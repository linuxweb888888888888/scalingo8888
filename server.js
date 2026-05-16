require('dotenv').config(); // Install: npm install dotenv
const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const CONFIG = {
    SYMBOL: 'TON/USDT:USDT',
    LEVERAGE: 75,
    TAKE_PROFIT_ROI: 10.0, 
    STOP_LOSS_ROI: -25.0,
    FEE_SIMULATION: 0.0006, // 0.06% average fee
    BASE_BALANCE: 10.00
};

// ==================== DATABASE CONNECTION ====================
mongoose.connect(process.env.MONGO_URI || "your_mongodb_uri_here")
    .then(() => console.log(`✅ Engine Connected`))
    .catch(err => console.error("❌ DB Error:", err));

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number, startDate: { type: Date, default: Date.now }
}));

const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({
    symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now }
}));

// ==================== TRADING LOGIC ====================
const htx = new ccxt.htx({ 
    apiKey: process.env.API_KEY, 
    secret: process.env.API_SECRET, 
    options: { defaultType: 'swap' } 
});

let botStatus = { active: false, side: 'IDLE', currentRoi: 0, currentPnl: 0, currentBalance: 0, totalClosedRoi: 0, lastUpdate: 'INIT' };

function calculateAI(series, window) {
    let results = [];
    for (let i = 0; i < series.length; i++) {
        if (i < window) { results.push(series[i]); continue; }
        let sumW = 0, sumV = 0;
        for (let j = 0; j < window; j++) {
            let w = Math.pow(1 - (j / window), 2); // Quadratic weighting
            sumV += series[i - j] * w; sumW += w;
        }
        results.push(sumV / sumW);
    }
    return results;
}

async function tradingLoop() {
    while (true) {
        try {
            // 1. Sync Account
            let balanceDoc = await BotState.findOne({ key: "paper_balance" });
            if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: CONFIG.BASE_BALANCE });
            botStatus.currentBalance = balanceDoc.value;

            // 2. Fetch Data
            const ohlcv = await htx.fetchOHLCV(CONFIG.SYMBOL, '1m', undefined, 50);
            const prices = ohlcv.map(x => x[4]);
            const currentPrice = prices[prices.length - 1];

            // 3. Signal Logic
            const fast = calculateAI(prices, 10);
            const slow = calculateAI(prices, 25);
            const fC = fast[fast.length-1], fP = fast[fast.length-2];
            const sC = slow[slow.length-1], sP = slow[slow.length-2];

            let signal = "NONE";
            if (fP <= sP && fC > sC) signal = "buy";
            if (fP >= sP && fC < sC) signal = "sell";

            // 4. Position Management
            let activePos = await PaperPosition.findOne({ symbol: CONFIG.SYMBOL });

            if (activePos) {
                const diff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (diff / activePos.entryPrice) * CONFIG.LEVERAGE * 100;
                
                // Realistic PnL (Subtracts estimated fees on entry and exit)
                const grossPnl = (diff * activePos.contracts);
                const fees = (activePos.entryPrice * activePos.contracts * CONFIG.FEE_SIMULATION) + (currentPrice * activePos.contracts * CONFIG.FEE_SIMULATION);
                botStatus.currentPnl = grossPnl - fees;

                const shouldFlip = (activePos.side === 'buy' && signal === 'sell') || (activePos.side === 'sell' && signal === 'buy');

                if (botStatus.currentRoi >= CONFIG.TAKE_PROFIT_ROI || botStatus.currentRoi <= CONFIG.STOP_LOSS_ROI || shouldFlip) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await Trade.create({ 
                        side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, 
                        roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: shouldFlip ? "AI_FLIP" : "EXIT" 
                    });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    activePos = null; // Position cleared
                }
            } 
            
            // 5. Open New Position
            if (!activePos && (signal === "buy" || signal === "sell")) {
                const marginPerPosition = botStatus.currentBalance * 0.9; // Use 90% of balance
                const contractSize = marginPerPosition * CONFIG.LEVERAGE / currentPrice;
                
                await PaperPosition.create({ 
                    symbol: CONFIG.SYMBOL, side: signal, entryPrice: currentPrice, contracts: contractSize 
                });
            }

            botStatus.lastUpdate = new Date().toLocaleTimeString();
        } catch (e) {
            console.error("Loop Error:", e.message);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}
