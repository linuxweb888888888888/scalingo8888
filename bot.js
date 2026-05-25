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
    leverage: 20,
    port: process.env.PORT || 3000,
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
    // Martingale Params (Cloned from HTX)
    settings: {
        baseOrder: 5000,
        safetyOrder: 5000,
        priceDrop: 0.8,       // %
        volumeMult: 1.5,
        priceMult: 1.1,
        takeProfit: 1.2,      // %
        maxSafetyOrders: 10
    }
};

// ==================== HTX V3 API INTERACTION ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.host, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.host}${path}?${query}&Signature=${encodeURIComponent(signature)}`;

    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null });
        return res.data;
    } catch (e) {
        console.error(`HTX API Error: ${e.message}`);
        return null;
    }
}

// ==================== TRADING LOGIC ====================
async function updateBotState() {
    // 1. Get Market Price
    try {
        const res = await axios.get(`https://${config.host}/linear-swap-ex/market/detail/merged?symbol=${config.symbol}`);
        bot.currentPrice = res.data.tick.close;
    } catch (e) {}

    if (!bot.isRunning) return;

    // 2. Get Position via V3
    const posRes = await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);

    if (pos) {
        bot.avgPrice = parseFloat(pos.cost_hold);
        bot.totalContracts = parseFloat(pos.volume);
        bot.roi = parseFloat(pos.profit_ratio) * 100;
        bot.pnl = parseFloat(pos.unrealized_pnl);

        // Take Profit Check
        if (bot.roi >= bot.settings.takeProfit) {
            await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: bot.totalContracts,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            bot.safetyOrdersFilled = 0;
        }

        // DCA / Safety Order Check
        const currentDropThreshold = bot.settings.priceDrop * Math.pow(bot.settings.priceMult, bot.safetyOrdersFilled);
        const triggerPrice = bot.avgPrice * (1 - (currentDropThreshold / 100));

        if (bot.currentPrice <= triggerPrice && bot.safetyOrdersFilled < bot.settings.maxSafetyOrders) {
            bot.safetyOrdersFilled++;
            const vol = Math.floor(bot.settings.safetyOrder * Math.pow(bot.settings.volumeMult, bot.safetyOrdersFilled - 1));
            await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: vol,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } else {
        // No position? Open Base Order
        await htxRequest('POST', '/v3/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: bot.settings.baseOrder,
            direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
        });
    }
}

setInterval(updateBotState, 3000);

// ==================== WEB INTERFACE ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>HTX Martingale Clone</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; background-color: #0b0e11; color: #eaecef; }
            .htx-card { background-color: #1e2329; border: 1px solid #30363d; }
            .htx-input { background-color: #2b3139; border: 1px solid #474d57; color: white; }
            .htx-blue { color: #3275ff; }
            .htx-btn-blue { background-color: #3275ff; }
        </style>
    </head>
    <body class="p-8">
        <div class="max-w-6xl mx-auto">
            <!-- Header -->
            <div class="flex justify-between items-center mb-8">
                <h1 class="text-2xl font-bold flex items-center gap-2">
                    <span class="htx-blue">HTX</span> Martingale Strategy
                </h1>
                <div class="flex gap-4">
                    <button onclick="toggleBot()" id="btnAction" class="px-6 py-2 rounded font-bold htx-btn-blue">START BOT</button>
                </div>
            </div>

            <div class="grid grid-cols-12 gap-6">
                <!-- Stats Panel -->
                <div class="col-span-8 space-y-6">
                    <div class="htx-card p-6 rounded-lg grid grid-cols-4 gap-4">
                        <div>
                            <p class="text-gray-400 text-xs mb-1">Total Profit (USDT)</p>
                            <p id="pnl" class="text-xl font-bold text-green-500">0.0000</p>
                        </div>
                        <div>
                            <p class="text-gray-400 text-xs mb-1">ROI</p>
                            <p id="roi" class="text-xl font-bold text-green-500">0.00%</p>
                        </div>
                        <div>
                            <p class="text-gray-400 text-xs mb-1">Last Price</p>
                            <p id="lastPrice" class="text-xl font-bold">0.000000</p>
                        </div>
                        <div>
                            <p class="text-gray-400 text-xs mb-1">Safety Orders</p>
                            <p id="safetyFilled" class="text-xl font-bold">0 / 10</p>
                        </div>
                    </div>

                    <div class="htx-card p-6 rounded-lg h-64 flex items-center justify-center border-dashed border-2 border-gray-700">
                        <p class="text-gray-500">Real-time PnL Chart Area</p>
                    </div>
                </div>

                <!-- Settings Sidebar -->
                <div class="col-span-4 htx-card p-6 rounded-lg">
                    <h3 class="font-bold mb-4 border-b border-gray-700 pb-2">Strategy Settings</h3>
                    <div class="space-y-4">
                        <div>
                            <label class="text-xs text-gray-400">Base Order Size (Contracts)</label>
                            <input id="baseOrder" type="number" class="w-full htx-input p-2 rounded mt-1" value="5000">
                        </div>
                        <div>
                            <label class="text-xs text-gray-400">Safety Order Size</label>
                            <input id="safetyOrder" type="number" class="w-full htx-input p-2 rounded mt-1" value="5000">
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="text-xs text-gray-400">Price Drop (%)</label>
                                <input id="priceDrop" type="number" class="w-full htx-input p-2 rounded mt-1" value="0.8">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Take Profit (%)</label>
                                <input id="takeProfit" type="number" class="w-full htx-input p-2 rounded mt-1" value="1.2">
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="text-xs text-gray-400">Volume Mult</label>
                                <input id="volumeMult" type="number" class="w-full htx-input p-2 rounded mt-1" value="1.5">
                            </div>
                            <div>
                                <label class="text-xs text-gray-400">Max Steps</label>
                                <input id="maxSteps" type="number" class="w-full htx-input p-2 rounded mt-1" value="10">
                            </div>
                        </div>
                        <button onclick="updateSettings()" class="w-full py-2 border border-gray-500 rounded text-sm hover:bg-gray-800 transition">SAVE SETTINGS</button>
                    </div>
                </div>
            </div>
        </div>

        <script>
            async function updateUI() {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('pnl').innerText = data.pnl.toFixed(4);
                document.getElementById('roi').innerText = data.roi.toFixed(2) + '%';
                document.getElementById('lastPrice').innerText = data.currentPrice;
                document.getElementById('safetyFilled').innerText = data.safetyOrdersFilled + ' / ' + data.settings.maxSafetyOrders;
                
                const btn = document.getElementById('btnAction');
                if (data.isRunning) {
                    btn.innerText = 'STOP BOT';
                    btn.className = 'px-6 py-2 rounded font-bold bg-red-600';
                } else {
                    btn.innerText = 'START BOT';
                    btn.className = 'px-6 py-2 rounded font-bold htx-btn-blue';
                }
            }

            async function toggleBot() {
                await fetch('/api/toggle', {method: 'POST'});
                updateUI();
            }

            async function updateSettings() {
                const settings = {
                    baseOrder: parseFloat(document.getElementById('baseOrder').value),
                    safetyOrder: parseFloat(document.getElementById('safetyOrder').value),
                    priceDrop: parseFloat(document.getElementById('priceDrop').value),
                    takeProfit: parseFloat(document.getElementById('takeProfit').value),
                    volumeMult: parseFloat(document.getElementById('volumeMult').value),
                    maxSafetyOrders: parseInt(document.getElementById('maxSteps').value)
                };
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(settings)
                });
                alert('Settings Updated');
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

app.listen(config.port, () => console.log(`Dashboard: http://localhost:${config.port}`));
