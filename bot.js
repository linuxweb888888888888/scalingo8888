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
    maxSyncBatch: 50,            // Safety cap: don't add more than 50 contracts in one hit
    feeRate: 0.0006,             
    contractSize: 0,
    roiThreshold: 0.05           // Trigger sync if ROI difference > 0.05%
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0
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
    
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[acc2 = config.accounts[1].accountId];

    // 1. Initial Position check
    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        if (s1.volume < 1) await htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        if (s2.volume < 1) await htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. PRECISE MATH CALCULATION
    // We want the ROI magnitude of both sides to be equal.
    const targetRoiMag = Math.min(Math.abs(s1.roi), Math.abs(s2.roi)); // We aim to pull the "outlier" back to the "anchor"
    const roiDiff = Math.abs(Math.abs(s1.roi) - Math.abs(s2.roi));

    if (roiDiff > config.roiThreshold) {
        // Identify the account that is "too far" from the market (Higher absolute ROI)
        const targetAccIdx = Math.abs(s1.roi) > Math.abs(s2.roi) ? 0 : 1;
        const targetAcc = config.accounts[targetAccIdx];
        const state = accountStates[targetAcc.accountId];

        // Solve for X: 
        // We want newEntry so that (abs(M - newEntry)/newEntry) * L * 100 = targetRoiMag
        // This is simplified to finding the volume needed to move average price.
        
        // Target Entry Price for that account to have the target ROI magnitude
        const side = state.direction === 'buy' ? 1 : -1;
        const R = targetRoiMag / (config.leverage * 100);
        const P_target = market.last / (1 + (side * R));

        // X = V * (P_current - P_target) / (P_target - P_market)
        let amountToAdd = Math.ceil(
            state.volume * (state.avgPrice - P_target) / (P_target - market.last)
        );

        // Sanity checks
        if (isNaN(amountToAdd) || amountToAdd <= 0) amountToAdd = 1;
        amountToAdd = Math.min(amountToAdd, config.maxSyncBatch); // Cap it for safety

        isProcessing = true;
        market.status = `Syncing: Adding ${amountToAdd} to ${state.direction}`;
        console.log(`⚖️ PRECISE SYNC: Adding ${amountToAdd} contracts to ${state.direction} to match ROI magnitude ${targetRoiMag.toFixed(2)}%`);

        await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, 
            volume: amountToAdd, 
            direction: state.direction, 
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
            if (msg.tick) {
                market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
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
    <meta charset="UTF-8"><title>Precise Mirror Sync</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { font-family: sans-serif; background: #09090b; color: #fafafa; }</style>
</head>
<body class="p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-bold">PRECISE<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-xs text-zinc-500 uppercase">Status</p></div>
            <div class="text-right font-mono"><p class="text-xs text-zinc-500">MARKET</p><p id="markPrice" class="text-xl text-indigo-400">0.00000000</p></div>
        </div>
        <div class="grid grid-cols-2 gap-6">
            <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                <div class="flex justify-between"><span class="text-emerald-500 font-bold">LONG</span><span id="longRoi">0%</span></div>
                <div id="longUsdt" class="text-xl font-mono mt-2">$0.00</div>
                <div id="longVol" class="text-xs text-zinc-500 mt-1">Size: 0</div>
            </div>
            <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800">
                <div class="flex justify-between"><span class="text-rose-500 font-bold">SHORT</span><span id="shortRoi">0%</span></div>
                <div id="shortUsdt" class="text-xl font-mono mt-2">$0.00</div>
                <div id="shortVol" class="text-xs text-zinc-500 mt-1">Size: 0</div>
            </div>
        </div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
            document.getElementById('botStatus').innerText = d.market.status;
            d.accounts.forEach(a => {
                const p = a.direction === 'buy' ? 'long' : 'short';
                document.getElementById(p + 'Roi').innerText = a.roi.toFixed(2) + '%';
                document.getElementById(p + 'Usdt').innerText = '$' + a.unrealizedUsdt.toFixed(6);
                document.getElementById(p + 'Vol').innerText = 'Size: ' + a.volume;
            });
        }, 1000);
    </script>
</body>
</html>`);
});

startWS(); setInterval(sync, 2000); setInterval(tradeLoop, 3000); app.listen(config.port, '0.0.0.0');
