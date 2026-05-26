//

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

// Full Persistent Schema - EVERYTHING is stored
const BotStateSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale_main", unique: true },
    
    // Balance Tracking
    initialBalance: { type: Number, default: 0 },
    displayBalance: { type: Number, default: 0 },
    peakBalance: { type: Number, default: 0 },
    walletBalance: { type: Number, default: 0 },
    realizedProfit: { type: Number, default: 0 },
    profitPct: { type: Number, default: 0 },
    
    // Trading State
    currentPrice: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
    roi: { type: Number, default: 0 },
    safetyOrdersFilled: { type: Number, default: 0 },
    distToNext: { type: Number, default: 0 },
    maxSafeBase: { type: Number, default: 0 },
    
    // Settings
    settings: {
        baseOrder: { type: Number, default: 0 },
        priceDrop: { type: Number, default: 0.1 },
        volumeMult: { type: Number, default: 1.2 },
        takeProfit: { type: Number, default: 1.5 },
        maxSteps: { type: Number, default: 10 }
    },
    
    // Estimations
    estimates: {
        hr: { type: Number, default: 0 },
        day: { type: Number, default: 0 },
        week: { type: Number, default: 0 },
        month: { type: Number, default: 0 },
        dgr: { type: Number, default: 0 }
    },
    
    // Metadata
    isRunning: { type: Boolean, default: true },
    startTime: { type: Number, default: Date.now },
    lastUpdate: { type: Number, default: Date.now },
    
    // Position Data (for safety)
    openPosition: {
        volume: { type: Number, default: 0 },
        direction: { type: String, default: "" },
        costHold: { type: Number, default: 0 }
    },
    
    // Historical tracking
    allTimeHigh: { type: Number, default: 0 },
    peakProfit: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 }
});

const BotState = mongoose.model('BotState_Persistent', BotStateSchema);

// Trade History Schema
const TradeHistorySchema = new mongoose.Schema({
    timestamp: { type: Number, default: Date.now },
    type: { type: String, enum: ['open', 'safety', 'take_profit', 'reset'] },
    volume: Number,
    price: Number,
    safetyLevel: Number,
    roi: Number,
    balanceAfter: Number
});

const TradeHistory = mongoose.model('TradeHistory', TradeHistorySchema);

// Daily Snapshot Schema
const DailySnapshotSchema = new mongoose.Schema({
    date: { type: String, unique: true }, // YYYY-MM-DD
    displayBalance: Number,
    walletBalance: Number,
    profit: Number,
    profitPct: Number,
    dgr: Number,
    tradesToday: Number
});

const DailySnapshot = mongoose.model('DailySnapshot', DailySnapshotSchema);

// Connect to MongoDB
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log("📦 MongoDB Connected - Persistent Storage Active"));

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

// Global bot state (loaded from DB)
let botState = {};

// ==================== PERSISTENCE FUNCTIONS ====================
async function saveStateToDB() {
    try {
        await BotState.updateOne(
            { id: "htx_martingale_main" },
            {
                initialBalance: botState.initialBalance,
                displayBalance: botState.displayBalance,
                peakBalance: botState.peakBalance,
                walletBalance: botState.walletBalance,
                realizedProfit: botState.realizedProfit,
                profitPct: botState.profitPct,
                currentPrice: botState.currentPrice,
                avgPrice: botState.avgPrice,
                roi: botState.roi,
                safetyOrdersFilled: botState.safetyOrdersFilled,
                distToNext: botState.distToNext,
                maxSafeBase: botState.maxSafeBase,
                settings: botState.settings,
                estimates: botState.estimates,
                isRunning: botState.isRunning,
                startTime: botState.startTime,
                lastUpdate: Date.now(),
                openPosition: botState.openPosition || { volume: 0, direction: "", costHold: 0 },
                allTimeHigh: botState.allTimeHigh || botState.peakBalance,
                peakProfit: botState.peakProfit || 0,
                totalTrades: botState.totalTrades || 0,
                winningTrades: botState.winningTrades || 0
            },
            { upsert: true }
        );
        console.log(`💾 State saved to DB | Balance: $${botState.displayBalance?.toFixed(2)}`);
    } catch (e) {
        console.error("DB Save Error:", e);
    }
}

async function loadStateFromDB() {
    const data = await BotState.findOne({ id: "htx_martingale_main" });
    
    if (data) {
        botState = {
            isRunning: data.isRunning ?? true,
            isTrading: false,
            startTime: data.startTime ?? Date.now(),
            currentPrice: data.currentPrice ?? 0,
            avgPrice: data.avgPrice ?? 0,
            roi: data.roi ?? 0,
            realizedProfit: data.realizedProfit ?? 0,
            profitPct: data.profitPct ?? 0,
            walletBalance: data.walletBalance ?? 0,
            displayBalance: data.displayBalance ?? 0,
            peakBalance: data.peakBalance ?? 0,
            initialBalance: data.initialBalance ?? 0,
            maxSafeBase: data.maxSafeBase ?? 0,
            safetyOrdersFilled: data.safetyOrdersFilled ?? 0,
            distToNext: data.distToNext ?? 0,
            estimates: data.estimates ?? { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
            settings: data.settings ?? { baseOrder: 0, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5, maxSteps: 10 },
            openPosition: data.openPosition ?? { volume: 0, direction: "", costHold: 0 },
            allTimeHigh: data.allTimeHigh ?? 0,
            peakProfit: data.peakProfit ?? 0,
            totalTrades: data.totalTrades ?? 0,
            winningTrades: data.winningTrades ?? 0
        };
        
        console.log(`📀 Loaded from DB | Display: $${botState.displayBalance.toFixed(2)} | Real: $${botState.walletBalance.toFixed(2)} | Trades: ${botState.totalTrades}`);
    } else {
        // First time setup
        botState = {
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
            estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
            settings: { baseOrder: 0, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5, maxSteps: 10 },
            openPosition: { volume: 0, direction: "", costHold: 0 },
            allTimeHigh: 0,
            peakProfit: 0,
            totalTrades: 0,
            winningTrades: 0
        };
        console.log("🆕 No existing state found - Creating new session");
    }
    return botState;
}

async function saveTradeHistory(type, volume, price, safetyLevel, roi, balanceAfter) {
    try {
        await TradeHistory.create({
            timestamp: Date.now(),
            type,
            volume,
            price,
            safetyLevel: safetyLevel || 0,
            roi: roi || 0,
            balanceAfter
        });
        
        // Update trade counters
        if (type === 'take_profit') {
            botState.winningTrades = (botState.winningTrades || 0) + 1;
            if (roi > (botState.peakProfit || 0)) botState.peakProfit = roi;
        }
        botState.totalTrades = (botState.totalTrades || 0) + 1;
        
    } catch (e) {
        console.error("Trade history save error:", e);
    }
}

async function saveDailySnapshot() {
    const today = new Date().toISOString().split('T')[0];
    const existing = await DailySnapshot.findOne({ date: today });
    
    if (!existing && botState.displayBalance > 0) {
        await DailySnapshot.create({
            date: today,
            displayBalance: botState.displayBalance,
            walletBalance: botState.walletBalance,
            profit: botState.realizedProfit,
            profitPct: botState.profitPct,
            dgr: botState.estimates.dgr,
            tradesToday: 0
        });
        console.log(`📸 Daily snapshot saved for ${today}`);
    }
}

// Auto-save every 30 seconds
setInterval(saveStateToDB, 30000);
// Daily snapshot at midnight
setInterval(() => saveDailySnapshot(), 3600000);

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

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        const [posRes, accRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol }),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' })
        ]);

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        // Update open position tracking
        if (pos) {
            botState.openPosition = {
                volume: parseFloat(pos.volume),
                direction: pos.direction,
                costHold: parseFloat(pos.cost_hold)
            };
        } else {
            botState.openPosition = { volume: 0, direction: "", costHold: 0 };
        }
        
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                const realBalance = equity - unrealized;
                
                // NEW LOGIC: Only update display balance when REAL balance increases
                if (realBalance > botState.peakBalance) {
                    const increase = realBalance - botState.peakBalance;
                    botState.displayBalance = botState.displayBalance + increase;
                    botState.peakBalance = realBalance;
                    
                    // Update all-time high tracking
                    if (botState.displayBalance > (botState.allTimeHigh || 0)) {
                        botState.allTimeHigh = botState.displayBalance;
                    }
                    
                    console.log(`🎯 New Peak Balance! Real: $${realBalance.toFixed(2)} | Display: $${botState.displayBalance.toFixed(2)} | Increase: $${increase.toFixed(2)}`);
                    
                    // Save immediately on new high
                    await saveStateToDB();
                }
                
                botState.walletBalance = realBalance;
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.displayBalance = botState.walletBalance;
                    botState.peakBalance = botState.walletBalance;
                    botState.allTimeHigh = botState.walletBalance;
                    botState.startTime = Date.now();
                    console.log(`🚀 Bot Initialized | Starting Balance: $${botState.initialBalance.toFixed(2)}`);
                    await saveStateToDB();
                }
            }
        }

        // Compounding Math using DISPLAY balance (static, only increases)
        const elapsedDays = (Date.now() - botState.startTime) / (1000 * 60 * 60 * 24);
        if (elapsedDays > 0.001 && botState.displayBalance > botState.initialBalance) {
            const dgr = Math.pow((botState.displayBalance / botState.initialBalance), (1 / elapsedDays)) - 1;
            botState.estimates.dgr = dgr * 100;
            botState.estimates.hr = (botState.displayBalance - botState.initialBalance) / (elapsedDays * 24);
            botState.estimates.day = botState.displayBalance * dgr;
            botState.estimates.week = (botState.displayBalance * Math.pow((1 + dgr), 7)) - botState.displayBalance;
            botState.estimates.month = (botState.displayBalance * Math.pow((1 + dgr), 30)) - botState.displayBalance;
        }

        // Position sizing uses REAL wallet balance for safety
        if (botState.currentPrice > 0 && botState.walletBalance > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
            botState.maxSafeBase = Math.floor(rawBase * 0.85);
            botState.settings.baseOrder = botState.maxSafeBase;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;

            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);

            if (botState.roi >= botState.settings.takeProfit) {
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: pos.volume,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('take_profit', parseFloat(pos.volume), botState.currentPrice, botState.safetyOrdersFilled, botState.roi, botState.displayBalance);
                    botState.safetyOrdersFilled = 0;
                    console.log(`✅ Take profit triggered | ROI: ${botState.roi}%`);
                    await saveStateToDB();
                }
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('safety', nextVol, botState.currentPrice, botState.safetyOrdersFilled, 0, botState.displayBalance);
                    console.log(`📉 Safety Order #${botState.safetyOrdersFilled} | Volume: ${nextVol}`);
                    await saveStateToDB();
                }
            }
        } else if (botState.maxSafeBase > 0 && botState.settings.baseOrder > 0) {
            const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            
            if (result?.code === 200) {
                await saveTradeHistory('open', botState.settings.baseOrder, botState.currentPrice, 0, 0, botState.displayBalance);
                botState.safetyOrdersFilled = 0;
                console.log(`🎯 Initial position opened | Volume: ${botState.settings.baseOrder}`);
                await saveStateToDB();
            }
        }

        // Profit calculations based on DISPLAY balance (static)
        botState.realizedProfit = botState.displayBalance - botState.initialBalance;
        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100 || 0;

    } catch (e) {
        console.error("Trading error:", e);
    }
    botState.isTrading = false;
}

// ==================== STARTUP ====================
async function boot() {
    await loadStateFromDB();
    
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
                    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
                } catch (e) {}
            }
        });
    });
    
    // Run logic every 3 seconds
    setInterval(runLogic, 3000);
    
    console.log(`🤖 Bot started | Symbol: ${config.symbol} | Leverage: ${config.leverage}X`);
    console.log(`📊 Initial State | Display: $${botState.displayBalance.toFixed(2)} | Real: $${botState.walletBalance.toFixed(2)}`);
}

// ==================== UI - FULL FEATURED DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Compounder V33 | Persistent Database Edition</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card-glow { box-shadow: 0 4px 20px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.03); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .progress-bar { background: linear-gradient(90deg, #059669 0%, #0284c7 100%); }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
        .balance-static { transition: all 0.3s ease; }
        @keyframes pulse-green {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); background-color: rgba(5, 150, 105, 0.1); }
            100% { transform: scale(1); }
        }
        .balance-update { animation: pulse-green 0.5s ease; }
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-gray-900 text-3xl font-bold tracking-tight">
                    COMPOUND<span class="gradient-text">_BOT</span>
                    <span class="text-sm font-mono text-gray-400 ml-2">v33</span>
                </h1>
                <p class="text-xs text-gray-400 uppercase tracking-wider mt-1">${config.symbol} | ${config.leverage}X Leverage</p>
                <p class="text-[10px] text-emerald-600 mt-2">✨ Persistent Database | Balance only increases on new highs</p>
            </div>
            <div class="text-right">
                <p class="text-3xl font-bold text-emerald-600" id="dgrText">0.00%</p>
                <p class="text-[10px] text-gray-400 uppercase tracking-wider">Daily Growth Rate</p>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Net Profit (Locked)</p>
                <p id="p1" class="text-3xl font-bold text-emerald-600 stat-number">$0.00</p>
                <p class="text-[9px] text-gray-400 mt-1">Total trades: <span id="totalTrades">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Total Gain</p>
                <p id="p2" class="text-3xl font-bold text-emerald-600 stat-number">0.00%</p>
                <p class="text-[9px] text-gray-400 mt-1">Winning trades: <span id="winningTrades">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Open Position ROI</p>
                <p id="roi" class="text-3xl font-bold text-gray-600 stat-number">0.00%</p>
                <p class="text-[9px] text-gray-400 mt-1">Open vol: <span id="openVol">0</span></p>
            </div>
            <div class="card p-6 rounded-2xl card-glow transition-all hover:shadow-md">
                <p class="text-[11px] text-gray-400 uppercase tracking-wider mb-2">Display Balance</p>
                <p id="bal" class="text-3xl font-bold text-gray-900 stat-number balance-static">$0.00</p>
                <p class="text-[9px] text-gray-400 mt-1">Real: <span id="realBal">$0.00</span> | ATH: <span id="ath">$0.00</span></p>
            </div>
        </div>

        <!-- Compounding Projections -->
        <h2 class="text-gray-500 text-[11px] font-bold uppercase tracking-wider mb-4">Compounding Estimates (Based on Locked Balance)</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
            
            <div class="bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-200 p-8 rounded-2xl card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-10 text-6xl italic font-black text-emerald-900">24H</div>
                <p class="text-[10px] text-emerald-700 font-bold uppercase tracking-wider mb-2">Next 24 Hours</p>
                <p id="estDay" class="text-4xl font-bold text-emerald-900 stat-number">$0.00</p>
                <p class="text-[10px] text-emerald-600 mt-4 font-semibold">ESTIMATED EARNINGS</p>
            </div>

            <div class="card p-8 rounded-2xl card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-6xl italic font-black text-gray-900">7D</div>
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 7 Days</p>
                <p id="estWeek" class="text-4xl font-bold text-gray-900 stat-number">$0.00</p>
                <p class="text-[10px] text-gray-400 mt-4 font-semibold">COMPOUNDED GROWTH</p>
            </div>

            <div class="card p-8 rounded-2xl border-l-4 border-l-emerald-500 card-glow relative overflow-hidden">
                <div class="absolute top-0 right-0 p-4 opacity-5 text-6xl italic font-black text-gray-900">30D</div>
                <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-2">Next 30 Days</p>
                <p id="estMonth" class="text-4xl font-bold text-emerald-700 stat-number">$0.00</p>
                <p class="text-[10px] text-gray-400 mt-4 font-semibold">PROJECTED PROFIT</p>
            </div>
        </div>

        <!-- Risk & Progress -->
        <div class="card p-8 rounded-2xl card-glow mb-8">
            <div class="flex justify-between items-end mb-6">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Safety Orders Filled</p>
                    <p id="stepText" class="text-5xl font-bold text-gray-900 stat-number">0 <span class="text-2xl text-gray-400">/ 10</span></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Next Step Distance</p>
                    <p id="distText" class="text-4xl font-bold text-orange-500 stat-number">0.00%</p>
                </div>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div id="progressBar" class="progress-bar h-full transition-all duration-500 rounded-full" style="width: 0%"></div>
            </div>
            
            <div id="riskWarning" class="mt-4 hidden">
                <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p class="text-amber-700 text-xs font-semibold">⚠️ High Risk Zone - Multiple safety orders activated</p>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="flex justify-between items-center text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            <div>Avg Profit/Hr: <span id="estHr" class="text-gray-600 ml-1">$0.00</span></div>
            <div class="flex gap-6 items-center">
                <span>Price: <span id="curPrice" class="text-gray-900 font-mono ml-1">0.00</span></span>
                <button onclick="resetStats()" class="text-gray-400 hover:text-red-500 transition-colors px-3 py-1 rounded-lg hover:bg-red-50">Reset Session</button>
                <button onclick="viewHistory()" class="text-blue-500 hover:text-blue-700 transition-colors px-3 py-1 rounded-lg hover:bg-blue-50">Trade History</button>
            </div>
        </div>
    </div>

    <script>
        let lastBalance = 0;
        
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('p1').innerHTML = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerHTML = d.profitPct.toFixed(2) + '%';
                document.getElementById('totalTrades').innerHTML = d.totalTrades || 0;
                document.getElementById('winningTrades').innerHTML = d.winningTrades || 0;
                document.getElementById('openVol').innerHTML = d.openPosition?.volume?.toFixed(0) || 0;
                document.getElementById('ath').innerHTML = '$' + (d.allTimeHigh || d.displayBalance).toFixed(2);
                
                const roiEl = document.getElementById('roi');
                roiEl.innerHTML = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-3xl font-bold stat-number ' + (d.roi >= 0 ? 'text-emerald-600' : 'text-red-500');
                
                // Animate balance on increase
                if (d.displayBalance > lastBalance) {
                    const balElement = document.getElementById('bal');
                    balElement.classList.add('balance-update');
                    setTimeout(() => balElement.classList.remove('balance-update'), 500);
                }
                lastBalance = d.displayBalance;
                
                document.getElementById('bal').innerHTML = '$' + d.displayBalance.toFixed(2);
                document.getElementById('realBal').innerHTML = '$' + d.walletBalance.toFixed(2);
                document.getElementById('dgrText').innerHTML = d.estimates.dgr.toFixed(2) + '%';
                
                document.getElementById('estHr').innerHTML = '$' + d.estimates.hr.toFixed(2);
                document.getElementById('estDay').innerHTML = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerHTML = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerHTML = '$' + d.estimates.month.toFixed(0);

                document.getElementById('curPrice').innerHTML = d.currentPrice.toFixed(8);
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-2xl text-gray-400">/ ' + d.settings.maxSteps + '</span>';
                document.getElementById('distText').innerHTML = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = progressPct + '%';
                
                const warning = document.getElementById('riskWarning');
                if (progressPct > 60) {
                    warning.classList.remove('hidden');
                    if (progressPct > 75) bar.style.background = 'linear-gradient(90deg, #dc2626 0%, #ea580c 100%)';
                    else if (progressPct > 60) bar.style.background = 'linear-gradient(90deg, #f59e0b 0%, #ea580c 100%)';
                } else {
                    warning.classList.add('hidden');
                    bar.style.background = 'linear-gradient(90deg, #059669 0%, #0284c7 100%)';
                }

            } catch (e) {}
        }
        
        async function resetStats() { 
            if(confirm("⚠️ Warning: This resets Initial Balance and Projections. Your display balance stays at current level. Continue?")) {
                await fetch('/api/reset-stats', {method:'POST'});
                update();
            }
        }
        
        async function viewHistory() {
            const r = await fetch('/api/trade-history');
            const trades = await r.json();
            if (trades.length === 0) {
                alert('No trades recorded yet.');
                return;
            }
            let msg = '📊 Last 20 Trades:\\n\\n';
            trades.slice(0, 20).forEach(t => {
                msg += \`\${new Date(t.timestamp).toLocaleString()} | \${t.type.toUpperCase()} | Vol: \${t.volume} | ROI: \${t.roi}%\\n\`;
            });
            alert(msg);
        }
        
        setInterval(update, 1000); 
        update();
    </script>
    <style>
        .balance-static {
            transition: transform 0.3s ease;
        }
        .balance-update {
            animation: pulse-green 0.5s ease;
        }
        @keyframes pulse-green {
            0% { transform: scale(1); background-color: transparent; border-radius: 8px; }
            50% { transform: scale(1.02); background-color: rgba(5, 150, 105, 0.1); border-radius: 8px; }
            100% { transform: scale(1); background-color: transparent; border-radius: 8px; }
        }
    </style>
</body>
</html>`);
});

app.get('/api/status', async (req, res) => {
    // Refresh from DB before sending
    await loadStateFromDB();
    res.json({
        ...botState,
        displayBalance: botState.displayBalance,
        walletBalance: botState.walletBalance,
        allTimeHigh: botState.allTimeHigh,
        totalTrades: botState.totalTrades,
        winningTrades: botState.winningTrades,
        peakProfit: botState.peakProfit
    });
});

app.get('/api/trade-history', async (req, res) => {
    const trades = await TradeHistory.find().sort({ timestamp: -1 }).limit(50);
    res.json(trades);
});

app.post('/api/reset-stats', async (req, res) => {
    await saveTradeHistory('reset', 0, botState.currentPrice, 0, 0, botState.displayBalance);
    
    botState.initialBalance = botState.displayBalance;
    botState.peakBalance = botState.walletBalance;
    botState.startTime = Date.now();
    botState.realizedProfit = 0;
    botState.profitPct = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    
    await saveStateToDB();
    console.log(`🔄 Session Reset | New starting balance: $${botState.initialBalance}`);
    res.sendStatus(200);
});

app.post('/api/save-now', async (req, res) => {
    await saveStateToDB();
    res.sendStatus(200);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Saving state before shutdown...');
    await saveStateToDB();
    await mongoose.disconnect();
    process.exit();
});

app.listen(config.port, () => {
    console.log(`🌐 Web UI: http://localhost:${config.port}`);
    boot();
});
