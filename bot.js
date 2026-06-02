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
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('🚨 MongoDB Error:', err));

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
    leverage: FORCED_LEVERAGE, 
    baseContracts: 1,           // START CONTRACTS
    contractSize: 1000, 
    marginMode: 'cross', 
    fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    direction: 'long',          // MANUAL SETTING: 'long' or 'short'
    dailyGrowthRate: 1.0,       // DGR: Target % Profit per day
    dcaRoiThresholdPct: 1.0,    // DCA TRIGGER PERCENTAGE (As positive number)
    dcaMultiplier: 2.0,         // DCA MULTIPLIER
    profitRoiThresholdPct: 2.0, 
    profitMultiplier: 2.0, 
    maxContracts: 100, 
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    htx: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 100, type: 'manual', rawValue: 1.0 } 
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

// ==================== DIRECTIONAL ENGINE (AI REMOVED) ====================
function calculateMLSignal(prices, config) {
    // This now simply returns the manual direction setting as a 'signal'
    const direction = config.direction || 'long';
    return { 
        confidence: 100, 
        type: direction === 'long' ? 'bull' : 'bear', 
        rawValue: direction === 'long' ? 1.0 : 0.0 
    };
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
    } catch (e) { if (allCandles.length === 0) allCandles = await publicBinance.fetchOHLCV(symbol, '1m', undefined, 1000).catch(()=>[]) || []; }

    const ticks = allCandles.map(c => ({ timestamp: c[0], priceMid: c[4] }));
    if (!ticks || ticks.length === 0) return { error: `No historical tick data fetched.` };

    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { direction = 'long', dcaRoiThresholdPct = 1.0, dcaMultiplier = 2.0, maxContracts = 100 } = config;
    
    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;
        let signal = direction === 'long' ? 'long' : 'short';

        if (!activePos) {
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
            
            if (math.currentGrossRoi >= config.takeProfitPct) forceExitReason = "TAKE_PROFIT";
            else if (math.currentGrossRoi <= config.stopLossPct) forceExitReason = "STOP_LOSS";

            if (forceExitReason) {
                netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
                totalTradeDurationMs += (tickTime - activePos.entryTime);
                closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: price, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: forceExitReason, time: tick.timestamp });
                activePos = null;
            } else {
                const requiredRoiForDca = -(Math.abs(dcaRoiThresholdPct));
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1;
                    let mult = Number(dcaMultiplier) || 2.0;
                    let step = Number(activePos.dcaStep) || 0;
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    if (activePos.contracts + contractsToAdd <= maxContracts) {
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
    return { ticksAnalyzed: ticks.length, totalTradesCount: closedTrades.length, wins, losses, winRate: closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(2) : 0, netPnl, depositNeeded: maxMarginUsed, trades: closedTrades.slice(-200) };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.config.leverage = FORCED_LEVERAGE;
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.currentMl = { confidence: 100, type: 'manual', rawValue: 1.0 };
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const key = user.apiKey || "demo", secret = user.apiSecret || "demo";
        this.htx = new ccxt.pro.htx({ apiKey: key, secret: secret, agent: keepAliveAgent, enableRateLimit: false, options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } });
    }
    
    async initialize() {
        await this.metrics.init(); 
        if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed);
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } });
        const cacheEntry = tokenCache.get(this.userId);
        if(cacheEntry) cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null; 
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? openPos.entryPrice * 1000 : openPos.entryPrice;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else this.activePositions = []; await this.saveState();
            } return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }

    async evaluateAIEntry() {
        const signal = this.config.direction === 'long' ? 'long' : 'short';
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        // DGR Check: If daily profit target met, stop opening new trades
        const dailyProfit = this.metrics.trades.filter(t => t.timestamp > new Date().setHours(0,0,0,0)).reduce((sum, t) => sum + t.netPnl, 0);
        const targetUsd = (this.walletBalance * (this.config.dailyGrowthRate / 100));
        if (dailyProfit >= targetUsd && targetUsd > 0) return;

        try {
            if (this.activePositions.length === 0) await this.syncState(signal);
        } catch (e) { console.error(`🚨 [Eval Error]:`, e.message); }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0];
            let effectiveRoi = pos.exchangeROI || 0;
            if (effectiveRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
            else if (effectiveRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
            else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaRoiThresholdPct));
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(false);
            }
        } catch (e) { console.error(`🚨 [Exit Error]:`, e.message); }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let multiplier = Number(this.config.dcaMultiplier) || 2.0;
            let baseC = Number(this.config.baseContracts) || 1;
            let step = Number(pos.dcaStep) || 0;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step))), 10);
            
            if (Number(pos.contracts) + contractsToAdd > this.config.maxContracts) { this.isTrading = false; return; }
            pos.lastDcaTime = Date.now(); await this.saveState();
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled) {
                const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
            }
            const addedSizeUsd = contractsToAdd * (this.config.contractSize || 1000) * realExecPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (realExecPrice * addedSizeUsd)) / (pos.size + addedSizeUsd);
            pos.size += addedSizeUsd; pos.contracts += contractsToAdd; pos.marginUsed += (addedSizeUsd / FORCED_LEVERAGE); pos.dcaStep++;
            await this.saveState();
        } catch (err) { console.error(`🚨 [DCA Error]:`, err.message); } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const contracts = parseInt(this.config.baseContracts || 1, 10);
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!this.liveTradingEnabled === false) {
                await this.htx.createMarketOrder(this.config.htxSymbol, targetSide === 'long' ? 'buy' : 'sell', contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
            }
            const sizeUsd = contracts * (this.config.contractSize || 1000) * executionPrice;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper: !this.liveTradingEnabled, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
            await this.saveState();
        } catch (err) { console.error(`🚨 [Open Error]:`, err.message); } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            if (this.liveTradingEnabled && !snapPos.isPaper) {
                await this.htx.createMarketOrder(this.config.htxSymbol, snapPos.side === 'long' ? 'sell' : 'buy', snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
            }
            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, globalMarketData.binance.mid, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: globalMarketData.binance.mid, marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } catch (err) { console.error(`🚨 [Close Error]:`, err.message); } finally { this.isTrading = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0) {
                if (this.liveTradingEnabled) try { const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = bal.total?.USDT || 0; } catch(e){}
                return;
            }
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled && !pos.isPaper) {
                try {
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const openPos = positions.find(p => p.contracts > 0);
                    if (openPos) { pos.exchangeROI = openPos.percentage || 0; pos.exchangePnl = openPos.unrealizedPnl || 0; }
                    else { this.activePositions = []; await this.saveState(); }
                } catch(e) {}
            } else {
                const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                pos.exchangeROI = math.currentGrossRoi; pos.exchangePnl = math.netPnlUsd;
            }
        }, 1000);
    }

    getExportData() { return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance, walletBalance: this.walletBalance }; }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); } catch (e) {}
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid: mid, timestamp: Date.now() };
                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateAIEntry().catch(()=>{}); 
                }
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u);
        await worker.initialize();
        activeWorkers.set(u._id.toString(), worker);
        if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
    }
}

// ==================== ANALYTICS & EXPRESS ====================
const activeSessions = new Map();
const app = express(); app.use(express.json());

app.post('/api/backtest', async (req, res) => {
    const bConfig = { ...BASE_CONFIG, takeProfitPct: parseFloat(req.body.tpPct), stopLossPct: parseFloat(req.body.slPct), direction: req.body.direction, baseContracts: parseInt(req.body.baseContracts), dcaRoiThresholdPct: parseFloat(req.body.dcaRoiThresholdPct), dcaMultiplier: parseFloat(req.body.dcaMultiplier) };
    const results = await runBacktestSimulation(bConfig, parseInt(req.body.ticks) || 1000, BASE_CONFIG.binanceSymbol);
    res.json(results);
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
    const worker = new UserTradeInstance(user); await worker.initialize();
    activeWorkers.set(user._id.toString(), worker); res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save(); res.json({ token: user.token });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Not found" });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(req.body.direction) worker.config.direction = req.body.direction;
    if(req.body.dcaMultiplier) worker.config.dcaMultiplier = parseFloat(req.body.dcaMultiplier);
    if(req.body.dcaRoiThresholdPct) worker.config.dcaRoiThresholdPct = parseFloat(req.body.dcaRoiThresholdPct);
    if(req.body.baseContracts) worker.config.baseContracts = parseInt(req.body.baseContracts);
    if(req.body.dailyGrowthRate) worker.config.dailyGrowthRate = parseFloat(req.body.dailyGrowthRate);
    req.user.config = worker.config; await req.user.save(); res.json({status: 'ok'});
});

app.get('/', (req, res) => { res.send(`
<!DOCTYPE html><html><head><title>TradeBotPille | Directional Engine</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-zinc-50 text-zinc-900 font-sans">
    <div class="max-w-4xl mx-auto p-10">
        <h1 class="text-4xl font-black mb-10">DIRECTIONAL DCA ENGINE</h1>
        <div class="grid grid-cols-2 gap-5 mb-10">
            <div class="bg-white p-6 rounded-xl border">
                <label class="block text-xs font-bold uppercase mb-2">Manual Direction</label>
                <select id="dirSelect" class="w-full p-3 border rounded">
                    <option value="long">Long Preference</option>
                    <option value="short">Short Preference</option>
                </select>
            </div>
            <div class="bg-white p-6 rounded-xl border">
                <label class="block text-xs font-bold uppercase mb-2">Daily Growth Target (%)</label>
                <input type="number" id="dgrInput" class="w-full p-3 border rounded" value="1.0">
            </div>
        </div>
        <div class="bg-white p-8 rounded-xl border shadow-sm">
            <h2 class="font-bold mb-4">DCA Parameters</h2>
            <div class="grid grid-cols-3 gap-4">
                <input type="number" id="baseC" placeholder="Start Contracts" class="p-3 border rounded">
                <input type="number" id="dcaMult" placeholder="DCA Multiplier" class="p-3 border rounded">
                <input type="number" id="dcaTrig" placeholder="DCA Trigger %" class="p-3 border rounded">
            </div>
            <button onclick="saveConfig()" class="mt-6 w-full bg-black text-white font-bold p-4 rounded">Update Strategy</button>
        </div>
    </div>
    <script>
        async function saveConfig() {
            const token = localStorage.getItem('bot_token');
            await fetch('/api/user/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': token },
                body: JSON.stringify({
                    direction: document.getElementById('dirSelect').value,
                    dailyGrowthRate: document.getElementById('dgrInput').value,
                    baseContracts: document.getElementById('baseC').value,
                    dcaMultiplier: document.getElementById('dcaMult').value,
                    dcaRoiThresholdPct: document.getElementById('dcaTrig').value
                })
            });
            alert('Settings Synced');
        }
    </script>
</body></html>`); 
});

// ==================== APP INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers(); startMasterStreams();
});
