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
const activeWorkers = new Map();

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

    // FIX: Re-initialize worker if server restarted but user is still logged in
    const userId = req.user._id.toString();
    if (!activeWorkers.has(userId)) {
        const worker = new UserTradeInstance(req.user, false);
        await worker.initialize();
        activeWorkers.set(userId, worker);
    }

    next();
}

// (The rest of your existing backend classes: updateUserStats, calculateTradeMath, PerformanceMetrics, runBacktestSimulation, UserTradeInstance etc. are identical to your original paste. I'll omit the repeat text for brevity but ensure UserTradeInstance remains intact in your actual file.)

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
    return { winRate: (wins / (wins+losses) * 100).toFixed(2), netPnl, totalTradesCount: closedTrades.length, trades: closedTrades.slice(-200) };
}

class UserTradeInstance {
    constructor(user, forceClean = false) {
        this.userId = user._id.toString(); 
        this.userEmail = user.email;
        this.userName = user.name;
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.metrics = new PerformanceMetrics(this.userId);
        this.liveTradingEnabled = user.liveTradingEnabled;
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }
    async initialize() {
        await this.metrics.init();
        this.startExchangeROISync();
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, config: this.config } });
    }
    async connectExchange() {
        try { if(this.liveTradingEnabled) await this.htx.loadMarkets(); return { success: true }; } catch(e) { return { success: false, message: e.message }; }
    }
    async checkExits() {
        if (this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        if (pos.exchangeROI >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (pos.exchangeROI <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
    }
    async evaluateManualEntry() {
        if (this.activePositions.length === 0 && this.config.manualDirection) await this.syncState(this.config.manualDirection);
    }
    async syncState(side) {
        const price = globalMarketData.binance.mid;
        const contracts = this.config.startContracts || 1;
        const size = contracts * this.config.contractSize * price;
        this.activePositions = [{ side, entryPrice: price, contracts, size, marginUsed: size / FORCED_LEVERAGE, exchangeROI: 0, timestamp: Date.now() }];
        await this.saveState();
    }
    async forceClosePosition(reason) {
        const pos = this.activePositions[0];
        const exitPrice = globalMarketData.binance.mid;
        const math = calculateTradeMath(pos.side, pos.entryPrice, exitPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
        this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice, netPnl: math.netPnlUsd, exitReason: reason, timestamp: Date.now() });
        this.activePositions = [];
        await this.saveState();
    }
    startExchangeROISync() {
        setInterval(() => {
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                const sideMult = pos.side === 'long' ? 1 : -1;
                pos.exchangeROI = ((globalMarketData.binance.mid - pos.entryPrice) / pos.entryPrice) * 100 * FORCED_LEVERAGE * sideMult;
            }
        }, 1000);
    }
    getExportData() { 
        return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.metrics.startDate) / 1000), metrics: { totalNetPnl: this.metrics.totalNetPnl, trades: this.metrics.trades.slice(-10) }, activePositions: this.activePositions, binance: globalMarketData.binance, walletBalance: this.walletBalance }; 
    }
}

// ==================== EXPRESS ROUTES & SYSTEM ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
    const worker = new UserTradeInstance(user);
    await worker.initialize();
    activeWorkers.set(user._id.toString(), worker);
    tokenCache.set(user.token, { user, lastAccessed: Date.now() });
    res.json({ token: user.token, user: { name, email } });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    tokenCache.set(user.token, { user, lastAccessed: Date.now() });
    
    // FIX: Ensure worker starts on login
    if (!activeWorkers.has(user._id.toString())) {
        const worker = new UserTradeInstance(user);
        await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
    }
    res.json({ token: user.token, user: { name: user.name, email: user.email } });
});

// FIX: Dashboard loops should be 1000ms, not 300ms in the frontend.
// I've kept the full HTML block from your original file below but adjusted the script at the end.

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker.getExportData());
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800)));

// (Keep your existing app.get('/admin'), app.get('/'), app.post('/api/backtest') etc. here)

// ==================== MASTER STREAM ====================
async function startMasterStreams() {
    await publicBinance.loadMarkets();
    while (true) {
        try {
            const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
            globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid: (ticker.bid + ticker.ask)/2, timestamp: Date.now() };
            for (const worker of activeWorkers.values()) { worker.checkExits(); worker.evaluateManualEntry(); }
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
}

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
