require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    initialBalance: { type: Number, default: 0 },
    storedRealizedProfit: { type: Number, default: 0 },
    storedProfitPct: { type: Number, default: 0 },
    startTime: { type: Number, default: Date.now() }
});
const BotModel = mongoose.model('BotConfig_V35', BotSchema);

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

let botState = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    currentPrice: 0,
    avgPrice: 0,
    roi: 0, 
    realizedProfit: 0,
    profitPct: 0,      
    walletBalance: 0,  
    initialBalance: 0, 
    maxSafeBase: 0,
    safetyOrdersFilled: 0,
    distToNext: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 }, 
    settings: {
        baseOrder: 0, 
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.5, 
        maxSteps: 10
    }
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        const [posRes, accRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol }),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' })
        ]);

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                botState.walletBalance = equity - unrealized;
                
                // LOAD INITIAL BALANCE FROM DB
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    const saved = await BotModel.findOne({ id: "htx_martingale" });
                    if (saved && saved.initialBalance > 0) {
                        botState.initialBalance = saved.initialBalance;
                        botState.startTime = saved.startTime;
                    } else {
                        botState.initialBalance = botState.walletBalance;
                        botState.startTime = Date.now();
                        await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime }, { upsert: true });
                    }
                }
            }
        }

        // PROFIT & COMPOUND MATH
        botState.realizedProfit = botState.walletBalance - botState.initialBalance;
        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;

        const elapsedDays = (Date.now() - botState.startTime) / (1000 * 60 * 60 * 24);
        if (elapsedDays > 0.001 && botState.walletBalance > botState.initialBalance) {
            const dgr = Math.pow((botState.walletBalance / botState.initialBalance), (1 / elapsedDays)) - 1;
            botState.estimates.dgr = dgr * 100;
            botState.estimates.hr = botState.realizedProfit / (elapsedDays * 24);
            botState.estimates.day = botState.walletBalance * dgr;
            botState.estimates.week = (botState.walletBalance * Math.pow((1 + dgr), 7)) - botState.walletBalance;
            botState.estimates.month = (botState.walletBalance * Math.pow((1 + dgr), 30)) - botState.walletBalance;
        }

        // AUTO-SCALING BASE ORDER
        if (botState.currentPrice > 0 && botState.walletBalance > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
            botState.maxSafeBase = Math.floor(rawBase * 0.85);
            botState.settings.baseOrder = botState.maxSafeBase;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);

            if (botState.roi >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: pos.volume, direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
            }
        } else if (botState.maxSafeBase > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== STARTUP ====================
async function boot() {
    const data = await BotModel.findOne({ id: "htx_martingale" });
    if (data) {
        botState.initialBalance = data.initialBalance || 0;
        botState.startTime = data.startTime || Date.now();
    }
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
                    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
                } catch (e) {}
            }
        });
    });
    setInterval(runLogic, 3000);
}

// ==================== UI (CLEAN WHITE DESIGN) ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Trading Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #f8fafc; color: #1e293b; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 1.25rem; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }
        .projection-card { background: white; border: 1px solid #e2e8f0; border-radius: 1.5rem; padding: 2rem; position: relative; overflow: hidden; }
        .projection-card::after { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: #3b82f6; }
    </style>
</head>
<body class="p-6 md:p-12">
    <div class="max-w-6xl mx-auto">
        
        <!-- Header -->
        <div class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
            <div>
                <h1 class="text-2xl font-extrabold text-slate-900 tracking-tight">HTX COMPOUNDER <span class="text-blue-600 font-black">v35</span></h1>
                <p class="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">${config.symbol} • ${config.leverage}X Leverage</p>
            </div>
            <div class="flex items-center gap-8 bg-white border border-slate-200 px-6 py-4 rounded-2xl shadow-sm">
                <div class="text-right">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">Daily Growth (DGR)</p>
                    <p id="dgrText" class="text-xl font-extrabold text-blue-600 mono">0.00%</p>
                </div>
                <div class="flex items-center gap-2">
                    <div class="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse"></div>
                    <span class="text-xs font-bold uppercase text-slate-500">Live</span>
                </div>
            </div>
        </div>

        <!-- Profit Summary Grid -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div class="stat-card">
                <p class="text-[11px] font-bold text-slate-400 uppercase mb-2">Net Profit</p>
                <p id="p1" class="text-2xl font-bold text-green-600 mono">$0.0000</p>
            </div>
            <div class="stat-card">
                <p class="text-[11px] font-bold text-slate-400 uppercase mb-2">Total Gain</p>
                <p id="p2" class="text-2xl font-bold text-green-600 mono">0.00%</p>
            </div>
            <div class="stat-card">
                <p class="text-[11px] font-bold text-slate-400 uppercase mb-2">Open Position ROI</p>
                <p id="roi" class="text-2xl font-bold text-slate-300 mono">0.00%</p>
            </div>
            <div class="stat-card bg-slate-900 border-none shadow-xl shadow-slate-200">
                <p class="text-[11px] font-bold text-slate-400 uppercase mb-2">Wallet Balance</p>
                <p id="bal" class="text-2xl font-bold text-white mono">$0.00</p>
            </div>
        </div>

        <!-- Compounding Projections -->
        <h2 class="text-[11px] font-bold text-slate-400 uppercase mb-4 tracking-widest px-1">Growth Forecast (100% Reinvestment)</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            <div class="projection-card">
                <p class="text-[11px] font-bold text-blue-600 uppercase mb-3">Expected Next 24H</p>
                <p id="estDay" class="text-4xl font-bold text-slate-900 mono">$0.00</p>
                <p class="text-[10px] text-slate-400 mt-4 font-medium uppercase">Linear performance avg.</p>
            </div>
            <div class="projection-card border-blue-200">
                <p class="text-[11px] font-bold text-slate-500 uppercase mb-3">Projected 7 Days</p>
                <p id="estWeek" class="text-4xl font-bold text-slate-900 mono">$0.00</p>
                <p class="text-[10px] text-slate-400 mt-4 font-medium uppercase">Compounded estimates</p>
            </div>
            <div class="projection-card">
                <p class="text-[11px] font-bold text-slate-500 uppercase mb-3">Projected 30 Days</p>
                <p id="estMonth" class="text-4xl font-bold text-slate-900 mono">$0.00</p>
                <p class="text-[10px] text-slate-400 mt-4 font-medium uppercase">Net gain target</p>
            </div>
        </div>

        <!-- Risk Bar -->
        <div class="stat-card p-8 mb-10">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[11px] font-bold text-slate-400 uppercase mb-1">Martingale Progress</p>
                    <p id="stepText" class="text-5xl font-bold text-slate-900 mono">0 / 10</p>
                </div>
                <div class="text-right">
                    <p class="text-[11px] font-bold text-slate-400 uppercase mb-1">Distance to Next Order</p>
                    <p id="distText" class="text-5xl font-bold text-orange-500 mono">0.00%</p>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-4 overflow-hidden">
                <div id="progressBar" class="bg-blue-600 h-full transition-all duration-1000 w-0"></div>
            </div>
        </div>

        <!-- Footer -->
        <div class="flex flex-col md:flex-row justify-between items-center text-slate-400 gap-4">
            <div class="text-[10px] font-bold uppercase tracking-wider">
                Price: <span id="curPrice" class="text-slate-900 mono ml-1">0.00000000</span>
            </div>
            <div class="flex gap-8">
                <div class="text-[10px] font-bold uppercase tracking-wider">Profit/Hr: <span id="estHr" class="text-slate-900 mono ml-1">$0.00</span></div>
                <button onclick="resetStats()" class="text-[10px] font-bold uppercase text-red-400 hover:text-red-600 transition-colors">Reset Session Stats</button>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-2xl font-bold mono ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
                
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(2) + '%';
                
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);

                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';

                const pct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = pct + '%';
                if(pct > 80) bar.className = "bg-red-500 h-full transition-all duration-1000";
                else if(pct > 50) bar.className = "bg-orange-500 h-full transition-all duration-1000";
                else bar.className = "bg-blue-600 h-full transition-all duration-1000";
            } catch (e) {}
        }
        async function resetStats() { if(confirm("This will clear session history and reset projections. Continue?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); update();
    </script>
</body>
</html>`);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.walletBalance; 
    botState.startTime = Date.now();
    botState.realizedProfit = 0; botState.profitPct = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, boot);
