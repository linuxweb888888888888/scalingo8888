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
    maxAffordableSteps: 0,
    distToNext: 0,
    profitShibLeveraged: 0, // Profit converted to SHIB units at 10x
    settings: {
        baseOrder: 0,        
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.5,     
        maxSteps: 999        
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    openPosition: { volume: 0, direction: "", costHold: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0
};

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
    let buyingPower = balance * leverage;
    let steps = 0;
    while (true) {
        let stepNotional = currentStepVolume * price * 1000; // 1000 SHIB per contract
        if (((totalContracts + currentStepVolume) * price * 1000) > buyingPower) break;
        totalContracts += currentStepVolume;
        currentStepVolume = Math.floor(currentStepVolume * multiplier);
        steps++;
        if (steps > 300) break; 
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
            
            // --- UPDATED COMPOUNDING MATH (1 Contract = 1000 SHIB) ---
            if (botState.currentPrice > 0) {
                // 1. Calculate Profit in SHIB tokens at 10x
                botState.profitShibLeveraged = (botState.realizedProfit * 10) / botState.currentPrice;
                
                // 2. Convert SHIB units to HTX Contracts (SHIB units / 1000)
                const profitContracts = Math.floor(botState.profitShibLeveraged / 1000);
                
                // 3. New Base Order = (Current Wallet * 10) + Profit Contracts
                const initialBase = Math.floor(botState.walletBalance * 10);
                botState.settings.baseOrder = Math.max(1, initialBase + profitContracts);
            }

            botState.maxAffordableSteps = calculateMaxPossibleSteps(botState.walletBalance, config.leverage, botState.settings.baseOrder, botState.settings.volumeMult, botState.currentPrice);
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botState.avgPrice };
            botState.safetyOrdersFilled = calculateCurrentStep(botState.openPosition.volume, botState.settings.baseOrder, botState.settings.volumeMult);
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
            botState.totalTrades++;
        } else if (hasPos) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
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

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Compounder PRO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; padding: 1.5rem; border-radius: 1rem; }
    </style>
</head>
<body class="p-10 bg-gray-50 text-gray-900">
    <div class="max-w-6xl mx-auto">
        <h1 class="text-3xl font-bold mb-8">HTX COMPOUNDING (1K SHIB/CONT)</h1>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="card">
                <p class="text-xs text-gray-400 uppercase font-bold mb-1">Net Profit USDT</p>
                <p id="p1" class="text-2xl font-bold text-emerald-600">$0.0000</p>
            </div>
            <div class="card">
                <p class="text-xs text-gray-400 uppercase font-bold mb-1">Profit SHIB (10x)</p>
                <p id="pShib" class="text-2xl font-bold text-emerald-900">0</p>
            </div>
            <div class="card">
                <p class="text-xs text-gray-400 uppercase font-bold mb-1">Safety Steps</p>
                <p id="stepText" class="text-2xl font-bold text-blue-600">0 / 0</p>
            </div>
            <div class="card">
                <p class="text-xs text-gray-400 uppercase font-bold mb-1">Base Order</p>
                <p id="baseOrderDisplay" class="text-2xl font-bold">0</p>
            </div>
        </div>
        <p class="text-[10px] text-gray-400 font-mono uppercase tracking-widest">Pricing: <span id="curPrice">0</span> | Leverage: ${config.leverage}x</p>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('pShib').innerText = Math.floor(d.profitShibLeveraged).toLocaleString() + ' SHIB';
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.maxAffordableSteps;
                document.getElementById('baseOrderDisplay').innerText = d.settings.baseOrder;
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
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
