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
    orderSize: 1,                
    maxSyncBatch: 100,           // Safety cap for precise additions
    feeRate: 0.0006,             
    contractSize: 0,
    roiThreshold: 0.05           // Sync if ROI magnitude difference > 0.05%
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;

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
        if (res.data.status !== 'ok') console.log(`❌ HTX ERROR: ${JSON.stringify(res.data)}`);
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
                state.volume = Math.floor(parseFloat(pos.volume));
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
    
    const acc1 = config.accounts[0];
    const acc2 = config.accounts[1];
    const s1 = accountStates[acc1.accountId];
    const s2 = accountStates[acc2.accountId];

    // 1. Initial Position check
    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        market.status = 'Opening Initial Hedge...';
        if (s1.volume < 1) await htxRequest(acc1, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        if (s2.volume < 1) await htxRequest(acc2, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. Precise Mirror Logic
    const roi1Mag = Math.abs(s1.roi);
    const roi2Mag = Math.abs(s2.roi);
    const roiDiff = Math.abs(roi1Mag - roi2Mag);

    if (roiDiff > config.roiThreshold) {
        // Target the "Outlier" (the one with higher ROI magnitude) to pull it back to the "Anchor"
        const targetAccIdx = roi1Mag > roi2Mag ? 0 : 1;
        const anchorAccIdx = targetAccIdx === 0 ? 1 : 0;
        
        const targetAcc = config.accounts[targetAccIdx];
        const targetState = accountStates[targetAcc.accountId];
        const anchorState = accountStates[config.accounts[anchorAccIdx].accountId];

        // Solve for X using Target Average Price
        const sideFactor = targetState.direction === 'buy' ? 1 : -1;
        const targetRoiDecimal = Math.abs(anchorState.roi) / (config.leverage * 100);
        const pTarget = market.last / (1 + (sideFactor * targetRoiDecimal));

        // Volume to Add X = CurrentVol * (CurrentAvg - TargetAvg) / (TargetAvg - MarketPrice)
        let amountToAdd = Math.ceil(
            targetState.volume * (targetState.avgPrice - pTarget) / (pTarget - market.last)
        );

        if (isNaN(amountToAdd) || amountToAdd <= 0) amountToAdd = 1;
        amountToAdd = Math.min(amountToAdd, config.maxSyncBatch); 

        isProcessing = true;
        market.status = `Balancing: Adding ${amountToAdd} to ${targetState.direction}`;
        console.log(`⚖️ BALANCING: Adding ${amountToAdd} to ${targetState.direction} to match ${anchorState.roi.toFixed(2)}% ROI`);

        await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, 
            volume: amountToAdd, 
            direction: targetState.direction, 
            offset: 'open', 
            lever_rate: config.leverage, 
            order_price_type: 'optimal_5' 
        });

        setTimeout(() => { isProcessing = false; }, 4000);
    } else {
        market.status = "Mirrored (ROI & PnL Synced)";
    }
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

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>AtomicSync Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #09090b; color: #fafafa; }
        .glass { background: rgba(24, 24, 27, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(63, 63, 70, 0.5); }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white">ATOMIC<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Running...</p></div>
            <div class="flex gap-10 text-right">
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Mark Price</p><p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.00000000</p></div>
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Total Equity Growth</p><p id="totalRealized" class="text-xl font-mono font-bold text-emerald-400">+$0.00000000</p></div>
            </div>
        </div>
        <div class="glass rounded-[2.5rem] p-8 mb-8 relative overflow-hidden border-indigo-500/20 text-center">
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">PnL Combined (Mirror Delta)</p>
            <h2 id="netProfit" class="text-6xl font-black mb-4 font-mono">+$0.00000000</h2>
            <div class="inline-flex items-center gap-2 bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800">
                <span class="text-[10px] font-bold text-zinc-500 uppercase">Mode:</span><span class="text-xs font-mono font-bold text-indigo-400">Precise Mirror Sync</span>
            </div>
        </div>
        <div class="grid md:grid-cols-2 gap-6">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-emerald-500 uppercase tracking-widest">Long Side (Acc 1)</span><span id="longRoi" class="text-xl font-black text-emerald-400">0.00%</span></div>
                <div class="flex justify-between items-center"><span class="text-xs text-zinc-500 uppercase font-bold">Vol / PnL (USDT)</span><span id="longUsdt" class="text-sm font-mono font-bold text-white">0 / $0.00000000</span></div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-rose-500 uppercase tracking-widest">Short Side (Acc 2)</span><span id="shortRoi" class="text-xl font-black text-rose-400">0.00%</span></div>
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
                let tP = 0, tR = 0;
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(8);
                    tP += a.unrealizedUsdt; tR += a.realizedProfit;
                });
                document.getElementById('totalRealized').innerText = (tR >= 0 ? '+' : '') + '$' + tR.toFixed(8);
                const pElem = document.getElementById('netProfit');
                pElem.innerText = (tP >= 0 ? '+' : '') + tP.toFixed(8);
                pElem.className = 'text-6xl font-black mb-4 font-mono ' + (Math.abs(tP) < 0.0001 ? 'text-indigo-400' : 'text-zinc-400');
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>`);
});

startWS(); setInterval(sync, 2000); setInterval(tradeLoop, 3000); app.listen(config.port, '0.0.0.0');
console.log(`AtomicSync Pro (Mirror Mode) running on Port ${config.port}`);
