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
        console.log("📀 Loaded from DB:", { isRunning: botState.isRunning, realizedProfit: botState.realizedProfit });
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
        if (botState.settings.autoScale && botState.maxSafeBase > 0) {
            botState.settings.baseOrder = botState.maxSafeBase;
        }
    } catch (e) {
        console.error("Max base calculation error:", e);
    }
}

// ==================== WEBSOCKET WITH BETTER HANDLING ====================
let ws = null;
let wsReconnectTimer = null;

function initWebSocket() {
    if (ws) {
        try { ws.terminate(); } catch(e) {}
    }
    
    console.log("🔌 Connecting to WebSocket...");
    ws = new WebSocket(config.wsHost);
    
    ws.on('open', () => {
        console.log("✅ WebSocket connected");
        const subscribeMsg = JSON.stringify({ 
            sub: `market.${config.symbol}.detail`, 
            id: Date.now().toString() 
        });
        ws.send(subscribeMsg);
        console.log(`📡 Subscribed to ${config.symbol}`);
        
        // Send ping every 30 seconds to keep connection alive
        if (ws.pingInterval) clearInterval(ws.pingInterval);
        ws.pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 30000);
    });
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (err) return;
            try {
                const msg = JSON.parse(dezipped.toString());
                
                // Handle ping/pong
                if (msg.ping) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ pong: msg.ping }));
                    }
                    return;
                }
                
                // Handle price updates
                if (msg.tick && msg.tick.close) {
                    const newPrice = msg.tick.close;
                    if (newPrice !== botState.currentPrice) {
                        botState.currentPrice = newPrice;
                        calculateMaxBase();
                        // console.log(`💰 Price updated: ${botState.currentPrice}`);
                    }
                }
                
                // Handle subscription response
                if (msg.id && msg.status === 'ok') {
                    console.log("✅ Subscription confirmed");
                }
            } catch (e) {
                // Silent fail for parse errors
            }
        });
    });
    
    ws.on('error', (error) => {
        console.error("WebSocket error:", error.message);
    });
    
    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} - ${reason || 'No reason'}`);
        if (ws.pingInterval) clearInterval(ws.pingInterval);
        
        // Reconnect after 5 seconds
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(() => {
            console.log("🔄 Reconnecting WebSocket...");
            initWebSocket();
        }, 5000);
    });
}

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
            headers: { 
                'Content-Type': 'application/json', 
                'User-Agent': 'Mozilla/5.0' 
            }, 
            timeout: 10000 
        });
        return res.data;
    } catch (e) { 
        console.error(`API Error (${path}):`, e.response?.data || e.message);
        return null; 
    }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) {
        if (botState.isRunning && botState.currentPrice <= 0) {
            console.log("⏳ Waiting for price data...");
        }
        return;
    }
    
    botState.isTrading = true;
    try {
        // Get account and position info
        const [balRes, posRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {}),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol })
        ]);

        if (balRes && balRes.data && balRes.data.length > 0) {
            const usdtAccount = balRes.data.find(a => a.margin_asset === 'USDT');
            
            if (usdtAccount) {
                const marginBalance = parseFloat(usdtAccount.margin_balance || 0);
                
                let totalUnrealized = 0;
                if (posRes && posRes.data) {
                    totalUnrealized = posRes.data.reduce((sum, p) => sum + parseFloat(p.unrealized_pnl || 0), 0);
                }
                
                const currentStaticBalance = marginBalance - totalUnrealized;
                botState.walletBalance = currentStaticBalance;
                
                // Initialize start point
                if (botState.initialBalance === 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    await saveToDb();
                    console.log(`🎯 Initial balance set: ${botState.initialBalance} USDT`);
                }
            }
        }

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);
        
        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            botState.roi = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100 * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            // Check take profit
            if (botState.roi >= botState.settings.takeProfit) {
                console.log(`🎯 Take profit triggered! ROI: ${botState.roi.toFixed(2)}%`);
                
                const closeResult = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: Math.abs(botState.totalContracts),
                    direction: 'sell', 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                
                if (closeResult && (closeResult.status === 'ok' || closeResult.data)) {
                    const realizedPnL = botState.totalContracts * 1000 * (botState.currentPrice - botState.avgPrice) * config.leverage;
                    
                    botState.realizedProfit += realizedPnL;
                    if (botState.initialBalance > 0) {
                        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                    }
                    
                    console.log(`✅ Trade closed! PnL: ${realizedPnL.toFixed(4)} USDT | Total: ${botState.realizedProfit.toFixed(4)} USDT (${botState.profitPct.toFixed(2)}%)`);
                    await saveToDb();
                }
                
                botState.safetyOrdersFilled = 0;
                botState.totalContracts = 0;
            } 
            // Check for safety order
            else {
                const dropAmount = botState.settings.priceDrop / 100;
                const triggerPrice = botState.avgPrice * (1 - dropAmount);
                
                if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                    botState.safetyOrdersFilled++;
                    const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                    
                    console.log(`📈 Safety Order #${botState.safetyOrdersFilled}: ${vol} contracts at ${botState.currentPrice}`);
                    
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, 
                        volume: vol,
                        direction: 'buy', 
                        offset: 'open', 
                        lever_rate: config.leverage, 
                        order_price_type: 'opponent'
                    });
                }
            }
        } 
        // No position - open new trade
        else if (botState.totalContracts === 0 && botState.walletBalance > 0) {
            console.log(`🚀 Opening new position: ${botState.settings.baseOrder} contracts at ${botState.currentPrice}`);
            
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: botState.settings.baseOrder,
                direction: 'buy', 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {
        console.error("Trading error:", e.message);
        botState.lastError = e.message;
    }
    botState.isTrading = false;
}

function logicLoop() { 
    runLogic().catch(console.error).finally(() => setTimeout(logicLoop, 3000)); 
}

// ==================== RESET STATS ====================
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBot | Martingale Static Profit</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        .card { background: white; border-radius: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 1.5rem; }
        .stat-value { font-size: 1.875rem; font-weight: 700; font-family: monospace; }
        .btn { padding: 0.5rem 1.5rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .btn-primary { background: #000; color: white; }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .btn-danger { background: #dc2626; color: white; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .input-field { width: 100%; padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 0.5rem; font-family: monospace; }
        .status-badge { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
        .status-running { background: #d1fae5; color: #065f46; }
        .status-stopped { background: #f3f4f6; color: #374151; }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="max-w-7xl mx-auto px-4 py-8">
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-2xl font-bold">🤖 Martingale TradeBot</h1>
                <p class="text-gray-500 text-sm">Static Profit Tracker | Only closed trades count</p>
            </div>
            <div class="flex items-center gap-4">
                <span id="statusBadge" class="status-badge status-stopped">STOPPED</span>
                <button id="toggleBtn" class="btn btn-primary" onclick="toggleBot()">START ENGINE</button>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-1">💰 Realized Profit</p>
                <p id="realProfit" class="stat-value positive">0.0000 USDT</p>
                <p class="text-gray-400 text-xs mt-2">↑ Only updates on trade close</p>
            </div>
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-1">📊 Session Profit</p>
                <p id="profitPct" class="stat-value positive">0.00%</p>
                <p class="text-gray-400 text-xs mt-2">↑ Based on closed trades</p>
            </div>
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-1">📈 Unrealized ROI</p>
                <p id="roi" class="stat-value">0.00%</p>
                <p class="text-gray-400 text-xs mt-2">↺ Current position</p>
            </div>
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-1">💵 Wallet Cash</p>
                <p id="balance" class="stat-value">0.0000 USDT</p>
                <p class="text-gray-400 text-xs mt-2">↺ Static balance</p>
            </div>
        </div>

        <!-- Live Info -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-3">📡 Live Market Data</p>
                <div class="space-y-2">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Symbol:</span>
                        <span class="font-mono font-bold">${config.symbol}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Current Price:</span>
                        <span id="currentPrice" class="font-mono font-bold">0.00000000</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Leverage:</span>
                        <span class="font-mono">${config.leverage}x</span>
                    </div>
                </div>
            </div>
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-3">🎯 Position Info</p>
                <div class="space-y-2">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Position Size:</span>
                        <span id="positionSize" class="font-mono">0</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Avg Entry:</span>
                        <span id="avgPrice" class="font-mono">0.00000000</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Safety Orders:</span>
                        <span id="safetyCount" class="font-mono">0</span>
                    </div>
                </div>
            </div>
            <div class="card">
                <p class="text-gray-500 text-xs uppercase font-bold mb-3">⚙️ Quick Actions</p>
                <div class="space-y-3">
                    <button onclick="resetStats()" class="btn btn-danger w-full text-sm">Reset Profit Stats</button>
                    <p class="text-gray-400 text-xs text-center">Resets starting point to current balance</p>
                </div>
            </div>
        </div>

        <!-- Settings -->
        <div class="card">
            <h2 class="font-bold mb-4">⚙️ Strategy Settings</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Auto Scale</label>
                    <input type="checkbox" id="autoScale" onchange="toggleAuto()" class="w-5 h-5">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Base Order</label>
                    <input type="number" id="baseOrder" class="input-field">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Price Drop %</label>
                    <input type="number" step="0.1" id="priceDrop" class="input-field">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Take Profit %</label>
                    <input type="number" step="0.1" id="takeProfit" class="input-field">
                </div>
            </div>
            <div class="mt-4">
                <button onclick="saveSettings()" class="btn btn-primary w-full md:w-auto">💾 Save Settings</button>
            </div>
        </div>
    </div>

    <script>
        let autoRefresh = null;
        
        async function refresh() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                // Update displays
                const profitElem = document.getElementById('realProfit');
                profitElem.innerText = (data.realizedProfit >= 0 ? '+' : '') + data.realizedProfit.toFixed(4) + ' USDT';
                profitElem.className = 'stat-value ' + (data.realizedProfit >= 0 ? 'positive' : 'negative');
                
                const pctElem = document.getElementById('profitPct');
                pctElem.innerText = (data.profitPct >= 0 ? '+' : '') + data.profitPct.toFixed(2) + '%';
                pctElem.className = 'stat-value ' + (data.profitPct >= 0 ? 'positive' : 'negative');
                
                const roiElem = document.getElementById('roi');
                roiElem.innerText = (data.roi >= 0 ? '+' : '') + data.roi.toFixed(2) + '%';
                roiElem.className = 'stat-value ' + (data.roi >= 0 ? 'positive' : 'negative');
                
                document.getElementById('balance').innerText = data.walletBalance.toFixed(4) + ' USDT';
                document.getElementById('currentPrice').innerText = data.currentPrice.toFixed(8);
                document.getElementById('positionSize').innerText = data.totalContracts;
                document.getElementById('avgPrice').innerText = data.avgPrice.toFixed(8);
                document.getElementById('safetyCount').innerText = data.safetyOrdersFilled;
                
                // Update form
                if (!window.isFirstLoad) {
                    document.getElementById('autoScale').checked = data.settings.autoScale;
                    document.getElementById('baseOrder').value = data.settings.baseOrder;
                    document.getElementById('priceDrop').value = data.settings.priceDrop;
                    document.getElementById('takeProfit').value = data.settings.takeProfit;
                    toggleAutoUI(data.settings.autoScale);
                    window.isFirstLoad = true;
                }
                
                if (data.settings.autoScale) {
                    document.getElementById('baseOrder').value = data.maxSafeBase;
                }
                
                // Update button and badge
                const toggleBtn = document.getElementById('toggleBtn');
                toggleBtn.textContent = data.isRunning ? '🛑 STOP ENGINE' : '▶️ START ENGINE';
                toggleBtn.className = data.isRunning ? 'btn btn-danger' : 'btn btn-primary';
                
                const badge = document.getElementById('statusBadge');
                badge.textContent = data.isRunning ? 'RUNNING' : 'STOPPED';
                badge.className = 'status-badge ' + (data.isRunning ? 'status-running' : 'status-stopped');
                
            } catch (error) {
                console.error('Refresh error:', error);
            }
        }
        
        function toggleAutoUI(checked) {
            const input = document.getElementById('baseOrder');
            input.disabled = checked;
            input.style.backgroundColor = checked ? '#f3f4f6' : 'white';
        }
        
        async function toggleAuto() {
            const autoScale = document.getElementById('autoScale').checked;
            toggleAutoUI(autoScale);
            await saveSettings();
        }
        
        async function toggleBot() {
            await fetch('/api/toggle', { method: 'POST' });
            refresh();
        }
        
        async function resetStats() {
            if (confirm('⚠️ Reset all profit statistics? Current balance will become the new starting point.\n\nRealized Profit and Profit % will be reset to 0.')) {
                await fetch('/api/reset-stats', { method: 'POST' });
                setTimeout(refresh, 500);
            }
        }
        
        async function saveSettings() {
            const settings = {
                autoScale: document.getElementById('autoScale').checked,
                baseOrder: parseFloat(document.getElementById('baseOrder').value),
                priceDrop: parseFloat(document.getElementById('priceDrop').value),
                takeProfit: parseFloat(document.getElementById('takeProfit').value),
                volumeMult: 1.2,
                maxSteps: 10
            };
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            setTimeout(refresh, 200);
        }
        
        window.isFirstLoad = false;
        setInterval(refresh, 1000);
        refresh();
    </script>
</body>
</html>
    `);
});

// ==================== API ENDPOINTS ====================
app.get('/api/status', (req, res) => {
    res.json({
        isRunning: botState.isRunning,
        currentPrice: botState.currentPrice,
        avgPrice: botState.avgPrice,
        totalContracts: botState.totalContracts,
        roi: botState.roi,
        pnl: botState.pnl,
        realizedProfit: botState.realizedProfit,
        profitPct: botState.profitPct,
        safetyOrdersFilled: botState.safetyOrdersFilled,
        walletBalance: botState.walletBalance,
        initialBalance: botState.initialBalance,
        maxSafeBase: botState.maxSafeBase,
        settings: botState.settings,
        lastError: botState.lastError
    });
});

app.post('/api/toggle', async (req, res) => { 
    botState.isRunning = !botState.isRunning; 
    await saveToDb(); 
    console.log(`🔄 Bot ${botState.isRunning ? 'STARTED' : 'STOPPED'} by user`);
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
    console.log('⚙️ Settings updated:', botState.settings);
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
