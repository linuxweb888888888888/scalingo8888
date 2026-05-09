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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TradeBot Android</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        :root { --m3-surface: #f7f9fc; --m3-primary: #000; --m3-card: #fff; }
        body { font-family: 'Roboto', sans-serif; background: var(--m3-surface); -webkit-tap-highlight-color: transparent; }
        .view-section { display: none; padding-bottom: 90px; }
        .active-view { display: block; animation: fade 0.2s ease; }
        @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
        .m3-card { background: var(--m3-card); border-radius: 28px; padding: 16px; margin-bottom: 12px; border: 1px solid #eef0f2; }
        .m3-field { position: relative; margin-bottom: 16px; }
        .m3-input { width: 100%; border: 1px solid #74777f; border-radius: 8px; padding: 12px; background: transparent; outline: none; font-size: 16px; }
        .m3-label { position: absolute; left: 10px; top: -9px; background: var(--m3-card); padding: 0 4px; font-size: 11px; font-weight: 700; color: #44474e; }
        .m3-nav { position: fixed; bottom: 0; left: 0; right: 0; background: #f0f3f8; height: 80px; display: flex; justify-content: space-around; align-items: center; border-top: 1px solid #dee2e6; z-index: 100; }
        .nav-item { display: flex; flex-direction: column; align-items: center; color: #44474e; flex: 1; }
        .nav-item .icon-box { padding: 4px 20px; border-radius: 16px; }
        .nav-item.active { color: #000; font-weight: 700; }
        .nav-item.active .icon-box { background: #d3e4ff; }
        .m3-btn { background: #000; color: #fff; border-radius: 100px; padding: 14px; width: 100%; font-weight: 500; }
        .app-bar { height: 64px; display: flex; align-items: center; padding: 0 16px; font-size: 22px; font-weight: 400; background: var(--m3-surface); }
        .sub-header { font-size: 12px; font-weight: 900; color: #5f6368; text-transform: uppercase; border-bottom: 1px solid #eee; margin-bottom: 12px; padding-bottom: 4px; }
    </style>
</head>
<body>
    <header class="app-bar"><span class="material-symbols-outlined mr-4">bolt</span>TradeBotPille</header>
    <main class="px-4">
        <section id="view-home" class="view-section active-view py-10 text-center"><div class="m3-card"><h1 class="text-3xl font-bold mb-4">ML Math Engine</h1><p class="text-gray-500 mb-8">24/7 High-Frequency Trading</p><button onclick="nav('register')" class="m3-btn">Get Started</button></div></section>
        <section id="view-dashboard" class="view-section">
            <div class="grid grid-cols-2 gap-3 mb-3"><div class="m3-card !p-4"><p class="text-[10px] font-bold text-gray-500 uppercase">Net PnL</p><p id="netPnl" class="text-xl font-mono font-bold">$0.00</p></div><div class="m3-card !p-4"><p class="text-[10px] font-bold text-gray-500 uppercase">Wallet</p><p id="wallet" class="text-xl font-mono font-bold">$0.00</p></div></div>
            <div class="m3-card">
                <div class="sub-header">ML Core</div>
                <div class="grid grid-cols-2 gap-3"><div class="m3-field"><label class="m3-label">Lookback</label><input type="number" id="mlLookback" class="m3-input"></div><div class="m3-field"><label class="m3-label">Threshold</label><input type="number" id="mlThreshold" class="m3-input"></div></div>
                <div class="grid grid-cols-2 gap-3"><div class="m3-field"><label class="m3-label">Smoothing</label><input type="number" id="mlAverageTicks" class="m3-input"></div><div class="m3-field"><label class="m3-label">Signal</label><select id="mlUseAverage" class="m3-input h-[48px]"><option value="false">Raw</option><option value="true">Avg</option></select></div></div>
                <div class="sub-header">Risk</div>
                <div class="grid grid-cols-2 gap-3"><div class="m3-field"><label class="m3-label">TP %</label><input type="number" id="takeProfitPct" class="m3-input"></div><div class="m3-field"><label class="m3-label">SL %</label><input type="number" id="stopLossPct" class="m3-input"></div></div>
                <div class="m3-field"><label class="m3-label">Flip Mode</label><select id="flipOnlyInProfit" class="m3-input h-[48px]"><option value="true">DCA Loss</option><option value="false">Flip Loss</option></select></div>
                <div class="m3-field"><label class="m3-label">Flip Threshold %</label><input type="number" id="flipThresholdPct" class="m3-input"></div>
                <div class="sub-header">Scaling</div>
                <div class="grid grid-cols-2 gap-3"><div class="m3-field"><label class="m3-label">DCA Drop %</label><input type="number" id="dcaRoiThresholdPct" class="m3-input"></div><div class="m3-field"><label class="m3-label">DCA Multi</label><input type="number" id="dcaMultiplier" class="m3-input"></div></div>
                <div class="grid grid-cols-2 gap-3"><div class="m3-field"><label class="m3-label">Scale ROI %</label><input type="number" id="profitRoiThresholdPct" class="m3-input"></div><div class="m3-field"><label class="m3-label">Scale Multi</label><input type="number" id="profitMultiplier" class="m3-input"></div></div>
                <div class="m3-field"><label class="m3-label">Max Contracts</label><input type="number" id="maxContracts" class="m3-input"></div>
                <button onclick="saveConfig()" class="m3-btn">Save Strategy</button><button onclick="closeAll()" class="w-full text-red-500 font-bold mt-4 uppercase text-xs">Force Close</button>
            </div>
        </section>
        <section id="view-history" class="view-section"><h2 class="text-xl font-bold mb-4">Logs</h2><div id="logs" class="space-y-2"></div></section>
        <section id="view-settings" class="view-section"><div class="m3-card"><div class="sub-header">Exchange Sync</div><div class="flex justify-between p-3 bg-blue-50 rounded-xl mb-6"><span class="font-bold text-sm">Live Trade</span><input type="checkbox" id="liveTrade"></div><div class="m3-field"><label class="m3-label">API Key</label><input type="password" id="apiKey" class="m3-input"></div><div class="m3-field"><label class="m3-label">API Secret</label><input type="password" id="apiSecret" class="m3-input"></div><button onclick="saveKeys()" class="m3-btn">Sync</button><button onclick="logout()" class="w-full text-red-500 font-bold mt-8">Logout</button></div></section>
        <section id="view-login" class="view-section pt-10"><div class="m3-card"><h2 class="text-2xl font-bold mb-6 text-center">Login</h2><input type="email" id="l-email" placeholder="Email" class="m3-input mb-4"><input type="password" id="l-pass" placeholder="Password" class="m3-input mb-6"><button onclick="doLogin()" class="m3-btn">Enter</button></div></section>
        <section id="view-register" class="view-section pt-10"><div class="m3-card"><h2 class="text-2xl font-bold mb-6 text-center">Register</h2><input type="text" id="r-name" placeholder="Name" class="m3-input mb-4"><input type="email" id="r-email" placeholder="Email" class="m3-input mb-4"><input type="password" id="r-pass" placeholder="Password" class="m3-input mb-6"><button onclick="doRegister()" class="m3-btn">Create</button></div></section>
    </main>
    <nav class="m3-nav"><div class="nav-item active" onclick="nav('home')" id="n-home"><div class="icon-box"><span class="material-symbols-outlined">home</span></div><span class="text-[11px]">Home</span></div><div class="nav-item" onclick="nav('dashboard')" id="n-dashboard"><div class="icon-box"><span class="material-symbols-outlined">analytics</span></div><span class="text-[11px]">Bot</span></div><div class="nav-item" onclick="nav('history')" id="n-history"><div class="icon-box"><span class="material-symbols-outlined">history</span></div><span class="text-[11px]">Logs</span></div><div class="nav-item" onclick="nav('settings')" id="n-settings"><div class="icon-box"><span class="material-symbols-outlined">settings</span></div><span class="text-[11px]">Setup</span></div></nav>
    <script>
        let token = localStorage.getItem('bot_token');
        function nav(id) { document.querySelectorAll('.view-section').forEach(e => e.classList.remove('active-view')); document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active')); document.getElementById('view-'+id).classList.add('active-view'); const b = document.getElementById('n-'+id); if(b) b.classList.add('active'); if(id === 'dashboard') startPoll(); }
        async function api(e, m, b) { const r = await fetch(e, { method: m, headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: b ? JSON.stringify(b) : undefined }); if(r.status === 401) logout(); return r.json(); }
        async function doLogin() { const r = await api('/api/auth/login', 'POST', { email: document.getElementById('l-email').value, password: document.getElementById('l-pass').value }); token = r.token; localStorage.setItem('bot_token', token); nav('dashboard'); }
        async function doRegister() { const r = await api('/api/auth/register', 'POST', { name: document.getElementById('r-name').value, email: document.getElementById('r-email').value, password: document.getElementById('r-pass').value }); token = r.token; localStorage.setItem('bot_token', token); nav('dashboard'); }
        async function saveConfig() { await api('/api/user/config', 'POST', { takeProfitPct: document.getElementById('takeProfitPct').value, stopLossPct: document.getElementById('stopLossPct').value, mlLookback: document.getElementById('mlLookback').value, mlThreshold: document.getElementById('mlThreshold').value, mlAverageTicks: document.getElementById('mlAverageTicks').value, mlUseAverage: document.getElementById('mlUseAverage').value, flipOnlyInProfit: document.getElementById('flipOnlyInProfit').value, flipThresholdPct: document.getElementById('flipThresholdPct').value, dcaRoiThresholdPct: document.getElementById('dcaRoiThresholdPct').value, dcaMultiplier: document.getElementById('dcaMultiplier').value, profitRoiThresholdPct: document.getElementById('profitRoiThresholdPct').value, profitMultiplier: document.getElementById('profitMultiplier').value, maxContracts: document.getElementById('maxContracts').value }); alert('Saved'); }
        async function saveKeys() { await api('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked }); alert('Synced'); }
        async function closeAll() { if(confirm('Force?')) await api('/api/close-all', 'GET'); }
        function logout() { localStorage.clear(); location.reload(); }
        let poll = null;
        function startPoll() {
            if(poll) clearInterval(poll);
            poll = setInterval(async () => {
                if(!document.getElementById('view-dashboard').classList.contains('active-view')) return;
                const d = await api('/api/data', 'GET');
                document.getElementById('netPnl').innerText = '$' + d.metrics.totalNetPnl.toFixed(4);
                document.getElementById('wallet').innerText = '$' + d.walletBalance.toFixed(2);
                if(!document.getElementById('takeProfitPct').value) {
                    const c = d.config; document.getElementById('takeProfitPct').value = c.takeProfitPct; document.getElementById('stopLossPct').value = c.stopLossPct;
                    document.getElementById('mlLookback').value = c.mlLookback; document.getElementById('mlThreshold').value = c.mlThreshold;
                    document.getElementById('mlAverageTicks').value = c.mlAverageTicks; document.getElementById('mlUseAverage').value = c.mlUseAverage.toString();
                    document.getElementById('flipOnlyInProfit').value = c.flipOnlyInProfit.toString(); document.getElementById('flipThresholdPct').value = c.flipThresholdPct;
                    document.getElementById('dcaRoiThresholdPct').value = c.dcaRoiThresholdPct; document.getElementById('dcaMultiplier').value = c.dcaMultiplier;
                    document.getElementById('profitRoiThresholdPct').value = c.profitRoiThresholdPct; document.getElementById('profitMultiplier').value = c.profitMultiplier;
                    document.getElementById('maxContracts').value = c.maxContracts || Math.floor(d.walletBalance * 2000);
                }
                const logs = document.getElementById('logs'); logs.innerHTML = '';
                [...d.metrics.trades].reverse().slice(0, 10).forEach(t => { logs.innerHTML += \`<div class="m3-card !py-3 flex justify-between text-xs"><b>\${t.side.toUpperCase()}</b> <span class="\${t.netPnl>=0?'text-green-600':'text-red-600'}">$\${t.netPnl.toFixed(4)}</span> <span>\${t.exitReason}</span></div>\`; });
            }, 1000);
        }
        if(token) nav('dashboard'); else nav('home');
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Mobile Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
