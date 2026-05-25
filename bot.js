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
    isRunning: Boolean,
    initialBalance: { type: Number, default: 0 },
    settings: {
        baseOrder: Number,
        autoScale: Boolean,
        priceDrop: Number,
        volumeMult: Number,
        takeProfit: Number,
        maxSteps: Number
    }
});
const BotModel = mongoose.model('BotConfig_V23', BotSchema);

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
    isRunning: true, // AUTO-START
    isTrading: false,
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0, 
    pnl: 0, 
    realizedProfit: 0, 
    profitPct: 0,
    safetyOrdersFilled: 0,
    walletBalance: 0, 
    initialBalance: 0,
    maxSafeBase: 0,
    settings: {
        baseOrder: 6000,
        autoScale: true,
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.0,    
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
        return res.data;
    } catch (e) { return null; }
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

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                const currentWallet = equity - unrealized;

                if (!isNaN(currentWallet) && currentWallet > 0) {
                    botState.walletBalance = currentWallet;
                    // FIX: Only save initialBalance if it's a valid number and not already set
                    if (botState.initialBalance <= 0 || isNaN(botState.initialBalance)) {
                        botState.initialBalance = currentWallet;
                        await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance }, { upsert: true });
                    }
                    botState.realizedProfit = botState.walletBalance - botState.initialBalance;
                    botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                }
            }
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            const priceMovePct = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100;
            botState.roi = priceMovePct * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            if (priceMovePct >= botState.settings.takeProfit) {
                console.log("🎯 Take Profit Hit. Closing.");
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else {
                const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
                if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                    botState.safetyOrdersFilled++;
                    const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                    console.log(`📉 Buying Safety Order #${botState.safetyOrdersFilled}`);
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: vol,
                        direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                }
            }
        } else if (botState.maxSafeBase > 0) {
            console.log("🚀 Opening Base Order.");
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== WEBSOCKET & MATH ====================
function calculateMaxBase() {
    if (botState.currentPrice <= 0 || botState.walletBalance <= 0) return;
    const m = botState.settings.volumeMult;
    const n = botState.settings.maxSteps;
    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
    const totalUsdtCapacity = botState.walletBalance * config.leverage;
    const rawBase = totalUsdtCapacity / (multiplierSum * botState.currentPrice * 1000);
    botState.maxSafeBase = Math.floor(rawBase * 0.75); 
    if (botState.settings.autoScale) botState.settings.baseOrder = botState.maxSafeBase;
}

function initWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        console.log("🌐 WS Connected");
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (err) return;
            try {
                const msg = JSON.parse(dezipped.toString());
                if (msg.ping) return ws.send(JSON.stringify({ pong: msg.ping }));
                if (msg.tick && msg.tick.close) {
                    botState.currentPrice = parseFloat(msg.tick.close);
                    calculateMaxBase();
                }
            } catch (e) {}
        });
    });
    ws.on('close', () => setTimeout(initWebSocket, 5000));
}

// ==================== STARTUP ====================
async function boot() {
    const data = await BotModel.findOne({ id: "htx_martingale" });
    if (data) {
        botState.initialBalance = parseFloat(data.initialBalance) || 0;
    }
    // Force 1% TP, 0.1% Drop, 1.2x Mult
    botState.settings = { ...botState.settings, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.0 };
    botState.isRunning = true;
    initWebSocket();
    setInterval(runLogic, 3000);
    console.log("✅ Bot Started. Settings: 1% TP, 0.1% Drop.");
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TradeBot | Fast & Stable</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@700&display=swap" rel="stylesheet">
    <style>
        .ui-card { background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 20px; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
    </style>
</head>
<body class="bg-gray-50 p-8">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold">🤖 HTX Martingale V3</h1>
            <button onclick="toggleBot()" id="btn" class="bg-black text-white px-8 py-3 rounded-lg font-bold">START BOT</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="ui-card"><p class="text-xs font-bold text-gray-400 uppercase">Realized Profit</p><p id="p1" class="text-xl font-mono text-green-600">$0.0000</p></div>
            <div class="ui-card"><p class="text-xs font-bold text-gray-400 uppercase">Session Profit</p><p id="p2" class="text-xl font-mono text-green-600">0.0000%</p></div>
            <div class="ui-card"><p class="text-xs font-bold text-gray-400 uppercase">Unrealized ROI</p><p id="roi" class="text-xl font-mono text-gray-400">0.00%</p></div>
            <div class="ui-card"><p class="text-xs font-bold text-gray-400 uppercase">Wallet Balance</p><p id="bal" class="text-xl font-mono text-gray-800">$0.0000</p></div>
        </div>
        <div class="ui-card text-center py-12">
            <p class="text-gray-400 text-xs font-bold uppercase mb-2">Max Safe Base Order</p>
            <p id="maxBase" class="text-6xl font-mono font-bold">0</p>
            <div class="mt-4 text-xs font-bold text-blue-500 uppercase">Price: <span id="curPrice">0.00</span> | TP: 1.0% | Drop: 0.1% | Mult: 1.2</div>
            <button onclick="resetStats()" class="mt-8 text-xs text-red-500 font-bold border border-red-200 px-4 py-1 rounded-full">RESET PROFIT HISTORY</button>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(4) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').className = 'text-xl font-mono ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(4);
                document.getElementById('maxBase').innerText = d.maxSafeBase.toLocaleString();
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(6);
                document.getElementById('btn').innerText = d.isRunning ? 'STOP BOT' : 'START BOT';
                document.getElementById('btn').className = d.isRunning ? 'bg-red-600 text-white px-8 py-3 rounded-lg font-bold' : 'bg-black text-white px-8 py-3 rounded-lg font-bold';
            } catch (e) {}
        }
        async function toggleBot() { await fetch('/api/toggle', {method:'POST'}); update(); }
        async function resetStats() { if(confirm("Reset?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); update();
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', async (req, res) => { botState.isRunning = !botState.isRunning; res.sendStatus(200); });
app.post('/api/reset-stats', async (req, res) => { botState.initialBalance = botState.walletBalance; await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance }); res.sendStatus(200); });

app.listen(config.port, boot);
