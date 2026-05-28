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
    orderSize: 1,                // Start with 1
    triggerRoi: 2.0,             // Wait for 2% ROI
    feeRate: 0.0005,             // 0.05% Taker fee
    contractSize: 0              // Auto-detected
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;
let hasAddedThisCycle = false; // Flag to ensure we only add ONCE

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, initialBalance: 0, realizedProfit: 0, wallet: 0
    };
});

// ==================== API HANDLER ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

// ==================== CORE LOGIC ====================

async function sync() {
    if (config.contractSize === 0) {
        const info = await htxRequest(config.accounts[0], 'GET', '/linear-swap-api/v1/swap_contract_info', { contract_code: config.symbol });
        if (info?.status === 'ok') {
            const contract = info.data.find(c => c.contract_code === config.symbol);
            config.contractSize = contract ? parseFloat(contract.contract_size) : 1;
        }
    }

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.status === 'ok' && res.data) {
            const pos = res.data.find(p => p.direction === state.direction);
            if (pos && parseFloat(pos.volume) > 0) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = parseFloat(pos.volume);
                state.unrealizedUsdt = parseFloat(pos.profit);
                state.roi = parseFloat(pos.profit_rate) * 100;
            } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data) {
            const equity = parseFloat(accRes.data[0].margin_balance);
            if (state.initialBalance === 0) state.initialBalance = equity;
            state.wallet = equity;
            state.realizedProfit = equity - state.initialBalance;
        }
    }
}

async function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    // 1. Start Cycle
    if (long.volume === 0 && short.volume === 0) {
        market.status = 'Starting New Cycle...';
        hasAddedThisCycle = false; // Reset flag
        isProcessing = true;
        await Promise.all(config.accounts.map((acc, idx) => htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.orderSize, direction: idx === 0 ? 'buy' : 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        })));
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. Net Profit Calculation
    const totalVol = long.volume + short.volume;
    const estExitFees = (totalVol * config.contractSize * market.last) * config.feeRate;
    const netProfit = (long.unrealizedUsdt + short.unrealizedUsdt) - estExitFees;

    // 3. Exit Condition (Any Net Profit)
    if (netProfit > 0.00000001) {
        market.status = `Exit Profit Found: $${netProfit.toFixed(8)}`;
        await closeAll();
        return;
    }

    // 4. One-Time 2% Repair Trigger
    if (!hasAddedThisCycle) {
        let targetAcc = null;
        if (long.roi >= config.triggerRoi) {
            targetAcc = config.accounts[1]; // Long is winning, add to Short
        } else if (short.roi >= config.triggerRoi) {
            targetAcc = config.accounts[0]; // Short is winning, add to Long
        }

        if (targetAcc) {
            const side = accountStates[targetAcc.accountId].direction;
            market.status = `Triggering One-Time Add (${side.toUpperCase()})`;
            await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: 1, direction: side, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            hasAddedThisCycle = true; // Mark as done for this cycle
        } else {
            market.status = `Waiting for ${config.triggerRoi}% ROI Threshold`;
        }
    } else {
        market.status = 'Monitoring for Net Profit Exit';
    }
}

async function closeAll() {
    isProcessing = true;
    await Promise.all(config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        return state.volume > 0 ? htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
        }) : Promise.resolve();
    }));
    hasAddedThisCycle = false; 
    setTimeout(() => { isProcessing = false; }, 5000);
}

// ==================== WS & DASHBOARD ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config, hasAddedThisCycle }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Atomic Hedge Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #09090b; color: #fafafa; }
        .glass { background: rgba(24, 24, 27, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(63, 63, 70, 0.5); }
        .roi-bar { transition: width 0.4s ease; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white">ATOMIC<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Running...</p></div>
            <div class="flex gap-10 text-right">
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Mark Price</p><p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.00000000</p></div>
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Combined Realized</p><p id="totalRealized" class="text-xl font-mono font-bold text-emerald-400">+$0.00000000</p></div>
            </div>
        </div>
        <div class="glass rounded-[2.5rem] p-8 mb-8 relative overflow-hidden border-indigo-500/20 text-center">
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Net Exit Profit (Incl. Fees)</p>
            <h2 id="netProfit" class="text-6xl font-black mb-4 font-mono">+$0.00000000</h2>
            <div class="inline-flex items-center gap-2 bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800">
                <span class="text-[10px] font-bold text-zinc-500 uppercase">One-Time Add:</span><span id="addFlag" class="text-xs font-mono font-bold text-indigo-400">No</span>
            </div>
        </div>
        <div class="grid md:grid-cols-2 gap-6">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-emerald-500 uppercase tracking-widest">Long Side</span><span id="longRoi" class="text-xl font-black text-emerald-400">0.00%</span></div>
                <div class="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden mb-4"><div id="longBar" class="roi-bar bg-emerald-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-xs text-zinc-500 uppercase font-bold">Vol / PnL (USDT)</span><span id="longUsdt" class="text-sm font-mono font-bold text-white">0 / $0.00000000</span></div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-rose-500 uppercase tracking-widest">Short Side</span><span id="shortRoi" class="text-xl font-black text-rose-400">0.00%</span></div>
                <div class="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden mb-4"><div id="shortBar" class="roi-bar bg-rose-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-xs text-zinc-500 uppercase font-bold">Vol / PnL (USDT)</span><span id="shortUsdt" class="text-sm font-mono font-bold text-white">0 / $0.00000000</span></div>
            </div>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
                document.getElementById('botStatus').innerText = d.market.status;
                document.getElementById('addFlag').innerText = d.hasAddedThisCycle ? 'Yes' : 'No';
                let tC = 0, tP = 0, tR = 0;
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    document.getElementById(prefix + 'Roi').innerText = a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(8);
                    document.getElementById(prefix + 'Bar').style.width = Math.min(100, Math.max(0, Math.abs(a.roi) * 20)) + '%';
                    tC += a.volume; tP += a.unrealizedUsdt; tR += a.realizedProfit;
                });
                document.getElementById('totalRealized').innerText = (tR >= 0 ? '+' : '') + '$' + tR.toFixed(8);
                const cSize = d.config.contractSize || 1;
                const realNotional = tC * cSize * d.market.last;
                const projected = tP - (realNotional * d.config.feeRate);
                const pElem = document.getElementById('netProfit');
                pElem.innerText = (projected >= 0 ? '+' : '') + '$' + projected.toFixed(8);
                pElem.className = 'text-6xl font-black mb-4 font-mono ' + (projected >= 0 ? 'text-emerald-400' : 'text-rose-500');
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>`);
});

startWS(); setInterval(sync, 2000); setInterval(tradeLoop, 3000); app.listen(config.port, '0.0.0.0');
