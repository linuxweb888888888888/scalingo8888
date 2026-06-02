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
    secondAccount: { type: Object, default: { apiKey: "", apiSecret: "", liveTradingEnabled: false, config: {}, activePosition: null, lastCloseTime: 0 } }
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, accountId: { type: String, default: "main" }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, grossRoiPct: Number, roiPct: Number, 
    netPnl: Number, feeCost: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V8', new mongoose.Schema({
    priceMid: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
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
    takeProfitPct: 10.0, stopLossPct: -50.0, 
    dcaTriggerPct: 1.0, dcaMultiplier: 2.0, 
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

function calculateDGRAdjustment(dgrDailyGrowthRate, daysActive) {
    if (dgrDailyGrowthRate <= 0) return 1.0;
    return Math.pow(1 + (dgrDailyGrowthRate / 100), daysActive);
}

// ==================== METRICS ENGINE ====================
class PerformanceMetrics {
    constructor(userId, accountId = "main") {
        this.userId = userId;
        this.accountId = accountId;
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
        this.initialWalletBalance = 0;
        this.currentWalletBalance = 0;
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId, accountId: this.accountId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; if (!trade.timestamp) trade.timestamp = Date.now();
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; 
        this.totalFees += trade.feeCost || 0; 
        this.totalRoiPct += trade.roiPct || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId, accountId: this.accountId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
    getDaysActive() { return (Date.now() - this.startDate) / (1000 * 60 * 60 * 24); }
    getGrowthPct() {
        if (this.initialWalletBalance <= 0) return 0;
        return ((this.currentWalletBalance - this.initialWalletBalance) / this.initialWalletBalance) * 100;
    }
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
    const { dcaTriggerPct=1.0, dcaMultiplier=2.0, startContracts=1, dgrDailyGrowthRate=0.0, manualDirection='long' } = config;
    const maxContracts = config.maxContracts !== undefined ? Number(config.maxContracts) : 100;
    
    let totalDaysSimulated = (ticks[ticks.length - 1].timestamp - ticks[0].timestamp) / (1000 * 60 * 60 * 24);
    let dgrAdjustment = calculateDGRAdjustment(dgrDailyGrowthRate, totalDaysSimulated);
    
    let priceBuffer = [];
    const totalSpanMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;

    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;

        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) {
            priceBuffer.push(price); if (priceBuffer.length > 500) priceBuffer.shift();
        }
        
        if (ticks.indexOf(tick) % 500 === 0) {
            await new Promise(resolve => setImmediate(resolve));
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
                netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
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
    constructor(user, accountType = "main") {
        this.userId = user._id.toString(); 
        this.accountType = accountType;
        
        if (accountType === "main") {
            this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
            this.liveTradingEnabled = user.liveTradingEnabled;
            this.apiKey = user.apiKey;
            this.apiSecret = user.apiSecret;
            this.activePositions = user.activePosition ? [user.activePosition] : [];
            this.lastCloseTime = user.lastCloseTime || 0;
        } else {
            this.config = { ...BASE_CONFIG, ...(user.secondAccount?.config || {}) };
            this.liveTradingEnabled = user.secondAccount?.liveTradingEnabled || false;
            this.apiKey = user.secondAccount?.apiKey || "";
            this.apiSecret = user.secondAccount?.apiSecret || "";
            this.activePositions = user.secondAccount?.activePosition ? [user.secondAccount.activePosition] : [];
            this.lastCloseTime = user.secondAccount?.lastCloseTime || 0;
        }
        
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) {
            this.config.htxSymbol = 'SHIB/USDT:USDT';
            this.config.binanceSymbol = '1000SHIB/USDT:USDT';
        }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.config.marginMode = 'cross'; 

        this.startTime = Date.now(); 
        this.metrics = new PerformanceMetrics(this.userId, accountType);
        this.isTrading = false; 
        this.lastEvalPrice = 0;
        this.walletBalance = 0;
        this.initialWalletBalance = 0;

        this.applyUserKeys();
    }

    applyUserKeys() {
        const key = this.apiKey || "demo", secret = this.apiSecret || "demo";
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

    async saveState(userDoc) {
        if (this.accountType === "main") {
            userDoc.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
            userDoc.lastCloseTime = this.lastCloseTime;
            userDoc.config = this.config;
            userDoc.liveTradingEnabled = this.liveTradingEnabled;
            userDoc.apiKey = this.apiKey;
            userDoc.apiSecret = this.apiSecret;
        } else {
            if (!userDoc.secondAccount) {
                userDoc.secondAccount = {};
            }
            userDoc.secondAccount.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
            userDoc.secondAccount.lastCloseTime = this.lastCloseTime;
            userDoc.secondAccount.config = this.config;
            userDoc.secondAccount.liveTradingEnabled = this.liveTradingEnabled;
            userDoc.secondAccount.apiKey = this.apiKey;
            userDoc.secondAccount.apiSecret = this.apiSecret;
        }
        await userDoc.save();
        
        const cacheEntry = tokenCache.get(this.userId);
        if (cacheEntry) {
            if (this.accountType === "main") {
                cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
                cacheEntry.user.liveTradingEnabled = this.liveTradingEnabled;
                cacheEntry.user.apiKey = this.apiKey;
            } else {
                if (!cacheEntry.user.secondAccount) {
                    cacheEntry.user.secondAccount = {};
                }
                cacheEntry.user.secondAccount.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
                cacheEntry.user.secondAccount.liveTradingEnabled = this.liveTradingEnabled;
                cacheEntry.user.secondAccount.apiKey = this.apiKey;
            }
            cacheEntry.lastAccessed = Date.now();
        }
    }

    async connectExchange() {
        try {
            if (this.liveTradingEnabled && this.apiKey && this.apiKey !== "demo" && this.apiSecret && this.apiSecret !== "demo") {
                console.log(`[${this.accountType}] Connecting to HTX...`);
                await this.htx.loadMarkets(); 
                
                try { 
                    await this.htx.setMarginMode('cross', this.config.htxSymbol); 
                } catch(e) {}
                
                try { 
                    await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); 
                } catch(e) {}

                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts && p.contracts > 0);
                
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) {
                        entryP = entryP * 1000;
                    }
                    
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    const marginUsed = sizeUsd / FORCED_LEVERAGE;
                    
                    this.activePositions = [{
                        id: Date.now(),
                        side: openPos.side,
                        entryPrice: entryP,
                        contracts: openPos.contracts,
                        size: sizeUsd,
                        marginUsed: marginUsed,
                        exchangeROI: openPos.percentage || 0,
                        exchangePnl: openPos.unrealizedPnl || 0,
                        entryTime: Date.now(),
                        isPaper: false,
                        lastDcaTime: 0,
                        dcaStep: 0,
                        stepHistory: []
                    }];
                    
                    this.metrics.updateMaxMargin(this.activePositions[0].marginUsed);
                    console.log(`[${this.accountType}] Found position: ${openPos.side} ROI: ${(openPos.percentage || 0).toFixed(2)}%`);
                    
                    const user = await UserModel.findById(this.userId);
                    if (user) await this.saveState(user);
                } else {
                    this.activePositions = [];
                    const user = await UserModel.findById(this.userId);
                    if (user) await this.saveState(user);
                }
                
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    if (bal && bal.total && bal.total.USDT !== undefined) {
                        this.walletBalance = bal.total.USDT;
                        this.initialWalletBalance = this.walletBalance;
                        this.metrics.initialWalletBalance = this.initialWalletBalance;
                    }
                } catch(e) {}
                
                return { success: true };
            } else {
                this.liveTradingEnabled = false;
                this.initialWalletBalance = 1000;
                this.walletBalance = 1000;
                this.metrics.initialWalletBalance = 1000;
                return { success: true };
            }
        } catch (error) { 
            console.log(`[${this.accountType}] Init Error:`, error.message); 
            this.liveTradingEnabled = false;
            this.initialWalletBalance = 1000;
            this.walletBalance = 1000;
            const user = await UserModel.findById(this.userId);
            if (user) await this.saveState(user);
            return { success: false, message: error.message }; 
        }
    }

    async evaluateManualEntry() {
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        try {
            let signal = this.config.manualDirection === 'long' ? 'long' : (this.config.manualDirection === 'short' ? 'short' : null);
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    await this.forceClosePosition("MANUAL_FLIP");
                    setTimeout(() => this.syncState(signal), 500);
                }
            } else {
                if (signal) {
                    await this.syncState(signal);
                }
            }
        } catch (e) {
            console.error(`[${this.accountType}] Eval Error:`, e.message);
        }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        
        try {
            const pos = this.activePositions[0];
            
            let effectiveRoi = 0;
            if (this.liveTradingEnabled && !pos.isPaper && this.apiKey && this.apiKey !== "demo") {
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
             console.error(`[${this.accountType}] Exit Error:`, e.message);
        }
    }

    async addDcaPosition() {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            
            let dgrAdjustment = calculateDGRAdjustment(this.config.dgrDailyGrowthRate || 0, this.metrics.getDaysActive());
            let multiplier = this.config.dcaMultiplier || 2.0;
            let baseC = this.config.startContracts || 1;
            let step = pos.dcaStep || 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step) * dgrAdjustment)), 10);
            
            const maxC = this.config.maxContracts || 100;
            if (Number(pos.contracts) + contractsToAdd > maxC) {
                pos.lastDcaTime = Date.now();
                const user = await UserModel.findById(this.userId);
                await this.saveState(user);
                this.isTrading = false;
                return; 
            }

            pos.lastDcaTime = Date.now();
            const user = await UserModel.findById(this.userId);
            await this.saveState(user);
            
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled && this.apiKey && this.apiKey !== "demo") {
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) {
                        realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
                    }
                } catch(e) {
                    console.error(`[${this.accountType}] DCA Error:`, e.message);
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
            const userFinal = await UserModel.findById(this.userId);
            await this.saveState(userFinal);
            console.log(`[${this.accountType}] DCA Executed Step ${pos.dcaStep}, Added ${contractsToAdd} contracts`);
        } catch (err) {
            console.error(`[${this.accountType}] DCA Error:`, err.message);
        } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled || !this.apiKey || this.apiKey === "demo"; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            
            let baseC = Number(this.config.startContracts) || 1;
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
            const user = await UserModel.findById(this.userId);
            await this.saveState(user);
            console.log(`[${this.accountType}] OPENED: ${targetSide.toUpperCase()} at $${executionPrice}`);
        } catch (err) { 
            console.error(`[${this.accountType}] Open Error:`, err.message); 
            this.activePositions = []; 
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

            if (!snapPos.isPaper && this.liveTradingEnabled && this.apiKey && this.apiKey !== "demo") {
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
            
            this.lastCloseTime = Date.now(); 
            const user = await UserModel.findById(this.userId);
            await this.saveState(user);
            console.log(`[${this.accountType}] CLOSED: ${reason}`);
        } catch (err) {
            console.error(`[${this.accountType}] Close Error:`, err.message);
        } finally { this.isTrading = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            try {
                if (this.liveTradingEnabled && this.apiKey && this.apiKey !== "demo" && this.apiSecret && this.apiSecret !== "demo") {
                    try {
                        const bal = await this.htx.fetchBalance({ type: 'swap' });
                        if (bal && bal.total && bal.total.USDT !== undefined) {
                            this.walletBalance = bal.total.USDT;
                            if (this.initialWalletBalance === 0 && this.walletBalance > 0) {
                                this.initialWalletBalance = this.walletBalance;
                                this.metrics.initialWalletBalance = this.initialWalletBalance;
                            }
                            this.metrics.currentWalletBalance = this.walletBalance;
                        }
                    } catch(e) {}
                    
                    try {
                        const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                        const openPos = positions.find(p => p.contracts && p.contracts > 0);
                        
                        if (openPos) {
                            let entryP = openPos.entryPrice;
                            if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) {
                                entryP = entryP * 1000;
                            }
                            
                            if (this.activePositions.length === 0) {
                                const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                                const marginUsed = sizeUsd / FORCED_LEVERAGE;
                                this.activePositions = [{
                                    id: Date.now(),
                                    side: openPos.side,
                                    entryPrice: entryP,
                                    contracts: openPos.contracts,
                                    size: sizeUsd,
                                    marginUsed: marginUsed,
                                    exchangeROI: openPos.percentage || 0,
                                    exchangePnl: openPos.unrealizedPnl || 0,
                                    entryTime: Date.now(),
                                    isPaper: false,
                                    lastDcaTime: 0,
                                    dcaStep: 0,
                                    stepHistory: []
                                }];
                            } else {
                                this.activePositions[0].entryPrice = entryP;
                                this.activePositions[0].exchangeROI = openPos.percentage || 0;
                                this.activePositions[0].exchangePnl = openPos.unrealizedPnl || 0;
                                this.activePositions[0].contracts = openPos.contracts;
                            }
                            
                            const user = await UserModel.findById(this.userId);
                            if (user) await this.saveState(user);
                            return;
                        } else {
                            if (this.activePositions.length > 0) {
                                this.activePositions = [];
                                const user = await UserModel.findById(this.userId);
                                if (user) await this.saveState(user);
                            }
                        }
                    } catch(e) {}
                } 
                
                if (this.activePositions.length > 0 && !this.isTrading) {
                    const pos = this.activePositions[0];
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    
                    if (currentPrice && pos.entryPrice > 0) {
                        const sideMult = pos.side === 'long' ? 1 : -1;
                        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult;
                        const exchangeROI = pnlPercent * FORCED_LEVERAGE;
                        const exchangePnl = (exchangeROI / 100) * pos.marginUsed;
                        
                        pos.exchangeROI = exchangeROI;
                        pos.exchangePnl = exchangePnl;
                    }
                }
                
                if (!this.liveTradingEnabled || !this.apiKey || this.apiKey === "demo") {
                    if (this.initialWalletBalance === 0) {
                        this.initialWalletBalance = 1000;
                        this.walletBalance = 1000 + (this.metrics?.totalNetPnl || 0);
                        this.metrics.initialWalletBalance = this.initialWalletBalance;
                    } else {
                        this.walletBalance = this.initialWalletBalance + (this.metrics?.totalNetPnl || 0);
                    }
                    this.metrics.currentWalletBalance = this.walletBalance;
                }
                
            } catch (err) {
                console.error(`[${this.accountType}] Sync error:`, err.message);
            }
        }, 2000);
    }

    getExportData() { 
        return { 
            config: this.config, 
            liveTradingEnabled: this.liveTradingEnabled, 
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, 
            activePositions: this.activePositions, 
            binance: globalMarketData.binance,
            walletBalance: this.walletBalance,
            initialWalletBalance: this.initialWalletBalance,
            growthPct: this.metrics.getGrowthPct(),
            accountType: this.accountType
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

                if (Date.now() - lastHistorySave > 2000) { 
                    if (mid !== lastSavedMid) {
                        const doc = { priceMid: mid, timestamp: Date.now() };
                        memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                        ChartDataModel.create(doc).catch(()=>{}); 
                        lastHistorySave = Date.now(); lastSavedMid = mid;
                    }
                }

                for (const [userId, workers] of activeWorkers.entries()) {
                    if (workers.main) {
                        workers.main.checkExits().catch(()=>{});
                        workers.main.evaluateManualEntry().catch(()=>{});
                    }
                    if (workers.second) {
                        workers.second.checkExits().catch(()=>{});
                        workers.second.evaluateManualEntry().catch(()=>{});
                    }
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
                const mainWorker = new UserTradeInstance(u, "main");
                await mainWorker.initialize();
                
                let secondWorker = null;
                if (u.secondAccount && (u.secondAccount.apiKey || u.secondAccount.liveTradingEnabled)) {
                    secondWorker = new UserTradeInstance(u, "second");
                    await secondWorker.initialize();
                }
                
                activeWorkers.set(u._id.toString(), { main: mainWorker, second: secondWorker });
                if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
            } catch(we) { console.error(`Worker error for ${u.email}:`, we.message); }
        }
    } catch(e) {}
}

// ==================== ANALYTICS ENGINE ====================
const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 15000) activeSessions.delete(sid);
    }
}, 5000);

// ==================== EXPRESS SERVER & API ====================
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
        if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'Email already exists' });
        
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        
        const mainWorker = new UserTradeInstance(user, "main");
        await mainWorker.initialize();
        
        activeWorkers.set(user._id.toString(), { main: mainWorker, second: null });
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
    res.json({ 
        name: req.user.name, 
        email: req.user.email, 
        apiKey: req.user.apiKey, 
        liveTradingEnabled: req.user.liveTradingEnabled,
        secondAccount: req.user.secondAccount || { apiKey: "", liveTradingEnabled: false }
    });
});

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    try {
        const { apiKey, apiSecret, liveTradingEnabled, isSecondAccount } = req.body;
        
        let workers = activeWorkers.get(req.user._id.toString());
        
        if (isSecondAccount) {
            if (!req.user.secondAccount) req.user.secondAccount = {};
            req.user.secondAccount.apiKey = apiKey;
            req.user.secondAccount.apiSecret = apiSecret;
            req.user.secondAccount.liveTradingEnabled = Boolean(liveTradingEnabled);
            
            if (workers && workers.second) {
                workers.second.apiKey = apiKey;
                workers.second.apiSecret = apiSecret;
                workers.second.liveTradingEnabled = Boolean(liveTradingEnabled);
                workers.second.applyUserKeys();
                const connectionResult = await workers.second.connectExchange();
                if (Boolean(liveTradingEnabled) && !connectionResult.success) {
                    workers.second.liveTradingEnabled = false;
                    req.user.secondAccount.liveTradingEnabled = false;
                }
            } else if (workers) {
                const secondWorker = new UserTradeInstance(req.user, "second");
                await secondWorker.initialize();
                workers.second = secondWorker;
            }
        } else {
            req.user.apiKey = apiKey;
            req.user.apiSecret = apiSecret;
            req.user.liveTradingEnabled = Boolean(liveTradingEnabled);
            
            if (workers && workers.main) {
                workers.main.apiKey = apiKey;
                workers.main.apiSecret = apiSecret;
                workers.main.liveTradingEnabled = Boolean(liveTradingEnabled);
                workers.main.applyUserKeys();
                const connectionResult = await workers.main.connectExchange();
                if (Boolean(liveTradingEnabled) && !connectionResult.success) {
                    workers.main.liveTradingEnabled = false;
                    req.user.liveTradingEnabled = false;
                }
            }
        }
        
        await req.user.save();
        res.json({ status: 'ok' });
    } catch(e) { res.status(500).json({ error: 'Failed to update settings' }); }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const workers = activeWorkers.get(req.user._id.toString());
    if(!workers) return res.status(400).json({ error: 'Worker not active' });
    
    const { tpPct, slPct, dcaTriggerPct, dcaMultiplier, startContracts, dgrDailyGrowthRate, manualDirection, maxContracts, isSecondAccount } = req.body;
    const pSet = (v, f, k, targetWorker) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) targetWorker.config[k] = p; } };
    
    const targetWorker = isSecondAccount ? workers.second : workers.main;
    if (!targetWorker) return res.status(400).json({ error: 'Account not initialized' });
    
    pSet(tpPct, parseFloat, 'takeProfitPct', targetWorker);
    pSet(slPct, parseFloat, 'stopLossPct', targetWorker);
    pSet(dcaTriggerPct, parseFloat, 'dcaTriggerPct', targetWorker);
    pSet(dcaMultiplier, parseFloat, 'dcaMultiplier', targetWorker);
    pSet(startContracts, parseInt, 'startContracts', targetWorker);
    pSet(dgrDailyGrowthRate, parseFloat, 'dgrDailyGrowthRate', targetWorker);
    pSet(maxContracts, parseInt, 'maxContracts', targetWorker);
    
    if (manualDirection !== undefined && (manualDirection === 'long' || manualDirection === 'short')) {
        targetWorker.config.manualDirection = manualDirection;
    }
    
    if (isSecondAccount) {
        if (!req.user.secondAccount) req.user.secondAccount = {};
        req.user.secondAccount.config = targetWorker.config;
        req.user.markModified('secondAccount');
    } else {
        req.user.config = targetWorker.config;
    }
    
    await req.user.save();
    res.json({status: 'ok', config: targetWorker.config});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    try {
        const { isSecondAccount } = req.body;
        const workers = activeWorkers.get(req.user._id.toString());
        if(workers) {
            const targetWorker = isSecondAccount ? workers.second : workers.main;
            if (targetWorker) {
                await TradeModel.deleteMany({ userId: req.user._id.toString(), accountId: targetWorker.accountType });
                targetWorker.metrics = new PerformanceMetrics(targetWorker.userId, targetWorker.accountType);
            }
        }
        res.json({status: 'ok'});
    } catch(err) { res.status(500).json({error: 'Failed to reset metrics'}); }
});

app.post('/api/user/close-all', authMiddleware, async (req, res) => {
    const { isSecondAccount } = req.body;
    const workers = activeWorkers.get(req.user._id.toString());
    if(workers) {
        const targetWorker = isSecondAccount ? workers.second : workers.main;
        if(targetWorker) await targetWorker.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{});
    }
    res.json({status: 'ok'});
});

app.get('/api/data', authMiddleware, (req, res) => {
    const workers = activeWorkers.get(req.user._id.toString());
    const mainData = workers?.main ? workers.main.getExportData() : null;
    const secondData = workers?.second ? workers.second.getExportData() : null;
    res.json({ main: mainData, second: secondData });
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>TradeBotPille | Multi-Account DCA Engine</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root { --zinc-50: #fafafa; --zinc-100: #f4f4f5; --zinc-200: #e4e4e7; --zinc-800: #27272a; --zinc-950: #09090b; --indigo-600: #4f46e5; --emerald-600: #059669; }
        body { font-family: 'Inter', sans-serif; background-color: var(--zinc-50); color: var(--zinc-950); }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .ui-card { background: #ffffff; border-radius: 12px; border: 1px solid var(--zinc-200); box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05); }
        .input-minimal { width: 100%; border: 1px solid var(--zinc-200); border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; transition: all 0.2s; background: #fff; }
        .input-minimal:focus { border-color: var(--zinc-950); ring: 2px ring-zinc-200; }
        .btn-primary { background: var(--zinc-950); color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 600; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
        .btn-secondary { background: #fff; color: var(--zinc-800); border: 1px solid var(--zinc-200); border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; transition: all 0.2s; }
        .btn-secondary:hover { background: var(--zinc-50); border-color: var(--zinc-800); }
        .status-pill { padding: 4px 10px; border-radius: 9999px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid transparent; }
        .account-tab { cursor: pointer; transition: all 0.2s; border-bottom: 2px solid transparent; padding: 8px 16px; }
        .account-tab.active { border-bottom-color: var(--zinc-950); color: var(--zinc-950); font-weight: 700; }
        .view-section { display: none; animation: slideUp 0.4s ease-out; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .active-view { display: block; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: var(--zinc-50); }
        ::-webkit-scrollbar-thumb { background: var(--zinc-200); border-radius: 10px; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

<header class="bg-white/70 backdrop-blur-xl border-b border-zinc-200 sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3 cursor-pointer group" onclick="nav('home')">
            <div class="w-8 h-8 rounded bg-zinc-950 flex items-center justify-center shadow-lg">
                <span class="material-symbols-outlined text-white text-[18px]">bolt</span>
            </div>
            <div class="flex flex-col leading-tight">
                <span class="font-extrabold tracking-tighter text-base">TRADEBOT<span class="text-indigo-600">PILLE</span></span>
                <span class="text-[9px] uppercase font-bold text-zinc-400 tracking-widest">Multi-Account DCA</span>
            </div>
        </div>
        <nav id="nav-public" class="flex items-center gap-2 text-sm">
            <button onclick="nav('backtest')" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950">Backtest</button>
            <button onclick="nav('analytics')" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950">Stats</button>
            <div class="w-px h-4 bg-zinc-200 mx-2"></div>
            <button onclick="nav('login')" class="px-4 py-2 font-semibold text-zinc-500 hover:text-zinc-950">Login</button>
            <button onclick="nav('register')" class="btn-primary">Get Started</button>
        </nav>
        <nav id="nav-private" class="hidden items-center gap-4 text-sm">
            <div class="hidden md:flex flex-col items-end mr-2">
                <span id="nav-user-name" class="font-bold text-zinc-950"></span>
                <span class="text-[9px] text-zinc-400 font-bold uppercase">Multi-Account Operator</span>
            </div>
            <button onclick="nav('dashboard')" class="px-3 py-2 rounded-md hover:bg-zinc-100 font-bold">Terminal</button>
            <button onclick="nav('step-history')" class="px-3 py-2 rounded-md hover:bg-zinc-100 font-bold">Steps</button>
            <button onclick="nav('settings')" class="px-3 py-2 rounded-md hover:bg-zinc-100 font-bold">Settings</button>
            <button onclick="logout()" class="px-3 py-2 text-red-500 font-bold hover:bg-red-50 rounded-md">Logout</button>
        </nav>
    </div>
</header>

<main class="flex-grow flex flex-col">
    <section id="view-home" class="view-section active-view">
        <div class="max-w-4xl mx-auto px-4 pt-32 pb-24 text-center">
            <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-zinc-100 text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-8">
                <span class="w-2 h-2 rounded-full bg-indigo-500 animate-ping"></span> Multi-Account DCA Execution
            </div>
            <h1 class="text-6xl md:text-8xl font-black tracking-tight mb-8 leading-[0.9]">DUAL ACCOUNT<br><span class="text-zinc-400 italic">DCA TRADING.</span></h1>
            <p class="text-lg md:text-xl text-zinc-500 mb-12 max-w-2xl mx-auto">Run two independent DCA bots with different strategies, directions, and API keys simultaneously.</p>
            <div class="flex flex-col sm:flex-row justify-center gap-4">
                <button onclick="nav('register')" class="btn-primary text-base px-8 py-4">Open Terminal</button>
                <button onclick="nav('backtest')" class="btn-secondary text-base px-8 py-4">Explore Backtest</button>
            </div>
        </div>
    </section>

    <section id="view-analytics" class="view-section max-w-5xl mx-auto px-4 py-20">
        <h2 class="text-4xl font-black mb-12">PLATFORM ANALYTICS</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            <div class="ui-card p-8"><p class="text-[10px] font-black text-zinc-400 uppercase mb-2">Live Connections</p><p id="stat-online" class="text-5xl font-mono font-black">0</p></div>
            <div class="ui-card p-8"><p class="text-[10px] font-black text-zinc-400 uppercase mb-2">Platform Views</p><p id="stat-views" class="text-5xl font-mono font-black">0</p></div>
            <div class="ui-card p-8"><p class="text-[10px] font-black text-zinc-400 uppercase mb-2">Unique Ops</p><p id="stat-uniques" class="text-5xl font-mono font-black">0</p></div>
        </div>
        <div class="ui-card p-8"><h3 class="text-xs font-black mb-6 uppercase">Live Viewport Distribution</h3><div id="stat-pages" class="divide-y divide-zinc-100"></div></div>
    </section>

    <section id="view-backtest" class="view-section max-w-7xl mx-auto px-4 py-16">
        <div class="grid lg:grid-cols-12 gap-8">
            <aside class="lg:col-span-3 space-y-6">
                <div class="ui-card p-6 sticky top-24">
                    <h3 class="font-black text-sm uppercase mb-6 border-b pb-4">Backtest Config</h3>
                    <div class="space-y-4">
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Data Span (Min)</label><input type="number" id="btTicks" class="input-minimal font-mono" value="5000"></div>
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DCA Trigger (%)</label><input type="number" id="btDcaTrigger" class="input-minimal font-mono" value="1.0" step="0.1"></div>
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DCA Multiplier</label><input type="number" id="btDcaMultiplier" class="input-minimal font-mono" value="2.0" step="0.1"></div>
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Start Contracts</label><input type="number" id="btStartContracts" class="input-minimal font-mono" value="1"></div>
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">DGR Daily Growth (%)</label><input type="number" id="btDgr" class="input-minimal font-mono" value="0.0" step="0.1"></div>
                        <div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Direction</label><select id="btDirection" class="input-minimal font-mono"><option value="long">Long Only</option><option value="short">Short Only</option></select></div>
                        <div class="grid grid-cols-2 gap-2"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">TP %</label><input type="number" id="btTp" class="input-minimal font-mono text-green-600" value="10.0"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">SL %</label><input type="number" id="btSl" class="input-minimal font-mono text-red-600" value="-50.0"></div></div>
                        <button onclick="runBacktest()" class="btn-primary w-full py-4 mt-4">Execute Simulation</button>
                    </div>
                </div>
            </aside>
            <div class="lg:col-span-9 space-y-6">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Win Rate</p><p id="btResWinrate" class="text-3xl font-mono font-black text-indigo-600">-</p></div>
                    <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Net Yield</p><p id="btResPnl" class="text-3xl font-mono font-black">-</p></div>
                    <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Volume (Trades)</p><p id="btResTrades" class="text-3xl font-mono font-black">-</p></div>
                    <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Max Deposit</p><p id="btResDeposit" class="text-3xl font-mono font-black">-</p></div>
                </div>
                <div class="ui-card overflow-hidden"><div class="p-4 bg-zinc-50 border-b"><span class="text-[10px] font-black uppercase">Simulation Tape</span></div><div class="overflow-x-auto max-h-[600px]"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase text-zinc-400 border-b bg-white"><tr><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4">Exit Trigger</th><th class="p-4 text-right">Net PnL</th></tr></thead><tbody id="btTableBody" class="font-mono text-xs divide-y"></tbody></table></div></div>
            </div>
        </div>
    </section>

    <section id="view-dashboard" class="view-section max-w-[1440px] mx-auto px-4 sm:px-6 py-10">
        <div class="flex justify-between items-center mb-6">
            <h2 class="text-4xl font-black italic">LIVE TERMINAL</h2>
            <div class="flex gap-2 bg-zinc-100 rounded-lg p-1">
                <button onclick="switchAccount('main')" id="tab-main" class="account-tab active">ACCOUNT 1</button>
                <button onclick="switchAccount('second')" id="tab-second" class="account-tab text-zinc-400">ACCOUNT 2</button>
            </div>
        </div>
        
        <div id="main-account-view">
            <div class="flex justify-between items-end mb-10"><div><div class="flex items-center gap-3"><span id="main-statusBadge" class="status-pill">Initializing...</span><span class="text-[10px] font-black text-zinc-400 uppercase">Uptime: <span id="main-uptime" class="text-zinc-950">0s</span></span></div></div><div><button onclick="closeAccount('main')" class="btn-secondary text-red-600 border-red-200 hover:bg-red-50">Emergency Exit</button></div></div>
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div class="ui-card p-6"><div class="absolute inset-y-0 left-0 w-1 bg-zinc-950"></div><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Total PnL</p><p id="main-netPnl" class="text-3xl font-mono font-black">$0.00</p><p id="main-growthPct" class="text-[10px] font-bold mt-1">Growth: 0%</p><button onclick="resetMetrics('main')" class="float-right text-zinc-300"><span class="material-symbols-outlined text-[16px]">restart_alt</span></button></div>
                        <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Wallet Balance</p><p id="main-walletBalance" class="text-3xl font-mono font-black">$0.00</p><p id="main-initialBalance" class="text-[9px] text-zinc-400 mt-1">Initial: $0</p></div>
                        <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Live ROI</p><p id="main-activeRoi" class="text-3xl font-mono font-black">IDLE</p></div>
                        <div class="ui-card p-6 bg-zinc-950"><p class="text-[10px] font-black text-zinc-800 uppercase mb-1">Direction</p><div class="flex justify-between"><span id="main-directionValue" class="text-3xl font-mono font-black text-white">LONG</span><span id="main-dgrValue" class="text-[10px] font-black text-zinc-500">DGR: 0%</span></div></div>
                    </div>
                    <div class="ui-card p-6 h-[450px]"><canvas id="priceChart"></canvas></div>
                    <div class="ui-card overflow-hidden"><div class="p-5 border-b"><h3 class="text-[10px] font-black uppercase">Trade History</h3></div><div class="overflow-x-auto"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase bg-zinc-50 border-b"><tr><th class="p-4">Time</th><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4">Trigger</th><th class="p-4 text-right">Net Return</th></tr></thead><tbody id="main-tradeHistoryBody" class="font-mono text-xs"></tbody></table></div></div>
                </div>
                <aside class="lg:col-span-4 space-y-8"><div class="ui-card p-8 border-t-4 border-t-indigo-600"><h3 class="text-sm font-black uppercase mb-8">DCA Parameters</h3><div class="space-y-6"><div class="flex justify-between"><label class="text-xs font-bold">TP (%)</label><input type="number" id="main-tpPctSens" class="input-minimal w-24 text-right font-mono"></div><div class="flex justify-between"><label class="text-xs font-bold">SL (%)</label><input type="number" id="main-slPctSens" class="input-minimal w-24 text-right font-mono"></div><hr><div class="flex justify-between"><label class="text-xs font-bold">DCA Trigger (%)</label><input type="number" id="main-dcaTriggerSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">DCA Multiplier</label><input type="number" id="main-dcaMultiplierSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">Start Contracts</label><input type="number" id="main-startContractsSens" class="input-minimal w-24 text-right font-mono"></div><div class="flex justify-between"><label class="text-xs font-bold">DGR Growth (%)</label><input type="number" id="main-dgrSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">Direction</label><select id="main-directionSens" class="input-minimal w-24 text-right font-mono"><option value="long">LONG</option><option value="short">SHORT</option></select></div><div class="flex justify-between"><label class="text-xs font-bold">Max Contracts</label><input type="number" id="main-maxContractsSens" class="input-minimal w-24 text-right font-mono"></div><button onclick="saveConfig('main')" class="btn-primary w-full py-4 mt-4">Apply Config</button></div></div></aside>
            </div>
        </div>
        
        <div id="second-account-view" style="display: none;">
            <div class="flex justify-between items-end mb-10"><div><div class="flex items-center gap-3"><span id="second-statusBadge" class="status-pill">Initializing...</span><span class="text-[10px] font-black text-zinc-400 uppercase">Uptime: <span id="second-uptime" class="text-zinc-950">0s</span></span></div></div><div><button onclick="closeAccount('second')" class="btn-secondary text-red-600 border-red-200 hover:bg-red-50">Emergency Exit</button></div></div>
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div class="ui-card p-6"><div class="absolute inset-y-0 left-0 w-1 bg-emerald-600"></div><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Total PnL</p><p id="second-netPnl" class="text-3xl font-mono font-black">$0.00</p><p id="second-growthPct" class="text-[10px] font-bold mt-1">Growth: 0%</p><button onclick="resetMetrics('second')" class="float-right text-zinc-300"><span class="material-symbols-outlined text-[16px]">restart_alt</span></button></div>
                        <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Wallet Balance</p><p id="second-walletBalance" class="text-3xl font-mono font-black">$0.00</p><p id="second-initialBalance" class="text-[9px] text-zinc-400 mt-1">Initial: $0</p></div>
                        <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase mb-1">Live ROI</p><p id="second-activeRoi" class="text-3xl font-mono font-black">IDLE</p></div>
                        <div class="ui-card p-6 bg-emerald-600"><p class="text-[10px] font-black text-emerald-100 uppercase mb-1">Direction</p><div class="flex justify-between"><span id="second-directionValue" class="text-3xl font-mono font-black text-white">LONG</span><span id="second-dgrValue" class="text-[10px] font-black text-emerald-100">DGR: 0%</span></div></div>
                    </div>
                    <div class="ui-card overflow-hidden"><div class="p-5 border-b"><h3 class="text-[10px] font-black uppercase">Trade History</h3></div><div class="overflow-x-auto"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase bg-zinc-50 border-b"><tr><th class="p-4">Time</th><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4">Trigger</th><th class="p-4 text-right">Net Return</th></tr></thead><tbody id="second-tradeHistoryBody" class="font-mono text-xs"></tbody></table></div></div>
                </div>
                <aside class="lg:col-span-4 space-y-8"><div class="ui-card p-8 border-t-4 border-t-emerald-600"><h3 class="text-sm font-black uppercase mb-8">DCA Parameters</h3><div class="space-y-6"><div class="flex justify-between"><label class="text-xs font-bold">TP (%)</label><input type="number" id="second-tpPctSens" class="input-minimal w-24 text-right font-mono"></div><div class="flex justify-between"><label class="text-xs font-bold">SL (%)</label><input type="number" id="second-slPctSens" class="input-minimal w-24 text-right font-mono"></div><hr><div class="flex justify-between"><label class="text-xs font-bold">DCA Trigger (%)</label><input type="number" id="second-dcaTriggerSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">DCA Multiplier</label><input type="number" id="second-dcaMultiplierSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">Start Contracts</label><input type="number" id="second-startContractsSens" class="input-minimal w-24 text-right font-mono"></div><div class="flex justify-between"><label class="text-xs font-bold">DGR Growth (%)</label><input type="number" id="second-dgrSens" class="input-minimal w-24 text-right font-mono" step="0.1"></div><div class="flex justify-between"><label class="text-xs font-bold">Direction</label><select id="second-directionSens" class="input-minimal w-24 text-right font-mono"><option value="long">LONG</option><option value="short">SHORT</option></select></div><div class="flex justify-between"><label class="text-xs font-bold">Max Contracts</label><input type="number" id="second-maxContractsSens" class="input-minimal w-24 text-right font-mono"></div><button onclick="saveConfig('second')" class="btn-primary w-full py-4 mt-4">Apply Config</button></div></div></aside>
            </div>
        </div>
    </section>

    <section id="view-step-history" class="view-section max-w-4xl mx-auto px-4 py-20">
        <div class="flex justify-between items-center mb-8"><h2 class="text-4xl font-black">DCA STEP TRACE</h2><div class="flex gap-2 bg-zinc-100 rounded-lg p-1"><button onclick="switchStepAccount('main')" id="step-tab-main" class="account-tab active">ACCOUNT 1</button><button onclick="switchStepAccount('second')" id="step-tab-second" class="account-tab text-zinc-400">ACCOUNT 2</button></div></div>
        <div class="ui-card overflow-hidden"><table class="w-full text-left"><thead class="text-[10px] font-black uppercase bg-zinc-950 text-white"><tr><th class="p-5">Step</th><th class="p-5">Action</th><th class="p-5">Price</th><th class="p-5">ROI %</th><th class="p-5 text-right">Time</th></tr></thead><tbody id="stepHistoryBody" class="font-mono text-xs"></tbody></table></div>
    </section>

    <section id="view-settings" class="view-section max-w-2xl mx-auto px-4 py-20">
        <h2 class="text-4xl font-black mb-8">ACCOUNT SETTINGS</h2>
        <div class="space-y-8">
            <div class="ui-card p-8"><h3 class="text-xl font-black mb-6">ACCOUNT 1 (MAIN)</h3><div class="space-y-6"><div class="flex items-center gap-4 p-5 bg-zinc-50 rounded-xl cursor-pointer" onclick="toggleLive('main')"><input type="checkbox" id="main-liveTrade" class="w-5 h-5 accent-zinc-950"><label class="text-xs font-black uppercase cursor-pointer">Live Exchange Execution</label></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX API Key</label><input type="password" id="main-apiKey" class="input-minimal font-mono"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX API Secret</label><input type="password" id="main-apiSecret" class="input-minimal font-mono"></div><button onclick="saveApiKeys('main')" class="btn-primary w-full py-4">Save Account 1 Keys</button></div></div>
            <div class="ui-card p-8"><h3 class="text-xl font-black mb-6">ACCOUNT 2 (SECONDARY)</h3><div class="space-y-6"><div class="flex items-center gap-4 p-5 bg-zinc-50 rounded-xl cursor-pointer" onclick="toggleLive('second')"><input type="checkbox" id="second-liveTrade" class="w-5 h-5 accent-emerald-600"><label class="text-xs font-black uppercase cursor-pointer">Live Exchange Execution</label></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX API Key</label><input type="password" id="second-apiKey" class="input-minimal font-mono"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-2 block">HTX API Secret</label><input type="password" id="second-apiSecret" class="input-minimal font-mono"></div><button onclick="saveApiKeys('second')" class="btn-primary w-full py-4 bg-emerald-600">Save Account 2 Keys</button></div></div>
            <p id="key-msg" class="text-center text-[10px] font-black text-zinc-500"></p>
        </div>
    </section>

    <section id="view-login" class="view-section max-w-md mx-auto px-4 py-32"><div class="ui-card p-10"><h2 class="text-3xl font-black mb-8">Welcome Back.</h2><div class="space-y-6"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Email</label><input type="email" id="login-email" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Password</label><input type="password" id="login-pass" class="input-minimal"></div><button onclick="doLogin()" class="btn-primary w-full py-4">Authenticate</button><p id="login-err" class="text-red-500 text-[10px] font-black text-center"></p></div></div></section>

    <section id="view-register" class="view-section max-w-md mx-auto px-4 py-32"><div class="ui-card p-10"><h2 class="text-3xl font-black mb-8">New Operator.</h2><div class="space-y-6"><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Name</label><input type="text" id="reg-name" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Email</label><input type="email" id="reg-email" class="input-minimal"></div><div><label class="text-[10px] font-black text-zinc-400 uppercase mb-1 block">Password</label><input type="password" id="reg-pass" class="input-minimal"></div><button onclick="doRegister()" class="btn-primary w-full py-4">Initialize</button><p id="reg-err" class="text-red-500 text-[10px] font-black text-center"></p></div></div></section>
</main>

<footer class="bg-white border-t border-zinc-200 py-12"><div class="max-w-7xl mx-auto px-4 text-center"><p class="text-[10px] font-black uppercase text-zinc-400 mb-2">© 2026 TRADEBOTPILLE MULTI-ACCOUNT DCA ENGINE</p><p class="text-[9px] text-zinc-300 font-bold uppercase">Geometric trading carries absolute risk. Non-custodial execution strictly for education.</p></div></footer>

<script>
let authToken = localStorage.getItem('bot_token');
let chartPoints = 800;
let currentAccount = 'main';
let currentStepAccount = 'main';
let lastMainTradesCount = -1, lastSecondTradesCount = -1;
let sessionTrackId = localStorage.getItem('rdca_visitor_id') || Math.random().toString(36).substring(2,15);
localStorage.setItem('rdca_visitor_id', sessionTrackId);
let currentPageView = 'home';
let priceChart = null;

async function pingAnalytics(isView){try{await fetch('/api/analytics/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sessionTrackId,page:currentPageView,isView:isView})});}catch(e){}}
setInterval(()=>pingAnalytics(false),10000);

function nav(viewId){
    document.querySelectorAll('.view-section').forEach(el=>el.classList.remove('active-view'));
    document.getElementById('view-'+viewId).classList.add('active-view');
    window.scrollTo(0,0);
    currentPageView=viewId;
    pingAnalytics(true);
    if(viewId==='dashboard'&&authToken){initDashboard();fetchMetrics();if(window.dashInterval)clearInterval(window.dashInterval);window.dashInterval=setInterval(fetchMetrics,2000);}
    if(viewId==='analytics')fetchAnalyticsData();
    if(viewId==='step-history'&&authToken)fetchStepHistory();
    if(viewId!=='dashboard'&&window.dashInterval){clearInterval(window.dashInterval);window.dashInterval=null;}
}

function switchAccount(account){
    currentAccount=account;
    document.getElementById('main-account-view').style.display=account==='main'?'block':'none';
    document.getElementById('second-account-view').style.display=account==='second'?'block':'none';
    document.getElementById('tab-main').classList.toggle('active',account==='main');
    document.getElementById('tab-second').classList.toggle('active',account==='second');
    document.getElementById('tab-main').classList.toggle('text-zinc-400',account!=='main');
    document.getElementById('tab-second').classList.toggle('text-zinc-400',account!=='second');
}

function switchStepAccount(account){
    currentStepAccount=account;
    document.getElementById('step-tab-main').classList.toggle('active',account==='main');
    document.getElementById('step-tab-second').classList.toggle('active',account==='second');
    fetchStepHistory();
}

function toggleAuthUI(){
    if(authToken){
        document.getElementById('nav-public').classList.add('hidden');
        document.getElementById('nav-private').classList.remove('hidden');
        document.getElementById('nav-private').classList.add('flex');
    }else{
        document.getElementById('nav-public').classList.remove('hidden');
        document.getElementById('nav-private').classList.add('hidden');
        document.getElementById('nav-private').classList.remove('flex');
    }
}

function logout(){localStorage.removeItem('bot_token');authToken=null;toggleAuthUI();nav('home');if(window.dashInterval)clearInterval(window.dashInterval);}

async function doAPI(endpoint,method,body){
    const headers={'Content-Type':'application/json'};
    if(authToken)headers['Authorization']=authToken;
    const res=await fetch(endpoint,{method,headers,body:body?JSON.stringify(body):undefined});
    const data=await res.json();
    if(res.status===401){logout();return{error:"Session expired"};}
    return data;
}

async function runBacktest(){
    const payload={ticks:document.getElementById('btTicks').value,tpPct:document.getElementById('btTp').value,slPct:document.getElementById('btSl').value,dcaTriggerPct:document.getElementById('btDcaTrigger').value,dcaMultiplier:document.getElementById('btDcaMultiplier').value,startContracts:document.getElementById('btStartContracts').value,dgrDailyGrowthRate:document.getElementById('btDgr').value,manualDirection:document.getElementById('btDirection').value,maxContracts:100};
    const res=await doAPI('/api/backtest','POST',payload);
    if(res.error)return;
    document.getElementById('btResWinrate').innerText=res.winRate+"%";
    document.getElementById('btResPnl').innerText="$"+res.netPnl.toFixed(4);
    document.getElementById('btResTrades').innerText=res.totalTradesCount;
    document.getElementById('btResDeposit').innerText="$"+res.depositNeeded.toFixed(4);
    const tbody=document.getElementById('btTableBody');
    tbody.innerHTML="";
    if(res.trades)res.trades.reverse().forEach(t=>{tbody.innerHTML+='<tr><td class="p-4 font-black '+(t.side==='long'?'text-green-600':'text-red-600')+'">'+t.side.toUpperCase()+'</td><td class="p-4">'+t.contracts+'</td><td class="p-4 text-[9px] uppercase text-zinc-400">'+t.exitReason+'</td><td class="p-4 text-right '+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$'+t.netPnl.toFixed(4)+'</td></tr>';});
}

async function doLogin(){const res=await doAPI('/api/auth/login','POST',{email:document.getElementById('login-email').value,password:document.getElementById('login-pass').value});if(res.error)document.getElementById('login-err').innerText=res.error;else{authToken=res.token;localStorage.setItem('bot_token',authToken);toggleAuthUI();nav('dashboard');}}
async function doRegister(){const res=await doAPI('/api/auth/register','POST',{name:document.getElementById('reg-name').value,email:document.getElementById('reg-email').value,password:document.getElementById('reg-pass').value});if(res.error)document.getElementById('reg-err').innerText=res.error;else{authToken=res.token;localStorage.setItem('bot_token',authToken);toggleAuthUI();nav('dashboard');}}
function toggleLive(account){const cb=document.getElementById(account+'-liveTrade');cb.checked=!cb.checked;}
async function saveApiKeys(account){const isSecond=account==='second';const res=await doAPI('/api/user/keys','POST',{apiKey:document.getElementById(account+'-apiKey').value,apiSecret:document.getElementById(account+'-apiSecret').value,liveTradingEnabled:document.getElementById(account+'-liveTrade').checked,isSecondAccount:isSecond});document.getElementById('key-msg').innerText=res.error?res.error:"KEYS SECURED";if(!res.error)setTimeout(()=>nav('dashboard'),1500);}
async function saveConfig(account){const isSecond=account==='second';const payload={tpPct:parseFloat(document.getElementById(account+"-tpPctSens").value),slPct:parseFloat(document.getElementById(account+"-slPctSens").value),dcaTriggerPct:parseFloat(document.getElementById(account+"-dcaTriggerSens").value),dcaMultiplier:parseFloat(document.getElementById(account+"-dcaMultiplierSens").value),startContracts:parseInt(document.getElementById(account+"-startContractsSens").value),dgrDailyGrowthRate:parseFloat(document.getElementById(account+"-dgrSens").value),manualDirection:document.getElementById(account+"-directionSens").value,maxContracts:parseInt(document.getElementById(account+"-maxContractsSens").value),isSecondAccount:isSecond};await doAPI('/api/user/config','POST',payload);alert("CONFIG SYNCED");}
async function closeAccount(account){if(confirm("Close all trades for "+account.toUpperCase()+"?"))await doAPI('/api/user/close-all','POST',{isSecondAccount:account==='second'});}
async function resetMetrics(account){if(confirm("Reset trade history for "+account.toUpperCase()+"?")){await doAPI('/api/user/reset-metrics','POST',{isSecondAccount:account==='second'});if(account==='main')lastMainTradesCount=-1;else lastSecondTradesCount=-1;fetchMetrics();}}
async function fetchAnalyticsData(){if(currentPageView!=='analytics')return;const data=await(await fetch('/api/analytics/stats')).json();document.getElementById('stat-online').innerText=data.online;document.getElementById('stat-views').innerText=data.views;document.getElementById('stat-uniques').innerText=data.uniques;document.getElementById('stat-pages').innerHTML=Object.entries(data.pages||{}).map(([n,c])=>'<div class="flex justify-between p-4"><span class="font-black text-[10px] uppercase">'+n+'</span><span class="font-mono font-bold">'+c+' OPS</span></div>').join('');}
function initPriceChart(){const ctx=document.getElementById("priceChart").getContext("2d");priceChart=new Chart(ctx,{type:"line",data:{labels:[],datasets:[{label:"Price",data:[],borderColor:"#09090b",borderWidth:2,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{display:false},y:{display:true,grid:{display:false}}}}});}
let settingsLoaded={main:false,second:false};
async function initDashboard(){if(!priceChart)initPriceChart();const me=await doAPI('/api/user/me','GET');if(!me.error){document.getElementById('nav-user-name').innerText=me.name;document.getElementById('main-liveTrade').checked=me.liveTradingEnabled;document.getElementById('main-apiKey').value=me.apiKey||'';if(me.secondAccount){document.getElementById('second-liveTrade').checked=me.secondAccount.liveTradingEnabled||false;document.getElementById('second-apiKey').value=me.secondAccount.apiKey||'';}}const history=await doAPI('/api/chart-history','GET');if(history&&!history.error){priceChart.data.labels=history.map(()=>"");priceChart.data.datasets[0].data=history.map(p=>p.priceMid);priceChart.update();}}
async function fetchStepHistory(){const data=await doAPI('/api/data','GET');if(data.error)return;const accData=currentStepAccount==='main'?data.main:data.second;const tbody=document.getElementById("stepHistoryBody");if(accData&&accData.activePositions&&accData.activePositions[0]?.stepHistory){const steps=accData.activePositions[0].stepHistory;if(steps.length){tbody.innerHTML=steps.map(s=>'<tr><td class="p-5 font-black">'+s.step+'</td><td class="p-5 font-black '+(s.type==='DCA'?'text-red-500':'text-indigo-500')+'">'+s.type+'</td><td class="p-5">$'+Number(s.price).toFixed(8)+'</td><td class="p-5 '+(s.roi>=0?'text-green-600':'text-red-600')+'">'+Number(s.roi).toFixed(2)+'%</td><td class="p-5 text-right">'+new Date(s.time).toLocaleTimeString()+'</td></tr>').join('');return;}}tbody.innerHTML='<tr><td colspan="5" class="p-20 text-center text-zinc-300">No DCA Steps</td></tr>';}
async function fetchMetrics(){if(currentPageView!=='dashboard'&&currentPageView!=='step-history')return;const data=await doAPI('/api/data','GET');if(data.error||!data)return;if(currentPageView==='step-history')await fetchStepHistory();const mainData=data.main,secondData=data.second;if(mainData&&mainData.binance?.mid&&priceChart){priceChart.data.labels.push("");priceChart.data.datasets[0].data.push(mainData.binance.mid);if(priceChart.data.labels.length>800){priceChart.data.labels.shift();priceChart.data.datasets[0].data.shift();}priceChart.update('none');}
if(mainData){if(!settingsLoaded.main&&mainData.config){const c=mainData.config;document.getElementById("main-tpPctSens").value=c.takeProfitPct||10;document.getElementById("main-slPctSens").value=c.stopLossPct||-50;document.getElementById("main-dcaTriggerSens").value=c.dcaTriggerPct||1;document.getElementById("main-dcaMultiplierSens").value=c.dcaMultiplier||2;document.getElementById("main-startContractsSens").value=c.startContracts||1;document.getElementById("main-dgrSens").value=c.dgrDailyGrowthRate||0;document.getElementById("main-directionSens").value=c.manualDirection||'long';document.getElementById("main-maxContractsSens").value=c.maxContracts||100;settingsLoaded.main=true;}
document.getElementById("main-uptime").innerText=(mainData.uptime||0)+"s";const netPnl=mainData.metrics?.totalNetPnl||0;const netEl=document.getElementById("main-netPnl");netEl.innerText="$"+netPnl.toFixed(4);netEl.className="text-3xl font-mono font-black "+(netPnl>=0?"text-green-600":"text-red-600");document.getElementById("main-growthPct").innerHTML="Growth: "+(mainData.growthPct||0).toFixed(2)+"%";document.getElementById("main-walletBalance").innerText="$"+Number(mainData.walletBalance||0).toFixed(4);document.getElementById("main-initialBalance").innerText="Initial: $"+(mainData.initialWalletBalance||0).toFixed(4);const mainBadge=document.getElementById("main-statusBadge");const roiEl=document.getElementById("main-activeRoi");if(mainData.activePositions?.length>0){const p=mainData.activePositions[0];mainBadge.innerText=p.isPaper?"PAPER ACTIVE":"LIVE ACTIVE";mainBadge.className="status-pill bg-zinc-950 text-white";const roi=p.exchangeROI||0;roiEl.innerText=roi.toFixed(2)+"%";roiEl.className="text-3xl font-mono font-black "+(roi>=0?"text-green-600":"text-red-600");}else{mainBadge.innerText=mainData.liveTradingEnabled?"LIVE SCANNING":"PAPER STANDBY";mainBadge.className="status-pill bg-zinc-100 text-zinc-400";roiEl.innerText="IDLE";roiEl.className="text-3xl font-mono font-black text-zinc-200";}
if(mainData.config){document.getElementById('main-directionValue').innerText=(mainData.config.manualDirection||'LONG').toUpperCase();document.getElementById('main-dgrValue').innerHTML='DGR: '+(mainData.config.dgrDailyGrowthRate||0)+'%';}
if(mainData.metrics?.totalTradesCount!==lastMainTradesCount){lastMainTradesCount=mainData.metrics.totalTradesCount;const trades=mainData.metrics.trades||[];const tbody=document.getElementById("main-tradeHistoryBody");if(trades.length){tbody.innerHTML=trades.slice().reverse().slice(0,20).map(t=>'<tr><td class="p-4 text-zinc-400 text-[9px]">'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="p-4 font-black '+(t.side==='long'?'text-green-600':'text-red-600')+'">'+t.side.toUpperCase()+'</td><td class="p-4">'+t.contracts+'</td><td class="p-4 text-[9px] uppercase text-zinc-400">'+t.exitReason+'</td><td class="p-4 text-right '+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$'+t.netPnl.toFixed(4)+'</td></tr>').join('');}else{tbody.innerHTML='<tr><td colspan="5" class="p-20 text-center text-zinc-300">No Trades</td></tr>';}}}
if(secondData){if(!settingsLoaded.second&&secondData.config){const c=secondData.config;document.getElementById("second-tpPctSens").value=c.takeProfitPct||10;document.getElementById("second-slPctSens").value=c.stopLossPct||-50;document.getElementById("second-dcaTriggerSens").value=c.dcaTriggerPct||1;document.getElementById("second-dcaMultiplierSens").value=c.dcaMultiplier||2;document.getElementById("second-startContractsSens").value=c.startContracts||1;document.getElementById("second-dgrSens").value=c.dgrDailyGrowthRate||0;document.getElementById("second-directionSens").value=c.manualDirection||'long';document.getElementById("second-maxContractsSens").value=c.maxContracts||100;settingsLoaded.second=true;}
document.getElementById("second-uptime").innerText=(secondData.uptime||0)+"s";const netPnl=secondData.metrics?.totalNetPnl||0;const netEl=document.getElementById("second-netPnl");netEl.innerText="$"+netPnl.toFixed(4);netEl.className="text-3xl font-mono font-black "+(netPnl>=0?"text-green-600":"text-red-600");document.getElementById("second-growthPct").innerHTML="Growth: "+(secondData.growthPct||0).toFixed(2)+"%";document.getElementById("second-walletBalance").innerText="$"+Number(secondData.walletBalance||0).toFixed(4);document.getElementById("second-initialBalance").innerText="Initial: $"+(secondData.initialWalletBalance||0).toFixed(4);const secBadge=document.getElementById("second-statusBadge");const roiEl=document.getElementById("second-activeRoi");if(secondData.activePositions?.length>0){const p=secondData.activePositions[0];secBadge.innerText=p.isPaper?"PAPER ACTIVE":"LIVE ACTIVE";secBadge.className="status-pill bg-emerald-600 text-white";const roi=p.exchangeROI||0;roiEl.innerText=roi.toFixed(2)+"%";roiEl.className="text-3xl font-mono font-black "+(roi>=0?"text-green-600":"text-red-600");}else{secBadge.innerText=secondData.liveTradingEnabled?"LIVE SCANNING":"PAPER STANDBY";secBadge.className="status-pill bg-zinc-100 text-zinc-400";roiEl.innerText="IDLE";roiEl.className="text-3xl font-mono font-black text-zinc-200";}
if(secondData.config){document.getElementById('second-directionValue').innerText=(secondData.config.manualDirection||'LONG').toUpperCase();document.getElementById('second-dgrValue').innerHTML='DGR: '+(secondData.config.dgrDailyGrowthRate||0)+'%';}
if(secondData.metrics?.totalTradesCount!==lastSecondTradesCount){lastSecondTradesCount=secondData.metrics.totalTradesCount;const trades=secondData.metrics.trades||[];const tbody=document.getElementById("second-tradeHistoryBody");if(trades.length){tbody.innerHTML=trades.slice().reverse().slice(0,20).map(t=>'<tr><td class="p-4 text-zinc-400 text-[9px]">'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="p-4 font-black '+(t.side==='long'?'text-green-600':'text-red-600')+'">'+t.side.toUpperCase()+'</td><td class="p-4">'+t.contracts+'</td><td class="p-4 text-[9px] uppercase text-zinc-400">'+t.exitReason+'</td><td class="p-4 text-right '+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$'+t.netPnl.toFixed(4)+'</td></tr>').join('');}else{tbody.innerHTML='<tr><td colspan="5" class="p-20 text-center text-zinc-300">No Trades</td></tr>';}}}}
pingAnalytics(true);setInterval(fetchAnalyticsData,4000);if(authToken){toggleAuthUI();nav('dashboard');}else{toggleAuthUI();nav('home');}
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
