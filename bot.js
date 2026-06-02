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
        } catch (e) {
            console.error(`🚨 [Eval Error - ${this.userId}]:`, e.message);
        }
    }

    async checkExits() {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
        
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
        } catch (e) {
             console.error(`🚨 [Exit Check Error - ${this.userId}]:`, e.message);
        }
    }

    async addDcaPosition() {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            
            let dgrAdjustment = calculateDGRAdjustment(this.config.dgrDailyGrowthRate || 0, this.metrics.getDaysActive());
            
            let multiplier = this.config.dcaMultiplier;
            multiplier = Number(multiplier);
            if (isNaN(multiplier) || multiplier < 1.0) multiplier = 2.0;
            
            let baseC = Number(this.config.startContracts) || 1;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            
            let step = Number(pos.dcaStep);
            if (isNaN(step)) step = 0;

            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step) * dgrAdjustment)), 10);
            
            const maxC = this.config.maxContracts || 100;
            if (Number(pos.contracts) + contractsToAdd > maxC) {
                pos.lastDcaTime = Date.now();
                await this.saveState();
                this.isTrading = false;
                return; 
            }

            pos.lastDcaTime = Date.now();
            await this.saveState();
            
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled) {
                console.log(`[User ${this.userId}] Requesting DCA: ${contractsToAdd} contracts on HTX`);
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
                type: 'DCA',
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
            console.log(`[User ${this.userId}] ${pos.isPaper ? 'Paper' : 'LIVE'} DCA Executed (Step ${pos.dcaStep}). Added ${contractsToAdd} to ${pos.side.toUpperCase()}`);
        } catch (err) {
            console.error(`🚨 [DCA Error - User ${this.userId}]:`, err.message);
        } finally { 
            this.isTrading = false; 
        }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.isClosing || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            
            let baseC = Number(this.config.startContracts) || 1;
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
            
            this.activePositions = [{ 
                id: Date.now(), 
                side: targetSide, 
                entryPrice: Number(executionPrice), 
                contracts: Number(contracts), 
                size: Number(sizeUsd), 
                marginUsed: Number(marginUsed), 
                entryTime: Date.now(), 
                exchangeROI: 0, 
                exchangePnl: 0, 
                isPaper, 
                lastDcaTime: 0, 
                dcaStep: 0, 
                stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] 
            }];
            
            this.metrics.updateMaxMargin(marginUsed); 
            await this.saveState();
            console.log(`[User ${this.userId}] ${isPaper?'Paper':'LIVE'} OPEN: ${targetSide.toUpperCase()} at $${executionPrice}`);
        } catch (err) { 
            console.error(`🚨 [Open Error - User ${this.userId}]:`, err.message); 
            this.activePositions = []; 
        } finally { 
            this.isTrading = false; 
        }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.isClosing || this.activePositions.length === 0) return;
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
                    if (cOrder && cOrder.average) {
                        realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average;
                    }
                } catch(e){}
            } else {
                this.activePositions = [];
            }

            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ 
                side: snapPos.side, 
                contracts: snapPos.contracts, 
                entryPrice: snapPos.entryPrice, 
                exitPrice: realExitPrice, 
                marginUsed: math.margin, 
                grossPnl: math.grossPnlUsd, 
                grossRoiPct: math.grossRoiPct, 
                netPnl: math.netPnlUsd, 
                roiPct: math.netRoiPct, 
                feeCost: math.feeCost, 
                exitReason: reason 
            });
            
            this.lastCloseTime = Date.now(); 
            await this.saveState();
            console.log(`[User ${this.userId}] ${snapPos.isPaper?'Paper':'LIVE'} CLOSED: ${reason}`);
        } catch (err) {
            console.error(`🚨 [Close Error - User ${this.userId}]:`, err.message);
        } finally { 
            this.isClosing = false; 
        }
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
            config: this.config, 
            liveTradingEnabled: this.liveTradingEnabled, 
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: {
                totalNetPnl: this.metrics.totalNetPnl,
                totalTradesCount: this.metrics.totalTradesCount,
                wins: this.metrics.wins,
                losses: this.metrics.losses,
                winRate: this.metrics.winRate,
                totalFees: this.metrics.totalFees,
                trades: this.metrics.trades.slice(-50)
            }, 
            activePositions: this.activePositions, 
            binance: globalMarketData.binance,
            walletBalance: this.walletBalance, 
            dgrDaysActive: this.metrics.getDaysActive()
        }; 
    }
    
    async resetAccount() {
        console.log(`[User ${this.userId}] Resetting account to clean state...`);
        
        if (this.activePositions.length > 0) {
            await this.forceClosePosition("ACCOUNT_RESET");
        }
        
        await this.metrics.reset();
        
        this.config = { ...BASE_CONFIG };
        
        this.activePositions = [];
        this.lastCloseTime = 0;
        this.startTime = Date.now();
        this.walletBalance = 0;
        
        await UserModel.updateOne(
            { _id: this.userId },
            { 
                $set: { 
                    config: this.config,
                    activePosition: null,
                    lastCloseTime: 0,
                    liveTradingEnabled: false
                } 
            }
        );
        
        await UserStatsModel.findOneAndDelete({ userId: this.userId });
        await WalletSnapshotModel.deleteMany({ userId: this.userId });
        
        await this.saveState();
        console.log(`[User ${this.userId}] Account reset complete`);
        return { success: true, message: "Account reset to clean state" };
    }
}

const activeWorkers = new Map();

async function startMasterStreams() {
    let marketsLoaded = false; 
    while (!marketsLoaded) { 
        try { 
            await publicBinance.loadMarkets(); 
            await publicHtx.loadMarkets(); 
            marketsLoaded = true; 
        } 
        catch (e) { 
            console.log("Waiting for markets to load...");
            await new Promise(r => setTimeout(r, 5000)); 
        } 
    }

    try {
        const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean();
        if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, timestamp: doc.timestamp }));
    } catch(e) {}

    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null;
        
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
                        new Promise((_, reject) => setTimeout(() => reject(new Error('WS_TIMEOUT')), 3000))
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

                if (Date.now() - lastHistorySave > 2000) { 
                    if (mid !== lastSavedMid) {
                        const doc = { priceMid: mid, timestamp: Date.now() };
                        memoryChartHistory.push(doc); 
                        if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                        ChartDataModel.create(doc).catch(()=>{}); 
                        lastHistorySave = Date.now(); 
                        lastSavedMid = mid;
                    }
                }

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch((err) => console.error(`Worker exit check error:`, err.message)); 
                    worker.evaluateManualEntry().catch((err) => console.error(`Worker eval error:`, err.message)); 
                }

                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { 
                console.error("Stream error:", e.message);
                await new Promise(r => setTimeout(r, 2000)); 
            }
        }
    })();
}

async function loadAllUsers() {
    try {
        const users = await UserModel.find({});
        console.log(`Loading ${users.length} existing users...`);
        for(const u of users) {
            try {
                const worker = new UserTradeInstance(u, false);
                await worker.initialize();
                activeWorkers.set(u._id.toString(), worker);
                if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
                console.log(`✅ Loaded user: ${u.email}`);
            } catch(we) { 
                console.error(`Worker error for ${u.email}:`, we.message); 
            }
        }
        console.log(`Total active workers: ${activeWorkers.size}`);
    } catch(e) {
        console.error("Failed to load users:", e);
    }
}

const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 15000) activeSessions.delete(sid);
    }
}, 5000);

async function recordDailyPerformance() {
    const today = new Date().toISOString().split('T')[0];
    const allStats = await UserStatsModel.find({});
    
    for (const stats of allStats) {
        const existing = await DailyPerformanceModel.findOne({ 
            userId: stats.userId, 
            date: today 
        });
        
        if (!existing && stats.lastUpdate) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            const yesterdayStats = await DailyPerformanceModel.findOne({
                userId: stats.userId,
                date: yesterdayStr
            });
            
            const startingBalance = yesterdayStats ? yesterdayStats.endingBalance : stats.initialWalletBalance;
            const endingBalance = stats.currentWalletBalance;
            const dailyPnL = endingBalance - startingBalance;
            const dailyGrowth = startingBalance > 0 ? (dailyPnL / startingBalance) * 100 : 0;
            
            const todayTrades = await TradeModel.countDocuments({
                userId: stats.userId,
                timestamp: { $gte: new Date(today) }
            });
            
            await DailyPerformanceModel.create({
                userId: stats.userId,
                date: today,
                startingBalance,
                endingBalance,
                dailyPnL,
                dailyGrowth,
                tradesCount: todayTrades,
                winsCount: 0,
                lossesCount: 0
            });
        }
    }
}

setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        recordDailyPerformance();
    }
}, 60000);

// ==================== EXPRESS SERVER & API ====================
const app = express(); 
app.use(express.json());

// Trust proxy - needed for Scalingo (handles X-Forwarded-For headers)
app.set('trust proxy', 1);

// Simple in-memory rate limiting (no external package needed)
const rateLimitMap = new Map();

function simpleRateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxRequests = 100;
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    const data = rateLimitMap.get(ip);
    if (now - data.firstRequest > windowMs) {
        rateLimitMap.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    if (data.count >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }
    
    data.count++;
    rateLimitMap.set(ip, data);
    next();
}

app.use('/api/', (req, res, next) => {
    if (req.path === '/analytics/track') return next();
    simpleRateLimiter(req, res, next);
});

setInterval(() => {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    for (const [ip, data] of rateLimitMap.entries()) {
        if (now - data.firstRequest > windowMs) {
            rateLimitMap.delete(ip);
        }
    }
}, 600000);

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
        takeProfitPct: parseFloat(req.body.tpPct) || 10.0, 
        stopLossPct: parseFloat(req.body.slPct) || -50.0,
        dcaTriggerPct: parseFloat(req.body.dcaTriggerPct) || 1.0,
        dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0,
        startContracts: parseInt(req.body.startContracts) || 1,
        dgrDailyGrowthRate: parseFloat(req.body.dgrDailyGrowthRate) || 0.0,
        manualDirection: req.body.manualDirection || 'long',
        maxContracts: parseInt(req.body.maxContracts) || 100
    };
    try {
        const results = await runBacktestSimulation(bConfig, parseInt(req.body.ticks) || 5000, BASE_CONFIG.binanceSymbol);
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already exists' });
        }
        
        const salt = crypto.randomBytes(16).toString('hex');
        
        const user = await UserModel.create({ 
            name, 
            email, 
            passwordHash: hashPassword(password, salt), 
            salt, 
            token: generateToken(),
            apiKey: "",
            apiSecret: "",
            liveTradingEnabled: false,
            config: {},
            activePosition: null,
            lastCloseTime: 0,
            createdAt: new Date()
        });
        
        const worker = new UserTradeInstance(user, true);
        await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        console.log(`✅ New user registered: ${email} (${user._id})`);
        
        res.json({ 
            token: user.token, 
            user: { 
                name: user.name, 
                email: user.email,
                createdAt: user.createdAt
            } 
        });
    } catch(e) { 
        console.error('Registration error:', e);
        res.status(500).json({ error: 'Registration failed: ' + e.message }); 
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await UserModel.findOne({ email: req.body.email });
        if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        user.token = generateToken(); 
        await user.save();
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { 
        console.error('Login error:', e);
        res.status(500).json({ error: 'Login failed' }); 
    }
});

app.post('/api/user/reset-account', authMiddleware, async (req, res) => {
    try {
        const worker = activeWorkers.get(req.user._id.toString());
        if (!worker) {
            return res.status(400).json({ error: 'Worker not found' });
        }
        
        const result = await worker.resetAccount();
        res.json(result);
    } catch(err) {
        console.error('Reset account error:', err);
        res.status(500).json({ error: 'Failed to reset account: ' + err.message });
    }
});

app.get('/api/user/account-info', authMiddleware, async (req, res) => {
    try {
        const user = await UserModel.findById(req.user._id);
        res.json({
            createdAt: user.createdAt,
            daysActive: Math.floor((Date.now() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24)),
            totalTrades: await TradeModel.countDocuments({ userId: user._id.toString() }),
            hasActivePosition: !!(user.activePosition),
            isLiveEnabled: user.liveTradingEnabled
        });
    } catch(err) {
        res.status(500).json({ error: 'Failed to get account info' });
    }
});

app.get('/api/user/me', authMiddleware, (req, res) => {
    res.json({ 
        name: req.user.name, 
        email: req.user.email, 
        apiKey: req.user.apiKey ? '***' : '', 
        liveTradingEnabled: req.user.liveTradingEnabled,
        createdAt: req.user.createdAt
    });
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

        req.user.apiKey = apiKey; 
        req.user.apiSecret = apiSecret; 
        await req.user.save();
        res.json({ status: 'ok' });
    } catch(e) { 
        console.error('Keys update error:', e);
        res.status(500).json({ error: 'Failed to update settings' }); 
    }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(!worker) return res.status(400).json({ error: 'Worker not active' });
    
    const { tpPct, slPct, dcaTriggerPct, dcaMultiplier, startContracts, dgrDailyGrowthRate, manualDirection, maxContracts } = req.body;
    const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) worker.config[k] = p; } };

    pSet(tpPct, parseFloat, 'takeProfitPct'); 
    pSet(slPct, parseFloat, 'stopLossPct');
    pSet(dcaTriggerPct, parseFloat, 'dcaTriggerPct'); 
    pSet(dcaMultiplier, parseFloat, 'dcaMultiplier');
    pSet(startContracts, parseInt, 'startContracts'); 
    pSet(dgrDailyGrowthRate, parseFloat, 'dgrDailyGrowthRate');
    pSet(maxContracts, parseInt, 'maxContracts');
    
    if (manualDirection !== undefined && (manualDirection === 'long' || manualDirection === 'short')) {
        worker.config.manualDirection = manualDirection;
    }

    req.user.config = worker.config; 
    req.user.markModified('config'); 
    await req.user.save();
    res.json({status: 'ok', config: worker.config});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    try {
        const worker = activeWorkers.get(req.user._id.toString());
        if(worker) { 
            await worker.metrics.reset();
            res.json({status: 'ok', message: 'Metrics reset successfully' });
        } else {
            res.status(400).json({ error: 'Worker not found' });
        }
    } catch(err) { 
        console.error('Reset metrics error:', err);
        res.status(500).json({error: 'Failed to reset metrics'}); 
    }
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if (!worker) {
        return res.status(400).json({ error: "Worker not found" });
    }
    res.json(worker.getExportData());
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 

app.post('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) {
        await worker.forceClosePosition("MANUAL_FORCE_CLOSE").catch((err) => console.error(err)); 
        res.json({status: 'ok', message: 'Position closed' });
    } else {
        res.status(400).json({ error: 'Worker not found' });
    }
});

// ==================== ADMIN PANEL ENDPOINTS ====================
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin_secret_token_change_me";

function adminAuthMiddleware(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Admin access denied' });
    }
    next();
}

app.get('/api/admin/users', adminAuthMiddleware, async (req, res) => {
    try {
        const users = await UserModel.find({}).select('-passwordHash -salt -apiSecret');
        const userStats = await UserStatsModel.find({});
        
        const combinedData = users.map(user => {
            const stats = userStats.find(s => s.userId === user._id.toString()) || {};
            return {
                _id: user._id,
                name: user.name,
                email: user.email,
                createdAt: user.createdAt,
                liveTradingEnabled: user.liveTradingEnabled,
                hasApiKeys: !!(user.apiKey && user.apiKey !== ""),
                stats: {
                    initialWalletBalance: stats.initialWalletBalance || 0,
                    currentWalletBalance: stats.currentWalletBalance || 0,
                    totalRealizedPnL: stats.totalRealizedPnL || 0,
                    totalUnrealizedPnL: stats.totalUnrealizedPnL || 0,
                    totalGrowth: stats.totalGrowth || 0,
                    peakGrowth: stats.peakGrowth || 0,
                    peakWalletBalance: stats.peakWalletBalance || 0,
                    lowestWalletBalance: stats.lowestWalletBalance || 0,
                    totalClosedTrades: stats.totalClosedTrades || 0,
                    winningTrades: stats.winningTrades || 0,
                    losingTrades: stats.losingTrades || 0,
                    winRate: stats.totalClosedTrades > 0 ? ((stats.winningTrades / stats.totalClosedTrades) * 100).toFixed(2) : 0,
                    totalFeesPaid: stats.totalFeesPaid || 0,
                    currentDirection: stats.currentDirection || 'none',
                    currentROI: stats.currentROI || 0,
                    currentMarginUsed: stats.currentMarginUsed || 0,
                    dgrDailyGrowthRate: stats.dgrDailyGrowthRate || 0,
                    manualDirection: stats.manualDirection || 'long',
                    lastTradeTime: stats.lastTradeTime,
                    lastUpdate: stats.lastUpdate
                }
            };
        });
        
        combinedData.sort((a, b) => (b.stats.totalGrowth || 0) - (a.stats.totalGrowth || 0));
        
        res.json({
            totalUsers: combinedData.length,
            activeTradingUsers: combinedData.filter(u => u.liveTradingEnabled).length,
            users: combinedData
        });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/user/:userId', adminAuthMiddleware, async (req, res) => {
    try {
        const user = await UserModel.findById(req.params.userId).select('-passwordHash -salt -apiSecret');
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const stats = await UserStatsModel.findOne({ userId: req.params.userId });
        const walletSnapshots = await WalletSnapshotModel.find({ userId: req.params.userId })
            .sort({ timestamp: -1 })
            .limit(100);
        const dailyPerformance = await DailyPerformanceModel.find({ userId: req.params.userId })
            .sort({ date: -1 })
            .limit(30);
        const recentTrades = await TradeModel.find({ userId: req.params.userId })
            .sort({ timestamp: -1 })
            .limit(50);
        
        res.json({
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                createdAt: user.createdAt,
                liveTradingEnabled: user.liveTradingEnabled
            },
            stats: stats || {},
            walletHistory: walletSnapshots,
            dailyPerformance: dailyPerformance,
            recentTrades: recentTrades
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/leaderboard', adminAuthMiddleware, async (req, res) => {
    try {
        const { metric = 'totalGrowth', limit = 10 } = req.query;
        const allowedMetrics = ['totalGrowth', 'totalRealizedPnL', 'winningTrades', 'totalClosedTrades', 'peakGrowth'];
        
        if (!allowedMetrics.includes(metric)) {
            return res.status(400).json({ error: 'Invalid metric' });
        }
        
        const stats = await UserStatsModel.find({})
            .sort({ [metric]: -1 })
            .limit(parseInt(limit));
        
        const leaderboard = await Promise.all(stats.map(async (stat) => {
            const user = await UserModel.findById(stat.userId).select('name email');
            return {
                userId: stat.userId,
                name: user?.name || 'Unknown',
                email: user?.email || 'Unknown',
                metric: metric,
                value: stat[metric],
                totalGrowth: stat.totalGrowth,
                totalPnL: stat.totalRealizedPnL,
                tradesCount: stat.totalClosedTrades,
                winRate: stat.totalClosedTrades > 0 ? ((stat.winningTrades / stat.totalClosedTrades) * 100).toFixed(2) : 0
            };
        }));
        
        res.json({ metric, leaderboard });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/dashboard-stats', adminAuthMiddleware, async (req, res) => {
    try {
        const totalUsers = await UserModel.countDocuments();
        const liveTraders = await UserModel.countDocuments({ liveTradingEnabled: true });
        const usersWithKeys = await UserModel.countDocuments({ apiKey: { $ne: "" } });
        
        const allStats = await UserStatsModel.find({});
        
        const totalVolume = allStats.reduce((sum, s) => sum + (s.totalVolume || 0), 0);
        const totalFees = allStats.reduce((sum, s) => sum + (s.totalFeesPaid || 0), 0);
        const totalPnL = allStats.reduce((sum, s) => sum + (s.totalRealizedPnL || 0), 0);
        const positivePnLUsers = allStats.filter(s => (s.totalRealizedPnL || 0) > 0).length;
        
        const totalWallets = allStats.reduce((sum, s) => sum + (s.currentWalletBalance || 0), 0);
        const totalInitialWallets = allStats.reduce((sum, s) => sum + (s.initialWalletBalance || 0), 0);
        const totalGrowthPercent = totalInitialWallets > 0 ? ((totalWallets - totalInitialWallets) / totalInitialWallets) * 100 : 0;
        
        const activePositions = allStats.filter(s => s.currentDirection !== 'none').length;
        
        const topPerformers = [...allStats]
            .sort((a, b) => (b.totalGrowth || 0) - (a.totalGrowth || 0))
            .slice(0, 5)
            .map(s => ({
                userId: s.userId,
                name: s.name,
                growth: s.totalGrowth,
                pnl: s.totalRealizedPnL
            }));
        
        res.json({
            overview: {
                totalUsers,
                liveTraders,
                usersWithKeys,
                activePositions,
                totalVolume: totalVolume.toFixed(2),
                totalFees: totalFees.toFixed(2),
                totalPnL: totalPnL.toFixed(2),
                positivePnLUsers,
                negativePnLUsers: totalUsers - positivePnLUsers,
                totalWalletBalance: totalWallets.toFixed(2),
                totalInitialBalance: totalInitialWallets.toFixed(2),
                totalGrowthPercent: totalGrowthPercent.toFixed(2)
            },
            topPerformers
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/reset-user-stats/:userId', adminAuthMiddleware, async (req, res) => {
    try {
        await UserStatsModel.findOneAndDelete({ userId: req.params.userId });
        await WalletSnapshotModel.deleteMany({ userId: req.params.userId });
        await DailyPerformanceModel.deleteMany({ userId: req.params.userId });
        
        res.json({ success: true, message: 'User stats reset successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== ADMIN PANEL HTML ====================
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel - TradeBotPille</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Inter', sans-serif; background: #f5f5f5; }
        .admin-card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .stat-number { font-size: 2rem; font-weight: 800; font-family: 'JetBrains Mono', monospace; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .user-row:hover { background: #f9fafb; cursor: pointer; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black tracking-tight">ADMIN PANEL</h1>
                <p class="text-gray-500 text-sm">TradeBotPille DCA Engine - User Management & Analytics</p>
            </div>
            <div class="flex gap-3">
                <input type="password" id="adminToken" placeholder="Admin Token" class="px-4 py-2 border rounded-lg font-mono text-sm">
                <button onclick="authenticate()" class="bg-black text-white px-6 py-2 rounded-lg font-bold hover:bg-gray-800">Login</button>
            </div>
        </div>
        
        <div id="adminContent" style="display: none;">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div class="admin-card">
                    <p class="text-gray-500 text-xs uppercase font-bold mb-2">Total Users</p>
                    <p id="statTotalUsers" class="stat-number">0</p>
                </div>
                <div class="admin-card">
                    <p class="text-gray-500 text-xs uppercase font-bold mb-2">Total PnL</p>
                    <p id="statTotalPnL" class="stat-number">$0</p>
                </div>
                <div class="admin-card">
                    <p class="text-gray-500 text-xs uppercase font-bold mb-2">Total Wallet</p>
                    <p id="statTotalWallet" class="stat-number">$0</p>
                </div>
                <div class="admin-card">
                    <p class="text-gray-500 text-xs uppercase font-bold mb-2">Active Positions</p>
                    <p id="statActivePositions" class="stat-number">0</p>
                </div>
            </div>
            
            <div class="admin-card mb-8">
                <h2 class="text-lg font-black mb-4">🏆 Top Performers</h2>
                <div id="topPerformersList" class="space-y-2"></div>
            </div>
            
            <div class="admin-card">
                <h2 class="text-lg font-black mb-4">Registered Users</h2>
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="bg-gray-50 border-b">
                            <tr><th class="text-left p-3">User</th><th class="text-left p-3">Direction</th><th class="text-right p-3">ROI</th><th class="text-right p-3">Trades</th><th class="text-right p-3">Growth %</th><th class="text-right p-3">PnL</th><th class="text-right p-3">Wallet</th></tr>
                        </thead>
                        <tbody id="usersTableBody"></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let adminToken = localStorage.getItem('admin_token');
        if(adminToken) { document.getElementById('adminToken').value = adminToken; loadAdminDashboard(); }
        
        async function authenticate() {
            adminToken = document.getElementById('adminToken').value;
            localStorage.setItem('admin_token', adminToken);
            await loadAdminDashboard();
        }
        
        async function apiCall(endpoint) {
            const res = await fetch(endpoint, { headers: { 'X-Admin-Token': adminToken } });
            if (res.status === 403) { alert('Admin access denied'); document.getElementById('adminContent').style.display = 'none'; return null; }
            return res.json();
        }
        
        async function loadAdminDashboard() {
            if (!adminToken) return;
            const stats = await apiCall('/api/admin/dashboard-stats');
            if (!stats) return;
            document.getElementById('adminContent').style.display = 'block';
            document.getElementById('statTotalUsers').innerText = stats.overview.totalUsers;
            document.getElementById('statTotalPnL').innerHTML = (stats.overview.totalPnL >= 0 ? '+' : '') + '$' + stats.overview.totalPnL;
            document.getElementById('statTotalWallet').innerHTML = '$' + stats.overview.totalWalletBalance;
            document.getElementById('statActivePositions').innerText = stats.overview.activePositions;
            
            const performersHtml = stats.topPerformers.map(p => '<div class="flex justify-between p-3 bg-gray-50 rounded"><span class="font-bold">' + p.name + '</span><span class="text-green-600">+' + p.growth.toFixed(2) + '%</span></div>').join('');
            document.getElementById('topPerformersList').innerHTML = performersHtml || '<p>No data</p>';
            
            const users = await apiCall('/api/admin/users');
            if(users) {
                const tbody = document.getElementById('usersTableBody');
                tbody.innerHTML = users.users.map(u => '<tr class="user-row border-b" onclick="alert(\\'ID: ' + u._id + '\\')"><td class="p-3"><div class="font-bold">' + u.name + '</div><div class="text-xs text-gray-400">' + u.email + '</div></td><td class="p-3"><span class="px-2 py-1 rounded text-xs font-bold bg-gray-100">' + (u.stats.currentDirection || 'none').toUpperCase() + '</span></td><td class="p-3 text-right font-mono ' + (u.stats.currentROI >= 0 ? 'positive' : 'negative') + '">' + u.stats.currentROI.toFixed(2) + '%</td><td class="p-3 text-right font-mono">' + u.stats.totalClosedTrades + '</td><td class="p-3 text-right font-mono ' + (u.stats.totalGrowth >= 0 ? 'positive' : 'negative') + '">' + (u.stats.totalGrowth >= 0 ? '+' : '') + u.stats.totalGrowth.toFixed(2) + '%</td><td class="p-3 text-right font-mono ' + (u.stats.totalRealizedPnL >= 0 ? 'positive' : 'negative') + '">$' + u.stats.totalRealizedPnL.toFixed(2) + '</td><td class="p-3 text-right font-mono font-bold">$' + u.stats.currentWalletBalance.toFixed(2) + '</td></tr>').join('');
            }
        }
    </script>
</body>
</html>`);
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TradeBotPille | SHIB DCA Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root { --zinc-50: #fafafa; --zinc-100: #f4f4f5; --zinc-200: #e4e4e7; --zinc-800: #27272a; --zinc-950: #09090b; }
        body { font-family: 'Inter', sans-serif; background-color: var(--zinc-50); color: var(--zinc-950); }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .ui-card { background: #ffffff; border-radius: 12px; border: 1px solid var(--zinc-200); box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05); }
        .input-minimal { width: 100%; border: 1px solid var(--zinc-200); border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fff; }
        .input-minimal:focus { border-color: var(--zinc-950); }
        .btn-primary { background: var(--zinc-950); color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; transition: all 0.2s; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: none; }
        .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-secondary { background: #fff; color: var(--zinc-800); border: 1px solid var(--zinc-200); border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-secondary:hover { background: var(--zinc-50); }
        .status-pill { padding: 4px 10px; border-radius: 9999px; font-size: 10px; font-weight: 800; text-transform: uppercase; }
        .view-section { display: none; }
        .active-view { display: block; }
        button, [onclick], .cursor-pointer { cursor: pointer; }
        nav button { background: none; border: none; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

<header class="bg-white/70 backdrop-blur-xl border-b border-zinc-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3 cursor-pointer group" id="homeLogo">
            <div class="w-8 h-8 rounded bg-zinc-950 flex items-center justify-center shadow-lg group-hover:scale-110 transition">
                <span class="material-symbols-outlined text-white text-[18px]">bolt</span>
            </div>
            <div class="flex flex-col leading-tight">
                <span class="font-extrabold tracking-tighter text-base">TRADEBOT<span class="text-indigo-600">PILLE</span></span>
                <span class="text-[9px] uppercase font-bold text-zinc-400 tracking-widest">DCA Engine</span>
            </div>
        </div>
        <nav id="nav-public" class="flex items-center gap-2 text-sm">
            <button id="navBacktest" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950 transition">Backtest</button>
            <button id="navAnalytics" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950 transition">Stats</button>
            <div class="w-px h-4 bg-zinc-200 mx-2"></div>
            <button id="navLogin" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950 transition">Login</button>
            <button id="navRegister" class="btn-primary">Get Started</button>
        </nav>
        <nav id="nav-private" class="hidden items-center gap-4 text-sm">
            <div class="hidden md:flex flex-col items-end mr-2">
                <span id="nav-user-name" class="font-bold text-zinc-950"></span>
                <span class="text-[9px] text-zinc-400 font-bold uppercase tracking-tighter">Authorized Operator</span>
            </div>
            <button id="navDashboard" class="px-3 py-2 rounded-md hover:bg-zinc-100 transition font-bold text-zinc-600">Terminal</button>
            <button id="navSteps" class="px-3 py-2 rounded-md hover:bg-zinc-100 transition font-bold text-zinc-600">Steps</button>
            <button id="logoutBtn" class="px-3 py-2 text-red-500 font-bold hover:bg-red-50 rounded-md transition">Logout</button>
        </nav>
    </div>
</header>

<main class="flex-grow flex flex-col">
    <!-- HOME -->
    <section id="view-home" class="view-section active-view">
        <div class="max-w-4xl mx-auto px-4 pt-32 pb-24 text-center">
            <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-zinc-100 text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-8 border border-zinc-200">
                <span class="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span> Live SHIB DCA Execution
            </div>
            <h1 class="text-6xl md:text-8xl font-black tracking-tight mb-8 leading-[0.9]">DCA TRADING<br><span class="text-zinc-400 italic">WITH PRECISION.</span></h1>
            <p class="text-lg md:text-xl text-zinc-500 mb-12 max-w-2xl mx-auto font-medium leading-relaxed">A specialized DCA trading algorithm using 75x cross-leverage on HTX with configurable DCA triggers and daily growth rate.</p>
            <div class="flex flex-col sm:flex-row justify-center gap-4">
                <button id="homeGetStarted" class="btn-primary text-base px-8 py-4 shadow-xl shadow-indigo-200">Open Terminal <span class="material-symbols-outlined">trending_up</span></button>
                <button id="homeBacktest" class="btn-secondary text-base px-8 py-4">Explore Backtest</button>
            </div>
        </div>
    </section>

    <!-- ANALYTICS -->
    <section id="view-analytics" class="view-section max-w-5xl mx-auto px-4 py-20">
        <h2 class="text-4xl font-black mb-12 flex items-center gap-4 italic"><span class="material-symbols-outlined text-4xl">insights</span> PLATFORM ANALYTICS</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            <div class="ui-card p-8 border-b-4 border-b-zinc-950"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Live Connections</p><p id="stat-online" class="text-5xl font-mono font-black">0</p></div>
            <div class="ui-card p-8"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Platform Views</p><p id="stat-views" class="text-5xl font-mono font-black">0</p></div>
            <div class="ui-card p-8"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">Unique Ops</p><p id="stat-uniques" class="text-5xl font-mono font-black">0</p></div>
        </div>
        <div class="ui-card p-8"><h3 class="text-xs font-black mb-6 uppercase tracking-widest text-zinc-400">Live Viewport Distribution</h3><div id="stat-pages" class="divide-y divide-zinc-100"></div></div>
    </section>

    <!-- BACKTEST -->
    <section id="view-backtest" class="view-section max-w-7xl mx-auto px-4 py-16">
        <div class="grid lg:grid-cols-12 gap-8">
            <aside class="lg:col-span-3 space-y-6"><div class="ui-card p-6 sticky top-24"><h3 class="font-black text-sm uppercase tracking-widest mb-6 border-b pb-4">Backtest Config</h3><div class="space-y-4"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Data Span (Min)</label><input type="number" id="btTicks" class="input-minimal font-mono font-bold" value="5000"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DCA Trigger (%)</label><input type="number" id="btDcaTrigger" class="input-minimal font-mono font-bold" value="1.0" step="0.1"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DCA Multiplier</label><input type="number" id="btDcaMultiplier" class="input-minimal font-mono font-bold" value="2.0" step="0.1"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Start Contracts</label><input type="number" id="btStartContracts" class="input-minimal font-mono font-bold" value="1"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DGR Daily Growth (%)</label><input type="number" id="btDgr" class="input-minimal font-mono font-bold" value="0.0" step="0.1"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Direction</label><select id="btDirection" class="input-minimal font-mono font-bold"><option value="long">Long Only</option><option value="short">Short Only</option></select></div><div class="grid grid-cols-2 gap-2"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">TP %</label><input type="number" id="btTp" class="input-minimal font-mono text-green-600 font-bold" value="10.0"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">SL %</label><input type="number" id="btSl" class="input-minimal font-mono text-red-600 font-bold" value="-50.0"></div></div><button id="runBacktestBtn" class="btn-primary w-full py-4 mt-4">Execute Simulation</button></div></div></aside>
            <div class="lg:col-span-9 space-y-6"><div class="grid grid-cols-2 md:grid-cols-4 gap-4"><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Win Rate</p><p id="btResWinrate" class="text-3xl font-mono font-black text-indigo-600">-</p></div><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Net Yield</p><p id="btResPnl" class="text-3xl font-mono font-black">-</p></div><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Volume (Trades)</p><p id="btResTrades" class="text-3xl font-mono font-black">-</p></div><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Max Deposit</p><p id="btResDeposit" class="text-3xl font-mono font-black">-</p></div></div><div class="ui-card overflow-hidden"><div class="p-4 bg-zinc-50 border-b"><span class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Simulation Tape</span></div><div class="overflow-x-auto max-h-[600px]"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase text-zinc-400 border-b bg-white sticky top-0"><tr><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4">Exit Trigger</th><th class="p-4 text-right">Net PnL</th></tr></thead><tbody id="btTableBody" class="font-mono text-xs divide-y"></tbody><table></div></div></div>
        </div>
    </section>

    <!-- DASHBOARD -->
    <section id="view-dashboard" class="view-section max-w-[1440px] mx-auto px-4 sm:px-6 py-10">
        <div class="flex flex-col md:flex-row justify-between items-end mb-10 gap-6"><div><h2 class="text-4xl font-black tracking-tighter mb-2 italic">LIVE TERMINAL</h2><div class="flex items-center gap-3"><span id="statusBadge" class="status-pill">Waking...</span><span class="text-[10px] font-black text-zinc-400 uppercase flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">timer</span> Uptime: <span id="uptime" class="text-zinc-950">0s</span></span></div></div><div class="flex gap-3"><button id="settingsBtn" class="btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">settings</span> Config</button><button id="resetAccountBtn" class="btn-secondary bg-red-50 text-red-600 border-red-200 hover:bg-red-100 flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">factory_reset</span> Reset Account</button><button id="emergencyExitBtn" class="btn-secondary text-red-600 border-red-200 hover:bg-red-50 flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">cancel</span> Emergency Exit</button></div></div>
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-8"><div class="lg:col-span-8 space-y-8"><div class="grid grid-cols-2 md:grid-cols-4 gap-4"><div class="ui-card p-6 relative"><div class="absolute inset-y-0 left-0 w-1 bg-zinc-950"></div><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Global PnL</p><p id="netPnl" class="text-3xl font-mono font-black">$0.00</p><button id="resetMetricsBtn" class="absolute top-4 right-4 text-zinc-300 hover:text-zinc-950"><span class="material-symbols-outlined text-[16px]">restart_alt</span></button></div><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Wallet Core</p><p id="marginUsed" class="text-3xl font-mono font-black">$0.00</p></div><div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Live Delta</p><p id="activeRoi" class="text-3xl font-mono font-black text-zinc-400 italic">IDLE</p></div><div class="ui-card p-6 bg-zinc-950 border-zinc-950"><p class="text-[10px] font-black text-zinc-800 uppercase mb-1">Current Direction</p><div class="flex justify-between"><span id="directionValue" class="text-3xl font-mono font-black text-white">LONG</span><span id="dgrValue" class="text-[10px] font-black text-zinc-500 uppercase italic">DGR: 0%</span></div></div></div><div class="ui-card p-6 h-[450px] relative"><canvas id="priceChart"></canvas></div><div class="ui-card overflow-hidden"><div class="p-5 border-b"><h3 class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Exchange Execution Logs</h3></div><div class="overflow-x-auto"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase bg-zinc-50 border-b"><tr><th class="p-4">Time</th><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4">Trigger</th><th class="p-4 text-right">Net Return</th></tr></thead><tbody id="tradeHistoryBody" class="font-mono text-xs divide-y"></tbody></table></div></div></div><aside class="lg:col-span-4 space-y-8"><div class="ui-card p-8 border-t-4 border-t-indigo-600"><h3 class="text-sm font-black uppercase tracking-widest mb-8 flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">tune</span> DCA Parameters</h3><div class="space-y-6"><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">TP Target (%)</label><input type="number" id="tpPctSens" class="input-minimal w-24 text-right font-mono font-bold text-green-600"></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">SL Threshold (%)</label><input type="number" id="slPctSens" class="input-minimal w-24 text-right font-mono font-bold text-red-600"></div><hr><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">DCA Trigger (%)</label><input type="number" id="dcaTriggerSens" class="input-minimal w-24 text-right font-mono font-bold" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">DCA Multiplier</label><input type="number" id="dcaMultiplierSens" class="input-minimal w-24 text-right font-mono font-bold" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">Start Contracts</label><input type="number" id="startContractsSens" class="input-minimal w-24 text-right font-mono font-bold"></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">DGR Growth (%)</label><input type="number" id="dgrSens" class="input-minimal w-24 text-right font-mono font-bold" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">Direction</label><select id="directionSens" class="input-minimal w-24 text-right font-mono font-bold"><option value="long">LONG</option><option value="short">SHORT</option></select></div><div class="flex justify-between"><label class="text-xs font-bold text-zinc-500">Max Contracts</label><input type="number" id="maxContractsSens" class="input-minimal w-24 text-right font-mono font-bold"></div><button id="saveConfigBtn" class="btn-primary w-full py-4 mt-4 italic">Apply Config Settings</button></div></div></aside></div>
    </section>

    <!-- STEP HISTORY -->
    <section id="view-step-history" class="view-section max-w-4xl mx-auto px-4 py-20"><h2 class="text-4xl font-black mb-8 flex items-center gap-4 italic"><span class="material-symbols-outlined text-4xl">layers</span> DCA STEP TRACE</h2><div class="ui-card overflow-hidden"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase bg-zinc-950 text-white"><tr><th class="p-5">Step</th><th class="p-5">Action</th><th class="p-5">Price</th><th class="p-5">ROI %</th><th class="p-5 text-right">Time</th></tr></thead><tbody id="stepHistoryBody" class="font-mono text-xs divide-y"></tbody></table></div></section>

    <!-- SETTINGS -->
    <section id="view-settings" class="view-section max-w-xl mx-auto px-4 py-20"><div class="ui-card p-10 border-t-4 border-t-zinc-950"><h2 class="text-3xl font-black mb-8 italic">API INTEGRATION</h2><div class="space-y-8"><div class="flex items-center gap-4 p-5 bg-zinc-50 rounded-xl border-2 border-dashed border-zinc-200 cursor-pointer" id="liveToggleDiv"><input type="checkbox" id="liveTrade" class="w-5 h-5 accent-zinc-950 cursor-pointer"><label class="text-xs font-black uppercase tracking-widest cursor-pointer">Live Exchange Execution</label></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX Key</label><input type="password" id="apiKey" class="input-minimal font-mono"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX Secret</label><input type="password" id="apiSecret" class="input-minimal font-mono"></div><button id="saveApiKeysBtn" class="btn-primary w-full py-4 text-base italic">Establish Connection</button><p id="key-msg" class="text-center text-[10px] font-black uppercase tracking-widest"></p></div></div></section>

    <!-- LOGIN -->
    <section id="view-login" class="view-section max-w-md mx-auto px-4 py-32"><div class="ui-card p-10"><h2 class="text-3xl font-black mb-8 italic">Welcome Back.</h2><div class="space-y-6"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Operator Email</label><input type="email" id="login-email" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Password</label><input type="password" id="login-pass" class="input-minimal"></div><button id="doLoginBtn" class="btn-primary w-full py-4">Authenticate Operator</button><p id="login-err" class="text-red-500 text-[10px] font-black text-center uppercase"></p></div></div></section>

    <!-- REGISTER -->
    <section id="view-register" class="view-section max-w-md mx-auto px-4 py-32"><div class="ui-card p-10"><h2 class="text-3xl font-black mb-8 italic">New Operator.</h2><div class="space-y-6"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Name</label><input type="text" id="reg-name" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Email</label><input type="email" id="reg-email" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Password</label><input type="password" id="reg-pass" class="input-minimal"></div><button id="doRegisterBtn" class="btn-primary w-full py-4">Initialize Command</button><p id="reg-err" class="text-red-500 text-[10px] font-black text-center uppercase"></p></div></div></section>
</main>

<footer class="bg-white border-t border-zinc-200 py-12"><div class="max-w-7xl mx-auto px-4 text-center"><p class="text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-2">&copy; <script>document.write(new Date().getFullYear())</script> TRADEBOTPILLE DCA ENGINE</p><p class="text-[9px] text-zinc-300 font-bold uppercase tracking-tighter">Geometric trading carries absolute risk. Non-custodial execution strictly for education.</p></div></footer>

<script>
(function() {
    // Global variables
    let authToken = localStorage.getItem('bot_token');
    let chartPoints = 800;
    let sessionTrackId = localStorage.getItem('rdca_visitor_id');
    if (!sessionTrackId) { sessionTrackId = Math.random().toString(36).substring(2, 15); localStorage.setItem('rdca_visitor_id', sessionTrackId); }
    let currentPageView = 'home';
    let dashLoop = null;
    let settingsLoaded = false;
    let lastTradesCount = -1;
    
    // Chart initialization
    const ctx = document.getElementById("priceChart").getContext("2d");
    const priceChart = new Chart(ctx, { type: "line", data: { labels: [], datasets: [{ label: "Price", data: [], borderColor: "#09090b", borderWidth: 2, pointRadius: 0, tension: 0.1 }] }, options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false }, y: { display: true, position: 'left', grid: { display: false }, ticks: { font: { family: "JetBrains Mono", size: 9 } } } }, plugins: { legend: { display: false } } } });
    
    // Navigation function
    function navigateTo(viewId) {
        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
        const targetView = document.getElementById('view-' + viewId);
        if (targetView) targetView.classList.add('active-view');
        window.scrollTo(0, 0);
        currentPageView = viewId;
        pingAnalytics(true);
        if (viewId === 'dashboard' && authToken) initDashboard();
        if (viewId === 'analytics') fetchAnalyticsData();
    }
    
    // Analytics
    async function pingAnalytics(isViewRecord) { 
        try { await fetch('/api/analytics/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionTrackId, page: currentPageView, isView: isViewRecord }) }); } catch(e) {} 
    }
    
    // API caller
    async function doAPI(endpoint, method, body) { 
        const headers = { 'Content-Type': 'application/json' }; 
        if (authToken) headers['Authorization'] = authToken; 
        const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined }); 
        const data = await res.json(); 
        if (res.status === 401) { logout(); return { error: "Session expired" }; } 
        return data; 
    }
    
    // Auth UI toggle
    function toggleAuthUI() { 
        if (authToken) { 
            document.getElementById('nav-public').classList.add('hidden'); 
            document.getElementById('nav-private').classList.remove('hidden'); 
            document.getElementById('nav-private').classList.add('flex'); 
        } else { 
            document.getElementById('nav-public').classList.remove('hidden'); 
            document.getElementById('nav-private').classList.add('hidden'); 
            document.getElementById('nav-private').classList.remove('flex'); 
        } 
    }
    
    // Logout
    function logout() { 
        localStorage.removeItem('bot_token'); 
        authToken = null; 
        toggleAuthUI(); 
        navigateTo('home'); 
    }
    
    // Dashboard functions
    async function initDashboard() { 
        const me = await doAPI('/api/user/me', 'GET'); 
        if(!me.error) { 
            document.getElementById('nav-user-name').innerText = me.name; 
            const liveCheckbox = document.getElementById('liveTrade');
            if(liveCheckbox) liveCheckbox.checked = me.liveTradingEnabled; 
            const apiKeyInput = document.getElementById('apiKey');
            if(apiKeyInput) apiKeyInput.value = me.apiKey; 
        } 
        const history = await doAPI('/api/chart-history', 'GET'); 
        if(!history.error && history.length) { 
            priceChart.data.labels = history.map(()=>""); 
            priceChart.data.datasets[0].data = history.map(p=>p.priceMid); 
            priceChart.update(); 
        } 
        if(dashLoop) clearInterval(dashLoop); 
        dashLoop = setInterval(fetchMetrics, 300); 
    }
    
    async function fetchMetrics() { 
        if(currentPageView !== 'dashboard' && currentPageView !== 'step-history') return; 
        const data = await doAPI('/api/data', 'GET'); 
        if(data.error) return; 
        
        if (currentPageView === 'step-history') { 
            const tbody = document.getElementById("stepHistoryBody"); 
            tbody.innerHTML = (data.activePositions[0]?.stepHistory || []).map(s => '<tr class="border-b"><td class="p-5 font-black">'+s.step+'</td><td class="p-5 font-black '+(s.type==='DCA'?'text-red-500':'text-indigo-500')+'">'+s.type+'</td><td class="p-5">$'+s.price.toFixed(8)+'</td><td class="p-5 font-black '+(s.roi>=0?'text-green-600':'text-red-600')+'">'+s.roi.toFixed(2)+'%</td><td class="p-5 text-right text-zinc-400">'+new Date(s.time).toLocaleTimeString()+'</td></tr>').join('') || '<tr><td colspan="5" class="p-20 text-center font-black uppercase text-zinc-300">No Trace Data</td></tr>'; 
        } 
        
        if(!settingsLoaded && data.config) { 
            document.getElementById("tpPctSens").value = data.config.takeProfitPct; 
            document.getElementById("slPctSens").value = data.config.stopLossPct; 
            document.getElementById("dcaTriggerSens").value = data.config.dcaTriggerPct || 1.0; 
            document.getElementById("dcaMultiplierSens").value = data.config.dcaMultiplier || 2.0; 
            document.getElementById("startContractsSens").value = data.config.startContracts || 1; 
            document.getElementById("dgrSens").value = data.config.dgrDailyGrowthRate || 0.0; 
            document.getElementById("directionSens").value = data.config.manualDirection || 'long'; 
            document.getElementById("maxContractsSens").value = data.config.maxContracts || 100; 
            settingsLoaded = true; 
        } 
        
        document.getElementById("uptime").innerText = data.uptime + "s"; 
        document.getElementById("netPnl").innerText = "$" + (data.metrics?.totalNetPnl || 0).toFixed(4); 
        document.getElementById("netPnl").className = "text-3xl font-mono font-black tracking-tight " + ((data.metrics?.totalNetPnl || 0) >= 0 ? "text-green-600" : "text-red-600"); 
        document.getElementById("marginUsed").innerText = "$" + Number(data.walletBalance || 0).toFixed(4); 
        
        const badge = document.getElementById("statusBadge"); 
        if(data.activePositions && data.activePositions.length > 0) { 
            const p = data.activePositions[0]; 
            badge.innerText = p.isPaper ? "PAPER ACTIVE" : "LIVE ACTIVE"; 
            badge.className = "status-pill bg-zinc-950 text-white"; 
            document.getElementById("activeRoi").innerText = (p.exchangeROI || 0).toFixed(2) + "%"; 
            document.getElementById("activeRoi").className = "text-3xl font-mono font-black tracking-tight " + ((p.exchangeROI || 0) >= 0 ? "text-green-600" : "text-red-600"); 
        } else { 
            badge.innerText = data.liveTradingEnabled ? "LIVE SCANNING" : "PAPER STANDBY"; 
            badge.className = "status-pill bg-zinc-100 text-zinc-400"; 
            document.getElementById("activeRoi").innerText = "IDLE"; 
            document.getElementById("activeRoi").className = "text-3xl font-mono font-black tracking-tight text-zinc-200"; 
        } 
        
        if(data.config) { 
            document.getElementById('directionValue').innerText = (data.config.manualDirection || 'LONG').toUpperCase(); 
            document.getElementById('dgrValue').innerText = 'DGR: ' + (data.config.dgrDailyGrowthRate || 0) + '%'; 
        } 
        
        if(data.metrics && data.metrics.totalTradesCount !== lastTradesCount && data.metrics.trades) { 
            lastTradesCount = data.metrics.totalTradesCount; 
            const tbody = document.getElementById("tradeHistoryBody"); 
            tbody.innerHTML = [...data.metrics.trades].reverse().slice(0, 10).map(t => '<tr class="border-b"><td class="p-4 text-zinc-400">'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="p-4 font-black '+(t.side==='long'?'text-green-600':'text-red-600')+'">'+t.side.toUpperCase()+'</td><td class="p-4 font-bold">'+t.contracts.toLocaleString()+'</td><td class="p-4 text-[9px] font-black uppercase text-zinc-300">'+t.exitReason+'</td><td class="p-4 text-right font-black '+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$' + t.netPnl.toFixed(4) + 'NonNull(',') 
        } 
        
        if(data.binance && data.binance.mid) { 
            priceChart.data.labels.push(""); 
            priceChart.data.datasets[0].data.push(data.binance.mid); 
            if(priceChart.data.labels.length > chartPoints) { 
                priceChart.data.labels.shift(); 
                priceChart.data.datasets[0].data.shift(); 
            } 
            priceChart.update(); 
        } 
    }
    
    // Action functions
    async function runBacktest() { 
        document.getElementById('btResTrades').innerText = "..."; 
        const payload = { 
            ticks: document.getElementById('btTicks').value, 
            tpPct: document.getElementById('btTp').value, 
            slPct: document.getElementById('btSl').value, 
            dcaTriggerPct: document.getElementById('btDcaTrigger').value, 
            dcaMultiplier: document.getElementById('btDcaMultiplier').value, 
            startContracts: document.getElementById('btStartContracts').value, 
            dgrDailyGrowthRate: document.getElementById('btDgr').value, 
            manualDirection: document.getElementById('btDirection').value, 
            maxContracts: 100 
        }; 
        const res = await doAPI('/api/backtest', 'POST', payload); 
        if(res.error) return; 
        document.getElementById('btResWinrate').innerText = res.winRate + "%"; 
        document.getElementById('btResPnl').innerText = "$" + res.netPnl.toFixed(4); 
        document.getElementById('btResTrades').innerText = res.totalTradesCount; 
        document.getElementById('btResDeposit').innerText = "$" + (res.depositNeeded || 0).toFixed(4); 
        const tbody = document.getElementById('btTableBody'); 
        tbody.innerHTML = ""; 
        [...res.trades].reverse().forEach(t => { 
            tbody.innerHTML += '<tr class="border-b"><td class="p-4 font-black ' + (t.side==='long'?'text-green-600':'text-red-600') + '">' + t.side.toUpperCase() + '</td><td class="p-4">' + t.contracts + '</td><td class="p-4 text-[9px] uppercase font-bold text-zinc-400">' + t.exitReason + '</td><td class="p-4 text-right font-black ' + (t.netPnl>=0?'text-green-600':'text-red-600') + '">$' + t.netPnl.toFixed(4) + 'NonNull(',') 
        }); 
    }
    
    async function doLogin() { 
        const res = await doAPI('/api/auth/login', 'POST', { email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value }); 
        if (res.error) document.getElementById('login-err').innerText = res.error; 
        else { authToken = res.token; localStorage.setItem('bot_token', authToken); toggleAuthUI(); navigateTo('dashboard'); } 
    }
    
    async function doRegister() { 
        const res = await doAPI('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value }); 
        if (res.error) document.getElementById('reg-err').innerText = res.error; 
        else { authToken = res.token; localStorage.setItem('bot_token', authToken); toggleAuthUI(); navigateTo('dashboard'); } 
    }
    
    async function resetAccount() { 
        if(confirm("⚠️ WARNING: This will reset your account to a clean state!")) { 
            const res = await doAPI('/api/user/reset-account', 'POST'); 
            if(res.error) alert("Reset failed: " + res.error); 
            else { alert("✅ Account reset successfully!"); if(dashLoop) clearInterval(dashLoop); setTimeout(() => initDashboard(), 1000); } 
        } 
    }
    
    function handleLiveToggle() { 
        const cb = document.getElementById('liveTrade'); 
        cb.checked = !cb.checked; 
    }
    
    async function saveApiKeys() { 
        const res = await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked }); 
        document.getElementById('key-msg').innerText = res.error ? res.error : "KEYS SECURED"; 
        if(!res.error) setTimeout(() => navigateTo('dashboard'), 1500); 
    }
    
    async function saveConfig() { 
        const payload = { 
            tpPct: document.getElementById("tpPctSens").value, 
            slPct: document.getElementById("slPctSens").value, 
            dcaTriggerPct: document.getElementById("dcaTriggerSens").value, 
            dcaMultiplier: document.getElementById("dcaMultiplierSens").value, 
            startContracts: document.getElementById("startContractsSens").value, 
            dgrDailyGrowthRate: document.getElementById("dgrSens").value, 
            manualDirection: document.getElementById("directionSens").value, 
            maxContracts: document.getElementById("maxContractsSens").value 
        }; 
        await doAPI('/api/user/config', 'POST', payload); 
        alert("CONFIG SYNCED"); 
    }
    
    async function closeAll() { 
        if(confirm("ABORT ALL TRADES?")) await doAPI('/api/close-all', 'POST'); 
    }
    
    async function resetMetrics() { 
        if(confirm("PURGE TRADE HISTORY?")) { 
            await doAPI('/api/user/reset-metrics', 'POST'); 
            lastTradesCount = -1; 
            fetchMetrics(); 
        } 
    }
    
    async function fetchAnalyticsData() { 
        if(currentPageView !== 'analytics') return; 
        const data = await (await fetch('/api/analytics/stats')).json(); 
        document.getElementById('stat-online').innerText = data.online; 
        document.getElementById('stat-views').innerText = data.views; 
        document.getElementById('stat-uniques').innerText = data.uniques; 
        document.getElementById('stat-pages').innerHTML = Object.entries(data.pages).map(([n, c]) => '<div class="flex justify-between p-4"><span class="font-black text-[10px] uppercase tracking-widest text-zinc-500">'+n+'</span><span class="font-mono font-bold">'+c+' OPS</span></div>').join(''); 
    }
    
    // Set up event listeners
    function setupEventListeners() {
        // Navigation buttons
        document.getElementById('homeLogo')?.addEventListener('click', () => navigateTo('home'));
        document.getElementById('navBacktest')?.addEventListener('click', () => navigateTo('backtest'));
        document.getElementById('navAnalytics')?.addEventListener('click', () => navigateTo('analytics'));
        document.getElementById('navLogin')?.addEventListener('click', () => navigateTo('login'));
        document.getElementById('navRegister')?.addEventListener('click', () => navigateTo('register'));
        document.getElementById('navDashboard')?.addEventListener('click', () => navigateTo('dashboard'));
        document.getElementById('navSteps')?.addEventListener('click', () => navigateTo('step-history'));
        document.getElementById('logoutBtn')?.addEventListener('click', logout);
        
        // Home buttons
        document.getElementById('homeGetStarted')?.addEventListener('click', () => navigateTo('register'));
        document.getElementById('homeBacktest')?.addEventListener('click', () => navigateTo('backtest'));
        
        // Dashboard buttons
        document.getElementById('settingsBtn')?.addEventListener('click', () => navigateTo('settings'));
        document.getElementById('resetAccountBtn')?.addEventListener('click', resetAccount);
        document.getElementById('emergencyExitBtn')?.addEventListener('click', closeAll);
        document.getElementById('resetMetricsBtn')?.addEventListener('click', resetMetrics);
        document.getElementById('saveConfigBtn')?.addEventListener('click', saveConfig);
        
        // Backtest button
        document.getElementById('runBacktestBtn')?.addEventListener('click', runBacktest);
        
        // Auth buttons
        document.getElementById('doLoginBtn')?.addEventListener('click', doLogin);
        document.getElementById('doRegisterBtn')?.addEventListener('click', doRegister);
        
        // Settings buttons
        document.getElementById('liveToggleDiv')?.addEventListener('click', handleLiveToggle);
        document.getElementById('saveApiKeysBtn')?.addEventListener('click', saveApiKeys);
    }
    
    // Initialize
    setInterval(pingAnalytics, 10000);
    setInterval(fetchAnalyticsData, 4000);
    setupEventListeners();
    toggleAuthUI();
    
    if(authToken) { 
        navigateTo('dashboard'); 
    } else { 
        navigateTo('home'); 
    }
})();
</script>
</body>
</html>`);
});

// ==================== APP INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
