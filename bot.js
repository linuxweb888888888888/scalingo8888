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
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected - Profit Lock Active"));

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
const BotModel = mongoose.model('BotConfig_V14', BotSchema);

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

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    isTrading: false,
    lastError: "None",
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0, 
    pnl: 0, 
    realizedProfit: 0, 
    profitPct: 0,
    safetyOrdersFilled: 0,
    lockedWalletBalance: 0, // THE "STAND STILL" BALANCE
    initialBalance: 0,
    maxSafeBase: 0,
    settings: {
        baseOrder: 6000,
        autoScale: true,
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 0.15,    
        maxSteps: 10
    }
};

// ==================== DATABASE ACTIONS ====================
async function loadFromDb() {
    const data = await BotModel.findOne({ id: "htx_martingale" });
    if (data) {
        botState.isRunning = data.isRunning;
        botState.initialBalance = data.initialBalance;
        botState.settings = data.settings;
    } else {
        await BotModel.create({ id: "htx_martingale", isRunning: false, settings: botState.settings });
    }
}

async function saveToDb() {
    await BotModel.updateOne({ id: "htx_martingale" }, {
        isRunning: botState.isRunning,
        initialBalance: botState.initialBalance,
        settings: botState.settings
    });
}

// ==================== MATH: MAX BASE ====================
function calculateMaxBase() {
    if (botState.currentPrice <= 0 || botState.lockedWalletBalance <= 0) return;
    try {
        const m = botState.settings.volumeMult;
        const n = botState.settings.maxSteps;
        const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
        const totalUsdtCapacity = botState.lockedWalletBalance * config.leverage;
        const rawBase = totalUsdtCapacity / (multiplierSum * botState.currentPrice * 1000);
        botState.maxSafeBase = Math.floor(rawBase * 0.80); 
        if (botState.settings.autoScale) botState.settings.baseOrder = botState.maxSafeBase;
    } catch (e) {}
}

// ==================== WEBSOCKET ====================
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

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        // 1. Fetch Position First
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);
        botState.totalContracts = pos ? parseFloat(pos.volume) : 0;

        // 2. Fetch Balance
        const balRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {});
        if (balRes) {
            const usdtAccount = balRes.data?.find(a => a.margin_asset === 'USDT');
            const actualWalletCash = parseFloat(usdtAccount?.static_balance || usdtAccount?.margin_balance || 0);

            // ✅ THE FIX: ONLY update the reference balance if we have 0 contracts open.
            // If totalContracts > 0, we use the value we saved BEFORE the trade started.
            if (botState.totalContracts === 0) {
                botState.lockedWalletBalance = actualWalletCash;
            }

            // Set Initial Balance if never set
            if (botState.initialBalance === 0 && botState.lockedWalletBalance > 0) {
                botState.initialBalance = botState.lockedWalletBalance;
                await saveToDb();
            }

            // Realized Profit = The Locked Balance - The Starting Balance
            botState.realizedProfit = botState.lockedWalletBalance - botState.initialBalance;
            botState.profitPct = botState.initialBalance > 0 ? (botState.realizedProfit / botState.initialBalance) * 100 : 0;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100 * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            if (botState.roi >= botState.settings.takeProfit) {
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
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: vol,
                        direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                }
            }
        } else {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {}
    botState.isTrading = false;
}

function logicLoop() { runLogic().finally(() => setTimeout(logicLoop, 4000)); }

// ==================== UI DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBot | Professional AI Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f1f1f1; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; transition: all 0.2s; }
        .input-disabled { background: #eeeeee !important; color: #888; cursor: not-allowed; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 12px 24px; font-size: 14px; font-weight: 500; cursor: pointer; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center shadow-md relative overflow-hidden">
                    <span class="material-symbols-outlined text-white text-[20px]">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg">TradeBot<span class="text-blue-600">PureProfit</span></span>
            </div>
            <div class="flex items-center gap-4">
                <span id="statusBadge" class="text-[10px] bg-gray-100 px-3 py-1 rounded-full uppercase font-bold tracking-wide">Ready</span>
                <button onclick="toggleBot()" id="mainAction" class="btn-primary py-2 px-6">START ENGINE</button>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto w-full px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div class="lg:col-span-8 space-y-8">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                <!-- REALIZED PROFIT USDT (STOPS MOVING DURING TRADES) -->
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Realized Profit (USDT)</p>
                    <p id="realProfit" class="text-2xl font-mono font-bold text-green-500">$0.0000</p>
                </div>
                <!-- SESSION PERCENTAGE (STOPS MOVING DURING TRADES) -->
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Session Profit (%)</p>
                    <p id="profitPct" class="text-2xl font-mono font-bold text-blue-600">0.0000%</p>
                </div>
                <!-- UNREALIZED ROI (FLOATS WITH PRICE) -->
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Unrealized ROI</p>
                    <p id="roi" class="text-2xl font-mono font-bold text-gray-400">0.00%</p>
                </div>
                <!-- WALLET BALANCE (STOPS MOVING DURING TRADES) -->
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Wallet Balance</p>
                    <p id="balance" class="text-2xl font-mono font-bold text-gray-800">$0.0000</p>
                </div>
            </div>

            <div class="ui-card p-8 h-64 flex flex-col items-center justify-center border-2 border-dashed border-gray-200">
                 <p class="text-gray-400 font-bold uppercase tracking-widest text-[10px] mb-2">Maximum Safe Base Order (10 Steps)</p>
                 <p id="recBaseDisplay" class="text-5xl font-mono font-bold text-black">0</p>
                 <div class="flex gap-4 mt-6">
                    <button onclick="resetStats()" class="text-[10px] bg-red-500 text-white font-bold px-6 py-2 rounded-full uppercase shadow-lg shadow-red-200 hover:bg-red-600 transition flex items-center gap-2">
                        <span class="material-symbols-outlined text-sm">refresh</span> Reset Statistics
                    </button>
                 </div>
            </div>
        </div>

        <div class="lg:col-span-4 space-y-6">
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6 flex items-center gap-2 pb-2 border-b border-gray-50 uppercase text-xs tracking-widest text-gray-400">Settings</h3>
                <div class="space-y-4">
                    <div class="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
                        <span class="text-[10px] font-bold text-blue-700 uppercase">Auto-Scale</span>
                        <input type="checkbox" id="autoScale" onchange="toggleAuto()">
                    </div>
                    <div><label class="text-xs font-bold text-gray-500 mb-1 block">Base Qty</label><input id="baseOrder" type="number" class="input-minimal font-mono"></div>
                    <div class="grid grid-cols-2 gap-4">
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">Drop %</label><input id="priceDrop" type="number" class="input-minimal font-mono"></div>
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">TP %</label><input id="takeProfit" type="number" class="input-minimal font-mono"></div>
                    </div>
                    <button onclick="saveSettings()" class="btn-primary w-full mt-4 font-bold text-xs uppercase tracking-widest">Update Strategy</button>
                </div>
            </div>
        </div>
    </main>

    <script>
        let isFirstLoad = true;
        async function refresh() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                
                document.getElementById('realProfit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('realProfit').className = 'text-2xl font-mono font-bold ' + (d.realizedProfit >= 0 ? 'text-green-500' : 'text-red-500');
                
                document.getElementById('profitPct').innerText = d.profitPct.toFixed(4) + '%';
                document.getElementById('profitPct').className = 'text-2xl font-mono font-bold ' + (d.profitPct >= 0 ? 'text-green-500' : 'text-red-500');
                
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').className = 'text-2xl font-mono font-bold ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');

                document.getElementById('balance').innerText = '$' + parseFloat(d.lockedWalletBalance).toFixed(4);
                document.getElementById('recBaseDisplay').innerText = d.maxSafeBase.toLocaleString();
                
                if(isFirstLoad) {
                    document.getElementById('autoScale').checked = d.settings.autoScale;
                    document.getElementById('baseOrder').value = d.settings.baseOrder;
                    document.getElementById('priceDrop').value = d.settings.priceDrop;
                    document.getElementById('takeProfit').value = d.settings.takeProfit;
                    toggleAutoUI(d.settings.autoScale);
                    isFirstLoad = false;
                }
                if(d.settings.autoScale) document.getElementById('baseOrder').value = d.maxSafeBase;

                const btn = document.getElementById('mainAction');
                btn.innerText = d.isRunning ? 'STOP ENGINE' : 'START ENGINE';
                btn.className = d.isRunning ? 'btn-primary bg-red-600 py-2 px-6' : 'btn-primary py-2 px-6';
                document.getElementById('statusBadge').innerText = d.isRunning ? 'Running' : 'Stopped';
            } catch (e) {}
        }

        function toggleAutoUI(checked) {
            const input = document.getElementById('baseOrder');
            input.disabled = checked;
            input.classList.toggle('input-disabled', checked);
        }

        async function toggleAuto() {
            toggleAutoUI(document.getElementById('autoScale').checked);
            await saveSettings();
        }

        async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
        async function resetStats() { 
            if(confirm("Reset profit statistics? This sets current balance as the new starting point.")) {
                await fetch('/api/reset-stats', {method: 'POST'}); 
                refresh();
            } 
        }
        
        async function saveSettings() {
            const body = {
                autoScale: document.getElementById('autoScale').checked,
                baseOrder: parseFloat(document.getElementById('baseOrder').value),
                priceDrop: parseFloat(document.getElementById('priceDrop').value),
                takeProfit: parseFloat(document.getElementById('takeProfit').value),
                volumeMult: 1.2,
                maxSteps: 10
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', async (req, res) => { botState.isRunning = !botState.isRunning; await saveToDb(); res.sendStatus(200); });

app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.lockedWalletBalance; 
    botState.realizedProfit = 0;
    botState.profitPct = 0;
    await saveToDb(); 
    res.sendStatus(200); 
});

app.post('/api/settings', async (req, res) => { botState.settings = { ...botState.settings, ...req.body }; await saveToDb(); res.sendStatus(200); });

// ==================== START ====================
app.listen(config.port, async () => {
    await loadFromDb();
    initWebSocket();
    logicLoop();
});
