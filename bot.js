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
    baseVolume: 1,         // Increased to ensure profit > fees
    multiplier: 1.2,
    stepDistancePct: 0.1,    
    takeProfitPct: 1,      // Target Net Profit
    maxStartSpread: 0.1, 
    takerFeeRate: 0.0005,    // 0.05%
    pollInterval: 1500 
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
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 3000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol,
            order_id: state.pendingOrderId
        });
        if (orderRes?.status === 'ok' && orderRes.data?.[0]) {
            const orderData = orderRes.data[0];
            if (orderData.status >= 4) { 
                if (orderData.offset === 'close') logFinalTrade(state, orderData); 
                state.pendingOrderId = null;
                state.isLocked = false; 
            } else {
                state.lastAction = "Syncing Order...";
                return;
            }
        }
    }

    if (state.isLocked) return; 

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open);
            
            // MATH FIX: Calculate NET PNL (Subtracting entry fees and predicted exit fees)
            const positionNotional = state.volume * state.entryPrice * (pos.contract_size || 1000); 
            const estimatedTotalFees = (positionNotional * config.takerFeeRate * 2); 
            
            const grossProfit = parseFloat(pos.profit);
            const netProfit = grossProfit - estimatedTotalFees;
            
            state.unrealizedUsdt = netProfit;
            // Net ROI = (Net Profit / Margin Used) * 100
            const marginUsed = positionNotional / config.leverage;
            state.roi = (netProfit / marginUsed) * 100;

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

function logFinalTrade(state, orderData) {
    const now = new Date();
    const actualProfit = parseFloat(orderData.profit || 0);
    const actualFee = parseFloat(orderData.fee || 0);
    const netPnl = actualProfit - actualFee;

    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'P',
        type: (state.direction === 'buy' ? 'Long' : 'Short'),
        openTime: state.startTime || 'N/A',
        closeTime: now.toLocaleString(),
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: parseFloat(orderData.trade_avg_price || 0).toFixed(8),
        roi: state.roi.toFixed(2) + '%',
        netPnlUsdt: netPnl.toFixed(8),
        status: 'Closed'
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
                state.lastAction = "Spread High";
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
            state.lastAction = "Closing Net Profit";
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
    if (Date.now() - market.lastPriceUpdate > 3000) await fetchPriceRest();
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    
    let totalEquity = 0;
    Object.values(accountStates).forEach(s => totalEquity += s.currentEquity);
    if (market.initialTotalEquity === 0 && totalEquity > 0) market.initialTotalEquity = totalEquity;
    
    market.totalNetGain = totalEquity - market.initialTotalEquity;
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
    setTimeout(() => market.status = "Active", 10000);
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
                <p class="stat-label mb-1">Target Net TP</p>
                <p class="text-3xl font-black text-white">${config.takeProfitPct}%</p>
                <p class="text-[9px] text-slate-500 mt-1">Fees Deducted Automatically</p>
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
                    <p id="lRoi" class="text-4xl font-black">0.0000%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p>
                    <div class="bg-emerald-500/10 inline-block px-2 py-1 rounded">
                        <p id="lStep" class="text-[10px] font-black text-emerald-400 uppercase">STEP: 0</p>
                    </div>
                    <p id="lMargin" class="text-[9px] text-slate-400 mt-2">AVL: $0.0000</p>
                    <p id="lAction" class="text-[9px] text-indigo-400 italic mt-1"></p>
                </div>
                <div class="text-right">
                    <p class="stat-label text-rose-500">Short Account</p>
                    <p id="sRoi" class="text-4xl font-black">0.0000%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-500 mb-2">$0.00000000</p>
                    <div class="bg-rose-500/10 inline-block px-2 py-1 rounded">
                        <p id="sStep" class="text-[10px] font-black text-rose-400 uppercase">STEP: 0</p>
                    </div>
                    <p id="sMargin" class="text-[9px] text-slate-400 mt-2">AVL: $0.0000</p>
                    <p id="sAction" class="text-[9px] text-indigo-400 italic mt-1"></p>
                </div>
            </div>
        </div>

        <div class="card overflow-hidden mb-8">
             <div class="bg-slate-800/50 p-4 border-b border-slate-700">
                <p class="stat-label">Realized History (After Fees)</p>
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
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(4)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(8);
                    document.getElementById(p+'Step').innerText = 'STEP: ' + a.step;
                    document.getElementById(p+'Margin').innerText = 'AVL: $' + a.availableMargin.toFixed(4);
                    document.getElementById(p+'Action').innerText = a.lastAction;
                });

                let html = '';
                d.tradeHistory.forEach(h => {
                    html += '<div class="exchange-row">' +
                        '<div class="flex justify-between mb-2"><div><span class="font-black">' + h.symbol + '</span><span class="ml-2 text-[9px] bg-slate-700 px-1 rounded">' + h.type + '</span></div>' +
                        '<div class="text-right text-slate-500 text-[9px]">Open: ' + h.openTime + '<br>Close: ' + h.closeTime + '</div></div>' +
                        '<div class="grid grid-cols-3 gap-4 text-[10px]">' +
                        '<div><p class="text-slate-500 uppercase">Volume</p><p class="font-bold">' + h.volume + '</p></div>' +
                        '<div><p class="text-slate-500 uppercase">Entry/Exit</p><p class="font-bold">' + h.entryPrice + ' / ' + h.exitPrice + '</p></div>' +
                        '<div class="text-right"><p class="text-slate-500 uppercase">Net ROI / Net PnL</p><p class="font-black ' + (parseFloat(h.netPnlUsdt) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + ' / ' + h.netPnlUsdt + ' USDT</p></div>' +
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
