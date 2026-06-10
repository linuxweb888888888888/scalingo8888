require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// Changed to Static Paper Accounts to match original logic flow
const apiAccounts = [
    { apiKey: 'PAPER_1', secretKey: 'PAPER_1', accountId: 1 },
    { apiKey: 'PAPER_2', secretKey: 'PAPER_2', accountId: 2 }
];

const config = {
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 75,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 10, // Triggers at -10% ROI
    takeProfitPct: 15,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.1,
    takerFeeRate: 0.0005,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 2,
    shibPerContract: 1000,
    walletPerContract: 0.0066135  // $0.0066135 wallet = 1 contract at 75x leverage
};

// ==================== PAPER ENGINE STORAGE ====================
let paperBalances = { 1: 50.0, 2: 50.0 }; // Total $100 starting equity
let paperPositions = { 1: null, 2: null };

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
    lastBaseUpdate: Date.now()
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};

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
});

// ==================== MOCKED HTX REQUEST (PAPER ENGINE) ====================
async function htxRequest(account, method, path, data = {}) {
    const accId = account.accountId;
    const price = market.bid || 0;

    // Simulate Account Balance
    if (path.includes('swap_cross_account_info')) {
        let unrealized = 0;
        const pos = paperPositions[accId];
        if (pos) {
            const sideMult = pos.direction === 'buy' ? 1 : -1;
            unrealized = pos.volume * config.shibPerContract * config.contractMultiplier * (price - pos.entryPrice) * sideMult;
        }
        return { status: 'ok', data: [{ margin_balance: paperBalances[accId] + unrealized, withdraw_available: paperBalances[accId] }] };
    }

    // Simulate Position Data
    if (path.includes('swap_cross_position_info')) {
        const pos = paperPositions[accId];
        if (!pos) return { status: 'ok', data: [] };
        const sideMult = pos.direction === 'buy' ? 1 : -1;
        const pnl = pos.volume * config.shibPerContract * config.contractMultiplier * (price - pos.entryPrice) * sideMult;
        const margin = (pos.volume * config.shibPerContract * config.contractMultiplier * pos.entryPrice) / config.leverage;
        return { status: 'ok', data: [{ direction: pos.direction, volume: pos.volume, cost_open: pos.entryPrice, profit: pnl, profit_rate: pnl/margin }] };
    }

    // Simulate Order Info
    if (path.includes('swap_cross_order_info')) {
        return { status: 'ok', data: [{ status: 6, price_avg: price }] };
    }

    // Simulate Order Execution
    if (path.includes('swap_cross_order')) {
        if (price === 0) return { status: 'error' };
        const fee = data.volume * config.shibPerContract * config.contractMultiplier * price * config.takerFeeRate;
        paperBalances[accId] -= fee;
        if (data.offset === 'open') {
            const current = paperPositions[accId];
            if (current) {
                const totalVol = current.volume + data.volume;
                const newEntry = ((current.entryPrice * current.volume) + (price * data.volume)) / totalVol;
                paperPositions[accId] = { direction: data.direction, volume: totalVol, entryPrice: newEntry };
            } else {
                paperPositions[accId] = { direction: data.direction, volume: data.volume, entryPrice: price };
            }
        } else {
            const pos = paperPositions[accId];
            const sideMult = pos.direction === 'buy' ? 1 : -1;
            const pnl = pos.volume * config.shibPerContract * config.contractMultiplier * (price - pos.entryPrice) * sideMult;
            paperBalances[accId] += pnl;
            paperPositions[accId] = null;
        }
        return { status: 'ok', data: { order_id_str: 'PAPER-' + Date.now() } };
    }
    return { status: 'ok' };
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
                    timestamp: now, exchangeRoi: newExchangeRoi, botRoi: state.roi, latencyMs: timeSinceLastUpdate,
                    difference: Math.abs(newExchangeRoi - state.roi).toFixed(2), volume: newVolume, step: calculatedStep
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
                state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
                state.lastStepPrice = 0; state.startTime = null; state.lastAddedVolume = 0;
                state.lastExchangeRoi = 0; state.targetPrice = 0;
            }
        }
    }

    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) return;
    lastBalanceFetch[acc.accountId] = now;

    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    const estimatedFee = Math.abs(finalPnl) * config.takerFeeRate;
    market.totalTrades++;
    if (finalPnl >= 0) market.winningTrades++; else market.losingTrades++;
    market.totalFeesPaid += estimatedFee;
    tradeHistory.unshift({
        symbol: config.symbolClean + 'Perpetual', side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime, closeTime: exitTime, volume: state.volume, step: step,
        entryPrice: state.entryPrice.toFixed(8), exitPrice: exitPrice.toFixed(8), roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8), estimatedFee: estimatedFee.toFixed(8)
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                if (msg.tick && msg.ch && msg.ch.includes('bbo')) {
                    market.bid = msg.tick.bid[0]; market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                    market.lastPriceUpdate = Date.now();
                }
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            } catch (e) {}
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
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
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: market.currentBaseVolume, direction: state.direction, offset: 'open',
                lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol, order_id: res.data.order_id_str
                    });
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        state.isLocked = false;
                    }
                }, 2000);
            } else { state.isLocked = false; }
            continue;
        }

        let shouldTakeProfit = state.direction === 'buy' ? (market.ask >= state.targetPrice) : (market.bid <= state.targetPrice);
        if (shouldTakeProfit && state.targetPrice > 0) {
            const finalRoi = config.takeProfitPct;
            const finalPnl = state.unrealizedUsdt;
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                logTradeExchangeStyle(state, currentPrice, new Date().toLocaleString(), finalRoi, finalPnl);
                state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
                state.lastStepPrice = 0; state.startTime = null; state.targetPrice = 0;
            } else { state.isLocked = false; }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        if (state.roi <= -10 && state.volume > 0) {
            const nextStepNumber = currentStep + 1;
            const nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVol, direction: state.direction, offset: 'open',
                lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = `Martingale Step ${nextStepNumber} (-${Math.abs(state.roi).toFixed(1)}% loss)`;
            } else { state.isLocked = false; }
        } else {
            state.lastAction = `Active - Step ${currentStep} | ROI: ${state.roi.toFixed(2)}%`;
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
        for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
        const s1 = accountStates[1]; const s2 = accountStates[2];
        if (s1 && s2) {
            if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
                market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                market.peakEquity = market.initialTotalEquity;
            }
            if (market.initialTotalEquity > 0) {
                const totalEquity = s1.currentEquity + s2.currentEquity;
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedHours = (Date.now() - market.startTime) / (1000 * 60 * 60);
                market.dgr = elapsedHours > 0 ? (market.growthPct / elapsedHours) : 0;
                if (config.autoCompound && market.bid > 0) {
                    market.currentBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                }
                updateWalletGrowth(totalEquity);
            }
        }
        if (market.status === 'Active') await processMartingale();
    } catch (e) { console.error('Background loop error:', e); }
}

app.get('/api/status', (req, res) => {
    const s1 = accountStates[1]; const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const accountsWithInfo = Object.values(accountStates).map(state => {
        const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        return {
            direction: state.direction, roi: state.roi, volume: state.volume, step: step,
            unrealizedUsdt: state.unrealizedUsdt, entryPrice: state.entryPrice, lastAction: state.lastAction,
            startTime: state.startTime, targetPrice: state.targetPrice, currentEquity: state.currentEquity,
            initialEquity: state.initialEquity, realizedPnl: state.realizedPnl, totalFees: state.totalFees
        };
    });
    res.json({
        market: { ...market, totalEquity, totalRealizedPnl: (s1?.realizedPnl || 0) + (s2?.realizedPnl || 0), winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0 },
        accounts: accountsWithInfo, tradeHistory, config: { ...config, baseVolume: market.currentBaseVolume }
    });
});

app.post('/api/force-sync', async (req, res) => {
    for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
    res.json({ status: 'ok' });
});

app.post('/api/close', async (req, res) => {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: s.volume, direction: s.direction === 'buy' ? 'sell' : 'buy', offset: 'close'
            });
        }
    }
    setTimeout(() => market.status = "Active", 5000);
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Paper Trading</title>
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
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
        .step-badge { background: #6366F120; color: #6366F1; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #00D1B240; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">PAPER MODE</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% move</span>
                </div>
            </div>
            <div>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
                <div><p class="stat-label">TOTAL WALLET</p><p id="totalWallet" class="stat-number value-positive">$0.00000000</p><p id="walletChange" class="text-xs"></p></div>
                <div><p class="stat-label">TOTAL P&L</p><p id="totalPnl" class="stat-number">$0.00000000</p><p id="pnlPercent" class="text-xs"></p></div>
                <div><p class="stat-label">REALIZED P&L</p><p id="realizedPnl" class="stat-number">$0.00000000</p><p id="feesPaid" class="text-xs text-slate-500">Fees: $0.00</p></div>
                <div><p class="stat-label">PERFORMANCE</p><p id="peakEquity" class="text-sm">Peak: $0.00</p><p id="maxDrawdown" class="text-sm text-red-400">DD: 0%</p></div>
                <div><p class="stat-label">STATISTICS</p><p id="tradeStats" class="text-sm">Trades: 0</p><p id="winRate" class="text-sm text-green-400">Win Rate: 0%</p></div>
            </div>
            <div class="compound-info mt-4 flex justify-between items-center">
                <div>
                    <p class="text-xs text-slate-400">📈 AUTO-COMPOUNDING (${config.riskPercent}% of Wallet)</p>
                    <p class="text-sm font-bold text-green-400" id="baseVolumeDisplay">Base Volume: 0 contracts</p>
                    <p class="text-xs text-slate-400" id="shibDisplay">0 SHIB per trade</p>
                </div>
                <div class="text-right">
                    <p class="text-xs text-slate-400">Risk Amount (2%)</p>
                    <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                    <p class="text-xs text-slate-400">🟢 Active</p>
                </div>
            </div>
        </div>

        <div class="card mb-8">
            <h3 class="font-bold mb-4">📈 WALLET GROWTH CHART</h3>
            <div class="chart-container"><canvas id="walletChart"></canvas></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label">MARKET</p>
                <p id="spread" class="text-2xl font-black">0.000%</p>
                <p class="text-[10px] text-slate-500">BID: <span id="bidPrice">0</span> | ASK: <span id="askPrice">0</span></p>
            </div>
            <div class="card">
                <p class="stat-label">LONG ROI</p>
                <p id="lRoi" class="text-2xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm mono">$0.00000000</p>
                <p id="lStep" class="text-[10px] mt-1"></p>
            </div>
            <div class="card">
                <p class="stat-label">SHORT ROI</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono">$0.00000000</p>
                <p id="sStep" class="text-[10px] mt-1"></p>
            </div>
            <div class="card">
                <p class="stat-label">ACTION</p>
                <p id="lAction" class="text-xs text-indigo-400 mt-1">Idle</p>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <div class="overflow-x-auto"><table class="w-full text-left text-xs">
                <thead><tr class="text-slate-500"><th>SIDE</th><th>CLOSE TIME</th><th>STEP</th><th>VOL</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>PNL</th></tr></thead>
                <tbody id="tradesBody"></tbody>
            </table></div>
        </div>
    </div>

    <script>
        let walletChart = null;
        function formatNumber(num) { return parseFloat(num || 0).toFixed(8); }
        async function forceSync() { await fetch('/api/force-sync', {method: 'POST'}); }
        async function emergencyClose() { if(confirm('Close all?')) await fetch('/api/close', {method: 'POST'}); }

        function updateChart(history) {
            if (!history || history.length === 0) return;
            const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString());
            const data = history.map(h => h.equity);
            if (walletChart) walletChart.destroy();
            const ctx = document.getElementById('walletChart').getContext('2d');
            walletChart = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets: [{ label: 'Equity', data, borderColor: '#00D1B2', backgroundColor: '#00D1B220', fill: true, tension: 0.4 }] },
                options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { ticks: { color: '#6B7A8F' } } }, plugins: { legend: { display: false } } }
            });
        }

        setInterval(async () => {
            const res = await fetch('/api/status');
            const data = await res.json();
            const m = data.market;
            document.getElementById('totalWallet').textContent = '$' + formatNumber(m.totalEquity);
            document.getElementById('totalPnl').textContent = '$' + formatNumber(m.totalNetGain);
            document.getElementById('pnlPercent').textContent = m.growthPct.toFixed(2) + '%';
            document.getElementById('realizedPnl').textContent = '$' + formatNumber(m.totalRealizedPnl);
            document.getElementById('peakEquity').textContent = 'Peak: $' + formatNumber(m.peakEquity);
            document.getElementById('maxDrawdown').textContent = 'DD: ' + m.maxDrawdown.toFixed(2) + '%';
            document.getElementById('tradeStats').textContent = 'Trades: ' + m.totalTrades;
            document.getElementById('winRate').textContent = 'Win Rate: ' + m.winRate + '%';
            document.getElementById('baseVolumeDisplay').textContent = 'Base Volume: ' + (m.currentBaseVolume || 0).toLocaleString() + ' contracts';
            document.getElementById('shibDisplay').textContent = (m.currentBaseShib || 0).toLocaleString() + ' SHIB per trade';
            document.getElementById('riskAmount').textContent = '$' + formatNumber(m.currentRiskAmount);
            document.getElementById('spread').textContent = (m.spread || 0).toFixed(3) + '%';
            document.getElementById('bidPrice').textContent = formatNumber(m.bid);
            document.getElementById('askPrice').textContent = formatNumber(m.ask);
            if(m.walletHistory) updateChart(m.walletHistory);
            
            const long = data.accounts.find(a => a.direction === 'buy');
            const short = data.accounts.find(a => a.direction === 'sell');
            if (long) {
                document.getElementById('lRoi').textContent = long.roi.toFixed(2) + '%';
                document.getElementById('lPnl').textContent = '$' + formatNumber(long.unrealizedUsdt);
                document.getElementById('lStep').innerHTML = '<span class="step-badge">STEP '+long.step+'</span> VOL '+long.volume;
                document.getElementById('lAction').textContent = long.lastAction;
            }
            if (short) {
                document.getElementById('sRoi').textContent = short.roi.toFixed(2) + '%';
                document.getElementById('sPnl').textContent = '$' + formatNumber(short.unrealizedUsdt);
                document.getElementById('sStep').innerHTML = '<span class="step-badge">STEP '+short.step+'</span> VOL '+short.volume;
            }

            let h = '';
            data.tradeHistory.forEach(t => {
                h += '<tr class="border-b border-slate-800"><td>'+t.side+'</td><td>'+t.closeTime+'</td><td>'+t.step+'</td><td>'+t.volume+'</td><td>'+t.entryPrice+'</td><td>'+t.exitPrice+'</td><td>'+t.roi+'</td><td>'+t.netPnlUsdt+'</td></tr>';
            });
            document.getElementById('tradesBody').innerHTML = h || '<tr><td colspan="8" class="text-center p-4">No trades yet</td></tr>';
        }, 1000);
    </script>
</body>
</html>
    `);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log('✅ Paper Martingale Pro Started'));
