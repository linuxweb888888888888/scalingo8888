require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib'); // Required to decompress HTX data

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: 'SHIB-USDT',
    leverage: 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com', // Direct Backend for Linear Swaps
    wsHost: 'wss://api.hbdm.com/linear-swap-ws' // Market Data WebSocket
};

// ==================== BOT STATE ====================
let bot = {
    isRunning: false,
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0,
    pnl: 0,
    safetyOrdersFilled: 0,
    settings: {
        baseOrder: 6000,
        priceDrop: 0.1,    // 0.1%
        volumeMult: 1.2,   // 1.2x
        priceMult: 1.0,
        takeProfit: 0.15,  // 0.15%
        maxSafetyOrders: 10
    }
};

// ==================== ✅ WEBSOCKET PRICE ENGINE ====================
function initWebSocket() {
    const ws = new WebSocket(config.wsHost);

    ws.on('open', () => {
        console.log('🌐 Price WebSocket Connected');
        // Subscribe to Market Detail for the symbol
        const subMsg = JSON.stringify({
            sub: `market.${config.symbol}.detail`,
            id: 'shib_bot_price'
        });
        ws.send(subMsg);
    });

    ws.on('message', (data) => {
        // HTX sends compressed binary data (Gzip)
        const payload = zlib.gunzipSync(data);
        const msg = JSON.parse(payload.toString());

        // Handle Heartbeat (Ping/Pong)
        if (msg.ping) {
            ws.send(JSON.stringify({ pong: msg.ping }));
            return;
        }

        // Update Price from Tick
        if (msg.tick && msg.tick.close) {
            bot.currentPrice = msg.tick.close;
        }
    });

    ws.on('error', (err) => console.error('WS Error:', err.message));
    ws.on('close', () => {
        console.log('WS Closed. Reconnecting...');
        setTimeout(initWebSocket, 2000);
    });
}

// ==================== ✅ REST API FOR ORDERS ====================
async function htxPrivateRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };
    const sortedQuery = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedQuery].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${sortedQuery}&Signature=${encodeURIComponent(signature)}`;

    try {
        const response = await axios({
            method,
            url,
            data: method === 'POST' ? data : null,
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });
        return response.data;
    } catch (error) {
        console.error(`Order API Error: ${error.message}`);
        return null;
    }
}

// ==================== TRADING LOGIC ====================
async function logicLoop() {
    if (!bot.isRunning || bot.currentPrice === 0) return;

    // 1. Sync Position Info
    const posRes = await htxPrivateRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    if (pos) {
        bot.avgPrice = parseFloat(pos.cost_hold);
        bot.totalContracts = parseFloat(pos.volume);
        bot.roi = parseFloat(pos.profit_ratio) * 100;
        bot.pnl = parseFloat(pos.unrealized_pnl);

        // Take Profit Check
        if (bot.roi >= bot.settings.takeProfit) {
            console.log("🎯 Take Profit Reached");
            await htxPrivateRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: bot.totalContracts,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            bot.safetyOrdersFilled = 0;
            return;
        }

        // Safety Order Check
        const dropThreshold = bot.settings.priceDrop * Math.pow(bot.settings.priceMult, bot.safetyOrdersFilled);
        const triggerPrice = bot.avgPrice * (1 - (dropThreshold / 100));

        if (bot.currentPrice <= triggerPrice && bot.safetyOrdersFilled < bot.settings.maxSafetyOrders) {
            bot.safetyOrdersFilled++;
            const vol = Math.floor(bot.settings.baseOrder * Math.pow(bot.settings.volumeMult, bot.safetyOrdersFilled));
            console.log(`📉 Adding Order #${bot.safetyOrdersFilled} | Qty: ${vol}`);
            await htxPrivateRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        // Open Base Order
        console.log("🚀 Starting Base Order");
        await htxPrivateRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: bot.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        bot.safetyOrdersFilled = 0;
    }
}

// ==================== DASHBOARD UI ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>HTX Martingale WS</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background-color: #0b0e11; color: #eaecef; font-family: sans-serif; }
            .htx-card { background-color: #1e2329; border: 1px solid #30363d; border-radius: 8px; }
            .htx-blue { color: #3275ff; }
            .btn-action { background-color: #3275ff; color: white; padding: 10px 24px; border-radius: 4px; font-weight: bold; }
        </style>
    </head>
    <body class="p-10">
        <div class="max-w-5xl mx-auto">
            <header class="flex justify-between items-center mb-10">
                <h1 class="text-2xl font-bold italic"><span class="htx-blue">HTX</span> Martingale (WS Mode)</h1>
                <button onclick="toggleBot()" id="btnAction" class="btn-action">START BOT</button>
            </header>
            <div class="grid grid-cols-12 gap-8">
                <div class="col-span-8 htx-card p-6 grid grid-cols-4 gap-4">
                    <div><p class="text-xs text-gray-400 uppercase">PnL</p><p id="pnl" class="text-xl font-bold text-green-500">0.0000</p></div>
                    <div><p class="text-xs text-gray-400 uppercase">ROI</p><p id="roi" class="text-xl font-bold text-green-500">0.00%</p></div>
                    <div><p class="text-xs text-gray-400 uppercase">Price</p><p id="price" class="text-xl font-bold">0.000000</p></div>
                    <div><p class="text-xs text-gray-400 uppercase">Steps</p><p id="steps" class="text-xl font-bold">0 / 10</p></div>
                </div>
                <div class="col-span-4 htx-card p-6">
                    <p class="text-sm">Base Order: ${bot.settings.baseOrder}</p>
                    <p class="text-sm">Volume Mult: ${bot.settings.volumeMult}x</p>
                    <p id="wsStatus" class="text-xs text-blue-400 mt-4">WebSocket: Connecting...</p>
                </div>
            </div>
        </div>
        <script>
            async function refresh() {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('pnl').innerText = d.pnl.toFixed(4);
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('price').innerText = d.currentPrice;
                document.getElementById('steps').innerText = d.safetyOrdersFilled + ' / 10';
                document.getElementById('btnAction').innerText = d.isRunning ? 'STOP BOT' : 'START BOT';
                document.getElementById('wsStatus').innerText = 'WebSocket: ' + (d.currentPrice > 0 ? 'Live Data' : 'Waiting...');
            }
            async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
            setInterval(refresh, 1000);
        </script>
    </body>
    </html>
    `);
});

// ==================== START ====================
app.get('/api/status', (req, res) => res.json(bot));
app.post('/api/toggle', (req, res) => { bot.isRunning = !bot.isRunning; res.sendStatus(200); });

app.listen(config.port, () => {
    console.log(`🚀 Bot listening on port ${config.port}`);
    initWebSocket();
    setInterval(logicLoop, 4000); // Private API logic
});
