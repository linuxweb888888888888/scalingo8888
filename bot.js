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
    symbol: (process.env.SYMBOL || 'FIL-USDT').toUpperCase(),
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
    maxVolGap: 1000               
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;
let triggeredExit = false; 

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
        if (res.data.status !== 'ok') {
            console.log(`❌ [Acc ${account.accountId}] Error: ${res.data['err_msg'] || JSON.stringify(res.data)}`);
        }
        return res.data;
    } catch (e) { 
        console.log(`❌ [Acc ${account.accountId}] Request Failed: ${e.message}`);
        return { status: 'error' }; 
    }
}

// ==================== CORE LOGIC ====================

async function restSync() {
    if (triggeredExit) return; 
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
                state.roi = parseFloat(pos.profit_rate) * 100;
                state.unrealizedUsdt = parseFloat(pos.profit);
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

function instantCheck() {
    if (triggeredExit || market.last === 0 || config.contractSize === 0) return;

    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    if (s1.volume < 1 || s2.volume < 1) return;

    const side1 = s1.direction === 'buy' ? 1 : -1;
    const side2 = s2.direction === 'buy' ? 1 : -1;
    const p1 = (market.last - s1.avgPrice) * s1.volume * side1 * config.contractSize;
    const p2 = (market.last - s2.avgPrice) * s2.volume * side2 * config.contractSize;
    const currentPnL = p1 + p2;

    if (currentPnL > 0.00000001) {
        triggeredExit = true; 
        console.log(`🚀 GREEN DETECTED ($${currentPnL.toFixed(8)}). EXECUTING FORCE CLOSE.`);
        closeAll();
    }
}

function tradeLoop() {
    if (isProcessing || triggeredExit || market.last === 0) return;
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

    let targetAcc = null;
    if (!isMirrored) {
        market.status = "Sign Recovery...";
        targetAcc = (roi1Mag < roi2Mag) ? config.accounts[0] : config.accounts[1];
    } else if (syncProgress > 95) {
        if ((s1.unrealizedUsdt + s2.unrealizedUsdt) <= 0) {
            market.status = "Profit Push...";
            targetAcc = (s1.roi > s2.roi) ? config.accounts[0] : config.accounts[1];
        }
    } else if (Math.abs(roi1Mag - roi2Mag) > config.roiThreshold) {
        market.status = "Magnitude Sync...";
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
    triggeredExit = true;
    market.status = "CLOSE SENT: WAITING CONFIRMATION";
    
    // Process accounts concurrently but individually
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const closeVol = Math.floor(state.volume); // Ensure it's an integer
        
        if (closeVol > 0) {
            console.log(`📡 Sending Close for Acc ${acc.accountId}: ${closeVol} contracts ${state.direction === 'buy' ? 'SELL' : 'BUY'}`);
            
            htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: closeVol, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', 
                lever_rate: config.leverage, 
                order_price_type: 'lightning' // AGGRESSIVE CLOSE
            }).then(res => {
                if (res.status === 'ok') {
                    console.log(`✅ Acc ${acc.accountId} closed successfully.`);
                    state.volume = 0; // Clear local state immediately
                }
            });
        }
    }

    // Heavy cooldown to allow exchange to settle balances
    setTimeout(() => { triggeredExit = false; isProcessing = false; }, 30000);
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
    <meta charset="UTF-8"><title>AtomicSync Pro | FIL</title>
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
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white uppercase">Atomic<span class="text-indigo-500">Sync</span> FIL</h1><p id="botStatus" class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Active</p></div>
            <div class="flex gap-10 text-right">
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">FIL Price</p><p id="markPrice" class="text-xl font-mono font-bold text-indigo-400">0.0000</p></div>
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Growth</p><p id="totalRealized" class="text-xl font-mono font-bold text-emerald-400">+$0.00</p></div>
            </div>
        </div>
        <div class="glass rounded-[2.5rem] p-8 mb-8 relative overflow-hidden border-indigo-500/20 text-center">
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Net Exit Profit (Mirror Delta)</p>
            <h2 id="netProfit" class="text-6xl font-black mb-4 font-mono">+$0.0000</h2>
            <div class="inline-flex items-center gap-2 bg-zinc-900 px-4 py-2 rounded-full border border-zinc-800">
                <span class="text-[10px] font-bold text-zinc-500 uppercase">Mirroring Goal:</span><span id="syncPct" class="text-xs font-mono font-bold text-indigo-400">0%</span>
            </div>
        </div>
        <div class="grid md:grid-cols-2 gap-6">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-emerald-500 uppercase tracking-widest">Long Side (Acc 1)</span><span id="longRoi" class="text-xl font-black text-emerald-400">0.00%</span></div>
                <div class="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden mb-4"><div id="longBar" class="roi-bar bg-emerald-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-xs text-zinc-500 uppercase font-bold">Vol / PnL</span><span id="longUsdt" class="text-sm font-mono font-bold text-white">0 / $0.0000</span></div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-4"><span class="text-xs font-bold text-rose-500 uppercase tracking-widest">Short Side (Acc 2)</span><span id="shortRoi" class="text-xl font-black text-rose-400">0.00%</span></div>
                <div class="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden mb-4"><div id="shortBar" class="roi-bar bg-rose-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-xs text-zinc-500 uppercase font-bold">Vol / PnL</span><span id="shortUsdt" class="text-sm font-mono font-bold text-white">0 / $0.0000</span></div>
            </div>
        </div>
    </div>
    <script>
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(4);
                document.getElementById('botStatus').innerText = d.market.status;
                let tP = 0, tR = 0, rois = [];
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    rois.push(a.roi); tP += a.unrealizedUsdt; tR += a.realizedProfit;
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(4);
                    document.getElementById(prefix + 'Bar').style.width = Math.min(100, Math.abs(a.roi) * 10) + '%';
                });
                const sScore = (rois[0] * rois[1] < 0) ? (Math.min(Math.abs(rois[0]), Math.abs(rois[1])) / Math.max(Math.abs(rois[0]), Math.abs(rois[1]))) * 100 : 0;
                document.getElementById('syncPct').innerText = (isNaN(sScore) ? 0 : sScore.toFixed(1)) + '%';
                document.getElementById('totalRealized').innerText = (tR >= 0 ? '+' : '') + '$' + tR.toFixed(4);
                document.getElementById('netProfit').innerText = (tP >= 0 ? '+' : '') + tP.toFixed(4);
                document.getElementById('netProfit').className = 'text-6xl font-black mb-4 font-mono ' + (tP > 0 ? 'text-emerald-400' : 'text-zinc-400');
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
