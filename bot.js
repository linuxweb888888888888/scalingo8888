require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
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
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    accounts: apiAccounts,
    baseVolume: 1, 
    multiplier: 1.2,
    stepDistancePct: 0.1,
    takeProfitPct: 1,      // Triggers based on Exchange ROI
    maxStartSpread: 0.1,
    pollInterval: 1500 
};

let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0,
    initialTotalEquity: 0, startTime: Date.now()
};

let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0, faceValue: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false, pendingOrderId: null, step: 0, lastStepPrice: 0
    };
});

// ==================== HTX API CORE ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 3000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
    // 1. Order Status Check
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol, order_id: state.pendingOrderId
        });
        if (orderRes?.status === 'ok' && orderRes.data?.[0]?.status >= 4) {
            if (orderRes.data[0].offset === 'close') logExchangeTrade(state, orderRes.data[0]);
            state.pendingOrderId = null;
            state.isLocked = false;
        } else return;
    }

    if (state.isLocked) return;

    // 2. Position Sync - PULLING DIRECTLY FROM EXCHANGE FIELDS
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = parseFloat(pos.volume);
            state.entryPrice = parseFloat(pos.cost_open);
            state.faceValue = parseFloat(pos.contract_size); // DIRECT FACE VALUE
            state.roi = parseFloat(pos.profit_rate) * 100;    // DIRECT ROI %
            state.unrealizedUsdt = parseFloat(pos.profit);   // DIRECT PNL USDT
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
        } else {
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; state.step = 0; state.lastStepPrice = 0;
        }
    }

    // 3. Wallet Sync
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logExchangeTrade(state, order) {
    tradeHistory.unshift({
        symbol: config.symbol,
        type: state.direction.toUpperCase(),
        closeTime: new Date().toLocaleString(),
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: parseFloat(order.trade_avg_price || 0).toFixed(8),
        roi: state.roi.toFixed(8) + '%',
        netPnlUsdt: (parseFloat(order.profit) - parseFloat(order.fee)).toFixed(8)
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
}

async function backgroundLoop() {
    try {
        const res = await axios.get(`https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`);
        if (res.data?.tick) {
            market.bid = res.data.tick.bid[0]; market.ask = res.data.tick.ask[0];
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
        }
    } catch (e) {}

    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    
    let currentTotal = Object.values(accountStates).reduce((sum, s) => sum + s.currentEquity, 0);
    if (market.initialTotalEquity === 0 && currentTotal > 0) market.initialTotalEquity = currentTotal;
    market.totalNetGain = currentTotal - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;

    if (market.status === 'Active') {
        for (const acc of config.accounts) {
            const state = accountStates[acc.accountId];
            if (state.isLocked || market.bid === 0) continue;

            if (state.volume === 0) {
                if (market.spread > config.maxStartSpread) continue;
                state.isLocked = true;
                const r = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent' });
                if (r?.status === 'ok') state.pendingOrderId = r.data.order_id_str; else state.isLocked = false;
            } else if (state.roi >= config.takeProfitPct) {
                state.isLocked = true;
                const r = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' });
                if (r?.status === 'ok') state.pendingOrderId = r.data.order_id_str; else state.isLocked = false;
            } else {
                const cur = state.direction === 'buy' ? market.bid : market.ask;
                const move = state.direction === 'buy' ? ((state.lastStepPrice - cur) / state.lastStepPrice) * 100 : ((cur - state.lastStepPrice) / state.lastStepPrice) * 100;
                if (move >= config.stepDistancePct) {
                    state.isLocked = true;
                    const v = Math.max(1, Math.ceil(state.volume * 0.5)); // Simple Martingale step
                    const r = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: v, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent' });
                    if (r?.status === 'ok') { state.pendingOrderId = r.data.order_id_str; state.step++; state.lastStepPrice = cur; } else state.isLocked = false;
                }
            }
        }
    }
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.post('/api/close', async (req, res) => {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: s.volume, direction: s.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' });
    }
    setTimeout(() => market.status = "Active", 5000);
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Martingale Pro</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet"><style>body{background:#0f172a;color:white;font-family:'Inter',sans-serif;}.card{background:#1e293b;border-radius:20px;border:1px solid #334155;}.stat-label{font-size:10px;font-weight:900;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;}.exchange-row{border-bottom:1px solid #334155;padding:16px;font-size:11px;}</style></head>
<body class="p-4 md:p-10"><div class="max-w-4xl mx-auto"><div class="flex justify-between items-center mb-10"><div><h1 class="text-3xl font-black tracking-tighter uppercase italic">Martingale <span class="text-indigo-500">Pro</span></h1><p class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Engine Online</p></div><div class="text-right"><p id="totalNetGain" class="text-3xl font-black text-white">$0.00000000</p><div class="flex flex-col items-end"><p id="growthPct" class="stat-label text-emerald-400">Total Profit: 0.00000000%</p><p id="growthUsdt" class="text-[10px] font-black text-indigo-400 uppercase tracking-tighter">0.00000000 USDT</p></div></div></div>
<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8"><div class="card p-6 border-l-4 border-indigo-500"><p class="stat-label mb-1">Target TP</p><p class="text-3xl font-black text-white">${config.takeProfitPct}%</p><p class="text-[9px] text-slate-500 mt-1">Direct Exchange Sync</p></div><div class="card p-6 border-l-4 border-slate-500"><p class="stat-label mb-1">Market Spread</p><p id="uiSpread" class="text-3xl font-black text-white">0.000%</p><p class="text-[9px] text-slate-500 mt-1">Status: <span id="marketStatus">Active</span></p></div></div>
<div class="card p-8 mb-8"><div class="grid grid-cols-2 gap-10"><div><p class="stat-label text-emerald-500">Long Account</p><p id="lRoi" class="text-4xl font-black">0.00000000%</p><p id="lPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p><div class="bg-emerald-500/10 inline-block px-2 py-1 rounded"><p id="lStep" class="text-[10px] font-black text-emerald-400 uppercase">STEP: 0</p></div><p id="lFace" class="text-[9px] text-indigo-400 mt-2 font-bold uppercase">Face: 0</p></div>
<div class="text-right"><p class="stat-label text-rose-500">Short Account</p><p id="sRoi" class="text-4xl font-black">0.00000000%</p><p id="sPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p><div class="bg-rose-500/10 inline-block px-2 py-1 rounded"><p id="sStep" class="text-[10px] font-black text-rose-400 uppercase">STEP: 0</p></div><p id="sFace" class="text-[9px] text-indigo-400 mt-2 font-bold uppercase">Face: 0</p></div></div></div>
<div class="card overflow-hidden mb-8"><div class="bg-slate-800/50 p-4 border-b border-slate-700"><p class="stat-label">Precise Exchange History</p></div><div id="historyBody" class="divide-y divide-slate-700"></div></div>
<button onclick="triggerClose()" class="w-full py-5 rounded-2xl bg-white text-black font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all shadow-2xl">Emergency Liquidation</button></div>
<script>
    async function triggerClose() { if(confirm("Close all?")) fetch('/api/close', {method:'POST'}); }
    setInterval(async () => {
        try {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(8);
            document.getElementById('growthPct').innerText = 'Total Profit: ' + d.market.growthPct.toFixed(8) + '%';
            document.getElementById('growthUsdt').innerText = d.market.totalNetGain.toFixed(8) + ' USDT';
            document.getElementById('uiSpread').innerText = d.market.spread.toFixed(3) + '%';
            document.getElementById('marketStatus').innerText = d.market.status;
            d.accounts.forEach((a, i) => {
                const p = i === 0 ? 'l' : 's';
                document.getElementById(p+'Roi').innerText = a.roi.toFixed(8)+'%';
                document.getElementById(p+'Roi').className = 'text-4xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(8);
                document.getElementById(p+'Step').innerText = 'STEP: ' + a.step;
                document.getElementById(p+'Face').innerText = 'FACE: ' + a.faceValue;
            });
            let html = '';
            d.tradeHistory.forEach(h => {
                html += '<div class="exchange-row"><div class="flex justify-between mb-2"><div><span class="font-black">' + h.symbol + '</span><span class="ml-2 text-[9px] bg-slate-700 px-1 rounded">' + h.type + '</span></div><div class="text-right text-slate-500 text-[9px]">Time: ' + h.closeTime + '</div></div><div class="grid grid-cols-3 gap-4 text-[10px]"><div><p class="text-slate-500 uppercase">Volume</p><p class="font-bold">' + h.volume + '</p></div><div><p class="text-slate-500 uppercase">Price</p><p class="font-bold">' + h.entryPrice + ' / ' + h.exitPrice + '</p></div><div class="text-right"><p class="text-slate-500 uppercase">ROI / PnL</p><p class="font-black ' + (parseFloat(h.netPnlUsdt) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + ' / ' + h.netPnlUsdt + ' USDT</p></div></div></div>';
            });
            document.getElementById('historyBody').innerHTML = html;
        } catch(e) {}
    }, 1500);
</script></body></html>`);
});

setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0');
