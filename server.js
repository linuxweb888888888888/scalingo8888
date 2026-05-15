const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
// 🚨 SECURITY WARNING: Do not hardcode your DB password. Use .env instead!
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

// SHIB CONFIGURATION (FORCED 20x LEVERAGE)
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

// ==================== BACKTEST SIMULATION ENGINE ====================
async function runBacktestSimulation(config, tickCount, symbol) {
    try {
        await publicBinance.loadMarkets();
    } catch (e) { return { error: `Market resolution error: ${e.message}` }; }

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
    } catch (e) {
        if (allCandles.length === 0) allCandles = await publicBinance.fetchOHLCV(symbol, '1m', undefined, Math.min(tickCount, 1000)).catch(()=>[]) || [];
    }

    const ticks = allCandles.map(c => ({ timestamp: c[0], priceMid: c[4] }));
    if (!ticks || ticks.length === 0) return { error: `No historical tick data fetched for ${symbol}.` };

    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { mlLookback=50, mlThreshold=60.0, mlAverageTicks=5, mlUseAverage=false, flipOnlyInProfit=true, flipThresholdPct=0.5 } = config;
    const dcaRoiThresholdPct = config.dcaRoiThresholdPct || 1.0;
    const profitRoiThresholdPct = config.profitRoiThresholdPct !== undefined ? config.profitRoiThresholdPct : 2.0;
    const maxContracts = config.maxContracts !== undefined ? Number(config.maxContracts) : 100;
    const maxDcaStepsBeforeReverse = config.maxDcaStepsBeforeReverse !== undefined ? Number(config.maxDcaStepsBeforeReverse) : 10;
    
    let priceBuffer = [], mlRawBuffer = [];
    const totalSpanMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;

    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;

        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) {
            priceBuffer.push(price); if (priceBuffer.length > 500) priceBuffer.shift();
        }
        
        if (ticks.indexOf(tick) % 500 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }

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
            
            if (signal && activePos.side !== signal) {
                if (flipOnlyInProfit) {
                    if (math.currentGrossRoi >= flipThresholdPct) forceExitReason = "ML_FLIP";
                } else forceExitReason = "ML_FLIP";
            }
            
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
                const requiredRoiForDca = -(Math.abs(dcaRoiThresholdPct || 1.0));
                
                // BACKTEST: Loss DCA
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    
                    // REVERSE DIRECTION IF MAX STEPS REACHED
                    if (maxDcaStepsBeforeReverse > 0 && activePos.dcaStep >= maxDcaStepsBeforeReverse) {
                        netPnl += math.netPnlUsd; losses++;
                        totalTradeDurationMs += (tickTime - activePos.entryTime);
                        closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: price, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: "MAX_DCA_REVERSE", time: tick.timestamp });
                        
                        const reverseSignal = activePos.side === 'long' ? 'short' : 'long';
                        let bC = parseInt(config.baseContracts) || 1;
                        const sizeUsd = bC * config.contractSize * price; 
                        activePos = { side: reverseSignal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
                    } else {
                        let bC = Number(config.baseContracts) || 1;
                        let mult = Number(config.dcaMultiplier) || 2.0;
                        let step = Number(activePos.dcaStep) || 0;
                        let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                        const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                        activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                        activePos.size = Number(activePos.size) + addedSizeUsd; 
                        activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                        activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                        activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                    }
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                    
                } // BACKTEST: Profit Scaling
                else if (math.currentGrossRoi >= profitRoiThresholdPct && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1;
                    let mult = Number(config.profitMultiplier) || 2.0;
                    let step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    if (Number(activePos.contracts) + contractsToAdd <= maxContracts) {
                        const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                        activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                        activePos.size = Number(activePos.size) + addedSizeUsd; 
                        activePos.contracts = Number(activePos.contracts) + contractsToAdd;
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
        totalTradeDurationMs += (lastTick.timestamp - activePos.entryTime);
        closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: lastTick.priceMid, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: "END_OF_TEST", time: lastTick.timestamp });
    }

    const totalTradesCount = closedTrades.length;
    const formatTime = (ms) => {
        if (ms < 1000) return "< 1s";
        let s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h%24}h`; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m ${s%60}s`; return `${s}s`;
    };

    return { 
        ticksAnalyzed: ticks.length, totalTradesCount, wins, losses, 
        winRate: totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(2) : 0, 
        netPnl, depositNeeded: maxMarginUsed, 
        avgDuration: formatTime(totalTradesCount > 0 ? totalTradeDurationMs / totalTradesCount : 0), 
        totalSpan: formatTime(totalSpanMs), trades: closedTrades.slice(-200) 
    };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) {
            this.config.htxSymbol = 'SHIB/USDT:USDT';
            this.config.binanceSymbol = '1000SHIB/USDT:USDT';
        }
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
        this.htx = new ccxt.pro.htx({ 
            apiKey: key, 
            secret: secret, 
            agent: keepAliveAgent, 
            enableRateLimit: false, 
            options: { 
                defaultType: 'swap', 
                defaultSubType: 'linear', 
                defaultMarginMode: 'cross', 
                positionMode: 'hedged' 
            } 
        });
    }
    
    async initialize() {
        await this.metrics.init(); 
        if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed);
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne(
            { _id: this.userId },
            { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }
        );
        const cacheEntry = tokenCache.get(this.userId);
        if(cacheEntry) cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null; 
    }

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
                } else {
                    this.activePositions = []; await this.saveState();
                }
            }
            return { success: true };
        } catch (error) { 
            console.log(`[Worker ${this.userId}] Exchange Init Error:`, error.message); 
            this.liveTradingEnabled = false; return { success: false, message: error.message }; 
        }
    }

    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback);
        if (!mlSig) {
            mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
            mlSignalCache.set(this.config.mlLookback, mlSig);
        }
        
        if (this.lastEvalPrice !== globalMarketData.binance.mid) {
            this.mlRawBuffer.push(mlSig.rawValue);
            if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift();
            this.lastEvalPrice = globalMarketData.binance.mid;
        }
        
        let avgRaw = this.mlRawBuffer.length > 0 ? (this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length) : mlSig.rawValue;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        
        this.currentMl = { 
            confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue,
            avgRaw: avgRaw, avgConfidence: avgConf, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' 
        };

        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        try {
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
            let activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;

            let signal = (activeType === 'bull' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'long' : 
                         (activeType === 'bear' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                    let instantRoi = pnlPercent * FORCED_LEVERAGE;

                    if (this.config.flipOnlyInProfit !== false) {
                        const threshold = this.config.flipThresholdPct || 0.0;
                        if (instantRoi >= threshold) {
                            await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50);
                        }
                    } else {
                        await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50);
                    }
                }
            } else {
                if (signal) await this.syncState(signal);
            }
        } catch (e) {
            console.error(`🚨 [Eval Error]:`, e.message);
        }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        
        try {
            const pos = this.activePositions[0];
            let effectiveRoi = 0;
            if (this.liveTradingEnabled && !pos.isPaper) {
                effectiveRoi = pos.exchangeROI || 0;
            } else {
                let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                effectiveRoi = pnlPercent * FORCED_LEVERAGE;
            }
            
            if (effectiveRoi >= this.config.takeProfitPct) {
                await this.forceClosePosition("TAKE_PROFIT");
            } else if (effectiveRoi <= this.config.stopLossPct) {
                await this.forceClosePosition("STOP_LOSS");
            } else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0));
                const profitScaleThreshold = this.config.profitRoiThresholdPct !== undefined ? this.config.profitRoiThresholdPct : 2.0;
                
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    const maxSteps = parseInt(this.config.maxDcaStepsBeforeReverse) || 0;
                    if (maxSteps > 0 && pos.dcaStep >= maxSteps) {
                        const reverseSide = pos.side === 'long' ? 'short' : 'long';
                        await this.forceClosePosition("MAX_DCA_REVERSE");
                        setTimeout(() => this.syncState(reverseSide), 200);
                    } else {
                        await this.addDcaPosition(false);
                    }
                } 
                else if (effectiveRoi >= profitScaleThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    await this.addDcaPosition(true);
                }
            }
        } catch (e) {
             console.error(`🚨 [Exit Check Error]:`, e.message);
        }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            
            let multiplier = isProfitScale ? (Number(this.walletBalance) * 1) : this.config.dcaMultiplier;
            multiplier = Number(multiplier);
            if (isNaN(multiplier) || multiplier < 1.0) multiplier = 2.0;
            
            let baseC = Number(this.walletBalance) * 10;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            
            let step = Number(pos.dcaStep);
            if (isNaN(step)) step = 0;

            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step))), 10);
            
            if (isProfitScale) {
                const maxC = (Number(this.walletBalance) * 2);
                if (Number(pos.contracts) + contractsToAdd > maxC) {
                    pos.lastDcaTime = Date.now();
                    await this.saveState();
                    this.isTrading = false;
                    return; 
                }
            }

            pos.lastDcaTime = Date.now();
            await this.saveState();
            
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled) {
                console.log(`[User ${this.userId}] Requesting Scale: ${contractsToAdd} contracts on HTX`);
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) {
                        realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
                    }
                } catch(e) {
                    console.error(`[User ${this.userId}] HTX API Error, cancelling local state update to prevent desync:`, e.message);
                    return; 
                }
            }

            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({
                step: step + 1,
                type: isProfitScale ? 'SCALE' : 'DCA',
                price: realExecPrice,
                roi: pos.exchangeROI || 0,
                time: Date.now()
            });

            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realExecPrice;
            
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realExecPrice) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd;
            pos.contracts = Number(pos.contracts) + contractsToAdd; 
            pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
            pos.dcaStep = step + 1;
            
            this.metrics.updateMaxMargin(pos.marginUsed);
            await this.saveState();
            console.log(`[User ${this.userId}] ${pos.isPaper ? 'Paper' : 'LIVE'} ${isProfitScale ? 'PROFIT SCALE' : 'LOSS DCA'} Executed (Step ${pos.dcaStep}). Added ${contractsToAdd} to ${pos.side.toUpperCase()}`);
        } catch (err) {
            console.error(`🚨 [Scale Error - User ${this.userId}]:`, err.message);
        } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            
            let baseC = Number(this.walletBalance) * 10;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!executionPrice) executionPrice = globalMarketData.binance.mid;

            if (!isPaper) {
                const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                await new Promise(r => setTimeout(r, 150)); 
                try { 
                    const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); 
                    if (oOrder && oOrder.average) {
                        executionPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average;
                    }
                } catch(e){}
            }

            const sizeUsd = contracts * (Number(this.config.contractSize) || 1000) * executionPrice;
            const marginUsed = sizeUsd / FORCED_LEVERAGE;
            
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: Number(marginUsed), entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] }];
            
            this.metrics.updateMaxMargin(marginUsed); 
            await this.saveState();
            console.log(`[User ${this.userId}] ${isPaper?'Paper':'LIVE'} OPEN: ${targetSide.toUpperCase()} at $${executionPrice}`);
        } catch (err) { 
            console.error(`🚨 [Open Error - User ${this.userId}]:`, err.message); this.activePositions = []; 
        } finally { this.isTrading = false; }
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
                try { 
                    const cOrder = await this.htx.fetchOrder(closeRes.id, this.config.htxSymbol); 
                    if (cOrder && cOrder.average) {
                        realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average;
                    }
                } catch(e){}
            } else {
                this.activePositions = [];
            }

            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ 
                side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, 
                marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason 
            });
            
            this.lastCloseTime = Date.now(); await this.saveState();
            console.log(`[User ${this.userId}] ${snapPos.isPaper?'Paper':'LIVE'} CLOSED: ${reason}`);
        } catch (err) {
            console.error(`🚨 [Close Error - User ${this.userId}]:`, err.message);
        } finally { this.isTrading = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading) {
                if (this.liveTradingEnabled) {
                    try {
                        const bal = await this.htx.fetchBalance({ type: 'swap' });
                        this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    } catch(e){}
                }
                return;
            }
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled && !pos.isPaper) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const openPos = positions.find(p => p.contracts > 0);
                    
                    if (openPos) {
                        let entryP = openPos.entryPrice;
                        if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                        pos.entryPrice = entryP;
                        pos.exchangeROI = openPos.percentage || 0; 
                        pos.exchangePnl = openPos.unrealizedPnl || 0;
                        return;
                    } else {
                        this.activePositions = [];
                        await this.saveState();
                        return;
                    }
                } catch(e) {}
            }
            
            let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!currentPrice) currentPrice = globalMarketData.binance.mid;
            
            if (currentPrice && pos.entryPrice > 0) { 
                const sideMult = pos.side === 'long' ? 1 : -1;
                const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult;
                pos.exchangeROI = pnlPercent * FORCED_LEVERAGE;
                pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed; 
            }
        }, 1000);
    }

    getExportData() { 
        return { 
            config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance,
            walletBalance: this.walletBalance
        }; 
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    let marketsLoaded = false; 
    while (!marketsLoaded) { 
        try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } 
        catch (e) { await new Promise(r => setTimeout(r, 5000)); } 
    }

    try {
        const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean();
        if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, mlPlot: doc.mlPlot || 0.5, timestamp: doc.timestamp }));
    } catch(e) {}

    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null, lastSavedMlPlot = null;
        
        try {
            const seedData = await publicBinance.fetchOHLCV(BASE_CONFIG.binanceSymbol, '1m', undefined, 100);
            if (seedData && seedData.length > 0) {
                seedData.forEach(c => {
                    const seedMid = c[4];
                    if (globalMarketData.tickBuffer.length === 0 || globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] !== seedMid) {
                        globalMarketData.tickBuffer.push(seedMid);
                    }
                });
            }
        } catch (e) { console.log("Seeding failed, starting empty."); }

        while (true) {
            try {
                let mid = 0;
                try {
                    const ticker = await Promise.race([
                        publicBinance.watchTicker(BASE_CONFIG.binanceSymbol),
                        new Promise((_, r) => setTimeout(() => r(new Error('WS_TIMEOUT')), 3000))
                    ]);
                    let bid = ticker.bid !== undefined ? ticker.bid : ticker.last;
                    let ask = ticker.ask !== undefined ? ticker.ask : ticker.last;
                    mid = (bid + ask) / 2;
                } catch(wsErr) {
                    const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); 
                    let bid = ticker.bid !== undefined ? ticker.bid : ticker.last;
                    let ask = ticker.ask !== undefined ? ticker.ask : ticker.last;
                    mid = (bid + ask) / 2;
                    await new Promise(r => setTimeout(r, 1000)); 
                }

                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }

                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                
                const lastTick = globalMarketData.tickBuffer.length > 0 ? globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] : null;
                if (mid !== lastTick) {
                    globalMarketData.tickBuffer.push(mid);
                    if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                }

                mlSignalCache.clear();
                const globalMl = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = globalMl;
                mlSignalCache.set(BASE_CONFIG.mlLookback, globalMl); 

                if (Date.now() - lastHistorySave > 2000) { 
                    if (mid !== lastSavedMid || globalMl.rawValue !== lastSavedMlPlot) {
                        const doc = { priceMid: mid, mlPlot: globalMl.rawValue, timestamp: Date.now() };
                        memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                        ChartDataModel.create(doc).catch(()=>{}); 
                        lastHistorySave = Date.now(); lastSavedMid = mid; lastSavedMlPlot = globalMl.rawValue;
                    }
                }

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateAIEntry().catch(()=>{}); 
                }

                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { 
                await new Promise(r => setTimeout(r, 2000)); 
            }
        }
    })();
}

async function loadAllUsers() {
    try {
        const users = await UserModel.find({});
        for(const u of users) {
            try {
                const worker = new UserTradeInstance(u);
                await worker.initialize();
                activeWorkers.set(u._id.toString(), worker);
                if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
            } catch(we) { console.error(`Worker error for ${u.email}:`, we.message); }
        }
    } catch(e) {}
}

const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 15000) activeSessions.delete(sid);
    }
}, 5000);

const app = express(); app.use(express.json());

app.post('/api/analytics/track', async (req, res) => {
    const { sessionId, page, isView } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing session' });
    activeSessions.set(sessionId, { page: page || 'unknown', lastSeen: Date.now() });

    if (isView) {
        try {
            let doc = await AnalyticsModel.findOne({ key: "global" });
            if (!doc) doc = await AnalyticsModel.create({ key: "global" });
            doc.views += 1;
            if (!doc.knownIds.includes(sessionId)) { doc.knownIds.push(sessionId); doc.uniques += 1; }
            await doc.save();
        } catch(e) {}
    }
    res.json({ status: 'ok' });
});

app.get('/api/analytics/stats', async (req, res) => {
    try {
        let doc = await AnalyticsModel.findOne({ key: "global" });
        const pageBreakdown = {};
        for (const data of activeSessions.values()) pageBreakdown[data.page] = (pageBreakdown[data.page] || 0) + 1;
        res.json({ online: activeSessions.size, views: doc ? doc.views : 0, uniques: doc ? doc.uniques : 0, pages: pageBreakdown });
    } catch(e) { res.status(500).json({ error: 'Failed to load stats' }); }
});

app.post('/api/backtest', async (req, res) => {
    const bConfig = { ...BASE_CONFIG,
        takeProfitPct: parseFloat(req.body.tpPct) || 10.0, stopLossPct: parseFloat(req.body.slPct) || -50.0,
        baseContracts: parseInt(req.body.baseContracts) || 1, mlLookback: parseInt(req.body.mlLookback) || 50,
        mlThreshold: parseFloat(req.body.mlThreshold) || 60.0, mlAverageTicks: parseInt(req.body.mlAverageTicks) || 5,
        mlUseAverage: (req.body.mlUseAverage === 'true'), flipOnlyInProfit: (req.body.flipOnlyInProfit === 'true'),
        flipThresholdPct: parseFloat(req.body.flipThresholdPct) || 0.5,
        dcaRoiThresholdPct: parseFloat(req.body.dcaRoiThresholdPct) || 1.0, 
        dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0,
        profitRoiThresholdPct: parseFloat(req.body.profitRoiThresholdPct) || 2.0,
        profitMultiplier: parseFloat(req.body.profitMultiplier) || 2.0,
        maxContracts: parseInt(req.body.maxContracts) || 100,
        maxDcaStepsBeforeReverse: parseInt(req.body.maxDcaStepsBeforeReverse) || 10
    };
    try {
        const results = await runBacktestSimulation(bConfig, parseInt(req.body.ticks) || 5000, BASE_CONFIG.binanceSymbol);
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'Email already exists' });
        
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        
        const worker = new UserTradeInstance(user);
        await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await UserModel.findOne({ email: req.body.email });
        if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid credentials' });

        user.token = generateToken(); await user.save();
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/user/me', authMiddleware, (req, res) => {
    res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled });
});

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    try {
        const { apiKey, apiSecret, liveTradingEnabled } = req.body;
        let worker = activeWorkers.get(req.user._id.toString());
        if(worker) {
            if (Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && worker.activePositions[0].isPaper) {
                worker.activePositions = [];
            }
            if (!Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && !worker.activePositions[0].isPaper) {
                worker.activePositions = [];
            }
            worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled });
            const connectionResult = await worker.connectExchange();
            if (liveTradingEnabled && !connectionResult.success) {
                worker.liveTradingEnabled = false; 
                return res.json({ error: 'Exchange Error: ' + connectionResult.message });
            }
            req.user.liveTradingEnabled = worker.liveTradingEnabled;
        } else {
            req.user.liveTradingEnabled = Boolean(liveTradingEnabled);
        }
        req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; 
        await req.user.save();
        res.json({ status: 'ok' });
    } catch(e) { res.status(500).json({ error: 'Failed to update settings' }); }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(!worker) return res.status(400).json({ error: 'Worker not active' });
    
    const { tpPct, slPct, baseContracts, contractSize, mlLookbackSens, mlThresholdSens, mlAverageTicksSens, mlUseAverageSens, flipOnlyInProfitSens, flipThresholdSens, dcaRoiThresholdSens, dcaMultiplierSens, profitRoiThresholdSens, profitMultiplierSens, maxContractsSens, maxDcaStepsBeforeReverseSens } = req.body;
    const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) worker.config[k] = p; } };

    pSet(tpPct, parseFloat, 'takeProfitPct'); pSet(slPct, parseFloat, 'stopLossPct');
    pSet(baseContracts, parseInt, 'baseContracts'); pSet(contractSize, parseFloat, 'contractSize'); 
    pSet(mlLookbackSens, parseInt, 'mlLookback'); pSet(mlThresholdSens, parseFloat, 'mlThreshold');
    pSet(mlAverageTicksSens, parseInt, 'mlAverageTicks'); 
    pSet(dcaRoiThresholdSens, parseFloat, 'dcaRoiThresholdPct'); 
    pSet(dcaMultiplierSens, parseFloat, 'dcaMultiplier'); 
    pSet(profitRoiThresholdSens, parseFloat, 'profitRoiThresholdPct');
    pSet(profitMultiplierSens, parseFloat, 'profitMultiplier');
    pSet(flipThresholdSens, parseFloat, 'flipThresholdPct');
    pSet(maxContractsSens, parseInt, 'maxContracts'); 
    pSet(maxDcaStepsBeforeReverseSens, parseInt, 'maxDcaStepsBeforeReverse'); 
    
    if (mlUseAverageSens !== undefined) worker.config.mlUseAverage = (mlUseAverageSens === 'true');
    if (flipOnlyInProfitSens !== undefined) worker.config.flipOnlyInProfit = (flipOnlyInProfitSens === 'true');

    req.user.config = worker.config; req.user.markModified('config'); await req.user.save();
    res.json({status: 'ok', config: worker.config});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    try {
        const worker = activeWorkers.get(req.user._id.toString());
        if(worker) { await TradeModel.deleteMany({ userId: req.user._id.toString() }); worker.metrics = new PerformanceMetrics(worker.userId); }
        res.json({status: 'ok'});
    } catch(err) { res.status(500).json({error: 'Failed to reset metrics'}); }
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Worker not found" });
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 
app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) await worker.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{}); 
    res.json({status: 'ok'}); 
});

// ==================== FRONTEND UI ====================
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
        .ui-card-hover { transition: transform 0.2s, box-shadow: 0.2s; }
        .ui-card-hover:hover { transform: translateY(-3px); box-shadow: 0 10px 30px -5px rgba(0,0,0,0.08); }
        
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; transition: all 0.2s; background: #fafafa; }
        .input-minimal:focus { border-color: #000000; background: #ffffff; box-shadow: 0 0 0 2px rgba(0,0,0,0.05); }
        
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.2s; text-align: center; }
        .btn-primary:hover { background: #374151; }
        
        .btn-secondary { background: #ffffff; color: #374151; border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s; text-align: center; }
        .btn-secondary:hover { background: #f9fafb; border-color: #9ca3af; }
        
        .view-section { display: none; animation: fade 0.3s ease; }
        @keyframes fade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        .active-view { display: block; }
        
        #netPnl, #activeRoi, #marginUsed, #activeQty { transition: color 0.3s ease; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col selection:bg-gray-200">

    <header class="bg-white/80 backdrop-blur-md shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2 cursor-pointer" onclick="nav('home')">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center shrink-0 shadow-md border border-gray-600 relative overflow-hidden">
                    <div class="absolute inset-0 m-[5px] grid grid-cols-2 grid-rows-2 gap-[2px]">
                        <div class="bg-white rounded-tl-[3px]"></div> 
                        <div class="bg-white rounded-tr-[3px]"></div> 
                        <div class="bg-black rounded-bl-[3px]"></div> 
                        <div class="bg-[#E1AD01] rounded-br-[3px]"></div> 
                    </div>
                    <span class="material-symbols-outlined text-[20px] font-bold text-white z-10 relative drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg ml-1">TradeBotPille</span><div>taking it to the next level</div>
            </div>
            
            <nav id="nav-public" class="flex items-center gap-4 text-sm font-medium text-gray-500">
                <button onclick="nav('backtest')" class="hover:text-black transition flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">science</span> Backtest</button>
                <button onclick="nav('analytics')" class="hover:text-black transition flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">monitoring</span> Stats</button>
                <div class="w-px h-4 bg-gray-200 mx-1"></div>
                <button onclick="nav('login')" class="hover:text-black transition">Login</button>
                <button onclick="nav('register')" class="btn-primary py-1.5 px-4 rounded-md">Get Started</button>
            </nav>
            
            <nav id="nav-private" class="hidden items-center gap-6 text-sm font-medium">
                <span id="nav-user-name" class="text-gray-500 hidden sm:block"></span>
                <button onclick="nav('backtest')" class="text-gray-500 hover:text-black transition flex items-center gap-1"><span class="material-symbols-outlined text-[18px]">science</span></button>
                <button onclick="nav('analytics')" class="text-gray-500 hover:text-black transition flex items-center gap-1"><span class="material-symbols-outlined text-[18px]">monitoring</span></button>
                <button onclick="nav('dashboard')" class="hover:text-black transition">Dashboard</button>
                <button onclick="nav('step-history')" class="hover:text-black transition">Step History</button>
                <button onclick="logout()" class="text-red-500 hover:text-red-700 transition">Logout</button>
            </nav>
        </div>
    </header>

    <main class="flex-grow flex flex-col justify-center">
        
        <!-- HOME VIEW -->
        <section id="view-home" class="view-section active-view w-full">
            <div class="max-w-5xl mx-auto px-4 pt-24 pb-16 text-center">
                <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gray-100 text-xs font-bold uppercase tracking-widest text-gray-600 mb-6 border border-gray-200">
                    <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> SHIB ML Probability Strategy
                </div>
                <h1 class="text-5xl sm:text-6xl md:text-7xl font-extrabold tracking-tight mb-6 leading-tight">Algorithmic Math.<br><span class="text-gray-400">Zero Emotion.</span></h1>
                <p class="text-lg md:text-xl text-gray-500 mb-10 max-w-2xl mx-auto leading-relaxed">TradeBot utilizes a dynamically trained logistic regression model, predicting probabilities and executing automatically via HTX 24/7.</p>
                <button onclick="nav('register')" class="btn-primary text-base px-10 py-4 shadow-lg shadow-black/20 flex items-center gap-2 mx-auto">
                    Launch Web Terminal <span class="material-symbols-outlined text-[20px]">arrow_forward</span>
                </button>
            </div>
        </section>

        <!-- ANALYTICS PAGE -->
        <section id="view-analytics" class="view-section max-w-4xl mx-auto px-4 py-16">
            <div class="text-center mb-10">
                <span class="material-symbols-outlined text-4xl text-black">monitoring</span>
                <h2 class="text-3xl font-bold mt-2">Platform Analytics</h2>
            </div>
            <div class="grid sm:grid-cols-3 gap-6 mb-8">
                <div class="ui-card p-6 text-center border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center justify-center gap-1">Users Online Now</p>
                    <p id="stat-online" class="text-4xl font-mono font-bold text-black">0</p>
                </div>
                <div class="ui-card p-6 text-center border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center justify-center gap-1">Total Page Views</p>
                    <p id="stat-views" class="text-4xl font-mono font-bold text-black">0</p>
                </div>
                <div class="ui-card p-6 text-center border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center justify-center gap-1">Unique Visitors</p>
                    <p id="stat-uniques" class="text-4xl font-mono font-bold text-black">0</p>
                </div>
            </div>
        </section>

        <!-- BACKTEST VIEW -->
        <section id="view-backtest" class="view-section max-w-6xl w-full mx-auto px-4 py-16">
            <div class="text-center mb-10">
                <span class="material-symbols-outlined text-4xl text-black">science</span>
                <h2 class="text-3xl font-bold mt-2">Strategy Backtesting</h2>
            </div>
            <div class="grid lg:grid-cols-4 gap-8">
                <div class="lg:col-span-1 space-y-4 ui-card p-6 border border-gray-100 h-fit">
                    <h3 class="font-bold mb-4 border-b border-gray-50 pb-2">Parameters</h3>
                    <div><label class="text-xs font-semibold text-gray-500 mb-1 block">Test Span (Minutes)</label><input type="number" id="btTicks" class="input-minimal w-full font-mono font-bold text-gray-700" value="5000" step="1000"></div>
                    <div><label class="text-xs font-semibold text-gray-500 mb-1 block">Training Lookback</label><input type="number" id="btMlLookback" class="input-minimal w-full font-mono text-gray-700" value="50" step="1"></div>
                    <div><label class="text-xs font-semibold text-gray-500 mb-1 block">Confidence Threshold (%)</label><input type="number" id="btMlThreshold" class="input-minimal w-full font-mono text-blue-600" value="60" step="1"></div>
                    <div><label class="text-xs font-semibold text-gray-500 mb-1 block">Max DCA Steps (Reverse)</label><input type="number" id="btMaxDcaStepsBeforeReverse" class="input-minimal w-full font-mono text-gray-700" value="10" step="1"></div>
                    <button onclick="runBacktest()" class="btn-primary w-full py-3 mt-4">Run Simulation</button>
                </div>
                <div class="lg:col-span-3 space-y-6">
                    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
                        <div class="ui-card p-4 text-center border border-gray-100"><p class="text-[10px] text-gray-400 font-bold">Win Rate</p><p id="btResWinrate" class="text-lg font-mono font-bold text-blue-600">-</p></div>
                        <div class="ui-card p-4 text-center border border-gray-100"><p class="text-[10px] text-gray-400 font-bold">Net PnL</p><p id="btResPnl" class="text-lg font-mono font-bold">-</p></div>
                        <div class="ui-card p-4 text-center border border-gray-100"><p class="text-[10px] text-gray-400 font-bold">Total Trades</p><p id="btResTrades" class="text-lg font-mono font-bold">-</p></div>
                    </div>
                    <div class="ui-card p-6 border border-gray-100">
                        <h3 class="font-bold mb-4 text-sm text-gray-500 uppercase tracking-widest">Executions</h3>
                        <div class="overflow-x-auto max-h-[400px] overflow-y-auto">
                            <table class="w-full text-left text-sm whitespace-nowrap">
                                <thead class="text-gray-400 uppercase text-[10px] tracking-wider sticky top-0 bg-white">
                                    <tr><th class="pb-2 px-2">Side</th><th class="pb-2 px-2">Qty</th><th class="pb-2 px-2">Reason</th><th class="pb-2 px-2 text-right">Net PnL</th></tr>
                                </thead>
                                <tbody id="btTableBody" class="font-mono text-xs"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <!-- LOGIN -->
        <section id="view-login" class="view-section max-w-md w-full mx-auto px-4 py-20">
            <div class="ui-card p-8 border border-gray-100">
                <div class="text-center mb-6">
                    <h2 class="text-2xl font-bold mt-2">Welcome Back</h2>
                </div>
                <div class="space-y-5">
                    <div><label class="block text-xs font-semibold text-gray-400 mb-1">Email</label><input type="email" id="login-email" class="input-minimal"></div>
                    <div><label class="block text-xs font-semibold text-gray-400 mb-1">Password</label><input type="password" id="login-pass" class="input-minimal"></div>
                    <button onclick="doLogin()" class="btn-primary w-full mt-2 py-3">Secure Log In</button>
                    <div id="login-err" class="text-red-500 text-xs text-center mt-2"></div>
                </div>
            </div>
        </section>

        <!-- REGISTER -->
        <section id="view-register" class="view-section max-w-md w-full mx-auto px-4 py-20">
            <div class="ui-card p-8 border border-gray-100">
                <div class="text-center mb-6">
                    <h2 class="text-2xl font-bold mt-2">Create Account</h2>
                </div>
                <div class="space-y-5">
                    <div><label class="block text-xs font-semibold text-gray-400 mb-1">Name</label><input type="text" id="reg-name" class="input-minimal"></div>
                    <div><label class="block text-xs font-semibold text-gray-400 mb-1">Email</label><input type="email" id="reg-email" class="input-minimal"></div>
                    <div><label class="block text-xs font-semibold text-gray-400 mb-1">Password</label><input type="password" id="reg-pass" class="input-minimal"></div>
                    <button onclick="doRegister()" class="btn-primary w-full mt-2 py-3">Sign Up & Enter Terminal</button>
                    <div id="reg-err" class="text-red-500 text-xs text-center mt-2"></div>
                </div>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-8">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                <div>
                    <h2 class="text-2xl font-bold">Trading Terminal <span id="statusBadge" class="text-[10px] bg-gray-100 text-gray-600 px-3 py-1 rounded-full uppercase">Loading</span></h2>
                </div>
                <div class="flex gap-3 w-full sm:w-auto">
                    <button onclick="nav('settings')" class="btn-secondary flex-1 sm:flex-none">Setup API</button>
                    <button onclick="closeAll()" class="btn-secondary text-red-600 flex-1 sm:flex-none">Close All</button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
                        <div class="ui-card p-5 relative border border-gray-100">
                            <p class="text-[10px] font-bold text-gray-400 uppercase">Net PnL</p>
                            <p id="netPnl" class="text-lg sm:text-xl font-mono font-bold tracking-tight">$0.0000</p>
                        </div>
                        <div class="ui-card p-5 border border-gray-100">
                            <p class="text-[10px] font-bold text-gray-400 uppercase">Win Rate</p>
                            <p id="winRateDisplay" class="text-lg sm:text-xl font-mono font-bold text-blue-600">0.00%</p>
                        </div>
                        <div class="ui-card p-5 border border-gray-100">
                            <p class="text-[10px] font-bold text-gray-400 uppercase">Wallet Balance</p>
                            <p id="marginUsed" class="text-lg sm:text-xl font-mono font-bold">$0.0000</p>
                        </div>
                        <div class="ui-card p-5 border border-gray-100">
                            <p class="text-[10px] font-bold text-gray-400 uppercase">Live ROI</p>
                            <p id="activeRoi" class="text-lg sm:text-xl font-mono font-bold">N/A</p>
                        </div>
                        <div class="ui-card p-3 border border-gray-100 flex flex-col items-center">
                            <div class="relative w-full h-12 flex justify-center items-end mt-1">
                                <canvas id="mlGauge"></canvas>
                                <div class="absolute bottom-0 text-center w-full"><span id="mlValue" class="text-lg font-mono font-bold">0%</span></div>
                            </div>
                            <p id="mlStatus" class="text-[9px] font-bold uppercase mt-1 text-gray-500">Neutral</p>
                        </div>
                    </div>

                    <div class="ui-card p-6 h-[350px] w-full border border-gray-100 relative">
                        <canvas id="mlChart"></canvas>
                    </div>

                    <div class="ui-card p-6 border border-gray-100">
                        <h3 class="text-base font-bold mb-4">HTX Executions</h3>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-sm whitespace-nowrap">
                                <thead class="text-gray-400 uppercase text-[10px] tracking-wider border-b border-gray-100">
                                    <tr><th class="pb-3 px-2">Time</th><th class="pb-3 px-2">Side</th><th class="pb-3 px-2">Qty</th><th class="pb-3 px-2">Reason</th><th class="pb-3 px-2 text-right">Net PnL</th></tr>
                                </thead>
                                <tbody id="tradeHistoryBody" class="font-mono text-xs"></tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="lg:col-span-4 h-fit space-y-6">
                    <div class="ui-card p-6 border border-gray-100">
                        <h3 class="text-base font-bold mb-5 pb-3 border-b border-gray-50">Strategy Config</h3>
                        <div class="space-y-4">
                            <div class="flex justify-between items-center"><label class="text-sm font-medium text-gray-500">Take Profit (%)</label><input type="number" id="tpPctSens" step="0.1" class="input-minimal w-24 text-right"></div>
                            <div class="flex justify-between items-center"><label class="text-sm font-medium text-gray-500">Stop Loss (%)</label><input type="number" id="slPctSens" step="0.1" class="input-minimal w-24 text-right"></div>
                            <div class="flex justify-between items-center"><label class="text-sm font-medium text-gray-500">Confidence Threshold</label><input type="number" id="mlThresholdSens" step="0.1" class="input-minimal w-24 text-right"></div>
                            <div class="flex justify-between items-center"><label class="text-sm font-medium text-gray-500">Max DCA Steps (Reverse)</label><input type="number" id="maxDcaStepsBeforeReverseSens" step="1" class="input-minimal w-24 text-right"></div>
                            <button onclick="saveConfig()" class="btn-primary w-full mt-6 py-3">Update Strategy</button>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <!-- STEP HISTORY VIEW -->
        <section id="view-step-history" class="view-section max-w-5xl mx-auto px-4 py-12">
            <h2 class="text-3xl font-bold text-center mb-10">Step Breakdown</h2>
            <div class="ui-card p-6 border border-gray-100">
                <table class="w-full text-left text-sm">
                    <thead class="text-gray-400 uppercase text-[10px] tracking-wider border-b border-gray-100">
                        <tr><th>Step #</th><th>Action</th><th>Price</th><th>ROI</th></tr>
                    </thead>
                    <tbody id="stepHistoryBody" class="font-mono text-xs"></tbody>
                </table>
            </div>
        </section>

        <!-- API SETTINGS VIEW -->
        <section id="view-settings" class="view-section max-w-lg mx-auto px-4 py-10">
            <button onclick="nav('dashboard')" class="text-sm font-medium text-gray-400 mb-8 flex items-center gap-1">Back</button>
            <div class="ui-card p-8 border border-gray-100">
                <h2 class="text-2xl font-bold mb-6">API Integration</h2>
                <div class="space-y-6">
                    <div class="flex items-center gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl" onclick="handleLiveToggle()">
                        <input type="checkbox" id="liveTrade" class="w-5 h-5 accent-black pointer-events-none">
                        <label class="text-sm font-bold text-gray-800">Enable Live HTX Execution</label>
                    </div>
                    <div><label class="block text-xs font-semibold text-gray-400 mb-2 uppercase">HTX API Key</label><input type="password" id="apiKey" class="input-minimal"></div>
                    <div><label class="block text-xs font-semibold text-gray-400 mb-2 uppercase">HTX API Secret</label><input type="password" id="apiSecret" class="input-minimal"></div>
                    <button onclick="saveApiKeys()" class="btn-primary w-full py-3">Save & Restart</button>
                    <div id="key-msg" class="text-sm text-center mt-3"></div>
                </div>
            </div>
        </section>

    </main>

    <footer class="py-10 mt-auto border-t border-gray-200 bg-white">
        <div class="max-w-6xl mx-auto px-4 text-center text-sm text-gray-400">
            &copy; <script>document.write(new Date().getFullYear())</script> TradeBot Mathematical Engine.
        </div>
    </footer>

    <script>
        let authToken = localStorage.getItem('bot_token');
        let chartPoints = 800;
        let sessionTrackId = localStorage.getItem('rdca_visitor_id') || Math.random().toString(36).substring(2, 15);
        localStorage.setItem('rdca_visitor_id', sessionTrackId);
        let currentPageView = 'home';

        async function pingAnalytics(isViewRecord = false) {
            try { await fetch('/api/analytics/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionTrackId, page: currentPageView, isView: isViewRecord }) }); } catch(e) {}
        }
        setInterval(() => pingAnalytics(false), 10000); 

        function nav(viewId) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.getElementById('view-' + viewId).classList.add('active-view');
            window.scrollTo(0,0);
            currentPageView = viewId; pingAnalytics(true); 
            if(viewId === 'dashboard' && authToken) initDashboard();
            if(viewId === 'analytics') fetchAnalyticsData();
        }

        function toggleAuthUI() {
            if (authToken) { document.getElementById('nav-public').classList.add('hidden'); document.getElementById('nav-private').classList.remove('hidden'); document.getElementById('nav-private').classList.add('flex'); } 
            else { document.getElementById('nav-public').classList.remove('hidden'); document.getElementById('nav-private').classList.add('hidden'); }
        }

        function logout() { localStorage.removeItem('bot_token'); authToken = null; toggleAuthUI(); nav('home'); }

        async function doAPI(endpoint, method, body) {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = authToken;
            const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
            if (res.status === 401) { logout(); return { error: "Session expired" }; }
            return await res.json();
        }

        async function runBacktest() {
            const payload = {
                ticks: document.getElementById('btTicks').value, tpPct: 10, slPct: -50, baseContracts: 1,
                mlLookback: document.getElementById('btMlLookback').value, mlThreshold: document.getElementById('btMlThreshold').value,
                maxDcaStepsBeforeReverse: document.getElementById('btMaxDcaStepsBeforeReverse').value
            };
            const res = await doAPI('/api/backtest', 'POST', payload);
            document.getElementById('btResWinrate').innerText = res.winRate + "%";
            document.getElementById('btResPnl').innerText = "$" + res.netPnl.toFixed(4);
            document.getElementById('btResTrades').innerText = res.totalTradesCount;
            const tbody = document.getElementById('btTableBody'); tbody.innerHTML = "";
            [...res.trades].reverse().forEach(t => {
                tbody.innerHTML += '<tr><td>' + t.side + '</td><td>' + t.contracts + '</td><td>' + t.exitReason + '</td><td class="text-right">$' + t.netPnl.toFixed(4) + '</td></tr>';
            });
        }

        async function doLogin() {
            const res = await doAPI('/api/auth/login', 'POST', { email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value });
            if (res.token) { authToken = res.token; localStorage.setItem('bot_token', authToken); toggleAuthUI(); nav('dashboard'); }
        }

        async function doRegister() {
            const res = await doAPI('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value });
            if (res.token) { authToken = res.token; localStorage.setItem('bot_token', authToken); toggleAuthUI(); nav('dashboard'); }
        }

        function handleLiveToggle() { document.getElementById('liveTrade').checked = !document.getElementById('liveTrade').checked; }

        async function saveApiKeys() {
            await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked });
            nav('dashboard');
        }

        async function saveConfig() {
            const payload = {
                tpPct: document.getElementById("tpPctSens").value, slPct: document.getElementById("slPctSens").value, 
                mlThresholdSens: document.getElementById("mlThresholdSens").value,
                maxDcaStepsBeforeReverseSens: document.getElementById("maxDcaStepsBeforeReverseSens").value
            };
            await doAPI('/api/user/config', 'POST', payload); alert("Saved.");
        }

        async function closeAll() { await doAPI('/api/close-all', 'GET'); }

        async function fetchAnalyticsData() {
            const data = await (await fetch('/api/analytics/stats')).json();
            document.getElementById('stat-online').innerText = data.online; document.getElementById('stat-views').innerText = data.views; document.getElementById('stat-uniques').innerText = data.uniques;
        }

        const ctx = document.getElementById("mlChart").getContext("2d");
        const mlChart = new Chart(ctx, {
            type: "line", 
            data: { labels: [], datasets: [{ label: "Price", data: [], borderColor: "#000", pointRadius: 0, yAxisID: 'y' }, { label: "Prob", data: [], pointRadius: 0, yAxisID: 'y1' }] },
            options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { position: 'left' }, y1: { position: 'right', min: 0, max: 1 } } }
        });

        const gaugeCtx = document.getElementById("mlGauge").getContext("2d");
        const mlGauge = new Chart(gaugeCtx, {
            type: 'doughnut', data: { datasets: [{ data: [50, 50], backgroundColor: ['#eee', '#eee'] }] },
            options: { rotation: -90, circumference: 180, cutout: '75%', responsive: true, maintainAspectRatio: false }
        });

        let dashLoop = null, settingsLoaded = false;
        async function initDashboard() {
            const me = await doAPI('/api/user/me', 'GET');
            document.getElementById('nav-user-name').innerText = me.name;
            if(dashLoop) clearInterval(dashLoop);
            dashLoop = setInterval(fetchMetrics, 1000); fetchMetrics();
        }

        async function fetchMetrics() {
            const data = await doAPI('/api/data', 'GET');
            if(!settingsLoaded) {
                document.getElementById("tpPctSens").value = data.config.takeProfitPct; 
                document.getElementById("slPctSens").value = data.config.stopLossPct; 
                document.getElementById("mlThresholdSens").value = data.config.mlThreshold;
                document.getElementById("maxDcaStepsBeforeReverseSens").value = data.config.maxDcaStepsBeforeReverse || 10;
                settingsLoaded = true;
            }
            document.getElementById("netPnl").innerText = "$" + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById("winRateDisplay").innerText = data.metrics.winRate + "%";
            document.getElementById("marginUsed").innerText = "$" + Number(data.walletBalance || 0).toFixed(4);
            
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById("activeRoi").innerText = p.exchangeROI.toFixed(2) + "%";
                document.getElementById("statusBadge").innerText = p.isPaper ? "📝 Paper" : "⚡ Live";
            }
            
            if (data.mlSignal) {
                document.getElementById('mlValue').innerText = data.mlSignal.confidence.toFixed(1) + "%";
                mlGauge.data.datasets[0].data = [data.mlSignal.confidence, 100 - data.mlSignal.confidence];
                mlGauge.update();
            }

            const tbody = document.getElementById("tradeHistoryBody"); tbody.innerHTML = "";
            [...data.metrics.trades].reverse().slice(0, 10).forEach(t => {
                tbody.innerHTML += '<tr><td>' + new Date(t.timestamp).toLocaleTimeString() + '</td><td>' + t.side + '</td><td>' + t.contracts + '</td><td>' + t.exitReason + '</td><td class="text-right">$' + t.netPnl.toFixed(4) + '</td></tr>';
            });
            
            mlChart.data.labels.push(""); 
            mlChart.data.datasets[0].data.push(data.binance.mid);
            mlChart.data.datasets[1].data.push(data.mlSignal.rawValue);
            if(mlChart.data.labels.length > 100) { mlChart.data.labels.shift(); mlChart.data.datasets[0].data.shift(); mlChart.data.datasets[1].data.shift(); }
            mlChart.update();
        }

        if(authToken) { toggleAuthUI(); nav('dashboard'); } else { toggleAuthUI(); nav('home'); }
    </script>
</body>
</html>`);
});

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
