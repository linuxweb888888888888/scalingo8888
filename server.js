const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ MongoDB Connected Successfully'))
    .catch(err => console.error('🚨 MongoDB Connection Error:', err));

const UserModel = mongoose.model('User_V3', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },
    apiSecret: { type: String, default: "" },
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    activePosition: { type: Object, default: null }, 
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, grossRoiPct: Number, roiPct: Number, 
    netPnl: Number, feeCost: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V8', new mongoose.Schema({
    priceMid: Number, mlPlot: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

const AnalyticsModel = mongoose.model('SiteAnalytics_V3', new mongoose.Schema({
    key: { type: String, default: "global" }, views: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 }, knownIds: { type: [String], default: [] }
}));

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0, 
    mlAverageTicks: 5, mlUseAverage: false, flipOnlyInProfit: true, flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, profitMultiplier: 2.0, 
    maxContracts: 100, 
    maxDcaStepsBeforeReverse: 10,
    
    // SCALPING & ENTRY IMPROVEMENT SETTINGS
    microProfitRoi: 0.5,        // Bank small profits at 0.5% ROI
    microProfitQty: 5,          // Close 5 contracts at a time to bank profit
    microDcaRoi: -0.3,          // Improve entry price if price drops 0.3%
    microDcaQty: 3,             // Add 3 contracts to shave down entry price
    
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    htx: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const mlSignalCache = new Map();

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
const tokenCache = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [token, data] of tokenCache.entries()) { if (now - data.lastAccessed > 3600000) tokenCache.delete(token); }
}, 600000);

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let userEntry = tokenCache.get(token);
    if (!userEntry) {
        const user = await UserModel.findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        userEntry = { user, lastAccessed: Date.now() };
        tokenCache.set(token, userEntry);
    } else userEntry.lastAccessed = Date.now();
    req.user = userEntry.user;
    next();
}

// ==================== MATH ENGINE ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd: grossPnlUsd - feeCost, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [((prices[idx]-prices[idx-1])/prices[idx-1])*1000, ((prices[idx]-prices[idx-3])/prices[idx-3])*1000, ((prices[idx]-prices[idx-5])/prices[idx-5])*1000, ((prices[idx]-prices[idx-10])/prices[idx-10])*1000];
    const trainEnd = prices.length - 2, trainStart = trainEnd - lookback;
    let upCount = 0, downCount = 0;
    for (let i = trainStart; i <= trainEnd; i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1] - prices[i];
        let label = 0.5;
        if (diff > 0) { label = 1; upCount++; } else if (diff < 0) { label = 0; downCount++; }
        y.push(label);
    }
    let n = X.length, totalDir = upCount + downCount;
    let upW = totalDir > 0 && upCount > 0 ? (totalDir / (2 * upCount)) : 1;
    let downW = totalDir > 0 && downCount > 0 ? (totalDir / (2 * downCount)) : 1;
    let means = [0,0,0,0], stds = [0,0,0,0];
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) means[j] += X[i][j];
    for(let j=0; j<4; j++) { means[j] /= n; }
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) stds[j] += Math.pow(X[i][j] - means[j], 2);
    for(let j=0; j<4; j++) { stds[j] = Math.sqrt(stds[j] / n); if (stds[j] === 0) stds[j] = 1; }
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) X[i][j] = (X[i][j] - means[j]) / stds[j];
    let w = [0, 0, 0, 0], b = 0, lr = 0.05, epochs = 20; 
    for (let e = 0; e < epochs; e++) {
        for (let i = 0; i < n; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b;
            let pred = 1 / (1 + Math.exp(-Math.max(Math.min(z, 20), -20))); 
            let err = (pred - y[i]) * (y[i] === 1 ? upW : downW);
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }
    let currX = getFeatures(prices.length - 1);
    for(let j=0; j<4; j++) currX[j] = (currX[j] - means[j]) / stds[j];
    let finalPred = 1 / (1 + Math.exp(-Math.max(Math.min(w[0]*currX[0] + w[1]*currX[1] + w[2]*currX[2] + w[3]*currX[3] + b, 20), -20)));
    finalPred = 1 - finalPred;
    return { confidence: Math.min(Math.abs(finalPred - 0.5) * 200, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.metrics = { totalNetPnl: 0, winRate: 0, trades: [] };
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false;
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        const mlVal = globalMarketData.mlSignal.rawValue;

        try {
            // 1. HARD EXITS (TP/SL)
            if (roi >= this.config.takeProfitPct) return await this.handleFullClose("TAKE_PROFIT");
            if (roi <= this.config.stopLossPct) return await this.handleFullClose("STOP_LOSS");

            // 2. MICRO-SCALPING (Profit taking in small qty at "just right price")
            // If ROI is positive and ML signal is starting to fade, bank some contracts
            const isFading = (pos.side === 'long' && mlVal < 0.55) || (pos.side === 'short' && mlVal > 0.45);
            if (roi >= (this.config.microProfitRoi || 0.5) && isFading && pos.contracts > (this.config.microProfitQty || 5)) {
                await this.partialClose(this.config.microProfitQty || 5, "MICRO_SCALP");
            }

            // 3. ENTRY IMPROVEMENT (Micro-DCA at "just right price")
            // If ROI is slightly negative and ML is strong in our direction, improve entry price
            const isStrong = (pos.side === 'long' && mlVal > 0.65) || (pos.side === 'short' && mlVal < 0.35);
            if (roi <= (this.config.microDcaRoi || -0.3) && isStrong && (Date.now() - (pos.lastDcaTime || 0) > 30000)) {
                await this.microEntry(this.config.microDcaQty || 3, "ENTRY_IMPROVE");
            }

            // 4. MAIN DCA LOGIC
            if (roi <= -(Math.abs(this.config.dcaRoiThresholdPct))) {
                if (pos.dcaStep >= this.config.maxDcaStepsBeforeReverse) {
                    await this.handleFullClose("MAX_DCA_REVERSE");
                } else {
                    await this.executeDcaStep();
                }
            }
        } catch (e) { console.error("Exit Check Error:", e.message); }
    }

    async partialClose(qty, reason) {
        if (this.isTrading) return;
        this.isTrading = true;
        console.log(`[User ${this.userId}] ${reason}: Closing ${qty} contracts to bank profit.`);
        try {
            const side = this.activePositions[0].side === 'long' ? 'sell' : 'buy';
            if (this.liveTradingEnabled) {
                await this.htx.createMarketOrder(this.config.htxSymbol, side, qty, undefined, { reduceOnly: true });
            }
            const pos = this.activePositions[0];
            pos.contracts -= qty;
            pos.size = pos.contracts * this.config.contractSize * pos.entryPrice;
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async microEntry(qty, reason) {
        if (this.isTrading) return;
        this.isTrading = true;
        console.log(`[User ${this.userId}] ${reason}: Adding ${qty} contracts to improve entry.`);
        try {
            const side = this.activePositions[0].side === 'long' ? 'buy' : 'sell';
            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled) {
                await this.htx.createMarketOrder(this.config.htxSymbol, side, qty);
            }
            const pos = this.activePositions[0];
            const newSize = (qty * this.config.contractSize * price);
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * newSize)) / (pos.size + newSize);
            pos.contracts += qty;
            pos.size += newSize;
            pos.lastDcaTime = Date.now();
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async executeDcaStep() {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const multiplier = this.config.dcaMultiplier || 2;
            const qtyToAdd = Math.floor(pos.contracts * (multiplier - 1));
            const side = pos.side === 'long' ? 'buy' : 'sell';
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side, qtyToAdd);
            
            const price = globalMarketData.binance.mid;
            const addedSize = qtyToAdd * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
            pos.contracts += qtyToAdd;
            pos.size += addedSize;
            pos.dcaStep++;
            pos.lastDcaTime = Date.now();
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async handleFullClose(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const side = pos.side === 'long' ? 'sell' : 'buy';
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side, pos.contracts, undefined, { reduceOnly: true });
            
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
            await TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, contracts: pos.contracts, netPnl: math.netPnlUsd, exitReason: reason });
            
            this.activePositions = [];
            this.lastCloseTime = Date.now();
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async evaluateAIEntry() {
        if (this.isTrading || this.activePositions.length > 0 || Date.now() - this.lastCloseTime < 5000) return;
        const sig = globalMarketData.mlSignal;
        if (sig.confidence >= this.config.mlThreshold) {
            const side = sig.type === 'bull' ? 'long' : 'short';
            const price = globalMarketData.binance.mid;
            const contracts = this.config.baseContracts;
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', contracts);
            
            this.activePositions = [{ side, entryPrice: price, contracts, size: contracts * this.config.contractSize * price, dcaStep: 0, entryTime: Date.now() }];
            await this.saveState();
        }
    }
}

// ==================== WORKER & STREAMS ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                if (globalMarketData.tickBuffer.length === 0 || mid !== globalMarketData.tickBuffer[globalMarketData.tickBuffer.length-1]) {
                    globalMarketData.tickBuffer.push(mid);
                    if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                }
                globalMarketData.mlSignal = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                for (const worker of activeWorkers.values()) { 
                    worker.checkExits(); 
                    worker.evaluateAIEntry(); 
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS SERVER ====================
const app = express(); app.use(express.json());

app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>TradeBot Improved</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-900 text-white p-10">
    <h1 class="text-3xl font-bold">TradeBot: Entry & Profit Optimizer</h1>
    <div class="grid grid-cols-2 gap-10 mt-10">
        <div class="bg-gray-800 p-5 rounded">
            <h2 class="text-xl border-b pb-2">Optimization Logic</h2>
            <ul class="mt-4 space-y-2 text-gray-400">
                <li><b class="text-green-500">Micro-Scalping:</b> Banks tiny profits automatically if trend slows.</li>
                <li><b class="text-blue-500">Entry Smoothing:</b> Performs small buys to lower entry price on minor dips.</li>
                <li><b class="text-orange-500">Signal Gating:</b> Only acts when ML signal raw value confirms the "Just Right" price.</li>
            </ul>
        </div>
        <div class="bg-gray-800 p-5 rounded">
            <h2 class="text-xl border-b pb-2">Status</h2>
            <div id="status" class="mt-4 font-mono text-yellow-500">Connecting to Engine...</div>
        </div>
    </div>
</body></html>`));

app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) activeWorkers.set(u._id.toString(), new UserTradeInstance(u));
    startMasterStreams();
    console.log(`✅ Optimizer Engine Live on ${CUSTOM_PORT}`);
});
