require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const apiAccounts = [
    { apiKey: 'PAPER_KEY_1', secretKey: 'PAPER_SECRET_1', accountId: 1 },
    { apiKey: 'PAPER_KEY_2', secretKey: 'PAPER_SECRET_2', accountId: 2 }
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

// ==================== PAPER TRADING ENGINE STORAGE ====================
let paperBalances = { 1: 100.0, 2: 100.0 }; 
let paperPositions = { 1: null, 2: null };

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 200.0, startTime: Date.now(),
    lastPriceUpdate: 0,
    walletHistory: [],
    peakEquity: 200.0,
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
    if (volume > MAX_VOLUME) volume = MAX_VOLUME;
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    const shibAmount = volume * config.shibPerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseShib = shibAmount;
    market.currentBaseVolume = volume;
    
    return volume;
}

function calculateStepFromVolume(volume, baseVolume, multiplier) {
    if (volume === 0) return 0;
    let totalVolume = 0;
    let step = 0;
    while (totalVolume < volume) {
        const stepVolume = step === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, step));
        totalVolume += stepVolume;
        if (totalVolume <= volume) step++; else break;
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
        return targetPrice * (1 + config.takerFeeRate);
    } else {
        const targetPrice = state.entryPrice * (1 - (requiredPriceMovePct / 100));
        return targetPrice * (1 - config.takerFeeRate);
    }
}

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
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
        currentEquity: 100, availableMargin: 100, initialEquity: 100,
        isLocked: false, pendingOrderId: null, lastAction: 'Idle',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        targetPrice: 0, realizedPnl: 0, totalFees: 0, roiLatencyHistory: []
    };
});

// ==================== MOCK HTX API ====================
async function htxRequest(account, method, path, data = {}) {
    const accId = account.accountId;
    const currentPrice = market.bid || 0;

    if (path.includes('swap_cross_account_info')) {
        let unrealized = 0;
        const pos = paperPositions[accId];
        if (pos) {
            const side = pos.direction === 'buy' ? 1 : -1;
            unrealized = pos.volume * config.shibPerContract * config.contractMultiplier * (currentPrice - pos.entryPrice) * side;
        }
        return { status: 'ok', data: [{ margin_balance: paperBalances[accId] + unrealized, withdraw_available: paperBalances[accId] }] };
    }

    if (path.includes('swap_cross_position_info')) {
        const pos = paperPositions[accId];
        if (!pos) return { status: 'ok', data: [] };
        const side = pos.direction === 'buy' ? 1 : -1;
        const pnl = pos.volume * config.shibPerContract * config.contractMultiplier * (currentPrice - pos.entryPrice) * side;
        const margin = (pos.volume * config.shibPerContract * config.contractMultiplier * pos.entryPrice) / config.leverage;
        return { status: 'ok', data: [{ direction: pos.direction, volume: pos.volume, cost_open: pos.entryPrice, profit: pnl, profit_rate: pnl/margin }] };
    }

    if (path.includes('swap_cross_order_info')) {
        return { status: 'ok', data: [{ status: 6, price_avg: currentPrice }] };
    }

    if (path.includes('swap_cross_order')) {
        if (currentPrice === 0) return { status: 'error' };
        const fee = data.volume * config.shibPerContract * config.contractMultiplier * currentPrice * config.takerFeeRate;
        paperBalances[accId] -= fee;
        market.totalFeesPaid += fee;
        if (data.offset === 'open') {
            const currentPos = paperPositions[accId];
            if (currentPos) {
                const totalVol = currentPos.volume + data.volume;
                const newEntry = ((currentPos.entryPrice * currentPos.volume) + (currentPrice * data.volume)) / totalVol;
                paperPositions[accId] = { direction: data.direction, volume: totalVol, entryPrice: newEntry };
            } else {
                paperPositions[accId] = { direction: data.direction, volume: data.volume, entryPrice: currentPrice };
            }
        } else {
            const pos = paperPositions[accId];
            if (pos) {
                const side = pos.direction === 'buy' ? 1 : -1;
                const pnl = pos.volume * config.shibPerContract * config.contractMultiplier * (currentPrice - pos.entryPrice) * side;
                paperBalances[accId] += pnl;
                paperPositions[accId] = null;
            }
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
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info');
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = pos.volume;
            state.entryPrice = pos.cost_open;
            state.roi = pos.profit_rate * 100;
            state.unrealizedUsdt = pos.profit;
            state.targetPrice = calculateTargetPrice(state);
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else {
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
        }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info');
    if (accRes?.status === 'ok') {
        state.currentEquity = accRes.data[0].margin_balance;
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    market.totalTrades++;
    if (finalPnl >= 0) market.winningTrades++; else market.losingTrades++;
    tradeHistory.unshift({
        side: state.direction.toUpperCase(), openTime: state.startTime, closeTime: exitTime,
        volume: state.volume, step: step, entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8), roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8), estimatedFee: (Math.abs(finalPnl) * config.takerFeeRate).toFixed(8)
    });
    state.realizedPnl += finalPnl;
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0]; market.ask = msg.tick.ask[0];
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                market.lastPriceUpdate = Date.now();
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) continue;
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                volume: market.currentBaseVolume, direction: state.direction, offset: 'open'
            });
            state.isLocked = false;
        } else {
            const tpTrigger = state.direction === 'buy' ? market.ask >= state.targetPrice : market.bid <= state.targetPrice;
            if (tpTrigger && state.targetPrice > 0) {
                const pnl = state.unrealizedUsdt;
                await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close'
                });
                logTradeExchangeStyle(state, currentPrice, new Date().toLocaleString(), config.takeProfitPct, pnl);
            } else if (state.roi <= -10) {
                const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier) + 1;
                const nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, step));
                state.isLocked = true;
                await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    volume: nextVol, direction: state.direction, offset: 'open'
                });
                state.isLocked = false;
            }
        }
    }
}

async function backgroundLoop() {
    if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
    for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
    
    const totalEquity = accountStates[1].currentEquity + accountStates[2].currentEquity;
    market.totalNetGain = totalEquity - market.initialTotalEquity;
    market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
    
    calculateBaseVolumeFromWallet(totalEquity, market.bid);
    updateWalletGrowth(totalEquity);
    await processMartingale();
}

app.get('/api/status', (req, res) => {
    res.json({
        market: { ...market, totalEquity: accountStates[1].currentEquity + accountStates[2].currentEquity, totalRealizedPnl: accountStates[1].realizedPnl + accountStates[2].realizedPnl, winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0 },
        accounts: Object.values(accountStates), tradeHistory, config
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Martingale Pro - Paper Mode</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #00D1B240; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <h1 class="text-3xl font-black mb-8">MARTINGALE <span class="text-indigo-500">PRO</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">PAPER MODE</span></h1>
        
        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
                <div><p class="stat-label">TOTAL WALLET</p><p id="totalWallet" class="stat-number value-positive">$0.00</p></div>
                <div><p class="stat-label">TOTAL P&L</p><p id="totalPnl" class="stat-number">$0.00</p></div>
                <div><p class="stat-label">REALIZED P&L</p><p id="realizedPnl" class="stat-number">$0.00</p></div>
                <div><p class="stat-label">PERFORMANCE</p><p id="peakEquity" class="text-sm">Peak: $0.00</p><p id="maxDrawdown" class="text-sm text-red-400">DD: 0%</p></div>
                <div><p class="stat-label">STATISTICS</p><p id="tradeStats" class="text-sm">Trades: 0</p><p id="winRate" class="text-sm text-green-400">Win Rate: 0%</p></div>
            </div>
            <div class="compound-info mt-4 flex justify-between items-center">
                <div>
                    <p class="text-xs text-slate-400">📈 AUTO-COMPOUNDING (2% Risk)</p>
                    <p class="text-sm font-bold text-green-400" id="baseVolumeDisplay">Base Volume: 0 contracts</p>
                    <p class="text-xs text-slate-400" id="shibDisplay">0 SHIB per trade</p>
                </div>
                <div class="text-right">
                    <p class="text-xs text-slate-400">Risk Amount</p>
                    <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                    <p class="text-xs text-slate-400">🟢 Active</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card"><p class="stat-label">SPREAD</p><p id="spread" class="text-2xl font-black">0.000%</p></div>
            <div class="card"><p class="stat-label">LONG ROI</p><p id="lRoi" class="text-2xl font-black">0.00%</p><p id="lPnl" class="text-sm">$0.00</p></div>
            <div class="card"><p class="stat-label">SHORT ROI</p><p id="sRoi" class="text-2xl font-black">0.00%</p><p id="sPnl" class="text-sm">$0.00</p></div>
            <div class="card"><p class="stat-label">ACTION</p><p id="lAction" class="text-xs text-indigo-400">Idle</p></div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <table class="w-full text-xs text-left">
                <thead class="text-slate-500"><tr><th>SIDE</th><th>CLOSE</th><th>VOL</th><th>ROI</th><th>PNL</th></tr></thead>
                <tbody id="tradesBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        function formatNumber(num) { return parseFloat(num || 0).toFixed(8); }
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                document.getElementById('totalWallet').textContent = '$' + formatNumber(data.market.totalEquity);
                document.getElementById('totalPnl').textContent = '$' + formatNumber(data.market.totalNetGain);
                document.getElementById('realizedPnl').textContent = '$' + formatNumber(data.market.totalRealizedPnl);
                document.getElementById('peakEquity').textContent = 'Peak: $' + formatNumber(data.market.peakEquity);
                document.getElementById('maxDrawdown').textContent = 'DD: ' + data.market.maxDrawdown.toFixed(2) + '%';
                document.getElementById('tradeStats').textContent = 'Trades: ' + data.market.totalTrades;
                document.getElementById('winRate').textContent = 'Win Rate: ' + data.market.winRate + '%';
                document.getElementById('spread').textContent = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('baseVolumeDisplay').textContent = 'Base Volume: ' + (data.market.currentBaseVolume || 0).toLocaleString() + ' contracts';
                document.getElementById('shibDisplay').textContent = (data.market.currentBaseShib || 0).toLocaleString() + ' SHIB per trade';
                document.getElementById('riskAmount').textContent = '$' + formatNumber(data.market.currentRiskAmount || 0);

                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                if (long) {
                    document.getElementById('lRoi').textContent = (long.roi || 0).toFixed(2) + '%';
                    document.getElementById('lPnl').textContent = '$' + formatNumber(long.unrealizedUsdt);
                    document.getElementById('lAction').textContent = long.lastAction;
                }
                if (short) {
                    document.getElementById('sRoi').textContent = (short.roi || 0).toFixed(2) + '%';
                    document.getElementById('sPnl').textContent = '$' + formatNumber(short.unrealizedUsdt);
                }

                let html = '';
                data.tradeHistory.forEach(t => {
                    html += '<tr class="border-b border-slate-800"><td class="p-2">' + t.side + '</td><td>' + t.closeTime + '</td><td>' + t.volume + '</td><td>' + t.roi + '</td><td>' + t.netPnlUsdt + '</td></tr>';
                });
                document.getElementById('tradesBody').innerHTML = html || '<tr><td colspan="5" class="text-center p-4">Waiting...</td></tr>';
            } catch(e) {}
        }, 1000);
    </script>
</body>
</html>
    `);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log('✅ Corrected Paper Mode Active'));
