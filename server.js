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
    try { await publicBinance.loadMarkets(); } catch (e) { return { error: `Market resolution error: ${e.message}` }; }
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
    if (!ticks || ticks.length === 0) return { error: `No historical tick data fetched for ${symbol}.` };
    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { mlLookback=50, mlThreshold=60.0, mlAverageTicks=5, mlUseAverage=false, flipOnlyInProfit=true, flipThresholdPct=0.5 } = config;
    const dcaRoiThresholdPct = config.dcaRoiThresholdPct || 1.0;
    const profitRoiThresholdPct = config.profitRoiThresholdPct !== undefined ? config.profitRoiThresholdPct : 2.0;
    const maxContracts = config.maxContracts !== undefined ? Number(config.maxContracts) : 100;
    let priceBuffer = [], mlRawBuffer = [];
    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;
        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) { priceBuffer.push(price); if (priceBuffer.length > 500) priceBuffer.shift(); }
        if (ticks.indexOf(tick) % 500 === 0) { await new Promise(resolve => setImmediate(resolve)); }
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
            activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: margin, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0, stepHistory: [] };
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
                    activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0, stepHistory: [] };
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                } else activePos = null;
            } else {
                const requiredRoiForDca = -(Math.abs(dcaRoiThresholdPct || 1.0));
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1, mult = Number(config.dcaMultiplier) || 2.0, step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                    activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                    activePos.size = Number(activePos.size) + addedSizeUsd; activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                    activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                    activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                } else if (math.currentGrossRoi >= profitRoiThresholdPct && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1, mult = Number(config.profitMultiplier) || 2.0, step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    if (Number(activePos.contracts) + contractsToAdd <= maxContracts) {
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
    if (activePos) {
        const lastTick = ticks[ticks.length - 1]; 
        const math = calculateTradeMath(activePos.side, activePos.entryPrice, lastTick.priceMid, activePos.size, FORCED_LEVERAGE, config.fees.taker);
        netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
        closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: lastTick.priceMid, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: "END_OF_TEST", time: lastTick.timestamp });
    }
    const totalTradesCount = closedTrades.length;
    const formatTime = (ms) => { if (ms < 1000) return "< 1s"; let s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24); if (d > 0) return `${d}d ${h%24}h`; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m ${s%60}s`; return `${s}s`; };
    return { ticksAnalyzed: ticks.length, totalTradesCount, wins, losses, winRate: totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(2) : 0, netPnl, depositNeeded: maxMarginUsed, avgDuration: formatTime(totalTradesCount > 0 ? totalTradeDurationMs / totalTradesCount : 0), totalSpan: formatTime(ticks[ticks.length-1].timestamp - ticks[0].timestamp), trades: closedTrades.slice(-200) };
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000SHIB')) { this.config.htxSymbol = 'SHIB/USDT:USDT'; this.config.binanceSymbol = '1000SHIB/USDT:USDT'; }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.lastEvalPrice = 0; this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) { this.liveTradingEnabled = user.liveTradingEnabled; const key = user.apiKey || "demo", secret = user.apiSecret || "demo"; this.htx = new ccxt.pro.htx({ apiKey: key, secret: secret, agent: keepAliveAgent, enableRateLimit: false, options: { defaultType: 'swap', defaultSubType: 'linear', defaultMarginMode: 'cross', positionMode: 'hedged' } }); }
    async initialize() { await this.metrics.init(); if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.connectExchange(); this.startExchangeROISync(); }
    async saveState() { await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }); const cacheEntry = tokenCache.get(this.userId); if(cacheEntry) cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null; }
    async connectExchange() {
        try { if(this.liveTradingEnabled) { await this.htx.loadMarkets(); try { await this.htx.setMarginMode('cross', this.config.htxSymbol); } catch(e){} try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){} const positions = await this.htx.fetchPositions([this.config.htxSymbol]); const openPos = positions.find(p => p.contracts > 0); if (openPos) { let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000; const sizeUsd = openPos.contracts * this.config.contractSize * entryP; this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }]; this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.saveState(); } else { this.activePositions = []; await this.saveState(); } } return { success: true }; } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }
    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback); if (!mlSig) { mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50); mlSignalCache.set(this.config.mlLookback, mlSig); }
        if (this.lastEvalPrice !== globalMarketData.binance.mid) { this.mlRawBuffer.push(mlSig.rawValue); if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift(); this.lastEvalPrice = globalMarketData.binance.mid; }
        let avgRaw = this.mlRawBuffer.length > 0 ? (this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length) : mlSig.rawValue;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue, avgRaw: avgRaw, avgConfidence: avgConf, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' };
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;
        try {
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type, activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;
            let signal = (activeType === 'bull' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'long' : (activeType === 'bear' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0]; if (signal && pos.side !== signal) {
                    let curPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!curPrice) curPrice = globalMarketData.binance.mid;
                    const pnlP = pos.side === 'long' ? ((curPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - curPrice) / pos.entryPrice) * 100;
                    if (this.config.flipOnlyInProfit !== false) { if (pnlP * FORCED_LEVERAGE >= (this.config.flipThresholdPct || 0.0)) { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); } } else { await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50); }
                }
            } else if (signal) await this.syncState(signal);
        } catch (e) {}
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0]; let curP = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!curP) curP = globalMarketData.binance.mid;
            const pnlP = pos.side === 'long' ? ((curP - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - curP) / pos.entryPrice) * 100;
            const instRoi = pnlP * FORCED_LEVERAGE;
            if (instRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
            else if (instRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
            else {
                const reqRoiDca = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0)), profRoi = this.config.profitRoiThresholdPct !== undefined ? this.config.profitRoiThresholdPct : 2.0;
                if (instRoi <= reqRoiDca && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(false);
                else if (instRoi >= profRoi && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(true);
            }
        } catch (e) {}
    }
    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return; this.isTrading = true;
        try {
            const pos = this.activePositions[0]; const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let mult = isProfitScale ? (Number(this.walletBalance) * 1) : this.config.dcaMultiplier; mult = Number(mult); if (isNaN(mult) || mult < 1.0) mult = 2.0;
            let baseC = Number(this.walletBalance) * 100; if (isNaN(baseC) || baseC < 1) baseC = 1;
            let step = Number(pos.dcaStep) || 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(mult, step))), 10);
            if (isProfitScale && (Number(pos.contracts) + contractsToAdd > (Number(this.walletBalance) * 2))) { pos.lastDcaTime = Date.now(); await this.saveState(); this.isTrading = false; return; }
            pos.lastDcaTime = Date.now(); await this.saveState();
            let realP = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid; if (!realP) realP = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                try { const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE }); await new Promise(r => setTimeout(r, 150)); const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); if (order && order.average) realP = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average; } catch(e) { return; }
            }
            // RECORD STEP
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: step + 1, type: isProfitScale ? 'SCALE' : 'DCA', price: realP, roiAtTrigger: pos.exchangeROI, added: contractsToAdd, time: Date.now() });
            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realP;
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realP) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd; pos.contracts = Number(pos.contracts) + contractsToAdd; pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE); pos.dcaStep = step + 1;
            this.metrics.updateMaxMargin(pos.marginUsed); await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }
    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return; this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled, orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            let baseC = Number(this.walletBalance) * 100; if (isNaN(baseC) || baseC < 1) baseC = 1;
            const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            let execP = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid; if (!execP) execP = globalMarketData.binance.mid;
            if (!isPaper) { const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE }); await new Promise(r => setTimeout(r, 150)); try { const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); if (oOrder && oOrder.average) execP = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average; } catch(e){} }
            const sizeUsd = contracts * (Number(this.config.contractSize) || 1000) * execP;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(execP), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: execP, roiAtTrigger: 0, added: contracts, time: Date.now() }] }];
            this.metrics.updateMaxMargin(sizeUsd / FORCED_LEVERAGE); await this.saveState();
        } catch (err) { this.activePositions = []; } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return; this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] }; const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let exitP = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!exitP) exitP = globalMarketData.binance.mid;
            if (!snapPos.isPaper && this.liveTradingEnabled) { const res = await this.htx.createMarketOrder(this.config.htxSymbol, closeSide, snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE }); this.activePositions = []; await new Promise(r => setTimeout(r, 150)); try { const cOrder = await this.htx.fetchOrder(res.id, this.config.htxSymbol); if (cOrder && cOrder.average) exitP = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average; } catch(e){} } else this.activePositions = [];
            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, exitP, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: exitP, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.lastCloseTime = Date.now(); await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading) { if (this.liveTradingEnabled) { try { const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0; } catch(e){} } return; }
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled && !pos.isPaper) { try { const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0; const positions = await this.htx.fetchPositions([this.config.htxSymbol]); const openPos = positions.find(p => p.contracts > 0); if (openPos) { let entryP = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000; pos.entryPrice = entryP; pos.exchangeROI = openPos.percentage || 0; pos.exchangePnl = openPos.unrealizedPnl || 0; return; } else { this.activePositions = []; await this.saveState(); return; } } catch(e) {} }
            let curP = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask; if (!curP) curP = globalMarketData.binance.mid;
            if (curP && pos.entryPrice > 0) { const pnlP = ((curP - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'long' ? 1 : -1); pos.exchangeROI = pnlP * FORCED_LEVERAGE; pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed; }
        }, 1000);
    }
    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

const activeWorkers = new Map();
async function startMasterStreams() {
    let marketsLoaded = false; while (!marketsLoaded) { try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } catch (e) { await new Promise(r => setTimeout(r, 5000)); } }
    try { const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean(); if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, mlPlot: doc.mlPlot || 0.5, timestamp: doc.timestamp })); } catch(e) {}
    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null;
        try { const seed = await publicBinance.fetchOHLCV(BASE_CONFIG.binanceSymbol, '1m', undefined, 100); if (seed) seed.forEach(c => { if (globalMarketData.tickBuffer.length === 0 || globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] !== c[4]) globalMarketData.tickBuffer.push(c[4]); }); } catch (e) {}
        while (true) {
            try {
                let mid = 0; try { const ticker = await Promise.race([publicBinance.watchTicker(BASE_CONFIG.binanceSymbol), new Promise((_, r) => setTimeout(() => r(new Error('T')), 3000))]); mid = (ticker.bid + ticker.ask) / 2; } catch(wsErr) { const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); mid = (ticker.bid + ticker.ask) / 2; await new Promise(r => setTimeout(r, 1000)); }
                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }
                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                if (mid !== (globalMarketData.tickBuffer.length > 0 ? globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] : null)) { globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift(); }
                mlSignalCache.clear(); const globalMl = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback); globalMarketData.mlSignal = globalMl;
                if (Date.now() - lastHistorySave > 2000) { if (mid !== lastSavedMid) { const doc = { priceMid: mid, mlPlot: globalMl.rawValue, timestamp: Date.now() }; memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); ChartDataModel.create(doc).catch(()=>{}); lastHistorySave = Date.now(); lastSavedMid = mid; } }
                for (const worker of activeWorkers.values()) { worker.checkExits().catch(()=>{}); worker.evaluateAIEntry().catch(()=>{}); }
                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() { try { const users = await UserModel.find({}); for(const u of users) { try { const worker = new UserTradeInstance(u); await worker.initialize(); activeWorkers.set(u._id.toString(), worker); if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() }); } catch(we) {} } } catch(e) {} }

const activeSessions = new Map();
setInterval(() => { const now = Date.now(); for (const [sid, data] of activeSessions.entries()) if (now - data.lastSeen > 15000) activeSessions.delete(sid); }, 5000);

const app = express(); app.use(express.json());
app.post('/api/analytics/track', (req, res) => { const { sessionId, page, isView } = req.body; if (!sessionId) return res.status(400).json({ error: 'M' }); activeSessions.set(sessionId, { page: page || 'U', lastSeen: Date.now() }); if (isView) { AnalyticsModel.findOne({ key: "global" }).then(doc => { if (!doc) doc = new AnalyticsModel({ key: "global" }); doc.views += 1; if (!doc.knownIds.includes(sessionId)) { doc.knownIds.push(sessionId); doc.uniques += 1; } doc.save(); }); } res.json({ status: 'ok' }); });
app.get('/api/analytics/stats', async (req, res) => { try { let doc = await AnalyticsModel.findOne({ key: "global" }); const pB = {}; for (const d of activeSessions.values()) pB[d.page] = (pB[d.page] || 0) + 1; res.json({ online: activeSessions.size, views: doc ? doc.views : 0, uniques: doc ? doc.uniques : 0, pages: pB }); } catch(e) { res.status(500).json({ error: 'F' }); } });
app.post('/api/backtest', async (req, res) => { const bC = { ...BASE_CONFIG, takeProfitPct: parseFloat(req.body.tpPct) || 10.0, stopLossPct: parseFloat(req.body.slPct) || -50.0, baseContracts: parseInt(req.body.baseContracts) || 1, mlLookback: parseInt(req.body.mlLookback) || 50, mlThreshold: parseFloat(req.body.mlThreshold) || 60.0, mlAverageTicks: parseInt(req.body.mlAverageTicks) || 5, mlUseAverage: (req.body.mlUseAverage === 'true'), flipOnlyInProfit: (req.body.flipOnlyInProfit === 'true'), flipThresholdPct: parseFloat(req.body.flipThresholdPct) || 0.5, dcaRoiThresholdPct: parseFloat(req.body.dcaRoiThresholdPct) || 1.0, dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0, profitRoiThresholdPct: parseFloat(req.body.profitRoiThresholdPct) || 2.0, profitMultiplier: parseFloat(req.body.profitMultiplier) || 2.0, maxContracts: parseInt(req.body.maxContracts) || 100 }; try { const results = await runBacktestSimulation(bC, parseInt(req.body.ticks) || 5000, BASE_CONFIG.binanceSymbol); res.json(results); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/auth/register', async (req, res) => { try { const { name, email, password } = req.body; if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'E' }); const salt = crypto.randomBytes(16).toString('hex'); const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() }); const worker = new UserTradeInstance(user); await worker.initialize(); activeWorkers.set(user._id.toString(), worker); tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token, user: { name: user.name, email: user.email } }); } catch(e) { res.status(500).json({ error: 'R' }); } });
app.post('/api/auth/login', async (req, res) => { try { const user = await UserModel.findOne({ email: req.body.email }); if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'I' }); user.token = generateToken(); await user.save(); tokenCache.set(user.token, { user, lastAccessed: Date.now() }); res.json({ token: user.token, user: { name: user.name, email: user.email } }); } catch(e) { res.status(500).json({ error: 'L' }); } });
app.get('/api/user/me', authMiddleware, (req, res) => res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled }));
app.post('/api/user/keys', authMiddleware, async (req, res) => { try { const { apiKey, apiSecret, liveTradingEnabled } = req.body; let worker = activeWorkers.get(req.user._id.toString()); if(worker) { if (Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && worker.activePositions[0].isPaper) worker.activePositions = []; if (!Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && !worker.activePositions[0].isPaper) worker.activePositions = []; worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled }); const conn = await worker.connectExchange(); if (liveTradingEnabled && !conn.success) { worker.liveTradingEnabled = false; return res.json({ error: conn.message }); } req.user.liveTradingEnabled = worker.liveTradingEnabled; } else req.user.liveTradingEnabled = Boolean(liveTradingEnabled); req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; await req.user.save(); res.json({ status: 'ok' }); } catch(e) { res.status(500).json({ error: 'F' }); } });
app.post('/api/user/config', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(!worker) return res.status(400).json({ error: 'W' }); const { tpPct, slPct, baseContracts, contractSize, mlLookbackSens, mlThresholdSens, mlAverageTicksSens, mlUseAverageSens, flipOnlyInProfitSens, flipThresholdSens, dcaRoiThresholdSens, dcaMultiplierSens, profitRoiThresholdSens, profitMultiplierSens, maxContractsSens } = req.body; const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) worker.config[k] = p; } }; pSet(tpPct, parseFloat, 'takeProfitPct'); pSet(slPct, parseFloat, 'stopLossPct'); pSet(baseContracts, parseInt, 'baseContracts'); pSet(contractSize, parseFloat, 'contractSize'); pSet(mlLookbackSens, parseInt, 'mlLookback'); pSet(mlThresholdSens, parseFloat, 'mlThreshold'); pSet(mlAverageTicksSens, parseInt, 'mlAverageTicks'); pSet(dcaRoiThresholdSens, parseFloat, 'dcaRoiThresholdPct'); pSet(dcaMultiplierSens, parseFloat, 'dcaMultiplier'); pSet(profitRoiThresholdSens, parseFloat, 'profitRoiThresholdPct'); pSet(profitMultiplierSens, parseFloat, 'profitMultiplier'); pSet(flipThresholdSens, parseFloat, 'flipThresholdPct'); pSet(maxContractsSens, parseInt, 'maxContracts'); if (mlUseAverageSens !== undefined) worker.config.mlUseAverage = (mlUseAverageSens === 'true'); if (flipOnlyInProfitSens !== undefined) worker.config.flipOnlyInProfit = (flipOnlyInProfitSens === 'true'); req.user.config = worker.config; req.user.markModified('config'); await req.user.save(); res.json({status: 'ok', config: worker.config}); });
app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => { try { const worker = activeWorkers.get(req.user._id.toString()); if(worker) { await TradeModel.deleteMany({ userId: req.user._id.toString() }); worker.metrics = new PerformanceMetrics(worker.userId); } res.json({status: 'ok'}); } catch(err) { res.status(500).json({error: 'F'}); } });
app.get('/api/data', authMiddleware, (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); res.json(worker ? worker.getExportData() : { error: "W" }); });
app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 
app.get('/api/close-all', authMiddleware, async (req, res) => { const worker = activeWorkers.get(req.user._id.toString()); if(worker) await worker.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{}); res.json({status: 'ok'}); });

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TradeBotPille | SHIB AI Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; text-align: center; }
        .btn-secondary { background: #ffffff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; text-align: center; }
        .view-section { display: none; animation: fade 0.3s ease; }
        @keyframes fade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col selection:bg-gray-200">
    <header class="bg-white/80 backdrop-blur-md shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2 cursor-pointer" onclick="nav('home')">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center shrink-0 shadow-md border border-gray-600 relative overflow-hidden">
                    <div class="absolute inset-0 m-[5px] grid grid-cols-2 grid-rows-2 gap-[2px]">
                        <div class="bg-white rounded-tl-[3px]"></div><div class="bg-white rounded-tr-[3px]"></div><div class="bg-black rounded-bl-[3px]"></div><div class="bg-[#E1AD01] rounded-br-[3px]"></div>
                    </div>
                    <span class="material-symbols-outlined text-[20px] font-bold text-white z-10 relative">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg ml-1">TradeBotPille</span>
            </div>
            <nav id="nav-public" class="flex items-center gap-4 text-sm font-medium text-gray-500">
                <button onclick="nav('backtest')" class="hover:text-black transition">Backtest</button>
                <button onclick="nav('login')" class="hover:text-black transition">Login</button>
                <button onclick="nav('register')" class="btn-primary py-1.5 px-4 rounded-md">Get Started</button>
            </nav>
            <nav id="nav-private" class="hidden items-center gap-6 text-sm font-medium">
                <button onclick="nav('dashboard')" class="text-gray-500 hover:text-black">Terminal</button>
                <button onclick="nav('steps')" class="text-gray-500 hover:text-black">Step History</button>
                <button onclick="nav('backtest')" class="text-gray-500 hover:text-black">Backtest</button>
                <button onclick="nav('settings')" class="text-gray-500 hover:text-black">Settings</button>
                <button onclick="logout()" class="text-red-500">Logout</button>
            </nav>
        </div>
    </header>

    <main class="flex-grow">
        <!-- HOME -->
        <section id="view-home" class="view-section active-view max-w-5xl mx-auto px-4 py-24 text-center">
            <h1 class="text-6xl font-extrabold mb-6">Algorithmic Math.<br><span class="text-gray-400">Zero Emotion.</span></h1>
            <p class="text-xl text-gray-500 mb-10">SHIB Logistic Regression Probability Engine.</p>
            <button onclick="nav('register')" class="btn-primary px-10 py-4">Launch Web Terminal</button>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section max-w-7xl mx-auto px-4 py-8">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                <div class="ui-card p-6 border">
                    <p class="text-xs font-bold text-gray-400 uppercase">Net PnL</p>
                    <p id="netPnl" class="text-3xl font-mono font-bold">$0.00</p>
                </div>
                <div class="ui-card p-6 border">
                    <p class="text-xs font-bold text-gray-400 uppercase">Live ROI</p>
                    <p id="activeRoi" class="text-3xl font-mono font-bold">0.00%</p>
                </div>
                <div class="ui-card p-6 border">
                    <p class="text-xs font-bold text-gray-400 uppercase">Active Qty</p>
                    <p id="activeQty" class="text-3xl font-mono font-bold">0</p>
                </div>
            </div>
            <div class="ui-card p-6 border mb-6 h-[400px]">
                <canvas id="mlChart"></canvas>
            </div>
            <div class="ui-card p-6 border">
                <h3 class="font-bold mb-4">Recent Closed Trades</h3>
                <table class="w-full text-left text-sm font-mono">
                    <thead><tr class="text-gray-400 border-b"><th>Side</th><th>Exit</th><th>ROI</th><th class="text-right">Net PnL</th></tr></thead>
                    <tbody id="tradeHistoryBody"></tbody>
                </table>
            </div>
        </section>

        <!-- STEP HISTORY PAGE (NEW) -->
        <section id="view-steps" class="view-section max-w-4xl mx-auto px-4 py-12">
            <div class="text-center mb-8">
                <h2 class="text-3xl font-bold">Position Step History</h2>
                <p class="text-gray-500 mt-2">Real-time breakdown of entries and DCA triggers for the current position.</p>
            </div>
            <div class="ui-card p-8 border">
                <div id="step-pos-header" class="mb-6 pb-4 border-b flex justify-between items-center">
                    <div>
                        <span id="step-pos-side" class="px-3 py-1 rounded-full text-xs font-bold uppercase mr-2">No Active Position</span>
                        <span id="step-pos-contracts" class="text-sm font-mono text-gray-600"></span>
                    </div>
                    <div id="step-pos-roi" class="text-lg font-mono font-bold text-gray-400">0.00%</div>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm">
                        <thead class="text-gray-400 uppercase text-[10px] tracking-wider border-b">
                            <tr>
                                <th class="pb-3">Step #</th>
                                <th class="pb-3">Action Type</th>
                                <th class="pb-3">Execution Price</th>
                                <th class="pb-3">Trigger ROI</th>
                                <th class="pb-3 text-right">Added Qty</th>
                            </tr>
                        </thead>
                        <tbody id="stepTableBody" class="font-mono text-xs">
                            <tr><td colspan="5" class="py-10 text-center text-gray-400 font-sans">No data available for current position.</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </section>

        <!-- BACKTEST -->
        <section id="view-backtest" class="view-section max-w-6xl mx-auto px-4 py-12">
            <h2 class="text-2xl font-bold mb-6">Strategy Backtester</h2>
            <div class="grid md:grid-cols-4 gap-6">
                <div class="ui-card p-6 border space-y-4">
                    <input type="number" id="btTicks" class="input-minimal" value="5000" placeholder="Minutes">
                    <button onclick="runBacktest()" class="btn-primary w-full">Run Test</button>
                </div>
                <div class="md:col-span-3 ui-card p-6 border">
                    <div id="btResWinrate" class="text-2xl font-bold">Result: -</div>
                    <div id="btResPnl" class="font-mono"></div>
                </div>
            </div>
        </section>

        <!-- LOGIN / REGISTER -->
        <section id="view-login" class="view-section max-w-md mx-auto px-4 py-20">
            <div class="ui-card p-8 border">
                <h2 class="text-2xl font-bold mb-6 text-center">Login</h2>
                <input type="email" id="login-email" class="input-minimal mb-4" placeholder="Email">
                <input type="password" id="login-pass" class="input-minimal mb-6" placeholder="Password">
                <button onclick="doLogin()" class="btn-primary w-full">Sign In</button>
                <p id="login-err" class="text-red-500 text-xs mt-2"></p>
            </div>
        </section>
        <section id="view-register" class="view-section max-w-md mx-auto px-4 py-20">
            <div class="ui-card p-8 border">
                <h2 class="text-2xl font-bold mb-6 text-center">Register</h2>
                <input type="text" id="reg-name" class="input-minimal mb-4" placeholder="Name">
                <input type="email" id="reg-email" class="input-minimal mb-4" placeholder="Email">
                <input type="password" id="reg-pass" class="input-minimal mb-6" placeholder="Password">
                <button onclick="doRegister()" class="btn-primary w-full">Create Account</button>
                <p id="reg-err" class="text-red-500 text-xs mt-2"></p>
            </div>
        </section>

        <!-- SETTINGS -->
        <section id="view-settings" class="view-section max-w-lg mx-auto px-4 py-20">
            <div class="ui-card p-8 border">
                <h2 class="text-2xl font-bold mb-6">Exchange Keys</h2>
                <input type="password" id="apiKey" class="input-minimal mb-4" placeholder="API Key">
                <input type="password" id="apiSecret" class="input-minimal mb-4" placeholder="API Secret">
                <div class="flex items-center gap-2 mb-6">
                    <input type="checkbox" id="liveTrade"> <label>Enable Live Trading</label>
                </div>
                <button onclick="saveApiKeys()" class="btn-primary w-full">Save Settings</button>
                <p id="key-msg" class="text-sm mt-2 text-center"></p>
            </div>
        </section>
    </main>

    <script>
        let authToken = localStorage.getItem('bot_token');
        let sessionTrackId = localStorage.getItem('rdca_visitor_id') || Math.random().toString(36).substring(2, 15);
        localStorage.setItem('rdca_visitor_id', sessionTrackId);

        function nav(id) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.getElementById('view-' + id).classList.add('active-view');
            if(id === 'dashboard' && authToken) initDashboard();
        }

        function logout() { localStorage.removeItem('bot_token'); authToken = null; location.reload(); }

        async function doAPI(endpoint, method, body) {
            const h = { 'Content-Type': 'application/json' };
            if (authToken) h['Authorization'] = authToken;
            const res = await fetch(endpoint, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
            return res.json();
        }

        async function doLogin() {
            const res = await doAPI('/api/auth/login', 'POST', { email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value });
            if (res.token) { authToken = res.token; localStorage.setItem('bot_token', authToken); nav('dashboard'); }
            else document.getElementById('login-err').innerText = res.error;
        }

        async function doRegister() {
            const res = await doAPI('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value });
            if (res.token) { authToken = res.token; localStorage.setItem('bot_token', authToken); nav('dashboard'); }
            else document.getElementById('reg-err').innerText = res.error;
        }

        async function saveApiKeys() {
            const res = await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked });
            document.getElementById('key-msg').innerText = res.error || "Saved.";
        }

        const mlChart = new Chart(document.getElementById("mlChart").getContext("2d"), {
            type: "line", data: { labels: [], datasets: [{ label: "Price", data: [], borderColor: "#000", pointRadius: 0 }, { label: "Signal", data: [], borderColor: "#3b82f6", pointRadius: 0, yAxisID: 'y1' }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { y1: { position: 'right', min: 0, max: 1 } } }
        });

        async function initDashboard() {
            document.getElementById('nav-public').classList.add('hidden');
            document.getElementById('nav-private').classList.remove('hidden');
            setInterval(updateData, 1000);
        }

        async function updateData() {
            const data = await doAPI('/api/data', 'GET'); if (data.error) return;
            document.getElementById('netPnl').innerText = "$" + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById('netPnl').style.color = data.metrics.totalNetPnl >= 0 ? '#16a34a' : '#dc2626';
            
            if (data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('activeRoi').innerText = (p.exchangeROI || 0).toFixed(2) + "%";
                document.getElementById('activeQty').innerText = p.contracts.toLocaleString();
                
                // POPULATE STEPS PAGE
                if (document.getElementById('view-steps').classList.contains('active-view')) {
                    document.getElementById('step-pos-side').innerText = p.side.toUpperCase();
                    document.getElementById('step-pos-side').className = "px-3 py-1 rounded-full text-xs font-bold uppercase mr-2 " + (p.side === 'long' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700');
                    document.getElementById('step-pos-contracts').innerText = p.contracts.toLocaleString() + " Contracts";
                    document.getElementById('step-pos-roi').innerText = (p.exchangeROI || 0).toFixed(2) + "%";
                    document.getElementById('step-pos-roi').style.color = p.exchangeROI >= 0 ? '#16a34a' : '#dc2626';

                    const tbody = document.getElementById('stepTableBody');
                    tbody.innerHTML = "";
                    if (p.stepHistory && p.stepHistory.length > 0) {
                        p.stepHistory.forEach(s => {
                            tbody.innerHTML += '<tr class="border-b border-gray-50">' +
                                '<td class="py-3">#' + s.step + '</td>' +
                                '<td class="py-3 font-bold">' + s.type + '</td>' +
                                '<td class="py-3">$' + Number(s.price).toFixed(8) + '</td>' +
                                '<td class="py-3 font-bold ' + (s.roiAtTrigger >= 0 ? 'text-green-600' : 'text-red-600') + '">' + (s.roiAtTrigger || 0).toFixed(2) + '%</td>' +
                                '<td class="py-3 text-right">+' + s.added + '</td></tr>';
                        });
                    }
                }
            } else {
                document.getElementById('activeRoi').innerText = "0.00%";
                document.getElementById('activeQty').innerText = "0";
                if (document.getElementById('view-steps').classList.contains('active-view')) {
                    document.getElementById('stepTableBody').innerHTML = '<tr><td colspan="5" class="py-10 text-center text-gray-400">No active position.</td></tr>';
                }
            }

            if (data.binance && data.mlSignal) {
                mlChart.data.labels.push("");
                mlChart.data.datasets[0].data.push(data.binance.mid);
                mlChart.data.datasets[1].data.push(data.mlSignal.rawValue);
                if (mlChart.data.labels.length > 100) { mlChart.data.labels.shift(); mlChart.data.datasets[0].data.shift(); mlChart.data.datasets[1].data.shift(); }
                mlChart.update();
            }
        }

        if(authToken) { initDashboard(); nav('dashboard'); }
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => { console.log(`✅ Server running on port ${CUSTOM_PORT}`); await loadAllUsers(); startMasterStreams(); });
