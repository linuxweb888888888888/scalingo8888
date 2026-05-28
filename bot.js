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
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 1.5,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 15.0,
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1,
    hedgeThreshold: 3.0, 
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, bid: 0, ask: 0, mark: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;
let totalTrades = 0;
let startTime = Date.now();

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0,
        roi: 0,
        volume: 0,
        wallet: 0,
        initialBalance: 0,
        profit: 0
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

// ==================== LOGIC ====================

async function sync() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.data) {
            const pos = res.data.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);
            if (pos) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = parseFloat(pos.volume);
                const price = market.mark || market.last;
                state.roi = state.direction === 'buy' 
                    ? ((price - state.avgPrice) / state.avgPrice) * 100 * config.leverage
                    : ((state.avgPrice - price) / state.avgPrice) * 100 * config.leverage;
            } else {
                state.volume = 0; state.roi = 0;
            }
        }
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const bal = parseFloat(accRes.data[0].margin_balance);
            if (state.initialBalance === 0) state.initialBalance = bal;
            state.wallet = bal;
            state.profit = bal - state.initialBalance;
        }
    }
}

async function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    if (long.volume === 0 && short.volume === 0) {
        market.status = 'searching';
        isProcessing = true;
        await Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            })
        ]);
        totalTrades++;
        setTimeout(() => { isProcessing = false; }, 2000);
    } else if (long.volume > 0 && short.volume > 0) {
        market.status = 'hedged';
        if (long.roi >= config.takeProfitPercent || short.roi >= config.takeProfitPercent) await closeAll();
        if (Math.abs(long.roi + short.roi) > config.hedgeThreshold) await closeAll();
    } else {
        market.status = 'imbalance';
        await closeAll();
    }
}

async function closeAll() {
    isProcessing = true;
    market.status = 'closing';
    await Promise.all(config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        return state.volume > 0 ? htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
        }) : Promise.resolve();
    }));
    setTimeout(() => { isProcessing = false; }, 2000);
}

// ==================== WS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'd1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) market.last = msg.tick.close;
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== WEB UI ====================
app.get('/api/status', (req, res) => {
    res.json({ market, accounts: Object.values(accountStates), totalTrades, uptime: Math.floor((Date.now() - startTime)/1000) });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Atomic Hedge Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #09090b; color: #fafafa; }
        .glass { background: rgba(24, 24, 27, 0.8); backdrop-filter: blur(12px); border: 1px solid rgba(63, 63, 70, 0.5); }
        .roi-bar { transition: width 0.5s ease-out; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-5xl mx-auto">
        <!-- Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
            <div>
                <h1 class="text-3xl font-extrabold tracking-tight text-white">ATOMIC<span class="text-indigo-500">HEDGE</span></h1>
                <div class="flex items-center gap-2 mt-1">
                    <span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span></span>
                    <p class="text-xs text-zinc-500 uppercase tracking-widest font-semibold" id="botStatus">System Live</p>
                </div>
            </div>
            <div class="glass px-6 py-3 rounded-2xl text-right">
                <p class="text-xs text-zinc-500 uppercase font-bold">Mark Price</p>
                <p class="text-2xl font-mono font-bold text-indigo-400" id="markPrice">0.00000000</p>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div class="glass p-4 rounded-2xl">
                <p class="text-zinc-500 text-xs font-bold uppercase">Total Profit</p>
                <p class="text-xl font-bold text-emerald-400" id="totalProfit">$0.00</p>
            </div>
            <div class="glass p-4 rounded-2xl">
                <p class="text-zinc-500 text-xs font-bold uppercase">Cycles</p>
                <p class="text-xl font-bold" id="totalTrades">0</p>
            </div>
            <div class="glass p-4 rounded-2xl">
                <p class="text-zinc-500 text-xs font-bold uppercase">Symbol</p>
                <p class="text-xl font-bold text-indigo-300">${config.symbol}</p>
            </div>
            <div class="glass p-4 rounded-2xl">
                <p class="text-zinc-500 text-xs font-bold uppercase">Uptime</p>
                <p class="text-xl font-bold font-mono text-zinc-300" id="uptime">0s</p>
            </div>
        </div>

        <!-- Position Cards -->
        <div class="grid md:grid-cols-2 gap-6" id="posContainer">
            <!-- Long Card -->
            <div class="glass rounded-3xl p-6 border-t-4 border-emerald-500">
                <div class="flex justify-between items-center mb-6">
                    <span class="bg-emerald-500/10 text-emerald-500 px-3 py-1 rounded-full text-xs font-bold uppercase">Long Position</span>
                    <span class="text-2xl font-black text-emerald-400" id="longRoi">0.00%</span>
                </div>
                <div class="space-y-4">
                    <div>
                        <div class="flex justify-between text-xs mb-1 text-zinc-400"><span>Progress to TP</span><span id="longTpText">0%</span></div>
                        <div class="w-full bg-zinc-800 h-2 rounded-full overflow-hidden"><div id="longBar" class="roi-bar bg-emerald-500 h-full" style="width: 0%"></div></div>
                    </div>
                    <div class="flex justify-between border-t border-zinc-800 pt-4"><span class="text-zinc-500 text-sm">Entry Price</span><span class="font-mono text-sm" id="longEntry">0.00</span></div>
                </div>
            </div>

            <!-- Short Card -->
            <div class="glass rounded-3xl p-6 border-t-4 border-rose-500">
                <div class="flex justify-between items-center mb-6">
                    <span class="bg-rose-500/10 text-rose-500 px-3 py-1 rounded-full text-xs font-bold uppercase">Short Position</span>
                    <span class="text-2xl font-black text-rose-400" id="shortRoi">0.00%</span>
                </div>
                <div class="space-y-4">
                    <div>
                        <div class="flex justify-between text-xs mb-1 text-zinc-400"><span>Progress to TP</span><span id="shortTpText">0%</span></div>
                        <div class="w-full bg-zinc-800 h-2 rounded-full overflow-hidden"><div id="shortBar" class="roi-bar bg-rose-500 h-full" style="width: 0%"></div></div>
                    </div>
                    <div class="flex justify-between border-t border-zinc-800 pt-4"><span class="text-zinc-500 text-sm">Entry Price</span><span class="font-mono text-sm" id="shortEntry">0.00</span></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const TP_TARGET = ${config.takeProfitPercent};
        async function refresh() {
            const r = await fetch('/api/status');
            const d = await r.json();
            
            document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
            document.getElementById('botStatus').innerText = d.market.status;
            document.getElementById('totalTrades').innerText = d.totalTrades;
            document.getElementById('uptime').innerText = d.uptime + 's';

            let totalP = 0;
            d.accounts.forEach(a => {
                totalP += a.profit;
                const isLong = a.direction === 'buy';
                const prefix = isLong ? 'long' : 'short';
                
                document.getElementById(prefix + 'Roi').innerText = a.roi.toFixed(2) + '%';
                document.getElementById(prefix + 'Entry').innerText = (a.avgPrice || 0).toFixed(8);
                
                // Update Bars
                const progress = Math.min(100, Math.max(0, (a.roi / TP_TARGET) * 100));
                document.getElementById(prefix + 'Bar').style.width = (a.volume > 0 ? progress : 0) + '%';
                document.getElementById(prefix + 'TpText').innerText = (a.volume > 0 ? progress.toFixed(0) : 0) + '%';
            });
            document.getElementById('totalProfit').innerText = '$' + totalP.toFixed(4);
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>`);
});

// ==================== START ====================
startWS();
setInterval(sync, 2000);
setInterval(tradeLoop, 3000);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🚀 ATOMIC HEDGER STARTED`);
    console.log(`🌍 Dashboard: http://localhost:${config.port}\n`);
});
