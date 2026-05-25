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
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 20,
    port: process.env.PORT || 3000,
    host: 'api.htx.com' // Do not include https://
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
        safetyOrder: 7000,
        priceDrop: 0.1,       // 0.1% drop per step
        volumeMult: 1.2,      // Size increases 1.2x per step
        priceMult: 1.0,       // Linear spacing
        takeProfit: 0.15,     // 0.15% ROI target
        maxSafetyOrders: 10
    }
};

// ==================== ✅ CORRECT HTX V3 API METHOD ====================
async function htxRequest(method, path, data = {}) {
    // 1. UTC Timestamp (No milliseconds)
    const timestamp = new Date().toISOString().split('.')[0];
    
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };

    // 2. Sort parameters and build query string for signature
    const sortedQuery = Object.keys(params).sort().map(key => 
        `${key}=${encodeURIComponent(params[key])}`
    ).join('&');

    // 3. Construct signature payload
    const payload = [
        method.toUpperCase(),
        config.host,
        path,
        sortedQuery
    ].join('\n');

    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');

    // 4. Construct Final URL (Auth in query string, Data in body)
    const url = `https://${config.host}${path}?${sortedQuery}&Signature=${encodeURIComponent(signature)}`;

    try {
        const response = await axios({
            method,
            url,
            data: method.toUpperCase() === 'POST' ? data : null,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.status !== 'ok') {
            throw new Error(response.data['err-msg'] || JSON.stringify(response.data));
        }
        return response.data;
    } catch (error) {
        console.error(`❌ API Error [${path}]:`, error.response?.data || error.message);
        return null;
    }
}

// ==================== TRADING LOGIC ====================
async function updateBotState() {
    // 1. Get Public Market Price
    try {
        const res = await axios.get(`https://${config.host}/linear-swap-ex/market/detail/merged?symbol=${config.symbol}`);
        bot.currentPrice = res.data.tick.close;
    } catch (e) {}

    if (!bot.isRunning) return;

    // 2. Get Private Position Info via V3 Path
    const posRes = await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    if (pos) {
        bot.avgPrice = parseFloat(pos.cost_hold);
        bot.totalContracts = parseFloat(pos.volume);
        bot.roi = parseFloat(pos.profit_ratio) * 100;
        bot.pnl = parseFloat(pos.unrealized_pnl);

        // A. Check Take Profit
        if (bot.roi >= bot.settings.takeProfit) {
            console.log("🎯 Take Profit Hit! Closing position...");
            await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: bot.totalContracts,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            bot.safetyOrdersFilled = 0;
            return;
        }

        // B. Check Safety Order (Addition Order)
        const dropNeeded = bot.settings.priceDrop * Math.pow(bot.settings.priceMult, bot.safetyOrdersFilled);
        const triggerPrice = bot.avgPrice * (1 - (dropNeeded / 100));

        if (bot.currentPrice <= triggerPrice && bot.safetyOrdersFilled < bot.settings.maxSafetyOrders) {
            bot.safetyOrdersFilled++;
            const vol = Math.floor(bot.settings.safetyOrder * Math.pow(bot.settings.volumeMult, bot.safetyOrdersFilled - 1));
            
            console.log(`📉 Price drop! Adding Order #${bot.safetyOrdersFilled} (Vol: ${vol})`);
            await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        // C. No position? Open Base Order
        console.log("🚀 Starting new cycle...");
        await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: bot.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
        bot.safetyOrdersFilled = 0;
    }
}

setInterval(updateBotState, 4000);

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <title>HTX Martingale V3</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background-color: #0b0e11; color: #eaecef; font-family: sans-serif; }
            .htx-card { background-color: #1e2329; border: 1px solid #30363d; border-radius: 8px; }
            .htx-input { background-color: #2b3139; border: 1px solid #474d57; color: white; border-radius: 4px; padding: 8px; }
            .htx-blue { color: #3275ff; }
            .btn-action { background-color: #3275ff; color: white; padding: 10px 24px; border-radius: 4px; font-weight: bold; }
        </style>
    </head>
    <body class="p-10">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-center mb-10">
                <h1 class="text-2xl font-bold italic"><span class="htx-blue">HTX</span> Martingale Strategy</h1>
                <div class="flex gap-4">
                    <button onclick="toggleBot()" id="btnAction" class="btn-action">START BOT</button>
                </div>
            </header>

            <div class="grid grid-cols-12 gap-8">
                <!-- Data Panel -->
                <div class="col-span-8 space-y-6">
                    <div class="htx-card p-6 grid grid-cols-4 gap-4">
                        <div>
                            <p class="text-xs text-gray-400 uppercase mb-2">Unrealized PnL</p>
                            <p id="pnl" class="text-xl font-bold text-green-500">0.0000</p>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 uppercase mb-2">Current ROI</p>
                            <p id="roi" class="text-xl font-bold text-green-500">0.00%</p>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 uppercase mb-2">Last Price</p>
                            <p id="price" class="text-xl font-bold">0.000000</p>
                        </div>
                        <div>
                            <p class="text-xs text-gray-400 uppercase mb-2">DCA Steps</p>
                            <p id="steps" class="text-xl font-bold">0 / 10</p>
                        </div>
                    </div>
                    <div class="htx-card h-64 flex items-center justify-center border-dashed border-2 border-gray-700 font-bold text-gray-600 uppercase tracking-widest">
                        Live Execution Chart
                    </div>
                </div>

                <!-- Settings Sidebar -->
                <div class="col-span-4 htx-card p-6">
                    <h3 class="font-bold border-b border-gray-700 pb-3 mb-6 uppercase text-sm">Bot Configuration</h3>
                    <div class="space-y-4">
                        <div><label class="text-xs text-gray-400 block mb-1">Base Order (Qty)</label><input id="baseOrder" type="number" class="w-full htx-input" value="${bot.settings.baseOrder}"></div>
                        <div><label class="text-xs text-gray-400 block mb-1">Safety Order (Qty)</label><input id="safetyOrder" type="number" class="w-full htx-input" value="${bot.settings.safetyOrder}"></div>
                        <div class="grid grid-cols-2 gap-4">
                            <div><label class="text-xs text-gray-400 block mb-1">Drop %</label><input id="priceDrop" type="number" class="w-full htx-input" value="${bot.settings.priceDrop}"></div>
                            <div><label class="text-xs text-gray-400 block mb-1">TP ROI %</label><input id="takeProfit" type="number" class="w-full htx-input" value="${bot.settings.takeProfit}"></div>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div><label class="text-xs text-gray-400 block mb-1">Vol Multiplier</label><input id="volumeMult" type="number" class="w-full htx-input" value="${bot.settings.volumeMult}"></div>
                            <div><label class="text-xs text-gray-400 block mb-1">Max Steps</label><input id="maxSteps" type="number" class="w-full htx-input" value="${bot.settings.maxSafetyOrders}"></div>
                        </div>
                        <button onclick="updateSettings()" class="w-full mt-4 py-2 border border-gray-600 rounded text-sm hover:bg-gray-800 transition font-bold uppercase">Update Strategy</button>
                    </div>
                </div>
            </div>
        </div>

        <script>
            async function updateUI() {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('pnl').innerText = d.pnl.toFixed(4);
                document.getElementById('pnl').className = d.pnl >= 0 ? 'text-xl font-bold text-green-500' : 'text-xl font-bold text-red-500';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').className = d.roi >= 0 ? 'text-xl font-bold text-green-500' : 'text-xl font-bold text-red-500';
                document.getElementById('price').innerText = d.currentPrice;
                document.getElementById('steps').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSafetyOrders;
                
                const btn = document.getElementById('btnAction');
                btn.innerText = d.isRunning ? 'STOP BOT' : 'START BOT';
                btn.className = d.isRunning ? 'px-6 py-2 rounded font-bold bg-red-600' : 'btn-action';
            }

            async function toggleBot() { await fetch('/api/toggle', {method: 'POST'}); updateUI(); }

            async function updateSettings() {
                const settings = {
                    baseOrder: parseFloat(document.getElementById('baseOrder').value),
                    safetyOrder: parseFloat(document.getElementById('safetyOrder').value),
                    priceDrop: parseFloat(document.getElementById('priceDrop').value),
                    takeProfit: parseFloat(document.getElementById('takeProfit').value),
                    volumeMult: parseFloat(document.getElementById('volumeMult').value),
                    maxSafetyOrders: parseInt(document.getElementById('maxSteps').value),
                    priceMult: 1.0
                };
                await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
                alert('Strategy Updated');
            }
            setInterval(updateUI, 2000);
        </script>
    </body>
    </html>
    `);
});

// ==================== API ENDPOINTS ====================
app.get('/api/status', (req, res) => res.json(bot));
app.post('/api/toggle', (req, res) => { bot.isRunning = !bot.isRunning; res.sendStatus(200); });
app.post('/api/settings', (req, res) => { bot.settings = req.body; res.sendStatus(200); });

app.listen(config.port, () => console.log(`🚀 Dashboard: http://localhost:${config.port}`));
