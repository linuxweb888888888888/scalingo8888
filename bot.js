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
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected - Stability Fix Applied"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    isRunning: Boolean,
    initialBalance: { type: Number, default: 0 },
    realizedProfit: { type: Number, default: 0 },
    profitPct: { type: Number, default: 0 },
    settings: {
        baseOrder: Number,
        autoScale: Boolean,
        priceDrop: Number,
        volumeMult: Number,
        takeProfit: Number,
        maxSteps: Number
    }
});
const BotModel = mongoose.model('BotConfig_V16', BotSchema);

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
    realizedProfit: 0,      // ONLY updates on closed trades (STATIC)
    profitPct: 0,           // ONLY updates on closed trades (STATIC)
    safetyOrdersFilled: 0,
    walletBalance: 0,        // Current static cash balance
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
        botState.initialBalance = data.initialBalance || 0;
        botState.realizedProfit = data.realizedProfit || 0;
        botState.profitPct = data.profitPct || 0;
        botState.settings = data.settings;
    } else {
        await BotModel.create({ 
            id: "htx_martingale", 
            isRunning: false, 
            realizedProfit: 0,
            profitPct: 0,
            settings: botState.settings 
        });
    }
}

async function saveToDb() {
    await BotModel.updateOne({ id: "htx_martingale" }, {
        isRunning: botState.isRunning,
        initialBalance: botState.initialBalance,
        realizedProfit: botState.realizedProfit,
        profitPct: botState.profitPct,
        settings: botState.settings
    });
}

// ==================== MATH: GEOMETRIC MAX BASE ====================
function calculateMaxBase() {
    if (botState.currentPrice <= 0 || botState.walletBalance <= 0) return;
    try {
        const m = botState.settings.volumeMult;
        const n = botState.settings.maxSteps;
        const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
        const totalUsdtCapacity = botState.walletBalance * config.leverage;
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
        // 1. Sync Balances & Position simultaneously
        const [balRes, posRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {}),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol })
        ]);

        if (balRes && balRes.data) {
            const usdtAccount = balRes.data.find(a => a.margin_asset === 'USDT' || a.symbol === 'USDT');
            
            if (usdtAccount) {
                const marginBalance = parseFloat(usdtAccount.margin_balance || 0);
                
                let totalUnrealized = 0;
                if (posRes && posRes.data) {
                    posRes.data.forEach(p => totalUnrealized += parseFloat(p.unrealized_pnl || 0));
                }
                
                const currentStaticBalance = marginBalance - totalUnrealized;
                botState.walletBalance = currentStaticBalance;
                
                // Initialize start point
                if (botState.initialBalance === 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    await saveToDb();
                }
            }
        }

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);
        
        if (pos) {
            const previousContracts = botState.totalContracts;
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            botState.roi = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100 * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            // CHECK TAKE PROFIT CONDITION
            if (botState.roi >= botState.settings.takeProfit) {
                // Execute closing order
                const closeResult = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: Math.abs(botState.totalContracts),
                    direction: 'sell', 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                
                // ✅ Calculate realized profit from this closed trade (STATIC UPDATE)
                if (closeResult && closeResult.data && closeResult.data.order_id) {
                    const closePrice = botState.currentPrice;
                    const realizedPnL = botState.totalContracts * 1000 * (closePrice - botState.avgPrice) * config.leverage;
                    
                    // Add to static realized profit (this persists)
                    botState.realizedProfit += realizedPnL;
                    
                    // Update profit percentage based on initial balance
                    if (botState.initialBalance > 0) {
                        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                    }
                    
                    console.log(`✅ Trade closed! Realized PnL: ${realizedPnL.toFixed(4)} USDT | Total Realized: ${botState.realizedProfit.toFixed(4)} USDT | Profit: ${botState.profitPct.toFixed(2)}%`);
                    
                    // Save to database immediately
                    await saveToDb();
                }
                
                botState.safetyOrdersFilled = 0;
                botState.totalContracts = 0;
            } 
            // CHECK FOR PRICE DROP TO ADD SAFETY ORDERS
            else {
                const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
                if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                    botState.safetyOrdersFilled++;
                    const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, 
                        volume: vol,
                        direction: 'buy', 
                        offset: 'open', 
                        lever_rate: config.leverage, 
                        order_price_type: 'opponent'
                    });
                    console.log(`📈 Safety Order #${botState.safetyOrdersFilled} placed: ${vol} contracts`);
                }
            }
        } 
        // NO POSITION - OPEN NEW TRADE
        else {
            // Only open if we have no position and bot is running
            if (botState.totalContracts === 0) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: botState.settings.baseOrder,
                    direction: 'buy', 
                    offset: 'open', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
                console.log(`🚀 New position opened: ${botState.settings.baseOrder} contracts at ${botState.currentPrice}`);
            }
        }
    } catch (e) {
        console.error("Trading error:", e);
        botState.lastError = e.message;
    }
    botState.isTrading = false;
}

function logicLoop() { 
    runLogic().finally(() => setTimeout(logicLoop, 4000)); 
}

// ==================== RESET STATS FUNCTION ====================
async function resetStats() {
    botState.initialBalance = botState.walletBalance;
    botState.realizedProfit = 0;
    botState.profitPct = 0;
    await saveToDb();
    console.log(`📊 Stats reset! New starting balance: ${botState.walletBalance} USDT`);
}

// ==================== UI DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBot | Smart Martingale - Static Profit Tracker</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f1f1f1; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; transition: all 0.2s; }
        .input-disabled { background: #eeeeee !important; color: #888; cursor: not-allowed; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 12px 24px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .stat-card { transition: all 0.3s ease; }
        .profit-positive { color: #10b981; }
        .profit-negative { color: #ef4444; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center shadow-md relative overflow-hidden">
                    <span class="material-symbols-outlined text-white text-[20px]">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg">TradeBot<span class="text-blue-600">StaticProfit</span></span>
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
                <!-- REALIZED PROFIT USDT (STATIC - ONLY UPDATES ON CLOSE) -->
                <div class="ui-card p-6 stat-card">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">💰 Realized Profit (USDT)</p>
                    <p id="realProfit" class="text-2xl font-mono font-bold text-green-500">$0.0000</p>
                    <p class="text-[9px] text-gray-400 mt-2">↑ Only updates when trades close</p>
                </div>
                
                <!-- SESSION PERCENTAGE (STATIC - ONLY UPDATES ON CLOSE) -->
                <div class="ui-card p-6 stat-card">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">📊 Session Profit (%)</p>
                    <p id="profitPct" class="text-2xl font-mono font-bold text-blue-600">0.0000%</p>
                    <p class="text-[9px] text-gray-400 mt-2">↑ Based on closed trades only</p>
                </div>
                
                <!-- UNREALIZED ROI (MOVES WITH MARKET) -->
                <div class="ui-card p-6 stat-card">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">📈 Unrealized ROI</p>
                    <p id="roi" class="text-2xl font-mono font-bold text-gray-400">0.00%</p>
                    <p class="text-[9px] text-gray-400 mt-2">↺ Current position PnL</p>
                </div>
                
                <!-- WALLET BALANCE (STATIC CASH) -->
                <div class="ui-card p-6 stat-card">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">💵 Wallet Cash</p>
                    <p id="balance" class="text-2xl font-mono font-bold text-gray-800">$0.0000</p>
                    <p class="text-[9px] text-gray-400 mt-2">↺ Static balance (excludes unrealized)</p>
                </div>
            </div>

            <div class="ui-card p-8 h-64 flex flex-col items-center justify-center border-2 border-dashed border-gray-200 text-center">
                 <p class="text-gray-400 font-bold uppercase tracking-widest text-[10px] mb-2">🎯 Calculated Max Safe Base (10 Steps)</p>
                 <p id="recBaseDisplay" class="text-5xl font-mono font-bold text-black">0</p>
                 <div class="flex gap-4 mt-6">
                    <button onclick="resetStats()" class="text-[10px] bg-red-500 text-white font-bold px-6 py-2 rounded-full uppercase shadow-lg shadow-red-200 hover:bg-red-600 transition flex items-center gap-2 mx-auto">
                        <span class="material-symbols-outlined text-sm">refresh</span> Reset Session Stats
                    </button>
                 </div>
                 <p class="text-[10px] text-gray-400 mt-4">⚠️ Reset will set current balance as new starting point</p>
            </div>
        </div>

        <div class="lg:col-span-4 space-y-6">
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6 flex items-center gap-2 pb-2 border-b border-gray-50 uppercase text-xs tracking-widest text-gray-400">⚙️ Strategy Settings</h3>
                <div class="space-y-4">
                    <div class="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
                        <span class="text-[10px] font-bold text-blue-700 uppercase">Auto-Scale Position</span>
                        <input type="checkbox" id="autoScale" onchange="toggleAuto()">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-gray-500 mb-1 block">Base Order Quantity</label>
                        <input id="baseOrder" type="number" class="input-minimal font-mono">
                        <p class="text-[9px] text-gray-400 mt-1">Auto-scale will override this</p>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="text-xs font-bold text-gray-500 mb-1 block">Price Drop %</label>
                            <input id="priceDrop" type="number" step="0.1" class="input-minimal font-mono">
                            <p class="text-[9px] text-gray-400 mt-1">Trigger for safety orders</p>
                        </div>
                        <div>
                            <label class="text-xs font-bold text-gray-500 mb-1 block">Take Profit %</label>
                            <input id="takeProfit" type="number" step="0.1" class="input-minimal font-mono">
                            <p class="text-[9px] text-gray-400 mt-1">Target profit to close</p>
                        </div>
                    </div>
                    <button onclick="saveSettings()" class="btn-primary w-full mt-4 font-bold text-xs uppercase tracking-widest">💾 Update Strategy</button>
                </div>
            </div>
            
            <div class="ui-card p-6 bg-gray-50">
                <h3 class="font-bold mb-3 text-xs uppercase tracking-widest text-gray-500">📋 Live Status</h3>
                <div class="space-y-2 text-xs font-mono">
                    <div class="flex justify-between"><span class="text-gray-500">Symbol:</span><span class="font-bold">${config.symbol}</span></div>
                    <div class="flex justify-between"><span class="text-gray-500">Leverage:</span><span class="font-bold">${config.leverage}x</span></div>
                    <div class="flex justify-between"><span class="text-gray-500">Current Price:</span><span id="currentPrice" class="font-bold">0.0000</span></div>
                    <div class="flex justify-between"><span class="text-gray-500">Safety Orders:</span><span id="safetyCount" class="font-bold">0</span></div>
                    <div class="flex justify-between"><span class="text-gray-500">Position Size:</span><span id="positionSize" class="font-bold">0</span></div>
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
                
                // Realized Profit (STATIC)
                const profitElem = document.getElementById('realProfit');
                profitElem.innerText = (d.realizedProfit >= 0 ? '+' : '') + d.realizedProfit.toFixed(4) + ' USDT';
                profitElem.className = 'text-2xl font-mono font-bold ' + (d.realizedProfit >= 0 ? 'text-green-500' : 'text-red-500');
                
                // Profit Percentage (STATIC)
                const pctElem = document.getElementById('profitPct');
                pctElem.innerText = (d.profitPct >= 0 ? '+' : '') + d.profitPct.toFixed(4) + '%';
                pctElem.className = 'text-2xl font-mono font-bold ' + (d.profitPct >= 0 ? 'text-green-500' : 'text-red-500');
                
                // Unrealized ROI (MOVING)
                const roiElem = document.getElementById('roi');
                roiElem.innerText = (d.roi >= 0 ? '+' : '') + d.roi.toFixed(2) + '%';
                roiElem.className = 'text-2xl font-mono font-bold ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
                
                // Wallet Balance
                document.getElementById('balance').innerText = d.walletBalance.toFixed(4) + ' USDT';
                document.getElementById('recBaseDisplay').innerText = d.maxSafeBase.toLocaleString();
                document.getElementById('currentPrice').innerText = d.currentPrice.toFixed(8);
                document.getElementById('safetyCount').innerText = d.safetyOrdersFilled;
                document.getElementById('positionSize').innerText = d.totalContracts;
                
                if(isFirstLoad) {
                    document.getElementById('autoScale').checked = d.settings.autoScale;
                    document.getElementById('baseOrder').value = d.settings.baseOrder;
                    document.getElementById('priceDrop').value = d.settings.priceDrop;
                    document.getElementById('takeProfit').value = d.settings.takeProfit;
                    toggleAutoUI(d.settings.autoScale);
                    isFirstLoad = false;
                }
                
                if(d.settings.autoScale) {
                    document.getElementById('baseOrder').value = d.maxSafeBase;
                }
                
                const btn = document.getElementById('mainAction');
                btn.innerText = d.isRunning ? '🛑 STOP ENGINE' : '▶️ START ENGINE';
                btn.className = d.isRunning ? 'btn-primary bg-red-600 py-2 px-6' : 'btn-primary py-2 px-6';
                document.getElementById('statusBadge').innerText = d.isRunning ? '🟢 Running' : '⏹️ Stopped';
                document.getElementById('statusBadge').className = 'text-[10px] px-3 py-1 rounded-full uppercase font-bold tracking-wide ' + (d.isRunning ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700');
            } catch (e) {
                console.error('Refresh error:', e);
            }
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
        
        async function toggleBot() { 
            await fetch('/api/toggle', {method: 'POST'}); 
            refresh(); 
        }
        
        async function resetStats() { 
            if(confirm("⚠️ Reset all profit statistics? Current balance will become the new starting point.\n\nRealized Profit and Profit % will be reset to 0.")) { 
                await fetch('/api/reset-stats', {method: 'POST'}); 
                setTimeout(refresh, 500);
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
            await fetch('/api/settings', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify(body) 
            });
            setTimeout(refresh, 200);
        }
        
        setInterval(refresh, 1000);
        refresh();
    </script>
</body>
</html>
    `);
});

// ==================== API ENDPOINTS ====================
app.get('/api/status', (req, res) => res.json(botState));

app.post('/api/toggle', async (req, res) => { 
    botState.isRunning = !botState.isRunning; 
    await saveToDb(); 
    console.log(`Bot ${botState.isRunning ? 'STARTED' : 'STOPPED'}`);
    res.sendStatus(200); 
});

app.post('/api/reset-stats', async (req, res) => { 
    await resetStats();
    res.sendStatus(200); 
});

app.post('/api/settings', async (req, res) => { 
    botState.settings = { ...botState.settings, ...req.body }; 
    if (!botState.settings.autoScale) {
        botState.settings.baseOrder = req.body.baseOrder;
    }
    await saveToDb(); 
    console.log('Settings updated:', botState.settings);
    res.sendStatus(200); 
});

// ==================== SERVER START ====================
app.listen(config.port, async () => {
    console.log(`\n🚀 TradeBot Server Started on port ${config.port}`);
    console.log(`📊 Dashboard: http://localhost:${config.port}`);
    console.log(`💰 Symbol: ${config.symbol} | Leverage: ${config.leverage}x`);
    console.log(`📈 Static Profit Mode: Realized PnL only updates on closed trades\n`);
    await loadFromDb();
    initWebSocket();
    logicLoop();
});
