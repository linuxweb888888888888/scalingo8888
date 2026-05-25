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
const MONGO_URI = process.env.MONGO_URI || "your_connection_string";
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
const BotModel = mongoose.model('BotConfig_V18', BotSchema);

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
    isRunning: false,
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
        priceDrop: 1.0,      
        volumeMult: 1.5,     
        takeProfit: 1.0,    // Target 1% Price Increase
        maxSteps: 10
    }
};

// ==================== DATABASE ACTIONS ====================
async function loadFromDb() {
    try {
        const data = await BotModel.findOne({ id: "htx_martingale" });
        if (data) {
            botState.isRunning = data.isRunning;
            botState.initialBalance = data.initialBalance;
            botState.settings = data.settings;
            console.log("✅ Settings Loaded. Current TP:", botState.settings.takeProfit);
        } else {
            await BotModel.create({ id: "htx_martingale", isRunning: false, settings: botState.settings });
        }
    } catch (e) { console.error("DB Load Error"); }
}

async function saveToDb() {
    try {
        await BotModel.updateOne({ id: "htx_martingale" }, {
            isRunning: botState.isRunning,
            initialBalance: botState.initialBalance,
            settings: botState.settings
        }, { upsert: true });
    } catch (e) { console.log("DB Save Error"); }
}

// ==================== HELPERS & WS ====================
function calculateMaxBase() {
    if (botState.currentPrice <= 0 || botState.walletBalance <= 0) return;
    const m = botState.settings.volumeMult || 1.5;
    const n = botState.settings.maxSteps || 10;
    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
    const totalUsdtCapacity = botState.walletBalance * config.leverage;
    const rawBase = totalUsdtCapacity / (multiplierSum * botState.currentPrice * 1000);
    botState.maxSafeBase = Math.floor(rawBase * 0.70); 
    if (botState.settings.autoScale) botState.settings.baseOrder = botState.maxSafeBase;
}

function initWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (err) return;
            try {
                const msg = JSON.parse(dezipped.toString());
                if (msg.ping) return ws.send(JSON.stringify({ pong: msg.ping }));
                if (msg.tick && msg.tick.close) {
                    botState.currentPrice = msg.tick.close;
                    calculateMaxBase();
                }
            } catch (e) {}
        });
    });
    ws.on('close', () => setTimeout(initWebSocket, 5000));
}

async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ 
            method, url, data: method === 'POST' ? data : null, 
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000 
        });
        return res.data;
    } catch (e) { return null; }
}

// ==================== CORE TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        // 1. Sync Positions
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        // 2. Sync Balance
        const balRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (balRes?.data) {
            const acc = balRes.data.find(a => a.margin_asset === 'USDT');
            const equity = parseFloat(acc.margin_balance);
            const unrealized = pos ? parseFloat(pos.unrealized_pnl) : 0;
            botState.walletBalance = equity - unrealized;
            if (botState.initialBalance === 0) { botState.initialBalance = botState.walletBalance; await saveToDb(); }
            botState.realizedProfit = botState.walletBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            botState.pnl = parseFloat(pos.unrealized_pnl);
            
            // Percentage movement of the price
            const priceChangePct = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100;
            botState.roi = priceChangePct * config.leverage;

            // CLOSE LOGIC: Check against settings.takeProfit
            if (priceChangePct >= botState.settings.takeProfit) {
                console.log(`Target ${botState.settings.takeProfit}% hit. Closing...`);
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } 
            // SAFETY ORDER LOGIC
            else {
                const dropTrigger = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
                if (botState.currentPrice <= dropTrigger && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                    botState.safetyOrdersFilled++;
                    const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: vol,
                        direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                }
            }
        } else {
            // OPEN INITIAL
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) { console.error("Logic Loop Error"); }
    botState.isTrading = false;
}

setInterval(runLogic, 3000);

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Bot Control</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 p-5">
    <div class="max-w-4xl mx-auto">
        <div class="bg-white p-6 rounded-xl shadow-sm mb-6 flex justify-between items-center">
            <h1 class="text-xl font-bold">HTX Martingale V18</h1>
            <button onclick="toggleBot()" id="btn" class="px-6 py-2 rounded-lg font-bold text-white bg-black">LOADING...</button>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="bg-white p-4 rounded shadow-sm"><p class="text-xs text-gray-500">PROFIT USD</p><p id="p1" class="text-lg font-bold">$0.00</p></div>
            <div class="bg-white p-4 rounded shadow-sm"><p class="text-xs text-gray-500">PROFIT %</p><p id="p2" class="text-lg font-bold">0.00%</p></div>
            <div class="bg-white p-4 rounded shadow-sm"><p class="text-xs text-gray-500">UNREALIZED ROI</p><p id="roi" class="text-lg font-bold">0.00%</p></div>
            <div class="bg-white p-4 rounded shadow-sm"><p class="text-xs text-gray-500">SAFE BASE</p><p id="maxBase" class="text-lg font-bold">0</p></div>
        </div>

        <div class="bg-white p-6 rounded-xl shadow-sm">
            <h2 class="font-bold mb-4">Settings</h2>
            <div class="grid grid-cols-2 gap-4">
                <div><label class="text-xs block">Take Profit (%)</label><input id="inp_tp" type="number" class="w-full border p-2 rounded"></div>
                <div><label class="text-xs block">Price Drop (%)</label><input id="inp_pd" type="number" class="w-full border p-2 rounded"></div>
                <div><label class="text-xs block">Volume Multiplier</label><input id="inp_vm" type="number" class="w-full border p-2 rounded"></div>
                <div><label class="text-xs block">Max Safety Steps</label><input id="inp_ms" type="number" class="w-full border p-2 rounded"></div>
            </div>
            <button onclick="saveSettings()" class="w-full mt-4 bg-blue-600 text-white py-2 rounded font-bold">SAVE SETTINGS</button>
            <button onclick="resetStats()" class="w-full mt-2 text-red-500 text-xs">Reset Profit History</button>
        </div>
    </div>

    <script>
        async function update() {
            const r = await fetch('/api/status');
            const d = await r.json();
            document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
            document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
            document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
            document.getElementById('maxBase').innerText = d.maxSafeBase;
            document.getElementById('btn').innerText = d.isRunning ? 'STOP BOT' : 'START BOT';
            document.getElementById('btn').className = d.isRunning ? 'px-6 py-2 rounded-lg font-bold text-white bg-red-600' : 'px-6 py-2 rounded-lg font-bold text-white bg-black';
            
            if(!window.loadedOnce) {
                document.getElementById('inp_tp').value = d.settings.takeProfit;
                document.getElementById('inp_pd').value = d.settings.priceDrop;
                document.getElementById('inp_vm').value = d.settings.volumeMult;
                document.getElementById('inp_ms').value = d.settings.maxSteps;
                window.loadedOnce = true;
            }
        }
        async function toggleBot() { await fetch('/api/toggle', {method:'POST'}); update(); }
        async function resetStats() { if(confirm("Reset?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        async function saveSettings() {
            const settings = {
                takeProfit: parseFloat(document.getElementById('inp_tp').value),
                priceDrop: parseFloat(document.getElementById('inp_pd').value),
                volumeMult: parseFloat(document.getElementById('inp_vm').value),
                maxSteps: parseInt(document.getElementById('inp_ms').value),
                autoScale: true
            };
            await fetch('/api/settings', {
                method:'POST', 
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify(settings)
            });
            alert("Settings Saved & Applied!");
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', async (req, res) => { botState.isRunning = !botState.isRunning; await saveToDb(); res.sendStatus(200); });
app.post('/api/reset-stats', async (req, res) => { botState.initialBalance = botState.walletBalance; botState.realizedProfit = 0; botState.profitPct = 0; await saveToDb(); res.sendStatus(200); });
app.post('/api/settings', async (req, res) => {
    botState.settings = { ...botState.settings, ...req.body };
    await saveToDb();
    res.sendStatus(200);
});

app.listen(config.port, async () => {
    await loadFromDb();
    initWebSocket();
});
