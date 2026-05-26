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
    safetyOrdersFilled: 0,
    distToNext: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 }, 
    settings: {
        baseOrder: 0, 
        priceDrop: 0.1,
        volumeMult: 1.2,
        takeProfit: 1.5,
        maxSteps: 10,
        contractSize: 1 // SHIB contract size is 1 USDT per contract
    }
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { 
        AccessKeyId: config.apiKey, 
        SignatureMethod: 'HmacSHA256', 
        SignatureVersion: '2', 
        Timestamp: timestamp 
    };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    
    try {
        const res = await axios({ 
            method, 
            url, 
            data: method === 'POST' ? data : null, 
            headers: { 'Content-Type': 'application/json' }, 
            timeout: 5000 
        });
        return res.data;
    } catch (e) {
        console.error(`❌ API Error (${path}):`, e.response?.data || e.message);
        return null;
    }
}

// ==================== CORRECT BASE ORDER CALCULATION ====================
function calculateBaseOrder(walletBalance, currentPrice) {
    // For SHIB-USDT with 10x leverage
    // Each contract = 1 USDT worth of SHIB
    // Margin needed per contract = 1 USDT / leverage = 0.1 USDT
    
    const leverage = config.leverage;
    const riskPerStep = 0.02; // 2% risk per step
    const maxRisk = walletBalance * 0.85; // Use 85% of wallet max
    
    // Sum of geometric series for 1.2 multiplier over 10 steps
    // Total = baseOrder * (1.2^11 - 1)/(1.2 - 1) = baseOrder * 32.15
    const multiplier = 1.2;
    const steps = 10;
    const seriesSum = (Math.pow(multiplier, steps + 1) - 1) / (multiplier - 1); // ~32.15
    
    // Each contract requires 0.1 USDT margin at 10x leverage
    const marginPerContract = 1 / leverage; // 0.1 USDT
    
    // Calculate base order
    let baseOrder = Math.floor(maxRisk / (seriesSum * marginPerContract));
    
    // Ensure minimum 1 contract
    baseOrder = Math.max(1, baseOrder);
    
    console.log(`📐 Base Order Calculation:
    Wallet: $${walletBalance}
    Max Risk: $${maxRisk}
    Series Sum: ${seriesSum}
    Margin/Contract: $${marginPerContract}
    Calculated Base Order: ${baseOrder} contracts`);
    
    return baseOrder;
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;

    try {
        const [posRes, accRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol }),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' })
        ]);

        // Parse positions
        let pos = null;
        if (posRes && posRes.data && Array.isArray(posRes.data)) {
            pos = posRes.data.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        }
        
        // Parse account info
        let walletBalance = 0;
        if (accRes && accRes.data && accRes.data.length > 0) {
            const account = accRes.data[0];
            walletBalance = parseFloat(account.margin_balance) || 0;
        }

        if (walletBalance > 0) {
            botState.walletBalance = Number(walletBalance.toFixed(4));
            
            // Calculate base order when no position is open
            if (!pos && botState.walletBalance > 0 && botState.currentPrice > 0) {
                // Use the correct calculation
                const calculatedBase = calculateBaseOrder(botState.walletBalance, botState.currentPrice);
                botState.settings.baseOrder = calculatedBase;
                
                console.log(`🎯 Updated Base Order: ${botState.settings.baseOrder} contracts`);
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.startTime = Date.now();
                    await BotModel.updateOne({ id: "htx_martingale" }, 
                        { initialBalance: botState.initialBalance, startTime: botState.startTime }, 
                        { upsert: true });
                    console.log(`🎯 Initial Balance Set: $${botState.initialBalance}`);
                }
            }
        }

        // Update profit stats
        if (botState.initialBalance > 0) {
            botState.realizedProfit = botState.walletBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }

        // Compounding estimates
        const elapsedHours = (Date.now() - botState.startTime) / (1000 * 60 * 60);
        if (elapsedHours > 0.1 && botState.initialBalance > 0 && botState.walletBalance > 0) {
            const hourlyReturn = Math.pow(botState.walletBalance / botState.initialBalance, (1 / elapsedHours)) - 1;
            const safeHourly = hourlyReturn > 0 ? hourlyReturn : 0;
            
            botState.estimates.dgr = safeHourly * 24 * 100;
            botState.estimates.hr = botState.realizedProfit / elapsedHours;
            botState.estimates.day = botState.walletBalance * safeHourly * 24;
            botState.estimates.week = botState.walletBalance * (Math.pow(1 + safeHourly, 24 * 7) - 1);
            botState.estimates.month = botState.walletBalance * (Math.pow(1 + safeHourly, 24 * 30) - 1);
        }

        // --- EXECUTION ---
        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            
            if (botState.roi >= botState.settings.takeProfit) {
                console.log(`🎯 TAKE PROFIT at ${botState.roi}%`);
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: pos.volume,
                    direction: 'sell', 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                // Volume = BaseOrder * (1.2 ^ step)
                const nextVol = Math.floor(botState.settings.baseOrder * Math.pow(1.2, botState.safetyOrdersFilled));
                console.log(`📉 SAFETY ORDER #${botState.safetyOrdersFilled}: ${nextVol} contracts at $${botState.currentPrice}`);
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: Math.max(1, nextVol),
                    direction: 'buy', 
                    offset: 'open', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
            }
        } else if (botState.settings.baseOrder > 0 && botState.walletBalance > 0) {
            console.log(`🚀 OPENING POSITION: ${botState.settings.baseOrder} contracts | Price: $${botState.currentPrice}`);
            botState.safetyOrdersFilled = 0;
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: botState.settings.baseOrder,
                direction: 'buy', 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
        }
    } catch (e) {
        console.error("❌ Trading loop error:", e?.message || e);
    }
    botState.isTrading = false;
}

// ==================== STARTUP ====================
async function boot() {
    let data = await BotModel.findOne({ id: "htx_martingale" });
    if (!data) data = await BotModel.create({ id: "htx_martingale" });
    botState.initialBalance = data.initialBalance || 0;
    botState.startTime = data.startTime || Date.now();
    
    console.log(`📀 Loaded: Initial Balance=$${botState.initialBalance}`);

    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        console.log("🔌 WebSocket Connected");
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) {
                        botState.currentPrice = parseFloat(msg.tick.close);
                    }
                    if (msg.ping) {
                        ws.send(JSON.stringify({ pong: msg.ping }));
                    }
                } catch (e) {}
            }
        });
    });
    ws.on('error', (err) => console.error("WebSocket Error:", err));
    
    setInterval(runLogic, 3000);
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-slate-50">
<head>
    <title>HTX Engine | Fixed 1.2x Martingale</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Roboto Mono', monospace; }
        .glass { background: white; border: 1px solid rgba(0, 0, 0, 0.08); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02); }
    </style>
</head>
<body class="text-slate-600 p-4 md:p-10">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-slate-900 text-2xl font-bold tracking-tighter uppercase">Fixed <span class="text-blue-600">1.2x Engine</span></h1>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">${config.symbol} | 1.2x Multiplier | 1.5% TP | 10x Leverage</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-blue-600 font-bold text-2xl">0.00%</p>
                <p class="text-[10px] text-slate-400 uppercase font-bold tracking-widest">Daily Growth Rate</p>
            </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div class="glass p-6 rounded-3xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold mb-2">Static Profit</p>
                <p id="p1" class="text-3xl text-emerald-600 font-bold">$0.0000</p>
            </div>
            <div class="glass p-6 rounded-3xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold mb-2">Static Gain</p>
                <p id="p2" class="text-3xl text-emerald-600 font-bold">0.00%</p>
            </div>
            <div class="glass p-6 rounded-3xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold mb-2">Live ROI</p>
                <p id="roi" class="text-3xl text-slate-300 font-bold">0.00%</p>
            </div>
            <div class="glass p-6 rounded-3xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold mb-2">Wallet Balance</p>
                <p id="bal" class="text-3xl text-slate-900 font-bold">$0.0000</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            <div class="bg-blue-600 p-8 rounded-[2rem] shadow-xl shadow-blue-100 relative overflow-hidden text-white text-center">
                <p id="estDay" class="text-4xl font-bold">$0.00</p>
                <p class="text-[10px] opacity-70 font-bold uppercase mt-2">Next 24h Projection</p>
            </div>
            <div class="glass p-8 rounded-[2rem] relative overflow-hidden text-center">
                <p id="estWeek" class="text-4xl text-slate-900 font-bold">$0.00</p>
                <p class="text-[10px] text-slate-400 font-bold uppercase mt-2">7 Day Projection</p>
            </div>
            <div class="glass p-8 rounded-[2rem] border-b-4 border-b-blue-600 relative overflow-hidden text-center">
                <p id="estMonth" class="text-4xl text-slate-900 font-bold">$0.00</p>
                <p class="text-[10px] text-slate-400 font-bold uppercase mt-2">30 Day Projection</p>
            </div>
        </div>

        <div class="glass p-8 rounded-[2rem] mb-8">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-1">Martingale Progress</p>
                    <p id="stepText" class="text-5xl text-slate-900 font-bold">0 / 10</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-slate-400 font-bold uppercase mb-1">Base Order (1.2x)</p>
                    <p id="baseOrderText" class="text-5xl text-blue-600 font-bold">0</p>
                </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-5 overflow-hidden p-1 shadow-inner">
                <div id="progressBar" class="bg-blue-600 h-full rounded-full transition-all duration-1000" style="width: 0%"></div>
            </div>
            <div class="mt-4 text-center text-[10px] text-slate-400">
                Martingale Series: Base → Base×1.2 → Base×1.44 → Base×1.73 → ... (10 steps max)
            </div>
        </div>

        <div class="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            <div>Hourly Avg: <span id="estHr" class="text-slate-900 ml-1">$0.0000</span></div>
            <div class="flex gap-8">
                <span>Current Price: <span id="curPrice" class="text-slate-900 ml-1">0.00000000</span></span>
                <button onclick="resetStats()" class="text-red-400 hover:text-red-600 transition-colors uppercase">Reset Session</button>
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
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(4);
                document.getElementById('baseOrderText').innerText = d.settings.baseOrder;
                
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-3xl font-bold ' + (d.roi >= 0 ? (d.roi == 0 ? 'text-slate-300' : 'text-emerald-500') : 'text-red-500');
                
                document.getElementById('dgrText').innerHTML = d.estimates.dgr.toFixed(2) + '%';
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(4);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);

                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-xl">/</span> ' + d.settings.maxSteps;

                const progressPct = d.settings.maxSteps > 0 ? (d.safetyOrdersFilled / d.settings.maxSteps) * 100 : 0;
                document.getElementById('progressBar').style.width = progressPct + '%';
            } catch (e) {}
        }
        async function resetStats() { 
            if(confirm("Reset session and start fresh?")) {
                await fetch('/api/reset-stats', {method:'POST'});
                setTimeout(update, 100);
            }
        }
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
    botState.realizedProfit = 0; 
    botState.profitPct = 0;
    botState.safetyOrdersFilled = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, 
        { initialBalance: botState.initialBalance, startTime: botState.startTime }, 
        { upsert: true });
    console.log(`🔄 Session Reset: New Balance=$${botState.initialBalance}`);
    res.sendStatus(200); 
});

app.listen(config.port, () => {
    console.log(`\n🚀 HTX Martingale Bot Running`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x | Multiplier: 1.2x | TP: 1.5%`);
    console.log(`🌐 Web UI: http://localhost:${config.port}\n`);
    boot();
});
