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
    
    // SMARTER SCALING DEFAULTS
    microScalpRoi: 0.6,       // ROI % to take a tiny profit
    microScalpQty: 2,         // Number of contracts to close during a scalp
    microDcaRoi: -0.4,        // ROI % to slightly improve entry
    microDcaQty: 1,           // Number of contracts to add to improve entry
    
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

// ==================== HELPER: CORE MATH ====================
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

// ==================== MACHINE LEARNING MATH ENGINE ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000, ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000, ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000, ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000];
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

// ==================== METRICS ENGINE ====================
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

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) { this.config.htxSymbol = 'SHIB/USDT:USDT'; this.config.binanceSymbol = '1000SHIB/USDT:USDT'; }
        this.config.leverage = FORCED_LEVERAGE;
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.lastEvalPrice = 0; this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, enableRateLimit: false, options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } });
    }
    
    async initialize() {
        await this.metrics.init(); 
        if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed);
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                    this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.saveState();
                } else { this.activePositions = []; await this.saveState(); }
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }

    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback) || calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
        mlSignalCache.set(this.config.mlLookback, mlSig);
        if (this.lastEvalPrice !== globalMarketData.binance.mid) {
            this.mlRawBuffer.push(mlSig.rawValue);
            if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift();
            this.lastEvalPrice = globalMarketData.binance.mid;
        }
        let avgRaw = this.mlRawBuffer.length > 0 ? (this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length) : mlSig.rawValue;
        this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue, avgRaw: avgRaw, avgConfidence: Math.min(Math.abs(avgRaw - 0.5) * 200, 100), avgType: avgRaw >= 0.5 ? 'bull' : 'bear' };

        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        try {
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
            let activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;
            let signal = (activeType === 'bull' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'long' : (activeType === 'bear' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                    if (!this.config.flipOnlyInProfit || math.currentGrossRoi >= (this.config.flipThresholdPct || 0.5)) {
                        await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 100);
                    }
                }
            } else if (signal) { await this.syncState(signal); }
        } catch (e) { console.error(`🚨 [Eval Error]:`, e.message); }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0];
            const effRoi = (this.liveTradingEnabled && !pos.isPaper) ? pos.exchangeROI : calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0).currentGrossRoi;
            
            if (effRoi >= this.config.takeProfitPct) { await this.forceClosePosition("TAKE_PROFIT"); return; }
            if (effRoi <= this.config.stopLossPct) { await this.forceClosePosition("STOP_LOSS"); return; }

            // SMARTER SCALING: PARTIAL PROFIT TAKING (MICRO-SCALP)
            // If we are in profit and the signal starts to weaken, bank a small amount.
            const mlWeakening = (pos.side === 'long' && this.currentMl.rawValue < 0.52) || (pos.side === 'short' && this.currentMl.rawValue > 0.48);
            if (effRoi >= (this.config.microScalpRoi || 0.6) && mlWeakening && pos.contracts > 5) {
                await this.executeMicroOrder('close', this.config.microScalpQty || 2, "MICRO_SCALP");
                return;
            }

            // SMARTER SCALING: ENTRY IMPROVEMENT (MICRO-DCA)
            // If slightly negative but signal is strong, buy a tiny bit to shave entry price.
            const mlStrong = (pos.side === 'long' && this.currentMl.rawValue > 0.65) || (pos.side === 'short' && this.currentMl.rawValue < 0.35);
            if (effRoi <= (this.config.microDcaRoi || -0.4) && mlStrong && (Date.now() - (pos.lastDcaTime || 0) > 30000)) {
                await this.executeMicroOrder('open', this.config.microDcaQty || 1, "ENTRY_IMPROVE");
                return;
            }

            // Standard DCA Logic
            const dcaThreshold = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0));
            if (effRoi <= dcaThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                if (pos.dcaStep >= (this.config.maxDcaStepsBeforeReverse || 10)) {
                    const rev = pos.side === 'long' ? 'short' : 'long';
                    await this.forceClosePosition("MAX_DCA_REVERSE"); setTimeout(() => this.syncState(rev), 200);
                } else { await this.addDcaPosition(false); }
            } else if (effRoi >= (this.config.profitRoiThresholdPct || 2.0) && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                await this.addDcaPosition(true);
            }
        } catch (e) { console.error(`🚨 [Exit Check Error]:`, e.message); }
    }

    async executeMicroOrder(action, qty, reason) {
        if (this.isTrading) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const side = action === 'open' ? (pos.side === 'long' ? 'buy' : 'sell') : (pos.side === 'long' ? 'sell' : 'buy');
            const price = globalMarketData.binance.mid;
            
            if (this.liveTradingEnabled && !pos.isPaper) {
                await this.htx.createMarketOrder(this.config.htxSymbol, side, qty, undefined, action === 'close' ? { reduceOnly: true } : {});
            }

            const addedSize = qty * this.config.contractSize * price;
            if (action === 'open') {
                pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
                pos.size += addedSize; pos.contracts += qty; pos.lastDcaTime = Date.now();
            } else {
                pos.contracts -= qty; pos.size -= (qty * this.config.contractSize * pos.entryPrice);
            }
            
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: reason, price: price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
            console.log(`[User ${this.userId}] ${reason} Executed: ${qty} contracts at ${price}`);
        } catch(e) { console.error(`Micro Order Error:`, e.message); }
        finally { this.isTrading = false; }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const mult = isProfitScale ? 1.5 : (this.config.dcaMultiplier || 2.0);
            const baseC = Math.max(1, Math.floor(Number(this.walletBalance) * 5));
            const contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(mult, pos.dcaStep))), 10);
            
            if (isProfitScale && (pos.contracts + contractsToAdd > (this.config.maxContracts || 100))) { this.isTrading = false; return; }

            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled && !pos.isPaper) {
                await this.htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'buy' : 'sell', contractsToAdd);
            }

            const addedSizeUsd = contractsToAdd * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSizeUsd)) / (pos.size + addedSizeUsd);
            pos.size += addedSizeUsd; pos.contracts += contractsToAdd; pos.dcaStep++; pos.lastDcaTime = Date.now();
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: isProfitScale ? 'SCALE' : 'DCA', price: price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const contracts = Math.max(1, Math.floor(Number(this.walletBalance) * 5));
            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled) { await this.htx.createMarketOrder(this.config.htxSymbol, targetSide === 'long' ? 'buy' : 'sell', contracts); }
            const sizeUsd = contracts * this.config.contractSize * price;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: price, contracts: contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper: !this.liveTradingEnabled, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: price, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } catch (err) { this.activePositions = []; }
        finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled && !pos.isPaper) { await this.htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true }); }
            const math = calculateTradeMath(pos.side, pos.entryPrice, price, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice: price, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } finally { this.isTrading = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            if (this.isTrading) return;
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = bal.total.USDT || 0;
                    if (this.activePositions.length > 0) {
                        const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                        const openPos = positions.find(p => p.contracts > 0);
                        if (openPos) { this.activePositions[0].exchangeROI = openPos.percentage || 0; this.activePositions[0].exchangePnl = openPos.unrealizedPnl || 0; }
                        else { this.activePositions = []; await this.saveState(); }
                    }
                } catch(e) {}
            }
        }, 1500);
    }

    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

// ==================== WORKER MANAGER & SERVER ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                if (globalMarketData.tickBuffer.length === 0 || mid !== globalMarketData.tickBuffer[globalMarketData.tickBuffer.length-1]) {
                    globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                }
                const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = ml; mlSignalCache.clear();
                for (const w of activeWorkers.values()) { w.checkExits(); w.evaluateAIEntry(); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

const app = express(); app.use(express.json());
app.get('/', (req, res) => res.send(`<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;padding:50px"><h1>TradeBot Optimized</h1><p>Smart Scaling is Active: Scaling in on dips and scaling out on profit peaks using micro-orders.</p></body></html>`));

app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { const w = new UserTradeInstance(u); await w.initialize(); activeWorkers.set(u._id.toString(), w); }
    startMasterStreams();
    console.log(`✅ Engine running on ${CUSTOM_PORT}`);
});
