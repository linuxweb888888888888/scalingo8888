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
    // --- Trading Rules ---
    takeProfitPct: 1.5,
    stopLossPct: -5.0,
    orderVolume: 1 // Default volume per trade
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'Auto-Trading Active', totalEquity: 0, equityProfit: 0 };
let initialTotalEquity = 0;
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, wallet: 0, initialBalance: 0,
        lastAction: 'Initializing...'
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

// ==================== TRADING LOGIC ====================

async function tradeManager() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];

        // 1. Sync Position & Balance
        await syncAccountData(acc, state);

        // 2. Automated Logic
        if (state.volume === 0) {
            // AUTO OPEN: If no position, open based on designated direction
            console.log(`[Acc ${acc.accountId}] Opening auto-position: ${state.direction}`);
            state.lastAction = `Opening ${state.direction}...`;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: config.orderVolume, direction: state.direction, 
                offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
        } else {
            // AUTO EXIT: Check TP/SL
            if (state.roi >= config.takeProfitPct) {
                console.log(`[Acc ${acc.accountId}] TP Hit: ${state.roi}%`);
                state.lastAction = `Closing (TP ${state.roi.toFixed(2)}%)`;
                await closeAccountPosition(acc, state);
            } 
            else if (state.roi <= config.stopLossPct) {
                console.log(`[Acc ${acc.accountId}] SL Hit: ${state.roi}%`);
                state.lastAction = `Closing (SL ${state.roi.toFixed(2)}%)`;
                await closeAccountPosition(acc, state);
            }
        }
    }
}

async function syncAccountData(acc, state) {
    // Sync Positions
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

    // Sync Balance
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data) {
        state.wallet = parseFloat(accRes.data[0].margin_balance);
        if (state.initialBalance === 0) state.initialBalance = state.wallet;
    }
}

async function closeAccountPosition(acc, state) {
    const closeDirection = state.direction === 'buy' ? 'sell' : 'buy';
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, 
        direction: closeDirection, offset: 'close', 
        lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });
}

// ==================== WS & HELPERS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                const bid = msg.tick.bid[0]; const ask = msg.tick.ask[0];
                market.last = (bid + ask) / 2;
                market.spreadPct = ((ask - bid) / bid) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// Endpoints
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { 
    market.status = "Manual Liquidation...";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) await closeAccountPosition(acc, state);
    }
    res.json({status: 'ok'}); 
});

// UI Template (Identical but with TP/SL Indicator)
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Auto Hedge Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-end mb-10">
        <div><h1 class="text-xl font-bold text-white uppercase tracking-tighter">Hedge Bot <span class="text-indigo-500">AUTO</span></h1><p id="botStatus" class="text-xs text-zinc-500 font-bold uppercase"></p></div>
        <div class="flex gap-8 text-right">
            <div class="text-right"><p class="text-[10px] text-zinc-600 font-bold uppercase">Settings</p><p class="font-mono text-zinc-400 text-xs">TP: ${config.takeProfitPct}% | SL: ${config.stopLossPct}%</p></div>
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase text-right">Price</p><p id="price" class="font-mono text-white">0.00</p></div>
        </div>
    </div>
    <div class="glass rounded-3xl p-8 mb-6 text-center border-t border-indigo-500/20">
        <p class="text-[10px] text-zinc-500 font-bold uppercase mb-2">Combined PnL</p>
        <h2 id="netPnl" class="text-5xl font-mono font-bold mb-2">$0.00</h2>
        <p class="text-zinc-400 text-xs font-mono">NET ROI: <span id="mirrorRoi" class="text-indigo-400">0.00%</span></p>
    </div>
    <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-emerald-500 uppercase mb-4">Account 1 (Long)</p>
            <p id="longRoi" class="text-2xl font-mono font-bold mb-1">0.00%</p>
            <p id="longStats" class="text-[10px] text-zinc-500 font-mono italic">Syncing...</p>
        </div>
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-rose-500 uppercase mb-4">Account 2 (Short)</p>
            <p id="shortRoi" class="text-2xl font-mono font-bold mb-1">0.00%</p>
            <p id="shortStats" class="text-[10px] text-zinc-500 font-mono italic">Syncing...</p>
        </div>
    </div>
    <button onclick="closeAll()" class="w-full py-4 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs uppercase tracking-widest transition-all">Emergency Liquidate & Stop</button>
</div>
<script>
async function closeAll(){ if(confirm("Close all positions?")) await fetch('/api/close',{method:'POST'}); }
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('botStatus').innerText = d.market.status;
        
        let tP=0, tW=0;
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'long' : 'short';
            tP += a.unrealizedUsdt; tW += a.wallet;
            document.getElementById(pre+'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Stats').innerText = 'Vol: '+a.volume+' | Status: ' + a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-2xl font-mono font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
        document.getElementById('netPnl').innerText = (tP>=0?'+':'') + '$' + tP.toFixed(4);
        document.getElementById('netPnl').className = 'text-5xl font-mono font-bold mb-2 ' + (tP>=0?'text-emerald-400':'text-rose-500');
        document.getElementById('mirrorRoi').innerText = (tW > 0 ? (tP/tW*100) : 0).toFixed(4)+'%';
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

// Execution Loop
startWS(); 
setInterval(tradeManager, 3000); // Runs logic every 3 seconds
app.listen(config.port, '0.0.0.0');
