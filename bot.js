require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    // List of "Small" coins likely to fit high step counts
    symbols: ['SHIB-USDT', 'PEPE-USDT', 'BONK-USDT', 'FLOKI-USDT', 'LUNC-USDT', 'XEC-USDT', 'BTTC-USDT', 'HOT-USDT', 'XVG-USDT', 'WIF-USDT']
};

// ==================== BOT STATE ====================
let botState = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    initialBalance: 0,
    walletBalance: 0,
    displayBalance: 0,
    peakBalance: 0,
    realizedProfit: 0,
    profitPct: 0,
    totalTrades: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    coins: {} // Holds individual state for each symbol
};

// Initialize coin states
config.symbols.forEach((sym, index) => {
    botState.coins[sym] = {
        symbol: sym,
        direction: index % 2 === 0 ? 'buy' : 'sell', // Even = Long, Odd = Short
        currentPrice: 0,
        avgPrice: 0,
        roi: 0,
        safetyOrdersFilled: 0,
        maxAffordableSteps: 0,
        distToNext: 0,
        volume: 0,
        baseOrder: 0,
        settings: { priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5 }
    };
});

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== CALCULATIONS ====================
function calculateMaxPossibleSteps(balance, leverage, baseOrder, multiplier, price) {
    if (price <= 0 || baseOrder <= 0) return 0;
    let totalContracts = 0;
    let currentStepVolume = baseOrder;
    let buyingPower = (balance / config.symbols.length) * leverage; // Split balance among coins
    let steps = 0;
    while (steps < 100) {
        let stepNotional = currentStepVolume * price;
        if ((totalContracts * price) + stepNotional > buyingPower) break;
        totalContracts += currentStepVolume;
        currentStepVolume = Math.floor(currentStepVolume * multiplier);
        steps++;
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0; let runningTotal = baseVol; let lastOrder = baseVol;
    while (runningTotal < totalVol && step < 100) {
        step++;
        lastOrder = Math.floor(lastOrder * multiplier);
        runningTotal += lastOrder;
        if (Math.abs(runningTotal - totalVol) / totalVol < 0.05) return step;
    }
    return step;
}

// ==================== DATA SYNC ====================
async function syncData() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const equity = parseFloat(acc.margin_balance);
            const unrealized = parseFloat(acc.profit_unreal) || 0;
            const realBalance = equity - unrealized;

            if (botState.initialBalance <= 0) {
                botState.initialBalance = realBalance;
                botState.displayBalance = realBalance;
                botState.peakBalance = realBalance;
            }
            if (realBalance > botState.peakBalance) {
                botState.displayBalance += (realBalance - botState.peakBalance);
                botState.peakBalance = realBalance;
            }
            botState.walletBalance = realBalance;
            botState.realizedProfit = botState.displayBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { margin_asset: 'USDT' });
        
        for (let sym of config.symbols) {
            const coin = botState.coins[sym];
            const pos = posRes?.data?.find(p => p.contract_code === sym && parseFloat(p.volume) > 0);

            // Dynamic base order per coin (Balance divided by coin count * 10)
            coin.baseOrder = Math.max(1, Math.floor((botState.walletBalance / config.symbols.length) * 10));
            coin.maxAffordableSteps = calculateMaxPossibleSteps(botState.walletBalance, config.leverage, coin.baseOrder, coin.settings.volumeMult, coin.currentPrice);

            if (pos) {
                coin.avgPrice = parseFloat(pos.cost_hold);
                coin.roi = parseFloat(pos.profit_rate) * 100;
                coin.volume = parseFloat(pos.volume);
                coin.safetyOrdersFilled = calculateCurrentStep(coin.volume, coin.baseOrder, coin.settings.volumeMult);

                const diff = coin.direction === 'buy' ? (coin.avgPrice - coin.currentPrice) : (coin.currentPrice - coin.avgPrice);
                const currentDrop = (diff / coin.avgPrice) * 100;
                coin.distToNext = Math.max(0, coin.settings.priceDrop - currentDrop);
            } else {
                coin.volume = 0; coin.roi = 0; coin.avgPrice = 0; coin.distToNext = 0; coin.safetyOrdersFilled = 0;
            }
        }
        
        const elapsed = (Date.now() - botState.startTime) / 3600000;
        const hr = botState.realizedProfit / Math.max(elapsed, 0.01);
        botState.estimates = { hr, day: hr * 24, week: hr * 168, month: hr * 720, dgr: (hr * 24 / botState.initialBalance) * 100 };
    } catch (e) {}
}

// ==================== TRADING LOGIC ====================
async function checkTrades() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;
    
    for (let sym of config.symbols) {
        const coin = botState.coins[sym];
        if (coin.currentPrice <= 0) continue;

        try {
            const hasPos = coin.volume > 0;
            const oppDir = coin.direction === 'buy' ? 'sell' : 'buy';

            if (hasPos && coin.roi >= coin.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: sym, volume: coin.volume, direction: oppDir, offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.totalTrades++;
            } else if (hasPos) {
                const diff = coin.direction === 'buy' ? (coin.avgPrice - coin.currentPrice) : (coin.currentPrice - coin.avgPrice);
                const currentDrop = (diff / coin.avgPrice) * 100;
                if (currentDrop >= coin.settings.priceDrop) {
                    const nextVol = Math.max(1, Math.floor(coin.baseOrder * Math.pow(coin.settings.volumeMult, coin.safetyOrdersFilled + 1)));
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: sym, volume: nextVol, direction: coin.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                    botState.totalTrades++;
                }
            } else if (!hasPos && coin.baseOrder > 0) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: sym, volume: coin.baseOrder, direction: coin.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.totalTrades++;
            }
        } catch (e) {}
    }
    botState.isTrading = false;
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Multi-Compounder</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #f9fafb; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: all 0.2s; }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8 bg-white p-6 rounded-2xl border border-gray-100">
            <div>
                <h1 class="text-3xl font-bold tracking-tight">MULTI<span class="gradient-text">_COMPOUND</span></h1>
                <p class="text-[10px] text-gray-400 uppercase tracking-widest mt-1">Multi-Coin DCA Portfolio | ${config.leverage}X</p>
            </div>
            <div class="text-right">
                <p id="totalProfit" class="text-3xl font-bold text-emerald-600">$0.00</p>
                <p id="totalPct" class="text-[10px] text-gray-400 uppercase tracking-wider">Total Profit (0.00%)</p>
            </div>
        </div>

        <div id="coinContainer" class="space-y-6">
            <!-- Coins will be injected here -->
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('totalProfit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('totalPct').innerText = 'Total Profit (' + d.profitPct.toFixed(2) + '%)';
                
                const container = document.getElementById('coinContainer');
                let html = '';
                
                Object.values(d.coins).forEach(coin => {
                    const isLong = coin.direction === 'buy';
                    html += \`
                    <div class="card p-6 rounded-2xl">
                        <div class="grid grid-cols-2 lg:grid-cols-4 gap-6 items-center">
                            <div>
                                <h3 class="font-black text-xl">\${coin.symbol}</h3>
                                <span class="px-2 py-0.5 rounded text-[10px] font-bold \${isLong ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'} uppercase">
                                    \${isLong ? 'Long' : 'Short'} Odd/Even
                                </span>
                            </div>
                            <div>
                                <p class="text-[10px] text-gray-400 uppercase">ROI / Avg Price</p>
                                <p class="text-xl font-bold \${coin.roi >= 0 ? 'text-emerald-600' : 'text-rose-600'}">\${coin.roi.toFixed(2)}%</p>
                                <p class="text-[10px] text-gray-500 font-mono">\${coin.avgPrice.toFixed(8)}</p>
                            </div>
                            <div>
                                <p class="text-[10px] text-gray-400 uppercase">Steps (Capacity: \${coin.maxAffordableSteps})</p>
                                <p class="text-xl font-bold text-blue-600">\${coin.safetyOrdersFilled} <span class="text-gray-300">/ 50+</span></p>
                                <p class="text-[10px] \${coin.distToNext <= 0.02 ? 'text-rose-500' : 'text-orange-500'} font-bold">NEXT: \${coin.distToNext.toFixed(3)}%</p>
                            </div>
                            <div class="text-right">
                                <p class="text-[10px] text-gray-400 uppercase">Current Price</p>
                                <p class="text-xl font-mono font-bold text-gray-800">\${coin.currentPrice.toFixed(8)}</p>
                            </div>
                        </div>
                    </div>\`;
                });
                container.innerHTML = html;
            } catch (e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));

function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        config.symbols.forEach(sym => {
            ws.send(JSON.stringify({ sub: `market.${sym}.detail`, id: sym }));
        });
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            const sym = msg.ch?.split('.')[1];
            if (sym && botState.coins[sym] && msg.tick?.close) {
                botState.coins[sym].currentPrice = parseFloat(msg.tick.close);
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.listen(config.port, () => {
    startWS();
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
