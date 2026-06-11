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

// Dynamic config - ALL parameters auto-adjusted by AI
let config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: 50,
    baseVolume: 1,
    multiplier: 1.5,
    stepDistancePct: 10,
    takeProfitPct: 10,
    maxStartSpread: 0.1,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 0.5,
    dogePerContract: 100,
    stepCooldownMs: 10 * 60 * 1000,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    
    // AI Settings - Real-time optimization
    aiEnabled: true,
    aiControlInterval: 15000, // 15 seconds
    lastAIConfigUpdate: 0,
    lastEmergencyCheck: 0,
    
    // HTX DOGE OPTIMAL RANGES
    allowedLeverages: [75, 50, 25, 10],
    leverageTPMapping: { 75: 15, 50: 10, 25: 5, 10: 1.5 },
    minLeverage: 10, maxLeverage: 75,
    minBaseVolume: 1, maxBaseVolume: 100,
    minMultiplier: 1.1, maxMultiplier: 2.0,
    minStepDistance: 5, maxStepDistance: 20,
    minRiskPercent: 0.1, maxRiskPercent: 3.0,
    minMaxStartSpread: 0.05, maxMaxStartSpread: 0.3,
    
    // Efficiency thresholds
    maxDailyFees: 0.02,
    profitTarget: 10,
    stopLossThreshold: 15,
    efficiencyTarget: 0.8
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0,
    walletHistory: [],
    peakEquity: 0,
    maxDrawdown: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalFeesPaid: 0,
    currentBaseVolume: 1,
    currentBaseDoge: 0,
    currentRiskAmount: 0,
    aiRecommendation: null,
    aiLastUpdate: 0,
    aiConfigChanges: [],
    dailyFees: 0,
    lastFeeReset: Date.now(),
    lastActionTime: 0
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let lastStepTime = {};

// ==================== HELPER FUNCTIONS ====================

function calculateTargetPrice(state) {
    const requiredPriceMovePct = config.takeProfitPct / config.leverage;
    if (state.direction === 'buy') {
        return state.entryPrice * (1 + (requiredPriceMovePct / 100)) * (1 + config.takerFeeRate);
    } else {
        return state.entryPrice * (1 - (requiredPriceMovePct / 100)) * (1 - config.takerFeeRate);
    }
}

function calculateStepFromVolume(volume, baseVolume, multiplier) {
    if (volume === 0) return 0;
    let totalVolume = 0, step = 0;
    while (totalVolume < volume) {
        const stepVolume = step === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, step));
        totalVolume += stepVolume;
        if (totalVolume <= volume) step++;
        else break;
    }
    return step;
}

function calculateBaseVolumeFromWallet(totalEquity) {
    if (!config.autoCompound || totalEquity <= 0) return config.baseVolume;
    const riskAmount = totalEquity * (config.riskPercent / 100);
    let volume = Math.floor(riskAmount / 0.005);
    volume = Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, volume));
    if (market.spread > 0.15) volume = Math.floor(volume * 0.6);
    else if (market.spread > 0.1) volume = Math.floor(volume * 0.8);
    const leverageFactor = 75 / config.leverage;
    volume = Math.floor(volume * Math.min(1.5, Math.max(0.5, leverageFactor)));
    volume = Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, volume));
    market.currentRiskAmount = riskAmount;
    market.currentBaseDoge = volume * config.dogePerContract;
    return volume;
}

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
    if (now - market.lastFeeReset > 86400000) { market.dailyFees = 0; market.lastFeeReset = now; }
    
    const lastRecord = market.walletHistory[market.walletHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000) {
        market.walletHistory.push({
            timestamp: now, time: new Date().toLocaleString(), equity: totalEquity,
            pnl: totalEquity - market.initialTotalEquity,
            pnlPercent: market.initialTotalEquity > 0 ? ((totalEquity - market.initialTotalEquity) / market.initialTotalEquity) * 100 : 0
        });
        if (market.walletHistory.length > 100) market.walletHistory.shift();
    }
    if (totalEquity > market.peakEquity) market.peakEquity = totalEquity;
    if (market.peakEquity > 0) {
        const currentDrawdown = ((market.peakEquity - totalEquity) / market.peakEquity) * 100;
        if (currentDrawdown > market.maxDrawdown) market.maxDrawdown = currentDrawdown;
    }
}

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false, pendingOrderId: null, lastAction: 'Idle',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        targetPrice: 0, realizedPnl: 0, totalFees: 0
    };
    lastStepTime[account.accountId] = 0;
});

function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp, ...params };
    const sortedParams = Object.keys(allParams).sort().map(key => `${key}=${encodeURIComponent(allParams[key])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedParams].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    return { timestamp, signature, sortedParams };
}

async function htxRequest(account, method, path, data = {}) {
    try {
        const { sortedParams, signature } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        const options = { method, url, headers: { 'Content-Type': 'application/json' }, timeout: 5000 };
        if (method === 'POST') options.data = data;
        const res = await axios(options);
        return res.data;
    } catch (e) { return { status: 'error', msg: e.message }; }
}

async function closePosition(account, state) {
    if (state.volume === 0) return true;
    console.log(`🔒 Closing ${state.direction} position (${state.volume} contracts)...`);
    const res = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbol, volume: state.volume,
        direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close',
        lever_rate: config.leverage, order_price_type: 'optimal_20'
    });
    if (res?.status === 'ok') {
        state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0;
        state.entryPrice = 0; state.targetPrice = 0; state.startTime = null;
        return true;
    }
    return false;
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
            contract_code: config.symbol, order_id: state.pendingOrderId
        });
        if (orderRes?.data?.[0]?.status === 6 || orderRes?.data?.[0]?.status === 7 || 
            orderRes?.data?.[0]?.status === 4 || orderRes?.data?.[0]?.status === 5) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else return;
    }
    if (state.isLocked) return;
    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) return;
    lastPositionFetch[acc.accountId] = now;

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos && parseFloat(pos.volume) > 0) {
            state.volume = parseFloat(pos.volume);
            state.entryPrice = parseFloat(pos.cost_open);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
            state.targetPrice = calculateTargetPrice(state);
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else if (state.volume !== 0) {
            console.log(`✅ ${state.direction.toUpperCase()} position closed`);
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0;
            state.entryPrice = 0; state.targetPrice = 0; state.startTime = null;
        }
    }

    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) return;
    lastBalanceFetch[acc.accountId] = now;
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTrade(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    const fee = Math.abs(finalPnl) * config.takerFeeRate;
    market.totalTrades++;
    if (finalPnl >= 0) market.winningTrades++;
    else market.losingTrades++;
    market.totalFeesPaid += fee;
    market.dailyFees += fee;
    tradeHistory.unshift({
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime, closeTime: exitTime,
        volume: state.volume, step: step,
        entryPrice: state.entryPrice.toFixed(8), exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%', pnl: finalPnl.toFixed(8), fee: fee.toFixed(8)
    });
    if (tradeHistory.length > 30) tradeHistory.pop();
    state.realizedPnl += finalPnl;
    console.log(`📊 CLOSED ${state.direction} | ROI: ${finalRoi.toFixed(2)}% | PnL: $${finalPnl.toFixed(8)}`);
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
                if (msg.tick && msg.ch?.includes('bbo')) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                }
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            } catch (e) {}
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== SMART AI CONTROLLER - AUTO ADJUSTS EVERY SETTING ====================

async function smartAIController() {
    const long = accountStates[1];
    const short = accountStates[2];
    const totalEquity = (long?.currentEquity || 0) + (short?.currentEquity || 0);
    const drawdown = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100) : 0;
    const winRate = market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100) : 0;
    const longRoi = long?.roi || 0;
    const shortRoi = short?.roi || 0;
    const longVol = long?.volume || 0;
    const shortVol = short?.volume || 0;
    const combinedPnL = (long?.unrealizedUsdt || 0) + (short?.unrealizedUsdt || 0);
    const efficiency = market.totalTrades > 0 ? (market.winningTrades / market.totalTrades) : 0.5;
    const isBothNegative = longRoi < 0 && shortRoi < 0;
    const isOneProfitable = (longRoi > 0 && shortRoi < 0) || (longRoi < 0 && shortRoi > 0);
    
    let changes = [];
    let settingsChanged = false;
    let emergencyAction = false;
    
    console.log(`\n🧠 SMART AI ANALYSIS (${new Date().toLocaleTimeString()})`);
    console.log(`   Wallet: $${totalEquity.toFixed(4)} | DD: ${drawdown.toFixed(2)}% | WR: ${winRate.toFixed(0)}%`);
    console.log(`   LONG: ${longRoi.toFixed(2)}% (${longVol} vol) | SHORT: ${shortRoi.toFixed(2)}% (${shortVol} vol)`);
    
    // ===== 1. EMERGENCY: BOTH POSITIONS LOSING =====
    if (isBothNegative && longVol > 0 && shortVol > 0 && drawdown > 8) {
        console.log(`🚨 EMERGENCY: Both positions losing! LONG: ${longRoi.toFixed(2)}%, SHORT: ${shortRoi.toFixed(2)}%`);
        console.log(`🔒 Closing BOTH positions to stop bleeding...`);
        await closePosition(config.accounts[0], long);
        await closePosition(config.accounts[1], short);
        emergencyAction = true;
        changes.push(`EMERGENCY: Closed both losing positions`);
    }
    // ===== 2. CLOSE LOSING POSITION WHEN ONE IS PROFITABLE =====
    else if (isOneProfitable) {
        if (longRoi < 0 && shortRoi > 0 && longVol > 0) {
            console.log(`📉 Closing losing LONG position (${longRoi.toFixed(2)}%) while SHORT is profitable`);
            await closePosition(config.accounts[0], long);
            changes.push(`Closed losing LONG position to stop losses`);
        } else if (shortRoi < 0 && longRoi > 0 && shortVol > 0) {
            console.log(`📉 Closing losing SHORT position (${shortRoi.toFixed(2)}%) while LONG is profitable`);
            await closePosition(config.accounts[1], short);
            changes.push(`Closed losing SHORT position to stop losses`);
        }
    }
    
    // ===== 3. LEVERAGE OPTIMIZATION =====
    let newLeverage = config.leverage;
    if (drawdown > 12) {
        newLeverage = 25;
        if (newLeverage !== config.leverage) changes.push(`Leverage: ${config.leverage}x → 25x (drawdown protection)`);
    } else if (drawdown > 8) {
        newLeverage = 50;
        if (newLeverage !== config.leverage) changes.push(`Leverage: ${config.leverage}x → 50x (moderate drawdown)`);
    } else if (winRate > 70 && drawdown < 5 && totalEquity > market.initialTotalEquity) {
        newLeverage = 75;
        if (newLeverage !== config.leverage) changes.push(`Leverage: ${config.leverage}x → 75x (high win rate ${winRate.toFixed(0)}%)`);
    } else if (winRate < 40) {
        newLeverage = 25;
        if (newLeverage !== config.leverage) changes.push(`Leverage: ${config.leverage}x → 25x (low win rate)`);
    }
    
    if (newLeverage !== config.leverage) {
        config.leverage = newLeverage;
        config.takeProfitPct = config.leverageTPMapping[newLeverage];
        if (long?.volume > 0) long.targetPrice = calculateTargetPrice(long);
        if (short?.volume > 0) short.targetPrice = calculateTargetPrice(short);
        settingsChanged = true;
    }
    
    // ===== 4. RISK PERCENT OPTIMIZATION =====
    let newRiskPercent = config.riskPercent;
    if (drawdown > 10) {
        newRiskPercent = Math.max(0.15, config.riskPercent * 0.5);
        if (newRiskPercent !== config.riskPercent) changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}% (drawdown protection)`);
    } else if (winRate > 70 && drawdown < 5) {
        newRiskPercent = Math.min(1.0, config.riskPercent * 1.3);
        if (newRiskPercent !== config.riskPercent) changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}% (high win rate)`);
    } else if (winRate < 40) {
        newRiskPercent = Math.max(0.2, config.riskPercent * 0.7);
        if (newRiskPercent !== config.riskPercent) changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}% (conservative)`);
    }
    if (newRiskPercent !== config.riskPercent) {
        config.riskPercent = Math.min(config.maxRiskPercent, Math.max(config.minRiskPercent, newRiskPercent));
        settingsChanged = true;
    }
    
    // ===== 5. BASE VOLUME OPTIMIZATION =====
    let newBaseVolume = config.baseVolume;
    if (drawdown > 10 || market.dailyFees > config.maxDailyFees) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.6);
        if (newBaseVolume !== config.baseVolume) changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume} (reducing fees/spending)`);
    } else if (winRate > 70 && drawdown < 5 && totalEquity > market.initialTotalEquity) {
        newBaseVolume = Math.min(10, config.baseVolume * 1.2);
        if (newBaseVolume !== config.baseVolume) changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume} (profitable strategy)`);
    } else if (efficiency < config.efficiencyTarget) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.8);
        if (newBaseVolume !== config.baseVolume) changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume} (improving efficiency)`);
    }
    if (newBaseVolume !== config.baseVolume) {
        config.baseVolume = Math.min(config.maxBaseVolume, Math.max(config.minBaseVolume, newBaseVolume));
        if (!config.autoCompound) market.currentBaseVolume = config.baseVolume;
        settingsChanged = true;
    }
    
    // ===== 6. MARTINGALE MULTIPLIER OPTIMIZATION =====
    let newMultiplier = config.multiplier;
    if (drawdown > 8) {
        newMultiplier = 1.2;
        if (newMultiplier !== config.multiplier) changes.push(`Multiplier: ${config.multiplier}x → 1.2x (drawdown reduction)`);
    } else if (winRate > 70 && drawdown < 5) {
        newMultiplier = Math.min(1.8, config.multiplier + 0.1);
        if (newMultiplier !== config.multiplier) changes.push(`Multiplier: ${config.multiplier}x → ${newMultiplier.toFixed(1)}x (aggressive)`);
    } else if (winRate < 45) {
        newMultiplier = Math.max(1.1, config.multiplier - 0.1);
        if (newMultiplier !== config.multiplier) changes.push(`Multiplier: ${config.multiplier}x → ${newMultiplier.toFixed(1)}x (conservative)`);
    }
    if (newMultiplier !== config.multiplier) {
        config.multiplier = Math.min(config.maxMultiplier, Math.max(config.minMultiplier, newMultiplier));
        settingsChanged = true;
    }
    
    // ===== 7. STEP DISTANCE OPTIMIZATION =====
    let newStepDistance = config.stepDistancePct;
    if (drawdown > 8) {
        newStepDistance = 15;
        if (newStepDistance !== config.stepDistancePct) changes.push(`Step Trigger: -${config.stepDistancePct}% → -15% (wider trigger)`);
    } else if (winRate > 70) {
        newStepDistance = 8;
        if (newStepDistance !== config.stepDistancePct) changes.push(`Step Trigger: -${config.stepDistancePct}% → -8% (tighter trigger)`);
    } else if (market.spread > 0.12) {
        newStepDistance = 12;
        if (newStepDistance !== config.stepDistancePct) changes.push(`Step Trigger: -${config.stepDistancePct}% → -12% (high spread)`);
    }
    if (newStepDistance !== config.stepDistancePct) {
        config.stepDistancePct = Math.min(config.maxStepDistance, Math.max(config.minStepDistance, newStepDistance));
        settingsChanged = true;
    }
    
    // ===== 8. MAX START SPREAD OPTIMIZATION =====
    let newMaxSpread = config.maxStartSpread;
    if (market.spread > 0.15) {
        newMaxSpread = 0.2;
        if (newMaxSpread !== config.maxStartSpread) changes.push(`Max Spread: ${config.maxStartSpread}% → 0.2% (market spread high)`);
    } else if (market.spread < 0.06) {
        newMaxSpread = 0.08;
        if (newMaxSpread !== config.maxStartSpread) changes.push(`Max Spread: ${config.maxStartSpread}% → 0.08% (tight spread)`);
    }
    if (newMaxSpread !== config.maxStartSpread) {
        config.maxStartSpread = Math.min(config.maxMaxStartSpread, Math.max(config.minMaxStartSpread, newMaxSpread));
        settingsChanged = true;
    }
    
    // ===== 9. AUTO-COMPOUND OPTIMIZATION =====
    if (drawdown > 10 && config.autoCompound) {
        config.autoCompound = false;
        changes.push(`Auto-Compound: OFF (drawdown protection)`);
        settingsChanged = true;
    } else if (drawdown < 5 && winRate > 60 && !config.autoCompound) {
        config.autoCompound = true;
        changes.push(`Auto-Compound: ON (profitable conditions)`);
        settingsChanged = true;
    }
    
    // ===== 10. UPDATE TARGET PRICES IF LEVERAGE CHANGED =====
    if (settingsChanged) {
        if (long?.volume > 0) long.targetPrice = calculateTargetPrice(long);
        if (short?.volume > 0) short.targetPrice = calculateTargetPrice(short);
    }
    
    // ===== 11. UPDATE BASE VOLUME FROM WALLET =====
    if (config.autoCompound && totalEquity > 0 && market.bid > 0) {
        const autoVolume = calculateBaseVolumeFromWallet(totalEquity);
        if (autoVolume !== market.currentBaseVolume) {
            market.currentBaseVolume = autoVolume;
            console.log(`📈 Auto-compound: volume adjusted to ${autoVolume} contracts`);
        }
    }
    
    // ===== BUILD RECOMMENDATION TEXT =====
    const requiredMove = (config.takeProfitPct / config.leverage).toFixed(3);
    const actionText = emergencyAction ? "🚨 EMERGENCY ACTION TAKEN" : 
                       (isBothNegative ? "⚠️ BOTH POSITIONS LOSING" :
                       (isOneProfitable ? "✅ ONE POSITION PROFITABLE" : "📊 MONITORING"));
    
    const recommendationText = `🧠 SMART AI CONTROLLER\n${actionText}\n\n📊 DASHBOARD ANALYSIS:\n• Wallet: $${totalEquity.toFixed(4)} (${market.growthPct.toFixed(2)}%)\n• Drawdown: ${drawdown.toFixed(2)}% | Win Rate: ${winRate.toFixed(0)}%\n• LONG: ${longRoi.toFixed(2)}% | SHORT: ${shortRoi.toFixed(2)}%\n• Fees Today: $${market.dailyFees.toFixed(6)}\n\n⚙️ CURRENT SETTINGS:\n• Leverage: ${config.leverage}x (TP: ${config.takeProfitPct}%, move: ${requiredMove}%)\n• Base Volume: ${config.baseVolume} | Risk: ${config.riskPercent}%\n• Multiplier: ${config.multiplier}x | Step: -${config.stepDistancePct}%\n• Max Spread: ${config.maxStartSpread}% | Auto-Compound: ${config.autoCompound ? 'ON' : 'OFF'}\n\n${changes.length > 0 ? '✅ CHANGES MADE:\n• ' + changes.join('\n• ') : '⚙️ Settings optimized for current conditions'}\n\n💡 GOAL: Maximize profit, minimize fees, protect capital.`;
    
    market.aiRecommendation = {
        text: recommendationText,
        timestamp: Date.now(),
        time: new Date().toLocaleString(),
        changes: changes,
        settings: {
            leverage: config.leverage,
            takeProfit: config.takeProfitPct,
            baseVolume: config.baseVolume,
            riskPercent: config.riskPercent,
            multiplier: config.multiplier,
            stepDistance: config.stepDistancePct,
            maxSpread: config.maxStartSpread,
            autoCompound: config.autoCompound
        }
    };
    
    if (changes.length > 0) {
        market.aiConfigChanges.unshift({
            timestamp: Date.now(),
            time: new Date().toLocaleString(),
            changes: changes,
            drawdown: drawdown.toFixed(2),
            winRate: winRate.toFixed(0)
        });
        if (market.aiConfigChanges.length > 20) market.aiConfigChanges.pop();
    }
    
    market.aiLastUpdate = Date.now();
    config.lastAIConfigUpdate = Date.now();
    
    console.log(`\n📊 AI SUMMARY:`);
    console.log(`   Settings: ${config.leverage}x | ${config.riskPercent}% | Vol:${config.baseVolume}`);
    console.log(`   Changes: ${changes.length > 0 ? changes.join(', ') : 'None'}`);
    console.log(`   Wallet: $${totalEquity.toFixed(4)} | DD: ${drawdown.toFixed(2)}%\n`);
    
    return true;
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        if (currentPrice === 0) continue;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}% > ${config.maxStartSpread}%)`;
                continue;
            }
            console.log(`🚀 Opening ${state.direction} | ${market.currentBaseVolume} contracts @ ${config.leverage}x`);
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: market.currentBaseVolume,
                direction: state.direction, offset: 'open', lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol, order_id: res.data.order_id_str
                    });
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Opened at ${state.entryPrice.toFixed(8)} | TP: ${state.targetPrice.toFixed(8)}`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else { state.isLocked = false; }
            continue;
        }

        let shouldTakeProfit = false, exitPrice = 0;
        if (state.direction === 'buy' && market.ask >= state.targetPrice && state.targetPrice > 0) {
            shouldTakeProfit = true; exitPrice = market.ask;
        } else if (state.direction === 'sell' && market.bid <= state.targetPrice && state.targetPrice > 0) {
            shouldTakeProfit = true; exitPrice = market.bid;
        }
        
        if (shouldTakeProfit) {
            console.log(`✅ Taking ${state.direction} profit (${config.takeProfitPct}% ROI)`);
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close',
                lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                logTrade(state, exitPrice, new Date().toLocaleString(), config.takeProfitPct, state.unrealizedUsdt);
                state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0;
                state.entryPrice = 0; state.targetPrice = 0; state.startTime = null;
                state.isLocked = false;
            } else { state.isLocked = false; }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const now = Date.now();
        const timeSinceLastStep = now - (lastStepTime[acc.accountId] || 0);
        
        if (state.roi <= -config.stepDistancePct && state.volume > 0 && timeSinceLastStep >= config.stepCooldownMs) {
            const nextStepNumber = currentStep + 1;
            let nextVol = nextStepNumber === 1 ? Math.ceil(market.currentBaseVolume * config.multiplier) : 
                          Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} | Adding: ${nextVol} contracts`);
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVol,
                direction: state.direction, offset: 'open', lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                lastStepTime[acc.accountId] = now;
            }
            state.isLocked = false;
        } else {
            state.lastAction = `Step ${currentStep} | ROI: ${state.roi.toFixed(2)}% | TP: ${config.takeProfitPct}%`;
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
        for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
        
        const long = accountStates[1], short = accountStates[2];
        if (long && short) {
            if (market.initialTotalEquity === 0 && long.initialEquity !== null && short.initialEquity !== null) {
                market.initialTotalEquity = long.initialEquity + short.initialEquity;
                market.peakEquity = market.initialTotalEquity;
                console.log(`\n💰 INITIAL EQUITY: $${market.initialTotalEquity.toFixed(4)}\n`);
            }
            if (market.initialTotalEquity > 0) {
                const totalEquity = long.currentEquity + short.currentEquity;
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                updateWalletGrowth(totalEquity);
            }
        }
        
        if (market.status === 'Active') await processMartingale();
        
        // Run AI every 15 seconds
        if (config.aiEnabled && (!config.lastAIConfigUpdate || (Date.now() - config.lastAIConfigUpdate) > config.aiControlInterval)) {
            await smartAIController();
        }
    } catch (e) { console.error('Background error:', e.message); }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const long = accountStates[1], short = accountStates[2];
    const totalEquity = (long?.currentEquity || 0) + (short?.currentEquity || 0);
    res.json({
        market: {
            ...market, totalEquity, growthPct: market.growthPct, maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades, winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            currentBaseVolume: market.currentBaseVolume, dailyFees: market.dailyFees,
            aiRecommendation: market.aiRecommendation,
            currentConfig: {
                leverage: config.leverage, takeProfitPct: config.takeProfitPct,
                riskPercent: config.riskPercent, baseVolume: config.baseVolume,
                multiplier: config.multiplier, stepDistancePct: config.stepDistancePct,
                maxStartSpread: config.maxStartSpread, autoCompound: config.autoCompound
            },
            dualMetrics: { longRoi: long?.roi || 0, shortRoi: short?.roi || 0,
                longVolume: long?.volume || 0, shortVolume: short?.volume || 0,
                combinedPnL: (long?.unrealizedUsdt || 0) + (short?.unrealizedUsdt || 0) }
        },
        accounts: [
            { direction: 'buy', roi: long?.roi || 0, volume: long?.volume || 0, dogeAmount: (long?.volume || 0) * 100,
              unrealizedUsdt: long?.unrealizedUsdt || 0, entryPrice: long?.entryPrice || 0, targetPrice: long?.targetPrice || 0,
              lastAction: long?.lastAction || 'Idle', step: calculateStepFromVolume(long?.volume || 0, market.currentBaseVolume, config.multiplier) },
            { direction: 'sell', roi: short?.roi || 0, volume: short?.volume || 0, dogeAmount: (short?.volume || 0) * 100,
              unrealizedUsdt: short?.unrealizedUsdt || 0, entryPrice: short?.entryPrice || 0, targetPrice: short?.targetPrice || 0,
              lastAction: short?.lastAction || 'Idle', step: calculateStepFromVolume(short?.volume || 0, market.currentBaseVolume, config.multiplier) }
        ],
        tradeHistory: tradeHistory.slice(0, 20)
    });
});

app.post('/api/close', async (req, res) => {
    console.log("🔴 EMERGENCY CLOSE");
    await closePosition(config.accounts[0], accountStates[1]);
    await closePosition(config.accounts[1], accountStates[2]);
    res.json({ status: 'ok' });
});

app.post('/api/force-sync', async (req, res) => {
    for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
    res.json({ status: 'ok' });
});

app.post('/api/ai-refresh', async (req, res) => {
    await smartAIController();
    res.json({ recommendation: market.aiRecommendation });
});

// Modern Clean Dashboard
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale DOGE - Smart AI Control</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        body { background: #f5f7fa; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px; }
        h1 { font-size: 24px; color: #1e293b; }
        .badge { background: #10b981; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
        .ai-badge { background: #8b5cf6; }
        .btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: 500; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-outline { background: white; border: 1px solid #e2e8f0; color: #1e293b; }
        .btn-outline:hover { background: #f1f5f9; }
        .card { background: white; border-radius: 16px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .ai-card { background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-value { font-size: 24px; font-weight: 700; color: #1e293b; margin-top: 5px; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .positions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .position-card { background: #f8fafc; border-radius: 12px; padding: 16px; border: 1px solid #e2e8f0; }
        .position-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
        .position-title.long { color: #10b981; }
        .position-title.short { color: #ef4444; }
        .pos-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
        .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-top: 15px; }
        .config-item { background: #f8fafc; border-radius: 8px; padding: 10px; text-align: center; }
        .config-value { font-size: 18px; font-weight: 700; color: #1e293b; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        .update-time { font-size: 11px; color: #64748b; margin-top: 10px; }
        @media (max-width: 768px) { .positions-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>MARTINGALE DOGE <span class="badge">AI CONTROLLED</span><span class="badge ai-badge">AUTO-OPTIMIZE</span></h1>
                <p style="color: #64748b; font-size: 13px; margin-top: 5px;">AI auto-adjusts ALL settings every 15 seconds to maximize profit & efficiency</p>
            </div>
            <div>
                <button class="btn btn-outline" onclick="forceSync()">🔄 Force Sync</button>
                <button class="btn btn-danger" onclick="emergencyClose()">⚠️ Emergency Close</button>
            </div>
        </div>

        <div class="card ai-card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div><strong>🧠 SMART AI CONTROLLER</strong> <span style="font-size: 11px; opacity: 0.8;">Analyzes & adjusts every 15 seconds</span></div>
                <button class="btn" style="background: rgba(255,255,255,0.2); color: white;" onclick="refreshAI()">🔄 Force AI</button>
            </div>
            <div id="aiRecommendation" style="margin-top: 15px; font-size: 13px; white-space: pre-line;">Initializing AI...</div>
            <div id="aiTime" class="update-time" style="color: rgba(255,255,255,0.7);"></div>
        </div>

        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">TOTAL WALLET</div><div class="stat-value" id="totalWallet">$0.00</div><div id="walletChange" class="stat-label"></div></div>
            <div class="stat-card"><div class="stat-label">TOTAL P&L</div><div class="stat-value" id="totalPnl">$0.00</div><div id="pnlPercent" class="stat-label"></div></div>
            <div class="stat-card"><div class="stat-label">DRAWDOWN</div><div class="stat-value" id="drawdown">0%</div><div class="stat-label">Peak: <span id="peakEquity">$0.00</span></div></div>
            <div class="stat-card"><div class="stat-label">WIN RATE</div><div class="stat-value" id="winRate">0%</div><div class="stat-label">Trades: <span id="tradeCount">0</span></div></div>
            <div class="stat-card"><div class="stat-label">DAILY FEES</div><div class="stat-value" id="dailyFees">$0.00</div><div class="stat-label">Spending limit</div></div>
            <div class="stat-card"><div class="stat-label">MARKET</div><div class="stat-value" id="spread">0.000%</div><div class="stat-label">Spread</div></div>
        </div>

        <div class="positions-grid">
            <div class="position-card"><div class="position-title long">📈 LONG POSITION</div>
                <div class="pos-row"><span>ROI:</span><strong id="lRoi" class="positive">0%</strong></div>
                <div class="pos-row"><span>PnL:</span><strong id="lPnl">$0.00</strong></div>
                <div class="pos-row"><span>Volume:</span><span id="lVol">0</span> contracts</div>
                <div class="pos-row"><span>DOGE:</span><span id="lDoge">0</span></div>
                <div class="pos-row"><span>Entry/Target:</span><span id="lPrices">0 / 0</span></div>
                <div class="pos-row"><span>Status:</span><span id="lAction">Idle</span></div>
            </div>
            <div class="position-card"><div class="position-title short">📉 SHORT POSITION</div>
                <div class="pos-row"><span>ROI:</span><strong id="sRoi" class="negative">0%</strong></div>
                <div class="pos-row"><span>PnL:</span><strong id="sPnl">$0.00</strong></div>
                <div class="pos-row"><span>Volume:</span><span id="sVol">0</span> contracts</div>
                <div class="pos-row"><span>DOGE:</span><span id="sDoge">0</span></div>
                <div class="pos-row"><span>Entry/Target:</span><span id="sPrices">0 / 0</span></div>
                <div class="pos-row"><span>Status:</span><span id="sAction">Idle</span></div>
            </div>
        </div>

        <div class="card">
            <div class="stat-label">⚙️ AI AUTO-OPTIMIZED CONFIGURATION</div>
            <div class="config-grid">
                <div class="config-item"><div class="stat-label">LEVERAGE</div><div class="config-value" id="cfgLeverage">50</div><div style="font-size:10px;">x</div></div>
                <div class="config-item"><div class="stat-label">TAKE PROFIT</div><div class="config-value" id="cfgTP">10</div><div style="font-size:10px;">%</div></div>
                <div class="config-item"><div class="stat-label">BASE VOLUME</div><div class="config-value" id="cfgVolume">1</div><div style="font-size:10px;">contracts</div></div>
                <div class="config-item"><div class="stat-label">MULTIPLIER</div><div class="config-value" id="cfgMultiplier">1.5</div><div style="font-size:10px;">x</div></div>
                <div class="config-item"><div class="stat-label">STEP TRIGGER</div><div class="config-value" id="cfgStep">10</div><div style="font-size:10px;">%</div></div>
                <div class="config-item"><div class="stat-label">RISK</div><div class="config-value" id="cfgRisk">0.5</div><div style="font-size:10px;">%</div></div>
                <div class="config-item"><div class="stat-label">MAX SPREAD</div><div class="config-value" id="cfgSpread">0.1</div><div style="font-size:10px;">%</div></div>
                <div class="config-item"><div class="stat-label">AUTO-COMPOUND</div><div class="config-value" id="cfgCompound">ON</div></div>
            </div>
        </div>

        <div class="card">
            <div class="stat-label">📋 CLOSED TRADES</div>
            <div style="overflow-x: auto; margin-top: 15px;">
                <table><thead><tr><th>SIDE</th><th>TIME</th><th>VOL</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>PNL</th></tr></thead>
                <tbody id="tradesBody"><tr><td colspan="7" style="text-align: center;">Loading...</td></tr></tbody></table>
            </div>
        </div>
    </div>

    <script>
        async function forceSync() { await fetch('/api/force-sync', {method: 'POST'}); }
        async function emergencyClose() { if(confirm('Close ALL positions?')) await fetch('/api/close', {method: 'POST'}); }
        async function refreshAI() { await fetch('/api/ai-refresh', {method: 'POST'}); }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalWallet').innerHTML = '$' + (data.market.totalEquity?.toFixed(4) || '0.00');
                document.getElementById('totalPnl').innerHTML = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + (data.market.totalNetGain?.toFixed(4) || '0.00');
                document.getElementById('drawdown').innerHTML = (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('peakEquity').innerHTML = '$' + (data.market.peakEquity?.toFixed(4) || '0.00');
                document.getElementById('winRate').innerHTML = (data.market.winRate || 0) + '%';
                document.getElementById('tradeCount').innerHTML = data.market.totalTrades || 0;
                document.getElementById('dailyFees').innerHTML = '$' + (data.market.dailyFees?.toFixed(6) || '0.00');
                document.getElementById('spread').innerHTML = (data.market.spread || 0).toFixed(3) + '%';
                
                if (data.market.aiRecommendation) {
                    document.getElementById('aiRecommendation').innerHTML = data.market.aiRecommendation.text.replace(/\\n/g, '<br>');
                    document.getElementById('aiTime').innerHTML = 'Last update: ' + data.market.aiRecommendation.time;
                }
                
                const long = data.accounts?.[0];
                const short = data.accounts?.[1];
                
                if (long) {
                    document.getElementById('lRoi').innerHTML = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + '$' + long.unrealizedUsdt?.toFixed(4);
                    document.getElementById('lVol').innerHTML = long.volume || 0;
                    document.getElementById('lDoge').innerHTML = long.dogeAmount || 0;
                    document.getElementById('lPrices').innerHTML = (long.entryPrice?.toFixed(6) || '0') + ' / ' + (long.targetPrice?.toFixed(6) || '0');
                    document.getElementById('lAction').innerHTML = long.lastAction || 'Idle';
                    document.getElementById('lRoi').className = long.roi >= 0 ? 'positive' : 'negative';
                }
                if (short) {
                    document.getElementById('sRoi').innerHTML = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + '$' + short.unrealizedUsdt?.toFixed(4);
                    document.getElementById('sVol').innerHTML = short.volume || 0;
                    document.getElementById('sDoge').innerHTML = short.dogeAmount || 0;
                    document.getElementById('sPrices').innerHTML = (short.entryPrice?.toFixed(6) || '0') + ' / ' + (short.targetPrice?.toFixed(6) || '0');
                    document.getElementById('sAction').innerHTML = short.lastAction || 'Idle';
                    document.getElementById('sRoi').className = short.roi >= 0 ? 'positive' : 'negative';
                }
                
                if (data.market.currentConfig) {
                    document.getElementById('cfgLeverage').innerHTML = data.market.currentConfig.leverage;
                    document.getElementById('cfgTP').innerHTML = data.market.currentConfig.takeProfitPct;
                    document.getElementById('cfgVolume').innerHTML = data.market.currentConfig.baseVolume;
                    document.getElementById('cfgMultiplier').innerHTML = data.market.currentConfig.multiplier;
                    document.getElementById('cfgStep').innerHTML = data.market.currentConfig.stepDistancePct;
                    document.getElementById('cfgRisk').innerHTML = data.market.currentConfig.riskPercent;
                    document.getElementById('cfgSpread').innerHTML = data.market.currentConfig.maxStartSpread;
                    document.getElementById('cfgCompound').innerHTML = data.market.currentConfig.autoCompound ? 'ON' : 'OFF';
                }
                
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 15).forEach(t => {
                        tradesHtml += `<tr><td class="${t.side === 'LONG' ? 'positive' : 'negative'}">${t.side}</td>
                        <td>${t.closeTime?.split(',')[1] || ''}</td><td>${t.volume}</td>
                        <td>${t.entryPrice}</td><td>${t.exitPrice}</td>
                        <td class="${parseFloat(t.roi) >= 0 ? 'positive' : 'negative'}">${t.roi}</td>
                        <td class="${parseFloat(t.pnl) >= 0 ? 'positive' : 'negative'}">$${t.pnl}</td></tr>`;
                    });
                } else { tradesHtml = '<tr><td colspan="7" style="text-align: center;">No trades</td></tr>'; }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
            } catch(e) { console.error(e); }
        }, 2000);
    </script>
</body>
</html>`;
    res.send(html);
});

// ==================== START BOT ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ MARTINGALE DOGE BOT STARTED`);
    console.log(`🎯 Leverage: ${config.leverage}x = ${config.takeProfitPct}% TP`);
    console.log(`🤖 SMART AI: Auto-adjusts ALL settings every 15 seconds`);
    console.log(`💰 Goals: Maximize profit | Reduce fees | Protect capital`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
