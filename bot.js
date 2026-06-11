require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const talib = require('talib-binding');

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
        resistance: 0
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

// ==================== TA-LIB INDICATORS ====================

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

function calculateIndicators() {
    if (market.ohlcv.length < 50) return;
    
    const closes = market.ohlcv.map(c => c.close);
    const highs = market.ohlcv.map(c => c.high);
    const lows = market.ohlcv.map(c => c.low);
    const volumes = market.ohlcv.map(c => c.volume);
    
    try {
        // RSI
        const rsi = talib.RSI(closes, 14);
        market.indicators.rsi = rsi[rsi.length - 1];
        
        // MACD
        const macd = talib.MACD(closes, 12, 26, 9);
        market.indicators.macd = {
            macd: macd.macd[macd.macd.length - 1],
            signal: macd.macdSignal[macd.macdSignal.length - 1],
            histogram: macd.macdHist[macd.macdHist.length - 1]
        };
        
        // Bollinger Bands
        const bb = talib.BBANDS(closes, 20, 2, 2);
        market.indicators.bb = {
            upper: bb.upperBand[bb.upperBand.length - 1],
            middle: bb.middleBand[bb.middleBand.length - 1],
            lower: bb.lowerBand[bb.lowerBand.length - 1]
        };
        
        // EMAs
        const ema20 = talib.EMA(closes, 20);
        const ema50 = talib.EMA(closes, 50);
        market.indicators.ema20 = ema20[ema20.length - 1];
        market.indicators.ema50 = ema50[ema50.length - 1];
        
        // Volume
        market.indicators.volume = volumes[volumes.length - 1];
        const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        market.indicators.volumeRatio = market.indicators.volume / avgVolume;
        
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
        
        // Support and Resistance (using pivot points)
        const recentHighs = highs.slice(-20);
        const recentLows = lows.slice(-20);
        market.indicators.resistance = Math.max(...recentHighs);
        market.indicators.support = Math.min(...recentLows);
        
        // ATR for volatility
        const atr = talib.ATR(highs, lows, closes, 14);
        market.indicators.atr = atr[atr.length - 1];
        
        // Stochastic
        const stoch = talib.STOCH(highs, lows, closes, 14, 3, 3);
        market.indicators.stochK = stoch.slowK[stoch.slowK.length - 1];
        market.indicators.stochD = stoch.slowD[stoch.slowD.length - 1];
        
        // MFI
        const mfi = talib.MFI(highs, lows, closes, volumes, 14);
        market.indicators.mfi = mfi[mfi.length - 1];
        
        // ADX for trend strength
        const adx = talib.ADX(highs, lows, closes, 14);
        market.indicators.adx = adx[adx.length - 1];
        
        // Williams %R
        const willr = talib.WILLR(highs, lows, closes, 14);
        market.indicators.willr = willr[willr.length - 1];
        
        // CCI
        const cci = talib.CCI(highs, lows, closes, 14);
        market.indicators.cci = cci[cci.length - 1];
        
    } catch (error) {
        console.error('Indicator calculation error:', error.message);
    }
}

function getIndicatorSummary() {
    const ind = market.indicators;
    return {
        rsi: ind.rsi.toFixed(1),
        rsi_status: ind.rsi > 70 ? 'OVERSOLD' : (ind.rsi < 30 ? 'OVERBOUGHT' : 'NEUTRAL'),
        macd: ind.macd.macd.toFixed(4),
        macd_signal: ind.macd.signal.toFixed(4),
        macd_histogram: ind.macd.histogram.toFixed(4),
        macd_status: ind.macd.histogram > 0 ? 'BULLISH' : 'BEARISH',
        bb_position: ind.bb.middle > 0 ? ((ind.bb.upper - ind.bb.lower) / ind.bb.middle * 100).toFixed(1) : 0,
        price_vs_bb: market.bid > ind.bb.upper ? 'ABOVE_UPPER' : (market.bid < ind.bb.lower ? 'BELOW_LOWER' : 'IN_RANGE'),
        ema20: ind.ema20.toFixed(8),
        ema50: ind.ema50.toFixed(8),
        ema_trend: ind.ema20 > ind.ema50 ? 'BULLISH' : 'BEARISH',
        volume_ratio: ind.volumeRatio.toFixed(2),
        trend: ind.trend,
        support: ind.support.toFixed(8),
        resistance: ind.resistance.toFixed(8),
        atr: ind.atr.toFixed(8),
        atr_percent: ((ind.atr / market.bid) * 100).toFixed(2),
        stoch_k: ind.stochK.toFixed(1),
        stoch_d: ind.stochD.toFixed(1),
        stoch_status: ind.stochK > 80 ? 'OVERBOUGHT' : (ind.stochK < 20 ? 'OVERSOLD' : 'NEUTRAL'),
        mfi: ind.mfi.toFixed(1),
        mfi_status: ind.mfi > 80 ? 'OVERBOUGHT' : (ind.mfi < 20 ? 'OVERSOLD' : 'NEUTRAL'),
        adx: ind.adx.toFixed(1),
        adx_status: ind.adx > 25 ? 'STRONG_TREND' : (ind.adx > 20 ? 'WEAK_TREND' : 'RANGING'),
        willr: ind.willr.toFixed(1),
        cci: ind.cci.toFixed(1)
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

function calculateVolumeForStep(step, baseVolume, multiplier) {
    let totalVolume = 0;
    for (let i = 0; i <= step; i++) {
        const stepVolume = i === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, i));
        totalVolume += stepVolume;
    }
    return totalVolume;
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
        
        if (oldEquity > 0 && Math.abs(state.currentEquity - oldEquity) > 0.000001) {
            const change = state.currentEquity - oldEquity;
            if (Math.abs(change) > 0.0001) {
                console.log(`[${state.direction.toUpperCase()}] Equity: $${oldEquity.toFixed(8)} → $${state.currentEquity.toFixed(8)}`);
            }
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
- EMA Trend: 20=${indicators.ema20.toFixed(6)} | 50=${indicators.ema50.toFixed(6)} (${indicators.ema_trend})
- Bollinger Bands: Price is ${indicators.price_vs_bb}
- Volume Ratio: ${indicators.volume_ratio}x average
- Overall Trend: ${indicators.trend}
- Trend Strength: ${trendStrength}/10
- Support: ${indicators.support} | Resistance: ${indicators.resistance}
- ATR (Volatility): ${indicators.atr_percent}%
- Stochastic: K=${indicators.stoch_k} | D=${indicators.stoch_d} (${indicators.stoch_status})
- MFI: ${indicators.mfi} (${indicators.mfi_status})
- ADX: ${indicators.adx} (${indicators.adx_status})
- Williams %R: ${indicators.willr}
- CCI: ${indicators.cci}

POSITION DATA:
- Current ROI: ${state.roi.toFixed(2)}%
- Volume: ${state.volume} contracts
- Entry Price: ${state.entryPrice.toFixed(8)}
- Current Price: $${direction === 'buy' ? market.bid : market.ask}

RULES FOR RECOMMENDATION:
1. OPEN POSITION (if volume = 0 AND spread < ${config.maxStartSpread}%):
   - Strong trend (ADX > 25) AND momentum agrees (MACD positive for long, negative for short)
   - RSI not extreme (>70 or <30)
   - Volume above average (>1x)

2. STEP UP (if ROI <= -${config.stepDistancePct}%):
   - Only if trend supports reversal (ADX > 20)
   - Not recommended if ADX > 40 (trend too strong against you)

3. CLOSE POSITION (if ROI >= ${config.takeProfitPct}% OR indicators show reversal):
   - Take profit at target OR
   - Indicators turning against position (RSI extreme, MACD crossover, BB breach)

4. HOLD: All other cases

Respond with EXACTLY ONE of these formats:
- "OPEN POSITION: Start new ${direction} position with ${market.currentBaseVolume} contracts [reason: brief]"
- "STEP UP: Add ${nextStepVolume} contracts [reason: brief]"
- "CLOSE POSITION: Take profit/loss now [reason: brief]"
- "HOLD: No action needed [reason: brief]"

Keep reason very short (max 10 words).`;

        const response = await axios.post(`${config.ollamaUrl}/api/generate`, {
            model: config.ollamaModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.2,
                top_p: 0.9,
                num_predict: 100
            }
        });

        let recommendation = response.data.response.trim();
        
        // Extract main action
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
        // Fetch latest OHLCV and indicators
        await fetchOHLCV();
        
        const longState = accountStates[1];
        const shortState = accountStates[2];
        
        const totalEquity = (longState?.currentEquity || 0) + (shortState?.currentEquity || 0);
        
        const marketData = {
            totalEquity: totalEquity,
            longRoi: longState?.roi || 0,
            shortRoi: shortState?.roi || 0,
            spread: market.spread,
            bid: market.bid,
            ask: market.ask
        };
        
        // Get recommendations for both positions
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
        console.log(`   📊 Indicators: RSI=${market.indicators.rsi.toFixed(1)} | Trend=${market.indicators.trend} | ADX=${market.indicators.adx.toFixed(1)}`);
        console.log(`   LONG: ${longResult.full}`);
        console.log(`   SHORT: ${shortResult.full}\n`);
        
        // Execute AI recommendations
        await executeAIRecommendation('long', longResult.action, longState, 1);
        await executeAIRecommendation('short', shortResult.action, shortState, 2);
        
    } catch (error) {
        console.error('AI recommendation error:', error);
    }
}

async function executeAIRecommendation(direction, action, state, accountId) {
    const acc = config.accounts.find(a => a.accountId === accountId);
    if (!acc || state.isLocked) return;
    
    // STEP UP action
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
                console.log(`✅ AI STEP UP executed for ${direction}`);
            } else {
                console.error(`❌ AI STEP UP failed`);
                state.lastAction = `❌ AI STEP UP Failed`;
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    // CLOSE POSITION action
    else if (action === 'CLOSE POSITION') {
        if (state.volume > 0) {
            console.log(`🤖 AI EXECUTING CLOSE POSITION: Closing ${state.volume} contracts ${direction}`);
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
                console.log(`✅ AI CLOSE POSITION executed for ${direction}`);
                
                const finalRoi = state.roi;
                const finalPnl = state.unrealizedUsdt;
                const exitTime = new Date().toLocaleString();
                logTradeExchangeStyle(state, state.direction === 'buy' ? market.bid : market.ask, exitTime, finalRoi, finalPnl);
                
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.targetPrice = 0;
                state.aiActionTaken = false;
            } else {
                console.error(`❌ AI CLOSE POSITION failed`);
                state.lastAction = `❌ AI CLOSE Failed`;
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    // OPEN POSITION action
    else if (action === 'OPEN POSITION') {
        if (state.volume === 0 && market.spread <= config.maxStartSpread) {
            console.log(`🤖 AI EXECUTING OPEN POSITION: Opening ${market.currentBaseVolume} contracts ${direction}`);
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
                console.log(`✅ AI OPEN POSITION executed for ${direction}`);
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Position opened at ${state.entryPrice.toFixed(8)}`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
                state.lastAction = `❌ AI OPEN Failed`;
                console.error(`❌ AI OPEN POSITION failed`);
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
        symbol: config.symbol.replace('-', '') + 'Perpetual',
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
        aiRecommendation: state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation,
        indicatorsAtClose: getIndicatorSummary()
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
            state.lastAction = `🤖 ${aiRec.action} | No position | RSI: ${market.indicators.rsi.toFixed(1)}`;
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
                const elapsedHours = (Date.now() - market.startTime) / (1000 * 60 * 60);
                market.dgr = elapsedHours > 0 ? (market.growthPct / elapsedHours) : 0;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        console.log(`📈 AUTO-COMPOUND: ${market.currentBaseVolume} → ${newBaseVolume} contracts`);
                        market.currentBaseVolume = newBaseVolume;
                        market.lastBaseUpdate = Date.now();
                    }
                }
                
                updateWalletGrowth(totalEquity);
            }
        }
        
        // Update AI recommendations and indicators every 15 seconds
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
            currentBaseShib: market.currentBaseShib,
            currentRiskAmount: market.currentRiskAmount,
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
            ollamaModel: config.ollamaModel,
            klineInterval: config.klineInterval
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
        raw: {
            rsi: market.indicators.rsi,
            macd: market.indicators.macd,
            bb: market.indicators.bb,
            ema20: market.indicators.ema20,
            ema50: market.indicators.ema50,
            trend: market.indicators.trend,
            support: market.indicators.support,
            resistance: market.indicators.resistance,
            atr: market.indicators.atr,
            stochK: market.indicators.stochK,
            stochD: market.indicators.stochD,
            mfi: market.indicators.mfi,
            adx: market.indicators.adx,
            willr: market.indicators.willr,
            cci: market.indicators.cci
        },
        ohlcv_count: market.ohlcv.length,
        last_price: market.bid
    });
});

// ==================== HTML DASHBOARD ====================

app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro AI - TA-Lib Technical Analysis</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .mono { font-family: monospace; font-size: 12px; }
        .tp-target { background: #00D1B220; color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 10px; }
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
        button:hover { background: #FF4D6D40; transform: scale(1.02); }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
        .ai-btn { background: #6366F120; border-color: #6366F1; color: #6366F1; margin-left: 10px; }
        .step-badge { background: #6366F120; color: #6366F1; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #00D1B240; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
        .ai-card { background: linear-gradient(135deg, #6366F120 0%, #131824 100%); border: 2px solid #6366F1; border-radius: 12px; padding: 15px; margin-bottom: 20px; }
        .ai-recommendation { font-size: 14px; font-weight: bold; padding: 10px; border-radius: 8px; margin-top: 8px; }
        .step-up { background: #FF4D6D20; color: #FF4D6D; border-left: 3px solid #FF4D6D; }
        .close-position { background: #FF000020; color: #FF0000; border-left: 3px solid #FF0000; }
        .open-position { background: #00D1B220; color: #00D1B2; border-left: 3px solid #00D1B2; }
        .hold { background: #6366F120; color: #6366F1; border-left: 3px solid #6366F1; }
        .ai-badge { background: #6366F1; color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-left: 8px; }
        .indicator-card { background: #0F141C; border-radius: 8px; padding: 10px; margin: 5px; }
        .bullish { color: #00D1B2; }
        .bearish { color: #FF4D6D; }
        .neutral { color: #FFB347; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO AI</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">TA-LIB POWERED</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% ROI</span>
                    <span class="ai-badge">🤖 ${config.ollamaModel}</span>
                </div>
            </div>
            <div>
                <button onclick="forceAICheck()" class="ai-btn">🤖 FORCE AI CHECK</button>
                <button onclick="forceSync()" class="sync-btn">🔄 SYNC</button>
                <button onclick="emergencyClose()">⚠️ CLOSE ALL</button>
            </div>
        </div>

        <!-- Technical Indicators Panel -->
        <div class="card mb-4">
            <h3 class="font-bold mb-3">📊 TECHNICAL INDICATORS (TA-Lib)</h3>
            <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">RSI (14)</div>
                    <div class="text-xl font-bold" id="rsiValue">--</div>
                    <div class="text-[8px]" id="rsiStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">MACD</div>
                    <div class="text-sm font-bold" id="macdValue">--</div>
                    <div class="text-[8px]" id="macdStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">ADX</div>
                    <div class="text-xl font-bold" id="adxValue">--</div>
                    <div class="text-[8px]" id="adxStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">STOCH</div>
                    <div class="text-sm font-bold" id="stochValue">--</div>
                    <div class="text-[8px]" id="stochStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">MFI</div>
                    <div class="text-xl font-bold" id="mfiValue">--</div>
                    <div class="text-[8px]" id="mfiStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">BB %</div>
                    <div class="text-xl font-bold" id="bbValue">--</div>
                    <div class="text-[8px]" id="bbStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">VOL RATIO</div>
                    <div class="text-xl font-bold" id="volumeValue">--</div>
                    <div class="text-[8px]" id="volumeStatus">--</div>
                </div>
                <div class="indicator-card text-center">
                    <div class="text-[10px] text-slate-500">TREND</div>
                    <div class="text-xl font-bold" id="trendValue">--</div>
                    <div class="text-[8px]" id="trendStrength">--</div>
                </div>
            </div>
        </div>

        <!-- AI Recommendations -->
        <div class="ai-card">
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-bold text-indigo-400">🤖 OLLAMA AI RECOMMENDATIONS</h3>
                <span class="text-[10px] text-slate-500" id="aiLastUpdate">Updating...</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-emerald-400 font-bold">LONG POSITION</span>
                    </div>
                    <div id="longRecommendation" class="ai-recommendation hold">🤖 Analyzing...</div>
                </div>
                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-red-400 font-bold">SHORT POSITION</span>
                    </div>
                    <div id="shortRecommendation" class="ai-recommendation hold">🤖 Analyzing...</div>
                </div>
            </div>
        </div>

        <!-- Wallet Card -->
        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-2 md:grid-cols-5 gap-6">
                <div>
                    <p class="stat-label">TOTAL WALLET</p>
                    <p id="totalWallet" class="stat-number">$0.00</p>
                    <p id="walletChange" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">TOTAL P&L</p>
                    <p id="totalPnl" class="stat-number">$0.00</p>
                    <p id="pnlPercent" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">REALIZED P&L</p>
                    <p id="realizedPnl" class="stat-number">$0.00</p>
                    <p id="feesPaid" class="text-xs">Fees: $0.00</p>
                </div>
                <div>
                    <p class="stat-label">PERFORMANCE</p>
                    <p id="peakEquity" class="text-sm">Peak: $0.00</p>
                    <p id="maxDrawdown" class="text-sm">DD: 0%</p>
                </div>
                <div>
                    <p class="stat-label">STATISTICS</p>
                    <p id="tradeStats" class="text-sm">Trades: 0</p>
                    <p id="winRate" class="text-sm">Win Rate: 0%</p>
                </div>
            </div>
            <div class="compound-info mt-4">
                <div class="flex justify-between">
                    <div>
                        <p class="text-xs text-slate-400">📈 AUTO-COMPOUNDING (${config.riskPercent}% of Wallet)</p>
                        <p class="text-sm font-bold text-green-400" id="baseVolumeDisplay">Base Volume: 0 contracts</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-slate-400">Risk Amount</p>
                        <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Position Cards -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <div class="card">
                <p class="stat-label mb-2">LONG POSITION</p>
                <p id="lRoi" class="text-3xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm">$0.00</p>
                <p id="lStep" class="text-xs text-slate-500 mt-2">Step 0 | Vol 0</p>
                <p id="lAction" class="text-xs text-indigo-400 mt-1"></p>
                <p id="lTarget" class="text-xs text-green-400"></p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">SHORT POSITION</p>
                <p id="sRoi" class="text-3xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm">$0.00</p>
                <p id="sStep" class="text-xs text-slate-500 mt-2">Step 0 | Vol 0</p>
                <p id="sAction" class="text-xs text-indigo-400 mt-1"></p>
                <p id="sTarget" class="text-xs text-green-400"></p>
            </div>
        </div>

        <!-- Market Info -->
        <div class="card mb-8">
            <div class="grid grid-cols-3 gap-4">
                <div>
                    <p class="stat-label">BID</p>
                    <p id="bidPrice" class="text-xl font-mono">0.00000000</p>
                </div>
                <div>
                    <p class="stat-label">ASK</p>
                    <p id="askPrice" class="text-xl font-mono">0.00000000</p>
                </div>
                <div>
                    <p class="stat-label">SPREAD</p>
                    <p id="spread" class="text-xl font-mono">0.000%</p>
                </div>
            </div>
        </div>

        <!-- Trade History -->
        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <div class="overflow-x-auto max-h-96 overflow-y-auto">
                <table class="w-full">
                    <thead class="sticky top-0 bg-[#131824]">
                        <tr class="text-xs text-slate-500">
                            <th class="p-2">SIDE</th>
                            <th class="p-2">VOL</th>
                            <th class="p-2">ENTRY</th>
                            <th class="p-2">EXIT</th>
                            <th class="p-2">ROI</th>
                            <th class="p-2">PNL</th>
                        </tr>
                    </thead>
                    <tbody id="tradesBody">
                        <tr><td colspan="6" class="text-center p-8 text-slate-500">No trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function forceSync() {
            await fetch('/api/force-sync', {method: 'POST'});
        }
        
        async function forceAICheck() {
            const btn = event.target;
            btn.textContent = '🤖 AI CHECK...';
            await fetch('/api/force-ai-check', {method: 'POST'});
            setTimeout(() => btn.textContent = '🤖 FORCE AI CHECK', 1000);
        }
        
        async function emergencyClose() {
            if(confirm('EMERGENCY CLOSE ALL POSITIONS?')) {
                await fetch('/api/close', {method: 'POST'});
                alert('Emergency close initiated');
            }
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Update wallet
                document.getElementById('totalWallet').textContent = '$' + (data.market.totalEquity || 0).toFixed(8);
                document.getElementById('totalPnl').textContent = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + (data.market.totalNetGain || 0).toFixed(8);
                document.getElementById('pnlPercent').innerHTML = (data.market.growthPct || 0).toFixed(2) + '%';
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl || 0).toFixed(8);
                document.getElementById('peakEquity').innerHTML = 'Peak: $' + (data.market.peakEquity || 0).toFixed(8);
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = 'Trades: ' + (data.market.totalTrades || 0);
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + (data.market.winRate || 0) + '%';
                document.getElementById('baseVolumeDisplay').innerHTML = 'Base Volume: ' + (data.market.currentBaseVolume || 0) + ' contracts';
                document.getElementById('riskAmount').innerHTML = '$' + (data.market.currentRiskAmount || 0).toFixed(8);
                
                // Update indicators
                if (data.market.indicators) {
                    const ind = data.market.indicators;
                    document.getElementById('rsiValue').innerHTML = ind.rsi;
                    document.getElementById('rsiStatus').innerHTML = ind.rsi_status;
                    document.getElementById('macdValue').innerHTML = ind.macd_histogram;
                    document.getElementById('macdStatus').innerHTML = ind.macd_status;
                    document.getElementById('adxValue').innerHTML = ind.adx;
                    document.getElementById('adxStatus').innerHTML = ind.adx_status;
                    document.getElementById('stochValue').innerHTML = ind.stoch_k + '/' + ind.stoch_d;
                    document.getElementById('stochStatus').innerHTML = ind.stoch_status;
                    document.getElementById('mfiValue').innerHTML = ind.mfi;
                    document.getElementById('mfiStatus').innerHTML = ind.mfi_status;
                    document.getElementById('bbValue').innerHTML = ind.price_vs_bb;
                    document.getElementById('volumeValue').innerHTML = ind.volume_ratio + 'x';
                    document.getElementById('trendValue').innerHTML = ind.trend;
                    document.getElementById('trendStrength').innerHTML = 'Strength: ' + (data.market.trendStrength || 0) + '/10';
                    
                    // Color coding
                    document.getElementById('rsiValue').className = 'text-xl font-bold ' + (ind.rsi > 70 ? 'bearish' : (ind.rsi < 30 ? 'bullish' : 'neutral'));
                    document.getElementById('macdValue').className = 'text-sm font-bold ' + (ind.macd_status === 'BULLISH' ? 'bullish' : 'bearish');
                }
                
                // Update market prices
                document.getElementById('bidPrice').textContent = (data.market.bid || 0).toFixed(8);
                document.getElementById('askPrice').textContent = (data.market.ask || 0).toFixed(8);
                document.getElementById('spread').textContent = (data.market.spread || 0).toFixed(3) + '%';
                
                // Update AI recommendations
                if (data.aiRecommendations) {
                    const longDiv = document.getElementById('longRecommendation');
                    longDiv.textContent = data.aiRecommendations.long.recommendation;
                    longDiv.className = 'ai-recommendation ' + (data.aiRecommendations.long.action === 'STEP UP' ? 'step-up' : 
                        (data.aiRecommendations.long.action === 'CLOSE POSITION' ? 'close-position' :
                        (data.aiRecommendations.long.action === 'OPEN POSITION' ? 'open-position' : 'hold')));
                    
                    const shortDiv = document.getElementById('shortRecommendation');
                    shortDiv.textContent = data.aiRecommendations.short.recommendation;
                    shortDiv.className = 'ai-recommendation ' + (data.aiRecommendations.short.action === 'STEP UP' ? 'step-up' : 
                        (data.aiRecommendations.short.action === 'CLOSE POSITION' ? 'close-position' :
                        (data.aiRecommendations.short.action === 'OPEN POSITION' ? 'open-position' : 'hold')));
                    
                    if (data.aiRecommendations.long.lastUpdate) {
                        document.getElementById('aiLastUpdate').textContent = 'Updated: ' + new Date(data.aiRecommendations.long.lastUpdate).toLocaleTimeString();
                    }
                }
                
                // Update positions
                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                
                if (long) {
                    document.getElementById('lRoi').innerHTML = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lRoi').className = 'text-3xl font-black ' + (long.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + '$' + long.unrealizedUsdt.toFixed(8);
                    document.getElementById('lStep').innerHTML = 'Step ' + long.step + ' | Vol ' + long.volume;
                    document.getElementById('lAction').innerHTML = long.lastAction;
                    if (long.targetPrice) document.getElementById('lTarget').innerHTML = '🎯 TP: ' + long.targetPrice.toFixed(8);
                }
                
                if (short) {
                    document.getElementById('sRoi').innerHTML = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sRoi').className = 'text-3xl font-black ' + (short.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + '$' + short.unrealizedUsdt.toFixed(8);
                    document.getElementById('sStep').innerHTML = 'Step ' + short.step + ' | Vol ' + short.volume;
                    document.getElementById('sAction').innerHTML = short.lastAction;
                    if (short.targetPrice) document.getElementById('sTarget').innerHTML = '🎯 TP: ' + short.targetPrice.toFixed(8);
                }
                
                // Update trade history
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.forEach(t => {
                        tradesHtml += '<tr class="border-b border-[#1F2A3E]">' +
                            '<td class="p-2"><span class="' + (t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400') + '">' + t.side + '</span></td>' +
                            '<td class="p-2">' + t.volume + '</td>' +
                            '<td class="p-2 font-mono text-xs">' + t.entryPrice + '</td>' +
                            '<td class="p-2 font-mono text-xs">' + t.exitPrice + '</td>' +
                            '<td class="p-2 ' + (parseFloat(t.roi) >= 0 ? 'value-positive' : 'value-negative') + '">' + t.roi + '</td>' +
                            '<td class="p-2 font-mono">' + (parseFloat(t.netPnlUsdt) >= 0 ? '+' : '') + t.netPnlUsdt + '</td>' +
                        '</tr>';
                    });
                } else {
                    tradesHtml = '<tr><td colspan="6" class="text-center p-8 text-slate-500">No trades yet</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
                
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>`);
});

// ==================== START ====================

startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro AI Started (TA-Lib Technical Analysis)`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`🤖 Ollama AI: ${config.ollamaModel}`);
    console.log(`📈 TA-Lib Indicators: RSI, MACD, BB, ADX, Stochastic, MFI, ATR, CCI, WillR`);
    console.log(`🎮 AI Control: All trading decisions based on technical analysis`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
