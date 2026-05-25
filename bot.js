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
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    uptime: 0,
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0,
    pnl: 0,
    safetyOrdersFilled: 0,
    walletBalance: 0,
    startTime: Date.now(),
    settings: {
        baseOrder: 6000,
        priceDrop: 0.1,      // 0.1%
        volumeMult: 1.2,     // 1.2x
        takeProfit: 0.15,    // 0.15%
        maxSteps: 10
    }
};

// ==================== ✅ WEBSOCKET PRICE ENGINE ====================
function initWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'price_feed' }));
    });
    ws.on('message', (data) => {
        const payload = zlib.gunzipSync(data);
        const msg = JSON.parse(payload.toString());
        if (msg.ping) return ws.send(JSON.stringify({ pong: msg.ping }));
        if (msg.tick && msg.tick.close) botState.currentPrice = msg.tick.close;
    });
    ws.on('close', () => setTimeout(initWebSocket, 2000));
}

// ==================== ✅ V3 PRIVATE API METHOD ====================
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
            method, url, data: method === 'POST' ? data : null,
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function logicLoop() {
    if (!botState.isRunning || botState.currentPrice === 0) return;

    // 1. Sync Position & Balance
    const balRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {});
    botState.walletBalance = balRes?.data?.find(a => a.margin_asset === 'USDT')?.margin_balance || 0;

    const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    if (pos) {
        botState.avgPrice = parseFloat(pos.cost_hold);
        botState.totalContracts = parseFloat(pos.volume);
        botState.roi = parseFloat(pos.profit_ratio) * 100;
        botState.pnl = parseFloat(pos.unrealized_pnl);

        // Check TP
        if (botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.totalContracts,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }

        // Check Safety Order
        const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
        if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
            botState.safetyOrdersFilled++;
            const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        // Initial Order
        await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: botState.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        botState.safetyOrdersFilled = 0;
    }
}

// ==================== ORIGINAL DESIGN DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBot | HTX AI Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f1f1f1; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 12px 24px; font-size: 14px; font-weight: 500; transition: background 0.2s; }
        .btn-primary:hover { background: #374151; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center shadow-md relative overflow-hidden">
                    <span class="material-symbols-outlined text-white text-[20px]">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg">TradeBot<span class="text-blue-600">Pille</span></span>
            </div>
            <div class="flex items-center gap-4">
                <span id="statusBadge" class="text-[10px] bg-gray-100 px-3 py-1 rounded-full uppercase font-bold tracking-wide">Ready</span>
                <button onclick="toggleBot()" id="mainAction" class="btn-primary py-2 px-6">START ENGINE</button>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto w-full px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        <!-- DATA PANEL -->
        <div class="lg:col-span-8 space-y-8">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Unrealized PnL</p>
                    <p id="pnl" class="text-2xl font-mono font-bold">$0.0000</p>
                </div>
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Live ROI</p>
                    <p id="roi" class="text-2xl font-mono font-bold text-blue-600">0.00%</p>
                </div>
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">SHIB Price</p>
                    <p id="price" class="text-2xl font-mono font-bold">0.000000</p>
                </div>
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Balance</p>
                    <p id="balance" class="text-2xl font-mono font-bold text-gray-800">$0.00</p>
                </div>
            </div>

            <div class="ui-card p-8 h-80 flex flex-col items-center justify-center border-dashed border-2 border-gray-200">
                 <span class="material-symbols-outlined text-gray-200 text-6xl mb-4">monitoring</span>
                 <p class="text-gray-400 font-bold uppercase tracking-widest text-xs">Live Execution Visualizer</p>
            </div>

            <div class="ui-card p-6 overflow-hidden">
                <h3 class="text-sm font-bold uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                    <span class="material-symbols-outlined text-lg">receipt_long</span> Active Position Details
                </h3>
                <div class="grid grid-cols-3 gap-4 text-sm font-mono">
                    <div>Contracts: <b id="qty">0</b></div>
                    <div>Avg Entry: <b id="entry">0.00</b></div>
                    <div>DCA Steps: <b id="steps">0 / 10</b></div>
                </div>
            </div>
        </div>

        <!-- SETTINGS PANEL -->
        <div class="lg:col-span-4 space-y-6">
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6 flex items-center gap-2 pb-2 border-b border-gray-50 uppercase text-xs tracking-widest text-gray-400">
                    <span class="material-symbols-outlined text-lg">tune</span> Strategy Config
                </h3>
                <div class="space-y-4">
                    <div><label class="text-xs font-bold text-gray-500 mb-1 block">Base Order (Qty)</label><input id="baseOrder" type="number" class="input-minimal font-mono" value="${botState.settings.baseOrder}"></div>
                    <div class="grid grid-cols-2 gap-4">
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">Drop (%)</label><input id="priceDrop" type="number" class="input-minimal font-mono" value="${botState.settings.priceDrop}"></div>
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">TP (%)</label><input id="takeProfit" type="number" class="input-minimal font-mono" value="${botState.settings.takeProfit}"></div>
                    </div>
                    <div><label class="text-xs font-bold text-gray-500 mb-1 block">Volume Multiplier</label><input id="volumeMult" type="number" class="input-minimal font-mono" value="${botState.settings.volumeMult}"></div>
                    <button onclick="saveSettings()" class="btn-primary w-full mt-4 flex items-center justify-center gap-2 shadow-sm">
                        <span class="material-symbols-outlined text-lg">save</span> Update Strategy
                    </button>
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
            document.getElementById('roi').className = 'text-2xl font-mono font-bold ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
            document.getElementById('price').innerText = d.currentPrice;
            document.getElementById('balance').innerText = '$' + parseFloat(d.walletBalance).toFixed(2);
            document.getElementById('qty').innerText = d.totalContracts;
            document.getElementById('entry').innerText = d.avgPrice;
            document.getElementById('steps').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;

            const btn = document.getElementById('mainAction');
            const badge = document.getElementById('statusBadge');
            if(d.isRunning) {
                btn.innerText = 'STOP ENGINE'; btn.className = 'btn-primary bg-red-600 hover:bg-red-700 py-2 px-6';
                badge.innerText = 'Running'; badge.className = 'text-[10px] bg-green-100 text-green-700 px-3 py-1 rounded-full uppercase font-bold tracking-wide';
            } else {
                btn.innerText = 'START ENGINE'; btn.className = 'btn-primary py-2 px-6';
                badge.innerText = 'Stopped'; badge.className = 'text-[10px] bg-gray-100 text-gray-500 px-3 py-1 rounded-full uppercase font-bold tracking-wide';
            }
        }

        async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
        async function saveSettings() {
            const body = {
                baseOrder: parseFloat(document.getElementById('baseOrder').value),
                priceDrop: parseFloat(document.getElementById('priceDrop').value),
                takeProfit: parseFloat(document.getElementById('takeProfit').value),
                volumeMult: parseFloat(document.getElementById('volumeMult').value)
            };
            await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            alert("Configuration Saved");
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== API ENDPOINTS ====================
app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/toggle', (req, res) => { botState.isRunning = !botState.isRunning; res.sendStatus(200); });
app.post('/api/settings', (req, res) => { botState.settings = { ...botState.settings, ...req.body }; res.sendStatus(200); });

app.listen(config.port, () => {
    console.log(`🚀 Dashboard: http://localhost:${config.port}`);
    initWebSocket();
    setInterval(logicLoop, 4000);
});
