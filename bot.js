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
    leverage: parseInt(process.env.LEVERAGE) || 75,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 0.2, // Distance from Average Entry Price
    takeProfitPct: 15,
    maxStartSpread: 0.1,
    pollInterval: 1000,
    contractMultiplier: 0.001
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
        step: 0, lastAddedVolume: 0, startTime: null
    };
});

// ==================== HTX API CORE ====================
function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = {
        AccessKeyId: account.apiKey,
        SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp,
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
        const options = { method, url, headers: { 'Content-Type': 'application/json' }, timeout: 5000 };
        if (method === 'POST') options.data = data;
        const res = await axios(options);
        return res.data;
    } catch (e) { return { status: 'error', msg: e.message }; }
}

// ==================== EXACT SETTLEMENT LOGGING ====================
async function logFinalSettledTrade(state, orderData) {
    try {
        const exitPrice = parseFloat(orderData.trade_avg_price);
        const volume = parseFloat(orderData.trade_volume);
        const fee = parseFloat(orderData.fee); 
        const profit = parseFloat(orderData.profit); 
        const netPnlUsdt = profit + fee;
        
        const priceDiff = state.direction === 'buy' ? (exitPrice - state.entryPrice) : (state.entryPrice - exitPrice);
        const finalRoi = (priceDiff / state.entryPrice) * config.leverage * 100;

        tradeHistory.unshift({
            symbol: config.symbol.replace('-', '') + 'Perpetual',
            side: state.direction === 'buy' ? 'LONG' : 'SHORT',
            openTime: state.startTime,
            closeTime: new Date().toLocaleString(),
            volume: volume,
            entryPrice: state.entryPrice.toFixed(8),
            exitPrice: exitPrice.toFixed(8),
            roi: finalRoi.toFixed(2) + '%',
            netPnlUsdt: netPnlUsdt.toFixed(8)
        });
        if (tradeHistory.length > 20) tradeHistory.pop();
    } catch (e) { console.error("Log error:", e); }
}

async function syncAccount(acc, state) {
    try {
        if (state.pendingOrderId) {
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', { contract_code: config.symbol, order_id: state.pendingOrderId });
            const data = res?.data?.[0];
            if (data?.status === 6) { // Fully Filled
                if (data.offset === 'close') {
                    await logFinalSettledTrade(state, data);
                    state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
                    state.step = 0; state.startTime = null; state.lastAddedVolume = 0;
                }
                state.pendingOrderId = null; state.isLocked = false;
            } else if (data?.status === 7 || data?.status === 4) { state.pendingOrderId = null; state.isLocked = false; }
            return;
        }

        if (state.isLocked) return;

        const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (posRes?.status === 'ok' && posRes.data) {
            const pos = posRes.data.find(p => p.direction === state.direction);
            if (pos && parseFloat(pos.volume) > 0) {
                state.volume = parseFloat(pos.volume);
                state.entryPrice = parseFloat(pos.cost_open); // This is the "Open Value"
                state.roi = parseFloat(pos.profit_rate) * 100;
                state.unrealizedUsdt = parseFloat(pos.profit);
                if (!state.startTime) state.startTime = new Date().toLocaleString();
            } else if (!state.pendingOrderId) {
                state.volume = 0; state.roi = 0; state.entryPrice = 0; state.step = 0;
            }
        }

        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data?.[0]) {
            state.currentEquity = parseFloat(accRes.data[0].margin_balance);
            state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
            if (state.initialEquity === null) state.initialEquity = state.currentEquity;
        }
    } catch (e) { console.error("Sync error:", e.message); }
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) continue;
            state.isLocked = true; state.lastAction = "Opening Position...";
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction,
                offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') state.pendingOrderId = res.data.order_id_str;
            else { state.isLocked = false; state.lastAction = "Open Failed"; }
            continue;
        }

        if (state.roi >= config.takeProfitPct) {
            state.isLocked = true; state.lastAction = "Taking Profit...";
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') state.pendingOrderId = res.data.order_id_str;
            else { state.isLocked = false; state.lastAction = "TP Failed"; }
            continue;
        }

        // STEP CALCULATION BASED ON OPEN VALUE (ENTRY PRICE)
        let priceMove = state.direction === 'buy' ? 
            ((state.entryPrice - currentPrice) / state.entryPrice) * 100 : 
            ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
        
        if (priceMove >= config.stepDistancePct && state.entryPrice > 0) {
            state.isLocked = true;
            const nextVol = Math.max(1, Math.ceil((state.lastAddedVolume || config.baseVolume) * config.multiplier));
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVol, direction: state.direction,
                offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.step++; state.lastAddedVolume = nextVol;
                state.lastAction = `Step ${state.step} (+${priceMove.toFixed(2)}%)`;
            } else { state.isLocked = false; state.lastAction = "Step Failed"; }
        }
    }
}

// ==================== ENGINE & WS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                if (msg.tick) {
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

async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    if (market.status === 'Active') await processMartingale();
    const s1 = accountStates[1], s2 = accountStates[2];
    if (s1 && s2 && market.initialTotalEquity > 0) {
        market.totalNetGain = (s1.currentEquity + s2.currentEquity) - market.initialTotalEquity;
        market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
    }
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Martingale Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0A0E17; color: #E8EDF2; font-family: 'Inter', sans-serif; }
        .exchange-card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; }
        .stat-label { font-size: 11px; font-weight: 700; color: #6B7A8F; text-transform: uppercase; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .mono { font-family: 'SF Mono', monospace; }
        .badge-long { background: rgba(0, 209, 178, 0.12); color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
        .badge-short { background: rgba(255, 77, 109, 0.12); color: #FF4D6D; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span></h1>
            <div class="text-right"><p class="stat-label">TOTAL GAIN</p><p id="totalNetGain" class="text-3xl font-black mono">0.00 USDT</p></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <div class="exchange-card p-6">
                <div class="flex justify-between"><div><p class="stat-label">LONG ROI</p><p id="lRoi" class="text-3xl font-black">0%</p></div>
                <div class="text-right"><p class="stat-label">AVAILABLE</p><p id="lBal" class="mono font-bold">0.00</p></div></div>
                <div class="grid grid-cols-3 gap-4 mt-4 border-t border-[#1F2A3E] pt-4">
                    <div><p class="stat-label">STEP</p><p id="lStep" class="font-bold">0</p></div>
                    <div><p class="stat-label">VOL</p><p id="lVol" class="font-bold">0</p></div>
                    <div><p class="stat-label">ENTRY</p><p id="lEntry" class="mono text-[10px]">0.00</p></div>
                </div>
                <p id="lAction" class="text-[10px] text-indigo-400 mt-4 font-bold"></p>
            </div>
            <div class="exchange-card p-6">
                <div class="flex justify-between"><div><p class="stat-label">SHORT ROI</p><p id="sRoi" class="text-3xl font-black">0%</p></div>
                <div class="text-right"><p class="stat-label">AVAILABLE</p><p id="sBal" class="mono font-bold">0.00</p></div></div>
                <div class="grid grid-cols-3 gap-4 mt-4 border-t border-[#1F2A3E] pt-4">
                    <div><p class="stat-label">STEP</p><p id="sStep" class="font-bold">0</p></div>
                    <div><p class="stat-label">VOL</p><p id="sVol" class="font-bold">0</p></div>
                    <div><p class="stat-label">ENTRY</p><p id="sEntry" class="mono text-[10px]">0.00</p></div>
                </div>
                <p id="sAction" class="text-[10px] text-indigo-400 mt-4 font-bold"></p>
            </div>
        </div>

        <div class="exchange-card overflow-hidden">
            <table class="w-full text-left">
                <thead class="bg-[#0F141C] text-[11px] text-slate-500"><tr><th class="p-4">SIDE</th><th class="p-4">OPEN/CLOSE TIME</th><th class="p-4">VOL</th><th class="p-4">ENTRY/EXIT</th><th class="p-4">ROI</th><th class="p-4">PNL</th></tr></thead>
                <tbody id="historyBody" class="text-sm"></tbody>
            </table>
        </div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = d.market.totalNetGain.toFixed(6) + ' USDT';
            if (d.accounts.length >= 2) {
                const l = d.accounts[0], s = d.accounts[1];
                document.getElementById('lRoi').innerText = l.roi.toFixed(2) + '%';
                document.getElementById('lRoi').className = 'text-3xl font-black ' + (l.roi >= 0 ? 'value-positive' : 'value-negative');
                document.getElementById('lBal').innerText = l.availableMargin.toFixed(2);
                document.getElementById('lStep').innerText = l.step;
                document.getElementById('lVol').innerText = l.volume;
                document.getElementById('lEntry').innerText = l.entryPrice.toFixed(8);
                document.getElementById('lAction').innerText = l.lastAction;

                document.getElementById('sRoi').innerText = s.roi.toFixed(2) + '%';
                document.getElementById('sRoi').className = 'text-3xl font-black ' + (s.roi >= 0 ? 'value-positive' : 'value-negative');
                document.getElementById('sBal').innerText = s.availableMargin.toFixed(2);
                document.getElementById('sStep').innerText = s.step;
                document.getElementById('sVol').innerText = s.volume;
                document.getElementById('sEntry').innerText = s.entryPrice.toFixed(8);
                document.getElementById('sAction').innerText = s.lastAction;
            }
            let html = '';
            d.tradeHistory.forEach(h => {
                html += '<tr class="border-t border-[#1A212E]">';
                html += '<td class="p-4"><span class="' + (h.side === 'LONG' ? 'badge-long' : 'badge-short') + '">' + h.side + '</span></td>';
                html += '<td class="p-4 mono text-[10px]">' + h.openTime + '<br>' + h.closeTime + '</td>';
                html += '<td class="p-4">' + h.volume + '</td>';
                html += '<td class="p-4 mono text-[10px]">' + h.entryPrice + '<br>' + h.exitPrice + '</td>';
                html += '<td class="p-4 font-bold ' + (parseFloat(h.roi) >= 0 ? 'value-positive' : 'value-negative') + '">' + h.roi + '</td>';
                html += '<td class="p-4 mono font-bold">' + h.netPnlUsdt + '</td>';
                html += '</tr>';
            });
            document.getElementById('historyBody').innerHTML = html;
        }, 1000);
    </script>
</body>
</html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0');
