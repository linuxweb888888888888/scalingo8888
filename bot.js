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
                // STATIC BALANCE CALCULATION (Exactly as first pasted)
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
        } else if (botState.maxSafeBase > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }

        // STATIC GAIN CALCULATION
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
        botState.realizedProfit = data.storedRealizedProfit || 0;
        botState.profitPct = data.storedProfitPct || 0;
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

// ==================== UI (WHITE DESIGN) ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-slate-50">
<head>
    <title>HTX Compounder V33</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Roboto Mono', monospace; }
        .glass { background: white; border: 1px solid rgba(0, 0, 0, 0.08); box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
        .glow-blue { box-shadow: 0 10px 30px -5px rgba(59, 130, 246, 0.2); }
    </style>
</head>
<body class="text-slate-700 p-4 md:p-10">
    <div class="max-w-6xl mx-auto">
        
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-slate-900 text-2xl font-bold tracking-tighter">COMPOUND_BOT <span class="text-blue-600">v33</span></h1>
                <p class="text-[10px] text-slate-400 uppercase tracking-widest">${config.symbol} | ${config.leverage}X Leverage</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-blue-600 font-bold text-xl">0.00% DGR</p>
                <p class="text-[10px] text-slate-400 uppercase">Daily Growth Rate</p>
            </div>
        </div>

        <!-- STATS GRID -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Static Profit</p>
                <p id="p1" class="text-2xl text-emerald-600 font-bold">$0.00</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Static Gain</p>
                <p id="p2" class="text-2xl text-emerald-600 font-bold">0.00%</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Live Position ROI</p>
                <p id="roi" class="text-2xl text-slate-300 font-bold">0.00%</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Static Balance</p>
                <p id="bal" class="text-2xl text-slate-900 font-bold">$0.00</p>
            </div>
        </div>

        <!-- COMPOUNDING PROJECTIONS SECTION -->
        <h2 class="text-slate-400 text-[10px] font-bold uppercase mb-4 tracking-widest">Compounding Estimates</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            
            <div class="bg-blue-600 p-8 rounded-3xl glow-blue relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-10 text-4xl italic font-black text-white">24H</div>
                <p class="text-[10px] text-blue-100 font-bold uppercase mb-2">Next 24 Hours</p>
                <p id="estDay" class="text-4xl text-white font-bold">$0.00</p>
                <p class="text-[10px] text-blue-200 mt-4 font-bold uppercase">Estimated Earnings</p>
            </div>

            <div class="glass p-8 rounded-3xl relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-4xl italic font-black text-slate-900">7D</div>
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Next 7 Days</p>
                <p id="estWeek" class="text-4xl text-slate-900 font-bold">$0.00</p>
                <p class="text-[10px] text-slate-300 mt-4 font-bold uppercase">Compounded Growth</p>
            </div>

            <div class="glass p-8 rounded-3xl border-l-4 border-l-blue-600 relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-4xl italic font-black text-slate-900">30D</div>
                <p class="text-[10px] text-slate-400 font-bold uppercase mb-2">Next 30 Days</p>
                <p id="estMonth" class="text-4xl text-slate-900 font-bold">$0.00</p>
                <p class="text-[10px] text-slate-300 mt-4 font-bold uppercase">Projected Profit</p>
            </div>
        </div>

        <!-- RISK & PROGRESS -->
        <div class="glass p-8 rounded-3xl mb-8">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[10px] text-slate-400 uppercase mb-1">Safety Orders Filled</p>
                    <p id="stepText" class="text-5xl text-slate-900 font-bold">0 / 10</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-slate-400 uppercase mb-1">Next Step Distance</p>
                    <p id="distText" class="text-5xl text-orange-500 font-bold">0.00%</p>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-4 overflow-hidden">
                <div id="progressBar" class="bg-blue-600 h-full transition-all duration-1000" style="width: 0%"></div>
            </div>
        </div>

        <!-- FOOTER -->
        <div class="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase">
            <div>Avg Profit/Hr: <span id="estHr" class="text-slate-600 ml-1">$0.00</span></div>
            <div class="flex gap-6">
                <span>Price: <span id="curPrice" class="text-slate-600 ml-1">0.00</span></span>
                <button onclick="resetStats()" class="text-red-300 hover:text-red-600 transition-colors">Reset Session</button>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                // Static fields
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                
                // Live ROI field
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-2xl font-bold ' + (d.roi >= 0 ? (d.roi == 0 ? 'text-slate-300' : 'text-emerald-600') : 'text-red-500');
                
                document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(2) + '% DGR';
                
                // Estimates
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);

                // Risk
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = progressPct + '%';
                
                if(progressPct > 75) bar.className = 'bg-red-500 h-full transition-all duration-1000';
                else if(progressPct > 45) bar.className = 'bg-orange-500 h-full transition-all duration-1000';
                else bar.className = 'bg-blue-600 h-full transition-all duration-1000';

            } catch (e) {}
        }
        async function resetStats() { if(confirm("Reset Initial Balance?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); 
        update();
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
