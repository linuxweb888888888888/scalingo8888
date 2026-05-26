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
const BotModel = mongoose.model('BotConfig_V32', BotSchema);

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
    totalContracts: 0,
    roi: 0, 
    realizedProfit: 0,
    profitPct: 0,      
    walletBalance: 0,  
    initialBalance: 0, 
    maxSafeBase: 0,
    safetyOrdersFilled: 0,
    distToNext: 0,
    estimates: { hr: 0, day: 0, month: 0, dgr: 0 }, 
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
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.startTime = Date.now();
                    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime }, { upsert: true });
                }
            }
        }

        // ==================== COMPOUNDING PROJECTIONS ====================
        const elapsedMs = Date.now() - botState.startTime;
        const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

        if (elapsedDays > 0.005 && botState.walletBalance > botState.initialBalance) {
            // 1. Calculate Daily Growth Rate (DGR) using CAGR formula
            // (Current / Initial) ^ (1 / days) - 1
            const dgr = Math.pow((botState.walletBalance / botState.initialBalance), (1 / elapsedDays)) - 1;
            botState.estimates.dgr = dgr * 100;

            // 2. Linear Hourly (Simple average for immediate feel)
            botState.estimates.hr = botState.realizedProfit / (elapsedDays * 24);

            // 3. Compounded Daily (What you will make in the NEXT 24 hours)
            botState.estimates.day = botState.walletBalance * dgr;

            // 4. Compounded Monthly (Balance in 30 days if growth continues)
            // Balance = P * (1 + r)^30
            const projectBal30d = botState.walletBalance * Math.pow((1 + dgr), 30);
            botState.estimates.month = projectBal30d - botState.walletBalance;
        }

        // BASE ORDER SCALING
        if (botState.currentPrice > 0 && botState.walletBalance > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
            botState.maxSafeBase = Math.floor(rawBase * 0.85);
            botState.settings.baseOrder = botState.maxSafeBase;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            botState.roi = parseFloat(pos.profit_rate) * 100;

            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);

            if (botState.roi >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
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

        // Sync local stats
        if (botState.initialBalance > 0) {
            botState.realizedProfit = botState.walletBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }

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

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Compounder V32</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@700&display=swap" rel="stylesheet">
</head>
<body class="bg-black text-white p-6 font-sans">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-xl font-bold tracking-tighter text-blue-500">COMPOUND BOT V32</h1>
            <div class="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-[10px] font-bold">ACTIVE</div>
        </div>

        <!-- Profit Summary -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800"><p class="text-[10px] text-zinc-500 uppercase">Realized Profit</p><p id="p1" class="text-xl font-mono text-green-400">$0.00</p></div>
            <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800"><p class="text-[10px] text-zinc-500 uppercase">Growth %</p><p id="p2" class="text-xl font-mono text-green-400">0.00%</p></div>
            <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800"><p class="text-[10px] text-zinc-500 uppercase">Live ROI</p><p id="roi" class="text-xl font-mono text-zinc-600">0.00%</p></div>
            <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800"><p class="text-[10px] text-zinc-500 uppercase">DGR Rate</p><p id="dgr" class="text-xl font-mono text-blue-400">0.00%</p></div>
        </div>

        <!-- COMPOUNDING PROJECTIONS -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div class="bg-blue-600 p-6 rounded-2xl">
                <p class="text-[10px] text-blue-200 font-bold uppercase mb-1">Linear Avg / Hr</p>
                <p id="estHr" class="text-3xl font-mono font-bold">$0.00</p>
            </div>
            <div class="bg-zinc-900 border-2 border-blue-600 p-6 rounded-2xl shadow-xl shadow-blue-900/20">
                <p class="text-[10px] text-blue-500 font-bold uppercase mb-1">Next 24h (Compounded)</p>
                <p id="estDay" class="text-3xl font-mono font-bold">$0.00</p>
                <p class="text-[9px] text-zinc-500 mt-2 italic">Expectancy based on current balance</p>
            </div>
            <div class="bg-blue-900/40 p-6 rounded-2xl border border-blue-800">
                <p class="text-[10px] text-blue-400 font-bold uppercase mb-1">30 Day Projection</p>
                <p id="estMonth" class="text-3xl font-mono font-bold">$0.00</p>
                <p class="text-[9px] text-blue-500 mt-2 italic">100% Reinvestment Model</p>
            </div>
        </div>

        <!-- Safety Progress -->
        <div class="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 mb-6">
            <div class="flex justify-between items-end mb-4">
                <div><p class="text-[10px] text-zinc-500 uppercase">Martingale Steps</p><p id="stepText" class="text-4xl font-mono font-bold">0 / 10</p></div>
                <div class="text-right"><p class="text-[10px] text-zinc-500 uppercase">Dist. to Next Buy</p><p id="distText" class="text-4xl font-mono font-bold text-orange-500">0.00%</p></div>
            </div>
            <div class="w-full bg-zinc-800 rounded-full h-3 overflow-hidden flex">
                <div id="progressBar" class="bg-blue-500 h-full transition-all duration-700" style="width: 0%"></div>
            </div>
        </div>

        <div class="flex justify-between items-center text-zinc-500">
            <div class="text-xs">Price: <span id="curPrice" class="font-mono text-zinc-300">0.0000</span></div>
            <button onclick="resetStats()" class="text-[10px] font-bold hover:text-red-500 transition-colors">RESET ALL SESSION DATA</button>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('dgr').innerText = d.estimates.dgr.toFixed(2) + '%';
                
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);

                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                document.getElementById('progressBar').style.width = progressPct + '%';
                if(progressPct > 70) document.getElementById('progressBar').className = "bg-red-500 h-full transition-all";
            } catch (e) {}
        }
        async function resetStats() { if(confirm("Clear data?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
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
    botState.estimates = { hr: 0, day: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, boot);
