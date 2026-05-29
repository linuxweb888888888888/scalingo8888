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
    spreadThreshold: 0.05,        
    initialOrderSize: 5,         // Open exactly 5
    reductionTriggerRoi: -2.0,   // Trigger at -2%
    reductionAmount: 2           // Close 2 contracts
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'connecting...', totalEquity: 0, equityProfit: 0 };
let initialTotalEquity = 0; 
let accountStates = {};
let isProcessing = false;

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, wallet: 0
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
    let totalPnl = 0;
    let currentTotalWallet = 0;

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

                // STRATEGY: IF ROI <= -2% AND VOLUME IS 5, CLOSE 2 CONTRACTS
                if (state.roi <= config.reductionTriggerRoi && state.volume >= config.initialOrderSize && !isProcessing) {
                    market.status = `Reducing ${state.direction} risk (-2% hit)`;
                    reduceExposure(acc, state);
                }
            } else { state.avgPrice = 0; state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }

        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data) {
            state.wallet = parseFloat(accRes.data[0].margin_balance);
        }
        totalPnl += state.unrealizedUsdt;
        currentTotalWallet += state.wallet;
    }
    
    if (initialTotalEquity === 0 && currentTotalWallet > 0) initialTotalEquity = currentTotalWallet;
    market.totalEquity = currentTotalWallet;
    market.equityProfit = initialTotalEquity > 0 ? (currentTotalWallet - initialTotalEquity) : 0;

    // AUTO-OPEN LOGIC
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    if (s1.volume === 0 && s2.volume === 0 && !isProcessing) {
        if (market.spreadPct > 0 && market.spreadPct <= config.spreadThreshold) {
            autoOpen();
        } else {
            market.status = `Wait for Spread < ${config.spreadThreshold}%`;
        }
    }
}

async function autoOpen() {
    isProcessing = true;
    market.status = "Opening 5:5 Positions...";
    await Promise.all([
        htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.initialOrderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }),
        htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.initialOrderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' })
    ]);
    setTimeout(() => { isProcessing = false; }, 3000);
}

async function reduceExposure(acc, state) {
    isProcessing = true;
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, 
        volume: config.reductionAmount, 
        direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', 
        lever_rate: config.leverage, 
        order_price_type: 'optimal_5' 
    });
    setTimeout(() => { isProcessing = false; }, 5000);
}

async function addManual(index) {
    const acc = config.accounts[index];
    const state = accountStates[acc.accountId];
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: 1, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' });
}

async function closeAll() {
    isProcessing = true;
    market.status = "Liquidating...";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        }
    }
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
            if (msg.tick) {
                market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
                market.spreadPct = ((msg.tick.ask[0] - msg.tick.bid[0]) / msg.tick.bid[0]) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/add/:id', async (req, res) => { await addManual(req.params.id); res.json({status: 'ok'}); });
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>ManualSync 5.0</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-end mb-10">
        <div><h1 class="text-xl font-bold text-white uppercase tracking-tighter">ManualSync <span class="text-indigo-500">PRO</span></h1><p id="botStatus" class="text-xs text-zinc-500 font-bold uppercase"></p></div>
        <div class="flex gap-8 text-right">
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Start Profit</p><p id="equityProfit" class="font-mono text-emerald-400 font-bold text-right">+$0.00000000</p></div>
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Total Equity</p><p id="totalEquity" class="font-mono text-white font-bold text-right">$0.00000000</p></div>
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Spread / Price</p><p class="font-mono text-right"><span id="spread" class="text-amber-500 mr-4">0.000%</span><span id="price" class="text-white">0.00000000</span></p></div>
        </div>
    </div>
    <div class="glass rounded-3xl p-8 mb-6 text-center border-t border-indigo-500/20">
        <p class="text-[10px] text-zinc-500 font-bold uppercase mb-2">Net Mirror PnL</p>
        <h2 id="netPnl" class="text-5xl font-mono font-bold mb-2">$0.00000000</h2>
        <div class="flex justify-center gap-6 text-xs font-mono">
            <p>ROI SUM: <span id="roiSum" class="text-white">0.00%</span></p>
            <p>MIRROR ROI: <span id="mirrorRoi" class="text-indigo-400">0.00%</span></p>
        </div>
    </div>
    <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="glass rounded-2xl p-6">
            <div class="flex justify-between items-start mb-4"><p class="text-[10px] font-bold text-emerald-500 uppercase">Long Account</p><button onclick="add(0)" class="bg-emerald-500/20 text-emerald-500 px-3 py-1 rounded-md text-xs font-bold hover:bg-emerald-500 hover:text-white">+ 1</button></div>
            <p id="longRoi" class="text-2xl font-mono font-bold mb-1">0.00%</p><p id="longStats" class="text-[10px] text-zinc-500 font-mono italic">Vol: 0 | PnL: $0.00000000</p>
        </div>
        <div class="glass rounded-2xl p-6">
            <div class="flex justify-between items-start mb-4"><p class="text-[10px] font-bold text-rose-500 uppercase">Short Account</p><button onclick="add(1)" class="bg-rose-500/20 text-rose-500 px-3 py-1 rounded-md text-xs font-bold hover:bg-rose-500 hover:text-white">+ 1</button></div>
            <p id="shortRoi" class="text-2xl font-mono font-bold mb-1">0.00%</p><p id="shortStats" class="text-[10px] text-zinc-500 font-mono italic">Vol: 0 | PnL: $0.00000000</p>
        </div>
    </div>
    <button onclick="closeAll()" class="w-full py-4 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs uppercase tracking-widest transition-all">Emergency Liquidate All</button>
</div>
<script>
async function add(id){ await fetch('/api/add/'+id,{method:'POST'}); }
async function closeAll(){ if(confirm("Liquidate all?")) await fetch('/api/close',{method:'POST'}); }
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('spread').innerText = d.market.spreadPct.toFixed(3) + '%';
        document.getElementById('botStatus').innerText = d.market.status;
        document.getElementById('totalEquity').innerText = '$' + d.market.totalEquity.toFixed(8);
        document.getElementById('equityProfit').innerText = (d.market.equityProfit >= 0 ? '+' : '') + '$' + d.market.equityProfit.toFixed(8);
        document.getElementById('equityProfit').className = 'font-mono font-bold ' + (d.market.equityProfit >= 0 ? 'text-emerald-400' : 'text-rose-500');
        let tP=0, tW=0, sumRoi=0;
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'long' : 'short';
            tP += a.unrealizedUsdt; tW += a.wallet; sumRoi += a.roi;
            document.getElementById(pre+'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Stats').innerText = 'Vol: '+a.volume+' | PnL: $'+a.unrealizedUsdt.toFixed(8);
            document.getElementById(pre+'Roi').className = 'text-2xl font-mono font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
        document.getElementById('netPnl').innerText = (tP>=0?'+':'') + '$' + tP.toFixed(8);
        document.getElementById('netPnl').className = 'text-5xl font-mono font-bold mb-2 ' + (tP>=0?'text-emerald-400':'text-rose-500');
        document.getElementById('roiSum').innerText = (sumRoi >= 0 ? '+' : '') + sumRoi.toFixed(2)+'%';
        document.getElementById('mirrorRoi').innerText = (tW > 0 ? (tP/tW*100) : 0).toFixed(4)+'%';
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

startWS(); setInterval(restSync, 2000); app.listen(config.port, '0.0.0.0');
