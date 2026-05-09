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
    try { await publicBinance.loadMarkets(); } catch (e) { return { error: `Market error: ${e.message}` }; }
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
    if (!ticks || ticks.length === 0) return { error: `No historical tick data fetched.` };
    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { mlLookback=50, mlThreshold=60.0, mlAverageTicks=5, mlUseAverage=false, flipOnlyInProfit=true, flipThresholdPct=0.5 } = config;
    let priceBuffer = [], mlRawBuffer = [];
    const totalSpanMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;
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
                const requiredRoiForDca = -(Math.abs(config.dcaRoiThresholdPct || 1.0));
                const profitRoiThresholdPct = config.profitRoiThresholdPct !== undefined ? config.profitRoiThresholdPct : 2.0;
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1; let mult = Number(config.dcaMultiplier) || 2.0; let step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                    activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                    activePos.size = Number(activePos.size) + addedSizeUsd; activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                    activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                    activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                } else if (math.currentGrossRoi >= profitRoiThresholdPct && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1; let mult = Number(config.profitMultiplier) || 2.0; let step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    if (Number(activePos.contracts) + contractsToAdd <= (config.maxContracts || 100)) {
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
    }
    const totalTradesCount = closedTrades.length;
    const formatTime = (ms) => {
        if (ms < 1000) return "< 1s";
        let s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h%24}h`; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m ${s%60}s`; return `${s}s`;
    };
    return { 
        ticksAnalyzed: ticks.length, totalTradesCount, wins, losses, winRate: totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(2) : 0, 
        netPnl, depositNeeded: maxMarginUsed, avgDuration: formatTime(totalTradesCount > 0 ? totalTradeDurationMs / totalTradesCount : 0), totalSpan: formatTime(totalSpanMs), trades: closedTrades.slice(-200) 
    };
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) { this.config.htxSymbol = 'SHIB/USDT:USDT'; this.config.binanceSymbol = '1000SHIB/USDT:USDT'; }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE; this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.lastEvalPrice = 0; this.walletBalance = 0;
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
                await this.htx.loadMarkets(); try { await this.htx.setMarginMode('cross', this.config.htxSymbol); } catch(e){} try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                    this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.saveState();
                } else { this.activePositions = []; await this.saveState(); }
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
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
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                    let instantRoi = pnlPercent * FORCED_LEVERAGE;
                    if (this.config.flipOnlyInProfit !== false) { if (instantRoi >= (this.config.flipThresholdPct || 0.0)) { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); } } 
                    else { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); }
                }
            } else if (signal) await this.syncState(signal);
        } catch (e) {}
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0]; let effectiveRoi = 0;
            if (this.liveTradingEnabled && !pos.isPaper) { effectiveRoi = pos.exchangeROI || 0; } 
            else {
                let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!currentPrice) currentPrice = globalMarketData.binance.mid;
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
        } catch (e) {}
    }
    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0]; const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let multiplier = isProfitScale ? (Number(this.walletBalance) * 1) : (this.config.dcaMultiplier || 2.0);
            let baseC = (Number(this.walletBalance) * 1000) || 1; let step = Number(pos.dcaStep) || 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step))), 10);
            if (isProfitScale) { if (Number(pos.contracts) + contractsToAdd > (Number(this.walletBalance) * 2)) { pos.lastDcaTime = Date.now(); await this.saveState(); this.isTrading = false; return; } }
            pos.lastDcaTime = Date.now(); await this.saveState();
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid; if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) { realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average; }
                } catch(e) { this.isTrading = false; return; }
            }
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: step + 1, type: isProfitScale ? 'SCALE' : 'DCA', price: realExecPrice, roi: pos.exchangeROI || 0, time: Date.now() });
            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realExecPrice;
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realExecPrice) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd; pos.contracts = Number(pos.contracts) + contractsToAdd; 
            pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE); pos.dcaStep = step + 1;
            this.metrics.updateMaxMargin(pos.marginUsed); await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }
    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            let baseC = (Number(this.walletBalance) * 1000) || 1; const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid; if (!executionPrice) executionPrice = globalMarketData.binance.mid;
            if (!isPaper) {
                const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                await new Promise(r => setTimeout(r, 150)); try { const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); if (oOrder && oOrder.average) { executionPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average; } } catch(e){}
            }
            const sizeUsd = contracts * (Number(this.config.contractSize) || 1000) * executionPrice;
            const marginUsed = sizeUsd / FORCED_LEVERAGE;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: Number(marginUsed), entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] }];
            this.metrics.updateMaxMargin(marginUsed); await this.saveState();
        } catch (err) { this.activePositions = []; } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] }; const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let realExitPrice = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;
            if (!snapPos.isPaper && this.liveTradingEnabled) {
                const closeRes = await this.htx.createMarketOrder(this.config.htxSymbol, closeSide, snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                this.activePositions = []; await new Promise(r => setTimeout(r, 150));
                try { const cOrder = await this.htx.fetchOrder(closeRes.id, this.config.htxSymbol); if (cOrder && cOrder.average) { realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average; } } catch(e){}
            } else { this.activePositions = []; }
            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.lastCloseTime = Date.now(); await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading) { if (this.liveTradingEnabled) { try { const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0; } catch(e){} } return; }
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled && !pos.isPaper) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]); const openPos = positions.find(p => p.contracts > 0);
                    if (openPos) { let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000; pos.entryPrice = entryP; pos.exchangeROI = openPos.percentage || 0; pos.exchangePnl = openPos.unrealizedPnl || 0; return; } 
                    else { this.activePositions = []; await this.saveState(); return; }
                } catch(e) {}
            }
            let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!currentPrice) currentPrice = globalMarketData.binance.mid;
            if (currentPrice && pos.entryPrice > 0) { const sideMult = pos.side === 'long' ? 1 : -1; const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult; pos.exchangeROI = pnlPercent * FORCED_LEVERAGE; pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed; }
        }, 1000);
    }
    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

const activeWorkers = new Map();
async function startMasterStreams() {
    let marketsLoaded = false; while (!marketsLoaded) { try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } catch (e) { await new Promise(r => setTimeout(r, 5000)); } }
    try { const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean(); if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, mlPlot: doc.mlPlot || 0.5, timestamp: doc.timestamp })); } catch(e) {}
    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null, lastSavedMlPlot = null;
        while (true) {
            try {
                let mid = 0;
                try { const ticker = await Promise.race([ publicBinance.watchTicker(BASE_CONFIG.binanceSymbol), new Promise((_, r) => setTimeout(() => r(new Error('WS_TIMEOUT')), 3000)) ]); let bid = ticker.bid !== undefined ? ticker.bid : ticker.last; let ask = ticker.ask !== undefined ? ticker.ask : ticker.last; mid = (bid + ask) / 2; } 
                catch(wsErr) { const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); let bid = ticker.bid !== undefined ? ticker.bid : ticker.last; let ask = ticker.ask !== undefined ? ticker.ask : ticker.last; mid = (bid + ask) / 2; await new Promise(r => setTimeout(r, 1000)); }
                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }
                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                const lastTick = globalMarketData.tickBuffer.length > 0 ? globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] : null;
                if (mid !== lastTick) { globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift(); }
                mlSignalCache.clear(); const globalMl = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = globalMl; mlSignalCache.set(BASE_CONFIG.mlLookback, globalMl); 
                if (Date.now() - lastHistorySave > 2000) { if (mid !== lastSavedMid || globalMl.rawValue !== lastSavedMlPlot) { const doc = { priceMid: mid, mlPlot: globalMl.rawValue, timestamp: Date.now() }; memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); ChartDataModel.create(doc).catch(()=>{}); lastHistorySave = Date.now(); lastSavedMid = mid; lastSavedMlPlot = globalMl.rawValue; } }
                for (const worker of activeWorkers.values()) { worker.checkExits().catch(()=>{}); worker.evaluateAIEntry().catch(()=>{}); }
                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() { try { const users = await UserModel.find({}); for(const u of users) { try { const worker = new UserTradeInstance(u); await worker.initialize(); activeWorkers.set(u._id.toString(), worker); if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() }); } catch(we) {} } } catch(e) {} }

// ==================== EXPRESS & API ====================
const app = express(); app.use(express.json());

app.post('/api/analytics/track', async (req, res) => {
    const { sessionId, page, isView } = req.body; if (!sessionId) return res.status(400).json({ error: 'Missing session' });
    if (isView) { try { let doc = await AnalyticsModel.findOne({ key: "global" }); if (!doc) doc = await AnalyticsModel.create({ key: "global" }); doc.views += 1; if (!doc.knownIds.includes(sessionId)) { doc.knownIds.push(sessionId); doc.uniques += 1; } await doc.save(); } catch(e) {} }
    res.json({ status: 'ok' });
});

app.post('/api/backtest', async (req, res) => {
    const bConfig = { ...BASE_CONFIG, takeProfitPct: parseFloat(req.body.tpPct) || 10.0, stopLossPct: parseFloat(req.body.slPct) || -50.0, baseContracts: parseInt(req.body.baseContracts) || 1, mlLookback: parseInt(req.body.mlLookback) || 50, mlThreshold: parseFloat(req.body.mlThreshold) || 60.0, mlAverageTicks: parseInt(req.body.mlAverageTicks) || 5, mlUseAverage: (req.body.mlUseAverage === 'true'), flipOnlyInProfit: (req.body.flipOnlyInProfit === 'true'), flipThresholdPct: parseFloat(req.body.flipThresholdPct) || 0.5, dcaRoiThresholdPct: parseFloat(req.body.dcaRoiThresholdPct) || 1.0, dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0, profitRoiThresholdPct: parseFloat(req.body.profitRoiThresholdPct) || 2.0, profitMultiplier: parseFloat(req.body.profitMultiplier) || 2.0, maxContracts: parseInt(req.body.maxContracts) || 100 };
    try { const results = await runBacktestSimulation(bConfig, parseInt(req.body.ticks) || 5000, BASE_CONFIG.binanceSymbol); res.json(results); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
    try { const { name, email, password } = req.body; if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'Exists' });
        const salt = crypto.randomBytes(16).toString('hex'); const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        const worker = new UserTradeInstance(user); await worker.initialize(); activeWorkers.set(user._id.toString(), worker); tokenCache.set(user.token, { user, lastAccessed: Date.now() });
        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try { const user = await UserModel.findOne({ email: req.body.email }); if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
        user.token = generateToken(); await user.save(); tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/user/me', authMiddleware, (req, res) => { res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled }); });

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    try { const { apiKey, apiSecret, liveTradingEnabled } = req.body;
        let worker = activeWorkers.get(req.user._id.toString());
        if(worker) { if (Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && worker.activePositions[0].isPaper) worker.activePositions = [];
            worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled }); const connectionResult = await worker.connectExchange(); if (liveTradingEnabled && !connectionResult.success) { worker.liveTradingEnabled = false; return res.json({ error: connectionResult.message }); }
            req.user.liveTradingEnabled = worker.liveTradingEnabled;
        } else req.user.liveTradingEnabled = Boolean(liveTradingEnabled);
        req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; await req.user.save(); res.json({ status: 'ok' });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString()); if(!worker) return res.status(400).json({ error: 'Inactive' });
    const { tpPct, slPct, baseContracts, contractSize, mlLookbackSens, mlThresholdSens, mlAverageTicksSens, mlUseAverageSens, flipOnlyInProfitSens, flipThresholdSens, dcaRoiThresholdSens, dcaMultiplierSens, profitRoiThresholdSens, profitMultiplierSens, maxContractsSens } = req.body;
    const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) worker.config[k] = p; } };
    pSet(tpPct, parseFloat, 'takeProfitPct'); pSet(slPct, parseFloat, 'stopLossPct'); pSet(baseContracts, parseInt, 'baseContracts'); pSet(contractSize, parseFloat, 'contractSize'); pSet(mlLookbackSens, parseInt, 'mlLookback'); pSet(mlThresholdSens, parseFloat, 'mlThreshold'); pSet(mlAverageTicksSens, parseInt, 'mlAverageTicks'); pSet(dcaRoiThresholdSens, parseFloat, 'dcaRoiThresholdPct'); pSet(dcaMultiplierSens, parseFloat, 'dcaMultiplier'); pSet(profitRoiThresholdSens, parseFloat, 'profitRoiThresholdPct'); pSet(profitMultiplierSens, parseFloat, 'profitMultiplier'); pSet(flipThresholdSens, parseFloat, 'flipThresholdPct'); pSet(maxContractsSens, parseInt, 'maxContracts'); 
    if (mlUseAverageSens !== undefined) worker.config.mlUseAverage = (mlUseAverageSens === 'true'); if (flipOnlyInProfitSens !== undefined) worker.config.flipOnlyInProfit = (flipOnlyInProfitSens === 'true');
    req.user.config = worker.config; req.user.markModified('config'); await req.user.save(); res.json({status: 'ok'});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => { try { const worker = activeWorkers.get(req.user._id.toString()); if(worker) { await TradeModel.deleteMany({ userId: req.user._id.toString() }); worker.metrics = new PerformanceMetrics(worker.userId); } res.json({status: 'ok'}); } catch(err) { res.status(500).json({error: 'Failed'}); } });
app.get('/api/data', authMiddleware, (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); res.json(worker ? worker.getExportData() : { error: "None" }); });
app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 
app.get('/api/close-all', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(worker) await worker.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{}); res.json({status: 'ok'}); });

// ==================== FRONTEND (ANDROID MOBILE DESIGN) ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>TradeBot Mobile</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --surface: #f7f9fc; --on-surface: #1a1c1e; --primary: #0061a4; --secondary-container: #d1e4ff; --error: #ba1a1a; }
        body { font-family: 'Roboto', sans-serif; background-color: var(--surface); color: var(--on-surface); -webkit-tap-highlight-color: transparent; overflow-x: hidden; }
        .app-bar { position: fixed; top: 0; left: 0; right: 0; height: 64px; background: white; display: flex; align-items: center; padding: 0 16px; z-index: 100; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; height: 80px; background: white; border-top: 1px solid #eee; display: flex; justify-content: space-around; align-items: center; z-index: 100; padding-bottom: env(safe-area-inset-bottom); }
        .nav-item { display: flex; flex-direction: column; align-items: center; color: #444; font-size: 11px; font-weight: 500; gap: 4px; flex: 1; }
        .nav-item.active { color: var(--primary); }
        .nav-item.active .material-symbols-outlined { background: var(--secondary-container); border-radius: 16px; padding: 2px 16px; font-variation-settings: 'FILL' 1; }
        .main-container { margin-top: 64px; margin-bottom: 90px; padding: 16px; min-height: calc(100vh - 154px); }
        .view-section { display: none; animation: slideUp 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); }
        .active-view { display: block; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .m3-card { background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; border: 1px solid #eef2f6; }
        .m3-input-group { position: relative; margin-bottom: 16px; }
        .m3-input { width: 100%; border: 1px solid #8e9199; border-radius: 4px; padding: 10px; background: transparent; font-size: 14px; outline: none; transition: border-color 0.2s; }
        .m3-input:focus { border-color: var(--primary); border-width: 2px; }
        .m3-label { position: absolute; left: 10px; top: -10px; background: white; padding: 0 4px; font-size: 11px; color: #444; font-weight: 500; }
        .m3-select { width: 100%; border: 1px solid #8e9199; border-radius: 4px; padding: 10px; background: white; font-size: 14px; appearance: none; }
        .btn-fab { position: fixed; bottom: 96px; right: 20px; width: 56px; height: 56px; background: var(--error); border-radius: 50%; display: flex; items: center; justify-content: center; color: white; box-shadow: 0 4px 12px rgba(0,0,0,0.25); z-index: 150; border: none; cursor: pointer; }
        .metric-label { font-size: 10px; font-weight: 700; color: #74777f; text-transform: uppercase; letter-spacing: 0.5px; }
        .metric-value { font-family: 'Roboto Mono', monospace; font-size: 16px; font-weight: 700; }
        #chartWrapper { height: 180px; width: 100%; }
    </style>
</head>
<body>

    <header class="app-bar">
        <div class="flex items-center gap-3 w-full">
            <div class="w-8 h-8 rounded-lg bg-black flex items-center justify-center text-white text-xs font-bold">TB</div>
            <div class="flex-1">
                <h1 class="text-sm font-bold leading-none">TradeBot Engine</h1>
                <span id="statusBadge" class="text-[10px] text-gray-400 font-bold uppercase">Connecting...</span>
            </div>
            <div id="userProfile" class="hidden flex items-center gap-2">
                <span id="nav-user-name" class="text-xs font-bold text-gray-600"></span>
                <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600"><span class="material-symbols-outlined text-[18px]">person</span></div>
            </div>
        </div>
    </header>

    <main class="main-container">

        <!-- HOME -->
        <section id="view-home" class="view-section active-view">
            <div class="py-8 text-center">
                <div class="w-20 h-20 bg-blue-50 rounded-3xl flex items-center justify-center mx-auto mb-6"><span class="material-symbols-outlined text-4xl text-blue-600">bolt</span></div>
                <h2 class="text-3xl font-bold tracking-tight mb-2">Automated SHIB<br>AI Trading</h2>
                <p class="text-gray-500 text-sm px-4 mb-8">Deploy machine learning strategies directly from your mobile device.</p>
                <div class="space-y-3 px-4" id="home-auth-btns">
                    <button onclick="nav('login')" class="w-full py-4 bg-black text-white rounded-2xl font-bold text-sm">Sign In</button>
                    <button onclick="nav('register')" class="w-full py-4 bg-white border border-gray-200 text-black rounded-2xl font-bold text-sm">Create Account</button>
                </div>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section">
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="m3-card !mb-0 flex flex-col justify-between"><span class="metric-label">Net PnL</span><span id="netPnl" class="metric-value">$0.00</span></div>
                <div class="m3-card !mb-0 flex flex-col justify-between"><span class="metric-label">Active ROI</span><span id="activeRoi" class="metric-value">N/A</span></div>
            </div>
            <div class="m3-card">
                <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-gray-400 uppercase">Live ML Prob.</span><span id="mlValue" class="text-xs font-mono font-bold">0%</span></div>
                <div id="chartWrapper"><canvas id="mlChart"></canvas></div>
                <div class="flex gap-2 justify-center mt-2"><div id="mlStatus" class="text-[9px] font-bold px-2 py-1 rounded bg-gray-100 uppercase">Neutral</div></div>
            </div>
            <div class="m3-card">
                <div class="flex justify-between border-b pb-3 mb-3 border-gray-50">
                    <div><span class="metric-label block">Wallet Balance</span><span id="marginUsed" class="text-lg font-bold font-mono">$0.00</span></div>
                    <div class="text-right"><span class="metric-label block">Contracts</span><span id="activeQty" class="text-lg font-bold font-mono">0</span></div>
                </div>
                <div class="flex items-center gap-2"><span class="material-symbols-outlined text-[16px] text-gray-400">history</span><span class="text-[10px] font-bold text-gray-400 uppercase">Uptime: <span id="uptime" class="text-black">0s</span></span></div>
            </div>
            <div class="m3-card"><h3 class="text-[10px] font-bold uppercase text-gray-400 mb-3">Recent Executions</h3><div id="tradeHistoryBody" class="space-y-3"><p class="text-center py-4 text-xs text-gray-400">No trades found.</p></div></div>
        </section>

        <!-- SETUP MENU (EVERY SETTING RESTORED) -->
        <section id="view-settings" class="view-section">
            <h2 class="text-xl font-bold mb-4">Strategy Setup</h2>
            <div class="m3-card">
                <h3 class="text-xs font-bold uppercase text-gray-400 mb-4">HTX API Connection</h3>
                <div class="m3-input-group"><label class="m3-label">API Key</label><input type="password" id="apiKey" class="m3-input"></div>
                <div class="m3-input-group"><label class="m3-label">API Secret</label><input type="password" id="apiSecret" class="m3-input"></div>
                <div class="flex items-center justify-between py-2 px-1"><span class="text-xs font-bold">Enable Live Trading</span><input type="checkbox" id="liveTrade" class="w-6 h-6 accent-blue-600"></div>
                <button onclick="saveApiKeys()" class="w-full py-3 mt-3 bg-black text-white rounded-xl font-bold text-xs">Update Connection</button>
                <p id="key-msg" class="text-[9px] text-center mt-2"></p>
            </div>
            <div class="m3-card">
                <h3 class="text-xs font-bold uppercase text-gray-400 mb-4">ML Engine Logic</h3>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-input-group"><label class="m3-label">Lookback</label><input type="number" id="mlLookbackSens" class="m3-input"></div>
                    <div class="m3-input-group"><label class="m3-label">Threshold %</label><input type="number" id="mlThresholdSens" class="m3-input"></div>
                </div>
                <div class="m3-input-group"><label class="m3-label">Smoothing (Ticks)</label><input type="number" id="mlAverageTicksSens" class="m3-input"></div>
                <div class="m3-input-group">
                    <label class="m3-label">Signal Trigger</label>
                    <select id="mlUseAverageSens" class="m3-select"><option value="false">Raw Signal</option><option value="true">Averaged</option></select>
                </div>
            </div>
            <div class="m3-card">
                <h3 class="text-xs font-bold uppercase text-gray-400 mb-4">Risk & Exit</h3>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-input-group"><label class="m3-label">Take Profit %</label><input type="number" id="tpPctSens" class="m3-input" step="0.1"></div>
                    <div class="m3-input-group"><label class="m3-label">Stop Loss %</label><input type="number" id="slPctSens" class="m3-input" step="0.1"></div>
                </div>
                <div class="m3-input-group">
                    <label class="m3-label">Loss Behavior</label>
                    <select id="flipOnlyInProfitSens" class="m3-select"><option value="true">DCA in Loss</option><option value="false">Force Flip</option></select>
                </div>
                <div class="m3-input-group"><label class="m3-label">Flip ROI Threshold %</label><input type="number" id="flipThresholdSens" class="m3-input" step="0.1"></div>
            </div>
            <div class="m3-card">
                <h3 class="text-xs font-bold uppercase text-gray-400 mb-4">DCA & Profit Scaling</h3>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-input-group"><label class="m3-label">Loss DCA ROI</label><input type="number" id="dcaRoiThresholdSens" class="m3-input" step="0.1"></div>
                    <div class="m3-input-group"><label class="m3-label">Loss Mult</label><input type="number" id="dcaMultiplierSens" class="m3-input" step="0.1"></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-input-group"><label class="m3-label">Profit Scale ROI</label><input type="number" id="profitRoiThresholdSens" class="m3-input" step="0.1"></div>
                    <div class="m3-input-group"><label class="m3-label">Profit Mult</label><input type="number" id="profitMultiplierSens" class="m3-input" disabled></div>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div class="m3-input-group"><label class="m3-label">Start Contracts</label><input type="number" id="baseContracts" class="m3-input" disabled></div>
                    <div class="m3-input-group"><label class="m3-label">Max Scaling</label><input type="number" id="maxContractsSens" class="m3-input" disabled></div>
                </div>
            </div>
            <button onclick="saveConfig()" class="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-sm shadow-lg mb-4">Save Strategy Config</button>
            <button onclick="logout()" class="w-full py-4 text-red-500 font-bold text-sm">Logout</button>
        </section>

        <!-- BACKTEST -->
        <section id="view-backtest" class="view-section">
            <h2 class="text-xl font-bold mb-4">Backtest Engine</h2>
            <div class="m3-card">
                <div class="grid grid-cols-2 gap-4">
                    <div class="m3-input-group"><label class="m3-label">Span (Min)</label><input type="number" id="btTicks" class="m3-input" value="5000"></div>
                    <div class="m3-input-group"><label class="m3-label">Lookback</label><input type="number" id="btMlLookback" class="m3-input" value="50"></div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="m3-input-group"><label class="m3-label">TP %</label><input type="number" id="btTp" class="m3-input" value="10.0" step="0.1"></div>
                    <div class="m3-input-group"><label class="m3-label">SL %</label><input type="number" id="btSl" class="m3-input" value="-50.0" step="1"></div>
                </div>
                <button onclick="runBacktest()" class="w-full py-4 bg-blue-600 text-white rounded-xl font-bold text-sm">Run Simulation</button>
            </div>
            <div id="backtestResults" class="hidden">
                 <div class="grid grid-cols-2 gap-3 mb-3">
                    <div class="m3-card !mb-0"><span class="metric-label block">Win Rate</span><span id="btResWinrate" class="metric-value">-</span></div>
                    <div class="m3-card !mb-0"><span class="metric-label block">Net Pnl</span><span id="btResPnl" class="metric-value">-</span></div>
                </div>
                <div class="m3-card"><div id="btTableBody" class="space-y-2 text-[10px] font-mono"></div></div>
            </div>
        </section>

        <!-- AUTH -->
        <section id="view-login" class="view-section"><h2 class="text-2xl font-bold mb-6">Sign In</h2><div class="m3-card"><div class="m3-input-group"><label class="m3-label">Email</label><input type="email" id="login-email" class="m3-input"></div><div class="m3-input-group"><label class="m3-label">Password</label><input type="password" id="login-pass" class="m3-input"></div><button onclick="doLogin()" class="w-full py-4 bg-black text-white rounded-2xl font-bold">Login</button><p id="login-err" class="text-red-500 text-xs mt-3 text-center"></p></div></section>
        <section id="view-register" class="view-section"><h2 class="text-2xl font-bold mb-6">Register</h2><div class="m3-card"><div class="m3-input-group"><label class="m3-label">Name</label><input type="text" id="reg-name" class="m3-input"></div><div class="m3-input-group"><label class="m3-label">Email</label><input type="email" id="reg-email" class="m3-input"></div><div class="m3-input-group"><label class="m3-label">Password</label><input type="password" id="reg-pass" class="m3-input"></div><button onclick="doRegister()" class="w-full py-4 bg-black text-white rounded-2xl font-bold">Sign Up</button><p id="reg-err" class="text-red-500 text-xs mt-3 text-center"></p></div></section>

    </main>

    <button id="fabClose" class="btn-fab hidden" onclick="closeAll()" title="Close All"><span class="material-symbols-outlined">close</span></button>

    <nav class="bottom-nav">
        <button onclick="nav('home')" id="nav-home" class="nav-item active"><span class="material-symbols-outlined">home</span><span>Home</span></button>
        <button onclick="nav('dashboard')" id="nav-dashboard" class="nav-item"><span class="material-symbols-outlined">show_chart</span><span>Trade</span></button>
        <button onclick="nav('backtest')" id="nav-backtest" class="nav-item"><span class="material-symbols-outlined">science</span><span>Test</span></button>
        <button onclick="nav('settings')" id="nav-settings" class="nav-item"><span class="material-symbols-outlined">settings</span><span>Setup</span></button>
    </nav>

    <script>
        let authToken = localStorage.getItem('bot_token');
        let chartPoints = 100;
        let dashLoop = null;
        let settingsLoaded = false;

        function nav(v) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.getElementById('view-' + v).classList.add('active-view');
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            const activeNav = document.getElementById('nav-' + (['login','register'].includes(v) ? 'home' : v));
            if(activeNav) activeNav.classList.add('active');
            if(v === 'dashboard' && authToken) initDashboard();
            const fab = document.getElementById('fabClose');
            if(v === 'dashboard' && authToken) fab.classList.remove('hidden'); else fab.classList.add('hidden');
            window.scrollTo(0,0);
        }

        function logout() { localStorage.removeItem('bot_token'); location.reload(); }

        async function doAPI(endpoint, method, body) {
            const h = { 'Content-Type': 'application/json' };
            if (authToken) h['Authorization'] = authToken;
            const res = await fetch(endpoint, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
            if (res.status === 401) { logout(); return { error: "Expired" }; }
            return await res.json();
        }

        async function initDashboard() {
            document.getElementById('userProfile').classList.remove('hidden');
            document.getElementById('home-auth-btns').classList.add('hidden');
            if(dashLoop) clearInterval(dashLoop);
            dashLoop = setInterval(fetchMetrics, 1000);
            fetchMetrics();
        }

        async function fetchMetrics() {
            const data = await doAPI('/api/data', 'GET');
            if(data.error) return;

            if(!settingsLoaded) {
                document.getElementById("tpPctSens").value = data.config.takeProfitPct;
                document.getElementById("slPctSens").value = data.config.stopLossPct; 
                document.getElementById("mlLookbackSens").value = data.config.mlLookback || 50;
                document.getElementById("mlThresholdSens").value = data.config.mlThreshold || 60;
                document.getElementById("mlAverageTicksSens").value = data.config.mlAverageTicks || 5;
                document.getElementById("mlUseAverageSens").value = data.config.mlUseAverage ? "true" : "false";
                document.getElementById("flipOnlyInProfitSens").value = data.config.flipOnlyInProfit !== undefined ? data.config.flipOnlyInProfit.toString() : "true";
                document.getElementById("flipThresholdSens").value = data.config.flipThresholdPct || 0.5;
                document.getElementById("dcaRoiThresholdSens").value = data.config.dcaRoiThresholdPct || 1.0;
                document.getElementById("dcaMultiplierSens").value = data.config.dcaMultiplier || 2.0;
                document.getElementById("profitRoiThresholdSens").value = data.config.profitRoiThresholdPct || 2.0;
                document.getElementById("profitMultiplierSens").value = (data.walletBalance * 1) || 0;
                document.getElementById("baseContracts").value = (data.walletBalance * 1000) || 1;
                document.getElementById("maxContractsSens").value = (data.walletBalance * 2) || 100;
                document.getElementById("apiKey").value = data.apiKey || "";
                document.getElementById("liveTrade").checked = data.liveTradingEnabled;
                settingsLoaded = true;
            }

            document.getElementById("uptime").innerText = data.uptime + "s";
            document.getElementById("netPnl").innerText = "$" + data.metrics.totalNetPnl.toFixed(2);
            document.getElementById("netPnl").className = "metric-value " + (data.metrics.totalNetPnl >= 0 ? "text-green-600" : "text-red-600");
            document.getElementById("marginUsed").innerText = "$" + Number(data.walletBalance || 0).toFixed(2);

            const badge = document.getElementById("statusBadge");
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                badge.innerText = p.isPaper ? "Paper Active" : "Live Trading";
                document.getElementById("activeRoi").innerText = p.exchangeROI.toFixed(2) + "%";
                document.getElementById("activeRoi").className = "metric-value " + (p.exchangeROI >= 0 ? "text-green-600" : "text-red-600");
                document.getElementById("activeQty").innerText = p.contracts.toLocaleString();
            } else {
                badge.innerText = data.liveTradingEnabled ? "Idle (Live)" : "Idle (Paper)";
                document.getElementById("activeRoi").innerText = "N/A";
                document.getElementById("activeQty").innerText = "0";
            }

            if (data.mlSignal) {
                document.getElementById('mlValue').innerText = data.mlSignal.confidence.toFixed(1) + "%";
                const stat = document.getElementById('mlStatus');
                stat.innerText = data.mlSignal.type.toUpperCase();
                stat.className = "text-[9px] font-bold px-2 py-1 rounded uppercase " + (data.mlSignal.type === 'bull' ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700");
            }

            const hist = document.getElementById("tradeHistoryBody");
            if(data.metrics.trades && data.metrics.trades.length > 0) {
                hist.innerHTML = "";
                data.metrics.trades.slice(-4).reverse().forEach(t => {
                    hist.innerHTML += \`<div class="flex justify-between items-center text-[10px] border-b border-gray-50 pb-2">
                        <span class="font-bold \${t.side==='long'?'text-green-600':'text-red-600'}">\${t.side.toUpperCase()}</span>
                        <span class="text-gray-400">\${t.exitReason}</span>
                        <span class="font-bold \${t.netPnl>=0?'text-green-600':'text-red-600'}">$\${t.netPnl.toFixed(2)}</span>
                    </div>\`;
                });
            }
            if(data.binance && data.mlSignal) pushChartData(data.binance.mid, data.mlSignal.rawValue);
        }

        async function saveConfig() {
            const p = {
                tpPct: document.getElementById("tpPctSens").value, slPct: document.getElementById("slPctSens").value,
                mlLookbackSens: document.getElementById("mlLookbackSens").value, mlThresholdSens: document.getElementById("mlThresholdSens").value,
                mlAverageTicksSens: document.getElementById("mlAverageTicksSens").value, mlUseAverageSens: document.getElementById("mlUseAverageSens").value,
                flipOnlyInProfitSens: document.getElementById("flipOnlyInProfitSens").value, flipThresholdSens: document.getElementById("flipThresholdSens").value,
                dcaRoiThresholdSens: document.getElementById("dcaRoiThresholdSens").value, dcaMultiplierSens: document.getElementById("dcaMultiplierSens").value,
                profitRoiThresholdSens: document.getElementById("profitRoiThresholdSens").value
            };
            await doAPI('/api/user/config', 'POST', p);
            alert("Strategy Updated");
        }

        async function saveApiKeys() {
            const res = await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked });
            document.getElementById('key-msg').innerText = res.error ? res.error : "Connection Secured";
        }

        async function doLogin() {
            const res = await doAPI('/api/auth/login', 'POST', { email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value });
            if (res.error) document.getElementById('login-err').innerText = res.error; else { authToken = res.token; localStorage.setItem('bot_token', authToken); nav('dashboard'); }
        }

        async function doRegister() {
            const res = await doAPI('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value });
            if (res.error) document.getElementById('reg-err').innerText = res.error; else { authToken = res.token; localStorage.setItem('bot_token', authToken); nav('dashboard'); }
        }

        async function closeAll() { if(confirm("Close Position?")) await doAPI('/api/close-all', 'GET'); }

        async function runBacktest() {
            const res = await doAPI('/api/backtest', 'POST', { ticks: document.getElementById('btTicks').value, tpPct: document.getElementById('btTp').value, slPct: document.getElementById('btSl').value, mlLookback: document.getElementById('btMlLookback').value });
            document.getElementById('backtestResults').classList.remove('hidden');
            document.getElementById('btResWinrate').innerText = res.winRate + "%";
            document.getElementById('btResPnl').innerText = "$" + res.netPnl.toFixed(2);
            const container = document.getElementById('btTableBody'); container.innerHTML = "";
            res.trades.slice(-8).forEach(t => { container.innerHTML += \`<div>\${t.side.toUpperCase()} | \${t.netPnl.toFixed(2)}</div>\`; });
        }

        const ctx = document.getElementById("mlChart").getContext("2d");
        const mlChart = new Chart(ctx, {
            type: "line", data: { labels: [], datasets: [
                { data: [], borderColor: "#000", borderWidth: 1, pointRadius: 0, yAxisID: 'y' },
                { data: [], borderColor: "#3b82f6", borderWidth: 1, pointRadius: 0, yAxisID: 'y1', fill: true, backgroundColor: 'rgba(59,130,246,0.03)' }
            ]},
            options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { display: false }, y1: { display: false, min: 0, max: 1 } }, plugins: { legend: { display: false } } }
        });

        function pushChartData(p, m) {
            mlChart.data.labels.push(""); mlChart.data.datasets[0].data.push(p); mlChart.data.datasets[1].data.push(m);
            if(mlChart.data.labels.length > chartPoints) { mlChart.data.labels.shift(); mlChart.data.datasets[0].data.shift(); mlChart.data.datasets[1].data.shift(); }
            mlChart.update();
        }

        if(authToken) nav('dashboard'); else nav('home');
    </script>
</body>
</html>`);
});

app.listen(CUSTOM_PORT, async () => { console.log(`✅ Server running on port ${CUSTOM_PORT}`); await loadAllUsers(); startMasterStreams(); });
