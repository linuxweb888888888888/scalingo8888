require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== HTX DOGE OPTIMIZED CONFIGURATION ====================
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

// Dynamic config - ALL parameters controlled by AI
let config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 75,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 10,
    takeProfitPct: 15,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.1,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 0.25,
    dogePerContract: 100,
    stepCooldownMs: 10 * 60 * 1000,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    
    // AI Settings
    aiEnabled: true,
    ollamaModel: 'llama3.2:3b',
    aiControlInterval: 60000,
    lastAIConfigUpdate: 0,
    
    // HTX DOGE OPTIMAL RANGES
    allowedLeverages: [75, 50, 25, 10],
    leverageTPMapping: {
        75: 15,
        50: 10,
        25: 5,
        10: 1.5
    },
    minLeverage: 10,
    maxLeverage: 75,
    minTakeProfit: 1.5,
    maxTakeProfit: 15,
    minBaseVolume: 1,
    maxBaseVolume: 10000,
    minMultiplier: 1.1,
    maxMultiplier: 2.0,
    minStepDistance: 5,
    maxStepDistance: 20,
    minRiskPercent: 0.1,
    maxRiskPercent: 5,
    minMaxStartSpread: 0.05,
    maxMaxStartSpread: 0.5
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
    currentBaseDoge: 0,
    currentRiskAmount: 0,
    lastBaseUpdate: Date.now(),
    aiRecommendation: null,
    aiLastUpdate: 0,
    aiConfigChanges: [],
    dogeVolatility: 0,
    ollamaAvailable: false
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let lastStepTime = {};

// ==================== HELPER FUNCTIONS ====================

function calculateTakeProfitFromLeverage(leverage) {
    return config.leverageTPMapping[leverage] || 15;
}

function calculateRequiredPriceMove(leverage, takeProfitPct) {
    return (takeProfitPct / leverage).toFixed(3);
}

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    let volume = Math.floor(riskAmount / 0.005);
    volume = Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, volume));
    
    if (market.spread > 0.1) {
        volume = Math.floor(volume * 0.7);
    } else if (market.spread > 0.05) {
        volume = Math.floor(volume * 0.85);
    }
    
    const leverageFactor = 75 / config.leverage;
    volume = Math.floor(volume * Math.min(1.5, Math.max(0.5, leverageFactor)));
    volume = Math.max(config.minBaseVolume, volume);
    
    const dogeAmountTotal = volume * config.dogePerContract;
    market.currentRiskAmount = riskAmount;
    market.currentBaseDoge = dogeAmountTotal;
    
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
            baseDoge: market.currentBaseDoge,
            riskAmount: market.currentRiskAmount
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

function calculateDogeVolatility() {
    if (market.walletHistory.length < 10) return 2;
    
    let returns = [];
    for (let i = 1; i < Math.min(20, market.walletHistory.length); i++) {
        const prev = market.walletHistory[i-1].equity;
        const curr = market.walletHistory[i].equity;
        if (prev > 0) {
            returns.push(Math.abs((curr - prev) / prev) * 100);
        }
    }
    
    if (returns.length === 0) return 2;
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    market.dogeVolatility = avgReturn;
    return avgReturn;
}

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false,
        pendingOrderId: null,
        lastAction: 'Idle',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastExchangeRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0,
        realizedPnl: 0,
        totalFees: 0
    };
    lastStepTime[account.accountId] = 0;
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
                
                console.log(`[${state.direction.toUpperCase()}] ROI: ${newExchangeRoi.toFixed(2)}% | Vol: ${newVolume}`);
                
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
        estimatedFee: estimatedFee.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
    
    console.log(`📊 TRADE CLOSED: ${state.direction.toUpperCase()} | ROI: ${finalRoi.toFixed(2)}% | PnL: ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(8)}`);
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

// ==================== AI CONTROLLER ====================

async function localAIController() {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const drawdownPercent = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100) : 0;
    const winRate = market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100) : 0;
    const volatility = market.dogeVolatility || 2;
    
    let changes = [];
    let newLeverage = config.leverage;
    let newBaseVolume = config.baseVolume;
    let newMultiplier = config.multiplier;
    let newStepDistance = config.stepDistancePct;
    let newRiskPercent = config.riskPercent;
    let newMaxStartSpread = config.maxStartSpread;
    let reason = '';
    
    // LEVERAGE ADJUSTMENT
    if (drawdownPercent > 30) {
        newLeverage = 10;
        reason = `Critical drawdown (${drawdownPercent.toFixed(1)}%)`;
    } else if (drawdownPercent > 20) {
        newLeverage = 25;
        reason = `High drawdown (${drawdownPercent.toFixed(1)}%)`;
    } else if (drawdownPercent > 10) {
        newLeverage = 50;
        reason = `Moderate drawdown (${drawdownPercent.toFixed(1)}%)`;
    } else if (volatility > 5) {
        newLeverage = 25;
        reason = `High volatility (${volatility.toFixed(1)}%)`;
    } else if (winRate > 70 && market.totalTrades > 10) {
        newLeverage = 75;
        reason = `Excellent win rate (${winRate.toFixed(0)}%)`;
    } else {
        newLeverage = 50;
        reason = `Standard conditions`;
    }
    
    // BASE VOLUME ADJUSTMENT
    if (drawdownPercent > 25) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.5);
    } else if (drawdownPercent > 15) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.7);
    } else if (winRate > 70) {
        newBaseVolume = Math.min(10, config.baseVolume * 1.2);
    } else {
        newBaseVolume = config.baseVolume;
    }
    
    // MULTIPLIER ADJUSTMENT
    if (drawdownPercent > 20) {
        newMultiplier = 1.1;
    } else if (winRate > 70) {
        newMultiplier = Math.min(1.5, config.multiplier + 0.1);
    } else {
        newMultiplier = 1.2;
    }
    
    // STEP DISTANCE ADJUSTMENT
    if (volatility > 4) {
        newStepDistance = 15;
    } else if (volatility > 2) {
        newStepDistance = 12;
    } else {
        newStepDistance = 10;
    }
    
    // RISK PERCENT ADJUSTMENT
    if (drawdownPercent > 25) {
        newRiskPercent = 0.15;
    } else if (drawdownPercent > 15) {
        newRiskPercent = 0.2;
    } else if (winRate > 70) {
        newRiskPercent = Math.min(0.5, config.riskPercent + 0.1);
    } else {
        newRiskPercent = 0.25;
    }
    
    // MAX START SPREAD ADJUSTMENT
    if (market.spread > 0.15) {
        newMaxStartSpread = 0.2;
    } else if (market.spread > 0.1) {
        newMaxStartSpread = 0.15;
    } else {
        newMaxStartSpread = 0.1;
    }
    
    newBaseVolume = Math.floor(Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, newBaseVolume)));
    newRiskPercent = Math.min(config.maxRiskPercent, Math.max(config.minRiskPercent, newRiskPercent));
    newMultiplier = Math.min(config.maxMultiplier, Math.max(config.minMultiplier, newMultiplier));
    newStepDistance = Math.min(config.maxStepDistance, Math.max(config.minStepDistance, newStepDistance));
    newMaxStartSpread = Math.min(config.maxMaxStartSpread, Math.max(config.minMaxStartSpread, newMaxStartSpread));
    
    const newTakeProfit = config.leverageTPMapping[newLeverage];
    const priceMove = (newTakeProfit / newLeverage).toFixed(3);
    
    if (newLeverage !== config.leverage) {
        changes.push(`Leverage: ${config.leverage}x → ${newLeverage}x (TP: ${newTakeProfit}%)`);
        config.leverage = newLeverage;
        config.takeProfitPct = newTakeProfit;
        
        for (const acc of config.accounts) {
            const state = accountStates[acc.accountId];
            if (state.volume > 0 && state.entryPrice > 0) {
                state.targetPrice = calculateTargetPrice(state);
            }
        }
    }
    
    if (newBaseVolume !== config.baseVolume) {
        changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume}`);
        config.baseVolume = newBaseVolume;
        if (!config.autoCompound) {
            market.currentBaseVolume = newBaseVolume;
        }
    }
    
    if (newMultiplier !== config.multiplier) {
        changes.push(`Multiplier: ${config.multiplier} → ${newMultiplier}x`);
        config.multiplier = newMultiplier;
    }
    
    if (newStepDistance !== config.stepDistancePct) {
        changes.push(`Step Trigger: -${config.stepDistancePct}% → -${newStepDistance}%`);
        config.stepDistancePct = newStepDistance;
    }
    
    if (newRiskPercent !== config.riskPercent) {
        changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}%`);
        config.riskPercent = newRiskPercent;
    }
    
    if (newMaxStartSpread !== config.maxStartSpread) {
        changes.push(`Max Spread: ${config.maxStartSpread}% → ${newMaxStartSpread}%`);
        config.maxStartSpread = newMaxStartSpread;
    }
    
    if (changes.length > 0) {
        console.log(`\n🔧 AI CONFIGURATION CHANGES:`);
        changes.forEach(c => console.log(`   ${c}`));
        
        market.aiConfigChanges.unshift({
            timestamp: Date.now(),
            time: new Date().toLocaleString(),
            changes: changes,
            reason: reason
        });
        if (market.aiConfigChanges.length > 20) market.aiConfigChanges.pop();
    }
    
    const recommendationText = `🧠 AI CONTROLLER ACTIVE\n\n📊 Current Settings:\n• Leverage: ${config.leverage}x (TP: ${config.takeProfitPct}%)\n• Required Move: ${priceMove}%\n• Base Volume: ${config.baseVolume} | Risk: ${config.riskPercent}%\n• Multiplier: ${config.multiplier}x | Step: -${config.stepDistancePct}%\n• Max Spread: ${config.maxStartSpread}%\n\n${changes.length > 0 ? '✅ Changes Made:\n' + changes.map(c => '• ' + c).join('\n') : '⚙️ Settings optimized'}\n\n📈 Reason: ${reason}`;
    
    market.aiRecommendation = {
        text: recommendationText,
        timestamp: Date.now(),
        time: new Date().toLocaleString(),
        type: 'local'
    };
    
    return true;
}

async function aiController() {
    if (!config.aiEnabled) return;
    
    console.log('\n🤖 AI CONTROLLER running...');
    calculateDogeVolatility();
    await localAIController();
    
    market.aiLastUpdate = Date.now();
    config.lastAIConfigUpdate = Date.now();
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (currentPrice === 0) continue;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread && market.spread > 0) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}% > ${config.maxStartSpread}%)`;
                continue;
            }
            
            console.log(`🚀 Opening ${state.direction} at ${currentPrice.toFixed(8)} | ${market.currentBaseVolume} contracts @ ${config.leverage}x`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            
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
                state.lastAction = "Position Opening";
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Opened at ${state.entryPrice.toFixed(8)} | TP: ${state.targetPrice.toFixed(8)} (${config.takeProfitPct}% @ ${config.leverage}x)`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
                state.lastAction = "Open Failed";
            }
            continue;
        }

        let shouldTakeProfit = false;
        let exitPrice = 0;
        
        if (state.direction === 'buy') {
            if (market.ask >= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.ask;
            }
        } else {
            if (market.bid <= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.bid;
            }
        }
        
        if (shouldTakeProfit) {
            const finalRoi = config.takeProfitPct;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            
            console.log(`✅ Taking ${state.direction} profit (${finalRoi}% ROI)`);
            state.isLocked = true;
            state.lastAction = "Taking Profit...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl);
                
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.targetPrice = 0;
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
            }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const now = Date.now();
        const timeSinceLastStep = now - (lastStepTime[acc.accountId] || 0);
        
        if (state.roi <= -config.stepDistancePct && state.volume > 0 && timeSinceLastStep >= config.stepCooldownMs) {
            const nextStepNumber = currentStep + 1;
            let nextVol;
            
            if (nextStepNumber === 1) {
                nextVol = Math.ceil(market.currentBaseVolume * config.multiplier);
            } else {
                nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            }
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} | ROI: ${state.roi.toFixed(2)}% | Adding: ${nextVol} contracts`);
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: nextVol,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${nextStepNumber}`;
                lastStepTime[acc.accountId] = now;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        } else {
            state.lastAction = `Step ${currentStep} | ROI: ${state.roi.toFixed(2)}% | ${config.leverage}x TP: ${config.takeProfitPct}%`;
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
        
        if (market.status === 'Active') {
            await processMartingale();
        }
        
        if (config.aiEnabled && (!config.lastAIConfigUpdate || (Date.now() - config.lastAIConfigUpdate) > config.aiControlInterval)) {
            await aiController();
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
    const totalRealizedPnl = (s1?.realizedPnl || 0) + (s2?.realizedPnl || 0);
    const totalFees = (s1?.totalFees || 0) + (s2?.totalFees || 0);
    
    const accountsWithInfo = Object.values(accountStates).map(state => {
        const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
        
        return {
            direction: state.direction,
            roi: state.roi,
            volume: state.volume,
            dogeAmount: state.volume * config.dogePerContract,
            step: step,
            unrealizedUsdt: state.unrealizedUsdt,
            entryPrice: state.entryPrice,
            lastAction: state.lastAction,
            startTime: state.startTime,
            targetPrice: state.targetPrice,
            requiredPriceMoveForTP: `${requiredPriceMovePct}%`,
            currentEquity: state.currentEquity,
            initialEquity: state.initialEquity,
            realizedPnl: state.realizedPnl,
            totalFees: state.totalFees
        };
    });
    
    res.json({
        market: {
            ...market,
            totalEquity: totalEquity,
            totalRealizedPnl: totalRealizedPnl,
            totalFeesPaid: totalFees,
            totalNetGain: market.totalNetGain,
            growthPct: market.growthPct,
            peakEquity: market.peakEquity,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winningTrades: market.winningTrades,
            losingTrades: market.losingTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            currentBaseVolume: market.currentBaseVolume,
            currentBaseDoge: market.currentBaseDoge,
            currentRiskAmount: market.currentRiskAmount,
            dogePerContract: config.dogePerContract,
            aiRecommendation: market.aiRecommendation,
            currentConfig: {
                leverage: config.leverage,
                takeProfitPct: config.takeProfitPct,
                requiredPriceMove: (config.takeProfitPct / config.leverage).toFixed(3) + '%',
                riskPercent: config.riskPercent,
                baseVolume: config.baseVolume,
                multiplier: config.multiplier,
                stepDistancePct: config.stepDistancePct,
                maxStartSpread: config.maxStartSpread
            }
        },
        accounts: accountsWithInfo,
        tradeHistory: tradeHistory.slice(0, 20)
    });
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
        const state = accountStates[acc.accountId];
        await syncAccount(acc, state);
    }
    res.json({ status: 'ok' });
});

app.post('/api/ai-refresh', async (req, res) => {
    await aiController();
    res.json({ recommendation: market.aiRecommendation });
});

// CLEAN WHITE DASHBOARD - NO CHART
app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale DOGE Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body { background: #f5f7fa; padding: 24px; }
        
        .container { max-width: 1400px; margin: 0 auto; }
        
        /* Header */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }
        .title h1 { font-size: 28px; font-weight: 700; color: #1a1a2e; }
        .title p { font-size: 13px; color: #666; margin-top: 4px; }
        .badge { display: inline-block; background: #e8f4fd; color: #0066cc; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; margin-left: 12px; }
        .button-group { display: flex; gap: 12px; }
        .btn { padding: 8px 20px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; transition: all 0.2s; }
        .btn-primary { background: #0066cc; color: white; }
        .btn-primary:hover { background: #0052a3; }
        .btn-danger { background: #dc2626; color: white; }
        .btn-danger:hover { background: #b91c1c; }
        .btn-outline { background: white; border: 1px solid #ddd; color: #333; }
        .btn-outline:hover { background: #f0f0f0; }
        
        /* Cards */
        .card { background: white; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #eee; font-weight: 600; font-size: 16px; color: #1a1a2e; display: flex; justify-content: space-between; align-items: center; }
        .card-body { padding: 20px; }
        
        /* Stats Grid */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 20px; }
        .stat-card { background: white; border-radius: 16px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 8px; }
        .stat-value { font-size: 28px; font-weight: 700; color: #1a1a2e; }
        .stat-change { font-size: 13px; margin-top: 4px; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        
        /* AI Card */
        .ai-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 16px; padding: 20px; margin-bottom: 20px; color: white; }
        .ai-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 12px; }
        .ai-title { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .ai-badge { background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 500; }
        .ai-content { font-size: 14px; line-height: 1.5; opacity: 0.95; white-space: pre-line; }
        .ai-time { font-size: 11px; opacity: 0.7; margin-top: 12px; }
        
        /* Config Grid */
        .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
        .config-item { background: #f8f9fa; border-radius: 12px; padding: 12px 16px; }
        .config-label { font-size: 11px; color: #888; margin-bottom: 4px; }
        .config-value { font-size: 20px; font-weight: 600; color: #1a1a2e; }
        .config-unit { font-size: 12px; color: #666; margin-left: 4px; }
        
        /* Positions Grid */
        .positions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .position-card { background: #f8f9fa; border-radius: 12px; padding: 16px; }
        .position-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
        .position-title.long { color: #10b981; }
        .position-title.short { color: #ef4444; }
        .position-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
        .position-label { color: #666; }
        .position-value { font-weight: 500; color: #1a1a2e; }
        
        /* Table */
        .table-wrapper { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; padding: 12px; background: #f8f9fa; color: #666; font-weight: 500; border-bottom: 1px solid #eee; }
        td { padding: 12px; border-bottom: 1px solid #eee; color: #333; }
        .trade-long { color: #10b981; font-weight: 500; }
        .trade-short { color: #ef4444; font-weight: 500; }
        
        /* Select Dropdown */
        .leverage-select { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
        
        @media (max-width: 768px) {
            body { padding: 16px; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .positions-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="title">
                <h1>MARTINGALE DOGE <span class="badge">AI CONTROLLED</span></h1>
                <p>${config.symbol} • ${config.leverage}x Leverage • TP: ${config.takeProfitPct}% (${requiredPriceMovePct}% move)</p>
            </div>
            <div class="button-group">
                <select id="leverageSelect" class="leverage-select" onchange="setLeverage(this.value)">
                    <option value="75" ${config.leverage === 75 ? 'selected' : ''}>75x (15% TP)</option>
                    <option value="50" ${config.leverage === 50 ? 'selected' : ''}>50x (10% TP)</option>
                    <option value="25" ${config.leverage === 25 ? 'selected' : ''}>25x (5% TP)</option>
                    <option value="10" ${config.leverage === 10 ? 'selected' : ''}>10x (1.5% TP)</option>
                </select>
                <button class="btn btn-outline" onclick="forceSync()">🔄 Force Sync</button>
                <button class="btn btn-danger" onclick="emergencyClose()">⚠️ Emergency Close</button>
            </div>
        </div>

        <!-- AI Card -->
        <div class="ai-card">
            <div class="ai-header">
                <div class="ai-title">
                    <span>🧠</span> AI Controller Active
                </div>
                <button class="btn" style="background: rgba(255,255,255,0.2); color: white; padding: 4px 12px;" onclick="refreshAI()">🔄 Force AI Reconfig</button>
            </div>
            <div id="aiRecommendation" class="ai-content">AI Controller initializing...</div>
            <div id="aiTimestamp" class="ai-time"></div>
        </div>

        <!-- Stats Grid -->
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">TOTAL WALLET</div>
                <div class="stat-value" id="totalWallet">$0.00</div>
                <div class="stat-change" id="walletChange"></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">TOTAL P&L</div>
                <div class="stat-value" id="totalPnl">$0.00</div>
                <div class="stat-change" id="pnlPercent"></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">REALIZED P&L</div>
                <div class="stat-value" id="realizedPnl">$0.00</div>
                <div class="stat-change" id="feesPaid">Fees: $0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">PERFORMANCE</div>
                <div class="stat-value" id="peakEquity">$0.00</div>
                <div class="stat-change" id="maxDrawdown">DD: 0%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">STATISTICS</div>
                <div class="stat-value" id="tradeStats">0</div>
                <div class="stat-change" id="winRate">Win Rate: 0%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">MARKET</div>
                <div class="stat-value" id="spread">0.000%</div>
                <div class="stat-change" id="marketPrice">BID: 0 | ASK: 0</div>
            </div>
        </div>

        <!-- AI Controlled Config -->
        <div class="card">
            <div class="card-header">
                <span>⚙️ AI CONTROLLED CONFIGURATION</span>
                <span style="font-size: 12px; color: #888;">Auto-adjusts every 60 seconds</span>
            </div>
            <div class="card-body">
                <div class="config-grid">
                    <div class="config-item">
                        <div class="config-label">LEVERAGE</div>
                        <div class="config-value"><span id="cfgLeverage">${config.leverage}</span><span class="config-unit">x</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">TAKE PROFIT</div>
                        <div class="config-value"><span id="cfgTP">${config.takeProfitPct}</span><span class="config-unit">%</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">BASE VOLUME</div>
                        <div class="config-value"><span id="cfgVolume">${config.baseVolume}</span><span class="config-unit">contracts</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">MARTINGALE MULTIPLIER</div>
                        <div class="config-value"><span id="cfgMultiplier">${config.multiplier}</span><span class="config-unit">x</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">STEP TRIGGER</div>
                        <div class="config-value">-<span id="cfgStep">${config.stepDistancePct}</span><span class="config-unit">%</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">RISK PERCENT</div>
                        <div class="config-value"><span id="cfgRisk">${config.riskPercent}</span><span class="config-unit">%</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">MAX START SPREAD</div>
                        <div class="config-value"><span id="cfgSpread">${config.maxStartSpread}</span><span class="config-unit">%</span></div>
                    </div>
                    <div class="config-item">
                        <div class="config-label">AUTO-COMPOUND</div>
                        <div class="config-value"><span id="cfgCompound">${config.autoCompound ? 'ON' : 'OFF'}</span></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Positions -->
        <div class="positions-grid" style="margin-bottom: 20px;">
            <div class="position-card">
                <div class="position-title long">📈 LONG POSITION</div>
                <div class="position-row"><span class="position-label">ROI:</span><span class="position-value" id="lRoi">0.00%</span></div>
                <div class="position-row"><span class="position-label">Unrealized PnL:</span><span class="position-value" id="lPnl">$0.00</span></div>
                <div class="position-row"><span class="position-label">Volume:</span><span class="position-value" id="lVol">0 contracts</span></div>
                <div class="position-row"><span class="position-label">DOGE Amount:</span><span class="position-value" id="lDoge">0 DOGE</span></div>
                <div class="position-row"><span class="position-label">Entry Price:</span><span class="position-value" id="lEntry">0.00000000</span></div>
                <div class="position-row"><span class="position-label">Target Price:</span><span class="position-value" id="lTarget">0.00000000</span></div>
                <div class="position-row"><span class="position-label">Status:</span><span class="position-value" id="lAction">Idle</span></div>
            </div>
            <div class="position-card">
                <div class="position-title short">📉 SHORT POSITION</div>
                <div class="position-row"><span class="position-label">ROI:</span><span class="position-value" id="sRoi">0.00%</span></div>
                <div class="position-row"><span class="position-label">Unrealized PnL:</span><span class="position-value" id="sPnl">$0.00</span></div>
                <div class="position-row"><span class="position-label">Volume:</span><span class="position-value" id="sVol">0 contracts</span></div>
                <div class="position-row"><span class="position-label">DOGE Amount:</span><span class="position-value" id="sDoge">0 DOGE</span></div>
                <div class="position-row"><span class="position-label">Entry Price:</span><span class="position-value" id="sEntry">0.00000000</span></div>
                <div class="position-row"><span class="position-label">Target Price:</span><span class="position-value" id="sTarget">0.00000000</span></div>
                <div class="position-row"><span class="position-label">Status:</span><span class="position-value" id="sAction">Idle</span></div>
            </div>
        </div>

        <!-- Trade History -->
        <div class="card">
            <div class="card-header">📋 CLOSED TRADES</div>
            <div class="card-body">
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr><th>SIDE</th><th>OPEN TIME</th><th>CLOSE TIME</th><th>STEP</th><th>VOL</th><th>DOGE</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>PNL</th></tr>
                        </thead>
                        <tbody id="tradesBody">
                            <tr><td colspan="10" style="text-align: center; color: #888;">No closed trades</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function setLeverage(leverage) {
            const res = await fetch('/api/set-leverage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leverage: parseInt(leverage) })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                location.reload();
            } else {
                alert('Failed: ' + (data.error || 'Unknown error'));
            }
        }
        
        async function forceSync() {
            const btn = event.target;
            btn.textContent = '🔄 Syncing...';
            await fetch('/api/force-sync', {method: 'POST'});
            setTimeout(() => btn.textContent = '🔄 Force Sync', 1000);
        }
        
        async function emergencyClose() {
            if(confirm('⚠️ Close ALL positions?')) {
                await fetch('/api/close', {method: 'POST'});
                alert('Emergency liquidation initiated');
            }
        }
        
        async function refreshAI() {
            const btn = event.target;
            btn.textContent = '⟳ Forcing...';
            await fetch('/api/ai-refresh', {method: 'POST'});
            setTimeout(() => btn.textContent = '🔄 Force AI Reconfig', 1000);
        }
        
        function formatNumber(num) { return parseFloat(num).toFixed(4); }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Stats
                document.getElementById('totalWallet').textContent = '$' + formatNumber(data.market.totalEquity);
                document.getElementById('totalPnl').textContent = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + formatNumber(data.market.totalNetGain);
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl >= 0 ? '+' : '') + '$' + formatNumber(data.market.totalRealizedPnl);
                document.getElementById('feesPaid').innerHTML = 'Fees: $' + formatNumber(data.market.totalFeesPaid);
                document.getElementById('peakEquity').innerHTML = '$' + formatNumber(data.market.peakEquity);
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = data.market.totalTrades || 0;
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + (data.market.winRate || 0) + '%';
                document.getElementById('spread').innerHTML = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('marketPrice').innerHTML = 'BID: ' + (data.market.bid || 0).toFixed(6) + ' | ASK: ' + (data.market.ask || 0).toFixed(6);
                
                // Wallet Change
                const change = data.market.totalNetGain || 0;
                document.getElementById('walletChange').innerHTML = (change >= 0 ? '↑' : '↓') + ' $' + Math.abs(change).toFixed(4);
                document.getElementById('walletChange').className = 'stat-change ' + (change >= 0 ? 'positive' : 'negative');
                document.getElementById('pnlPercent').innerHTML = (data.market.growthPct >= 0 ? '+' : '') + data.market.growthPct.toFixed(2) + '%';
                document.getElementById('pnlPercent').className = 'stat-change ' + (data.market.growthPct >= 0 ? 'positive' : 'negative');
                
                // Config
                if (data.market.currentConfig) {
                    document.getElementById('cfgLeverage').innerHTML = data.market.currentConfig.leverage;
                    document.getElementById('cfgTP').innerHTML = data.market.currentConfig.takeProfitPct;
                    document.getElementById('cfgVolume').innerHTML = data.market.currentConfig.baseVolume;
                    document.getElementById('cfgMultiplier').innerHTML = data.market.currentConfig.multiplier;
                    document.getElementById('cfgStep').innerHTML = data.market.currentConfig.stepDistancePct;
                    document.getElementById('cfgRisk').innerHTML = data.market.currentConfig.riskPercent;
                    document.getElementById('cfgSpread').innerHTML = data.market.currentConfig.maxStartSpread;
                }
                
                // AI Recommendation
                if (data.market.aiRecommendation) {
                    document.getElementById('aiRecommendation').innerHTML = data.market.aiRecommendation.text.replace(/\\n/g, '<br>');
                    document.getElementById('aiTimestamp').innerHTML = 'Last updated: ' + data.market.aiRecommendation.time;
                }
                
                // Positions
                const long = data.accounts?.find(a => a.direction === 'buy');
                const short = data.accounts?.find(a => a.direction === 'sell');
                
                if (long) {
                    document.getElementById('lRoi').innerHTML = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + '$' + long.unrealizedUsdt.toFixed(6);
                    document.getElementById('lVol').innerHTML = long.volume + ' contracts';
                    document.getElementById('lDoge').innerHTML = (long.dogeAmount || 0).toLocaleString() + ' DOGE';
                    document.getElementById('lEntry').innerHTML = long.entryPrice?.toFixed(8) || '0.00000000';
                    document.getElementById('lTarget').innerHTML = long.targetPrice?.toFixed(8) || '0.00000000';
                    document.getElementById('lAction').innerHTML = long.lastAction || 'Idle';
                    document.getElementById('lRoi').className = 'position-value ' + (long.roi >= 0 ? 'positive' : 'negative');
                }
                
                if (short) {
                    document.getElementById('sRoi').innerHTML = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + '$' + short.unrealizedUsdt.toFixed(6);
                    document.getElementById('sVol').innerHTML = short.volume + ' contracts';
                    document.getElementById('sDoge').innerHTML = (short.dogeAmount || 0).toLocaleString() + ' DOGE';
                    document.getElementById('sEntry').innerHTML = short.entryPrice?.toFixed(8) || '0.00000000';
                    document.getElementById('sTarget').innerHTML = short.targetPrice?.toFixed(8) || '0.00000000';
                    document.getElementById('sAction').innerHTML = short.lastAction || 'Idle';
                    document.getElementById('sRoi').className = 'position-value ' + (short.roi >= 0 ? 'positive' : 'negative');
                }
                
                // Trades Table
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 20).forEach(t => {
                        const roiVal = parseFloat(t.roi);
                        tradesHtml += `<tr>
                            <td class="${t.side === 'LONG' ? 'trade-long' : 'trade-short'}">${t.side}</td>
                            <td>${t.openTime || '--'}</td>
                            <td>${t.closeTime || '--'}</td>
                            <td>${t.step || 0}</td>
                            <td>${t.volume}</td>
                            <td>${(t.volume * 100).toLocaleString()}</td>
                            <td>${t.entryPrice}</td>
                            <td>${t.exitPrice}</td>
                            <td class="${roiVal >= 0 ? 'positive' : 'negative'}">${roiVal >= 0 ? '+' : ''}${t.roi}</td>
                            <td class="${parseFloat(t.netPnlUsdt) >= 0 ? 'positive' : 'negative'}">${parseFloat(t.netPnlUsdt) >= 0 ? '+' : ''}$${t.netPnlUsdt}</td>
                        </tr>`;
                    });
                } else {
                    tradesHtml = '<tr><td colspan="10" style="text-align: center; color: #888;">No closed trades</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
                
            } catch(e) { console.error(e); }
        }, 2000);
    </script>
</body>
</html>
    `);
});

// ==================== START BOT ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', async () => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    console.log(`\n✅ Martingale DOGE Bot Started`);
    console.log(`🎯 Leverage: ${config.leverage}x = ${config.takeProfitPct}% TP (${requiredPriceMovePct}% move)`);
    console.log(`📊 Base Volume: ${config.baseVolume} | Risk: ${config.riskPercent}%`);
    console.log(`📈 Multiplier: ${config.multiplier}x | Step: -${config.stepDistancePct}%`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`🤖 AI Controller: ACTIVE (updates every 60s)\n`);
});
