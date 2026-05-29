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
    addSize: 1,                  
    feeRate: 0.0006,             
    contractSize: 0,
    roiThreshold: 0.1,           
    maxVolGap: 500               
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

// ==================== CORE LOGIC ====================

async function restSync() {
    if (config.contractSize === 0) {
        const info = await htxRequest(config.accounts[0], 'GET', '/linear-swap-api/v1/swap_contract_info');
        if (info?.status === 'ok') {
            const contract = info.data.find(c => c.contract_code === config.symbol);
            if (contract) config.contractSize = parseFloat(contract.contract_size);
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
            } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }
    }
}

// INSTANT MONITOR: Triggers on every price tick via WebSocket
function instantCheck() {
    if (isProcessing || market.last === 0 || config.contractSize === 0) return;

    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    if (s1.volume < 1 || s2.volume < 1) return;

    // LIVE CALCULATION
    const calc = (s) => {
        const side = s.direction === 'buy' ? 1 : -1;
        s.roi = ((market.last - s.avgPrice) / s.avgPrice) * config.leverage * side * 100;
        s.unrealizedUsdt = (market.last - s.avgPrice) * s.volume * side * config.contractSize;
    };
    calc(s1); calc(s2);

    const combinedPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // INSTANT EXIT TRIGGER: Profit > 0 (Progress ignored)
    if (combinedPnL > 0) {
        console.log(`🚀 PROFIT DETECTED: $${combinedPnL.toFixed(8)}. Executing Instant Close.`);
        market.status = "EXECUTING INSTANT EXIT...";
        closeAll();
    }
}

// SLOW SYNC: Runs every 3 seconds for position balancing
function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        Promise.all([
            s1.volume < 1 ? htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }) : null,
            s2.volume < 1 ? htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }) : null
        ]).finally(() => { setTimeout(() => { isProcessing = false; }, 3000); });
        return;
    }

    const roi1Mag = Math.abs(s1.roi);
    const roi2Mag = Math.abs(s2.roi);
    const isMirrored = (s1.roi * s2.roi < 0);
    const syncProgress = isMirrored ? (Math.min(roi1Mag, roi2Mag) / Math.max(roi1Mag, roi2Mag)) * 100 : 0;
    const combinedPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    let targetAcc = null;

    if (!isMirrored) {
        market.status = "Correction: Fixing Signs...";
        targetAcc = (roi1Mag < roi2Mag) ? config.accounts[0] : config.accounts[1];
    } 
    else if (syncProgress > 95) {
        if (combinedPnL <= 0) {
            market.status = "Profit Push...";
            targetAcc = (s1.roi > s2.roi) ? config.accounts[0] : config.accounts[1];
        }
    } 
    else if (Math.abs(roi1Mag - roi2Mag) > config.roiThreshold) {
        market.status = "Syncing Magnitudes...";
        targetAcc = (roi1Mag > roi2Mag) ? config.accounts[0] : config.accounts[1];
    }

    if (targetAcc) {
        if (Math.abs(s1.volume - s2.volume) > config.maxVolGap) return;
        isProcessing = true;
        htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.addSize, direction: accountStates[targetAcc.accountId].direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        }).finally(() => { setTimeout(() => { isProcessing = false; }, 4000); });
    }
}

async function closeAll() {
    isProcessing = true;
    await Promise.all(config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        if (state.volume <= 0) return Promise.resolve();
        return htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: state.volume, 
            direction: state.direction === 'buy' ? 'sell' : 'buy', 
            offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
    }));
    setTimeout(() => { isProcessing = false; }, 10000);
}

// ==================== WS & DASHBOARD ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
                instantCheck(); 
            }
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
        .progress-bar { transition: width 0.3s ease; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white">ATOMIC<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Active</p></div>
            <div class="text-right"><p class="text-[10px] text-zinc-500 font-bold uppercase">Price</p><p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.00</p></div>
        </div>
        <div class="glass rounded-[2.5rem] p-8 mb-8 text-center border-indigo-500/20">
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Net Exit Profit (Mirror Delta)</p>
            <h2 id="netProfit" class="text-6xl font-black mb-6 font-mono">+$0.00</h2>
            <div class="max-w-md mx-auto mb-2">
                <div class="flex justify-between text-[10px] font-bold uppercase text-zinc-500 mb-2"><span>Sync Progress (Mirroring Goal)</span><span id="syncPct">0%</span></div>
                <div class="w-full bg-zinc-900 h-3 rounded-full border border-zinc-800 overflow-hidden p-0.5">
                    <div id="syncBar" class="progress-bar h-full bg-indigo-500 rounded-full" style="width: 0%"></div>
                </div>
            </div>
        </div>
        <div class="grid md:grid-cols-2 gap-6">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-emerald-500 uppercase tracking-widest">Long Side</span><span id="longRoi" class="text-xl font-black text-emerald-400">0.00%</span></div>
                <div id="longUsdt" class="text-sm font-mono font-bold text-white">0 / $0.00</div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-rose-500 uppercase tracking-widest">Short Side</span><span id="shortRoi" class="text-xl font-black text-rose-400">0.00%</span></div>
                <div id="shortUsdt" class="text-sm font-mono font-bold text-white">0 / $0.00</div>
            </div>
        </div>
    </div>
    <script>
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
                document.getElementById('botStatus').innerText = d.market.status;
                let tP = 0, rois = [];
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    rois.push(a.roi); tP += a.unrealizedUsdt;
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(8);
                });
                const sScore = (rois[0] * rois[1] < 0) ? (Math.min(Math.abs(rois[0]), Math.abs(rois[1])) / Math.max(Math.abs(rois[0]), Math.abs(rois[1]))) * 100 : 0;
                document.getElementById('syncBar').style.width = (isNaN(sScore) ? 0 : sScore.toFixed(0)) + '%';
                document.getElementById('syncPct').innerText = (isNaN(sScore) ? 0 : sScore.toFixed(1)) + '%';
                document.getElementById('netProfit').innerText = (tP >= 0 ? '+' : '') + tP.toFixed(8);
                document.getElementById('netProfit').className = 'text-6xl font-black mb-6 font-mono ' + (tP > 0 ? 'text-emerald-400' : 'text-zinc-400');
            } catch(e) {}
        }, 500);
    </script>
</body>
</html>`);
});

startWS(); 
setInterval(restSync, 2000); 
setInterval(tradeLoop, 3000); 
app.listen(config.port, '0.0.0.0');
