require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const apiAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}

const config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 75,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 10,
    takeProfitPct: 15,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.1,
    takerFeeRate: 0.0005,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 2,
    shibPerContract: 1000,
    walletPerContract: 0.0066135,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    aiControlEnabled: true,
    klineInterval: '1min',
    klinesToFetch: 100
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0,
    walletHistory: [],
    peakEquity: 0,
    maxDrawdown: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalFeesPaid: 0,
    currentBaseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    currentBaseShib: 0,
    currentRiskAmount: 0,
    lastBaseUpdate: Date.now(),
    aiModeEnabled: true,
    lastAiCheck: 0,
    ohlcv: [],
    indicators: {
        rsi: 50,
        macd: { macd: 0, signal: 0, histogram: 0 },
        bb: { upper: 0, middle: 0, lower: 0 },
        ema20: 0,
        ema50: 0,
        volume: 0,
        trend: 'NEUTRAL',
        support: 0,
        resistance: 0,
        atr: 0,
        stochK: 50,
        stochD: 50,
        mfi: 50,
        adx: 20,
        willr: 0,
        cci: 0
    }
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let aiRecommendations = {
    long: { recommendation: 'HOLD: Waiting for AI analysis...', confidence: 0, lastUpdate: null, action: 'HOLD', indicators: {} },
    short: { recommendation: 'HOLD: Waiting for AI analysis...', confidence: 0, lastUpdate: null, action: 'HOLD', indicators: {} }
};

// ==================== CUSTOM TECHNICAL INDICATORS (No TA-Lib required) ====================

async function fetchOHLCV() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/history/kline?contract_code=${config.symbol}&period=${config.klineInterval}&size=${config.klinesToFetch}`;
        const res = await axios.get(url, { timeout: 5000 });
        
        if (res.data?.data) {
            const klines = res.data.data;
            market.ohlcv = klines.map(k => ({
                time: k.id,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.vol)
            }));
            
            calculateIndicators();
        }
    } catch (error) {
        console.error('Failed to fetch OHLCV:', error.message);
    }
}

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
        const change = closes[closes.length - i] - closes[closes.length - i - 1];
        if (change >= 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateMACD(closes) {
    const ema12 = calculateEMA(closes.slice(-26), 12);
    const ema26 = calculateEMA(closes.slice(-26), 26);
    const macdLine = ema12 - ema26;
    
    const macdHistory = [];
    for (let i = 0; i < closes.length - 26; i++) {
        const e12 = calculateEMA(closes.slice(i, i + 26), 12);
        const e26 = calculateEMA(closes.slice(i, i + 26), 26);
        macdHistory.push(e12 - e26);
    }
    
    const signalLine = calculateEMA(macdHistory, 9);
    const histogram = macdLine - signalLine;
    
    return { macd: macdLine, signal: signalLine, histogram: histogram };
}

function calculateBB(closes, period = 20, stdDev = 2) {
    const lastCloses = closes.slice(-period);
    const sma = lastCloses.reduce((a, b) => a + b, 0) / period;
    
    const squaredDiffs = lastCloses.map(price => Math.pow(price - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(variance);
    
    return {
        upper: sma + (stdDev * std),
        middle: sma,
        lower: sma - (stdDev * std)
    };
}

function calculateStochastic(highs, lows, closes, period = 14, smoothK = 3, smoothD = 3) {
    const lastHighs = highs.slice(-period);
    const lastLows = lows.slice(-period);
    const lastClose = closes[closes.length - 1];
    
    const highestHigh = Math.max(...lastHighs);
    const lowestLow = Math.min(...lastLows);
    
    const k = ((lastClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    return { k, d: k };
}

function calculateATR(highs, lows, closes, period = 14) {
    const trValues = [];
    for (let i = 1; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trValues.push(Math.max(hl, hc, lc));
    }
    
    const recentTR = trValues.slice(-period);
    return recentTR.reduce((a, b) => a + b, 0) / period;
}

function calculateMFI(highs, lows, closes, volumes, period = 14) {
    let positiveFlow = 0;
    let negativeFlow = 0;
    
    for (let i = 1; i <= period; i++) {
        const typicalPrice = (highs[highs.length - i] + lows[highs.length - i] + closes[closes.length - i]) / 3;
        const prevTypicalPrice = (highs[highs.length - i - 1] + lows[highs.length - i - 1] + closes[closes.length - i - 1]) / 3;
        const rawMoneyFlow = typicalPrice * volumes[volumes.length - i];
        
        if (typicalPrice > prevTypicalPrice) {
            positiveFlow += rawMoneyFlow;
        } else {
            negativeFlow += rawMoneyFlow;
        }
    }
    
    const moneyRatio = positiveFlow / negativeFlow;
    return 100 - (100 / (1 + moneyRatio));
}

function calculateADX(highs, lows, closes, period = 14) {
    const plusDM = [];
    const minusDM = [];
    const tr = [];
    
    for (let i = 1; i < highs.length; i++) {
        const highDiff = highs[i] - highs[i - 1];
        const lowDiff = lows[i - 1] - lows[i];
        
        plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
        minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
        
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    
    const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
    const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    
    return dx;
}

function calculateCCI(highs, lows, closes, period = 14) {
    const tp = [];
    for (let i = 0; i < highs.length; i++) {
        tp.push((highs[i] + lows[i] + closes[i]) / 3);
    }
    
    const sma = tp.slice(-period).reduce((a, b) => a + b, 0) / period;
    const meanDev = tp.slice(-period).reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    
    return (tp[tp.length - 1] - sma) / (0.015 * meanDev);
}

function calculateIndicators() {
    if (market.ohlcv.length < 50) return;
    
    const closes = market.ohlcv.map(c => c.close);
    const highs = market.ohlcv.map(c => c.high);
    const lows = market.ohlcv.map(c => c.low);
    const volumes = market.ohlcv.map(c => c.volume);
    
    try {
        // RSI
        market.indicators.rsi = calculateRSI(closes, 14);
        
        // MACD
        const macd = calculateMACD(closes);
        market.indicators.macd = macd;
        
        // Bollinger Bands
        const bb = calculateBB(closes, 20, 2);
        market.indicators.bb = bb;
        
        // EMAs
        market.indicators.ema20 = calculateEMA(closes.slice(-20), 20);
        market.indicators.ema50 = calculateEMA(closes.slice(-50), 50);
        
        // Volume
        market.indicators.volume = volumes[volumes.length - 1];
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        market.indicators.volumeRatio = market.indicators.volume / avgVolume;
        
        // Support and Resistance
        const recentHighs = highs.slice(-20);
        const recentLows = lows.slice(-20);
        market.indicators.resistance = Math.max(...recentHighs);
        market.indicators.support = Math.min(...recentLows);
        
        // ATR
        market.indicators.atr = calculateATR(highs, lows, closes, 14);
        
        // Stochastic
        const stoch = calculateStochastic(highs, lows, closes, 14, 3, 3);
        market.indicators.stochK = stoch.k;
        market.indicators.stochD = stoch.d;
        
        // MFI
        market.indicators.mfi = calculateMFI(highs, lows, closes, volumes, 14);
        
        // ADX
        market.indicators.adx = calculateADX(highs, lows, closes, 14);
        
        // Williams %R
        const highestHigh = Math.max(...highs.slice(-14));
        const lowestLow = Math.min(...lows.slice(-14));
        market.indicators.willr = ((highestHigh - closes[closes.length - 1]) / (highestHigh - lowestLow)) * -100;
        
        // CCI
        market.indicators.cci = calculateCCI(highs, lows, closes, 14);
        
        // Trend detection
        if (market.indicators.ema20 > market.indicators.ema50 && 
            market.indicators.rsi > 50 && 
            market.indicators.macd.histogram > 0) {
            market.indicators.trend = 'BULLISH';
        } else if (market.indicators.ema20 < market.indicators.ema50 && 
                   market.indicators.rsi < 50 && 
                   market.indicators.macd.histogram < 0) {
            market.indicators.trend = 'BEARISH';
        } else {
            market.indicators.trend = 'NEUTRAL';
        }
        
    } catch (error) {
        console.error('Indicator calculation error:', error.message);
    }
}

function getIndicatorSummary() {
    const ind = market.indicators;
    return {
        rsi: ind.rsi.toFixed(1),
        rsi_status: ind.rsi > 70 ? 'OVERBOUGHT' : (ind.rsi < 30 ? 'OVERSOLD' : 'NEUTRAL'),
        macd: ind.macd.macd.toFixed(4),
        macd_signal: ind.macd.signal.toFixed(4),
        macd_histogram: ind.macd.histogram.toFixed(4),
        macd_status: ind.macd.histogram > 0 ? 'BULLISH' : 'BEARISH',
        bb_position: ind.bb.middle > 0 ? ((ind.bb.upper - ind.bb.lower) / ind.bb.middle * 100).toFixed(1) : 0,
        price_vs_bb: market.bid > ind.bb.upper ? 'ABOVE_UPPER' : (market.bid < ind.bb.lower ? 'BELOW_LOWER' : 'IN_RANGE'),
        ema20: ind.ema20.toFixed(8),
        ema50: ind.ema50.toFixed(8),
        ema_trend: ind.ema20 > ind.ema50 ? 'BULLISH' : 'BEARISH',
        volume_ratio: (ind.volumeRatio || 1).toFixed(2),
        trend: ind.trend,
        support: ind.support.toFixed(8),
        resistance: ind.resistance.toFixed(8),
        atr: ind.atr.toFixed(8),
        atr_percent: ((ind.atr / market.bid) * 100).toFixed(2),
        stoch_k: (ind.stochK || 50).toFixed(1),
        stoch_d: (ind.stochD || 50).toFixed(1),
        stoch_status: ind.stochK > 80 ? 'OVERBOUGHT' : (ind.stochK < 20 ? 'OVERSOLD' : 'NEUTRAL'),
        mfi: (ind.mfi || 50).toFixed(1),
        mfi_status: ind.mfi > 80 ? 'OVERBOUGHT' : (ind.mfi < 20 ? 'OVERSOLD' : 'NEUTRAL'),
        adx: (ind.adx || 20).toFixed(1),
        adx_status: ind.adx > 25 ? 'STRONG_TREND' : (ind.adx > 20 ? 'WEAK_TREND' : 'RANGING'),
        willr: (ind.willr || 0).toFixed(1),
        cci: (ind.cci || 0).toFixed(1)
    };
}

function calculateTrendStrength() {
    const ind = market.indicators;
    let strength = 0;
    
    if (ind.trend === 'BULLISH') strength += 2;
    if (ind.macd.histogram > 0) strength += 1.5;
    if (ind.rsi > 50 && ind.rsi < 70) strength += 1;
    if (ind.ema20 > ind.ema50) strength += 1.5;
    if (ind.adx > 25) strength += 1;
    if (ind.stochK > 20 && ind.stochK < 80) strength += 0.5;
    if (ind.mfi > 40 && ind.mfi < 60) strength += 0.5;
    
    return Math.min(10, strength);
}

// ==================== EXISTING TRADING FUNCTIONS ====================

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    let volume = Math.floor(totalEquity / config.walletPerContract);
    volume = Math.max(1, volume);
    
    const MAX_VOLUME = 1000000;
    if (volume > MAX_VOLUME) {
        volume = MAX_VOLUME;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    const positionUsdt = riskAmount * config.leverage;
    const shibAmount = volume * config.shibPerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseShib = shibAmount;
    
    return volume;
}

function calculateStepFromVolume(volume, baseVolume, multiplier) {
    if (volume === 0) return 0;
    
    let totalVolume = 0;
    let step = 0;
    
    while (totalVolume < volume) {
        const stepVolume = step === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, step));
        totalVolume += stepVolume;
        if (totalVolume <= volume) {
            step++;
        } else {
            break;
        }
    }
    
    return step;
}

function calculateTargetPrice(state) {
    const requiredPriceMovePct = config.takeProfitPct / config.leverage;
    
    if (state.direction === 'buy') {
        const targetPrice = state.entryPrice * (1 + (requiredPriceMovePct / 100));
        const feeAdjustedTarget = targetPrice * (1 + config.takerFeeRate);
        return feeAdjustedTarget;
    } else {
        const targetPrice = state.entryPrice * (1 - (requiredPriceMovePct / 100));
        const feeAdjustedTarget = targetPrice * (1 - config.takerFeeRate);
        return feeAdjustedTarget;
    }
}

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
    
    const lastRecord = market.walletHistory[market.walletHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000 || Math.abs(lastRecord.equity - totalEquity) > 0.000001) {
        market.walletHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            equity: totalEquity,
            pnl: totalEquity - market.initialTotalEquity,
            pnlPercent: market.initialTotalEquity > 0 ? ((totalEquity - market.initialTotalEquity) / market.initialTotalEquity) * 100 : 0,
            baseVolume: market.currentBaseVolume,
            baseShib: market.currentBaseShib,
            riskAmount: market.currentRiskAmount,
            longRec: aiRecommendations.long.recommendation,
            shortRec: aiRecommendations.short.recommendation,
            indicators: getIndicatorSummary()
        });
        
        if (market.walletHistory.length > 100) market.walletHistory.shift();
    }
    
    if (totalEquity > market.peakEquity) {
        market.peakEquity = totalEquity;
    }
    
    if (market.peakEquity > 0) {
        const currentDrawdown = ((market.peakEquity - totalEquity) / market.peakEquity) * 100;
        if (currentDrawdown > market.maxDrawdown) {
            market.maxDrawdown = currentDrawdown;
        }
    }
}

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false,
        pendingOrderId: null,
        lastAction: '🤖 Waiting for AI analysis...',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastExchangeRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0,
        realizedPnl: 0,
        totalFees: 0,
        lastAiRecommendation: null,
        aiActionTaken: false
    };
});

function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = {
        AccessKeyId: account.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp,
        ...params
    };
    
    const sortedParams = Object.keys(allParams).sort().map(key => `${key}=${encodeURIComponent(allParams[key])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedParams].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    
    return { timestamp, signature, sortedParams };
}

async function htxRequest(account, method, path, data = {}) {
    try {
        const { timestamp, signature, sortedParams } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        
        const options = {
            method,
            url,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 5000
        };
        
        if (method === 'POST') {
            options.data = data;
        }
        
        const res = await axios(options);
        return res.data;
    } catch (e) {
        console.error(`API Error: ${e.message}`);
        return { status: 'error', msg: e.message };
    }
}

async function fetchPriceRest() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`;
        const res = await axios.get(url, { timeout: 3000 });
        if (res.data?.tick) {
            market.bid = parseFloat(res.data.tick.bid[0]);
            market.ask = parseFloat(res.data.tick.ask[0]);
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
            market.lastPriceUpdate = Date.now();
        }
    } catch (e) {}
}

async function syncAccount(acc, state) {
    const now = Date.now();
    
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol,
            order_id: state.pendingOrderId
        });
        if (orderRes?.data?.[0]?.status === 6 || orderRes?.data?.[0]?.status === 7) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else if (orderRes?.data?.[0]?.status === 4 || orderRes?.data?.[0]?.status === 5) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else {
            return;
        }
    }

    if (state.isLocked) return;

    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) {
        return;
    }
    lastPositionFetch[acc.accountId] = now;

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', {
        contract_code: config.symbol
    });

    if (posRes?.status === 'ok' && posRes.data) {
        const positions = posRes.data;
        const pos = positions.find(p => p.direction === state.direction);
        
        if (pos && parseFloat(pos.volume) > 0) {
            const newVolume = parseFloat(pos.volume);
            const newEntryPrice = parseFloat(pos.cost_open);
            const rawProfitRate = parseFloat(pos.profit_rate);
            const newExchangeRoi = rawProfitRate * 100;
            const newUnrealizedUsdt = parseFloat(pos.profit);
            
            state.volume = newVolume;
            state.entryPrice = newEntryPrice;
            state.unrealizedUsdt = newUnrealizedUsdt;
            
            const calculatedStep = calculateStepFromVolume(newVolume, market.currentBaseVolume, config.multiplier);
            
            if (Math.abs(newExchangeRoi - state.roi) > 0.01) {
                const timeSinceLastUpdate = now - state.lastRoiUpdateTime;
                
                state.roiLatencyMs = timeSinceLastUpdate;
                state.roiLatencyHistory.unshift({
                    timestamp: now,
                    exchangeRoi: newExchangeRoi,
                    botRoi: state.roi,
                    latencyMs: timeSinceLastUpdate,
                    difference: Math.abs(newExchangeRoi - state.roi).toFixed(2),
                    volume: newVolume,
                    step: calculatedStep
                });
                
                if (state.roiLatencyHistory.length > 10) state.roiLatencyHistory.pop();
                
                console.log(`[${state.direction.toUpperCase()}] ROI: ${newExchangeRoi.toFixed(2)}% | Vol: ${newVolume} | Step: ${calculatedStep}`);
                
                state.roi = newExchangeRoi;
                state.lastExchangeRoi = newExchangeRoi;
                state.lastRoiUpdateTime = now;
            }
            
            state.targetPrice = calculateTargetPrice(state);
            
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else {
            if (state.volume !== 0) {
                console.log(`✅ [${state.direction.toUpperCase()}] Position closed`);
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.lastExchangeRoi = 0;
                state.targetPrice = 0;
                state.aiActionTaken = false;
            }
        }
    }

    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) {
        return;
    }
    lastBalanceFetch[acc.accountId] = now;

    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', {
        margin_asset: 'USDT'
    });

    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const oldEquity = state.currentEquity;
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        
        if (state.initialEquity === null) {
            state.initialEquity = state.currentEquity;
        }
    }
}

// ==================== AI WITH TECHNICAL INDICATORS ====================

async function getAIRecommendation(direction, state, marketData) {
    try {
        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const nextStepVolume = currentStep === 0 ? market.currentBaseVolume : Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, currentStep + 1));
        
        const indicators = getIndicatorSummary();
        const trendStrength = calculateTrendStrength();
        
        const prompt = `You are a professional crypto futures trading advisor. Analyze this ${direction.toUpperCase()} position using technical indicators and give ONLY ONE recommendation.

TECHNICAL INDICATORS:
- RSI(14): ${indicators.rsi} (${indicators.rsi_status})
- MACD: ${indicators.macd_histogram} (${indicators.macd_status})
- EMA Trend: 20 EMA ${indicators.ema_trend} vs 50 EMA
- Bollinger Bands: Price is ${indicators.price_vs_bb}
- Volume Ratio: ${indicators.volume_ratio}x average
- Overall Trend: ${indicators.trend}
- Trend Strength: ${trendStrength}/10
- Support: ${indicators.support} | Resistance: ${indicators.resistance}
- ATR (Volatility): ${indicators.atr_percent}%
- Stochastic: K=${indicators.stoch_k} (${indicators.stoch_status})
- ADX: ${indicators.adx} (${indicators.adx_status})

POSITION DATA:
- Current ROI: ${state.roi.toFixed(2)}%
- Volume: ${state.volume} contracts
- Entry Price: ${state.entryPrice.toFixed(8)}
- Current Price: $${direction === 'buy' ? market.bid : market.ask}

RULES - Respond with EXACTLY ONE of these:
- "OPEN POSITION: Start new ${direction} position with ${market.currentBaseVolume} contracts"
- "STEP UP: Add ${nextStepVolume} contracts (martingale)"
- "CLOSE POSITION: Take profit/loss now"
- "HOLD: No action needed"

Keep response short and only use these exact formats.`;

        const response = await axios.post(`${config.ollamaUrl}/api/generate`, {
            model: config.ollamaModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.2,
                top_p: 0.9,
                num_predict: 80
            }
        });

        let recommendation = response.data.response.trim();
        
        let action = 'HOLD';
        if (recommendation.includes('OPEN POSITION')) action = 'OPEN POSITION';
        else if (recommendation.includes('STEP UP')) action = 'STEP UP';
        else if (recommendation.includes('CLOSE POSITION')) action = 'CLOSE POSITION';
        
        return { action, full: recommendation };
        
    } catch (error) {
        console.error(`AI Error for ${direction}:`, error.message);
        return { action: 'HOLD', full: 'HOLD: AI unavailable, manual review needed' };
    }
}

async function updateAIRecommendations() {
    try {
        await fetchOHLCV();
        
        const longState = accountStates[1];
        const shortState = accountStates[2];
        
        const totalEquity = (longState?.currentEquity || 0) + (shortState?.currentEquity || 0);
        
        const marketData = {
            totalEquity: totalEquity,
            spread: market.spread,
            bid: market.bid,
            ask: market.ask
        };
        
        const [longResult, shortResult] = await Promise.all([
            getAIRecommendation('long', longState, marketData),
            getAIRecommendation('short', shortState, marketData)
        ]);
        
        aiRecommendations.long = {
            recommendation: longResult.full,
            confidence: 90,
            lastUpdate: new Date().toISOString(),
            action: longResult.action,
            indicators: getIndicatorSummary()
        };
        
        aiRecommendations.short = {
            recommendation: shortResult.full,
            confidence: 90,
            lastUpdate: new Date().toISOString(),
            action: shortResult.action,
            indicators: getIndicatorSummary()
        };
        
        console.log(`\n🤖 AI RECOMMENDATIONS (${new Date().toLocaleTimeString()}):`);
        console.log(`   📊 RSI=${market.indicators.rsi.toFixed(1)} | Trend=${market.indicators.trend} | ADX=${market.indicators.adx.toFixed(1)}`);
        console.log(`   LONG: ${longResult.full}`);
        console.log(`   SHORT: ${shortResult.full}\n`);
        
        await executeAIRecommendation('long', longResult.action, longState, 1);
        await executeAIRecommendation('short', shortResult.action, shortState, 2);
        
    } catch (error) {
        console.error('AI recommendation error:', error);
    }
}

async function executeAIRecommendation(direction, action, state, accountId) {
    const acc = config.accounts.find(a => a.accountId === accountId);
    if (!acc || state.isLocked) return;
    
    if (action === 'STEP UP') {
        if (state.volume > 0 && state.roi <= -config.stepDistancePct) {
            const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            const volumeToAdd = currentStep === 0 ? market.currentBaseVolume : Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, currentStep + 1));
            
            console.log(`🤖 AI EXECUTING STEP UP: Adding ${volumeToAdd} contracts to ${direction}`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: STEP UP +${volumeToAdd}`;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: volumeToAdd,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data?.order_id_str;
                console.log(`✅ AI STEP UP executed`);
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    else if (action === 'CLOSE POSITION') {
        if (state.volume > 0) {
            console.log(`🤖 AI EXECUTING CLOSE POSITION`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: CLOSE POSITION`;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data?.order_id_str;
                console.log(`✅ AI CLOSE POSITION executed`);
                
                const finalRoi = state.roi;
                const finalPnl = state.unrealizedUsdt;
                const exitTime = new Date().toLocaleString();
                logTradeExchangeStyle(state, state.direction === 'buy' ? market.bid : market.ask, exitTime, finalRoi, finalPnl);
                
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.startTime = null;
                state.targetPrice = 0;
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    else if (action === 'OPEN POSITION') {
        if (state.volume === 0 && market.spread <= config.maxStartSpread) {
            console.log(`🤖 AI EXECUTING OPEN POSITION`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: OPEN POSITION`;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: market.currentBaseVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                console.log(`✅ AI OPEN POSITION executed`);
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
            }
        }
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    const estimatedFee = Math.abs(finalPnl) * config.takerFeeRate;
    
    market.totalTrades++;
    if (finalPnl >= 0) {
        market.winningTrades++;
    } else {
        market.losingTrades++;
    }
    market.totalFeesPaid += estimatedFee;
    
    tradeHistory.unshift({
        symbol: config.symbol,
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        step: step,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8),
        estimatedFee: estimatedFee.toFixed(8),
        aiRecommendation: state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    
    ws.on('open', () => {
        console.log('✅ WebSocket connected');
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' }));
    });
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                if (msg.tick && msg.ch && msg.ch.includes('bbo')) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                    market.lastPriceUpdate = Date.now();
                }
                if (msg.ping) {
                    ws.send(JSON.stringify({ pong: msg.ping }));
                }
            } catch (e) {}
        });
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
    
    ws.on('close', () => {
        console.log('WebSocket disconnected, reconnecting in 5s...');
        setTimeout(startWS, 5000);
    });
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked) continue;
        
        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        
        if (state.volume > 0) {
            const aiRec = state.direction === 'buy' ? aiRecommendations.long : aiRecommendations.short;
            state.lastAction = `🤖 ${aiRec.action} | ROI: ${state.roi.toFixed(2)}% | Step ${currentStep}`;
        } else {
            const aiRec = state.direction === 'buy' ? aiRecommendations.long : aiRecommendations.short;
            state.lastAction = `🤖 ${aiRec.action} | RSI: ${market.indicators.rsi.toFixed(1)}`;
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) {
            await fetchPriceRest();
        }
        
        for (const acc of config.accounts) {
            await syncAccount(acc, accountStates[acc.accountId]);
        }
        
        const s1 = accountStates[1];
        const s2 = accountStates[2];
        
        if (s1 && s2) {
            if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
                market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                market.peakEquity = market.initialTotalEquity;
                console.log(`\n💰 INITIAL TOTAL EQUITY: $${market.initialTotalEquity.toFixed(8)} USDT\n`);
            }
            
            if (market.initialTotalEquity > 0) {
                const totalEquity = s1.currentEquity + s2.currentEquity;
                
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        console.log(`📈 AUTO-COMPOUND: ${market.currentBaseVolume} → ${newBaseVolume} contracts`);
                        market.currentBaseVolume = newBaseVolume;
                    }
                }
                
                updateWalletGrowth(totalEquity);
            }
        }
        
        if (Date.now() - market.lastAiCheck > 15000) {
            market.lastAiCheck = Date.now();
            await updateAIRecommendations();
        }
        
        if (market.status === 'Active') {
            await processMartingale();
        }
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    
    res.json({
        market: {
            ...market,
            totalEquity: totalEquity,
            totalNetGain: market.totalNetGain,
            growthPct: market.growthPct,
            peakEquity: market.peakEquity,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winningTrades: market.winningTrades,
            losingTrades: market.losingTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            walletHistory: market.walletHistory.slice(-20),
            currentBaseVolume: market.currentBaseVolume,
            indicators: getIndicatorSummary(),
            trendStrength: calculateTrendStrength()
        },
        accounts: Object.values(accountStates).map(state => ({
            direction: state.direction,
            roi: state.roi,
            volume: state.volume,
            step: calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier),
            unrealizedUsdt: state.unrealizedUsdt,
            entryPrice: state.entryPrice,
            lastAction: state.lastAction,
            targetPrice: state.targetPrice,
            realizedPnl: state.realizedPnl
        })),
        tradeHistory: tradeHistory.slice(0, 20),
        aiRecommendations: aiRecommendations,
        config: {
            leverage: config.leverage,
            takeProfitPct: config.takeProfitPct,
            maxStartSpread: config.maxStartSpread,
            multiplier: config.multiplier,
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            ollamaModel: config.ollamaModel
        }
    });
});

app.post('/api/force-ai-check', async (req, res) => {
    console.log("🤖 Force AI check initiated...");
    await updateAIRecommendations();
    res.json({ status: 'ok', recommendations: aiRecommendations, indicators: getIndicatorSummary() });
});

app.post('/api/close', async (req, res) => {
    console.log("🔴 EMERGENCY CLOSE INITIATED");
    market.status = "LIQUIDATING";
    
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: s.volume,
                direction: s.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
        }
    }
    
    setTimeout(() => market.status = "Active", 5000);
    res.json({ status: 'ok' });
});

app.post('/api/force-sync', async (req, res) => {
    console.log("🔄 Force syncing...");
    for (const acc of config.accounts) {
        await syncAccount(acc, accountStates[acc.accountId]);
    }
    res.json({ status: 'ok' });
});

app.get('/api/indicators', (req, res) => {
    res.json({
        current: getIndicatorSummary(),
        raw: market.indicators,
        ohlcv_count: market.ohlcv.length,
        last_price: market.bid
    });
});

// Simple HTML dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Martingale Pro AI</title>
    <style>
        body { font-family: monospace; background: #0a0a0a; color: #0f0; padding: 20px; }
        .card { background: #111; border: 1px solid #0f0; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .value-positive { color: #0f0; }
        .value-negative { color: #f00; }
        .stat-number { font-size: 24px; font-weight: bold; }
        button { background: #0f0; color: #000; border: none; padding: 10px 20px; cursor: pointer; margin: 5px; }
        button:hover { background: #0a0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    </style>
</head>
<body>
    <h1>🤖 Martingale Pro AI</h1>
    <div id="status">Loading...</div>
    
    <script>
        setInterval(async () => {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('status').innerHTML = \`
                <div class="card">
                    <h2>💰 Wallet: $\${data.market.totalEquity?.toFixed(8)}</h2>
                    <p>PnL: \${data.market.growthPct?.toFixed(2)}% | Trades: \${data.market.totalTrades}</p>
                    <p>📊 RSI: \${data.market.indicators?.rsi} | Trend: \${data.market.indicators?.trend}</p>
                </div>
                <div class="card">
                    <h3>🤖 AI Recommendations</h3>
                    <p><span style="color:#0f0">LONG:</span> \${data.aiRecommendations?.long?.recommendation}</p>
                    <p><span style="color:#f00">SHORT:</span> \${data.aiRecommendations?.short?.recommendation}</p>
                </div>
                <div class="card">
                    <div class="grid">
                        <div>📈 RSI: \${data.market.indicators?.rsi}</div>
                        <div>📊 MACD: \${data.market.indicators?.macd_histogram}</div>
                        <div>🎯 ADX: \${data.market.indicators?.adx}</div>
                        <div>📉 ATR: \${data.market.indicators?.atr_percent}%</div>
                    </div>
                </div>
            \`;
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== START ====================

startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro AI Started (Custom TA-Lib Implementation)`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`🤖 Ollama AI: ${config.ollamaModel}`);
    console.log(`📈 Technical Indicators: RSI, MACD, BB, ADX, Stochastic, MFI, ATR, CCI, WillR`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
