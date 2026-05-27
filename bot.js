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
    wsHost: 'wss://api.hbdm.com/linear-swap-ws', // Linear Swap WS
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
    coins: {}
};

config.symbols.forEach((sym, index) => {
    botState.coins[sym] = {
        symbol: sym,
        direction: index % 2 === 0 ? 'buy' : 'sell', 
        currentPrice: 0,
        avgPrice: 0,
        roi: 0,
        safetyOrdersFilled: 0,
        maxAffordableSteps: 0,
        distToNext: 0,
        volume: 0,
        baseOrder: 1, 
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
    let nextStepVol = baseOrder;
    let buyingPower = (balance / config.symbols.length) * leverage; 
    let steps = 0;
    while (steps < 100) {
        let stepNotional = nextStepVol * price; 
        if ((totalContracts * price) + stepNotional > buyingPower) break;
        totalContracts += nextStepVol;
        nextStepVol = Math.max(nextStepVol + 1, Math.ceil(nextStepVol * multiplier));
        steps++;
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0; let runningTotal = baseVol; let lastOrder = baseVol;
    while (runningTotal < totalVol && step < 100) {
        step++;
        lastOrder = Math.max(lastOrder + 1, Math.ceil(lastOrder * multiplier));
        runningTotal += lastOrder;
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
            botState.profitPct = botState.initialBalance > 0 ? (botState.realizedProfit / botState.initialBalance) * 100 : 0;
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { margin_asset: 'USDT' });
        
        for (let sym of config.symbols) {
            const coin = botState.coins[sym];
            const pos = posRes?.data?.find(p => p.contract_code === sym && parseFloat(p.volume) > 0);

            if (coin.currentPrice > 0) {
                coin.maxAffordableSteps = calculateMaxPossibleSteps(botState.walletBalance, config.leverage, coin.baseOrder, coin.settings.volumeMult, coin.currentPrice);
            }

            if (pos) {
                coin.avgPrice = parseFloat(pos.cost_hold);
                coin.volume = parseFloat(pos.volume);
                coin.direction = pos.direction; 
                const side = coin.direction === 'buy' ? 1 : -1;
                coin.roi = ((coin.currentPrice - coin.avgPrice) / coin.avgPrice) * side * config.leverage * 100;
                coin.safetyOrdersFilled = calculateCurrentStep(coin.volume, coin.baseOrder, coin.settings.volumeMult);
                const diff = coin.direction === 'buy' ? (coin.avgPrice - coin.currentPrice) : (coin.currentPrice - coin.avgPrice);
                const currentDrop = (diff / coin.avgPrice) * 100;
                coin.distToNext = Math.max(0, coin.settings.priceDrop - currentDrop);
            } else {
                coin.volume = 0; coin.roi = 0; coin.avgPrice = 0; coin.distToNext = 0; coin.safetyOrdersFilled = 0;
            }
        }
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
                    const nextVol = Math.max(1, Math.ceil(coin.baseOrder * Math.pow(coin.settings.volumeMult, coin.safetyOrdersFilled + 1)));
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: sym, volume: nextVol, direction: coin.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                    botState.totalTrades++;
                }
            } else if (!hasPos) {
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
    <title>HTX Multi-DCA</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Inter', sans-serif; background: #f9fafb; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8 bg-white p-6 rounded-2xl border border-gray-100">
            <div>
                <h1 class="text-3xl font-bold tracking-tight uppercase">MULTI<span class="gradient-text">_DCA</span></h1>
                <p class="text-[10px] text-gray-400 uppercase tracking-widest mt-1">HTX Futures | 1.5% TP | 0.1% Drop</p>
            </div>
            <div class="text-right">
                <p id="totalProfit" class="text-3xl font-bold text-emerald-600">$0.00</p>
                <p id="totalPct" class="text-[10px] text-gray-400 uppercase tracking-wider">Total Profit (0.00%)</p>
            </div>
        </div>
        <div id="coinContainer" class="space-y-4"></div>
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
                    <div class="card p-5 rounded-xl">
                        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 items-center">
                            <div>
                                <h3 class="font-bold text-lg">\${coin.symbol}</h3>
                                <span class="text-[10px] font-bold \${isLong ? 'text-emerald-600' : 'text-rose-600'} uppercase">
                                    \${isLong ? 'Long' : 'Short'} | Vol: \${coin.volume}
                                </span>
                            </div>
                            <div><p class="text-[10px] text-gray-400 uppercase">ROI</p><p class="text-lg font-bold \${coin.roi >= 0 ? 'text-emerald-600' : 'text-rose-600'}">\${coin.roi.toFixed(2)}%</p></div>
                            <div><p class="text-[10px] text-gray-400 uppercase">Steps / Capacity</p><p class="text-lg font-bold text-blue-600">\${coin.safetyOrdersFilled} / \${coin.maxAffordableSteps}</p></div>
                            <div class="text-right"><p class="text-[10px] text-gray-400 uppercase">Price</p><p class="text-lg font-mono font-bold text-gray-800">\${coin.currentPrice.toFixed(8)}</p></div>
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

// ==================== FIXED FUTURES WEBSOCKET ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        config.symbols.forEach(sym => {
            // For Futures WS: Symbol must be EXACTLY as traded (e.g. SHIB-USDT)
            ws.send(JSON.stringify({ sub: `market.${sym}.detail`, id: sym }));
        });
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.ping) return ws.send(JSON.stringify({ pong: msg.ping }));
            
            if (msg.ch) {
                const sym = msg.ch.split('.')[1]; // Extracts "SHIB-USDT"
                if (botState.coins[sym] && msg.tick?.close) {
                    botState.coins[sym].currentPrice = parseFloat(msg.tick.close);
                }
            }
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.listen(config.port, () => {
    startWS();
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
