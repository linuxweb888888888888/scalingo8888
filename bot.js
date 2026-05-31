require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    symbolA: 'SHIB-USDT',      // Account 1: Long
    symbolB: 'BONK-USDT',      // Account 2: Short
    
    // CONTRACT FACE VALUES (Tokens per 1 contract)
    faceValueA: 1000,          // Your SHIB spec: 1 contract = 1,000 tokens
    faceValueB: 10000000,      // HTX BONK-USDT spec: 1 contract is usually 10M tokens. VERIFY THIS.
    
    anchorB: 1,                // Logic: Open exactly 1 contract of BONK
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    
    winLossRatio: 1.5,
    resetDiffThreshold: 3.5,   // % gap to trigger reset
    autoClosePct: 110,
    takerFeeRate: 0.0005
};

const apiAccounts = [
    { apiKey: process.env.HTX_API_KEY_1, secretKey: process.env.HTX_SECRET_KEY_1, accountId: 1, symbol: config.symbolA, direction: 'buy' },
    { apiKey: process.env.HTX_API_KEY_2, secretKey: process.env.HTX_SECRET_KEY_2, accountId: 2, symbol: config.symbolB, direction: 'sell' }
];

let market = {
    status: 'Active', priceA: { bid: 0, ask: 0 }, priceB: { bid: 0, ask: 0 },
    currentRatio: 0, diffSum: 0, totalNetGain: 0, initialTotalEquity: 0,
    resetUsed: false, sessionResetLoss: 0, netSessionUsdt: 0
};

let accountStates = {
    1: { symbol: config.symbolA, direction: 'buy', roi: 0, volume: 0, entryPrice: 0, unrealizedUsdt: 0, currentEquity: 0, initialEquity: null, isLocked: false },
    2: { symbol: config.symbolB, direction: 'sell', roi: 0, volume: 0, entryPrice: 0, unrealizedUsdt: 0, currentEquity: 0, initialEquity: null, isLocked: false }
};

let tradeHistory = [];

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

async function syncAccount(acc) {
    const state = accountStates[acc.accountId];
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: acc.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === acc.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

// ==================== STRATEGY ENGINE ====================
async function openHedge() {
    if (market.priceA.ask === 0 || market.priceB.bid === 0) return;

    // 1. Value of 1 BONK Contract
    const bonkValueUsd = market.priceB.bid * config.faceValueB * config.anchorB;
    // 2. SHIB contracts needed to match that value
    const shibVol = Math.floor(bonkValueUsd / (market.priceA.ask * config.faceValueA));

    if (shibVol < 1) return;

    await htxRequest(apiAccounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbolA, volume: shibVol, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
    });
    await htxRequest(apiAccounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbolB, volume: config.anchorB, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
    });
}

async function flashReset(accIdx) {
    if (market.resetUsed) return;
    const acc = apiAccounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.volume === 0 || state.isLocked) return;

    state.isLocked = true;
    market.resetUsed = true;
    market.sessionResetLoss += Math.abs(state.unrealizedUsdt);

    // Close
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: acc.symbol, volume: state.volume, direction: acc.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    // Re-open with Anchor Logic
    const bonkValue = market.priceB.bid * config.faceValueB * config.anchorB;
    const vol = accIdx === 0 ? Math.floor(bonkValue / (market.priceA.ask * config.faceValueA)) : config.anchorB;

    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: acc.symbol, volume: vol, direction: acc.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { state.isLocked = false; }, 5000);
}

// ==================== WS FEED ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        ws.send(JSON.stringify({ sub: `market.${config.symbolA}.bbo`, id: 'a' }));
        ws.send(JSON.stringify({ sub: `market.${config.symbolB}.bbo`, id: 'b' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.ch === `market.${config.symbolA}.bbo`) {
                market.priceA.bid = msg.tick.bid[0]; market.priceA.ask = msg.tick.ask[0];
            }
            if (msg.ch === `market.${config.symbolB}.bbo`) {
                market.priceB.bid = msg.tick.bid[0]; market.priceB.ask = msg.tick.ask[0];
            }

            const s1 = accountStates[1]; const s2 = accountStates[2];
            if (s1.entryPrice > 0 && s2.entryPrice > 0) {
                const roiA = ((market.priceA.bid - s1.entryPrice) / s1.entryPrice) * config.leverage * 100;
                const roiB = ((s2.entryPrice - market.priceB.ask) / s2.entryPrice) * config.leverage * 100;
                
                market.diffSum = Math.max(roiA, roiB);
                
                const winPnl = Math.max(s1.unrealizedUsdt, s2.unrealizedUsdt);
                const totalDebt = Math.abs(Math.min(s1.unrealizedUsdt, s2.unrealizedUsdt)) + market.sessionResetLoss + 0.01;
                market.currentRatio = winPnl / totalDebt;
                market.netSessionUsdt = (s1.unrealizedUsdt + s2.unrealizedUsdt) - market.sessionResetLoss;

                if (market.status === 'Active' && !market.resetUsed && market.diffSum >= config.resetDiffThreshold) {
                    roiA < roiB ? flashReset(0) : flashReset(1);
                }
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MAIN LOOP ====================
async function backgroundLoop() {
    await Promise.all(apiAccounts.map(acc => syncAccount(acc)));
    const s1 = accountStates[1]; const s2 = accountStates[2];
    market.totalNetGain = (s1.currentEquity + s2.currentEquity) - (s1.initialEquity + s2.initialEquity);

    if (market.status === 'Active' && s1.volume === 0 && s2.volume === 0 && !s1.isLocked && !s2.isLocked) {
        await openHedge();
    }

    if (market.status === 'Active' && (market.currentRatio * 100 / config.winLossRatio) >= config.autoClosePct && market.netSessionUsdt > 0) {
        market.status = "LIQUIDATING";
        for (const acc of apiAccounts) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: acc.symbol, volume: accountStates[acc.accountId].volume, direction: acc.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
        }
        market.resetUsed = false; market.sessionResetLoss = 0;
        setTimeout(() => market.status = "Active", 15000);
    }
}

// ==================== DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>SHIB/BONK Arb</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#0f172a;color:white;font-family:sans-serif;}</style></head>
    <body class="p-10"><div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-end mb-10">
            <div><h1 class="text-3xl font-black italic">SHIB / BONK <span class="text-indigo-500">PRO</span></h1><p class="text-emerald-500 font-bold text-xs tracking-widest">ENGINE ACTIVE</p></div>
            <div class="text-right"><p id="netGain" class="text-3xl font-black">$0.0000</p><p class="text-xs text-slate-400">SESSION NET PROFIT</p></div>
        </div>
        <div class="grid grid-cols-3 gap-6 mb-10">
            <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                <p class="text-xs font-bold text-slate-400 mb-1 uppercase">Debt Ratio</p>
                <p id="uiRatio" class="text-3xl font-black text-white">0.00x</p>
            </div>
            <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                <p class="text-xs font-bold text-slate-400 mb-1 uppercase">Diff Sum</p>
                <p id="uiDiff" class="text-3xl font-black text-indigo-400">0.00%</p>
            </div>
            <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                <p class="text-xs font-bold text-slate-400 mb-1 uppercase">Net PnL</p>
                <p id="uiNet" class="text-3xl font-black text-emerald-400">$0.00</p>
            </div>
        </div>
        <div class="bg-slate-800 p-8 rounded-3xl border border-slate-700">
            <div class="grid grid-cols-2 gap-10">
                <div><p class="text-xs font-bold text-emerald-500 uppercase mb-2">SHIB Long</p><p id="roiA" class="text-5xl font-black">0.00%</p><p id="pnlA" class="text-slate-400 font-bold">$0.00</p></div>
                <div class="text-right"><p class="text-xs font-bold text-rose-500 uppercase mb-2">BONK Short</p><p id="roiB" class="text-5xl font-black">0.00%</p><p id="pnlB" class="text-slate-400 font-bold">$0.00</p></div>
            </div>
        </div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('netGain').innerText = '$' + d.market.totalNetGain.toFixed(4);
            document.getElementById('uiRatio').innerText = d.market.currentRatio.toFixed(2) + 'x';
            document.getElementById('uiDiff').innerText = d.market.diffSum.toFixed(2) + '%';
            document.getElementById('uiNet').innerText = '$' + d.market.netSessionUsdt.toFixed(2);
            document.getElementById('roiA').innerText = d.accounts[0].roi.toFixed(2) + '%';
            document.getElementById('pnlA').innerText = '$' + d.accounts[0].unrealizedUsdt.toFixed(3);
            document.getElementById('roiB').innerText = d.accounts[1].roi.toFixed(2) + '%';
            document.getElementById('pnlB').innerText = '$' + d.accounts[1].unrealizedUsdt.toFixed(3);
        }, 1000);
    </script></body></html>`);
});

startWS();
setInterval(backgroundLoop, 3000);
app.listen(config.port, '0.0.0.0', () => console.log(`Engine Online: Matching 1 BONK to SHIB Value`));
