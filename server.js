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

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
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
            let weight = y[i] === 1 ? upWeight : (y[i] === 0 ? downWeight : 1);
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

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) { this.config.htxSymbol = 'SHIB/USDT:USDT'; this.config.binanceSymbol = '1000SHIB/USDT:USDT'; }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.config.marginMode = 'cross'; 
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }
    async initialize() { await this.metrics.init(); await this.connectExchange(); this.startExchangeROISync(); }
    async saveState() { await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }); }
    async connectExchange() {
        if(this.liveTradingEnabled) {
            try {
                await this.htx.loadMarkets(); 
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else this.activePositions = [];
            } catch (e) { this.liveTradingEnabled = false; return { success: false, message: e.message }; }
        }
        return { success: true };
    }
    async evaluateAIEntry() {
        try {
            let mlSig = mlSignalCache.get(this.config.mlLookback) || calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
            this.mlRawBuffer.push(mlSig.rawValue); if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift();
            let avgRaw = this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length;
            this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue, avgConfidence: Math.abs(avgRaw - 0.5)*200, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' };
            if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
            let activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;
            let signal = (activeConf >= (this.config.mlThreshold || 60.0)) ? (activeType === 'bull' ? 'long' : 'short') : null;
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    const roi = pos.exchangeROI || 0;
                    if (!this.config.flipOnlyInProfit || roi >= (this.config.flipThresholdPct || 0)) {
                        await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 100);
                    }
                }
            } else if (signal) await this.syncState(signal);
        } catch(e) {}
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0];
            const roi = pos.exchangeROI || 0;
            if (roi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
            else if (roi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
            else {
                const dcaThreshold = -(Math.abs(this.config.dcaRoiThresholdPct || 1));
                const scaleThreshold = this.config.profitRoiThresholdPct || 2;
                if (roi <= dcaThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(false);
                else if (roi >= scaleThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(true);
            }
        } catch(e) {}
    }
    async addDcaPosition(isProfitScale) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            let mult = isProfitScale ? (this.config.profitMultiplier || 2) : (this.config.dcaMultiplier || 2);
            let baseC = this.walletBalance * 1000;
            let contractsToAdd = Math.floor(baseC * Math.pow(mult, pos.dcaStep || 0));
            if (isProfitScale && (pos.contracts + contractsToAdd > (this.config.maxContracts || baseC*2))) { this.isTrading = false; return; }
            let price = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                await this.htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'buy' : 'sell', contractsToAdd, undefined, { offset: 'open' });
            }
            pos.stepHistory = pos.stepHistory || [];
            pos.stepHistory.push({ step: (pos.dcaStep || 0) + 1, type: isProfitScale ? 'SCALE' : 'DCA', price, roi: pos.exchangeROI || 0, time: Date.now() });
            const addedUsd = contractsToAdd * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedUsd)) / (pos.size + addedUsd);
            pos.size += addedUsd; pos.contracts += contractsToAdd; pos.marginUsed += (addedUsd / FORCED_LEVERAGE);
            pos.dcaStep = (pos.dcaStep || 0) + 1; pos.lastDcaTime = Date.now(); await this.saveState();
        } catch(e) { console.error("DCA Error:", e.message); } finally { this.isTrading = false; }
    }
    async syncState(targetSide) {
        this.isTrading = true;
        try {
            let contracts = Math.max(1, Math.floor(this.walletBalance * 1000));
            let price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled) {
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                await this.htx.createMarketOrder(this.config.htxSymbol, targetSide === 'long' ? 'buy' : 'sell', contracts, undefined, { offset: 'open' });
            }
            const sizeUsd = contracts * this.config.contractSize * price;
            this.activePositions = [{ side: targetSide, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: 0, exchangePnl: 0, isPaper: !this.liveTradingEnabled, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } catch(e) { console.error("Open Error:", e.message); } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            let price = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                await this.htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true, offset: 'close' });
            }
            const math = calculateTradeMath(pos.side, pos.entryPrice, price, pos.size, FORCED_LEVERAGE, 0.0004);
            this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, netPnl: math.netPnlUsd, exitReason: reason, timestamp: Date.now() });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } catch(e) { console.error("Close Error:", e.message); } finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = bal.total.USDT || 0;
                    if (this.activePositions.length > 0) {
                        const pos = await this.htx.fetchPositions([this.config.htxSymbol]);
                        const open = pos.find(p => p.contracts > 0);
                        if (open) { this.activePositions[0].exchangeROI = open.percentage; this.activePositions[0].exchangePnl = open.unrealizedPnl; }
                        else { this.activePositions = []; await this.saveState(); }
                    }
                } catch(e) {}
            } else {
                if (this.activePositions.length > 0) {
                    const pos = this.activePositions[0];
                    const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
                    pos.exchangeROI = math.currentGrossRoi; pos.exchangePnl = math.netPnlUsd;
                }
            }
        }, 1000);
    }
    getExportData() { return { config: this.config, uptime: Math.floor((Date.now() - this.startTime)/1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, walletBalance: this.walletBalance, binance: globalMarketData.binance }; }
}

const activeWorkers = new Map();
async function startMasterStreams() {
    await publicBinance.loadMarkets();
    (async function stream() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                mlSignalCache.set(BASE_CONFIG.mlLookback, ml);
                for (const w of activeWorkers.values()) { try { w.checkExits(); w.evaluateAIEntry(); } catch(e){} }
            } catch(e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}
async function loadAllUsers() { const users = await UserModel.find({}); for(const u of users) { const w = new UserTradeInstance(u); await w.initialize(); activeWorkers.set(u._id.toString(), w); } }

const app = express(); app.use(express.json());
app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    const w = new UserTradeInstance(user); await w.initialize(); activeWorkers.set(user._id.toString(), w); res.json({ token: user.token });
});
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save();
        tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token });
    } else res.status(400).json({ error: "Invalid" });
});
app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    const keys = ['takeProfitPct', 'stopLossPct', 'mlLookback', 'mlThreshold', 'mlAverageTicks', 'dcaRoiThresholdPct', 'dcaMultiplier', 'profitRoiThresholdPct', 'profitMultiplier', 'flipThresholdPct', 'maxContracts'];
    keys.forEach(k => { if(req.body[k] !== undefined) w.config[k] = parseFloat(req.body[k]); });
    if (req.body.mlUseAverage !== undefined) w.config.mlUseAverage = req.body.mlUseAverage === 'true';
    if (req.body.flipOnlyInProfit !== undefined) w.config.flipOnlyInProfit = req.body.flipOnlyInProfit === 'true';
    await w.saveState(); res.json({status: 'ok'});
});
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    w.applyUserKeys(req.body); await w.connectExchange();
    req.user.apiKey = req.body.apiKey; req.user.apiSecret = req.body.apiSecret; req.user.liveTradingEnabled = req.body.liveTradingEnabled;
    await req.user.save(); res.json({status: 'ok'});
});
app.get('/api/data', authMiddleware, (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    if(!w) return res.json({ metrics: { totalNetPnl: 0, trades: [] }, mlSignal: {}, config: BASE_CONFIG, walletBalance: 0, activePositions: [], binance: {} });
    res.json(w.getExportData());
});
app.get('/api/close-all', authMiddleware, async (req, res) => { await activeWorkers.get(req.user._id.toString()).forceClosePosition("MANUAL"); res.json({status: 'ok'}); });

// ==================== ANDROID UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>TradeBotPille | SHIB AI Engine</title>
    
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        * {
            -webkit-tap-highlight-color: transparent;
        }
        body {
            font-family: 'Inter', sans-serif;
            background: #f5f7fb;
            color: #0a0c10;
        }
        .font-mono {
            font-family: 'JetBrains Mono', monospace;
        }
        .material-symbols-outlined {
            font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20;
            vertical-align: middle;
        }
        
        /* Mobile-first glass card */
        .card {
            background: rgba(255,255,255,0.96);
            backdrop-filter: blur(0px);
            border-radius: 28px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.03);
            border: 1px solid rgba(226,232,240,0.8);
            transition: all 0.2s ease;
        }
        
        .ios-input {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 14px;
            padding: 12px 16px;
            font-size: 15px;
            width: 100%;
            transition: all 0.2s;
            font-family: 'JetBrains Mono', monospace;
        }
        .ios-input:focus {
            outline: none;
            border-color: #0f172a;
            background: white;
            box-shadow: 0 0 0 3px rgba(15,23,42,0.05);
        }
        
        .btn-primary {
            background: #0f172a;
            color: white;
            border-radius: 30px;
            padding: 14px 22px;
            font-weight: 600;
            font-size: 15px;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
        }
        .btn-primary:active { transform: scale(0.97); background: #1e293b; }
        
        .btn-secondary {
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 30px;
            padding: 12px 18px;
            font-weight: 500;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .btn-secondary:active { background: #f1f5f9; transform: scale(0.97); }
        
        .stat-badge {
            background: #f1f5f9;
            border-radius: 40px;
            padding: 6px 12px;
            font-size: 11px;
            font-weight: 600;
            color: #334155;
        }
        
        .view-section { display: none; animation: fadeIn 0.25s ease; }
        .active-view { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        
        /* Bottom tab indicator */
        .tab-active {
            color: #0f172a;
            font-weight: 600;
            border-bottom: 2px solid #0f172a;
        }
        
        /* scroll */
        .overflow-scroll-smooth {
            -webkit-overflow-scrolling: touch;
        }
        
        .gauge-wrapper {
            position: relative;
            width: 90px;
            height: 90px;
            margin: 0 auto;
        }
        canvas#mlGaugeCanvas {
            width: 100% !important;
            height: 100% !important;
        }
    </style>
</head>
<body class="antialiased pb-20">

    <!-- Header -->
    <header class="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100 shadow-sm">
        <div class="px-5 py-4 flex items-center justify-between">
            <div class="flex items-center gap-2" onclick="navigateView('home')">
                <div class="w-9 h-9 rounded-full bg-gray-800 flex items-center justify-center shadow-sm">
                    <span class="material-symbols-outlined text-white text-[20px]">auto_awesome</span>
                </div>
                <span class="font-bold text-lg tracking-tight">TradeBotPille</span>
            </div>
            <div id="auth-buttons" class="flex gap-2">
                <button onclick="navigateView('login')" class="text-sm font-medium text-gray-600 px-3 py-1.5">Login</button>
                <button onclick="navigateView('register')" class="bg-black text-white text-sm font-medium px-4 py-1.5 rounded-full shadow-sm">Sign Up</button>
            </div>
            <div id="user-menu" class="hidden items-center gap-3">
                <span id="userNameShort" class="text-sm font-semibold text-gray-700"></span>
                <button onclick="logout()" class="text-xs text-red-500 bg-red-50 px-3 py-1.5 rounded-full">Exit</button>
            </div>
        </div>
    </header>

    <main class="px-4 py-5 max-w-2xl mx-auto">
        
        <!-- HOME VIEW -->
        <section id="view-home" class="view-section active-view">
            <div class="text-center pt-8 pb-6">
                <div class="inline-flex items-center gap-2 bg-gray-100 px-4 py-1.5 rounded-full text-xs font-bold mb-5">
                    <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> ML PROBABILITY ENGINE
                </div>
                <h1 class="text-4xl font-extrabold tracking-tight mb-4">Algorithmic Edge.<br><span class="text-gray-400">Zero Emotion.</span></h1>
                <p class="text-gray-500 text-base max-w-xs mx-auto leading-relaxed">Logistic regression trained on tick deltas — automated execution on HTX.</p>
                <button onclick="navigateView('register')" class="btn-primary mt-8 w-auto px-8 mx-auto">Launch Terminal</button>
            </div>
            <div class="grid grid-cols-2 gap-4 mt-8">
                <div class="card p-5 text-center"><span class="material-symbols-outlined text-3xl text-black">memory</span><h3 class="font-bold mt-2">On-Chain ML</h3><p class="text-xs text-gray-500 mt-1">Real-time gradient descent</p></div>
                <div class="card p-5 text-center"><span class="material-symbols-outlined text-3xl text-black">key</span><h3 class="font-bold mt-2">Non-Custodial</h3><p class="text-xs text-gray-500 mt-1">Your keys, your funds</p></div>
                <div class="card p-5 text-center"><span class="material-symbols-outlined text-3xl text-black">bolt</span><h3 class="font-bold mt-2">Low Latency</h3><p class="text-xs text-gray-500 mt-1">Binance WS → HTX</p></div>
                <div class="card p-5 text-center"><span class="material-symbols-outlined text-3xl text-black">trending_up</span><h3 class="font-bold mt-2">1000x Multiplier</h3><p class="text-xs text-gray-500 mt-1">Wallet-based scaling</p></div>
            </div>
        </section>

        <!-- LOGIN & REGISTER (simplified demo) -->
        <section id="view-login" class="view-section">
            <div class="card p-6 mt-8">
                <h2 class="text-2xl font-bold text-center">Welcome Back</h2>
                <div class="space-y-4 mt-6">
                    <input type="email" id="loginEmail" placeholder="Email" class="ios-input">
                    <input type="password" id="loginPass" placeholder="Password" class="ios-input">
                    <button onclick="fakeLogin()" class="btn-primary">Secure Login</button>
                    <p class="text-center text-xs text-gray-400 mt-3">Demo: any email / any password</p>
                </div>
            </div>
        </section>
        <section id="view-register" class="view-section">
            <div class="card p-6 mt-8">
                <h2 class="text-2xl font-bold text-center">Create Account</h2>
                <div class="space-y-4 mt-6">
                    <input type="text" id="regName" placeholder="Name" class="ios-input">
                    <input type="email" id="regEmail" placeholder="Email" class="ios-input">
                    <input type="password" id="regPass" placeholder="Password" class="ios-input">
                    <button onclick="fakeRegister()" class="btn-primary">Start Trading</button>
                </div>
            </div>
        </section>

        <!-- ANALYTICS -->
        <section id="view-analytics" class="view-section">
            <div class="text-center mb-6"><span class="material-symbols-outlined text-4xl">monitoring</span><h2 class="text-2xl font-bold">Live Stats</h2></div>
            <div class="grid grid-cols-3 gap-3 mb-6">
                <div class="card p-4 text-center"><p class="text-xs text-gray-400">Online</p><p id="statOnline" class="text-2xl font-mono font-bold">0</p></div>
                <div class="card p-4 text-center"><p class="text-xs text-gray-400">Views</p><p id="statViews" class="text-2xl font-mono font-bold">0</p></div>
                <div class="card p-4 text-center"><p class="text-xs text-gray-400">Uniques</p><p id="statUniques" class="text-2xl font-mono font-bold">0</p></div>
            </div>
            <div class="card p-5"><h3 class="font-bold mb-3">Active Pages</h3><div id="pagesList" class="text-sm space-y-2 text-gray-600"></div></div>
        </section>

        <!-- DASHBOARD (main trading) -->
        <section id="view-dashboard" class="view-section">
            <div class="flex justify-between items-center mb-5">
                <div><h2 class="text-xl font-bold">Terminal</h2><span id="liveBadge" class="text-[10px] bg-gray-200 px-2 py-0.5 rounded-full">Paper Mode</span></div>
                <button onclick="forceClosePosition()" class="text-red-500 bg-red-50 px-4 py-2 rounded-full text-xs font-bold">Close All</button>
            </div>
            <!-- KPI grid (6 cards) -->
            <div class="grid grid-cols-2 gap-3 mb-6">
                <div class="card p-4"><p class="text-[10px] text-gray-400 uppercase">Net PnL</p><p id="netPnlVal" class="text-xl font-mono font-bold">$0.00</p></div>
                <div class="card p-4"><p class="text-[10px] text-gray-400 uppercase">Win Rate</p><p id="winRateVal" class="text-xl font-mono font-bold text-blue-600">0%</p></div>
                <div class="card p-4"><p class="text-[10px] text-gray-400 uppercase">Wallet Bal</p><p id="walletBal" class="text-xl font-mono font-bold">$0.00</p></div>
                <div class="card p-4"><p class="text-[10px] text-gray-400 uppercase">Active Ctr</p><p id="activeQtyVal" class="text-xl font-mono font-bold">0</p></div>
                <div class="card p-4"><p class="text-[10px] text-gray-400 uppercase">Live ROI</p><p id="activeRoiVal" class="text-md font-mono font-bold text-gray-500">N/A</p></div>
                <div class="card p-3 flex flex-col items-center"><p class="text-[9px] text-gray-400">ML Signal</p><div class="gauge-wrapper"><canvas id="mlGaugeCanvas" width="80" height="80"></canvas></div><span id="mlSignalText" class="text-[10px] font-bold mt-1">Neutral</span></div>
            </div>
            <!-- Price Chart -->
            <div class="card p-4 mb-6 h-56">
                <div class="flex gap-3 text-[10px] font-bold text-gray-400 mb-2"><span>🔴 Price</span><span>🟢 ML Bull</span><span>🔵 Avg Prob</span></div>
                <canvas id="mainChart" class="w-full h-40"></canvas>
            </div>
            <!-- Config quick toggles -->
            <div class="card p-5 mb-6">
                <div class="flex justify-between items-center mb-3"><span class="font-semibold">Strategy Config</span><button onclick="saveConfig()" class="text-xs bg-gray-100 px-3 py-1 rounded-full">Save</button></div>
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div><label class="text-gray-500 text-xs">TP %</label><input id="tpInput" type="number" step="0.1" class="ios-input text-sm py-2"></div>
                    <div><label class="text-gray-500 text-xs">SL %</label><input id="slInput" type="number" step="0.1" class="ios-input text-sm py-2"></div>
                    <div><label class="text-gray-500 text-xs">Confidence %</label><input id="threshInput" type="number" step="1" class="ios-input text-sm py-2"></div>
                    <div><label class="text-gray-500 text-xs">Lookback</label><input id="lookInput" type="number" step="1" class="ios-input text-sm py-2"></div>
                    <div class="col-span-2"><label class="text-gray-500 text-xs">Loss DCA ROI %</label><input id="dcaRoiInput" type="number" step="0.1" class="ios-input text-sm py-2"></div>
                </div>
            </div>
            <!-- Trade history -->
            <div class="card p-5"><h3 class="font-bold mb-3 flex items-center gap-1"><span class="material-symbols-outlined text-lg">history</span> Closed Trades</h3><div class="overflow-x-auto max-h-64 overflow-y-auto"><table class="w-full text-left text-xs"><thead class="text-gray-400"><tr><th>Time</th><th>Side</th><th>Net PnL</th></tr></thead><tbody id="tradeTableBody"><tr><td colspan="3" class="py-4 text-center">No closed trades</td></tr></tbody></table></div></div>
        </section>

        <!-- BACKTEST (simplified) -->
        <section id="view-backtest" class="view-section">
            <div class="card p-5"><h2 class="font-bold text-xl">Backtest Simulator</h2><p class="text-xs text-gray-400 mb-4">Test strategy on historical 1000SHIB ticks</p>
                <div class="space-y-3"><input type="number" id="btTicks" placeholder="Ticks (5000)" class="ios-input" value="3000"><div class="grid grid-cols-2 gap-2"><input type="number" id="btTP" placeholder="TP %" class="ios-input" value="10"><input type="number" id="btSL" placeholder="SL %" class="ios-input" value="-50"></div><button onclick="runBacktestDemo()" class="btn-primary py-3">Run Simulation</button></div>
                <div class="grid grid-cols-3 gap-3 mt-5 text-center"><div><p class="text-xs text-gray-400">Winrate</p><p id="btWinrate" class="font-mono font-bold">-</p></div><div><p class="text-xs text-gray-400">Net PnL</p><p id="btPnl" class="font-mono font-bold">-</p></div><div><p class="text-xs text-gray-400">Trades</p><p id="btTrades" class="font-mono font-bold">-</p></div></div>
            </div>
        </section>

    </main>

    <!-- Bottom Navigation (Android style) -->
    <div class="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-gray-100 px-6 py-2 flex justify-between items-center max-w-2xl mx-auto shadow-lg rounded-t-2xl z-50">
        <button onclick="navigateView('home')" class="flex flex-col items-center gap-0.5 text-gray-500 text-xs"><span class="material-symbols-outlined text-[22px]">home</span><span>Home</span></button>
        <button onclick="navigateView('dashboard')" class="flex flex-col items-center gap-0.5 text-gray-500 text-xs"><span class="material-symbols-outlined text-[22px]">show_chart</span><span>Trade</span></button>
        <button onclick="navigateView('backtest')" class="flex flex-col items-center gap-0.5 text-gray-500 text-xs"><span class="material-symbols-outlined text-[22px]">science</span><span>Backtest</span></button>
        <button onclick="navigateView('analytics')" class="flex flex-col items-center gap-0.5 text-gray-500 text-xs"><span class="material-symbols-outlined text-[22px]">insights</span><span>Stats</span></button>
        <button onclick="navigateView('settings')" class="flex flex-col items-center gap-0.5 text-gray-500 text-xs"><span class="material-symbols-outlined text-[22px]">settings</span><span>API</span></button>
    </div>

    <section id="view-settings" class="view-section pb-24">
        <div class="card p-6 mt-5"><h2 class="font-bold text-xl flex gap-2"><span class="material-symbols-outlined">api</span> HTX API Keys</h2><div class="space-y-4 mt-4"><input type="password" id="apiKeyInput" placeholder="API Key" class="ios-input"><input type="password" id="apiSecretInput" placeholder="API Secret" class="ios-input"><div class="flex items-center gap-3"><input type="checkbox" id="liveToggle"><label>Enable Live Trading</label></div><button onclick="saveApiKeys()" class="btn-primary">Connect & Restart</button><p id="apiMsg" class="text-xs text-center text-gray-500"></p></div></div>
    </section>

    <script>
        // ==================== FULL BOT SIMULATION (original logic adapted with 1000x multiplier) ====================
        let authToken = localStorage.getItem('auth_token');
        let activePosition = null;          // { side, entryPrice, contracts, size, marginUsed, lastDcaTime, dcaStep, stepHistory }
        let metrics = { totalNetPnl: 0, winRate: 0, wins:0, losses:0, trades: [] };
        let walletBalance = 1000;            // demo starting balance (USDT)
        let config = {
            takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0,
            mlAverageTicks: 5, mlUseAverage: false, flipOnlyInProfit: true, flipThresholdPct: 0.5,
            dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, profitRoiThresholdPct: 2.0, profitMultiplier: 2.0,
            maxContracts: 100, contractSize: 1000, leverage: 75
        };
        let priceBuffer = [0.0000072, 0.0000073, 0.00000725]; // mock SHIB price stream
        let currentPrice = 0.00000725;
        let mlSignal = { confidence: 45, type: 'flat', rawValue: 0.5, avgConfidence: 45, avgType: 'flat' };
        let chartHistory = [];
        
        // Helper ML mock (realistic dynamic)
        function updateMlSignal() {
            let volatility = Math.sin(Date.now() / 10000) * 0.2 + 0.5;
            let raw = 0.4 + Math.random() * 0.4;
            let conf = Math.min(85, Math.abs(raw-0.5)*180);
            let type = raw >= 0.55 ? 'bull' : (raw <= 0.45 ? 'bear' : 'flat');
            mlSignal = { confidence: conf, type, rawValue: raw, avgConfidence: conf, avgType: type };
        }
        
        function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, fee=0.0004) {
            let sideMult = side === 'long' ? 1 : -1;
            let grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
            let margin = sizeUsd / leverage;
            let grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
            let feeCost = sizeUsd * fee * 2;
            let netPnlUsd = grossPnlUsd - feeCost;
            let grossRoi = grossPnlPercent * leverage;
            return { grossPnlPercent, grossRoi, grossPnlUsd, netPnlUsd, margin, feeCost, currentGrossRoi: grossRoi };
        }
        
        // open position using 1000x multiplier of wallet balance
        function openPosition(side) {
            if (activePosition) return;
            let baseContracts = Math.max(1, Math.floor(walletBalance * 1000));  // 1000x multiplier
            let execPrice = currentPrice;
            let sizeUsd = baseContracts * config.contractSize * execPrice;
            let marginUsed = sizeUsd / config.leverage;
            activePosition = {
                side, entryPrice: execPrice, contracts: baseContracts, size: sizeUsd, marginUsed,
                entryTime: Date.now(), lastDcaTime: 0, dcaStep: 0,
                stepHistory: [{ step:0, type:'OPEN', price: execPrice, roi:0, time:Date.now() }]
            };
            updateUI();
        }
        
        async function addDcaPosition(isProfitScale = false) {
            if (!activePosition) return;
            let mult = isProfitScale ? (walletBalance * 1) : config.dcaMultiplier;
            let step = activePosition.dcaStep;
            let contractsToAdd = Math.max(1, Math.floor(walletBalance * 1000 * Math.pow(mult, step)));
            if (isProfitScale && (activePosition.contracts + contractsToAdd) > (walletBalance * 2)) return;
            let addedSize = contractsToAdd * config.contractSize * currentPrice;
            let newAvgPrice = ((activePosition.entryPrice * activePosition.size) + (currentPrice * addedSize)) / (activePosition.size + addedSize);
            activePosition.entryPrice = newAvgPrice;
            activePosition.size += addedSize;
            activePosition.contracts += contractsToAdd;
            activePosition.marginUsed += (addedSize / config.leverage);
            activePosition.dcaStep = step + 1;
            activePosition.lastDcaTime = Date.now();
            activePosition.stepHistory.push({ step: activePosition.dcaStep, type: isProfitScale ? 'SCALE' : 'DCA', price: currentPrice, roi: getCurrentRoi(), time: Date.now() });
            updateUI();
        }
        
        function getCurrentRoi() {
            if (!activePosition) return 0;
            let sideMult = activePosition.side === 'long' ? 1 : -1;
            let pnlPercent = ((currentPrice - activePosition.entryPrice) / activePosition.entryPrice) * 100 * sideMult;
            return pnlPercent * config.leverage;
        }
        
        function closePosition(reason) {
            if (!activePosition) return;
            let roi = getCurrentRoi();
            let math = calculateTradeMath(activePosition.side, activePosition.entryPrice, currentPrice, activePosition.size, config.leverage);
            let netPnl = math.netPnlUsd;
            metrics.totalNetPnl += netPnl;
            if (netPnl > 0) metrics.wins++; else metrics.losses++;
            metrics.trades.unshift({ side: activePosition.side, netPnl, exitReason: reason, timestamp: Date.now(), roiPct: roi });
            if (metrics.trades.length > 30) metrics.trades.pop();
            metrics.winRate = metrics.wins + metrics.losses > 0 ? (metrics.wins / (metrics.wins+metrics.losses))*100 : 0;
            activePosition = null;
            updateUI();
        }
        
        function evaluateStrategy() {
            if (!activePosition) {
                let signalType = mlSignal.avgType;
                let conf = mlSignal.avgConfidence;
                if ((signalType === 'bull' && conf >= config.mlThreshold)) openPosition('long');
                else if ((signalType === 'bear' && conf >= config.mlThreshold)) openPosition('short');
                return;
            }
            // exits & DCA
            let roi = getCurrentRoi();
            if (roi >= config.takeProfitPct) closePosition("TAKE_PROFIT");
            else if (roi <= config.stopLossPct) closePosition("STOP_LOSS");
            else if (roi <= -config.dcaRoiThresholdPct && Date.now() - (activePosition.lastDcaTime||0) > 3000) addDcaPosition(false);
            else if (roi >= config.profitRoiThresholdPct && Date.now() - (activePosition.lastDcaTime||0) > 3000) addDcaPosition(true);
        }
        
        // Simulate price & ML every second
        setInterval(() => {
            let change = (Math.random() - 0.5) * 0.00000008;
            currentPrice = Math.max(0.0000065, currentPrice + change);
            priceBuffer.push(currentPrice);
            if(priceBuffer.length > 200) priceBuffer.shift();
            updateMlSignal();
            evaluateStrategy();
            updateUI();
            // chart data
            chartHistory.push({ price: currentPrice, ml: mlSignal.rawValue, timestamp: Date.now() });
            if(chartHistory.length > 300) chartHistory.shift();
            drawChart();
        }, 1500);
        
        // UI Render
        function updateUI() {
            document.getElementById('netPnlVal').innerText = `$${metrics.totalNetPnl.toFixed(4)}`;
            document.getElementById('winRateVal').innerText = `${metrics.winRate.toFixed(1)}%`;
            document.getElementById('walletBal').innerText = `$${walletBalance.toFixed(2)}`;
            document.getElementById('activeQtyVal').innerText = activePosition ? activePosition.contracts : 0;
            let roi = getCurrentRoi();
            document.getElementById('activeRoiVal').innerHTML = activePosition ? `${roi.toFixed(2)}%` : 'N/A';
            document.getElementById('activeRoiVal').className = `text-md font-mono font-bold ${roi>=0 ? 'text-green-600':'text-red-500'}`;
            document.getElementById('liveBadge').innerText = localStorage.getItem('liveMode') === 'true' ? 'LIVE MODE' : 'Paper Mode';
            // ML Gauge
            let gaugeVal = mlSignal.avgConfidence || 50;
            let ctx = document.getElementById('mlGaugeCanvas').getContext('2d');
            if(window.gaugeChart) window.gaugeChart.destroy();
            window.gaugeChart = new Chart(ctx, { type: 'doughnut', data: { datasets: [{ data: [gaugeVal, 100-gaugeVal], backgroundColor: ['#0f172a', '#e2e8f0'], borderWidth:0 }] }, options: { cutout: '70%', plugins: { legend: { display: false }, tooltip: { enabled: false } }, rotation: -90, circumference: 180, responsive: true, maintainAspectRatio: true } });
            document.getElementById('mlSignalText').innerHTML = mlSignal.avgType === 'bull' ? 'BULLISH' : (mlSignal.avgType === 'bear' ? 'BEARISH' : 'NEUTRAL');
            // trade table
            let tbody = document.getElementById('tradeTableBody');
            if(metrics.trades.length === 0) tbody.innerHTML = '<tr><td colspan="3" class="py-4 text-center text-gray-400">No closed trades</td></tr>';
            else tbody.innerHTML = metrics.trades.slice(0,8).map(t => `<tr class="border-b border-gray-50"><td class="py-2">${new Date(t.timestamp).toLocaleTimeString()}</td><td class="font-bold ${t.side==='long'?'text-green-600':'text-red-600'}">${t.side}</td><td class="font-mono ${t.netPnl>=0?'text-green-600':'text-red-600'}">$${t.netPnl.toFixed(4)}</td></tr>`).join('');
        }
        
        let chart;
        function drawChart() {
            let canvas = document.getElementById('mainChart');
            if(!canvas) return;
            let prices = chartHistory.slice(-120).map(p=>p.price);
            let mlVals = chartHistory.slice(-120).map(p=>p.ml);
            if(chart) chart.destroy();
            let ctx = canvas.getContext('2d');
            chart = new Chart(ctx, { type: 'line', data: { labels: prices.map((_,i)=>i), datasets: [{ label:'Price', data: prices, borderColor:'#0f172a', borderWidth:2, pointRadius:0, yAxisID:'y'},{ label:'ML Prob', data: mlVals, borderColor:'#22c55e', borderWidth:1.5, pointRadius:0, yAxisID:'y1'}] }, options: { responsive: true, maintainAspectRatio: true, scales: { y: { ticks: { callback: v=>v.toExponential(2) } }, y1: { min:0, max:1, position:'right' } }, plugins: { legend: { position:'top', labels:{ boxWidth:8, font:{size:9} } } } } });
        }
        
        async function saveConfig() { config.takeProfitPct = parseFloat(document.getElementById('tpInput').value); config.stopLossPct = parseFloat(document.getElementById('slInput').value); config.mlThreshold = parseFloat(document.getElementById('threshInput').value); config.mlLookback = parseInt(document.getElementById('lookInput').value); config.dcaRoiThresholdPct = parseFloat(document.getElementById('dcaRoiInput').value); alert('Config saved (local simulation)'); }
        async function forceClosePosition() { if(activePosition) closePosition("MANUAL"); updateUI(); }
        function saveApiKeys() { let live = document.getElementById('liveToggle').checked; localStorage.setItem('liveMode', live); document.getElementById('apiMsg').innerText = live ? 'Live mode enabled (demo simulation)' : 'Paper mode active'; setTimeout(()=>navigateView('dashboard'), 1000); }
        function runBacktestDemo() { alert('Backtest sim: Using engine logic with 1000x multiplier. Check console for mock.'); }
        
        // Fake auth
        function fakeLogin() { localStorage.setItem('auth_token','demo'); authToken='demo'; document.getElementById('userNameShort').innerText='Trader'; toggleAuthUI(); navigateView('dashboard'); }
        function fakeRegister() { fakeLogin(); }
        function logout() { localStorage.removeItem('auth_token'); authToken=null; toggleAuthUI(); navigateView('home'); }
        function toggleAuthUI() { let logged = !!authToken; document.getElementById('auth-buttons').classList.toggle('hidden', logged); document.getElementById('user-menu').classList.toggle('hidden', !logged); }
        
        function navigateView(view) {
            document.querySelectorAll('.view-section').forEach(el=>el.classList.remove('active-view'));
            document.getElementById(`view-${view}`).classList.add('active-view');
            if(view === 'dashboard') { updateUI(); drawChart(); }
            if(view === 'analytics') { document.getElementById('statOnline').innerText = Math.floor(Math.random()*12)+3; document.getElementById('statViews').innerText = 2847; document.getElementById('statUniques').innerText = 912; document.getElementById('pagesList').innerHTML = '<div>Dashboard: 4 users</div><div>Analytics: 2 users</div>'; }
        }
        
        // init config fields
        document.getElementById('tpInput').value = config.takeProfitPct;
        document.getElementById('slInput').value = config.stopLossPct;
        document.getElementById('threshInput').value = config.mlThreshold;
        document.getElementById('lookInput').value = config.mlLookback;
        document.getElementById('dcaRoiInput').value = config.dcaRoiThresholdPct;
        if(authToken) toggleAuthUI(); else toggleAuthUI();
        updateUI();
        drawChart();
        setInterval(()=>{ if(document.getElementById('view-dashboard').classList.contains('active-view')) { updateUI(); drawChart(); } }, 800);
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Mobile Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
