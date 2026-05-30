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
    roi: 0, // This will hold the Exchange's profit_rate
    realizedProfit: 0,
    profitPct: 0,
    walletBalance: 0,
    displayBalance: 0,
    peakBalance: 0,
    initialBalance: 0,
    safetyOrdersFilled: 0,
    maxAffordableSteps: 0,
    distToNext: 0,
    profitShibLeveraged: 0, 
    settings: {
        baseOrder: 1,        
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.5, // 1.5% target
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
    if (price <= 0 || baseOrder <= 0 || balance <= 0) return 0;
    let totalContractsAccumulated = 0;
    let nextOrderSize = baseOrder;
    let buyingPower = balance * leverage;
    let steps = 0;
    while (true) {
        let totalValueWithNextStep = (totalContractsAccumulated + nextOrderSize) * price * 1000;
        if (totalValueWithNextStep > buyingPower) break;
        totalContractsAccumulated += nextOrderSize;
        nextOrderSize = Math.ceil(nextOrderSize * multiplier);
        steps++;
        if (steps > 500) break; 
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0; let runningTotal = baseVol; let lastOrder = baseVol;
    while (runningTotal < totalVol && step < 100) {
        step++;
        lastOrder = Math.ceil(lastOrder * multiplier);
        runningTotal += lastOrder;
        if (Math.abs(runningTotal - totalVol) / totalVol < 0.05) return step;
        if (runningTotal > totalVol) return step;
    }
    return step;
}

// ==================== DATA SYNC ====================
async function syncData() {
    try {
        // 1. Sync Account/Balance
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
                if (botState.displayBalance > (botState.allTimeHigh || 0)) botState.allTimeHigh = botState.displayBalance;
            }
            botState.walletBalance = realBalance;
            botState.realizedProfit = botState.displayBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
            
            if (botState.currentPrice > 0) {
                botState.profitShibLeveraged = (botState.realizedProfit * 10) / botState.currentPrice;
                const profitContracts = Math.floor(botState.profitShibLeveraged / 1000);
                botState.settings.baseOrder = Math.max(1, 1 + profitContracts);

                botState.maxAffordableSteps = calculateMaxPossibleSteps(
                    botState.walletBalance, 
                    config.leverage, 
                    botState.settings.baseOrder, 
                    botState.settings.volumeMult, 
                    botState.currentPrice
                );
            }
        }

        // 2. Sync Position & Direct Exchange ROI
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            // DIRECT FROM EXCHANGE: profit_rate is the ROI as reported by HTX
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

// ==================== TRADING LOGIC ====================
async function checkTrades() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        const hasPos = botState.openPosition.volume > 0;
        
        // Uses the direct ROI from the exchange sync
        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.openPosition.volume,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.winningTrades++; botState.totalTrades++;
        } else if (hasPos) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            if (currentDrop >= botState.settings.priceDrop) {
                const nextVol = Math.max(1, Math.ceil(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
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
    <title>HTX Compounder PRO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
    </style>
</head>
<body class="text-gray-900 p-6 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold tracking-tight">COMPOUND<span class="gradient-text">_BOT</span></h1>
                <p class="text-[10px] text-gray-400 uppercase tracking-widest mt-1">${config.symbol} | ${config.leverage}X LEVERAGE</p>
                <p class="text-[10px] text-emerald-600 font-bold mt-2">🎯 DIRECT EXCHANGE ROI TRACKING</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-3xl font-bold text-emerald-600">0.00%</p>
                <p class="text-[10px] text-gray-400 uppercase tracking-wider">Daily Growth Rate</p>
            </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Net Profit</p>
                <p id="p1" class="text-2xl font-bold text-emerald-600 stat-number">$0.00</p>
                <p id="p2" class="text-[10px] font-bold text-gray-400 mt-1">0.00% TOTAL GAIN</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Profit SHIB (10x)</p>
                <p id="pShib" class="text-2xl font-bold text-emerald-900 stat-number">0</p>
                <p class="text-[10px] font-bold text-gray-400 mt-1 uppercase">Units</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Open ROI (HTX)</p>
                <p id="roi" class="text-2xl font-bold stat-number">0.00%</p>
                <p id="distText" class="text-[10px] font-bold text-orange-500 mt-1">NEXT STEP: 0.100%</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Safety Steps</p>
                <p id="stepText" class="text-2xl font-bold text-blue-600 stat-number">0 <span class="text-lg text-gray-300">/ 0</span></p>
                <p class="text-[10px] font-bold text-gray-400 mt-1 uppercase">Wallet Limit</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Display Balance</p>
                <p id="bal" class="text-2xl font-bold text-gray-900 stat-number">$0.00</p>
                <p id="totalTrades" class="text-[10px] font-bold text-gray-400 mt-1">0 TOTAL TRADES</p>
            </div>
        </div>

        <div class="card p-6 rounded-2xl mb-8 bg-gradient-to-r from-gray-50 to-white">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 items-center">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Base Order (Compounded)</p>
                    <p id="baseOrderDisplay" class="text-xl font-bold text-gray-800">0</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Live Price</p>
                    <p id="curPrice" class="text-xl font-mono font-bold text-gray-800">0.00000000</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Take Profit</p>
                    <p class="text-xl font-bold text-emerald-600">${botState.settings.takeProfit}%</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Step Multiplier</p>
                    <p class="text-xl font-bold text-purple-600">${botState.settings.volumeMult}x</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(4) + '% TOTAL GAIN';
                document.getElementById('pShib').innerText = Math.floor(d.profitShibLeveraged).toLocaleString();
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').style.color = d.roi >= 0 ? '#059669' : '#dc2626';
                document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                document.getElementById('totalTrades').innerText = d.totalTrades + ' TOTAL TRADES';
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-lg text-gray-300">/ ' + d.maxAffordableSteps + '</span>';
                document.getElementById('distText').innerText = 'NEXT STEP: ' + d.distToNext.toFixed(3) + '%';
                document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(4) + '%';
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
