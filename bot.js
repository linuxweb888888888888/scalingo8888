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
    secret_key: process.env.HTX_SECRET_KEY,
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
    maxAffordableSteps: 0, 
    distToNext: 0,
    settings: {
        baseOrder: 0,        
        priceDrop: 0.1,      // 0.1% Static Drop
        volumeMult: 1.2,     // 1.2x Multiplier
        takeProfit: 1.5,     // 1.5% TP
        maxSteps: 999        
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    openPosition: { volume: 0, direction: "", costHold: 0 },
    totalTrades: 0,
    winningTrades: 0
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secret_key).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== CALCULATIONS ====================
function calculateMaxSteps(balance, leverage, base, mult, price) {
    if (!price || !base) return 0;
    let totalNotional = 0;
    let nextOrder = base;
    let steps = 0;
    let power = balance * leverage;
    while ((totalNotional + (nextOrder * price)) < power && steps < 50) {
        totalNotional += (nextOrder * price);
        nextOrder = Math.floor(nextOrder * mult);
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

// ==================== SYNC ====================
async function syncData() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const realBalance = parseFloat(acc.margin_balance) - (parseFloat(acc.profit_unreal) || 0);

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
            botState.settings.baseOrder = Math.max(1, Math.floor(botState.walletBalance * 10));
            botState.maxAffordableSteps = calculateMaxSteps(realBalance, config.leverage, botState.settings.baseOrder, botState.settings.volumeMult, botState.currentPrice);
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botState.avgPrice };
            botState.safetyOrdersFilled = calculateCurrentStep(botState.openPosition.volume, botState.settings.baseOrder, botState.settings.volumeMult);

            // FIX: Static 0.1% drop calculation from CURRENT Average Price
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            botState.distToNext = Math.max(0, botState.settings.priceDrop - currentDrop);
        } else {
            botState.openPosition = { volume: 0, direction: "", costHold: 0 };
            botState.roi = 0; botState.avgPrice = 0; botState.distToNext = 0; botState.safetyOrdersFilled = 0;
        }

        const elapsed = (Date.now() - botState.startTime) / 3600000;
        const hr = botState.realizedProfit / Math.max(elapsed, 0.01);
        botState.estimates = { hr, day: hr * 24, week: hr * 168, month: hr * 720, dgr: (hr * 24 / botState.initialBalance) * 100 };
    } catch (e) {}
}

// ==================== TRADING ====================
async function checkTrades() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        const hasPos = botState.openPosition.volume > 0;
        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.openPosition.volume,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.winningTrades++; botState.totalTrades++;
        } else if (hasPos) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            // Trigger if price is 0.1% or more below the CURRENT Average Price
            if (currentDrop >= botState.settings.priceDrop) {
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.totalTrades++;
            }
        } else if (!hasPos && botState.settings.baseOrder > 0) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.totalTrades++;
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX 0.1% Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: sans-serif; background: #ffffff; color: #000; }
        .card { background: #fff; border: 1px solid #eee; border-radius: 12px; padding: 24px; }
        .stat-val { font-size: 2.2rem; font-weight: 800; }
        .label { font-size: 0.65rem; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
    </style>
</head>
<body class="p-8">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-end mb-12">
            <div>
                <h1 class="text-2xl font-black italic">HTX_0.1_STATIC</h1>
                <p class="text-[10px] text-gray-400 font-bold tracking-widest">${config.symbol} | ${config.leverage}X</p>
            </div>
            <div class="text-right">
                <p id="dgr" class="text-2xl font-black text-emerald-500">0.00%</p>
                <p class="label">Daily Growth</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="card">
                <p class="label">Profit</p>
                <p id="profit" class="stat-val text-emerald-500">$0.00</p>
                <p id="profitPct" class="text-xs font-bold text-gray-300">0.00%</p>
            </div>
            <div class="card">
                <p class="label">Current ROI</p>
                <p id="roi" class="stat-val">0.00%</p>
                <p id="dist" class="text-xs font-bold text-orange-500">NEXT: 0.100%</p>
            </div>
            <div class="card">
                <p class="label">Steps Filled</p>
                <div class="flex items-baseline gap-1">
                    <p id="steps" class="stat-val text-blue-500">0</p>
                    <span id="maxSteps" class="text-gray-300 font-bold">/ 0</span>
                </div>
            </div>
            <div class="card">
                <p class="label">Wallet</p>
                <p id="bal" class="stat-val">$0.00</p>
                <p id="trades" class="text-xs font-bold text-gray-300">0 Trades</p>
            </div>
        </div>

        <div class="card">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div><p class="label">Price</p><p id="price" class="font-mono font-bold">0.000000</p></div>
                <div><p class="label">Base Order</p><p id="base" class="font-bold">0</p></div>
                <div><p class="label">Est. 24h</p><p id="estDay" class="font-bold text-emerald-500">$0.00</p></div>
                <div><p class="label">Trigger</p><p class="font-bold text-red-500">0.1% Drop</p></div>
            </div>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('profit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('profitPct').innerText = d.profitPct.toFixed(4) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').style.color = d.roi >= 0 ? '#10b981' : '#f43f5e';
                document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                document.getElementById('steps').innerText = d.safetyOrdersFilled;
                document.getElementById('maxSteps').innerText = '/ ' + d.maxAffordableSteps;
                document.getElementById('dist').innerText = 'DROP NEEDED: ' + d.distToNext.toFixed(3) + '%';
                document.getElementById('dgr').innerText = d.estimates.dgr.toFixed(3) + '%';
                document.getElementById('base').innerText = d.settings.baseOrder;
                document.getElementById('price').innerText = d.currentPrice.toFixed(8);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
            } catch(e) {}
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
    startWS();
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
