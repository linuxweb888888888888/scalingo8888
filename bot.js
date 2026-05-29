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
    }
}

async function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    
    const acc1 = config.accounts[0];
    const acc2 = config.accounts[1];
    const s1 = accountStates[acc1.accountId];
    const s2 = accountStates[acc2.accountId];

    // 1. Initial Hedge Open
    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        if (s1.volume < 1) await htxRequest(acc1, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        if (s2.volume < 1) await htxRequest(acc2, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. PRECISE CALCULATION
    const roi1Mag = Math.abs(s1.roi);
    const roi2Mag = Math.abs(s2.roi);
    const roiDiff = Math.abs(roi1Mag - roi2Mag);

    if (roiDiff > config.roiThreshold) {
        // Find the side with the LARGER magnitude (the one that needs adjusting)
        const targetAccIdx = roi1Mag > roi2Mag ? 0 : 1;
        const anchorAccIdx = targetAccIdx === 0 ? 1 : 0;
        
        const targetAcc = config.accounts[targetAccIdx];
        const targetState = accountStates[targetAcc.accountId];
        const anchorState = accountStates[config.accounts[anchorAccIdx].accountId];

        // Solve for X (precise contracts to add to move average price to target ROI)
        // P_target = Market / (1 + (Side * Target_ROI / (Leverage * 100)))
        const sideFactor = targetState.direction === 'buy' ? 1 : -1;
        const targetRoiDecimal = Math.abs(anchorState.roi) / (config.leverage * 100);
        const pTarget = market.last / (1 + (sideFactor * targetRoiDecimal));

        // Required Volume X = CurrentVolume * (CurrentAvg - TargetAvg) / (TargetAvg - MarketPrice)
        let preciseX = Math.ceil(
            targetState.volume * (targetState.avgPrice - pTarget) / (pTarget - market.last)
        );

        // Filter valid precise amount
        if (isNaN(preciseX) || preciseX <= 0) preciseX = 1;
        preciseX = Math.min(preciseX, config.maxSyncBatch); 

        isProcessing = true;
        market.status = `Precise Sync: Adding ${preciseX} to ${targetState.direction}`;
        console.log(`⚖️ BALANCING: Adding ${preciseX} to ${targetState.direction} to match ${anchorState.roi.toFixed(2)}%`);

        await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, 
            volume: preciseX, 
            direction: targetState.direction, 
            offset: 'open', 
            lever_rate: config.leverage, 
            order_price_type: 'optimal_5' 
        });

        setTimeout(() => { isProcessing = false; }, 4000);
    } else {
        market.status = "Mirror Synced";
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
    <meta charset="UTF-8"><title>Precise Mirror Sync</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { font-family: sans-serif; background: #09090b; color: #fafafa; }</style>
</head>
<body class="p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-bold">PRECISE<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-xs text-zinc-500 uppercase tracking-widest">Status</p></div>
            <div class="text-right">
                <p class="text-[10px] text-zinc-500 font-bold uppercase">Mark Price</p>
                <p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.00000000</p>
            </div>
        </div>
        <div class="grid md:grid-cols-2 gap-6">
            <div class="bg-zinc-900 p-6 rounded-3xl border border-emerald-500/20">
                <div class="flex justify-between"><span class="text-xs font-bold text-emerald-500 uppercase">Long Acc</span><span id="longRoi" class="font-bold text-emerald-400">0.00%</span></div>
                <div id="longUsdt" class="text-2xl font-mono font-bold mt-2 text-white">$0.00000000</div>
                <div id="longVol" class="text-xs text-zinc-500 mt-1">Size: 0</div>
            </div>
            <div class="bg-zinc-900 p-6 rounded-3xl border border-rose-500/20">
                <div class="flex justify-between"><span class="text-xs font-bold text-rose-500 uppercase">Short Acc</span><span id="shortRoi" class="font-bold text-rose-400">0.00%</span></div>
                <div id="shortUsdt" class="text-2xl font-mono font-bold mt-2 text-white">$0.00000000</div>
                <div id="shortVol" class="text-xs text-zinc-500 mt-1">Size: 0</div>
            </div>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
                document.getElementById('botStatus').innerText = d.market.status;
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = (a.unrealizedUsdt >= 0 ? '+' : '') + a.unrealizedUsdt.toFixed(8);
                    document.getElementById(prefix + 'Vol').innerText = 'Size: ' + a.volume;
                });
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>`);
});

startWS(); setInterval(sync, 2000); setInterval(tradeLoop, 3000); app.listen(config.port, '0.0.0.0');
