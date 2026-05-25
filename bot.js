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
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0,
    pnl: 0,
    safetyOrdersFilled: 0,
    walletBalance: 0,
    maxSafeBase: 0, // Geometric calculation result
    settings: {
        baseOrder: 6000,
        autoScale: true,     // ✅ New Feature
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 0.15,    
        maxSteps: 10
    }
};

// ==================== ✅ MATH: GEOMETRIC MAX BASE ====================
function calculateMaxBase() {
    if (botState.currentPrice === 0 || botState.walletBalance === 0) return;
    
    const m = botState.settings.volumeMult;
    const n = botState.settings.maxSteps;
    const price = botState.currentPrice;
    
    // Sum of multipliers: 1 + 1.2^1 + 1.2^2 ... + 1.2^10
    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
    
    // Total USDT value we can hold = Balance * Leverage
    const totalUsdtCapacity = botState.walletBalance * config.leverage;
    
    // Face value for SHIB is usually 1000 or 1. Let's assume 1000 for standard SHIB-USDT
    const faceValue = 1000; 
    
    // Base = Total / (Sum * Price * FaceValue)
    const rawBase = totalUsdtCapacity / (multiplierSum * price * faceValue);
    
    // 10% safety buffer for fees and slippage
    botState.maxSafeBase = Math.floor(rawBase * 0.90);
    
    if (botState.settings.autoScale) {
        botState.settings.baseOrder = botState.maxSafeBase;
    }
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
                calculateMaxBase();
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

    const balRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', {});
    botState.walletBalance = balRes?.data?.find(a => a.margin_asset === 'USDT')?.margin_balance || 0;

    const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

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
            const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: botState.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        botState.safetyOrdersFilled = 0;
    }
}

// ==================== DASHBOARD UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBot | HTX AI Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f1f1f1; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; transition: all 0.2s; }
        .input-disabled { background: #eeeeee !important; color: #888; cursor: not-allowed; border-color: #ddd; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 12px 24px; font-size: 14px; font-weight: 500; transition: background 0.2s; }
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
        <div class="lg:col-span-8 space-y-8">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Unrealized PnL</p><p id="pnl" class="text-2xl font-mono font-bold">$0.0000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Live ROI</p><p id="roi" class="text-2xl font-mono font-bold text-blue-600">0.00%</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">SHIB Price</p><p id="price" class="text-2xl font-mono font-bold">0.000000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">USDT Balance</p><p id="balance" class="text-2xl font-mono font-bold text-gray-800">$0.00</p></div>
            </div>

            <div class="ui-card p-8 h-64 flex flex-col items-center justify-center border-2 border-dashed border-gray-200">
                 <p class="text-gray-400 font-bold uppercase tracking-widest text-[10px] mb-2">Calculated Max Safe Base (10 Steps)</p>
                 <p id="recBaseDisplay" class="text-5xl font-mono font-bold text-black">0</p>
                 <p class="text-gray-300 text-[9px] mt-4 font-bold">100% Margin Utilization Threshold</p>
            </div>
        </div>

        <div class="lg:col-span-4 space-y-6">
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6 flex items-center gap-2 pb-2 border-b border-gray-50 uppercase text-xs tracking-widest text-gray-400">
                    <span class="material-symbols-outlined text-lg">tune</span> Strategy Config
                </h3>
                <div class="space-y-4">
                    <div class="flex items-center justify-between p-3 bg-blue-50 rounded-lg mb-2">
                        <span class="text-[10px] font-bold text-blue-700 uppercase">Auto-Scale Base Order</span>
                        <input type="checkbox" id="autoScale" ${botState.settings.autoScale ? 'checked' : ''} onchange="toggleAuto()">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-gray-500 mb-1 block">Base Order (Qty)</label>
                        <input id="baseOrder" type="number" class="input-minimal font-mono ${botState.settings.autoScale ? 'input-disabled' : ''}" ${botState.settings.autoScale ? 'disabled' : ''} value="${botState.settings.baseOrder}">
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">Drop (%)</label><input id="priceDrop" type="number" class="input-minimal font-mono" value="${botState.settings.priceDrop}"></div>
                        <div><label class="text-xs font-bold text-gray-500 mb-1 block">TP (%)</label><input id="takeProfit" type="number" class="input-minimal font-mono" value="${botState.settings.takeProfit}"></div>
                    </div>
                    <div><label class="text-xs font-bold text-gray-500 mb-1 block">Volume Multiplier</label><input id="volumeMult" type="number" class="input-minimal font-mono" value="${botState.settings.volumeMult}"></div>
                    <button onclick="saveSettings()" class="btn-primary w-full mt-4 flex items-center justify-center gap-2 shadow-sm font-bold text-xs uppercase tracking-widest">
                        Update Strategy
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
            document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
            document.getElementById('price').innerText = d.currentPrice;
            document.getElementById('balance').innerText = '$' + parseFloat(d.walletBalance).toFixed(2);
            document.getElementById('recBaseDisplay').innerText = d.maxSafeBase.toLocaleString();
            
            if(d.settings.autoScale) {
                document.getElementById('baseOrder').value = d.maxSafeBase;
            }

            const btn = document.getElementById('mainAction');
            if(d.isRunning) { btn.innerText = 'STOP ENGINE'; btn.className = 'btn-primary bg-red-600 hover:bg-red-700 py-2 px-6'; }
            else { btn.innerText = 'START ENGINE'; btn.className = 'btn-primary py-2 px-6'; }
        }

        async function toggleAuto() {
            const isChecked = document.getElementById('autoScale').checked;
            const input = document.getElementById('baseOrder');
            if(isChecked) { input.classList.add('input-disabled'); input.disabled = true; }
            else { input.classList.remove('input-disabled'); input.disabled = false; }
            await saveSettings();
        }

        async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
        async function saveSettings() {
            const body = {
                autoScale: document.getElementById('autoScale').checked,
                baseOrder: parseFloat(document.getElementById('baseOrder').value),
                priceDrop: parseFloat(document.getElementById('priceDrop').value),
                takeProfit: parseFloat(document.getElementById('takeProfit').value),
                volumeMult: parseFloat(document.getElementById('volumeMult').value)
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
app.post('/api/toggle', (req, res) => { botState.isRunning = !botState.isRunning; res.sendStatus(200); });
app.post('/api/settings', (req, res) => { botState.settings = { ...botState.settings, ...req.body }; res.sendStatus(200); });

app.listen(config.port, async () => {
    // Force Leverage 10 on start
    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_switch_lever_rate', { contract_code: config.symbol, lever_rate: config.leverage });
    initWebSocket();
    setInterval(logicLoop, 4000);
});
