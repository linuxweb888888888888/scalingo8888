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
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    initialBalance: { type: Number, default: 0 },
    storedRealizedProfit: { type: Number, default: 0 },
    storedProfitPct: { type: Number, default: 0 },
    startTime: { type: Number, default: Date.now() }
});
const BotModel = mongoose.model('BotConfig_V33', BotSchema);

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
        priceDrop: 0.12,      
        volumeMult: 1.25,     
        takeProfit: 1.2, 
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
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.startTime = Date.now();
                }
            }
        }

        // ==================== COMPOUNDING MATH ====================
        const elapsedDays = (Date.now() - botState.startTime) / (1000 * 60 * 60 * 24);
        if (elapsedDays > 0.001 && botState.walletBalance > botState.initialBalance) {
            const dgr = Math.pow((botState.walletBalance / botState.initialBalance), (1 / elapsedDays)) - 1;
            botState.estimates.dgr = dgr * 100;
            botState.estimates.hr = botState.realizedProfit / (elapsedDays * 24);
            botState.estimates.day = botState.walletBalance * dgr;
            botState.estimates.week = (botState.walletBalance * Math.pow((1 + dgr), 7)) - botState.walletBalance;
            botState.estimates.month = (botState.walletBalance * Math.pow((1 + dgr), 30)) - botState.walletBalance;
        }

        // Auto-scale base order
        if (botState.currentPrice > 0 && botState.walletBalance > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
            botState.maxSafeBase = Math.floor(rawBase * 0.80);
            botState.settings.baseOrder = Math.max(1, botState.maxSafeBase);
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);

            if (botState.roi >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: pos.volume,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
            }
        } else if (botState.settings.baseOrder > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }

        botState.realizedProfit = botState.walletBalance - botState.initialBalance;
        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;

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
    setInterval(runLogic, 3500);
}

// ==================== UI (WHITE DESIGN) ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-slate-50">
<head>
    <title>HTX Compounder V33</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        .mono { font-family: 'Roboto Mono', monospace; }
        .card-shadow { box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.05); }
        .stat-card { background: white; border: 1px solid #e2e8f0; }
        .projection-card { background: white; border: 1px solid #e2e8f0; transition: transform 0.2s; }
        .projection-card:hover { transform: translateY(-2px); }
    </style>
</head>
<body class="text-slate-900 p-4 md:p-10">
    <div class="max-w-6xl mx-auto">
        
        <!-- HEADER -->
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-slate-900 text-2xl font-extrabold tracking-tight">COMPOUND_BOT <span class="text-blue-600">v33</span></h1>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">${config.symbol} • ${config.leverage}X LEVERAGE</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-blue-600 font-black text-2xl">0.00% DGR</p>
                <p class="text-[10px] text-slate-400 font-bold uppercase">Daily Growth Rate</p>
            </div>
        </div>

        <!-- MAIN STATS GRID -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            <div class="stat-card p-6 rounded-2xl card-shadow">
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Net Profit</p>
                <p id="p1" class="text-3xl text-emerald-600 font-black mono">$0.00</p>
            </div>
            <div class="stat-card p-6 rounded-2xl card-shadow">
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Total Gain</p>
                <p id="p2" class="text-3xl text-emerald-600 font-black mono">0.00%</p>
            </div>
            <div class="stat-card p-6 rounded-2xl card-shadow">
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Open Position ROI</p>
                <p id="roi" class="text-3xl text-slate-300 font-black mono">0.00%</p>
            </div>
            <div class="stat-card p-6 rounded-2xl card-shadow">
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Current Balance</p>
                <p id="bal" class="text-3xl text-slate-900 font-black mono">$0.00</p>
            </div>
        </div>

        <!-- COMPOUNDING SECTION -->
        <div class="mb-4 flex items-center gap-3">
            <h2 class="text-slate-400 text-[10px] font-black uppercase tracking-widest">Earnings Projections</h2>
            <div class="h-px flex-1 bg-slate-200"></div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            <div class="bg-blue-600 p-8 rounded-3xl shadow-xl shadow-blue-100 relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-10 text-5xl italic font-black text-white uppercase">24h</div>
                <p class="text-[10px] text-blue-100 font-bold uppercase mb-2 tracking-widest">Expected Next 24H</p>
                <p id="estDay" class="text-4xl text-white font-black mono">$0.00</p>
                <p class="text-[10px] text-blue-200 mt-4 font-medium italic">Based on current performance</p>
            </div>

            <div class="projection-card p-8 rounded-3xl shadow-sm relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-5xl italic font-black text-slate-900 uppercase">7d</div>
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2 tracking-widest">Next 7 Days</p>
                <p id="estWeek" class="text-4xl text-slate-900 font-black mono">$0.00</p>
                <p class="text-[10px] text-slate-300 mt-4 font-bold uppercase">Compounded Growth</p>
            </div>

            <div class="projection-card p-8 rounded-3xl shadow-sm border-b-4 border-b-blue-600 relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-5xl italic font-black text-slate-900 uppercase">30d</div>
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2 tracking-widest">Next 30 Days</p>
                <p id="estMonth" class="text-4xl text-slate-900 font-black mono">$0.00</p>
                <p class="text-[10px] text-slate-300 mt-4 font-bold uppercase">Projected 30 Day Profit</p>
            </div>
        </div>

        <!-- RISK & PROGRESS -->
        <div class="stat-card p-8 rounded-3xl card-shadow mb-8">
            <div class="flex flex-col md:flex-row justify-between items-end mb-6 gap-4">
                <div>
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-1">Safety Orders Filled</p>
                    <p id="stepText" class="text-5xl text-slate-900 font-black mono">0 / 10</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-1">Price Drop Distance</p>
                    <p id="distText" class="text-5xl text-orange-500 font-black mono">0.00%</p>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-5 overflow-hidden p-1">
                <div id="progressBar" class="bg-blue-600 h-full rounded-full transition-all duration-1000 shadow-sm" style="width: 0%"></div>
            </div>
        </div>

        <!-- FOOTER -->
        <div class="flex flex-col md:flex-row justify-between items-center text-[11px] font-bold text-slate-400 uppercase gap-4">
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                System Live • Avg Profit/Hr: <span id="estHr" class="text-slate-600 ml-1">$0.00</span>
            </div>
            <div class="flex gap-8 items-center">
                <span>Market Price: <span id="curPrice" class="text-slate-900 ml-1 mono">0.00</span></span>
                <button onclick="resetStats()" class="bg-slate-100 hover:bg-red-50 text-slate-400 hover:text-red-600 px-4 py-2 rounded-lg transition-all">Reset Session</button>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                if(d.roi > 0) roiEl.className = 'text-3xl font-black mono text-emerald-600';
                else if(d.roi < 0) roiEl.className = 'text-3xl font-black mono text-red-500';
                else roiEl.className = 'text-3xl font-black mono text-slate-300';
                
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(2) + '% DGR';
                
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);

                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = progressPct + '%';
                
                if(progressPct > 75) { bar.classList.remove('bg-blue-600', 'bg-orange-500'); bar.classList.add('bg-red-500'); }
                else if(progressPct > 45) { bar.classList.remove('bg-blue-600', 'bg-red-500'); bar.classList.add('bg-orange-500'); }
                else { bar.classList.remove('bg-red-500', 'bg-orange-500'); bar.classList.add('bg-blue-600'); }

            } catch (e) {}
        }
        async function resetStats() { if(confirm("This resets Initial Balance and Projections. Continue?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); 
        update();
    </script>
</body>
</html>`);
});

// ==================== API ROUTES ====================
app.get('/api/status', (req, res) => res.json(botState));

app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.walletBalance; 
    botState.startTime = Date.now();
    botState.realizedProfit = 0; 
    botState.profitPct = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, () => {
    console.log(`🚀 Server running on port ${config.port}`);
    boot();
});
