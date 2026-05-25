require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==================== BOT CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: 'SHIB-USDT',
    leverage: 10,
    port: process.env.PORT || 3000,
    // Use api.htx.com for Unified Accounts
    host: 'api.htx.com' 
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
        priceDrop: 0.1,       // 0.1%
        volumeMult: 1.2,
        priceMult: 1.0,
        takeProfit: 0.15,     // 0.15%
        maxSafetyOrders: 10
    }
};

// ==================== ✅ FIXED HTX PRIVATE API METHOD ====================
async function htxRequest(method, path, data = {}) {
    // 1. Timestamp MUST NOT have milliseconds
    const timestamp = new Date().toISOString().split('.')[0];
    
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };

    // 2. Sort parameters alphabetically
    const sortedQuery = Object.keys(params).sort().map(key => 
        `${key}=${encodeURIComponent(params[key])}`
    ).join('&');

    // 3. Create Signature (Method + Host + Path + SortedQuery)
    const payload = [
        method.toUpperCase(),
        config.host,
        path,
        sortedQuery
    ].join('\n');

    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');

    // 4. Construct URL
    const url = `https://${config.host}${path}?${sortedQuery}&Signature=${encodeURIComponent(signature)}`;

    try {
        const response = await axios({
            method,
            url,
            data: method.toUpperCase() === 'POST' ? data : null,
            headers: { 
                'Content-Type': 'application/json',
                // ✅ ADDED USER-AGENT TO FIX 403 CLOUDFLARE BLOCK
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 5000
        });

        if (response.data.status !== 'ok') {
            console.error(`HTX Business Error: ${response.data['err-msg']}`);
            return null;
        }
        return response.data;
    } catch (error) {
        // If it's a 403, we are being throttled or blocked by Cloudflare
        console.error(`❌ API Error [${path}]: ${error.response?.status || error.message}`);
        return null;
    }
}

// ==================== TRADING LOGIC ====================
async function updateBotState() {
    // 1. Get Market Price (Public)
    try {
        const res = await axios.get(`https://${config.host}/linear-swap-ex/market/detail/merged?symbol=${config.symbol}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        bot.currentPrice = res.data.tick.close;
    } catch (e) {
        console.error("Public Price Fetch Error");
    }

    if (!bot.isRunning) return;

    // 2. Get Position (Private) - REMOVED /v3/ TO FIX 404
    const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    if (pos) {
        bot.avgPrice = parseFloat(pos.cost_hold);
        bot.totalContracts = parseFloat(pos.volume);
        bot.roi = parseFloat(pos.profit_ratio) * 100;
        bot.pnl = parseFloat(pos.unrealized_pnl);

        // Take Profit Check
        if (bot.roi >= bot.settings.takeProfit) {
            console.log("🎯 Target ROI met. Closing position.");
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
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
            console.log(`📉 Adding Safety Order #${bot.safetyOrdersFilled}`);
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        // No position? Open Base Order
        console.log("🚀 Starting cycle with Base Order");
        await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: bot.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        bot.safetyOrdersFilled = 0;
    }
}

// Run loop every 4 seconds to avoid spamming Cloudflare
setInterval(updateBotState, 4000);

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <title>HTX Martingale V3 Fix</title>
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
                <h1 class="text-2xl font-bold italic"><span class="htx-blue">HTX</span> Martingale (Fixed)</h1>
                <button onclick="toggleBot()" id="btnAction" class="btn-action">START BOT</button>
            </header>

            <div class="grid grid-cols-12 gap-8">
                <div class="col-span-8 htx-card p-6 grid grid-cols-4 gap-4">
                    <div><p class="text-xs text-gray-400 mb-1 uppercase">PnL</p><p id="pnl" class="text-xl font-bold">0.0000</p></div>
                    <div><p class="text-xs text-gray-400 mb-1 uppercase">ROI</p><p id="roi" class="text-xl font-bold">0.00%</p></div>
                    <div><p class="text-xs text-gray-400 mb-1 uppercase">Price</p><p id="price" class="text-xl font-bold">0.000000</p></div>
                    <div><p class="text-xs text-gray-400 mb-1 uppercase">Safety</p><p id="steps" class="text-xl font-bold">0 / 10</p></div>
                </div>
                <div class="col-span-4 htx-card p-6">
                    <h3 class="font-bold mb-4 border-b border-gray-700 pb-2">Settings</h3>
                    <p class="text-sm">Base: ${bot.settings.baseOrder} SHIB</p>
                    <p class="text-sm">Drop: ${bot.settings.priceDrop}%</p>
                    <p class="text-sm">TP: ${bot.settings.takeProfit}%</p>
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
            }
            async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); refresh(); }
            setInterval(refresh, 2000);
        </script>
    </body>
    </html>
    `);
});

app.get('/api/status', (req, res) => res.json(bot));
app.post('/api/toggle', (req, res) => { bot.isRunning = !bot.isRunning; res.sendStatus(200); });

app.listen(config.port, () => console.log(`🚀 Bot listening on port ${config.port}`));
