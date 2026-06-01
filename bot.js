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
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: 1, 
    multiplier: 1.5,
    stepDistancePct: 0.5,
    takeProfitPct: 1.0,      // Triggers based on Exchange ROI
    maxStartSpread: 0.1, 
    takerFeeRate: 0.0005, 
    pollInterval: 1000 
};

let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0
};

let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0, faceValue: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false, 
        pendingOrderId: null,
        lastAction: 'Idle',
        step: 0, lastStepPrice: 0, lastAddedVolume: 0, startTime: null
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function fetchPriceRest() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`;
        const res = await axios.get(url);
        if (res.data?.tick) {
            market.bid = res.data.tick.bid[0];
            market.ask = res.data.tick.ask[0];
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
            market.lastPriceUpdate = Date.now();
        }
    } catch (e) {}
}

async function syncAccount(acc, state) {
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol,
            order_id: state.pendingOrderId
        });
        if (orderRes?.status === 'ok' && orderRes.data?.[0]?.status >= 4) {
            if (orderRes.data[0].offset === 'close') logTradeExchangeStyle(state, orderRes.data[0]);
            state.pendingOrderId = null;
            state.isLocked = false; 
        } else {
            state.lastAction = "Waiting Confirmation";
            return;
        }
    }

    if (state.isLocked) return; 

    // PULL DIRECTLY FROM EXCHANGE POSITION INFO
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open);
            
            // EXCHANGE SOURCE OF TRUTH FIELDS:
            state.roi = parseFloat(pos.profit_rate) * 100; 
            state.unrealizedUsdt = parseFloat(pos.profit);
            state.faceValue = parseFloat(pos.contract_size);

            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else { 
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; 
            state.step = 0; state.lastStepPrice = 0; state.startTime = null;
        }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTradeExchangeStyle(state, order) {
    const now = new Date();
    // Realized Net PnL = Profit - Fee (Direct from exchange order data)
    const netPnl = parseFloat(order.profit) - parseFloat(order.fee);

    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perp',
        type: (state.direction === 'buy' ? 'BuyCross' : 'SellCross'),
        openTime: state.startTime || now.toLocaleString(),
        closeTime: now.toLocaleString(),
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: parseFloat(order.trade_avg_price || 0).toFixed(8),
        roi: state.roi.toFixed(8) + '%',
        netPnlUsdt: netPnl.toFixed(8),
        status: 'All Closed'
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) { 
                market.bid = msg.tick.bid[0]; 
                market.ask = msg.tick.ask[0]; 
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                market.lastPriceUpdate = Date.now();
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) {
                state.lastAction = "Wait Spread < " + config.maxStartSpread + "%";
                continue;
            }
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            if (res?.status === 'ok') state.pendingOrderId = res.data.order_id_str;
            else state.isLocked = false;
            continue;
        }

        if (state.roi >= config.takeProfitPct) {
            state.isLocked = true; 
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
            if (res?.status === 'ok') state.pendingOrderId = res.data.order_id_str;
            else state.isLocked = false;
            continue;
        }

        let priceMove = state.direction === 'buy' ? 
            ((state.lastStepPrice - currentPrice) / state.lastStepPrice) * 100 : 
            ((currentPrice - state.lastStepPrice) / state.lastStepPrice) * 100;

        if (priceMove >= config.stepDistancePct) {
            state.isLocked = true;
            const nextVol = Math.max(1, Math.ceil((state.lastAddedVolume || config.baseVolume) * config.multiplier));
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVol, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            if(res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.step++;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
            } else {
                state.isLocked = false;
            }
        }
    }
}

async function backgroundLoop() {
    if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    const s1 = accountStates[1] || {currentEquity:0}; 
    const s2 = accountStates[2] || {currentEquity:0};
    
    const currentTotalEquity = s1.currentEquity + s2.currentEquity;
    if (market.initialTotalEquity === 0 && currentTotalEquity > 0) market.initialTotalEquity = currentTotalEquity;
    
    market.totalNetGain = currentTotalEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;
    
    const elapsedDays = (Date.now() - market.startTime) / (1000 * 60 * 60 * 24);
    market.dgr = elapsedDays > 0 ? (market.growthPct / elapsedDays) : 0;
    if (market.status === 'Active') await processMartingale();
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.post('/api/close', async (req, res) => { 
    market.status = "LIQUIDATING"; 
    for (const acc of config.accounts) { 
        const s = accountStates[acc.accountId];
        if (s.volume > 0) await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: s.volume, direction: s.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' });
    }
    setTimeout(() => market.status = "Active", 5000);
    res.json({status:'ok'});
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Martingale Pro Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #0f172a; color: white; font-family: 'Inter', sans-serif; }
        .card { background: #1e293b; border-radius: 20px; border: 1px solid #334155; }
        .stat-label { font-size: 10px; font-weight: 900; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; }
        .exchange-row { border-bottom: 1px solid #334155; padding: 16px; font-size: 11px; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-3xl font-black tracking-tighter uppercase italic">Martingale <span class="text-indigo-500">Pro</span></h1>
                <p id="botStatus" class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Engine Online</p>
            </div>
            <div class="text-right">
                <p id="totalNetGain" class="text-3xl font-black text-white">$0.00000000</p>
                <div class="flex flex-col items-end">
                    <p id="growthPct" class="stat-label text-emerald-400">Total Profit: 0.00000000%</p>
                    <p id="growthUsdt" class="text-[10px] font-black text-indigo-400 uppercase tracking-tighter">0.00000000 USDT</p>
                    <p id="dgrPct" class="text-[10px] font-black text-slate-500 uppercase tracking-tighter mt-1">DGR: 0.00% / Day</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="card p-6 border-l-4 border-indigo-500">
                <p class="stat-label mb-1">Target TP</p>
                <p class="text-3xl font-black text-white">${config.takeProfitPct}%</p>
                <p class="text-[9px] text-slate-500 mt-1">Direct Exchange Sync Mode</p>
            </div>
            <div class="card p-6 border-l-4 border-slate-500">
                <p class="stat-label mb-1">Market Spread</p>
                <p id="uiSpread" class="text-3xl font-black text-white">0.000%</p>
                <p class="text-[9px] text-slate-500 mt-1">Status: <span id="marketStatus">Active</span></p>
            </div>
        </div>

        <div class="card p-8 mb-8">
            <div class="grid grid-cols-2 gap-10">
                <div>
                    <p class="stat-label text-emerald-500">Long Account</p>
                    <p id="lRoi" class="text-4xl font-black">0.00000000%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p>
                    <div class="bg-emerald-500/10 inline-block px-2 py-1 rounded">
                        <p id="lStep" class="text-[10px] font-black text-emerald-400 uppercase">STEP: 0</p>
                    </div>
                    <p id="lFace" class="text-[9px] text-indigo-400 mt-2 font-bold uppercase tracking-widest">Face: 0</p>
                    <p id="lAction" class="text-[9px] text-slate-400 italic mt-1"></p>
                </div>
                <div class="text-right">
                    <p class="stat-label text-rose-500">Short Account</p>
                    <p id="sRoi" class="text-4xl font-black">0.00000000%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p>
                    <div class="bg-rose-500/10 inline-block px-2 py-1 rounded">
                        <p id="sStep" class="text-[10px] font-black text-rose-400 uppercase">STEP: 0</p>
                    </div>
                    <p id="sFace" class="text-[9px] text-indigo-400 mt-2 font-bold uppercase tracking-widest">Face: 0</p>
                    <p id="sAction" class="text-[9px] text-slate-400 italic mt-1"></p>
                </div>
            </div>
        </div>

        <div class="card overflow-hidden mb-8">
             <div class="bg-slate-800/50 p-4 border-b border-slate-700">
                <p class="stat-label">Precise Exchange History</p>
            </div>
            <div id="historyBody" class="divide-y divide-slate-700"></div>
        </div>

        <button onclick="triggerClose()" class="w-full py-5 rounded-2xl bg-white text-black font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all shadow-2xl">
            Emergency Liquidation
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Close all?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(8);
                document.getElementById('growthPct').innerText = 'Total Profit: ' + d.market.growthPct.toFixed(8) + '%';
                document.getElementById('growthUsdt').innerText = d.market.totalNetGain.toFixed(8) + ' USDT';
                document.getElementById('dgrPct').innerText = 'DGR: ' + d.market.dgr.toFixed(2) + '% / DAY';
                document.getElementById('uiSpread').innerText = d.market.spread.toFixed(3) + '%';
                document.getElementById('marketStatus').innerText = d.market.status;

                d.accounts.forEach(function(a, i) {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(8)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(8);
                    document.getElementById(p+'Step').innerText = 'STEP: ' + a.step;
                    document.getElementById(p+'Face').innerText = 'FACE: ' + a.faceValue;
                    document.getElementById(p+'Action').innerText = a.lastAction;
                });

                let html = '';
                d.tradeHistory.forEach(h => {
                    html += '<div class="exchange-row">' +
                        '<div class="flex justify-between mb-2"><div><span class="font-black">' + h.symbol + '</span><span class="ml-2 text-[9px] bg-slate-700 px-1 rounded">' + h.type + '</span></div>' +
                        '<div class="text-right text-slate-500 text-[9px]">Time: ' + h.closeTime + '</div></div>' +
                        '<div class="grid grid-cols-3 gap-4 text-[10px]">' +
                        '<div><p class="text-slate-500 uppercase">Volume</p><p class="font-bold">' + h.volume + '</p></div>' +
                        '<div><p class="text-slate-500 uppercase">Entry/Exit</p><p class="font-bold">' + h.entryPrice + ' / ' + h.exitPrice + '</p></div>' +
                        '<div class="text-right"><p class="text-slate-500 uppercase">ROI / Net PnL</p><p class="font-black ' + (parseFloat(h.netPnlUsdt) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + ' / ' + h.netPnlUsdt + ' USDT</p></div>' +
                        '</div></div>';
                });
                document.getElementById('historyBody').innerHTML = html;
            } catch(e) { }
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0');
