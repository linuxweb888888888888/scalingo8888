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

const BotStateSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale_main", unique: true },
    initialBalance: { type: Number, default: 0 },
    displayBalance: { type: Number, default: 0 },
    peakBalance: { type: Number, default: 0 },
    walletBalance: { type: Number, default: 0 },
    realizedProfit: { type: Number, default: 0 },
    profitPct: { type: Number, default: 0 },
    currentPrice: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
    roi: { type: Number, default: 0 },
    safetyOrdersFilled: { type: Number, default: 0 },
    distToNext: { type: Number, default: 0 },
    maxSafeBase: { type: Number, default: 0 },
    settings: {
        baseOrder: { type: Number, default: 0 },
        priceDrop: { type: Number, default: 0.1 },
        volumeMult: { type: Number, default: 1.2 },
        takeProfit: { type: Number, default: 1.5 },
        maxSteps: { type: Number, default: 30 }
    },
    estimates: {
        hr: { type: Number, default: 0 },
        day: { type: Number, default: 0 },
        week: { type: Number, default: 0 },
        month: { type: Number, default: 0 },
        dgr: { type: Number, default: 0 }
    },
    isRunning: { type: Boolean, default: true },
    startTime: { type: Number, default: Date.now },
    lastUpdate: { type: Number, default: Date.now },
    openPosition: {
        volume: { type: Number, default: 0 },
        direction: { type: String, default: "" },
        costHold: { type: Number, default: 0 }
    },
    allTimeHigh: { type: Number, default: 0 },
    peakProfit: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 }
});

const BotState = mongoose.model('BotState_Persistent', BotStateSchema);

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

const DailySnapshotSchema = new mongoose.Schema({
    date: { type: String, unique: true },
    displayBalance: Number,
    walletBalance: Number,
    profit: Number,
    profitPct: Number,
    dgr: Number,
    tradesToday: Number
});

const DailySnapshot = mongoose.model('DailySnapshot', DailySnapshotSchema);

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

let botState = {};
let lastPositionFetch = 0;
let lastAccountFetch = 0;
const FETCH_INTERVAL = 1000;

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
            settings: data.settings ?? { baseOrder: 0, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5, maxSteps: 30 },
            openPosition: data.openPosition ?? { volume: 0, direction: "", costHold: 0 },
            allTimeHigh: data.allTimeHigh ?? 0,
            peakProfit: data.peakProfit ?? 0,
            totalTrades: data.totalTrades ?? 0,
            winningTrades: data.winningTrades ?? 0
        };
        console.log(`📀 Loaded from DB | Display: $${botState.displayBalance.toFixed(2)} | Max Steps: ${botState.settings.maxSteps}`);
    } else {
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
            settings: { baseOrder: 0, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5, maxSteps: 30 },
            openPosition: { volume: 0, direction: "", costHold: 0 },
            allTimeHigh: 0,
            peakProfit: 0,
            totalTrades: 0,
            winningTrades: 0
        };
        console.log("🆕 No existing state found - Creating new session with 30 safety orders");
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

setInterval(saveStateToDB, 30000);
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
            // NO OPEN ORDERS DETECTED - RESET TO ZERO
            if (botState.openPosition.volume !== 0 || botState.safetyOrdersFilled !== 0) {
                console.log("🔄 No open orders detected - Resetting bot state to zero");
                botState.openPosition = { volume: 0, direction: "", costHold: 0 };
                botState.safetyOrdersFilled = 0;
                botState.roi = 0;
                botState.avgPrice = 0;
                botState.distToNext = 0;
                await saveStateToDB();
                await saveTradeHistory('reset', 0, botState.currentPrice, 0, 0, botState.displayBalance);
            } else {
                botState.openPosition = { volume: 0, direction: "", costHold: 0 };
                if (botState.roi !== 0) botState.roi = 0;
            }
        }
        
        console.log(`📊 ROI Updated: ${botState.roi}% | Price: ${botState.currentPrice} | Open Vol: ${botState.openPosition.volume}`);
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
                    await saveStateToDB();
                }
                
                botState.walletBalance = realBalance;
                
                if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                    botState.initialBalance = botState.walletBalance;
                    botState.displayBalance = botState.walletBalance;
                    botState.peakBalance = botState.walletBalance;
                    botState.allTimeHigh = botState.walletBalance;
                    botState.startTime = Date.now();
                    console.log(`🚀 Bot Initialized | Starting: $${botState.initialBalance.toFixed(2)}`);
                    await saveStateToDB();
                }
            }
        }
        
        botState.realizedProfit = botState.displayBalance - botState.initialBalance;
        botState.profitPct = botState.initialBalance > 0 ? (botState.realizedProfit / botState.initialBalance) * 100 : 0;
        
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

// FIXED: Proper base calculation for 30 steps
async function updatePositionSizing() {
    if (botState.currentPrice > 0 && botState.walletBalance > 0) {
        const m = botState.settings.volumeMult; // Multiplier (e.g., 1.2)
        const n = botState.settings.maxSteps;   // Number of safety orders (30)
        
        // Calculate sum of geometric series for ALL orders (initial + 30 safety orders = 31 total)
        // Formula: Sum = (m^(n+1) - 1) / (m - 1)
        let multiplierSum;
        if (Math.abs(m - 1) < 1e-9) {
            multiplierSum = n + 1; // If multiplier is 1, sum = number of terms
        } else {
            multiplierSum = (Math.pow(m, n + 1) - 1) / (m - 1);
        }
        
        // Contract value = price * 1000 (typical for HTX linear contracts)
        const contractValue = botState.currentPrice * 1000;
        
        // Total position value with leverage
        const totalPositionValue = (botState.walletBalance * config.leverage) / contractValue;
        
        // Base order = total position / sum of geometric series
        let rawBase = totalPositionValue / multiplierSum;
        
        // Safety margin: use 70% of calculated base to leave room for price fluctuations
        botState.maxSafeBase = Math.max(1, Math.floor(rawBase * 0.7));
        
        // Update base order in settings
        botState.settings.baseOrder = botState.maxSafeBase;
        
        // Calculate total contracts if all safety orders execute
        let totalContracts = 0;
        for (let i = 0; i <= n; i++) {
            totalContracts += botState.settings.baseOrder * Math.pow(m, i);
        }
        
        const totalValue = totalContracts * contractValue;
        const requiredMargin = totalValue / config.leverage;
        const marginUsage = (requiredMargin / botState.walletBalance) * 100;
        
        console.log(`📐 Position Sizing for ${n} Safety Orders:`);
        console.log(`   Balance: $${botState.walletBalance.toFixed(2)}`);
        console.log(`   Current Price: $${botState.currentPrice.toFixed(8)}`);
        console.log(`   Leverage: ${config.leverage}X`);
        console.log(`   Geometric Sum: ${multiplierSum.toFixed(2)}`);
        console.log(`   Raw Base: ${rawBase.toFixed(2)} contracts`);
        console.log(`   ✅ Base Order: ${botState.settings.baseOrder} contracts`);
        console.log(`   Total Contracts (if fully deployed): ${totalContracts.toFixed(0)}`);
        console.log(`   Total Position Value: $${totalValue.toFixed(2)}`);
        console.log(`   Required Margin: $${requiredMargin.toFixed(2)} (${marginUsage.toFixed(1)}% of balance)`);
        
        // Show first few safety order sizes
        console.log(`   Safety Order Sizes:`);
        for (let i = 1; i <= Math.min(5, n); i++) {
            const safetyVol = Math.floor(botState.settings.baseOrder * Math.pow(m, i));
            console.log(`     #${i}: ${safetyVol} contracts`);
        }
        if (n > 5) console.log(`     ... and ${n-5} more steps`);
        
    } else {
        console.log(`⚠️ Cannot calculate position sizing - Price: ${botState.currentPrice}, Balance: ${botState.walletBalance}`);
    }
}

// ==================== TRADING LOGIC ====================
async function checkAndExecuteTrades() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        if (pos) {
            const currentROI = parseFloat(pos.profit_rate) * 100;
            const avgPrice = parseFloat(pos.cost_hold);
            const currentVolume = parseFloat(pos.volume);
            const triggerPrice = avgPrice * (1 - (botState.settings.priceDrop / 100));
            
            // Check take profit
            if (currentROI >= botState.settings.takeProfit) {
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: currentVolume,
                    direction: 'sell', 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('take_profit', currentVolume, botState.currentPrice, botState.safetyOrdersFilled, currentROI, botState.displayBalance);
                    botState.safetyOrdersFilled = 0;
                    console.log(`✅ Take profit! ROI: ${currentROI}% | Volume: ${currentVolume}`);
                    await saveStateToDB();
                }
            }
            // Check safety order (up to maxSteps = 30)
            else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const safetyVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                
                const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: safetyVol,
                    direction: 'buy', 
                    offset: 'open', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                
                if (result?.code === 200) {
                    await saveTradeHistory('safety', safetyVol, botState.currentPrice, botState.safetyOrdersFilled, 0, botState.displayBalance);
                    console.log(`📉 Safety Order #${botState.safetyOrdersFilled}/${botState.settings.maxSteps} | Vol: ${safetyVol} | Price: ${botState.currentPrice.toFixed(8)}`);
                    await saveStateToDB();
                } else {
                    console.log(`❌ Safety order ${botState.safetyOrdersFilled} failed:`, result?.err_msg || result);
                    botState.safetyOrdersFilled--;
                }
            }
        } 
        // Open initial position
        else if (botState.maxSafeBase > 0 && botState.settings.baseOrder > 0 && botState.currentPrice > 0) {
            console.log(`🎯 Attempting to open initial position | Base Order: ${botState.settings.baseOrder} contracts | Price: ${botState.currentPrice.toFixed(8)}`);
            
            const result = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: botState.settings.baseOrder,
                direction: 'buy', 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            
            if (result?.code === 200) {
                await saveTradeHistory('open', botState.settings.baseOrder, botState.currentPrice, 0, 0, botState.displayBalance);
                botState.safetyOrdersFilled = 0;
                console.log(`✅ Position opened | Vol: ${botState.settings.baseOrder} | Price: ${botState.currentPrice.toFixed(8)}`);
                await saveStateToDB();
            } else {
                console.log(`❌ Failed to open position:`, result?.err_msg || result);
            }
        }

    } catch (e) {
        console.error("Trade execution error:", e);
    } finally {
        botState.isTrading = false;
    }
}

// ==================== STARTUP ====================
async function boot() {
    await loadStateFromDB();
    
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
    
    // Fast loops for real-time updates
    setInterval(async () => {
        await fetchPositionAndROI();
        await updatePositionSizing();
    }, 1000);
    
    setInterval(async () => {
        await fetchAccountAndBalance();
    }, 2000);
    
    setInterval(async () => {
        await checkAndExecuteTrades();
    }, 3000);
    
    console.log(`\n🚀 BOT STARTED WITH 30 SAFETY ORDERS CONFIGURATION`);
    console.log(`=============================================`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`⚡ Leverage: ${config.leverage}X`);
    console.log(`📉 Price Drop per Step: ${botState.settings.priceDrop}%`);
    console.log(`📈 Volume Multiplier: ${botState.settings.volumeMult}X`);
    console.log(`🎯 Take Profit: ${botState.settings.takeProfit}%`);
    console.log(`🔢 Max Safety Steps: ${botState.settings.maxSteps}`);
    console.log(`💰 Initial Balance: $${botState.displayBalance.toFixed(2)}`);
    console.log(`=============================================\n`);
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Martingale Bot | 30-Step Safety Orders</title>
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
    </style>
</head>
<body class="text-gray-900 p-4 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-gray-900 text-3xl font-bold tracking-tight">
                    MARTINGALE<span class="gradient-text">_BOT</span>
                    <span class="text-sm font-mono text-gray-400 ml-2">30-Step Edition</span>
                </h1>
                <p class="text-xs text-gray-400 uppercase tracking-wider mt-1">${config.symbol} | ${config.leverage}X Leverage | 30 Safety Orders</p>
                <p class="text-[10px] text-emerald-600 mt-2">⚡ Real-time updates | Auto-reset on no positions</p>
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
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Base Start Contracts</p>
                    <p id="baseOrderDisplay" class="text-2xl font-bold text-blue-600 stat-number">0</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Max Safe Base</p>
                    <p id="maxSafeBaseDisplay" class="text-2xl font-bold text-gray-700 stat-number">0</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Volume Multiplier</p>
                    <p class="text-2xl font-bold text-purple-600">${botState.settings.volumeMult || 1.2}X</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Max Safety Steps</p>
                    <p class="text-2xl font-bold text-orange-600">${botState.settings.maxSteps || 30}</p>
                </div>
            </div>
            <div class="mt-4 pt-3 border-t border-gray-100">
                <div class="text-[10px] text-gray-400 mb-2">Safety Order Sizes (First 5 of ${botState.settings.maxSteps || 30}):</div>
                <div class="flex justify-between text-[11px] font-mono">
                    <span>#1: <span id="so1" class="text-gray-700">0</span></span>
                    <span>#2: <span id="so2" class="text-gray-700">0</span></span>
                    <span>#3: <span id="so3" class="text-gray-700">0</span></span>
                    <span>#4: <span id="so4" class="text-gray-700">0</span></span>
                    <span>#5: <span id="so5" class="text-gray-700">0</span></span>
                    <span class="text-blue-500">+ ${(botState.settings.maxSteps || 30) - 5} more...</span>
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
                    <p id="stepText" class="text-5xl font-bold text-gray-900 stat-number">0 <span class="text-2xl text-gray-400">/ ${botState.settings.maxSteps || 30}</span></p>
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
                    <p class="text-amber-700 text-xs font-semibold">⚠️ High Risk Zone - Multiple safety orders active (${botState.settings.maxSteps || 30} step max)</p>
                </div>
            </div>
        </div>

        <div class="flex justify-between items-center text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
            <div>Avg Profit/Hr: <span id="estHr" class="text-gray-600 ml-1">$0.000000</span></div>
            <div class="flex gap-6 items-center">
                <span>Price: <span id="curPrice" class="text-gray-900 font-mono ml-1">0.00000000</span></span>
                <button onclick="resetStats()" class="text-gray-400 hover:text-red-500 transition-colors px-3 py-1 rounded-lg hover:bg-red-50">Reset Stats</button>
                <button onclick="viewHistory()" class="text-blue-500 hover:text-blue-700 transition-colors px-3 py-1 rounded-lg hover:bg-blue-50">History</button>
            </div>
        </div>
    </div>

    <script>
        let lastROI = 0;
        let lastBalance = 0;
        
        function calculateSafetyOrders(baseOrder, multiplier, count = 5) {
            const orders = [];
            for (let i = 1; i <= count; i++) {
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
                
                const safetyOrders = calculateSafetyOrders(d.settings.baseOrder || 0, d.settings.volumeMult || 1.2, 5);
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
                document.getElementById('stepText').innerHTML = d.safetyOrdersFilled + ' <span class="text-2xl text-gray-400">/ ' + d.settings.maxSteps + '</span>';
                document.getElementById('distText').innerHTML = d.distToNext.toFixed(3) + '%';

                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                document.getElementById('progressBar').style.width = progressPct + '%';
                
                const warning = document.getElementById('riskWarning');
                if (progressPct > 60) warning.classList.remove('hidden');
                else warning.classList.add('hidden');

            } catch (e) {
                console.error('Update error:', e);
            }
        }
        
        async function resetStats() { 
            if(confirm("Reset initial balance and statistics?")) {
                await fetch('/api/reset-stats', {method:'POST'});
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
        
        setInterval(update, 500);
        update();
    </script>
</body>
</html>`);
});

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
    res.sendStatus(200);
});

app.post('/api/save-now', async (req, res) => {
    await saveStateToDB();
    res.sendStatus(200);
});

process.on('SIGINT', async () => {
    console.log('\n💾 Saving state before exit...');
    await saveStateToDB();
    await mongoose.disconnect();
    process.exit();
});

app.listen(config.port, () => {
    console.log(`\n🌐 Web UI: http://localhost:${config.port}`);
    boot();
});
