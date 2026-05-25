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
// Fixed the URI issue by using your specific connection string
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI)
    .then(() => console.log("📦 MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

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
const BotModel = mongoose.model('BotConfig_V19', BotSchema);

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

// ==================== DATABASE ACTIONS (FORCE 1% FIX) ====================
async function loadFromDb() {
    try {
        let data = await BotModel.findOne({ id: "htx_martingale" });
        if (data) {
            botState.isRunning = data.isRunning;
            botState.initialBalance = data.initialBalance;
            botState.settings = data.settings;

            // FORCE FIX: If DB is stuck at 0.15, force it to 1.0
            if (botState.settings.takeProfit !== 1.0) {
                console.log(`⚠️ Forcing TakeProfit from ${botState.settings.takeProfit}% to 1.0%`);
                botState.settings.takeProfit = 1.0;
                await saveToDb(); 
            }
        } else {
            await BotModel.create({ id: "htx_martingale", isRunning: false, settings: botState.settings });
        }
        console.log("✅ Settings Loaded. Take Profit is:", botState.settings.takeProfit + "%");
    } catch (e) { console.error("DB Load Error"); }
}

async function saveToDb() {
    try {
        await BotModel.updateOne({ id: "htx_martingale" }, {
            isRunning: botState.isRunning,
            initialBalance: botState.initialBalance,
            settings: botState.settings
        }, { upsert: true });
    } catch (e) {}
}

// ==================== MATH & WS ====================
function calculateMaxBase() {
    if (botState.currentPrice <= 0 || botState.walletBalance <= 0) return;
    const m = botState.settings.volumeMult || 1.5;
    const n = botState.settings.maxSteps || 10;
    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
    const totalUsdtCapacity = botState.walletBalance * config.leverage;
    const rawBase = totalUsdtCapacity / (multiplierSum * botState.currentPrice * 1000);
    botState.maxSafeBase = Math.floor(rawBase * 0.75); 
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

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
            
            // Calculate REAL Price Move (not leveraged)
            const priceChangePct = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100;
            botState.roi = priceChangePct * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            // SELL CHECK: Using priceChangePct to ensure it hits 1% move
            if (priceChangePct >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else {
                // Safety Orders
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
            // Start Trade
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== UI & API ====================
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-gray-100 p-10 font-mono">
        <div class="max-w-2xl mx-auto bg-white p-6 rounded shadow">
            <h1 class="text-xl font-bold mb-4">HTX Martingale V19</h1>
            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="p-4 bg-blue-50 rounded">Profit: <span id="p1">$0</span></div>
                <div class="p-4 bg-green-50 rounded">ROI: <span id="roi">0%</span></div>
            </div>
            <div class="mb-4">
                <label class="text-xs">Take Profit (%)</label>
                <input id="tp" type="number" class="w-full border p-2 rounded mb-2">
                <button onclick="save()" class="w-full bg-blue-600 text-white py-2 rounded">SAVE SETTINGS</button>
            </div>
            <button onclick="toggle()" id="btn" class="w-full py-4 rounded font-bold text-white bg-black">START BOT</button>
        </div>
        <script>
            async function update() {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('btn').innerText = d.isRunning ? 'STOP' : 'START';
                document.getElementById('btn').style.background = d.isRunning ? 'red' : 'black';
                if(!window.once) { document.getElementById('tp').value = d.settings.takeProfit; window.once=true; }
            }
            async function toggle() { await fetch('/api/toggle', {method:'POST'}); update(); }
            async function save() {
                const tp = parseFloat(document.getElementById('tp').value);
                await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({takeProfit:tp})});
                alert("Saved!");
            }
            setInterval(update, 1000); update();
        </script>
    </body>
    </html>`);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', async (req, res) => { botState.isRunning = !botState.isRunning; await saveToDb(); res.sendStatus(200); });
app.post('/api/settings', async (req, res) => { botState.settings = {...botState.settings, ...req.body}; await saveToDb(); res.sendStatus(200); });

app.listen(config.port, async () => {
    await loadFromDb();
    initWebSocket();
    setInterval(runLogic, 3000);
});
