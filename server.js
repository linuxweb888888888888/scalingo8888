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
    for (const [token, data] of tokenCache.entries()) {
        if (now - data.lastAccessed > 3600000) tokenCache.delete(token);
    }
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

// ==================== CORE MATH & ML ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = (side === 'long' ? 1 : -1);
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const grossRoiPct = (grossPnlUsd / margin) * 100;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;
    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, grossRoiPct, netPnlUsd, netRoiPct: (netPnlUsd / margin) * 100, feeCost, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000,
        ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000
    ];
    const trainEnd = prices.length - 2; 
    const trainStart = trainEnd - lookback;
    let upCount = 0, downCount = 0;
    for (let i = trainStart; i <= trainEnd; i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1] - prices[i];
        let label = 0.5;
        if (diff > 0) { label = 1; upCount++; } else if (diff < 0) { label = 0; downCount++; }
        y.push(label);
    }
    let n = X.length, totalDirectional = upCount + downCount;
    let upWeight = totalDirectional > 0 && upCount > 0 ? (totalDirectional / (2 * upCount)) : 1;
    let downWeight = totalDirectional > 0 && downCount > 0 ? (totalDirectional / (2 * downCount)) : 1;
    let means = [0, 0, 0, 0], stds = [0, 0, 0, 0];
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) means[j] += X[i][j];
    for(let j=0; j<4; j++) means[j] /= n;
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) stds[j] += Math.pow(X[i][j] - means[j], 2);
    for(let j=0; j<4; j++) { stds[j] = Math.sqrt(stds[j] / n); if (stds[j] === 0) stds[j] = 1; }
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) X[i][j] = (X[i][j] - means[j]) / stds[j];
    let w = [0, 0, 0, 0], b = 0, lr = 0.05, epochs = 20; 
    for (let e = 0; e < epochs; e++) {
        for (let i = 0; i < n; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b;
            let pred = 1 / (1 + Math.exp(-Math.max(Math.min(z, 20), -20))); 
            let weight = (y[i] === 1 ? upWeight : (y[i] === 0 ? downWeight : 1));
            let err = (pred - y[i]) * weight;
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }
    let currX = getFeatures(prices.length - 1);
    for(let j=0; j<4; j++) currX[j] = (currX[j] - means[j]) / stds[j];
    let zCur = w[0]*currX[0] + w[1]*currX[1] + w[2]*currX[2] + w[3]*currX[3] + b;
    let finalPred = 1 / (1 + Math.exp(-Math.max(Math.min(zCur, 20), -20)));
    finalPred = 1 - finalPred;
    let confidence = Math.abs(finalPred - 0.5) * 200; 
    return { confidence: Math.min(confidence, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== METRICS & BACKTEST ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalGrossPnl = 0; this.totalNetPnl = 0; this.totalFees = 0; this.totalRoiPct = 0;
        this.wins = 0; this.losses = 0; this.winRate = 0; this.totalTradesCount = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; if (!trade.timestamp) trade.timestamp = Date.now();
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; this.totalFees += trade.feeCost || 0; this.totalRoiPct += trade.roiPct || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
}

async function runBacktestSimulation(config, tickCount, symbol) {
    try { await publicBinance.loadMarkets(); } catch (e) { return { error: "Market error" }; }
    let allCandles = [], since = Date.now() - (tickCount * 60 * 1000); 
    try {
        while (allCandles.length < tickCount) {
            const limit = Math.min(1000, tickCount - allCandles.length);
            const ohlcv = await publicBinance.fetchOHLCV(symbol, '1m', since, limit);
            if (!ohlcv || ohlcv.length === 0) break;
            allCandles.push(...ohlcv);
            since = ohlcv[ohlcv.length - 1][0] + 60000;
            if (allCandles.length < tickCount) await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) { if (allCandles.length === 0) allCandles = await publicBinance.fetchOHLCV(symbol, '1m', undefined, Math.min(tickCount, 1000)).catch(()=>[]) || []; }
    const ticks = allCandles.map(c => ({ timestamp: c[0], priceMid: c[4] }));
    if (!ticks || ticks.length === 0) return { error: "No data" };
    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { mlLookback=50, mlThreshold=60.0, mlAverageTicks=5, mlUseAverage=false, flipOnlyInProfit=true, flipThresholdPct=0.5 } = config;
    let priceBuffer = [], mlRawBuffer = [];
    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;
        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) { priceBuffer.push(price); if (priceBuffer.length > 500) priceBuffer.shift(); }
        const mlSig = calculateMLSignal(priceBuffer, mlLookback);
        mlRawBuffer.push(mlSig.rawValue); if (mlRawBuffer.length > mlAverageTicks) mlRawBuffer.shift();
        let avgRaw = mlRawBuffer.reduce((a,b)=>a+b,0) / mlRawBuffer.length;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        let avgType = avgRaw >= 0.5 ? 'bull' : 'bear';
        let activeType = mlUseAverage ? avgType : mlSig.type;
        let activeConf = mlUseAverage ? avgConf : mlSig.confidence;
        let signal = (activeType === 'bull' && activeConf >= mlThreshold) ? 'long' : (activeType === 'bear' && activeConf >= mlThreshold) ? 'short' : null;
        if (!activePos && signal) {
            let bC = parseInt(config.baseContracts) || 1;
            const sizeUsd = bC * config.contractSize * price; 
            const margin = sizeUsd / FORCED_LEVERAGE;
            activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: margin, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
            if (margin > maxMarginUsed) maxMarginUsed = margin;
            continue;
        }
        if (activePos) {
            const math = calculateTradeMath(activePos.side, activePos.entryPrice, price, activePos.size, FORCED_LEVERAGE, config.fees.taker);
            let forceExitReason = null;
            if (signal && activePos.side !== signal) { if (flipOnlyInProfit) { if (math.currentGrossRoi >= flipThresholdPct) forceExitReason = "ML_FLIP"; } else forceExitReason = "ML_FLIP"; }
            if (!forceExitReason && math.currentGrossRoi >= config.takeProfitPct) forceExitReason = "TAKE_PROFIT";
            else if (!forceExitReason && math.currentGrossRoi <= config.stopLossPct) forceExitReason = "STOP_LOSS";
            if (forceExitReason) {
                netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
                totalTradeDurationMs += (tickTime - activePos.entryTime);
                closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: price, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: forceExitReason, time: tick.timestamp });
                if (forceExitReason === "ML_FLIP") {
                    let bC = parseInt(config.baseContracts) || 1;
                    const sizeUsd = bC * config.contractSize * price; 
                    activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                } else activePos = null;
            } else {
                const reqDca = -(Math.abs(config.dcaRoiThresholdPct || 1.0));
                if (math.currentGrossRoi <= reqDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor((parseInt(config.baseContracts) || 1) * Math.pow((config.dcaMultiplier || 2), step))), 10);
                    const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                    activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                    activePos.size = Number(activePos.size) + addedSizeUsd; activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                    activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                    activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                }
            }
        }
    }
    return { 
        totalTradesCount: closedTrades.length, wins, losses, winRate: closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(2) : 0, 
        netPnl, trades: closedTrades.slice(-200) 
    };
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.config.leverage = FORCED_LEVERAGE; this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.lastEvalPrice = 0; this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const key = user.apiKey || "demo", secret = user.apiSecret || "demo";
        this.htx = new ccxt.pro.htx({ apiKey: key, secret: secret, agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }
    async initialize() { await this.metrics.init(); await this.connectExchange(); this.startExchangeROISync(); }
    async saveState() { await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }); }
    async connectExchange() {
        try { if(this.liveTradingEnabled) { await this.htx.loadMarkets(); } return { success: true }; } catch (e) { this.liveTradingEnabled = false; return { success: false }; }
    }
    async evaluateAIEntry() {
        let mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
        this.currentMl = mlSig;
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;
        let signal = (mlSig.type === 'bull' && mlSig.confidence >= (this.config.mlThreshold || 60)) ? 'long' : (mlSig.type === 'bear' && mlSig.confidence >= (this.config.mlThreshold || 60)) ? 'short' : null;
        if (!this.activePositions.length && signal) await this.syncState(signal);
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const sideMult = (pos.side === 'long' ? 1 : -1);
        const pnlPct = ((globalMarketData.binance.mid - pos.entryPrice) / pos.entryPrice) * 100 * sideMult;
        const roi = pnlPct * FORCED_LEVERAGE;
        if (roi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (roi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
    }
    async addDcaPosition() {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            pos.dcaStep = (pos.dcaStep || 0) + 1;
            await this.saveState();
        } catch (err) { } finally { this.isTrading = false; }
    }
    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const price = globalMarketData.binance.mid;
            const contracts = 1;
            const sizeUsd = contracts * this.config.contractSize * price;
            this.activePositions = [{ side: targetSide, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, isPaper: !this.liveTradingEnabled }];
            await this.saveState();
        } catch (err) { } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
            this.metrics.recordTrade({ ...pos, exitPrice: globalMarketData.binance.mid, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } catch (err) { } finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(() => {
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                const sideMult = (pos.side === 'long' ? 1 : -1);
                pos.exchangeROI = ((globalMarketData.binance.mid - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;
            }
        }, 1000);
    }
    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

const activeWorkers = new Map();
async function startMasterStreams() {
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                for (const worker of activeWorkers.values()) { worker.checkExits(); worker.evaluateAIEntry(); }
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() { const users = await UserModel.find({}); for(const u of users) { const w = new UserTradeInstance(u); await w.initialize(); activeWorkers.set(u._id.toString(), w); } }

const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    const worker = new UserTradeInstance(user); await worker.initialize(); activeWorkers.set(user._id.toString(), worker);
    res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save(); res.json({ token: user.token });
});

app.get('/api/data', authMiddleware, (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "None" });
});

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        .view-section { display: none; }
        .active-view { display: block; }
        .auth-only { display: none; }
    </style>
</head>
<body class="bg-gray-50 text-gray-900">
    <main class="p-4 mb-20">
        <section id="view-home" class="view-section active-view text-center py-10">
            <h1 class="text-3xl font-bold">AI Trading Bot</h1>
            <div id="home-auth-btns" class="mt-10 space-y-4">
                <button onclick="nav('login')" class="w-full py-4 bg-black text-white rounded-xl">Login</button>
                <button onclick="nav('register')" class="w-full py-4 border border-black rounded-xl">Register</button>
            </div>
        </section>

        <section id="view-dashboard" class="view-section">
            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="bg-white p-4 rounded-xl shadow-sm">
                    <p class="text-xs text-gray-400">NET PNL</p>
                    <h2 id="netPnl" class="text-xl font-bold">$0.00</h2>
                </div>
                <div class="bg-white p-4 rounded-xl shadow-sm">
                    <p class="text-xs text-gray-400">ACTIVE ROI</p>
                    <h2 id="activeRoi" class="text-xl font-bold">0%</h2>
                </div>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm mb-6 text-center">
                <div id="mlStatus" class="inline-block px-4 py-1 rounded-full text-xs font-bold bg-gray-100 mb-2">NEUTRAL</div>
                <p class="text-xs text-gray-400">CONFIDENCE: <span id="mlValue" class="text-black font-bold">0%</span></p>
            </div>
            <div class="bg-white p-4 rounded-xl shadow-sm">
                <h3 class="text-xs font-bold text-gray-400 mb-4">LAST 10 EXECUTIONS</h3>
                <div id="tradeHistoryBody" class="space-y-4"></div>
            </div>
        </section>

        <section id="view-login" class="view-section"><h2 class="text-2xl font-bold">Login</h2><input id="l-email" placeholder="Email" class="w-full p-4 border mt-4"><input id="l-pass" type="password" placeholder="Pass" class="w-full p-4 border mt-4"><button onclick="doLogin()" class="w-full py-4 bg-black text-white mt-4">Go</button></section>
        <section id="view-register" class="view-section"><h2 class="text-2xl font-bold">Register</h2><input id="r-name" placeholder="Name" class="w-full p-4 border mt-4"><input id="r-email" placeholder="Email" class="w-full p-4 border mt-4"><input id="r-pass" type="password" placeholder="Pass" class="w-full p-4 border mt-4"><button onclick="doRegister()" class="w-full py-4 bg-black text-white mt-4">Go</button></section>
    </main>

    <nav class="fixed bottom-0 left-0 right-0 bg-white border-t flex justify-around p-4">
        <button onclick="nav('home')"><span class="material-symbols-outlined">home</span></button>
        <button onclick="nav('dashboard')" class="auth-only"><span class="material-symbols-outlined">show_chart</span></button>
        <button onclick="logout()" class="auth-only text-red-500"><span class="material-symbols-outlined">logout</span></button>
    </nav>

    <script>
        let token = localStorage.getItem('bot_token');
        function updateUI() {
            document.querySelectorAll('.auth-only').forEach(el => el.style.display = token ? 'block' : 'none');
            if(token) document.getElementById('home-auth-btns').style.display = 'none';
        }
        function nav(v) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.getElementById('view-' + v).classList.add('active-view');
            if(v==='dashboard') fetchLoop();
        }
        async function fetchLoop() {
            if(!token) return;
            const res = await fetch('/api/data', { headers: {'Authorization': token} });
            const data = await res.json();
            document.getElementById('netPnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(2);
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('activeRoi').innerText = p.exchangeROI.toFixed(2) + '%';
            }
            const mlSig = data.mlSignal;
            const signalText = mlSig.type === 'bull' ? 'LONG' : 'SHORT';
            document.getElementById('mlStatus').innerText = 'SIGNAL: ' + signalText;
            document.getElementById('mlStatus').className = 'inline-block px-4 py-1 rounded-full text-xs font-bold ' + (mlSig.type === 'bull' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700');
            document.getElementById('mlValue').innerText = mlSig.confidence.toFixed(1) + '%';
            
            const hist = document.getElementById('tradeHistoryBody');
            hist.innerHTML = '';
            data.metrics.trades.slice(-10).reverse().forEach(t => {
                hist.innerHTML += '<div class="border-b pb-2"><div class="flex justify-between text-xs font-bold"><span>' + t.side.toUpperCase() + '</span><span>$' + t.netPnl.toFixed(2) + '</span></div><div class="flex justify-between text-[10px] text-gray-400"><span>Qty: ' + t.contracts + '</span><span>ROI: ' + t.roiPct.toFixed(2) + '%</span></div></div>';
            });
            setTimeout(fetchLoop, 2000);
        }
        async function doLogin() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:document.getElementById('l-email').value, password:document.getElementById('l-pass').value}) });
            const d = await res.json(); if(d.token) { localStorage.setItem('bot_token', d.token); token=d.token; updateUI(); nav('dashboard'); }
        }
        async function doRegister() {
            const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name:document.getElementById('r-name').value, email:document.getElementById('r-email').value, password:document.getElementById('r-pass').value}) });
            const d = await res.json(); if(d.token) { localStorage.setItem('bot_token', d.token); token=d.token; updateUI(); nav('dashboard'); }
        }
        function logout() { localStorage.removeItem('bot_token'); location.reload(); }
        updateUI();
    </script>
</body>
</html>\`); });

app.listen(CUSTOM_PORT, async () => { 
    console.log(\`✅ Server running on port \${CUSTOM_PORT}\`); 
    await loadAllUsers(); 
    startMasterStreams(); 
});
