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
        priceDrop: { type: Number, default: 0.1 }, // 0.1% drop per safety order
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
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 }
});

const BotState = mongoose.model('BotState_Persistent', BotStateSchema);
const TradeHistory = mongoose.model('TradeHistory', new mongoose.Schema({
    timestamp: { type: Number, default: Date.now },
    type: { type: String },
    volume: Number,
    price: Number,
    safetyLevel: Number,
    roi: Number,
    balanceAfter: Number
}));

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    contractSize: 1000 // SHIB-USDT is typically 1000 SHIB per contract
};

let botState = {};

// ==================== PERSISTENCE ====================
async function saveStateToDB() {
    try {
        await BotState.updateOne({ id: "htx_martingale_main" }, { ...botState, lastUpdate: Date.now() }, { upsert: true });
    } catch (e) { console.error("DB Save Error:", e); }
}

async function loadStateFromDB() {
    const data = await BotState.findOne({ id: "htx_martingale_main" });
    if (data) {
        botState = data.toObject();
        botState.isTrading = false;
        console.log(`📀 Loaded: Display $${botState.displayBalance.toFixed(2)} | Steps: ${botState.settings.maxSteps}`);
    } else {
        botState = {
            isRunning: true, isTrading: false, startTime: Date.now(), currentPrice: 0, avgPrice: 0,
            roi: 0, realizedProfit: 0, profitPct: 0, walletBalance: 0, displayBalance: 0, peakBalance: 0,
            initialBalance: 0, maxSafeBase: 0, safetyOrdersFilled: 0, distToNext: 0,
            estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
            settings: { baseOrder: 0, priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5, maxSteps: 30 },
            openPosition: { volume: 0, direction: "", costHold: 0 },
            allTimeHigh: 0, totalTrades: 0, winningTrades: 0
        };
    }
}

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

// ==================== CORE CALCULATIONS ====================

/**
 * Calculates the Max Base Order allowed to survive N safety steps
 * using the geometric series sum formula.
 */
async function updatePositionSizing() {
    if (botState.currentPrice > 0 && botState.walletBalance > 0) {
        const m = botState.settings.volumeMult;
        const n = botState.settings.maxSteps;
        const balance = botState.walletBalance;
        const lev = config.leverage;
        const price = botState.currentPrice;
        
        // Sum of geometric series: 1 + m + m^2 + ... + m^n
        // This represents the total "multiples" of the base order we will hold after all steps
        let totalMultiplierSum = (Math.abs(m - 1) < 1e-9) ? (n + 1) : (1 - Math.pow(m, n + 1)) / (1 - m);
        
        // Total Position Value (USD) = (Wallet Balance * Leverage)
        // We use a 80% safety buffer to prevent liquidation on the final step
        const maxAvailablePositionUSD = balance * lev * 0.80;
        
        // Value of 1 Contract in USD
        const oneContractUSD = price * config.contractSize;
        
        // Max Base Order = Total USD / (MultiplierSum * Price of 1 Contract)
        let calculatedBase = maxAvailablePositionUSD / (totalMultiplierSum * oneContractUSD);
        
        botState.maxSafeBase = Math.floor(calculatedBase);
        
        // Set the active base order (minimum 1)
        if (botState.maxSafeBase >= 1) {
            botState.settings.baseOrder = botState.maxSafeBase;
        } else {
            botState.settings.baseOrder = 0; // Not enough money
        }

        console.log(`📐 Sizing: Bal $${balance.toFixed(2)} | Max Pos: $${maxAvailablePositionUSD.toFixed(2)} | Sum: ${totalMultiplierSum.toFixed(2)} | Base: ${botState.settings.baseOrder}`);
    }
}

// ==================== TRADING LOGIC ====================
async function checkAndExecuteTrades() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice === 0) return;
    botState.isTrading = true;

    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            // Position exists: Check for TP or Safety Order
            const currentROI = parseFloat(pos.profit_rate) * 100;
            const avgPrice = parseFloat(pos.cost_hold);
            const currentVolume = parseFloat(pos.volume);
            
            // Calculate drop from average price
            const priceDropPct = ((avgPrice - botState.currentPrice) / avgPrice) * 100;
            const triggerDrop = botState.settings.priceDrop; // e.g. 0.1%

            if (currentROI >= botState.settings.takeProfit) {
                // TAKE PROFIT
                const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: currentVolume, direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (res?.code === 200) {
                    botState.safetyOrdersFilled = 0;
                    botState.winningTrades++;
                    botState.totalTrades++;
                    console.log(`💰 TP Hit! ROI: ${currentROI.toFixed(2)}%`);
                    await saveStateToDB();
                }
            } else if (priceDropPct >= triggerDrop && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                // SAFETY ORDER
                botState.safetyOrdersFilled++;
                const nextVol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                
                const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: Math.max(1, nextVol), direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (res?.code === 200) {
                    console.log(`📉 Safety #${botState.safetyOrdersFilled} filled. Vol: ${nextVol}`);
                    botState.totalTrades++;
                    await saveStateToDB();
                } else {
                    botState.safetyOrdersFilled--; // Reset counter on failure
                }
            }
        } else {
            // No position: Open Base Order
            if (botState.settings.baseOrder >= 1) {
                const res = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.settings.baseOrder, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (res?.code === 200) {
                    botState.safetyOrdersFilled = 0;
                    console.log(`🚀 Base Order Opened: ${botState.settings.baseOrder} contracts`);
                    await saveStateToDB();
                }
            }
        }
    } catch (e) {
        console.error("Trade Error:", e);
    } finally {
        botState.isTrading = false;
    }
}

// ==================== FAST SYNC ====================
async function syncBalances() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const equity = parseFloat(acc.margin_balance);
            const unrealized = parseFloat(acc.unrealized_pnl) || 0;
            const realBalance = equity - unrealized; // This is the "wallet balance" (closed profit)

            if (botState.initialBalance === 0) {
                botState.initialBalance = realBalance;
                botState.displayBalance = realBalance;
                botState.peakBalance = realBalance;
            }

            // If real wallet balance increased, add to display balance
            if (realBalance > botState.peakBalance) {
                botState.displayBalance += (realBalance - botState.peakBalance);
                botState.peakBalance = realBalance;
            }
            botState.walletBalance = realBalance;
            
            // Stats
            botState.realizedProfit = botState.displayBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }
    } catch (e) {}
}

async function syncPosition() {
    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0);
        if (pos) {
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.openPosition = { volume: parseFloat(pos.volume), direction: pos.direction, costHold: botState.avgPrice };
            
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            botState.distToNext = Math.max(0, ((botState.currentPrice - triggerPrice) / botState.currentPrice) * 100);
        } else {
            botState.roi = 0;
            botState.openPosition = { volume: 0, direction: "", costHold: 0 };
        }
    } catch (e) {}
}

// ==================== STARTUP ====================
async function boot() {
    await loadStateFromDB();
    
    // Price WebSocket
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                const msg = JSON.parse(dezipped.toString());
                if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            }
        });
    });

    setInterval(syncBalances, 2000);
    setInterval(syncPosition, 1000);
    setInterval(updatePositionSizing, 5000);
    setInterval(checkAndExecuteTrades, 3000);
    setInterval(saveStateToDB, 30000);
}

// UI... (Existing UI routes stay the same, but they will now show the new baseOrder)
app.get('/', (req, res) => { /* Your existing HTML block */ res.send(htmlMarkup); }); 
// Note: Ensure the HTML markup you have uses the 'botState' variables correctly.

app.get('/api/status', (req, res) => res.json(botState));

app.listen(config.port, () => {
    console.log(`🌐 HTX Martingale v33 Online on Port ${config.port}`);
    boot();
});
