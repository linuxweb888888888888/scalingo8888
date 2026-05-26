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
    maxAffordableSteps: 0, // NEW: Calculated limit
    distToNext: 0,
    settings: {
        baseOrder: 0,        
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.5,     
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
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== MATH: CALCULATE LIMITS ====================
function calculateMaxPossibleSteps(balance, leverage, baseOrder, multiplier, price) {
    if (price <= 0 || baseOrder <= 0) return 0;
    
    let totalContracts = 0;
    let currentStepVolume = baseOrder;
    let buyingPower = balance * leverage;
    let steps = 0;

    // Simulate steps until we run out of buying power
    while (true) {
        let stepNotional = currentStepVolume * price; 
        // Note: For SHIB, HTX contract size is usually 1,000 or 1,000,000. 
        // If your baseOrder is already calculated with face value, this is correct.
        
        if ((totalContracts * price) + stepNotional > buyingPower) {
            break;
        }
        
        totalContracts += currentStepVolume;
        currentStepVolume = Math.floor(currentStepVolume * multiplier);
        steps++;
        
        if (steps > 100) break; // Safety break
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0;
    let runningTotal = baseVol;
    let lastOrder = baseVol;
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
            
            // MATH: Base Order = Balance * 10
            botState.settings.baseOrder = Math.max(1, Math.floor(botState.walletBalance * 10));
            
            // MATH: How many steps can we survive?
            botState.maxAffordableSteps = calculateMaxPossibleSteps(
                botState.walletBalance, 
                config.leverage, 
                botState.settings.baseOrder, 
                botState.settings.volumeMult, 
                botState.currentPrice
            );
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            const currentVol = parseFloat(pos.volume);
            botState.openPosition = { volume: currentVol, direction: pos.direction, costHold: botState.avgPrice };
            
            botState.safetyOrdersFilled = calculateCurrentStep(currentVol, botState.settings.baseOrder, botState.settings.volumeMult);

            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            const targetDrop = (botState.safetyOrdersFilled + 1) * botState.settings.priceDrop;
            botState.distToNext = Math.max(0, targetDrop - currentDrop);
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
        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.openPosition.volume,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.winningTrades++; botState.totalTrades++; botState.safetyOrdersFilled = 0;
        } else if (hasPos) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            const targetDrop = (botState.safetyOrdersFilled + 1) * botState.settings.priceDrop;
            if (currentDrop >= targetDrop) {
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled++; botState.totalTrades++;
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
    <title>HTX Compounder</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; color: #111827; }
        .card { background: white; border: 1px solid #f3f4f6; border-radius: 1.5rem; padding: 2rem; }
        .stat-val { font-size: 2.5rem; font-weight: 800; letter-spacing: -0.05em; }
        .label { font-size: 0.7rem; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; }
    </style>
</head>
<body class="p-8 md:p-16">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-end mb-16">
            <div>
                <h1 class="text-3xl font-black tracking-tighter">COMPOUND_BOT <span class="text-emerald-500">PRO</span></h1>
                <p class="text-[10px] text-gray-400 font-bold tracking-[0.2em] uppercase mt-1">${config.symbol} • ${config.leverage}X</p>
            </div>
            <div class="text-right">
                <p class="label">Daily Growth</p>
                <p id="dgr" class="text-3xl font-black text-emerald-500">0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
            <div class="card border-l-4 border-l-emerald-500">
                <p class="label">Net Profit</p>
                <p id="profit" class="stat-val text-emerald-600">$0.00</p>
                <p id="profitPct" class="text-sm font-bold text-gray-400">+0.00%</p>
            </div>
            <div class="card">
                <p class="label">Current ROI</p>
                <p id="roi" class="stat-val">0.00%</p>
                <p id="dist" class="text-sm font-bold text-orange-500">Next: 0.000%</p>
            </div>
            <div class="card">
                <p class="label">Safety Steps</p>
                <div class="flex items-baseline gap-2">
                    <p id="steps" class="stat-val text-blue-600">0</p>
                    <span id="maxSteps" class="text-gray-300 font-bold text-xl">/ 0</span>
                </div>
                <p class="text-[10px] font-bold text-gray-400">UNTIL WALLET CAPACITY</p>
            </div>
            <div class="card">
                <p class="label">Wallet Balance</p>
                <p id="bal" class="stat-val text-gray-900">$0.00</p>
                <p id="trades" class="text-sm font-bold text-gray-400">0 Trades</p>
            </div>
        </div>

        <div class="card bg-gray-50 border-none">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div>
                    <p class="label">Base Order</p>
                    <p id="base" class="text-xl font-bold text-gray-800">0</p>
                </div>
                <div>
                    <p class="label">Live Price</p>
                    <p id="price" class="text-xl font-mono font-bold text-gray-800">0.000000</p>
                </div>
                <div>
                    <p class="label">Est. 24h</p>
                    <p id="estDay" class="text-xl font-bold text-emerald-600">$0.00</p>
                </div>
                <div>
                    <p class="label">Est. Month</p>
                    <p id="estMonth" class="text-xl font-bold text-gray-800">$0.00</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                document.getElementById('profit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('profitPct').innerText = '+' + d.profitPct.toFixed(4) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').style.color = d.roi >= 0 ? '#10b981' : '#ef4444';
                document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                document.getElementById('steps').innerText = d.safetyOrdersFilled;
                document.getElementById('maxSteps').innerText = '/ ' + d.maxAffordableSteps;
                document.getElementById('dist').innerText = 'Next: ' + d.distToNext.toFixed(3) + '%';
                document.getElementById('trades').innerText = d.totalTrades + ' Trades';
                document.getElementById('dgr').innerText = d.estimates.dgr.toFixed(3) + '%';
                document.getElementById('base').innerText = d.settings.baseOrder;
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
    startWS();
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
