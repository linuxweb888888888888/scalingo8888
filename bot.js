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
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

// ==================== BOT STATE ====================
let botState = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    currentPrice: 0,
    avgPrice: 0,
    roi: 0,
    realizedProfit: 0,
    profitPct: 0,
    walletBalance: 0,
    displayBalance: 0,
    peakBalance: 0,
    initialBalance: 0,
    safetyOrdersFilled: 0,
    distToNext: 0,
    settings: {
        baseOrder: 0,        // Calculated as Balance * 10
        priceDrop: 0.1,      // 0.1% Drop
        volumeMult: 1.2,     // 1.2x Multiplier
        takeProfit: 1.5,     // 1.5% Take Profit
        maxSteps: 999        // "Unlimited"
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    openPosition: { volume: 0, direction: "", costHold: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0
};

let tradeHistory = [];

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
            
            // MATH: Base Order = Wallet Balance * 10
            botState.settings.baseOrder = Math.floor(botState.walletBalance * 10);
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botState.avgPrice };
            
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            const targetDrop = (botState.safetyOrdersFilled + 1) * botState.settings.priceDrop;
            botState.distToNext = Math.max(0, targetDrop - currentDrop);
        } else {
            botState.openPosition = { volume: 0, direction: "", costHold: 0 };
            botState.roi = 0;
            botState.avgPrice = 0;
            botState.distToNext = 0;
            botState.safetyOrdersFilled = 0;
        }
        
        // Update Growth Estimates
        const elapsed = (Date.now() - botState.startTime) / 3600000;
        const hr = botState.realizedProfit / Math.max(elapsed, 0.01);
        botState.estimates = { hr, day: hr * 24, week: hr * 168, month: hr * 720, dgr: (hr * 24 / botState.initialBalance) * 100 };

    } catch (e) { console.log("Sync Error"); }
}

// ==================== TRADE LOGIC ====================
async function checkTrades() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;

    try {
        const hasPos = botState.openPosition.volume > 0;

        // 1. Take Profit
        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.openPosition.volume,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            if (res?.code === 200) {
                tradeHistory.unshift({ t: Date.now(), type: 'TP', roi: botState.roi });
                botState.winningTrades++;
                botState.totalTrades++;
                botState.safetyOrdersFilled = 0;
            }
        } 
        // 2. Unlimited Safety Orders (triggered every 0.1% drop)
        else if (hasPos) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            const targetDrop = (botState.safetyOrdersFilled + 1) * botState.settings.priceDrop;

            if (currentDrop >= targetDrop) {
                // Contracts increase by 1.2x each step
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
                const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (res?.code === 200) {
                    botState.safetyOrdersFilled++;
                    botState.totalTrades++;
                    tradeHistory.unshift({ t: Date.now(), type: 'SAFETY', step: botState.safetyOrdersFilled });
                }
            }
        }
        // 3. Open Base Position
        else if (!hasPos && botState.settings.baseOrder > 0) {
            const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            if (res?.code === 200) {
                botState.totalTrades++;
                tradeHistory.unshift({ t: Date.now(), type: 'OPEN' });
            }
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== WEB UI (WHITE DESIGN) ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Compounder | 0.1% Steps</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #f9fafb; color: #111827; }
        .card { background: white; border: 1px solid #e5e7eb; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .stat-val { font-size: 1.875rem; font-weight: 800; letter-spacing: -0.025em; }
        .label { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    </style>
</head>
<body class="p-6 md:p-12">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-2xl font-black">COMPOUND_BOT <span class="text-emerald-500">PRO</span></h1>
                <p class="text-xs text-gray-400 font-bold tracking-widest uppercase">${config.symbol} | ${config.leverage}X</p>
            </div>
            <div class="text-right">
                <p class="label">Daily Growth</p>
                <p id="dgr" class="text-2xl font-black text-emerald-600">0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="card">
                <p class="label">Net Profit</p>
                <p id="profit" class="stat-val text-emerald-600">$0.00</p>
                <p id="profitPct" class="text-xs font-bold text-gray-400">0.00%</p>
            </div>
            <div class="card">
                <p class="label">Current ROI</p>
                <p id="roi" class="stat-val">0.00%</p>
                <p id="dist" class="text-xs font-bold text-orange-500">Next step: 0.00%</p>
            </div>
            <div class="card">
                <p class="label">Safety Steps</p>
                <p id="steps" class="stat-val text-blue-600">0</p>
                <p class="text-xs font-bold text-gray-400">Unlimited Active</p>
            </div>
            <div class="card">
                <p class="label">Display Balance</p>
                <p id="bal" class="stat-val text-gray-900">$0.00</p>
                <p id="trades" class="text-xs font-bold text-gray-400">0 Trades</p>
            </div>
        </div>

        <div class="card mb-8">
            <div class="flex justify-between items-center mb-4">
                <p class="label">Strategy Parameters</p>
                <div class="flex gap-4">
                    <span class="text-[10px] font-bold bg-gray-100 px-2 py-1 rounded">DROP: 0.1%</span>
                    <span class="text-[10px] font-bold bg-gray-100 px-2 py-1 rounded">TP: 1.5%</span>
                    <span class="text-[10px] font-bold bg-gray-100 px-2 py-1 rounded">MULT: 1.2x</span>
                </div>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                    <p class="label">Base Order (Bal * 10)</p>
                    <p id="base" class="font-bold text-gray-800">0</p>
                </div>
                <div>
                    <p class="label">Price</p>
                    <p id="price" class="font-mono font-bold text-gray-800">0.000000</p>
                </div>
                <div>
                    <p class="label">Est. 24h</p>
                    <p id="estDay" class="font-bold text-emerald-600">$0.00</p>
                </div>
                <div>
                    <p class="label">Est. Month</p>
                    <p id="estMonth" class="font-bold text-gray-800">$0.00</p>
                </div>
            </div>
        </div>
        
        <div class="text-[10px] text-gray-300 font-bold uppercase tracking-widest text-center">
            System is monitoring real-time WebSocket ticks...
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('profit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('profitPct').innerText = d.profitPct.toFixed(4) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').style.color = d.roi >= 0 ? '#059669' : '#dc2626';
                document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                document.getElementById('steps').innerText = d.safetyOrdersFilled;
                document.getElementById('dist').innerText = 'Next step in: ' + d.distToNext.toFixed(3) + '%';
                document.getElementById('trades').innerText = d.totalTrades + ' Trades (' + d.winningTrades + ' wins)';
                document.getElementById('dgr').innerText = d.estimates.dgr.toFixed(3) + '%';
                document.getElementById('base').innerText = d.settings.baseOrder + ' contracts';
                document.getElementById('price').innerText = d.currentPrice.toFixed(8);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(2);
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));

// ==================== BOOT ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.listen(config.port, () => {
    console.log(`🚀 White UI active on port ${config.port}`);
    startWS();
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
