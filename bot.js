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
                userDoc.secondAccount = { apiKey: "", apiSecret: "", liveTradingEnabled: false, config: {}, activePosition: null, lastCloseTime: 0 };
            }
            userDoc.secondAccount.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null;
            userDoc.secondAccount.lastCloseTime = this.lastCloseTime;
            userDoc.secondAccount.config = this.config;
            userDoc.secondAccount.liveTradingEnabled = this.liveTradingEnabled;
            userDoc.secondAccount.apiKey = this.apiKey;
            userDoc.secondAccount.apiSecret = this.apiSecret;
            userDoc.markModified('secondAccount'); // CRITICAL FIX: Ensure Mongoose detects nested object change
        }
        await userDoc.save();
        
        const cacheEntry = tokenCache.get(userDoc.token);
        if (cacheEntry) {
            cacheEntry.user = userDoc;
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
                        console.log(`[${this.accountType}] Wallet balance: $${this.walletBalance}`);
                    }
                } catch(e) {}
                
                return { success: true };
            } else {
                console.log(`[${this.accountType}] Running in PAPER mode`);
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
        if (this.isTrading) return;

        try {
            let signal = this.config.manualDirection === 'long' ? 'long' : (this.config.manualDirection === 'short' ? 'short' : null);
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (signal && pos.side !== signal) {
                    console.log(`[${this.accountType}] Flipping from ${pos.side} to ${signal}`);
                    await this.forceClosePosition("MANUAL_FLIP");
                    setTimeout(() => this.syncState(signal), 500);
                }
            } else {
                if (signal) {
                    console.log(`[${this.accountType}] Opening new ${signal.toUpperCase()} position`);
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
                console.log(`[${this.accountType}] Take profit triggered at ${effectiveRoi.toFixed(2)}%`);
                await this.forceClosePosition("TAKE_PROFIT");
            } else if (effectiveRoi <= this.config.stopLossPct) {
                console.log(`[${this.accountType}] Stop loss triggered at ${effectiveRoi.toFixed(2)}%`);
                await this.forceClosePosition("STOP_LOSS");
            } else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaTriggerPct || 1.0));
                
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    console.log(`[${this.accountType}] DCA triggered at ${effectiveRoi.toFixed(2)}%`);
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
        if (this.isTrading) return;
        
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled || !this.apiKey || this.apiKey === "demo"; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            
            let baseC = Number(this.config.startContracts) || 1;
            const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!executionPrice) executionPrice = globalMarketData.binance.mid;

            console.log(`[${this.accountType}] Attempting to open ${targetSide.toUpperCase()} position with ${contracts} contracts at $${executionPrice}`);

            if (!isPaper) {
                try {
                    const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    try { 
                        const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); 
                        if (oOrder && oOrder.average) {
                            executionPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average;
                        }
                    } catch(e){}
                } catch(err) {
                    console.error(`[${this.accountType}] LIVE order failed:`, err.message);
                    this.isTrading = false;
                    return;
                }
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
            if (user) await this.saveState(user);
            console.log(`[${this.accountType}] SUCCESS: Opened ${targetSide.toUpperCase()} position at $${executionPrice}`);
            
        } catch (err) { 
            console.error(`[${this.accountType}] Open Error:`, err.message); 
            this.activePositions = []; 
        } finally { 
            this.isTrading = false; 
        }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let realExitPrice = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;

            console.log(`[${this.accountType}] Closing ${snapPos.side.toUpperCase()} position at $${realExitPrice}, Reason: ${reason}`);

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
            console.log(`[${this.accountType}] CLOSED: ${reason} | PnL: $${math.netPnlUsd.toFixed(4)}`);
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
                            if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                            const currentROI = openPos.percentage || 0;
                            const currentPnL = openPos.unrealizedPnl || 0;
                            
                            if (this.activePositions.length === 0) {
                                const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                                const marginUsed = sizeUsd / FORCED_LEVERAGE;
                                this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: marginUsed, exchangeROI: currentROI, exchangePnl: currentPnL, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                            } else {
                                this.activePositions[0].exchangeROI = currentROI;
                                this.activePositions[0].exchangePnl = currentPnL;
                                this.activePositions[0].contracts = openPos.contracts;
                            }
                            
                            const user = await UserModel.findById(this.userId);
                            if (user) await this.saveState(user);
                        } else if (this.activePositions.length > 0) {
                            this.activePositions = [];
                            const user = await UserModel.findById(this.userId);
                            if (user) await this.saveState(user);
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
                        pos.exchangeROI = pnlPercent * FORCED_LEVERAGE;
                        pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed;
                    }
                }
                
                if (!this.liveTradingEnabled || !this.apiKey || this.apiKey === "demo") {
                    this.initialWalletBalance = this.initialWalletBalance || 1000;
                    this.walletBalance = this.initialWalletBalance + (this.metrics?.totalNetPnl || 0);
                    this.metrics.currentWalletBalance = this.walletBalance;
                    this.metrics.initialWalletBalance = this.initialWalletBalance;
                }
                
            } catch (err) {}
        }, 2000);
    }

    getExportData() { 
        return { 
            config: this.config, liveTradingEnabled: this.liveTradingEnabled, 
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, activePositions: this.activePositions, 
            binance: globalMarketData.binance, walletBalance: this.walletBalance,
            initialWalletBalance: this.initialWalletBalance, growthPct: this.metrics.getGrowthPct(), accountType: this.accountType
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
        
        while (true) {
            try {
                let mid = 0;
                try {
                    const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                    let bid = ticker.bid !== undefined ? ticker.bid : ticker.last;
                    let ask = ticker.ask !== undefined ? ticker.ask : ticker.last;
                    mid = (bid + ask) / 2;
                } catch(wsErr) {
                    const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); 
                    mid = (ticker.bid + ticker.ask) / 2;
                    await new Promise(r => setTimeout(r, 1000)); 
                }

                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }

                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                
                if (Date.now() - lastHistorySave > 2000) { 
                    if (mid !== lastSavedMid) {
                        const doc = { priceMid: mid, timestamp: Date.now() };
                        memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                        ChartDataModel.create(doc).catch(()=>{}); 
                        lastHistorySave = Date.now(); lastSavedMid = mid;
                    }
                }

                for (const workers of activeWorkers.values()) {
                    if (workers.main) { workers.main.checkExits().catch(()=>{}); workers.main.evaluateManualEntry().catch(()=>{}); }
                    if (workers.second) { workers.second.checkExits().catch(()=>{}); workers.second.evaluateManualEntry().catch(()=>{}); }
                }

                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
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
                const secondWorker = new UserTradeInstance(u, "second"); // CRITICAL FIX: Unconditional startup
                await secondWorker.initialize();
                activeWorkers.set(u._id.toString(), { main: mainWorker, second: secondWorker });
                if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
            } catch(we) { console.error(`Worker error for ${u.email}:`, we.message); }
        }
    } catch(e) {}
}

const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) { if (now - data.lastSeen > 15000) activeSessions.delete(sid); }
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
        dcaTriggerPct: parseFloat(req.body.dcaTriggerPct) || 1.0, dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0,
        startContracts: parseInt(req.body.startContracts) || 1, dgrDailyGrowthRate: parseFloat(req.body.dgrDailyGrowthRate) || 0.0,
        manualDirection: req.body.manualDirection || 'long', maxContracts: parseInt(req.body.maxContracts) || 100
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
        const mainWorker = new UserTradeInstance(user, "main"); await mainWorker.initialize();
        const secondWorker = new UserTradeInstance(user, "second"); await secondWorker.initialize();
        activeWorkers.set(user._id.toString(), { main: mainWorker, second: secondWorker });
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
        name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, 
        liveTradingEnabled: req.user.liveTradingEnabled, secondAccount: req.user.secondAccount || { apiKey: "", liveTradingEnabled: false }
    });
});

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    try {
        const { apiKey, apiSecret, liveTradingEnabled, isSecondAccount } = req.body;
        let workers = activeWorkers.get(req.user._id.toString());
        if (isSecondAccount) {
            if (!req.user.secondAccount) req.user.secondAccount = {};
            req.user.secondAccount.apiKey = apiKey; req.user.secondAccount.apiSecret = apiSecret;
            req.user.secondAccount.liveTradingEnabled = Boolean(liveTradingEnabled);
            req.user.markModified('secondAccount'); // CRITICAL FIX: Mark modified for DB save
            if (workers?.second) { 
                workers.second.apiKey = apiKey; workers.second.apiSecret = apiSecret; 
                workers.second.liveTradingEnabled = Boolean(liveTradingEnabled);
                workers.second.applyUserKeys(); await workers.second.connectExchange();
            }
        } else {
            req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; req.user.liveTradingEnabled = Boolean(liveTradingEnabled);
            if (workers?.main) { 
                workers.main.apiKey = apiKey; workers.main.apiSecret = apiSecret; 
                workers.main.liveTradingEnabled = Boolean(liveTradingEnabled);
                workers.main.applyUserKeys(); await workers.main.connectExchange();
            }
        }
        await req.user.save();
        res.json({ status: 'ok' });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const workers = activeWorkers.get(req.user._id.toString());
    const { tpPct, slPct, dcaTriggerPct, dcaMultiplier, startContracts, dgrDailyGrowthRate, manualDirection, maxContracts, isSecondAccount } = req.body;
    const targetWorker = isSecondAccount ? workers?.second : workers?.main;
    if (!targetWorker) return res.status(400).json({ error: 'Not initialized' });
    const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) targetWorker.config[k] = p; } };
    pSet(tpPct, parseFloat, 'takeProfitPct'); pSet(slPct, parseFloat, 'stopLossPct'); pSet(dcaTriggerPct, parseFloat, 'dcaTriggerPct');
    pSet(dcaMultiplier, parseFloat, 'dcaMultiplier'); pSet(startContracts, parseInt, 'startContracts');
    pSet(dgrDailyGrowthRate, parseFloat, 'dgrDailyGrowthRate'); pSet(maxContracts, parseInt, 'maxContracts');
    if (manualDirection === 'long' || manualDirection === 'short') targetWorker.config.manualDirection = manualDirection;
    if (isSecondAccount) { req.user.secondAccount.config = targetWorker.config; req.user.markModified('secondAccount'); }
    else { req.user.config = targetWorker.config; }
    await req.user.save();
    res.json({status: 'ok'});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    const { isSecondAccount } = req.body;
    const workers = activeWorkers.get(req.user._id.toString());
    const target = isSecondAccount ? workers?.second : workers?.main;
    if (target) { await TradeModel.deleteMany({ userId: req.user._id, accountId: target.accountType }); target.metrics = new PerformanceMetrics(target.userId, target.accountType); }
    res.json({status: 'ok'});
});

app.post('/api/user/close-all', authMiddleware, async (req, res) => {
    const { isSecondAccount } = req.body;
    const workers = activeWorkers.get(req.user._id.toString());
    const target = isSecondAccount ? workers?.second : workers?.main;
    if(target) await target.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{});
    res.json({status: 'ok'});
});

app.get('/api/data', authMiddleware, (req, res) => {
    const workers = activeWorkers.get(req.user._id.toString());
    res.json({ main: workers?.main?.getExportData(), second: workers?.second?.getExportData() });
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>TradeBotPille</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>body { background: #fafafa; } .card { background: white; border-radius: 16px; border: 1px solid #e4e4e7; padding: 20px; } .btn-primary { background: #09090b; color: white; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; } .account-tab { padding: 8px 20px; cursor: pointer; border-bottom: 2px solid transparent; } .account-tab.active { border-bottom-color: #09090b; font-weight: 700; } .view-section { display: none; } .active-view { display: block; } input, select { border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px 12px; font-size: 14px; }</style>
</head>
<body>
<div class="max-w-7xl mx-auto px-4 py-6">
    <div class="flex justify-between items-center mb-8">
        <div class="flex items-center gap-3"><div class="w-10 h-10 bg-black rounded-lg flex items-center justify-center"><span class="text-white text-xl">⚡</span></div><div><h1 class="font-bold text-xl">TRADEBOT<span class="text-indigo-600">PILLE</span></h1></div></div>
        <div class="flex gap-3"><button onclick="nav('home')" class="px-4 py-2 text-sm font-semibold">Home</button><button onclick="nav('backtest')" class="px-4 py-2 text-sm font-semibold">Backtest</button><button onclick="nav('dashboard')" class="px-4 py-2 text-sm font-semibold">Terminal</button><button onclick="nav('settings')" class="px-4 py-2 text-sm font-semibold">Settings</button><button onclick="logout()" id="logout-btn" class="px-4 py-2 text-sm font-semibold text-red-600 hidden">Logout</button><button onclick="nav('login')" id="login-btn" class="btn-primary text-sm">Login</button></div>
    </div>
    <div id="view-home" class="view-section active-view text-center py-20"><h1 class="text-6xl font-black mb-4">DUAL ACCOUNT DCA</h1><button onclick="nav('dashboard')" class="btn-primary">Open Terminal</button></div>
    <div id="view-dashboard" class="view-section">
        <div class="flex justify-between items-center mb-6"><h2 class="text-2xl font-black">TERMINAL</h2><div class="flex gap-2 bg-gray-100 rounded-lg p-1"><button onclick="switchAccount('main')" id="tab-main" class="account-tab active">ACCOUNT 1</button><button onclick="switchAccount('second')" id="tab-second" class="account-tab text-gray-400">ACCOUNT 2</button></div></div>
        <div id="main-view">
            <div class="grid grid-cols-4 gap-4 mb-6"><div class="card"><p class="text-xs text-gray-400">PnL</p><p id="main-pnl" class="text-2xl font-bold">$0.00</p></div><div class="card"><p class="text-xs text-gray-400">Wallet</p><p id="main-wallet" class="text-2xl font-bold">$0.00</p></div><div class="card"><p class="text-xs text-gray-400">Live ROI</p><p id="main-roi" class="text-2xl font-bold">IDLE</p></div><div class="card bg-black text-white"><p class="text-xs text-gray-400">Mode</p><p id="main-dir" class="text-2xl font-bold">LONG</p></div></div>
            <div class="card mb-6 h-80"><canvas id="priceChart"></canvas></div><div class="card"><table class="w-full text-sm"><thead><tr><th>Time</th><th>Side</th><th>Exit Reason</th><th class="text-right">PnL</th></tr></thead><tbody id="main-trades"></tbody></table></div>
        </div>
        <div id="second-view" style="display:none">
            <div class="grid grid-cols-4 gap-4 mb-6"><div class="card"><p class="text-xs text-gray-400">PnL</p><p id="second-pnl" class="text-2xl font-bold">$0.00</p></div><div class="card"><p class="text-xs text-gray-400">Wallet</p><p id="second-wallet" class="text-2xl font-bold">$0.00</p></div><div class="card"><p class="text-xs text-gray-400">Live ROI</p><p id="second-roi" class="text-2xl font-bold">IDLE</p></div><div class="card bg-indigo-600 text-white"><p class="text-xs text-indigo-100">Mode</p><p id="second-dir" class="text-2xl font-bold">LONG</p></div></div>
            <div class="card"><table class="w-full text-sm"><thead><tr><th>Time</th><th>Side</th><th>Exit Reason</th><th class="text-right">PnL</th></tr></thead><tbody id="second-trades"></tbody></table></div>
        </div>
    </div>
    <div id="view-settings" class="view-section max-w-2xl mx-auto">
        <div class="card mb-6"><h3 class="font-bold mb-4">ACCOUNT 1</h3><label class="flex items-center gap-3"><input type="checkbox" id="main-live"> Live</label><input type="password" id="main-key" placeholder="API Key" class="w-full mt-2"><input type="password" id="main-secret" placeholder="API Secret" class="w-full mt-2"><button onclick="saveKeys('main')" class="btn-primary w-full mt-3">Save</button></div>
        <div class="card mb-6"><h3 class="font-bold mb-4">ACCOUNT 2</h3><label class="flex items-center gap-3"><input type="checkbox" id="second-live"> Live</label><input type="password" id="second-key" placeholder="API Key" class="w-full mt-2"><input type="password" id="second-secret" placeholder="API Secret" class="w-full mt-2"><button onclick="saveKeys('second')" class="btn-primary w-full mt-3">Save</button></div>
        <div class="card"><h3 class="font-bold mb-4">DCA CONFIG</h3><div class="grid grid-cols-2 gap-4"><div><label>TP%</label><input type="number" id="tp" value="10" class="w-full"></div><div><label>SL%</label><input type="number" id="sl" value="-50" class="w-full"></div><div><label>DCA Trigger</label><input type="number" id="dcaTrigger" value="1" class="w-full"></div><div><label>Multiplier</label><input type="number" id="dcaMult" value="2" class="w-full"></div><div><label>Direction</label><select id="dir" class="w-full"><option value="long">LONG</option><option value="short">SHORT</option></select></div></div><button onclick="saveConfig()" class="btn-primary w-full mt-4">Apply to Current</button></div>
    </div>
    <div id="view-login" class="view-section max-w-md mx-auto"><div class="card"><h2 class="text-2xl font-bold mb-4">Login</h2><input type="email" id="login-email" placeholder="Email" class="w-full mb-3"><input type="password" id="login-pass" placeholder="Password" class="w-full mb-3"><button onclick="doLogin()" class="btn-primary w-full">Login</button></div></div>
    <div id="view-register" class="view-section max-w-md mx-auto"><div class="card"><h2 class="text-2xl font-bold mb-4">Register</h2><input type="text" id="reg-name" placeholder="Name" class="w-full mb-3"><input type="email" id="reg-email" placeholder="Email" class="w-full mb-3"><input type="password" id="reg-pass" placeholder="Password" class="w-full mb-3"><button onclick="doRegister()" class="btn-primary w-full">Register</button></div></div>
</div>
<script>
let authToken = localStorage.getItem('token'); let currentAccount = 'main'; let priceChart = null; let updateInterval = null;
async function doAPI(endpoint, method, body) { const headers = {'Content-Type':'application/json'}; if(authToken) headers['Authorization'] = authToken; const res = await fetch(endpoint, {method, headers, body: body ? JSON.stringify(body) : undefined}); if(res.status === 401) { logout(); return {error: 'Unauthorized'}; } return await res.json(); }
function nav(view) { document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view')); document.getElementById('view-' + view).classList.add('active-view'); if(view === 'dashboard') startUpdates(); else if(updateInterval) clearInterval(updateInterval); }
function logout() { localStorage.removeItem('token'); authToken = null; window.location.reload(); }
function switchAccount(account) { currentAccount = account; document.getElementById('main-view').style.display = account === 'main' ? 'block' : 'none'; document.getElementById('second-view').style.display = account === 'second' ? 'block' : 'none'; document.getElementById('tab-main').classList.toggle('active', account === 'main'); document.getElementById('tab-second').classList.toggle('active', account === 'second'); }
async function saveKeys(account) { await doAPI('/api/user/keys', 'POST', { apiKey: document.getElementById(account + '-key').value, apiSecret: document.getElementById(account + '-secret').value, liveTradingEnabled: document.getElementById(account + '-live').checked, isSecondAccount: account === 'second' }); alert('Saved'); }
async function saveConfig() { await doAPI('/api/user/config', 'POST', { tpPct: document.getElementById('tp').value, slPct: document.getElementById('sl').value, dcaTriggerPct: document.getElementById('dcaTrigger').value, dcaMultiplier: document.getElementById('dcaMult').value, manualDirection: document.getElementById('dir').value, isSecondAccount: currentAccount === 'second' }); alert('Config Applied'); }
async function fetchData() {
    const data = await doAPI('/api/data', 'GET');
    if(data.main) { document.getElementById('main-pnl').innerText = '$' + (data.main.metrics?.totalNetPnl || 0).toFixed(4); document.getElementById('main-wallet').innerText = '$' + (data.main.walletBalance || 0).toFixed(2); document.getElementById('main-roi').innerText = (data.main.activePositions?.[0]?.exchangeROI || 0).toFixed(2) + '%'; document.getElementById('main-dir').innerText = data.main.config.manualDirection.toUpperCase(); const mTrades = (data.main.metrics?.trades || []).slice().reverse().slice(0, 10); document.getElementById('main-trades').innerHTML = mTrades.map(t => '<tr><td>'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="font-bold">'+t.side+'</td><td>'+t.exitReason+'</td><td class="text-right">$'+t.netPnl.toFixed(4)+'</td></tr>').join(''); }
    if(data.second) { document.getElementById('second-pnl').innerText = '$' + (data.second.metrics?.totalNetPnl || 0).toFixed(4); document.getElementById('second-wallet').innerText = '$' + (data.second.walletBalance || 0).toFixed(2); document.getElementById('second-roi').innerText = (data.second.activePositions?.[0]?.exchangeROI || 0).toFixed(2) + '%'; document.getElementById('second-dir').innerText = data.second.config.manualDirection.toUpperCase(); const sTrades = (data.second.metrics?.trades || []).slice().reverse().slice(0, 10); document.getElementById('second-trades').innerHTML = sTrades.map(t => '<tr><td>'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="font-bold">'+t.side+'</td><td>'+t.exitReason+'</td><td class="text-right">$'+t.netPnl.toFixed(4)+'</td></tr>').join(''); }
    if(data.main?.binance?.mid && priceChart) { priceChart.data.labels.push(''); priceChart.data.datasets[0].data.push(data.main.binance.mid); if(priceChart.data.labels.length > 50) { priceChart.data.labels.shift(); priceChart.data.datasets[0].data.shift(); } priceChart.update('none'); }
}
async function doLogin() { const res = await doAPI('/api/auth/login', 'POST', {email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value}); if(res.token) { authToken = res.token; localStorage.setItem('token', authToken); window.location.reload(); } }
async function doRegister() { const res = await doAPI('/api/auth/register', 'POST', {name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value}); if(res.token) { authToken = res.token; localStorage.setItem('token', authToken); window.location.reload(); } }
function startUpdates() { if(updateInterval) clearInterval(updateInterval); updateInterval = setInterval(fetchData, 2000); }
if(authToken) { document.getElementById('login-btn').classList.add('hidden'); document.getElementById('logout-btn').classList.remove('hidden'); const ctx = document.getElementById('priceChart').getContext('2d'); priceChart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'SHIB', data: [], borderColor: 'black', borderWidth: 2, pointRadius: 0 }] }, options: { animation: false, scales: { x: { display: false } } } }); nav('dashboard'); }
</script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => { console.log(`✅ Server running on port ${CUSTOM_PORT}`); await loadAllUsers(); startMasterStreams(); });
