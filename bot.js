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
    orderSize: 100,               
    contractSize: 0,
    pnlTolerance: 0.00005,        
    roiTolerance: 0.01,           
    maxSpreadPct: 0.20,           
    profitRoiTarget: parseFloat(process.env.PROFIT_ROI_TARGET) || 0.40               
};

// ==================== GLOBAL STATE (AI ENHANCED) ====================
let market = { 
    last: 0, 
    spreadPct: 0, 
    status: 'initializing', 
    efficiency: 0,
    sentiment: 'NEUTRAL', 
    aggression: 1.0,      
    priceHistory: []      
};
let accountStates = {};
let tradeHistory = []; 
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

// ==================== AI ENGINE & CORE LOGIC ====================

function updateAI() {
    if (market.priceHistory.length < 5) return;
    const startPrice = market.priceHistory[0];
    const endPrice = market.last;
    const change = endPrice - startPrice;
    
    if (change > 0) market.sentiment = 'BULLISH';
    else if (change < 0) market.sentiment = 'BEARISH';
    else market.sentiment = 'STABLE';

    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const roiSum = s1.roi + s2.roi;

    // AI Scaling: The worse the sum, the harder it trades
    market.aggression = Math.min(3.5, 1.0 + (Math.abs(roiSum) * 5));
}

async function restSync() {
    if (triggeredExit) return; 
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.status === 'ok' && res.data) {
            const pos = res.data.find(p => p.direction === state.direction);
            if (pos) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = Math.floor(parseFloat(pos.volume));
                state.roi = parseFloat(pos.profit_rate) * 100;
                state.unrealizedUsdt = parseFloat(pos.profit);
            } else { state.avgPrice = 0; state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data) {
            state.wallet = parseFloat(accRes.data[0].margin_balance);
        }
    }
}

function tradeLoop() {
    if (isProcessing || triggeredExit || market.last === 0) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    if (s1.volume < 1 || s2.volume < 1) {
        isProcessing = true;
        Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' })
        ]).finally(() => { setTimeout(() => { isProcessing = false; }, 3000); });
        return;
    }

    const roiSum = s1.roi + s2.roi;
    const netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;
    const aiAddSize = Math.floor(Math.max(30, (Math.max(s1.volume, s2.volume) * 0.12)) * market.aggression);

    let targetAcc = null;

    if (roiSum < -config.roiTolerance) {
        market.status = `AI: SYNCING ROI (${market.sentiment})`;
        if (market.sentiment === 'BULLISH') targetAcc = config.accounts[0];
        else if (market.sentiment === 'BEARISH') targetAcc = config.accounts[1];
        else targetAcc = (s1.roi < s2.roi) ? config.accounts[0] : config.accounts[1];
    } 
    else if (netPnL < -config.pnlTolerance) {
        market.status = "AI: REPAIRING PNL";
        targetAcc = (s1.unrealizedUsdt < s2.unrealizedUsdt) ? config.accounts[0] : config.accounts[1];
    }
    else if ((netPnL / (s1.wallet + s2.wallet)) * 100 >= config.profitRoiTarget) {
        closeAll();
        return;
    } else {
        market.status = "AI: OPTIMIZED";
    }

    if (targetAcc) {
        isProcessing = true;
        htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: aiAddSize, direction: accountStates[targetAcc.accountId].direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        }).finally(() => { setTimeout(() => { isProcessing = false; }, 2500); });
    }
}

async function closeAll() {
    if (triggeredExit) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    tradeHistory.unshift({ time: new Date().toLocaleTimeString(), longEntry: s1.avgPrice, shortEntry: s2.avgPrice, netPnl: s1.unrealizedUsdt + s2.unrealizedUsdt });
    triggeredExit = true;
    market.status = "AI: EXITING PROFIT";
    config.accounts.forEach(acc => {
        htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: accountStates[acc.accountId].volume, direction: accountStates[acc.accountId].direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' });
    });
    setTimeout(() => { triggeredExit = false; isProcessing = false; }, 10000);
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
                market.priceHistory.push(market.last);
                if (market.priceHistory.length > 20) market.priceHistory.shift();
                updateAI(); 
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), history: tradeHistory }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({ status: 'ok' }); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>AtomicSync AI Turbo</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<style>body{font-family:'Plus Jakarta Sans',sans-serif;background:#040405;color:#fafafa;}.glass{background:rgba(10,10,12,0.95);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-4 md:p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-center mb-10">
        <div><h1 class="text-2xl font-black text-white italic">AtomicSync<span class="text-indigo-500">AI-Turbo</span></h1><p id="botStatus" class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">ANALYZING...</p></div>
        <div class="flex gap-10 text-right font-mono text-xs">
            <div><p class="text-zinc-600 font-bold uppercase">ROI Sum</p><p id="roiSum" class="text-lg font-bold">0.00%</p></div>
            <div><p class="text-zinc-600 font-bold uppercase">AI Sentiment</p><p id="sentiment" class="text-lg font-bold text-indigo-400">NEUTRAL</p></div>
            <div><p class="text-zinc-600 font-bold uppercase">Price</p><p id="markPrice" class="text-lg font-bold text-white">0.00000000</p></div>
        </div>
    </div>
    <div class="glass rounded-[3rem] p-10 mb-8 relative text-center border-t border-indigo-500/20">
        <button onclick="fetch('/api/close',{method:'POST'})" class="absolute top-8 right-8 bg-rose-600 text-white text-[10px] font-black px-6 py-3 rounded-full">FORCE EXIT</button>
        <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Net Mirror PnL</p>
        <h2 id="netProfit" class="text-7xl font-black mb-1 font-mono">+$0.00000000</h2>
        <p id="netRoi" class="text-md font-bold text-indigo-500/60 font-mono tracking-widest uppercase">MIRROR ROI: 0.0000%</p>
    </div>
    <div class="grid md:grid-cols-2 gap-8 mb-10 font-mono">
        <div class="glass rounded-[2.5rem] p-8 border-l-4 border-emerald-500">
            <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-emerald-500 italic">Long Account</span><span id="longRoi" class="text-2xl font-black text-emerald-400">0.00%</span></div>
            <p id="longUsdt" class="text-sm font-bold text-white">0 / $0.0000</p>
        </div>
        <div class="glass rounded-[2.5rem] p-8 border-l-4 border-rose-500">
            <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-rose-500 italic">Short Account</span><span id="shortRoi" class="text-2xl font-black text-rose-400">0.00%</span></div>
            <p id="shortUsdt" class="text-sm font-bold text-white">0 / $0.0000</p>
        </div>
    </div>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
        document.getElementById('botStatus').innerText = d.market.status;
        document.getElementById('sentiment').innerText = d.market.sentiment;
        let tP = 0, sumRoi = 0, tW = 0;
        d.accounts.forEach(a => {
            const prefix = a.direction === 'buy' ? 'long' : 'short';
            tP += a.unrealizedUsdt; sumRoi += a.roi; tW += a.wallet;
            document.getElementById(prefix + 'Roi').innerText = a.roi.toFixed(2) + '%';
            document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(4);
        });
        const netRoi = tW > 0 ? (tP / tW) * 100 : 0;
        document.getElementById('roiSum').innerText = sumRoi.toFixed(2) + '%';
        document.getElementById('roiSum').className = 'text-lg font-bold ' + (Math.abs(sumRoi) < 0.05 ? 'text-emerald-400' : 'text-rose-500');
        document.getElementById('netProfit').innerText = (tP >= 0 ? '+' : '') + tP.toFixed(8);
        document.getElementById('netRoi').innerText = 'MIRROR ROI: ' + (netRoi >= 0 ? '+' : '') + netRoi.toFixed(4) + '%';
        document.getElementById('netProfit').className = 'text-7xl font-black mb-1 font-mono ' + (tP >= 0 ? 'text-emerald-400' : 'text-rose-500');
    } catch(e) {}
}, 500);
</script></body></html>`);
});

startWS(); setInterval(restSync, 2000); setInterval(tradeLoop, 2500); app.listen(config.port, '0.0.0.0');
