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
    startTime: { type: Number, default: Date.now() },
    peakBalance: { type: Number, default: 0 } // Track highest balance achieved
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
    displayBalance: 0, // NEW: Static display balance that only increases
    peakBalance: 0,    // NEW: Track all-time high balance
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
                // Get REAL equity (total value including unrealized PnL)
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                const realBalance = equity - unrealized;
                
                // NEW LOGIC: Only update display balance when REAL balance increases
                if (realBalance > botState.peakBalance) {
                    const increase = realBalance - botState.peakBalance;
                    botState.displayBalance = botState.displayBalance + increase;
                    botState.peakBalance = realBalance;
                    
                    console.log(`🎯 New Peak Balance! Real: $${realBalance.toFixed(2)} | Display: $${botState.displayBalance.toFixed(2)} | Increase: $${increase.toFixed(2)}`);
                }
                
                // Store the real balance for calculations
                botState.walletBalance = realBalance;
                
                // Initialize on first run
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.displayBalance = botState.walletBalance;
                    botState.peakBalance = botState.walletBalance;
                    botState.startTime = Date.now();
                    console.log(`🚀 Bot Initialized | Starting Balance: $${botState.initialBalance.toFixed(2)}`);
                }
            }
        }

        // Compounding Math using DISPLAY balance (static, only increases)
        const elapsedDays = (Date.now() - botState.startTime) / (1000 * 60 * 60 * 24);
        if (elapsedDays > 0.001 && botState.displayBalance > botState.initialBalance) {
            // DGR based on static display balance
            const dgr = Math.pow((botState.displayBalance / botState.initialBalance), (1 / elapsedDays)) - 1;
            botState.estimates.dgr = dgr * 100;
            botState.estimates.hr = (botState.displayBalance - botState.initialBalance) / (elapsedDays * 24);
            
            // Projections based on static balance
            botState.estimates.day = botState.displayBalance * dgr;
            botState.estimates.week = (botState.displayBalance * Math.pow((1 + dgr), 7)) - botState.displayBalance;
            botState.estimates.month = (botState.displayBalance * Math.pow((1 + dgr), 30)) - botState.displayBalance;
        }

        // Position sizing uses REAL wallet balance for safety
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
                console.log(`✅ Take profit triggered | ROI: ${botState.roi}%`);
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                console.log(`📉 Safety Order #${botState.safetyOrdersFilled} | Volume: ${nextVol}`);
            }
        } else if (botState.maxSafeBase > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
            console.log(`🎯 Initial position opened | Volume: ${botState.settings.baseOrder}`);
        }

        // Profit calculations based on DISPLAY balance (static)
        botState.realizedProfit = botState.displayBalance - botState.initialBalance;
        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;

    } catch (e) {
        console.error("Trading error:", e);
    }
    botState.isTrading = false;
}

// ==================== STARTUP ====================
async function boot() {
    const data = await BotModel.findOne({ id: "htx_martingale" });
    if (data) {
        botState.initialBalance = data.initialBalance || 0;
        botState.displayBalance = data.initialBalance || 0;
        botState.peakBalance = data.peakBalance || 0;
        botState.realizedProfit = data.storedRealizedProfit || 0;
        botState.profitPct = data.storedProfitPct || 0;
        botState.startTime = data.startTime || Date.now();
        console.log(`📀 Loaded from DB | Initial: $${botState.initialBalance} | Peak: $${botState.peakBalance}`);
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
    console.log(`🤖 Bot started | Symbol: ${config.symbol} | Leverage: ${config.leverage}X`);
}

// ==================== UI - WHITE DESIGN ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Compounder V33 | Static Balance Edition</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card-glow { box-shadow: 0 4px 20px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .progress-bar { background: linear-gradient(90deg, #059669 0%, #0284c7 100%); }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
        .balance-static { transition: all 0.3s ease; }
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-gray-900 text-3xl font-bold tracking-tight">
                    COMPOUND<span class="gradient-text">_BOT</span>
                    <span class="text-sm font-mono text-gray-400 ml-2">v33</span>
                </h1>
                <p class="text-xs text-gray-400 uppercase tracking-wider mt-1">${config.symbol} | ${config.leverage}X Leverage</p>
                <p class="text-[10px] text-emerald-600 mt-2">✨ Balance only increases on new highs</p>
            </div>
            <div class="text-right">
                <p class="text-3xl font-bold text-emerald-600" id="dgrText">0.00%</p>
                <p class="text-[10px] text-gray-400 uppercase tracking-wider">Daily Growth Rate</p>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Net Profit (Locked)</p>
                <p id="p1" class="text-3xl font-bold text-emerald-600 stat-number">$0.00</p>
                <p class="text-[9px] text-gray-400 mt-1">Only counts new highs</p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Total Gain</p>
                <p id="p2" class="text-3xl font-bold text-emerald-600 stat-number">0.00%</p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Open Position ROI</p>
                <p id="roi" class="text-3xl font-bold text-gray-600 stat-number">0.00%</p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Display Balance</p>
                <p id="bal" class="text-3xl font-bold text-gray-900 stat-number balance-static">$0.00</p>
                <p class="text-[9px] text-gray-400 mt-1">Real: <span id="realBal">$0.00</span></p>
            </div>
        </div>

        <!-- Compounding Projections -->
        <h2 class="text-gray-500 text-[11px] font-bold uppercase tracking-wider mb-4">Compounding Estimates (Based on Locked Balance)</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            
            <div class="bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-200 p-8 rounded-2xl card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl italic font-black text-emerald-900">24H</div>
                <p class="text-[10px] text-emerald-700 font-bold uppercase tracking-wider mb-2">Next 24 Hours</p>
                <p id="estDay" class="text-4xl font-bold text-emerald-900 stat-number">$0.00</p>
                <p class="text-[10px] text-emerald-600 mt-4 font-semibold">ESTIMATED EARNINGS</p>
            </div>

            <div class="card p-8 rounded-2xl card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-6xl italic font-black text-gray-900">7D</div>
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 7 Days</p>
                <p id="estWeek" class="text-4xl font-bold text-gray-900 stat-number">$0.00</p>
                <p class="text-[10px] text-gray-400 mt-4 font-semibold">COMPOUNDED GROWTH</p>
            </div>

            <div class="card p-8 rounded-2xl border-l-4 border-l-emerald-500 card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-6xl italic font-black text-gray-900">30D</div>
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 30 Days</p>
                <p id="estMonth" class="text-4xl font-bold text-emerald-700 stat-number">$0.00</p>
                <p class="text-[10px] text-gray-400 mt-4 font-semibold">PROJECTED PROFIT</p>
            </div>
        </div>

        <!-- Risk & Progress -->
        <div class="card p-8 rounded-2xl card-glow mb-8">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Safety Orders Filled</p>
                    <p id="stepText" class="text-5xl font-bold text-gray-900 stat-number">0 <span class="text-2xl text-gray-400">/ 10</span></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Next Step Distance</p>
                    <p id="distText" class="text-4xl font-bold text-orange-500 stat-number">0.00%</p>
                </div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div id="progressBar" class="progress-bar h-full transition-all duration-500 rounded-full" style="width: 0%"></div>
            </div>
            
            <!-- Warning indicator for high risk -->
            <div id="riskWarning" class="mt-4 hidden">
                <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p class="text-amber-700 text-xs font-semibold">⚠️ High Risk Zone - Multiple safety orders activated</p>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="flex justify-between items-center text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            <div>Avg Profit/Hr: <span id="estHr" class="text-gray-600 ml-1">$0.00</span></div>
            <div class="flex gap-6 items-center">
                <span>Price: <span id="curPrice" class="text-gray-900 font-mono ml-1">0.00</span></span>
                <button onclick="resetStats()" class="text-gray-400 hover:text-red-500 transition-colors px-3 py-1 rounded-lg hover:bg-red-50">Reset Session</button>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                // Format numbers
                document.getElementById('p1').innerHTML = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerHTML = d.profitPct.toFixed(2) + '%';
                
                const roiEl = document.getElementById('roi');
                roiEl.innerHTML = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-3xl font-bold stat-number ' + (d.roi >= 0 ? 'text-emerald-600' : 'text-red-500');
                
                // Display static balance and real balance
                document.getElementById('bal').innerHTML = '$' + d.displayBalance.toFixed(2);
                document.getElementById('realBal').innerHTML = '$' + d.walletBalance.toFixed(2);
                
                // Add animation when balance increases
                const balElement = document.getElementById('bal');
                balElement.classList.add('scale-105');
                setTimeout(() => balElement.classList.remove('scale-105'), 300);
                
                document.getElementById('dgrText').innerHTML = d.estimates.dgr.toFixed(2) + '%';
                
                // Estimates
                document.getElementById('estHr').innerHTML = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerHTML = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerHTML = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerHTML = '$' + d.estimates.month.toFixed(0);

                // Risk
                document.getElementById('curPrice').innerHTML = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-2xl text-gray-400">/ ' + d.settings.maxSteps + '</span>';
                document.getElementById('distText').innerHTML = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = progressPct + '%';
                
                // Show warning when at risk
                const warning = document.getElementById('riskWarning');
                if (progressPct > 60) {
                    warning.classList.remove('hidden');
                    if (progressPct > 75) bar.style.background = 'linear-gradient(90deg, #dc2626 0%, #ea580c 100%)';
                    else if (progressPct > 60) bar.style.background = 'linear-gradient(90deg, #f59e0b 0%, #ea580c 100%)';
                } else {
                    warning.classList.add('hidden');
                    bar.style.background = 'linear-gradient(90deg, #059669 0%, #0284c7 100%)';
                }

            } catch (e) {}
        }
        
        async function resetStats() { 
            if(confirm("⚠️ Warning: This resets Initial Balance and Projections. Continue?")) {
                await fetch('/api/reset-stats', {method:'POST'});
                update();
            }
        }
        
        setInterval(update, 1000); 
        update();
    </script>
    <style>
        .balance-static {
            transition: transform 0.3s ease;
        }
        .scale-105 {
            transform: scale(1.05);
        }
    </style>
</body>
</html>`);
});

app.get('/api/status', (req, res) => res.json({
    ...botState,
    displayBalance: botState.displayBalance, // Static balance
    walletBalance: botState.walletBalance   // Real balance
}));

app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.displayBalance; // Reset to current display balance
    botState.displayBalance = botState.displayBalance;
    botState.peakBalance = botState.walletBalance;
    botState.startTime = Date.now();
    botState.realizedProfit = 0; 
    botState.profitPct = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, { 
        initialBalance: botState.initialBalance, 
        startTime: botState.startTime, 
        storedRealizedProfit: 0, 
        storedProfitPct: 0,
        peakBalance: botState.peakBalance
    }, { upsert: true });
    console.log(`🔄 Session Reset | New starting balance: $${botState.initialBalance}`);
    res.sendStatus(200); 
});

app.listen(config.port, boot);
