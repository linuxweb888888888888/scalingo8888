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
    addSize: 1,                  // Add 1 contract to sync
    feeRate: 0.0006,             
    contractSize: 0,
    roiThreshold: 0.5,           // Sync if ROI difference is > 0.5%
    pnlThreshold: 0.00001        // Sync if PnL difference is > 0.00001
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
    } catch (e) { 
        console.log(`❌ REQUEST FAILED: ${e.message}`);
        return { status: 'error' }; 
    }
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

    // 1. OPEN INITIAL 1v1 HEDGE
    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        market.status = 'Initializing Sync...';
        const tasks = [];
        if (s1.volume < 1) tasks.push(htxRequest(acc1, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }));
        if (s2.volume < 1) tasks.push(htxRequest(acc2, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }));
        await Promise.all(tasks);
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. MIRROR CALCULATION
    // Goal: roi1 + roi2 = 0 and pnl1 + pnl2 = 0
    const roiCombined = s1.roi + s2.roi;
    const pnlCombined = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // 3. ADJUSTMENT TRIGGER
    // If the combined values are far from zero, one side is "lacking magnitude"
    if (Math.abs(roiCombined) > config.roiThreshold || Math.abs(pnlCombined) > config.pnlThreshold) {
        
        let targetAcc = null;
        // Logic: Add to the side that has the smaller absolute ROI (the side that is lagging)
        if (Math.abs(s1.roi) < Math.abs(s2.roi)) {
            targetAcc = acc1;
        } else {
            targetAcc = acc2;
        }

        if (targetAcc) {
            isProcessing = true;
            const targetState = accountStates[targetAcc.accountId];
            market.status = `Syncing ROI: Adding 1 to ${targetState.direction}...`;
            
            console.log(`⚖️ Syncing ROI/PnL: Acc1(${s1.roi.toFixed(2)}%) Acc2(${s2.roi.toFixed(2)}%). Adding to ${targetState.direction}`);
            
            await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: config.addSize, 
                direction: targetState.direction, 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'optimal_5' 
            });

            // Wait for position to update before next loop
            setTimeout(() => { isProcessing = false; }, 4000);
        }
    } else {
        market.status = "ROI & PnL Fully Synced";
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
    <meta charset="UTF-8"><title>AtomicSync Mirror</title>
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
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white">ATOMIC<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Mirror ROI Mode</p></div>
            <div class="text-right">
                <p class="text-[10px] text-zinc-500 font-bold uppercase">Mark Price</p>
                <p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.00000000</p>
            </div>
        </div>
        
        <div class="glass rounded-[2.5rem] p-8 mb-8 text-center border-indigo-500/20">
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Sync Delta (Combined ROI)</p>
            <h2 id="roiDelta" class="text-6xl font-black mb-4 font-mono">0.00%</h2>
            <p class="text-zinc-400 text-sm">Targeting perfect opposite ROI and PnL values.</p>
        </div>

        <div class="grid md:grid-cols-2 gap-6">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between"><span class="text-xs font-bold text-emerald-500 uppercase">Long Acc</span><span id="longRoi" class="font-bold text-emerald-400">0.00%</span></div>
                <div id="longUsdt" class="text-2xl font-mono font-bold mt-2 text-white">$0.00000000</div>
                <div id="longVol" class="text-xs text-zinc-500 mt-1">Size: 0</div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
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
                let roiSum = 0;
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = (a.unrealizedUsdt >= 0 ? '+' : '') + a.unrealizedUsdt.toFixed(8);
                    document.getElementById(prefix + 'Vol').innerText = 'Size: ' + a.volume;
                    roiSum += a.roi;
                });
                const rElem = document.getElementById('roiDelta');
                rElem.innerText = (roiSum >= 0 ? '+' : '') + roiSum.toFixed(2) + '%';
                rElem.className = 'text-6xl font-black mb-4 font-mono ' + (Math.abs(roiSum) < 1 ? 'text-indigo-400' : 'text-zinc-400');
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>`);
});

startWS(); setInterval(sync, 2000); setInterval(tradeLoop, 3000); app.listen(config.port, '0.0.0.0');
console.log(`ROI Mirror Sync Running on Port ${config.port}`);
