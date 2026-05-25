require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== BOT CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: 10,
    contractFaceValue: 1000, // HTX SHIB-USDT usually 1 contract = 1,000 or 1,000,000 SHIB
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0,
    pnl: 0,
    safetyOrdersFilled: 0,
    walletBalance: 0,
    maxPossibleBase: 0, // Calculated automatically
    settings: {
        baseOrder: 6000, 
        autoScale: true,    // ✅ New: Auto-calculate base order
        priceDrop: 0.1,     
        volumeMult: 1.2,    
        takeProfit: 0.15,   
        maxSteps: 10
    }
};

// ==================== ✅ MATH: MAX BASE ORDER CALCULATION ====================
function calculateRecommendedBase() {
    if (botState.currentPrice === 0 || botState.walletBalance === 0) return;

    const m = botState.settings.volumeMult;
    const n = botState.settings.maxSteps;
    
    // Sum of geometric series: 1 + m^1 + m^2 ... + m^n
    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
    
    // Total USDT value we can handle = Balance * Leverage
    const maxTotalUsdtValue = botState.walletBalance * config.leverage;
    
    // Base Order = Total USDT / (Sum of Multipliers * Price * FaceValue)
    const rawBase = maxTotalUsdtValue / (multiplierSum * botState.currentPrice * config.contractFaceValue);
    
    botState.maxPossibleBase = Math.floor(rawBase * 0.95); // 5% buffer for fees/slippage
}

// ==================== WEBSOCKET & PRIVATE API ====================
function initWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'price_feed' }));
    });
    ws.on('message', (data) => {
        try {
            const payload = zlib.gunzipSync(data);
            const msg = JSON.parse(payload.toString());
            if (msg.ping) return ws.send(JSON.stringify({ pong: msg.ping }));
            if (msg.tick && msg.tick.close) {
                botState.currentPrice = msg.tick.close;
                calculateRecommendedBase(); // Recalculate on price move
            }
        } catch (e) {}
    });
    ws.on('close', () => setTimeout(initWebSocket, 2000));
}

async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;

    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function logicLoop() {
    if (!botState.isRunning || botState.currentPrice === 0) return;

    // Sync Balance
    const balRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {});
    botState.walletBalance = balRes?.data?.find(a => a.margin_asset === 'USDT')?.margin_balance || 0;

    const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    // ✅ If Auto-Scale is ON, use the calculated base
    const activeBase = botState.settings.autoScale ? botState.maxPossibleBase : botState.settings.baseOrder;

    if (pos) {
        botState.avgPrice = parseFloat(pos.cost_hold);
        botState.totalContracts = parseFloat(pos.volume);
        botState.roi = parseFloat(pos.profit_ratio) * 100;
        botState.pnl = parseFloat(pos.unrealized_pnl);

        if (botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.totalContracts,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }

        const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
        if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
            botState.safetyOrdersFilled++;
            const vol = Math.floor(activeBase * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: activeBase,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        botState.safetyOrdersFilled = 0;
    }
}

// ==================== UI DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBot | Smart Martingale</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; }
        .ui-card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
    </style>
</head>
<body class="antialiased min-h-screen">
    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50 px-6 h-16 flex items-center justify-between">
        <div class="flex items-center gap-2">
            <div class="w-9 h-9 rounded-full bg-gray-800 flex items-center justify-center shadow-lg"><span class="material-symbols-outlined text-white text-[20px]">bolt</span></div>
            <span class="font-bold text-lg">TradeBot <span class="text-blue-600">SmartScale</span></span>
        </div>
        <div class="flex items-center gap-4">
            <span id="statusBadge" class="text-[10px] bg-gray-100 px-3 py-1 rounded-full uppercase font-bold tracking-wide">Ready</span>
            <button onclick="toggleBot()" id="mainAction" class="bg-black text-white rounded-lg py-2 px-6 font-medium">START ENGINE</button>
        </div>
    </header>

    <main class="max-w-7xl mx-auto w-full px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div class="lg:col-span-8 space-y-8">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Unrealized PnL</p><p id="pnl" class="text-2xl font-mono font-bold">$0.0000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">ROI</p><p id="roi" class="text-2xl font-mono font-bold text-blue-600">0.00%</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">SHIB Price</p><p id="price" class="text-2xl font-mono font-bold">0.000000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Wallet (USDT)</p><p id="balance" class="text-2xl font-mono font-bold text-gray-800">$0.00</p></div>
            </div>

            <div class="ui-card p-8 text-center border-2 border-dashed border-gray-200">
                <p class="text-gray-400 uppercase text-xs font-bold mb-2">Maximum Safe Base Order (10 Steps)</p>
                <p id="recBase" class="text-5xl font-mono font-bold text-gray-800">0</p>
                <p class="text-gray-400 text-[10px] mt-2">Automatically calculated to utilize 100% margin at Step 10</p>
            </div>
        </div>

        <div class="lg:col-span-4 space-y-6">
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6 uppercase text-xs tracking-widest text-gray-400 border-b pb-2">Configuration</h3>
                <div class="space-y-4">
                    <div class="flex items-center justify-between p-3 bg-blue-50 rounded-lg">
                        <label class="text-xs font-bold text-blue-800">Auto-Scale Base Order</label>
                        <input type="checkbox" id="autoScale" ${botState.settings.autoScale ? 'checked' : ''} onchange="updateCheck()">
                    </div>
                    <div><label class="text-xs font-bold text-gray-500 mb-1 block">Manual Base Qty</label><input id="baseOrder" type="number" class="w-full bg-gray-50 border rounded-lg p-2 font-mono" value="${botState.settings.baseOrder}"></div>
                    <div class="grid grid-cols-2 gap-4">
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">Drop %</label><input id="priceDrop" type="number" class="w-full bg-gray-50 border rounded-lg p-2 font-mono" value="${botState.settings.priceDrop}"></div>
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">TP %</label><input id="takeProfit" type="number" class="w-full bg-gray-50 border rounded-lg p-2 font-mono" value="${botState.settings.takeProfit}"></div>
                    </div>
                    <button onclick="saveSettings()" class="w-full bg-black text-white rounded-lg py-3 font-bold text-xs uppercase tracking-widest">Update Strategy</button>
                </div>
            </div>
        </div>
    </main>

    <script>
        async function refresh() {
            const r = await fetch('/api/status');
            const d = await r.json();
            document.getElementById('pnl').innerText = '$' + d.pnl.toFixed(4);
            document.getElementById('pnl').className = 'text-2xl font-mono font-bold ' + (d.pnl >= 0 ? 'text-green-500' : 'text-red-500');
            document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
            document.getElementById('price').innerText = d.currentPrice;
            document.getElementById('balance').innerText = '$' + parseFloat(d.walletBalance).toFixed(2);
            document.getElementById('recBase').innerText = d.maxPossibleBase.toLocaleString();

            const btn = document.getElementById('mainAction');
            if(d.isRunning) { btn.innerText = 'STOP ENGINE'; btn.className = 'bg-red-600 text-white rounded-lg py-2 px-6 font-medium'; }
            else { btn.innerText = 'START ENGINE'; btn.className = 'bg-black text-white rounded-lg py-2 px-6 font-medium'; }
        }
        async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
        async function updateCheck() { 
            const auto = document.getElementById('autoScale').checked;
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ autoScale: auto }) });
        }
        async function saveSettings() {
            const body = {
                baseOrder: parseFloat(document.getElementById('baseOrder').value),
                priceDrop: parseFloat(document.getElementById('priceDrop').value),
                takeProfit: parseFloat(document.getElementById('takeProfit').value),
                autoScale: document.getElementById('autoScale').checked
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Settings Updated");
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', (req, res) => { botState.isRunning = !botState.isRunning; res.sendStatus(200); });
app.post('/api/settings', (req, res) => { botState.settings = { ...botState.settings, ...req.body }; res.sendStatus(200); });

app.listen(config.port, async () => {
    initWebSocket();
    setInterval(logicLoop, 4000);
});
