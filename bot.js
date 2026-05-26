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

// ==================== BOT STATE (Memory Only) ====================
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
        priceDrop: 0.1,
        volumeMult: 1.2,
        takeProfit: 1.5,
        maxSteps: 10
    },
    estimates: {
        hr: 0,
        day: 0,
        week: 0,
        month: 0,
        dgr: 0
    },
    openPosition: {
        volume: 0,
        direction: "",
        costHold: 0
    },
    allTimeHigh: 0,
    peakProfit: 0,
    totalTrades: 0,
    winningTrades: 0
};

// Trade history in memory
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
    } catch (e) { 
        console.error("API Error:", e.message);
        return null; 
    }
}

// ==================== FAST UPDATE FUNCTIONS ====================
async function fetchPositionAndROI() {
    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        if (pos) {
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.openPosition = {
                volume: parseFloat(pos.volume),
                direction: pos.direction,
                costHold: parseFloat(pos.cost_hold)
            };
            
            // Calculate distance to next safety order
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);
        } else {
            botState.openPosition = { volume: 0, direction: "", costHold: 0 };
            if (botState.roi !== 0) botState.roi = 0;
        }
        
        console.log(`📊 ROI Updated: ${botState.roi}% | Price: ${botState.currentPrice}`);
    } catch (e) {
        console.error("Position fetch error:", e);
    }
}

async function fetchAccountAndBalance() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                // Also get position for unrealized PnL
                const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
                const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
                
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                const realBalance = equity - unrealized;
                
                if (realBalance > botState.peakBalance) {
                    const increase = realBalance - botState.peakBalance;
                    botState.displayBalance = botState.displayBalance + increase;
                    botState.peakBalance = realBalance;
                    
                    if (botState.displayBalance > (botState.allTimeHigh || 0)) {
                        botState.allTimeHigh = botState.displayBalance;
                    }
                    
                    console.log(`🎯 New Peak! Display: $${botState.displayBalance.toFixed(2)}`);
                }
                
                botState.walletBalance = realBalance;
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.displayBalance = botState.walletBalance;
                    botState.peakBalance = botState.walletBalance;
                    botState.allTimeHigh = botState.walletBalance;
                    botState.startTime = Date.now();
                    console.log(`🚀 Bot Initialized | Starting: $${botState.initialBalance.toFixed(2)}`);
                }
            }
        }
        
        // Update locked profit calculations
        botState.realizedProfit = botState.displayBalance - botState.initialBalance;
        botState.profitPct = botState.initialBalance > 0 ? (botState.realizedProfit / botState.initialBalance) * 100 : 0;
        
        // Update estimates based on locked profit
        const elapsedHours = (Date.now() - botState.startTime) / (1000 * 60 * 60);
        const elapsedDays = elapsedHours / 24;
        const lockedProfit = botState.realizedProfit;
        
        if (elapsedHours > 0.1 && lockedProfit > 0 && botState.initialBalance > 0) {
            const hourlyProfitRate = lockedProfit / elapsedHours;
            
            if (elapsedDays > 0.01) {
                const growthFactor = (botState.initialBalance + lockedProfit) / botState.initialBalance;
                const dgr = Math.pow(growthFactor, (1 / elapsedDays)) - 1;
                botState.estimates.dgr = dgr * 100;
            } else {
                botState.estimates.dgr = (hourlyProfitRate / botState.initialBalance) * 24 * 100;
            }
            
            botState.estimates.hr = hourlyProfitRate;
            botState.estimates.day = hourlyProfitRate * 24;
            botState.estimates.week = hourlyProfitRate * 24 * 7;
            botState.estimates.month = hourlyProfitRate * 24 * 30;
        }
        
    } catch (e) {
        console.error("Account fetch error:", e);
    }
}

async function updatePositionSizing() {
    if (botState.currentPrice > 0 && botState.walletBalance > 0) {
        const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
        const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
        const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
        botState.maxSafeBase = Math.floor(rawBase * 0.85);
        botState.settings.baseOrder = botState.maxSafeBase;
    }
}

// ==================== TRADING LOGIC ====================
async function saveTradeHistory(type, volume, price, safetyLevel, roi, balanceAfter) {
    tradeHistory.unshift({
        timestamp: Date.now(),
        type,
        volume,
        price,
        safetyLevel: safetyLevel || 0,
        roi: roi || 0,
        balanceAfter
    });
    
    // Keep only last 100 trades in memory
    if (tradeHistory.length > 100) tradeHistory.pop();
    
    if (type === 'take_profit') {
        botState.winningTrades = (botState.winningTrades || 0) + 1;
        if (roi > (botState.peakProfit || 0)) botState.peakProfit = roi;
    }
    botState.totalTrades = (botState.totalTrades || 0) + 1;
}

async function checkAndExecuteTrades() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        // Get fresh position data
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        if (pos) {
            const currentROI = parseFloat(pos.profit_rate) * 100;
            const avgPrice = parseFloat(pos.cost_hold);
            const triggerPrice = avgPrice * (1 - (botState.settings.priceDrop / 100));
            
            // Check take profit
            if (currentROI >= botState.settings.takeProfit) {
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: pos.volume,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('take_profit', parseFloat(pos.volume), botState.currentPrice, botState.safetyOrdersFilled, currentROI, botState.displayBalance);
                    botState.safetyOrdersFilled = 0;
                    console.log(`✅ Take profit! ROI: ${currentROI}%`);
                }
            }
            // Check safety order
            else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('safety', nextVol, botState.currentPrice, botState.safetyOrdersFilled, 0, botState.displayBalance);
                    console.log(`📉 Safety Order #${botState.safetyOrdersFilled} | Vol: ${nextVol}`);
                }
            }
        } 
        // Open initial position
        else if (botState.maxSafeBase > 0 && botState.settings.baseOrder > 0) {
            const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            
            if (result?.code === 200) {
                await saveTradeHistory('open', botState.settings.baseOrder, botState.currentPrice, 0, 0, botState.displayBalance);
                botState.safetyOrdersFilled = 0;
                console.log(`🎯 Position opened | Vol: ${botState.settings.baseOrder}`);
            }
        }

    } catch (e) {
        console.error("Trade execution error:", e);
    }
    botState.isTrading = false;
}

// ==================== RESET FUNCTIONS ====================
function resetStats() {
    botState.initialBalance = botState.displayBalance;
    botState.peakBalance = botState.walletBalance;
    botState.startTime = Date.now();
    botState.realizedProfit = 0;
    botState.profitPct = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    console.log("📊 Stats reset!");
    return true;
}

function forceUpdateSettings() {
    botState.settings = {
        baseOrder: botState.settings.baseOrder || 0,
        priceDrop: 0.1,
        volumeMult: 1.2,
        takeProfit: 1.5,
        maxSteps: 10
    };
    console.log("⚙️ Settings force updated to defaults!");
    return true;
}

function fullReset() {
    botState = {
        isRunning: true,
        isTrading: false,
        startTime: Date.now(),
        currentPrice: botState.currentPrice,
        avgPrice: 0,
        roi: 0,
        realizedProfit: 0,
        profitPct: 0,
        walletBalance: botState.walletBalance,
        displayBalance: botState.walletBalance,
        peakBalance: botState.walletBalance,
        initialBalance: botState.walletBalance,
        maxSafeBase: 0,
        safetyOrdersFilled: 0,
        distToNext: 0,
        settings: {
            baseOrder: 0,
            priceDrop: 0.1,
            volumeMult: 1.2,
            takeProfit: 1.5,
            maxSteps: 10
        },
        estimates: {
            hr: 0,
            day: 0,
            week: 0,
            month: 0,
            dgr: 0
        },
        openPosition: {
            volume: 0,
            direction: "",
            costHold: 0
        },
        allTimeHigh: botState.walletBalance,
        peakProfit: 0,
        totalTrades: 0,
        winningTrades: 0
    };
    tradeHistory = [];
    console.log("🗑️ Full reset completed!");
    return true;
}

// ==================== STARTUP ====================
async function boot() {
    // WebSocket for real-time price
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) {
                        botState.currentPrice = parseFloat(msg.tick.close);
                    }
                    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
                } catch (e) {}
            }
        });
    });
    
    // Fast loops for real-time updates (every 1 second)
    setInterval(async () => {
        await fetchPositionAndROI();
        await updatePositionSizing();
    }, 1000);
    
    setInterval(async () => {
        await fetchAccountAndBalance();
    }, 2000);
    
    // Trade execution every 2 seconds
    setInterval(async () => {
        await checkAndExecuteTrades();
    }, 2000);
    
    console.log(`🤖 Bot started | ${config.symbol} | ${config.leverage}X`);
    console.log(`📊 No database - using memory only | Settings: TP=${botState.settings.takeProfit}%, MaxSteps=${botState.settings.maxSteps}`);
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Compounder | No DB Edition</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card-glow { box-shadow: 0 4px 20px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .progress-bar { background: linear-gradient(90deg, #059669 0%, #0284c7 100%); }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
        @keyframes pulse-green {
            0% { transform: scale(1); }
            50% { transform: scale(1.02); background-color: rgba(5, 150, 105, 0.1); }
            100% { transform: scale(1); }
        }
        .balance-update { animation: pulse-green 0.3s ease; }
        .roi-update { animation: pulse-green 0.3s ease; }
        .btn-danger { transition: all 0.2s ease; }
        .btn-danger:hover { background-color: #dc2626 !important; transform: scale(1.02); color: white !important; }
        .btn-warning:hover { background-color: #d97706 !important; transform: scale(1.02); }
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-gray-900 text-3xl font-bold tracking-tight">
                    COMPOUND<span class="gradient-text">_BOT</span>
                    <span class="text-sm font-mono text-gray-400 ml-2">No DB</span>
                </h1>
                <p class="text-xs text-gray-400 uppercase tracking-wider mt-1">${config.symbol} | ${config.leverage}X Leverage</p>
                <p class="text-[10px] text-emerald-600 mt-2">⚡ Memory-only | Settings: TP=${botState.settings.takeProfit}% | Steps=${botState.settings.maxSteps}</p>
            </div>
            <div class="text-right">
                <p class="text-3xl font-bold text-emerald-600" id="dgrText">0.00%</p>
                <p class="text-[10px] text-gray-400 uppercase tracking-wider">Daily Growth Rate</p>
            </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            <div class="card p-6 rounded-2xl card-glow">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Net Profit (Locked)</p>
                <p id="p1" class="text-3xl font-bold text-emerald-600 stat-number">$0.000000</p>
                <p class="text-[9px] text-gray-400 mt-1">Trades: <span id="totalTrades">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Total Gain</p>
                <p id="p2" class="text-3xl font-bold text-emerald-600 stat-number">0.000000%</p>
                <p class="text-[9px] text-gray-400 mt-1">Winning: <span id="winningTrades">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Open Position ROI</p>
                <p id="roi" class="text-3xl font-bold stat-number">0.00%</p>
                <p class="text-[9px] text-gray-400 mt-1">Vol: <span id="openVol">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Display Balance</p>
                <p id="bal" class="text-3xl font-bold text-gray-900 stat-number">$0.00</p>
                <p class="text-[9px] text-gray-400 mt-1">Real: <span id="realBal">$0.00</span> | ATH: <span id="ath">$0.00</span></p>
            </div>
        </div>

        <div class="card p-6 rounded-2xl card-glow mb-8 bg-gradient-to-r from-gray-50 to-white">
            <div class="flex justify-between items-center">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Base Start Contracts</p>
                    <p id="baseOrderDisplay" class="text-3xl font-bold text-blue-600 stat-number">0</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Max Safe Base</p>
                    <p id="maxSafeBaseDisplay" class="text-2xl font-bold text-gray-700 stat-number">0</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Multiplier</p>
                    <p class="text-2xl font-bold text-purple-600">${botState.settings.volumeMult || 1.2}X</p>
                </div>
            </div>
            <div class="mt-4 pt-3 border-t border-gray-100">
                <div class="flex justify-between text-[10px] text-gray-400">
                    <span>Safety Orders:</span>
                    <span>1st: <span id="so1">0</span> | 2nd: <span id="so2">0</span> | 3rd: <span id="so3">0</span> | 4th: <span id="so4">0</span> | 5th: <span id="so5">0</span></span>
                </div>
            </div>
        </div>

        <h2 class="text-gray-500 text-[11px] font-bold uppercase tracking-wider mb-4">Compounding Estimates (Based on Locked Profit)</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            <div class="bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-200 p-8 rounded-2xl">
                <p class="text-[10px] text-emerald-700 font-bold uppercase tracking-wider mb-2">Next 24 Hours</p>
                <p id="estDay" class="text-4xl font-bold text-emerald-900 stat-number">$0.000000</p>
            </div>
            <div class="card p-8 rounded-2xl">
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 7 Days</p>
                <p id="estWeek" class="text-4xl font-bold text-gray-900 stat-number">$0.000000</p>
            </div>
            <div class="card p-8 rounded-2xl border-l-4 border-l-emerald-500">
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 30 Days</p>
                <p id="estMonth" class="text-4xl font-bold text-emerald-700 stat-number">$0.000000</p>
            </div>
        </div>

        <div class="card p-8 rounded-2xl card-glow mb-8">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Safety Orders Filled</p>
                    <p id="stepText" class="text-5xl font-bold text-gray-900 stat-number">0 <span class="text-2xl text-gray-400">/ ${botState.settings.maxSteps}</span></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Next Step Distance</p>
                    <p id="distText" class="text-4xl font-bold text-orange-500 stat-number">0.000%</p>
                </div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div id="progressBar" class="progress-bar h-full transition-all duration-300 rounded-full" style="width: 0%"></div>
            </div>
            <div id="riskWarning" class="mt-4 hidden">
                <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p class="text-amber-700 text-xs font-semibold">⚠️ High Risk Zone</p>
                </div>
            </div>
        </div>

        <!-- BUTTONS SECTION -->
        <div class="flex justify-between items-center mb-8 gap-4 flex-wrap">
            <div class="flex gap-3">
                <button onclick="resetStats()" class="text-gray-600 hover:text-red-600 transition-colors px-4 py-2 rounded-lg bg-gray-100 hover:bg-red-50 text-sm font-medium border border-gray-200">📊 Reset Stats</button>
                <button onclick="forceUpdate()" class="text-amber-600 hover:text-amber-700 transition-colors px-4 py-2 rounded-lg bg-amber-50 hover:bg-amber-100 text-sm font-medium border border-amber-200">⚙️ Force Update Settings</button>
                <button onclick="fullReset()" class="text-red-600 hover:text-white transition-colors px-4 py-2 rounded-lg bg-red-50 hover:bg-red-600 text-sm font-medium border border-red-200">🗑️ Full Reset</button>
            </div>
            <div class="flex gap-3">
                <button onclick="viewHistory()" class="text-blue-500 hover:text-blue-700 transition-colors px-4 py-2 rounded-lg bg-blue-50 hover:bg-blue-100 text-sm font-medium">📜 Trade History</button>
                <button onclick="refreshUI()" class="text-gray-500 hover:text-gray-700 transition-colors px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-medium">🔄 Refresh</button>
            </div>
        </div>

        <div class="flex justify-between items-center text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            <div>Avg Profit/Hr: <span id="estHr" class="text-gray-600 ml-1">$0.000000</span></div>
            <div class="flex gap-6 items-center">
                <span>Price: <span id="curPrice" class="text-gray-900 font-mono ml-1">0.00000000</span></span>
                <span>TP: <span id="tpDisplay" class="text-emerald-600 font-mono ml-1">${botState.settings.takeProfit}%</span></span>
                <span>Drop: <span id="dropDisplay" class="text-orange-600 font-mono ml-1">${botState.settings.priceDrop}%</span></span>
            </div>
        </div>
    </div>

    <script>
        let lastROI = 0;
        let lastBalance = 0;
        
        function calculateSafetyOrders(baseOrder, multiplier) {
            const orders = [];
            for (let i = 1; i <= 5; i++) {
                orders.push(Math.floor(baseOrder * Math.pow(multiplier, i)));
            }
            return orders;
        }
        
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('p1').innerHTML = '$' + d.realizedProfit.toFixed(6);
                document.getElementById('p2').innerHTML = d.profitPct.toFixed(6) + '%';
                document.getElementById('totalTrades').innerHTML = d.totalTrades || 0;
                document.getElementById('winningTrades').innerHTML = d.winningTrades || 0;
                document.getElementById('openVol').innerHTML = d.openPosition?.volume?.toFixed(0) || 0;
                document.getElementById('ath').innerHTML = '$' + (d.allTimeHigh || d.displayBalance).toFixed(2);
                document.getElementById('tpDisplay').innerHTML = d.settings?.takeProfit + '%';
                document.getElementById('dropDisplay').innerHTML = d.settings?.priceDrop + '%';
                
                if (d.roi !== lastROI) {
                    const roiEl = document.getElementById('roi');
                    roiEl.classList.add('roi-update');
                    setTimeout(() => roiEl.classList.remove('roi-update'), 300);
                    lastROI = d.roi;
                }
                
                const roiEl = document.getElementById('roi');
                roiEl.innerHTML = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-3xl font-bold stat-number ' + (d.roi >= 0 ? 'text-emerald-600' : 'text-red-500');
                
                document.getElementById('baseOrderDisplay').innerHTML = d.settings.baseOrder || 0;
                document.getElementById('maxSafeBaseDisplay').innerHTML = d.maxSafeBase || 0;
                
                const safetyOrders = calculateSafetyOrders(d.settings.baseOrder || 0, d.settings.volumeMult || 1.2);
                for (let i = 1; i <= 5; i++) {
                    const el = document.getElementById('so' + i);
                    if (el) el.innerHTML = safetyOrders[i-1] || 0;
                }
                
                if (d.displayBalance > lastBalance) {
                    const balElement = document.getElementById('bal');
                    balElement.classList.add('balance-update');
                    setTimeout(() => balElement.classList.remove('balance-update'), 300);
                    lastBalance = d.displayBalance;
                }
                
                document.getElementById('bal').innerHTML = '$' + d.displayBalance.toFixed(2);
                document.getElementById('realBal').innerHTML = '$' + d.walletBalance.toFixed(2);
                document.getElementById('dgrText').innerHTML = d.estimates.dgr.toFixed(4) + '%';
                
                document.getElementById('estHr').innerHTML = '$' + d.estimates.hr.toFixed(6);
                document.getElementById('estDay').innerHTML = '$' + d.estimates.day.toFixed(6);
                document.getElementById('estWeek').innerHTML = '$' + d.estimates.week.toFixed(6);
                document.getElementById('estMonth').innerHTML = '$' + d.estimates.month.toFixed(6);

                document.getElementById('curPrice').innerHTML = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-2xl text-gray-400">/ ' + (d.settings?.maxSteps || 10) + '</span>';
                document.getElementById('distText').innerHTML = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / (d.settings?.maxSteps || 10)) * 100;
                document.getElementById('progressBar').style.width = progressPct + '%';
                
                const warning = document.getElementById('riskWarning');
                if (progressPct > 60) warning.classList.remove('hidden');
                else warning.classList.add('hidden');

            } catch (e) {}
        }
        
        async function resetStats() { 
            if(confirm("Reset stats only? (Keep position and balance)")) {
                await fetch('/api/reset-stats', {method:'POST'});
                update();
            }
        }
        
        async function forceUpdate() {
            if(confirm("Force update settings to defaults? (TP=1.5%, Drop=0.1%, MaxSteps=10)")) {
                await fetch('/api/force-update', {method:'POST'});
                setTimeout(() => update(), 500);
            }
        }
        
        async function fullReset() {
            if(confirm("⚠️ FULL RESET - Clear all trades and reset to current balance? This cannot be undone!")) {
                await fetch('/api/full-reset', {method:'POST'});
                setTimeout(() => update(), 500);
            }
        }
        
        async function viewHistory() {
            const r = await fetch('/api/trade-history');
            const trades = await r.json();
            if (trades.length === 0) alert('No trades yet.');
            else {
                let msg = '📊 Last 20 Trades:\\n\\n';
                trades.slice(0, 20).forEach(t => {
                    msg += \`\${new Date(t.timestamp).toLocaleString()} | \${t.type.toUpperCase()} | Vol: \${t.volume} | ROI: \${t.roi}%\\n\`;
                });
                alert(msg);
            }
        }
        
        function refreshUI() { update(); }
        
        setInterval(update, 500);
        update();
    </script>
</body>
</html>`);
});

// ==================== API ENDPOINTS ====================
app.get('/api/status', async (req, res) => {
    res.json({
        ...botState,
        displayBalance: botState.displayBalance,
        walletBalance: botState.walletBalance,
        allTimeHigh: botState.allTimeHigh,
        totalTrades: botState.totalTrades,
        winningTrades: botState.winningTrades,
        roi: botState.roi
    });
});

app.get('/api/trade-history', async (req, res) => {
    res.json(tradeHistory.slice(0, 50));
});

app.post('/api/reset-stats', async (req, res) => {
    resetStats();
    res.sendStatus(200);
});

app.post('/api/force-update', async (req, res) => {
    forceUpdateSettings();
    res.sendStatus(200);
});

app.post('/api/full-reset', async (req, res) => {
    fullReset();
    res.sendStatus(200);
});

process.on('SIGINT', async () => {
    console.log('Shutting down...');
    process.exit();
});

app.listen(config.port, () => {
    console.log(`🌐 Web UI: http://localhost:${config.port}`);
    boot();
});
