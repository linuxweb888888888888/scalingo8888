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

if (!config.apiKey || !config.secretKey) {
    console.error('❌ ERROR: Missing API Keys in .env file!');
    process.exit(1);
}

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
    maxSafeBase: 0,
    safetyOrdersFilled: 0,
    distToNext: 0,
    settings: {
        baseOrder: 0,
        priceDrop: 1.5,      // 1.5% drop for safety orders
        volumeMult: 1.2,     // Martingale multiplier
        takeProfit: 2.0,     // 2% Take Profit
        maxSteps: 5          // Max 5 safety orders
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    openPosition: { volume: 0, direction: "", costHold: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0
};

let tradeHistory = [];

// ==================== HTX API HELPER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    
    try {
        const res = await axios({ 
            method, url, 
            data: method === 'POST' ? data : null, 
            headers: { 'Content-Type': 'application/json' },
            timeout: 8000 
        });
        return res.data;
    } catch (e) { 
        console.error(`📡 API Error (${path}):`, e.response?.data || e.message);
        return null; 
    }
}

// ==================== LOGIC: CALCULATIONS ====================
function updateEstimates() {
    const elapsedHrs = (Date.now() - botState.startTime) / 3600000;
    if (botState.realizedProfit !== 0 && botState.initialBalance > 0) {
        const hrRate = botState.realizedProfit / Math.max(elapsedHrs, 0.01);
        botState.estimates = {
            hr: hrRate,
            day: hrRate * 24,
            week: hrRate * 168,
            month: hrRate * 720,
            dgr: (hrRate * 24 / botState.initialBalance) * 100
        };
    }
}

// ==================== SYNC DATA ====================
async function syncExchangeData() {
    try {
        // 1. Get Account Balance
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const info = accRes.data.find(a => a.margin_asset === 'USDT');
            const realBal = parseFloat(info.margin_balance) - (parseFloat(info.profit_unreal) || 0);
            
            if (botState.initialBalance <= 0) {
                botState.initialBalance = realBal;
                botState.displayBalance = realBal;
                botState.peakBalance = realBal;
                botState.allTimeHigh = realBal;
            }

            // If balance grew, update display (locking in profit)
            if (realBal > botState.peakBalance) {
                botState.displayBalance += (realBal - botState.peakBalance);
                botState.peakBalance = realBal;
                if (botState.displayBalance > botState.allTimeHigh) botState.allTimeHigh = botState.displayBalance;
            }
            botState.walletBalance = realBal;
            botState.realizedProfit = botState.displayBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
            updateEstimates();
        }

        // 2. Get Position Info
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botState.avgPrice };
            
            // Calculate distance to next safety order
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

        // 3. Update Dynamic Base Order sizing
        if (botState.currentPrice > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            // We want to ensure the total size of all steps doesn't exceed 85% of account leverage
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice);
            // Contract minimum is usually 1, or based on contract_size. We floor it.
            botState.maxSafeBase = Math.max(1, Math.floor(rawBase * 0.8)); 
            if (botState.settings.baseOrder === 0) botState.settings.baseOrder = botState.maxSafeBase;
        }

    } catch (e) {
        console.error("Sync Loop Error:", e.message);
    }
}

// ==================== TRADING EXECUTION ====================
async function checkAndExecuteTrades() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;

    try {
        const hasPos = botState.openPosition.volume > 0;

        // CASE 1: TAKE PROFIT
        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            console.log(`🎯 TP Triggered! ROI: ${botState.roi.toFixed(2)}%`);
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
        // CASE 2: SAFETY ORDER
        else if (hasPos && botState.safetyOrdersFilled < botState.settings.maxSteps) {
            const currentDrop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            const targetDrop = (botState.safetyOrdersFilled + 1) * botState.settings.priceDrop;

            if (currentDrop >= targetDrop) {
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
                console.log(`🔴 Safety Order #${botState.safetyOrdersFilled + 1} | Vol: ${nextVol}`);
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
        // CASE 3: OPEN INITIAL
        else if (!hasPos && botState.settings.baseOrder > 0) {
            console.log(`🚀 Opening Base Position | Vol: ${botState.settings.baseOrder}`);
            const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            if (res?.code === 200) {
                botState.totalTrades++;
                tradeHistory.unshift({ t: Date.now(), type: 'OPEN' });
            }
        }
    } catch (e) {
        console.error("Trade Logic Error:", e);
    } finally {
        botState.isTrading = false;
    }
}

// ==================== BOOT ====================
function startWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, decompressed) => {
            if (err) return;
            const msg = JSON.parse(decompressed.toString());
            if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWebSocket, 5000));
}

async function boot() {
    console.log(`\n🤖 BOT STARTING: ${config.symbol} @ ${config.leverage}x`);
    startWebSocket();
    setInterval(syncExchangeData, 2000);
    setInterval(checkAndExecuteTrades, 3000);
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    res.send(`
    <html>
    <head>
        <title>HTX BOT</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
            .live { animation: pulse 2s infinite; }
        </style>
    </head>
    <body class="bg-slate-900 text-white font-sans p-6">
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center mb-8">
                <div>
                    <h1 class="text-3xl font-black text-emerald-400 italic">COMPOUND_PRO</h1>
                    <p class="text-slate-400 text-xs tracking-widest uppercase">${config.symbol} • ${config.leverage}X</p>
                </div>
                <div class="text-right">
                    <div class="flex items-center justify-end gap-2">
                        <span class="w-2 h-2 bg-emerald-500 rounded-full live"></span>
                        <span class="text-xs font-bold text-emerald-500">SYSTEM LIVE</span>
                    </div>
                    <p id="curPrice" class="text-xl font-mono">0.00000000</p>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                    <p class="text-slate-400 text-[10px] uppercase font-bold mb-1">Total Profit</p>
                    <p id="profit" class="text-2xl font-bold text-emerald-400">$0.00</p>
                    <p id="profitPct" class="text-xs text-emerald-600">0.00%</p>
                </div>
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                    <p class="text-slate-400 text-[10px] uppercase font-bold mb-1">Current ROI</p>
                    <p id="roi" class="text-2xl font-bold text-white">0.00%</p>
                    <p id="dist" class="text-xs text-orange-400">Next step: 0.00%</p>
                </div>
                <div class="bg-slate-800 p-6 rounded-2xl border border-slate-700">
                    <p class="text-slate-400 text-[10px] uppercase font-bold mb-1">Wallet Balance</p>
                    <p id="bal" class="text-2xl font-bold text-white">$0.00</p>
                    <p id="trades" class="text-xs text-slate-500">Trades: 0</p>
                </div>
            </div>

            <div class="bg-slate-800 rounded-2xl border border-slate-700 p-6 mb-6">
                <div class="flex justify-between items-end mb-4">
                    <p class="text-slate-400 text-[10px] uppercase font-bold">Safety Steps (${botState.settings.maxSteps} Max)</p>
                    <p id="stepCount" class="text-xl font-bold">0 / ${botState.settings.maxSteps}</p>
                </div>
                <div class="w-full bg-slate-900 rounded-full h-4 p-1">
                    <div id="bar" class="bg-emerald-500 h-full rounded-full transition-all" style="width: 0%"></div>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                <div class="bg-slate-800/50 p-4 rounded-xl">
                    <p class="text-[9px] text-slate-500 uppercase mb-1">Daily Est.</p>
                    <p id="estDay" class="text-sm font-bold">$0.00</p>
                </div>
                <div class="bg-slate-800/50 p-4 rounded-xl">
                    <p class="text-[9px] text-slate-500 uppercase mb-1">Weekly Est.</p>
                    <p id="estWeek" class="text-sm font-bold">$0.00</p>
                </div>
                <div class="bg-slate-800/50 p-4 rounded-xl">
                    <p class="text-[9px] text-slate-500 uppercase mb-1">DGR %</p>
                    <p id="dgr" class="text-sm font-bold text-emerald-400">0.00%</p>
                </div>
                <div class="bg-slate-800/50 p-4 rounded-xl">
                    <p class="text-[9px] text-slate-500 uppercase mb-1">Base Order</p>
                    <p id="base" class="text-sm font-bold text-blue-400">0</p>
                </div>
            </div>
        </div>

        <script>
            async function refresh() {
                try {
                    const res = await fetch('/api/status');
                    const d = await res.json();
                    document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                    document.getElementById('profit').innerText = '$' + d.realizedProfit.toFixed(4);
                    document.getElementById('profitPct').innerText = d.profitPct.toFixed(4) + '%';
                    document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                    document.getElementById('roi').className = d.roi >= 0 ? 'text-2xl font-bold text-emerald-400' : 'text-2xl font-bold text-red-400';
                    document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                    document.getElementById('dist').innerText = 'Next step: ' + d.distToNext.toFixed(3) + '%';
                    document.getElementById('trades').innerText = 'Trades: ' + d.totalTrades + ' (' + d.winningTrades + ' wins)';
                    document.getElementById('stepCount').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                    document.getElementById('bar').style.width = (d.safetyOrdersFilled / d.settings.maxSteps * 100) + '%';
                    document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                    document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                    document.getElementById('dgr').innerText = d.estimates.dgr.toFixed(3) + '%';
                    document.getElementById('base').innerText = d.settings.baseOrder;
                } catch(e) {}
            }
            setInterval(refresh, 1000);
        </script>
    </body>
    </html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));

app.listen(config.port, () => {
    boot();
});
