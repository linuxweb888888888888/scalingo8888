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
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.config.marginMode = 'cross'; 
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = [];
        this.lastEvalPrice = 0;
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const key = user.apiKey || "demo", secret = user.apiSecret || "demo";
        this.htx = new ccxt.pro.htx({ apiKey: key, secret: secret, agent: keepAliveAgent, enableRateLimit: false, options: { defaultType: 'swap', defaultSubType: 'linear', defaultMarginMode: 'cross', positionMode: 'hedged' } });
    }
    async initialize() { await this.metrics.init(); if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.connectExchange(); this.startExchangeROISync(); }
    async saveState() { await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }); const cacheEntry = tokenCache.get(this.userId); if(cacheEntry) cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null; }
    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                try { await this.htx.setMarginMode('cross', this.config.htxSymbol); } catch(e){}
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
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
        } catch (error) { console.log(`[Worker ${this.userId}] Exchange Init Error:`, error.message); this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }
    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback);
        if (!mlSig) { mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50); mlSignalCache.set(this.config.mlLookback, mlSig); }
        if (this.lastEvalPrice !== globalMarketData.binance.mid) { this.mlRawBuffer.push(mlSig.rawValue); if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift(); this.lastEvalPrice = globalMarketData.binance.mid; }
        let avgRaw = this.mlRawBuffer.length > 0 ? (this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length) : mlSig.rawValue;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue, avgRaw: avgRaw, avgConfidence: avgConf, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' };
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;
        try {
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
            let activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;
            let signal = (activeType === 'bull' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'long' : (activeType === 'bear' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                    let instantRoi = pnlPercent * FORCED_LEVERAGE;
                    if (this.config.flipOnlyInProfit !== false) {
                        const threshold = this.config.flipThresholdPct || 0.0;
                        if (instantRoi >= threshold) { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); }
                    } else { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); }
                }
            } else { if (signal) await this.syncState(signal); }
        } catch (e) { console.error(`🚨 [Eval Error]:`, e.message); }
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0];
            let effectiveRoi = 0;
            if (this.liveTradingEnabled && !pos.isPaper) { effectiveRoi = pos.exchangeROI || 0; } else {
                let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                effectiveRoi = pnlPercent * FORCED_LEVERAGE;
            }
            if (effectiveRoi >= this.config.takeProfitPct) { await this.forceClosePosition("TAKE_PROFIT"); }
            else if (effectiveRoi <= this.config.stopLossPct) { await this.forceClosePosition("STOP_LOSS"); }
            else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0));
                const profitScaleThreshold = this.config.profitRoiThresholdPct !== undefined ? this.config.profitRoiThresholdPct : 2.0;
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) { await this.addDcaPosition(false); } 
                else if (effectiveRoi >= profitScaleThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) { await this.addDcaPosition(true); }
            }
        } catch (e) { console.error(`🚨 [Exit Check Error]:`, e.message); }
    }
    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let multiplier = isProfitScale ? (Number(this.config.profitMultiplier) || 2.0) : (Number(this.config.dcaMultiplier) || 2.0);
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            let step = Number(pos.dcaStep);
            if (isNaN(step)) step = 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step))), 10);
            if (isProfitScale) {
                const maxC = Number(this.config.maxContracts) || (Number(this.walletBalance) * 2000);
                if (Number(pos.contracts) + contractsToAdd > maxC) { pos.lastDcaTime = Date.now(); await this.saveState(); this.isTrading = false; return; }
            }
            pos.lastDcaTime = Date.now(); await this.saveState();
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) { realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average; }
                } catch(e) { return; }
            }
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: step + 1, type: isProfitScale ? 'SCALE' : 'DCA', price: realExecPrice, roi: pos.exchangeROI || 0, time: Date.now() });
            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realExecPrice;
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realExecPrice) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd;
            pos.contracts = Number(pos.contracts) + contractsToAdd; 
            pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
            pos.dcaStep = step + 1;
            this.metrics.updateMaxMargin(pos.marginUsed); await this.saveState();
        } catch (err) { console.error(`🚨 [Scale Error]:`, err.message); } finally { this.isTrading = false; }
    }
    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!executionPrice) executionPrice = globalMarketData.binance.mid;
            if (!isPaper) {
                const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                await new Promise(r => setTimeout(r, 150)); 
                try { 
                    const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); 
                    if (oOrder && oOrder.average) { executionPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average; }
                } catch(e){}
            }
            const sizeUsd = contracts * (Number(this.config.contractSize) || 1000) * executionPrice;
            const marginUsed = sizeUsd / FORCED_LEVERAGE;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: Number(marginUsed), entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] }];
            this.metrics.updateMaxMargin(marginUsed); await this.saveState();
        } catch (err) { console.error(`🚨 [Open Error]:`, err.message); this.activePositions = []; } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let realExitPrice = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;
            if (!snapPos.isPaper && this.liveTradingEnabled) {
                const closeRes = await this.htx.createMarketOrder(this.config.htxSymbol, closeSide, snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                this.activePositions = []; await new Promise(r => setTimeout(r, 150));
                try { const cOrder = await this.htx.fetchOrder(closeRes.id, this.config.htxSymbol); if (cOrder && cOrder.average) { realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average; } } catch(e){}
            } else { this.activePositions = []; }
            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.lastCloseTime = Date.now(); await this.saveState();
        } catch (err) { console.error(`🚨 [Close Error]:`, err.message); } finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading) { if (this.liveTradingEnabled) { try { const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0; } catch(e){} } return; }
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled && !pos.isPaper) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const openPos = positions.find(p => p.contracts > 0);
                    if (openPos) { let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000; pos.entryPrice = entryP; pos.exchangeROI = openPos.percentage || 0; pos.exchangePnl = openPos.unrealizedPnl || 0; return; } else { this.activePositions = []; await this.saveState(); return; }
                } catch(e) {}
            }
            let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!currentPrice) currentPrice = globalMarketData.binance.mid;
            if (currentPrice && pos.entryPrice > 0) { const sideMult = pos.side === 'long' ? 1 : -1; const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult; pos.exchangeROI = pnlPercent * FORCED_LEVERAGE; pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed; }
        }, 1000);
    }
    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    let marketsLoaded = false; while (!marketsLoaded) { try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } catch (e) { await new Promise(r => setTimeout(r, 5000)); } }
    try { const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean(); if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, mlPlot: doc.mlPlot || 0.5, timestamp: doc.timestamp })); } catch(e) {}
    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null, lastSavedMlPlot = null;
        while (true) {
            try {
                let mid = 0;
                try { const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol); mid = (ticker.bid + ticker.ask) / 2; } catch(wsErr) { const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); mid = (ticker.bid + ticker.ask) / 2; await new Promise(r => setTimeout(r, 1000)); }
                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }
                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                const lastTick = globalMarketData.tickBuffer.length > 0 ? globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] : null;
                if (mid !== lastTick) { globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift(); }
                mlSignalCache.clear(); const globalMl = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback); globalMarketData.mlSignal = globalMl; mlSignalCache.set(BASE_CONFIG.mlLookback, globalMl); 
                if (Date.now() - lastHistorySave > 2000) { if (mid !== lastSavedMid || globalMl.rawValue !== lastSavedMlPlot) { const doc = { priceMid: mid, mlPlot: globalMl.rawValue, timestamp: Date.now() }; memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); ChartDataModel.create(doc).catch(()=>{}); lastHistorySave = Date.now(); lastSavedMid = mid; lastSavedMlPlot = globalMl.rawValue; } }
                for (const worker of activeWorkers.values()) { worker.checkExits().catch(()=>{}); worker.evaluateAIEntry().catch(()=>{}); }
                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}
async function loadAllUsers() { const users = await UserModel.find({}); for(const u of users) { try { const worker = new UserTradeInstance(u); await worker.initialize(); activeWorkers.set(u._id.toString(), worker); if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() }); } catch(we) { } } }

// ==================== EXPRESS SERVER & API ====================
const app = express(); app.use(express.json());
app.post('/api/analytics/track', async (req, res) => { const { sessionId, page, isView } = req.body; if (isView) { try { let doc = await AnalyticsModel.findOne({ key: "global" }); if (!doc) doc = await AnalyticsModel.create({ key: "global" }); doc.views += 1; if (!doc.knownIds.includes(sessionId)) { doc.knownIds.push(sessionId); doc.uniques += 1; } await doc.save(); } catch(e) {} } res.json({ status: 'ok' }); });
app.get('/api/analytics/stats', async (req, res) => { let doc = await AnalyticsModel.findOne({ key: "global" }); res.json({ online: activeWorkers.size, views: doc ? doc.views : 0, uniques: doc ? doc.uniques : 0 }); });
app.post('/api/auth/register', async (req, res) => { const { name, email, password } = req.body; if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'Email already exists' }); const salt = crypto.randomBytes(16).toString('hex'); const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() }); const worker = new UserTradeInstance(user); await worker.initialize(); activeWorkers.set(user._id.toString(), worker); tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token, user: { name: user.name, email: user.email } }); });
app.post('/api/auth/login', async (req, res) => { const user = await UserModel.findOne({ email: req.body.email }); if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid credentials' }); user.token = generateToken(); await user.save(); tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token, user: { name: user.name, email: user.email } }); });
app.get('/api/user/me', authMiddleware, (req, res) => { res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled }); });
app.post('/api/user/keys', authMiddleware, async (req, res) => { const { apiKey, apiSecret, liveTradingEnabled } = req.body; let worker = activeWorkers.get(req.user._id.toString()); if(worker) { worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled }); const conn = await worker.connectExchange(); if (liveTradingEnabled && !conn.success) return res.json({ error: conn.message }); req.user.liveTradingEnabled = worker.liveTradingEnabled; } req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; await req.user.save(); res.json({ status: 'ok' }); });
app.post('/api/user/config', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(!worker) return res.status(400).json({ error: 'Worker not active' }); 
const keys = ['takeProfitPct', 'stopLossPct', 'baseContracts', 'contractSize', 'mlLookback', 'mlThreshold', 'mlAverageTicks', 'dcaRoiThresholdPct', 'dcaMultiplier', 'profitRoiThresholdPct', 'profitMultiplier', 'flipThresholdPct', 'maxContracts']; keys.forEach(k => { if(req.body[k] !== undefined) worker.config[k] = parseFloat(req.body[k]); }); 
if (req.body.mlUseAverage !== undefined) worker.config.mlUseAverage = req.body.mlUseAverage === 'true'; 
if (req.body.flipOnlyInProfit !== undefined) worker.config.flipOnlyInProfit = req.body.flipOnlyInProfit === 'true'; 
req.user.config = worker.config; req.user.markModified('config'); await req.user.save(); res.json({status: 'ok'}); });
app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(worker) { await TradeModel.deleteMany({ userId: req.user._id.toString() }); worker.metrics = new PerformanceMetrics(worker.userId); } res.json({status: 'ok'}); });
app.get('/api/data', authMiddleware, (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); res.json(worker ? worker.getExportData() : { error: "Worker not found" }); });
app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 
app.get('/api/close-all', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(worker) await worker.forceClosePosition("MANUAL").catch(()=>{}); res.json({status: 'ok'}); });

// ==================== ANDROID MOBILE UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TradeBotPille Mobile</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@500&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --m3-surface: #f7f9fc; --m3-on-surface: #1a1c1e; --m3-primary: #000000; --m3-card: #ffffff; }
        body { font-family: 'Roboto', sans-serif; background-color: var(--m3-surface); color: var(--m3-on-surface); -webkit-tap-highlight-color: transparent; overflow-x: hidden; }
        .view-section { display: none; padding-bottom: 90px; }
        .active-view { display: block; animation: android-fade 0.2s ease-out; }
        @keyframes android-fade { from { opacity: 0; } to { opacity: 1; } }
        .m3-card { background: var(--m3-card); border-radius: 24px; padding: 16px; margin-bottom: 12px; border: 1px solid #eef0f2; }
        .m3-field { position: relative; margin-bottom: 14px; }
        .m3-input { width: 100%; border: 1px solid #74777f; border-radius: 8px; padding: 10px 14px; background: transparent; outline: none; font-size: 15px; }
        .m3-label { position: absolute; left: 10px; top: -9px; background: var(--m3-card); padding: 0 4px; font-size: 11px; color: #44474e; font-weight: 500; }
        .m3-nav { position: fixed; bottom: 0; left: 0; right: 0; background: #f0f3f8; height: 75px; display: flex; justify-content: space-around; align-items: center; border-top: 1px solid #dee2e6; z-index: 100; }
        .nav-item { display: flex; flex-direction: column; align-items: center; color: #44474e; width: 25%; }
        .nav-item .icon-box { padding: 4px 18px; border-radius: 16px; margin-bottom: 3px; }
        .nav-item.active { color: #000; font-weight: 700; }
        .nav-item.active .icon-box { background: #d3e4ff; color: #001d35; }
        .m3-btn { background: var(--m3-primary); color: #fff; border-radius: 100px; padding: 12px 24px; font-weight: 500; width: 100%; text-align: center; }
        .app-bar { position: sticky; top: 0; background: var(--m3-surface); height: 56px; display: flex; align-items: center; padding: 0 16px; z-index: 50; font-size: 20px; }
        .sub-header { font-size: 13px; font-weight: 700; color: #5f6368; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
    </style>
</head>
<body>
    <header class="app-bar"><span class="material-symbols-outlined mr-3">bolt</span>TradeBotPille</header>
    <main class="px-3">
        <section id="view-home" class="view-section active-view py-10 text-center"><div class="m3-card"><h1 class="text-3xl font-bold mb-4">ML Math Engine</h1><p class="text-gray-500 mb-8">24/7 Automated execution on HTX exchange.</p><button onclick="nav('register')" class="m3-btn">Get Started</button></div></section>
        
        <section id="view-dashboard" class="view-section pt-1">
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="m3-card !p-3"><p class="text-[9px] text-gray-500 uppercase font-bold">Net PnL</p><p id="netPnl" class="text-lg font-mono font-bold">$0.00</p></div>
                <div class="m3-card !p-3"><p class="text-[9px] text-gray-500 uppercase font-bold">Wallet</p><p id="marginUsed" class="text-lg font-mono font-bold">$0.00</p></div>
            </div>
            <div class="m3-card !p-0 overflow-hidden mb-3"><div class="p-3 border-b flex justify-between"><span class="text-xs font-bold">ML Probability Chart</span><span id="mlValue" class="text-xs font-mono font-bold">0%</span></div><div class="h-40 w-full p-1"><canvas id="mlChart"></canvas></div></div>
            
            <!-- EVERY SINGLE SETTING RESTORED -->
            <div class="m3-card">
                <h3 class="font-bold mb-4 flex items-center gap-2"><span class="material-symbols-outlined text-sm">tune</span> Terminal Config</h3>
                
                <div class="sub-header">ML Core Engine</div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-field"><label class="m3-label">Lookback (Ticks)</label><input type="number" id="mlLookback" class="m3-input"></div>
                    <div class="m3-field"><label class="m3-label">Threshold (%)</label><input type="number" id="mlThreshold" class="m3-input"></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-field"><label class="m3-label">Smoothing</label><input type="number" id="mlAverageTicks" class="m3-input"></div>
                    <div class="m3-field"><label class="m3-label">Signal Trigger</label><select id="mlUseAverage" class="m3-input h-[42px]"><option value="false">Raw</option><option value="true">Averaged</option></select></div>
                </div>

                <div class="sub-header">Risk & Flips</div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-field"><label class="m3-label">Take Profit %</label><input type="number" id="tpPctSens" class="m3-input"></div>
                    <div class="m3-field"><label class="m3-label">Stop Loss %</label><input type="number" id="slPctSens" class="m3-input"></div>
                </div>
                <div class="m3-field"><label class="m3-label">Loss Behavior</label><select id="flipOnlyInProfit" class="m3-input h-[42px]"><option value="true">DCA in Loss</option><option value="false">Force Flip</option></select></div>
                <div class="m3-field"><label class="m3-label">Flip Profit Threshold %</label><input type="number" id="flipThreshold" class="m3-input"></div>

                <div class="sub-header">DCA & Scaling</div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-field"><label class="m3-label">Loss ROI Drop %</label><input type="number" id="dcaRoiThreshold" class="m3-input"></div>
                    <div class="m3-field"><label class="m3-label">Loss Multiplier</label><input type="number" id="dcaMultiplier" class="m3-input"></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-field"><label class="m3-label">Scale ROI %</label><input type="number" id="profitRoiThreshold" class="m3-input"></div>
                    <div class="m3-field"><label class="m3-label">Scale Multiplier</label><input type="number" id="profitMultiplier" class="m3-input"></div>
                </div>
                <div class="m3-field"><label class="m3-label">Max Scaled Contracts</label><input type="number" id="maxContracts" class="m3-input"></div>
                <div class="m3-field"><label class="m3-label">Start Contracts (Auto 1000x)</label><input type="number" id="baseContracts" class="m3-input bg-gray-100" disabled></div>

                <button onclick="saveConfig()" class="m3-btn !rounded-xl mt-2">Save Strategy</button>
                <button onclick="closeAll()" class="w-full text-red-500 font-bold py-2 mt-2 text-sm uppercase">Manual Force Close</button>
            </div>
        </section>

        <section id="view-step-history" class="view-section"><h2 class="text-xl font-bold mb-4">Execution Logs</h2><div id="stepHistoryBody" class="space-y-2 mb-6"></div><div id="tradeHistoryBody" class="space-y-2"></div></section>
        <section id="view-settings" class="view-section pt-4"><div class="m3-card"><h3 class="font-bold mb-6">API Access</h3><div class="flex justify-between mb-8 p-3 bg-blue-50 rounded-xl"><span class="text-sm font-bold">Live HTX Mode</span><input type="checkbox" id="liveTrade" class="w-5 h-5"></div><div class="m3-field"><label class="m3-label">API Key</label><input type="password" id="apiKey" class="m3-input"></div><div class="m3-field"><label class="m3-label">API Secret</label><input type="password" id="apiSecret" class="m3-input"></div><button onclick="saveApiKeys()" class="m3-btn">Sync Exchange</button><button onclick="logout()" class="w-full text-red-500 mt-6 font-bold uppercase text-xs">Logout</button></div></section>
        <section id="view-login" class="view-section pt-10"><div class="m3-card"><h2 class="text-2xl font-bold mb-6 text-center">Login</h2><input type="email" id="login-email" placeholder="Email" class="m3-input mb-4"><input type="password" id="login-pass" placeholder="Password" class="m3-input mb-6"><button onclick="doLogin()" class="m3-btn">Enter</button></div></section>
        <section id="view-register" class="view-section pt-10"><div class="m3-card"><h2 class="text-2xl font-bold mb-6 text-center">Register</h2><input type="text" id="reg-name" placeholder="Name" class="m3-input mb-4"><input type="email" id="reg-email" placeholder="Email" class="m3-input mb-4"><input type="password" id="reg-pass" placeholder="Password" class="m3-input mb-6"><button onclick="doRegister()" class="m3-btn">Create</button></div></section>
    </main>
    <nav class="m3-nav"><div class="nav-item active" onclick="nav('home')" id="nav-home"><div class="icon-box"><span class="material-symbols-outlined">home</span></div><span class="text-[10px]">Home</span></div><div class="nav-item" onclick="nav('dashboard')" id="nav-dashboard"><div class="icon-box"><span class="material-symbols-outlined">analytics</span></div><span class="text-[10px]">Terminal</span></div><div class="nav-item" onclick="nav('step-history')" id="nav-step-history"><div class="icon-box"><span class="material-symbols-outlined">history</span></div><span class="text-[10px]">Logs</span></div><div class="nav-item" onclick="nav('settings')" id="nav-settings"><div class="icon-box"><span class="material-symbols-outlined">settings</span></div><span class="text-[10px]">Setup</span></div></nav>

    <script>
        let authToken = localStorage.getItem('bot_token');
        function nav(id) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            document.getElementById('view-' + id).classList.add('active-view');
            document.getElementById('nav-' + id).classList.add('active');
            if(id === 'dashboard') initDashboard();
        }
        async function doAPI(e, m, b) { const h = { 'Content-Type': 'application/json' }; if (authToken) h['Authorization'] = authToken; const r = await fetch(e, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return await r.json(); }
        async function doLogin() { const r = await doAPI('/api/auth/login', 'POST', { email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value }); if(r.token) { authToken = r.token; localStorage.setItem('bot_token', r.token); nav('dashboard'); } }
        async function doRegister() { const r = await doAPI('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value }); if(r.token) { authToken = r.token; localStorage.setItem('bot_token', r.token); nav('dashboard'); } }
        function logout() { localStorage.removeItem('bot_token'); location.reload(); }
        async function saveConfig() {
            await doAPI('/api/user/config', 'POST', { 
                takeProfitPct: document.getElementById('tpPctSens').value, stopLossPct: document.getElementById('slPctSens').value,
                mlLookback: document.getElementById('mlLookback').value, mlThreshold: document.getElementById('mlThreshold').value,
                mlAverageTicks: document.getElementById('mlAverageTicks').value, mlUseAverage: document.getElementById('mlUseAverage').value,
                flipOnlyInProfit: document.getElementById('flipOnlyInProfit').value, flipThresholdPct: document.getElementById('flipThreshold').value,
                dcaRoiThresholdPct: document.getElementById('dcaRoiThreshold').value, dcaMultiplier: document.getElementById('dcaMultiplier').value,
                profitRoiThresholdPct: document.getElementById('profitRoiThreshold').value, profitMultiplier: document.getElementById('profitMultiplier').value,
                maxContracts: document.getElementById('maxContracts').value
            });
            alert('Config Saved');
        }
        async function saveApiKeys() { await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked }); nav('dashboard'); }
        async function closeAll() { if(confirm("Force close?")) await doAPI('/api/close-all', 'GET'); }
        const mlChart = new Chart(document.getElementById("mlChart").getContext("2d"), { type: "line", data: { labels: [], datasets: [{ data: [], borderColor: "#000", borderWidth: 1.5, pointRadius: 0, yAxisID: 'y' }, { data: [], borderColor: "#3b82f6", borderWidth: 1.5, pointRadius: 0, yAxisID: 'y1' }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { display: false }, y1: { display: false, min: 0, max: 1 } }, plugins: { legend: { display: false } } } });
        let dashInt = null;
        async function initDashboard() {
            if(dashInt) clearInterval(dashInt);
            dashInt = setInterval(async () => {
                if(!document.getElementById('view-dashboard').classList.contains('active-view') && !document.getElementById('view-step-history').classList.contains('active-view')) return;
                const data = await doAPI('/api/data', 'GET'); if(!data || data.error) return;
                document.getElementById('netPnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(4);
                document.getElementById('marginUsed').innerText = '$' + Number(data.walletBalance).toFixed(2);
                document.getElementById('mlValue').innerText = data.mlSignal.confidence.toFixed(1) + '%';
                document.getElementById('baseContracts').value = Math.floor(data.walletBalance * 1000);
                if(!document.getElementById('tpPctSens').value) {
                    const c = data.config;
                    document.getElementById('tpPctSens').value = c.takeProfitPct; document.getElementById('slPctSens').value = c.stopLossPct;
                    document.getElementById('mlLookback').value = c.mlLookback; document.getElementById('mlThreshold').value = c.mlThreshold;
                    document.getElementById('mlAverageTicks').value = c.mlAverageTicks; document.getElementById('mlUseAverage').value = c.mlUseAverage.toString();
                    document.getElementById('flipOnlyInProfit').value = c.flipOnlyInProfit.toString(); document.getElementById('flipThreshold').value = c.flipThresholdPct;
                    document.getElementById('dcaRoiThreshold').value = c.dcaRoiThresholdPct; document.getElementById('dcaMultiplier').value = c.dcaMultiplier;
                    document.getElementById('profitRoiThreshold').value = c.profitRoiThresholdPct; document.getElementById('profitMultiplier').value = c.profitMultiplier;
                    document.getElementById('maxContracts').value = c.maxContracts || Math.floor(data.walletBalance * 2000);
                }
                const steps = document.getElementById('stepHistoryBody'); steps.innerHTML = '';
                if(data.activePositions.length > 0) {
                    data.activePositions[0].stepHistory.forEach(s => { steps.innerHTML += \`<div class="m3-card !py-2 !mb-1 flex justify-between text-[10px]"><b>\${s.type}</b> <span>\${s.roi.toFixed(2)}%</span> <span>$\${s.price.toFixed(6)}</span></div>\`; });
                }
                const logs = document.getElementById('tradeHistoryBody'); logs.innerHTML = '';
                [...data.metrics.trades].reverse().slice(0, 5).forEach(t => { logs.innerHTML += \`<div class="m3-card !py-2 !mb-1 flex justify-between text-[10px]"><b>\${t.side.toUpperCase()}</b> <span class="\${t.netPnl>=0?'text-green-600':'text-red-600'}">$\${t.netPnl.toFixed(4)}</span> <span>\${t.exitReason}</span></div>\`; });
                mlChart.data.labels.push(""); mlChart.data.datasets[0].data.push(data.binance.mid); mlChart.data.datasets[1].data.push(data.mlSignal.rawValue);
                if(mlChart.data.labels.length > 50) { mlChart.data.labels.shift(); mlChart.data.datasets[0].data.shift(); mlChart.data.datasets[1].data.shift(); }
                mlChart.update('none');
            }, 1000);
        }
        if(authToken) nav('dashboard'); else nav('home');
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Mobile Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
