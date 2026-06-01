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
        secret_key: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        id: accountIndex 
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
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    takeProfitPct: 2.0,
    pollInterval: 2000,
    takerFeeRate: 0.0005,
    contractValue: 1000 // 1 Contract = 1000 SHIB
};

let market = {
    status: 'Active', bid: 0, ask: 0, 
    totalNetGain: 0, growthPct: 0,
    initialTotalEquity: 0,
    sessionRealizedProfit: 0,
    netSessionUsdt: 0,
    isQueueLocked: false 
};

let tradeHistory = [];
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.id] = {
        id: account.id,
        direction: idx % 2 === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, initialEquity: null,
        isLocked: false, lastAction: 'Idle'
    };
});

// ==================== HTX API CORE ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secret_key).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc) {
    const state = accountStates[acc.id];
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open);
            
            const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
            if (currentPrice > 0) {
                const sideMult = state.direction === 'buy' ? 1 : -1;
                state.roi = ((currentPrice - state.entryPrice) / state.entryPrice) * config.leverage * sideMult * 100;
                const grossPnL = (currentPrice - state.entryPrice) * state.volume * config.contractValue * sideMult;
                const feeEstimate = (state.entryPrice + currentPrice) * state.volume * config.contractValue * config.takerFeeRate;
                state.unrealizedUsdt = grossPnL - feeEstimate;
            }
        } else { 
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
        }
    }
    
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

async function openPositionUnique(accId) {
    if (market.isQueueLocked || market.status !== 'Active') return;
    
    const state = accountStates[accId];
    const acc = config.accounts.find(a => a.id === accId);
    const targetPrice = state.direction === 'buy' ? market.ask : market.bid;

    // UNIQUE PRICE CHECK
    const existingPrices = Object.values(accountStates)
        .filter(s => s.volume > 0)
        .map(s => s.entryPrice);

    if (existingPrices.includes(targetPrice)) {
        state.lastAction = `WAIT FOR TICK (${targetPrice.toFixed(8)})`;
        return; 
    }

    market.isQueueLocked = true;
    state.isLocked = true;
    state.lastAction = "OPENING...";

    const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
    });

    if (res.status === 'ok') console.log(`[UNIQUE] Acc ${accId} entry at ${targetPrice}`);

    state.isLocked = false;
    state.lastAction = "Idle";
    market.isQueueLocked = false;
}

async function closePosition(accId, type) {
    const state = accountStates[accId];
    const acc = config.accounts.find(a => a.id === accId);
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    if (res.status === 'ok') {
        market.sessionRealizedProfit += state.unrealizedUsdt;
        logToHistory(accId, state.direction, state.roi, state.unrealizedUsdt, type);
    }
    state.isLocked = false;
}

function logToHistory(accId, direction, roi, pnl, type) {
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        side: `ACC ${accId} ${direction.toUpperCase()}`,
        roi: roi.toFixed(4) + '%',
        pnl: pnl.toFixed(8), 
        type: type
    });
    if (tradeHistory.length > 25) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick && market.status === 'Active') {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                let totalUnrealized = 0;
                Object.values(accountStates).forEach((state) => {
                    totalUnrealized += state.unrealizedUsdt;
                    if (state.volume > 0 && !state.isLocked) {
                        if (state.roi >= config.takeProfitPct) closePosition(state.id, 'TAKE_PROFIT');
                        else if (state.roi < -5.0 && market.sessionRealizedProfit > (Math.abs(state.unrealizedUsdt) * 1.15)) closePosition(state.id, 'STOP_LOSS');
                    }
                });
                market.netSessionUsdt = totalUnrealized + market.sessionRealizedProfit;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc)));
    const states = Object.values(accountStates);
    const totalCurrentEquity = states.reduce((sum, s) => sum + s.currentEquity, 0);
    if (market.initialTotalEquity === 0 && totalCurrentEquity > 0) market.initialTotalEquity = totalCurrentEquity;
    market.totalNetGain = totalCurrentEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;

    if (market.status === 'Active' && !market.isQueueLocked) {
        const nextToOpen = states.find(s => s.volume === 0 && !s.isLocked);
        if (nextToOpen) openPositionUnique(nextToOpen.id);
    }
}

// ==================== DASHBOARD & ACTIONS ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close-all', async (req, res) => {
    market.status = 'LIQUIDATING';
    for (const acc of config.accounts) {
        const state = accountStates[acc.id];
        state.isLocked = true;
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
        }
    }
    setTimeout(() => { 
        Object.values(accountStates).forEach(s => s.isLocked = false);
        market.status = 'Active'; 
    }, 15000);
    res.json({status:'ok'});
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Hedge Engine UNIQUE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #020617; color: #f8fafc; font-family: monospace; }</style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-end mb-6">
            <div>
                <h1 class="text-xl font-bold text-indigo-400">UNIQUE-PRICE ENGINE</h1>
                <p id="statusBadge" class="text-[10px] mt-1 font-bold bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded border border-emerald-500/20 uppercase tracking-widest">SYSTEM ACTIVE</p>
            </div>
            <div class="flex gap-4 items-center">
                <button onclick="fetch('/api/close-all', {method:'POST'})" class="bg-rose-900/40 hover:bg-rose-900 text-rose-400 px-3 py-1 rounded text-[10px] border border-rose-500/30 font-bold uppercase">Liquidate All</button>
                <div class="text-right">
                    <p id="totalNetGain" class="text-2xl font-bold">0.00000000</p>
                    <p id="growthPct" class="text-emerald-500 text-[10px] font-bold">0.0000%</p>
                </div>
            </div>
        </div>
        <div class="grid grid-cols-2 gap-4 mb-6 text-center">
            <div class="bg-slate-900 p-4 border border-slate-800"><p class="text-[9px] text-slate-500 uppercase font-bold">Session Realized Profit</p><p id="realizedProfit" class="text-xl font-bold text-emerald-400">0.00000000</p></div>
            <div class="bg-slate-900 p-4 border border-slate-800"><p class="text-[9px] text-slate-500 uppercase font-bold">Live Session Net PnL</p><p id="netSession" class="text-xl font-bold text-white">0.00000000</p></div>
        </div>
        <div id="accountGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-6"></div>
        <div class="bg-slate-900 rounded border border-slate-800 p-4">
            <p class="text-[10px] font-bold mb-3 text-slate-500 uppercase">Recent Exchange Activity</p>
            <table class="w-full text-left text-[11px]">
                <thead><tr class="text-slate-600 border-b border-slate-800"><th class="pb-2">Time</th><th class="pb-2">Type</th><th class="pb-2">Target</th><th class="pb-2">ROI</th><th class="pb-2 text-right">PnL (USDT)</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = d.market.totalNetGain.toFixed(8);
            document.getElementById('growthPct').innerText = d.market.growthPct.toFixed(4) + '%';
            document.getElementById('realizedProfit').innerText = d.market.sessionRealizedProfit.toFixed(8);
            document.getElementById('netSession').innerText = d.market.netSessionUsdt.toFixed(8);
            document.getElementById('statusBadge').innerText = 'SYSTEM ' + d.market.status;
            let accHtml = '';
            d.accounts.forEach(a => {
                accHtml += '<div class="bg-slate-950 p-3 border border-slate-800"><div class="flex justify-between items-center mb-1"><span class="text-[9px] bg-slate-800 px-1.5 rounded text-slate-400 font-bold">ACC '+a.id+'</span><span class="text-[9px] font-bold '+(a.direction === "buy" ? "text-emerald-500" : "text-rose-500")+'">'+a.direction.toUpperCase()+'</span></div><p class="text-lg font-bold '+(a.roi >= 0 ? "text-emerald-400" : "text-rose-400")+'">'+a.roi.toFixed(4)+'%</p><p class="text-[10px] text-slate-500 font-bold tracking-tighter">PRICE: '+a.entryPrice.toFixed(8)+'</p><p class="text-[11px] text-slate-200 font-bold">'+a.unrealizedUsdt.toFixed(8)+'</p><div class="mt-2 text-[8px] text-slate-600 font-bold uppercase truncate">'+a.lastAction+'</div></div>';
            });
            document.getElementById('accountGrid').innerHTML = accHtml;
            let hHtml = '';
            d.tradeHistory.forEach(h => {
                const isNeg = h.pnl.startsWith('-');
                hHtml += '<tr class="border-b border-slate-900/50"><td class="py-1 text-slate-600">'+h.time+'</td><td class="font-bold text-indigo-400">'+h.type+'</td><td class="text-slate-400 font-bold">'+h.side+'</td><td class="font-bold text-slate-200">'+h.roi+'</td><td class="text-right font-bold '+(isNeg ? "text-rose-500" : "text-emerald-500")+'">'+h.pnl+'</td></tr>';
            });
            document.getElementById('historyBody').innerHTML = hHtml;
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Unique Price Engine Online (Liquidate All Button Restored).`));
