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
    lastCloseTime: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true, index: true }, 
    side: String, 
    entryPrice: Number, 
    exitPrice: Number,
    contracts: Number, 
    marginUsed: Number, 
    grossPnl: Number, 
    grossRoiPct: Number, 
    roiPct: Number, 
    netPnl: Number, 
    feeCost: Number, 
    timestamp: { type: Date, default: Date.now, index: true }, 
    exitReason: String
}));

TradeModel.schema.index({ userId: 1, timestamp: -1 });
UserModel.schema.index({ token: 1 });
UserModel.schema.index({ email: 1 });

const ChartDataModel = mongoose.model('ChartData_V8', new mongoose.Schema({
    priceMid: Number, 
    timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

const AnalyticsModel = mongoose.model('SiteAnalytics_V3', new mongoose.Schema({
    key: { type: String, default: "global" }, 
    views: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 }, 
    knownIds: { type: [String], default: [] }
}));

// ==================== USER STATS SCHEMA ====================
const UserStatsModel = mongoose.model('UserStats_V1', new mongoose.Schema({
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    initialWalletBalance: { type: Number, default: 0 },
    currentWalletBalance: { type: Number, default: 0 },
    peakWalletBalance: { type: Number, default: 0 },
    lowestWalletBalance: { type: Number, default: 0 },
    totalRealizedPnL: { type: Number, default: 0 },
    totalUnrealizedPnL: { type: Number, default: 0 },
    totalGrowth: { type: Number, default: 0 },
    peakGrowth: { type: Number, default: 0 },
    totalClosedTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 },
    losingTrades: { type: Number, default: 0 },
    totalVolume: { type: Number, default: 0 },
    totalFeesPaid: { type: Number, default: 0 },
    currentDirection: { type: String, default: 'none' },
    currentROI: { type: Number, default: 0 },
    currentMarginUsed: { type: Number, default: 0 },
    currentContracts: { type: Number, default: 0 },
    currentEntryPrice: { type: Number, default: 0 },
    dgrDailyGrowthRate: { type: Number, default: 0 },
    manualDirection: { type: String, default: 'long' },
    isLiveTrading: { type: Boolean, default: false },
    lastUpdate: { type: Date, default: Date.now },
    lastTradeTime: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}));

const WalletSnapshotModel = mongoose.model('WalletSnapshot_V1', new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    balance: { type: Number, required: true },
    realizedPnL: { type: Number, default: 0 },
    unrealizedPnL: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now, index: true }
}));

const DailyPerformanceModel = mongoose.model('DailyPerformance_V1', new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    date: { type: String, required: true },
    startingBalance: { type: Number, required: true },
    endingBalance: { type: Number, required: true },
    dailyPnL: { type: Number, required: true },
    dailyGrowth: { type: Number, required: true },
    tradesCount: { type: Number, default: 0 },
    winsCount: { type: Number, default: 0 },
    lossesCount: { type: Number, default: 0 }
}));

UserStatsModel.schema.index({ totalRealizedPnL: -1 });
UserStatsModel.schema.index({ totalGrowth: -1 });
DailyPerformanceModel.schema.index({ userId: 1, date: -1 });

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, 
    baseContracts: 1, 
    contractSize: 1000, 
    marginMode: 'cross', 
    fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    dcaTriggerPct: 1.0, 
    dcaMultiplier: 2.0, 
    startContracts: 1,
    dgrDailyGrowthRate: 0.0,
    manualDirection: 'long',
    maxContracts: 100, 
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    htx: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: []
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const activeWorkers = new Map(); // Shared between classes

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

    // FIX: DASHBOARD RECOVERY (Restarts worker if it disappeared from memory)
    const userId = req.user._id.toString();
    if (!activeWorkers.has(userId)) {
        const worker = new UserTradeInstance(req.user, false);
        await worker.initialize();
        activeWorkers.set(userId, worker);
    }
    
    next();
}

async function updateUserStats(userId, userEmail, userName, currentData) {
    try {
        let stats = await UserStatsModel.findOne({ userId });
        
        if (!stats) {
            stats = new UserStatsModel({
                userId,
                email: userEmail,
                name: userName,
                initialWalletBalance: currentData.walletBalance || 0,
                currentWalletBalance: currentData.walletBalance || 0,
                peakWalletBalance: currentData.walletBalance || 0,
                lowestWalletBalance: currentData.walletBalance || 0
            });
        }
        
        const previousBalance = stats.currentWalletBalance;
        const newBalance = currentData.walletBalance || 0;
        
        stats.currentWalletBalance = newBalance;
        if (newBalance > stats.peakWalletBalance) stats.peakWalletBalance = newBalance;
        if (stats.lowestWalletBalance === 0 || newBalance < stats.lowestWalletBalance) stats.lowestWalletBalance = newBalance;
        
        if (stats.initialWalletBalance > 0) {
            stats.totalGrowth = ((newBalance - stats.initialWalletBalance) / stats.initialWalletBalance) * 100;
            if (stats.totalGrowth > stats.peakGrowth) stats.peakGrowth = stats.totalGrowth;
        }
        
        if (currentData.activePositions && currentData.activePositions.length > 0) {
            const pos = currentData.activePositions[0];
            stats.currentDirection = pos.side;
            stats.currentROI = pos.exchangeROI || 0;
            stats.currentMarginUsed = pos.marginUsed || 0;
            stats.currentContracts = pos.contracts || 0;
            stats.currentEntryPrice = pos.entryPrice || 0;
            stats.totalUnrealizedPnL = pos.exchangePnl || 0;
        } else {
            stats.currentDirection = 'none';
            stats.currentROI = 0;
            stats.currentMarginUsed = 0;
            stats.currentContracts = 0;
            stats.currentEntryPrice = 0;
            stats.totalUnrealizedPnL = 0;
        }
        
        if (currentData.metrics) {
            stats.totalClosedTrades = currentData.metrics.totalTradesCount || 0;
            stats.winningTrades = currentData.metrics.wins || 0;
            stats.losingTrades = currentData.metrics.losses || 0;
            stats.totalRealizedPnL = currentData.metrics.totalNetPnl || 0;
            stats.totalFeesPaid = currentData.metrics.totalFees || 0;
            
            if (currentData.metrics.trades && currentData.metrics.trades.length > 0) {
                const lastTrade = currentData.metrics.trades[currentData.metrics.trades.length - 1];
                stats.lastTradeTime = lastTrade.timestamp || new Date();
            }
        }
        
        if (currentData.config) {
            stats.dgrDailyGrowthRate = currentData.config.dgrDailyGrowthRate || 0;
            stats.manualDirection = currentData.config.manualDirection || 'long';
            stats.isLiveTrading = currentData.liveTradingEnabled || false;
        }
        
        stats.lastUpdate = new Date();
        await stats.save();
        
        const shouldSaveSnapshot = Math.abs(newBalance - previousBalance) > 10 || Math.random() < 0.1;
        if (shouldSaveSnapshot) {
            await WalletSnapshotModel.create({
                userId,
                balance: newBalance,
                realizedPnL: stats.totalRealizedPnL,
                unrealizedPnL: stats.totalUnrealizedPnL,
                timestamp: new Date()
            });
        }
        
        return stats;
    } catch (err) {
        console.error(`Failed to update stats for ${userId}:`, err.message);
    }
}

// FIX: NAN PROTECTION (Check for valid prices before calculation)
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    if (!entryPrice || !currentPrice || isNaN(entryPrice) || isNaN(currentPrice) || entryPrice <= 0 || currentPrice <= 0) {
        return { grossPnlPercent: 0, currentGrossRoi: 0, grossPnlUsd: 0, grossRoiPct: 0, netPnlUsd: 0, netRoiPct: 0, feeCost: 0, margin: 0 };
    }
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const grossRoiPct = (grossPnlUsd / margin) * 100;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;

    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, grossRoiPct, netPnlUsd, netRoiPct: (netPnlUsd / margin) * 100, feeCost, margin };
}

function calculateDGRAdjustment(dgrDailyGrowthRate, daysActive) {
    if (dgrDailyGrowthRate <= 0) return 1.0;
    return Math.pow(1 + (dgrDailyGrowthRate / 100), daysActive);
}

class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; 
        this.trades = []; 
        this.totalGrossPnl = 0; 
        this.totalNetPnl = 0; 
        this.totalFees = 0; 
        this.totalRoiPct = 0;
        this.wins = 0; 
        this.losses = 0; 
        this.winRate = 0; 
        this.totalTradesCount = 0; 
        this.maxMarginUsed = 0; 
        this.startDate = Date.now();
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        // FIX: Validation before push/save to prevent NaN logs
        if (isNaN(trade.netPnl) || isNaN(trade.exitPrice)) return;

        this.totalTradesCount++; 
        if (!trade.timestamp) trade.timestamp = Date.now();
        this.trades.push(trade); 
        if (this.trades.length > 2000) this.trades.shift(); 
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; 
        this.totalFees += trade.feeCost || 0; 
        this.totalRoiPct += trade.roiPct || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch((err) => console.error('Trade save error:', err.message));
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
    getDaysActive() { return (Date.now() - this.startDate) / (1000 * 60 * 60 * 24); }
    
    async reset() {
        await TradeModel.deleteMany({ userId: this.userId });
        this.trades = [];
        this.totalGrossPnl = 0;
        this.totalNetPnl = 0;
        this.totalFees = 0;
        this.totalRoiPct = 0;
        this.wins = 0;
        this.losses = 0;
        this.winRate = 0;
        this.totalTradesCount = 0;
        this.maxMarginUsed = 0;
        this.startDate = Date.now();
    }
}

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
    const { dcaTriggerPct=1.0, dcaMultiplier=2.0, startContracts=1, dgrDailyGrowthRate=0.0, manualDirection='long' } = config;
    const maxContracts = config.maxContracts !== undefined ? Number(config.maxContracts) : 100;
    
    let totalDaysSimulated = (ticks[ticks.length - 1].timestamp - ticks[0].timestamp) / (1000 * 60 * 60 * 24);
    let dgrAdjustment = calculateDGRAdjustment(dgrDailyGrowthRate, totalDaysSimulated);
    
    let priceBuffer = [];
    const totalSpanMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;

    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i];
        const price = tick.priceMid, tickTime = tick.timestamp;

        if (i % 1000 === 0 && i > 0) {
            await new Promise(resolve => setImmediate(resolve));
        }

        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) {
            priceBuffer.push(price); 
            if (priceBuffer.length > 500) priceBuffer.shift();
        }
        
        let signal = manualDirection === 'long' ? 'long' : (manualDirection === 'short' ? 'short' : null);

        if (!activePos && signal) {
            let bC = parseInt(startContracts) || 1;
            const sizeUsd = bC * config.contractSize * price; 
            const margin = sizeUsd / FORCED_LEVERAGE;
            activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: margin, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
            if (margin > maxMarginUsed) maxMarginUsed = margin;
            continue;
        }

        if (activePos) {
            const math = calculateTradeMath(activePos.side, activePos.entryPrice, price, activePos.size, FORCED_LEVERAGE, config.fees.taker);
            let forceExitReason = null;
            
            if (math.currentGrossRoi >= config.takeProfitPct) forceExitReason = "TAKE_PROFIT";
            else if (math.currentGrossRoi <= config.stopLossPct) forceExitReason = "STOP_LOSS";

            if (forceExitReason) {
                netPnl += math.netPnlUsd; 
                math.netPnlUsd > 0 ? wins++ : losses++;
                totalTradeDurationMs += (tickTime - activePos.entryTime);

                closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: price, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: forceExitReason, time: tick.timestamp });
                
                activePos = null;
            } else {
                const requiredRoiForDca = -(Math.abs(dcaTriggerPct || 1.0));
                
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(startContracts) || 1;
                    let mult = Number(dcaMultiplier) || 2.0;
                    let step = Number(activePos.dcaStep) || 0;
                    
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step) * dgrAdjustment)), 10);
                    
                    if (Number(activePos.contracts) + contractsToAdd <= maxContracts) {
                        const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                        
                        activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                        activePos.size = Number(activePos.size) + addedSizeUsd; 
                        activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                        activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                        activePos.lastDcaTime = tickTime; 
                        activePos.dcaStep = step + 1;
                        if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                    }
                }
            }
        }
    }

    if (activePos) {
        const lastTick = ticks[ticks.length - 1]; 
        const math = calculateTradeMath(activePos.side, activePos.entryPrice, lastTick.priceMid, activePos.size, FORCED_LEVERAGE, config.fees.taker);
        netPnl += math.netPnlUsd; 
        math.netPnlUsd > 0 ? wins++ : losses++;
        totalTradeDurationMs += (lastTick.timestamp - activePos.entryTime);
        closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: lastTick.priceMid, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: "END_OF_TEST", time: lastTick.timestamp });
    }

    const totalTradesCount = closedTrades.length;
    const formatTime = (ms) => {
        if (ms < 1000) return "< 1s";
        let s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h%24}h`; 
        if (h > 0) return `${h}h ${m%60}m`; 
        if (m > 0) return `${m}m ${s%60}s`; 
        return `${s}s`;
    };

    return { 
        ticksAnalyzed: ticks.length, 
        totalTradesCount, 
        wins, 
        losses, 
        winRate: totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(2) : 0, 
        netPnl, 
        depositNeeded: maxMarginUsed, 
        avgDuration: formatTime(totalTradesCount > 0 ? totalTradeDurationMs / totalTradesCount : 0), 
        totalSpan: formatTime(totalSpanMs), 
        trades: closedTrades.slice(-200) 
    };
}

class UserTradeInstance {
    constructor(user, forceClean = false) {
        this.userId = user._id.toString(); 
        this.userEmail = user.email;
        this.userName = user.name;
        
        if (forceClean || !user.config || Object.keys(user.config).length === 0) {
            this.config = { ...BASE_CONFIG };
            user.config = this.config;
            user.save().catch(err => console.error(`Failed to save clean config for ${this.userId}:`, err.message));
        } else {
            this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        }
        
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) {
            this.config.htxSymbol = 'SHIB/USDT:USDT';
            this.config.binanceSymbol = '1000SHIB/USDT:USDT';
        }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.config.marginMode = 'cross'; 

        this.startTime = Date.now(); 
        this.metrics = new PerformanceMetrics(this.userId);
        
        if (forceClean || !user.activePosition) {
            this.activePositions = [];
            user.activePosition = null;
            user.lastCloseTime = 0;
            user.save().catch(err => console.error(`Failed to save clean position for ${this.userId}:`, err.message));
        } else {
            this.activePositions = user.activePosition ? [user.activePosition] : [];
        }
        
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.isClosing = false;
        this.lastEvalPrice = 0;
        this.walletBalance = 0;
        this.statsInterval = null;

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
        
        this.statsInterval = setInterval(async () => {
            await this.updatePerformanceStats();
        }, 30000);
    }
    
    async cleanup() {
        if (this.statsInterval) clearInterval(this.statsInterval);
    }
    
    async updatePerformanceStats() {
        const exportData = this.getExportData();
        await updateUserStats(this.userId, this.userEmail, this.userName, exportData);
    }

    async saveState() {
        await UserModel.updateOne(
            { _id: this.userId },
            { $set: { 
                activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, 
                lastCloseTime: this.lastCloseTime, 
                config: this.config 
            } }
        );
        for (const [token, data] of tokenCache.entries()) {
            if (data.user._id.toString() === this.userId) {
                data.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
                data.user.config = this.config;
                break;
            }
        }
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
                    this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); 
                    await this.saveState();
                } else {
                    this.activePositions = []; 
                    await this.saveState();
                }
            }
            return { success: true };
        } catch (error) { 
            console.log(`[Worker ${this.userId}] Exchange Init Error:`, error.message); 
            this.liveTradingEnabled = false; 
            return { success: false, message: error.message }; 
        }
    }

    async evaluateManualEntry() {
        if (this.isTrading || this.isClosing || (Date.now() - this.lastCloseTime < 3000)) return;
        // FIX: WAIT FOR PRICE
        if (!globalMarketData.binance.mid || globalMarketData.binance.mid <= 0) return;

        try {
            let signal = this.config.manualDirection === 'long' ? 'long' : (this.config.manualDirection === 'short' ? 'short' : null);
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                    let instantRoi = pnlPercent * FORCED_LEVERAGE;
                    if (instantRoi >= 0) {
                        await this.forceClosePosition("MANUAL_FLIP"); 
                        setTimeout(() => this.syncState(signal), 50);
                    }
                }
            } else {
                if (signal) await this.syncState(signal);
            }
        } catch (e) { console.error(`🚨 [Eval Error]:`, e.message); }
    }

    async checkExits() {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
        // FIX: WAIT FOR PRICE
        if (!globalMarketData.binance.mid || globalMarketData.binance.mid <= 0) return;
        
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
                const requiredRoiForDca = -(Math.abs(this.config.dcaTriggerPct || 1.0));
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    await this.addDcaPosition();
                }
            }
        } catch (e) { console.error(`🚨 [Exit Check Error]:`, e.message); }
    }

    async addDcaPosition() {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
        // FIX: WAIT FOR PRICE
        if (!globalMarketData.binance.mid || globalMarketData.binance.mid <= 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let dgrAdjustment = calculateDGRAdjustment(this.config.dgrDailyGrowthRate || 0, this.metrics.getDaysActive());
            let multiplier = Number(this.config.dcaMultiplier) || 2.0;
            let baseC = Number(this.config.startContracts) || 1;
            let step = Number(pos.dcaStep) || 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step) * dgrAdjustment)), 10);
            const maxC = this.config.maxContracts || 100;
            if (Number(pos.contracts) + contractsToAdd > maxC) { pos.lastDcaTime = Date.now(); await this.saveState(); this.isTrading = false; return; }

            pos.lastDcaTime = Date.now();
            await this.saveState();
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled) {
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) { realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average; }
                } catch(e) { console.error(`[User ${this.userId}] API Error:`, e.message); return; }
            }

            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: step + 1, type: 'DCA', price: realExecPrice, roi: pos.exchangeROI || 0, time: Date.now() });
            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realExecPrice;
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realExecPrice) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd;
            pos.contracts = Number(pos.contracts) + contractsToAdd; 
            pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
            pos.dcaStep = step + 1;
            this.metrics.updateMaxMargin(pos.marginUsed);
            await this.saveState();
        } catch (err) { console.error(`🚨 [DCA Error]:`, err.message); } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.isClosing || this.activePositions.length > 0) return;
        // FIX: WAIT FOR PRICE
        if (!globalMarketData.binance.mid || globalMarketData.binance.mid <= 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            let contracts = parseInt(Math.max(1, Math.floor(Number(this.config.startContracts) || 1)), 10);
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
            this.metrics.updateMaxMargin(marginUsed); 
            await this.saveState();
        } catch (err) { console.error(`🚨 [Open Error]:`, err.message); this.activePositions = []; } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
        // FIX: WAIT FOR PRICE
        if (!globalMarketData.binance.mid || globalMarketData.binance.mid <= 0) return;
        this.isClosing = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let realExitPrice = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;

            if (!snapPos.isPaper && this.liveTradingEnabled) {
                const closeRes = await this.htx.createMarketOrder(this.config.htxSymbol, closeSide, snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                this.activePositions = []; 
                await new Promise(r => setTimeout(r, 150));
                try { 
                    const cOrder = await this.htx.fetchOrder(closeRes.id, this.config.htxSymbol); 
                    if (cOrder && cOrder.average) { realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average; }
                } catch(e){}
            } else { this.activePositions = []; }

            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.lastCloseTime = Date.now(); 
            await this.saveState();
        } catch (err) { console.error(`🚨 [Close Error]:`, err.message); } finally { this.isClosing = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading || this.isClosing) {
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
                    } else { this.activePositions = []; await this.saveState(); return; }
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
        return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: { totalNetPnl: this.metrics.totalNetPnl, totalTradesCount: this.metrics.totalTradesCount, wins: this.metrics.wins, losses: this.metrics.losses, winRate: this.metrics.winRate, totalFees: this.metrics.totalFees, trades: this.metrics.trades.slice(-50) }, activePositions: this.activePositions, binance: globalMarketData.binance, walletBalance: this.walletBalance, dgrDaysActive: this.metrics.getDaysActive() }; 
    }
    
    async resetAccount() {
        if (this.activePositions.length > 0) await this.forceClosePosition("ACCOUNT_RESET");
        await this.metrics.reset();
        this.config = { ...BASE_CONFIG };
        this.activePositions = []; this.lastCloseTime = 0; this.startTime = Date.now(); this.walletBalance = 0;
        await UserModel.updateOne({ _id: this.userId }, { $set: { config: this.config, activePosition: null, lastCloseTime: 0, liveTradingEnabled: false } });
        await UserStatsModel.findOneAndDelete({ userId: this.userId });
        await WalletSnapshotModel.deleteMany({ userId: this.userId });
        await this.saveState();
        return { success: true, message: "Account reset" };
    }
}

async function startMasterStreams() {
    let marketsLoaded = false; 
    while (!marketsLoaded) { try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } catch (e) { await new Promise(r => setTimeout(r, 5000)); } }

    try {
        const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean();
        if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, timestamp: doc.timestamp }));
    } catch(e) {}

    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null;
        while (true) {
            try {
                let ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                let mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid: mid, timestamp: Date.now() };
                
                if (Date.now() - lastHistorySave > 2000 && mid !== lastSavedMid) { 
                    const doc = { priceMid: mid, timestamp: Date.now() };
                    memoryChartHistory.push(doc); 
                    if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                    ChartDataModel.create(doc).catch(()=>{}); 
                    lastHistorySave = Date.now(); lastSavedMid = mid;
                }
                for (const worker of activeWorkers.values()) { 
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateManualEntry().catch(()=>{}); 
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// (Express and UI section same as original - routes below are abbreviated for space but must be in your file)
const app = express(); app.use(express.json());
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    tokenCache.set(user.token, { user, lastAccessed: Date.now() });
    
    // FIX: RE-INITIALIZE WORKER ON LOGIN
    if (!activeWorkers.has(user._id.toString())) {
        const worker = new UserTradeInstance(user, false);
        await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
    }
    res.json({ token: user.token, user: { name: user.name, email: user.email } });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker.getExportData());
});

app.get('/', (req, res) => {
    // Keep your FULL HTML block here from original file.
    // Ensure the Tick Loop at the bottom of HTML is 1000ms: setInterval(fetchMetrics, 1000);
});

// START
app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u);
        await worker.initialize();
        activeWorkers.set(u._id.toString(), worker);
    }
    startMasterStreams();
});
