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
const BotModel = mongoose.model('BotConfig_V31', BotSchema);

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
    estimates: { hr: 0, day: 0, month: 0 }, // Compounding Projections
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
                
                if (botState.initialBalance <= 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.startTime = Date.now();
                    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime }, { upsert: true });
                }
            }
        }

        // COMPOUNDING CALCULATION (Projections)
        const elapsedHrs = (Date.now() - botState.startTime) / (1000 * 60 * 60);
        if (elapsedHrs > 0.01 && botState.realizedProfit > 0) {
            botState.estimates.hr = botState.realizedProfit / elapsedHrs;
            botState.estimates.day = botState.estimates.hr * 24;
            botState.estimates.month = botState.estimates.day * 30;
        }

        // MATH FOR BASE ORDER
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
            const diff = botState.currentPrice - triggerPrice;
            botState.distToNext = Math.max(0, (diff / botState.currentPrice) * 100);

            if (botState.roi >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
                // Force update profit stats after a close
                setTimeout(async () => {
                   const finalAcc = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
                   botState.realizedProfit = parseFloat(finalAcc.data[0].margin_balance) - botState.initialBalance;
                   botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                }, 2000);
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
            botState.distToNext = 0;
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
    <title>HTX Martingale V3</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@700&display=swap" rel="stylesheet">
</head>
<body class="bg-gray-900 text-white p-4 md:p-10 font-sans">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold tracking-tighter">HTX BOT <span class="text-blue-500">V31</span></h1>
            <div class="text-right"><p class="text-[10px] text-gray-500 uppercase">Status</p><p class="text-green-400 font-bold">ONLINE</p></div>
        </div>

        <!-- Real Stats -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-gray-800 p-4 rounded-xl"><p class="text-[10px] text-gray-400 uppercase">Profit</p><p id="p1" class="text-xl font-mono text-green-400">$0.00</p></div>
            <div class="bg-gray-800 p-4 rounded-xl"><p class="text-[10px] text-gray-400 uppercase">Gain</p><p id="p2" class="text-xl font-mono text-green-400">0.00%</p></div>
            <div class="bg-gray-800 p-4 rounded-xl"><p class="text-[10px] text-gray-400 uppercase">Live ROI</p><p id="roi" class="text-xl font-mono text-gray-500">0.00%</p></div>
            <div class="bg-gray-800 p-4 rounded-xl"><p class="text-[10px] text-gray-400 uppercase">Balance</p><p id="bal" class="text-xl font-mono text-white">$0.00</p></div>
        </div>

        <!-- ESTIMATE PROJECTIONS (Compounding) -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div class="bg-blue-900/30 border border-blue-800 p-6 rounded-xl">
                <p class="text-[10px] text-blue-400 font-bold uppercase mb-2">Est. Per Hour</p>
                <p id="estHr" class="text-3xl font-mono text-white">$0.00</p>
            </div>
            <div class="bg-blue-900/50 border border-blue-700 p-6 rounded-xl scale-105">
                <p class="text-[10px] text-blue-300 font-bold uppercase mb-2">Est. Per Day</p>
                <p id="estDay" class="text-3xl font-mono text-white">$0.00</p>
            </div>
            <div class="bg-blue-900/30 border border-blue-800 p-6 rounded-xl">
                <p class="text-[10px] text-blue-400 font-bold uppercase mb-2">Est. Per Month</p>
                <p id="estMonth" class="text-3xl font-mono text-white">$0.00</p>
            </div>
        </div>

        <!-- Progress Bar Section -->
        <div class="bg-gray-800 p-6 rounded-xl mb-6">
            <div class="flex justify-between items-end mb-4">
                <div><p class="text-[10px] text-gray-400 uppercase">Safety Steps</p><p id="stepText" class="text-4xl font-mono font-bold">0 / 10</p></div>
                <div class="text-right"><p class="text-[10px] text-gray-400 uppercase">Next Order Distance</p><p id="distText" class="text-4xl font-mono font-bold text-orange-400">0.00%</p></div>
            </div>
            <div class="w-full bg-gray-700 rounded-full h-4 overflow-hidden flex">
                <div id="progressBar" class="bg-blue-500 h-full transition-all duration-500" style="width: 0%"></div>
            </div>
        </div>

        <div class="flex justify-between items-center bg-gray-800 p-4 rounded-xl">
            <div><p class="text-[10px] text-gray-400 uppercase">Market Price</p><p id="curPrice" class="text-lg font-mono text-blue-400">0.00000000</p></div>
            <button onclick="resetStats()" class="bg-red-500/10 text-red-500 border border-red-500/20 px-4 py-2 rounded text-[10px] font-bold uppercase">Reset Stats</button>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';
                
                // Projections
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(2);

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                document.getElementById('progressBar').style.width = progressPct + '%';
            } catch (e) {}
        }
        async function resetStats() { if(confirm("Reset logic and projections?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
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
    botState.estimates = { hr: 0, day: 0, month: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, startTime: botState.startTime, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, boot);
