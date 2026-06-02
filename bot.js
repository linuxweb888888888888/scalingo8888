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

const UserModel = mongoose.model('User_V3_Hedge', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },      // Account 1 (Longs)
    apiSecret: { type: String, default: "" },   // Account 1 (Longs)
    apiKey2: { type: String, default: "" },     // Account 2 (Shorts)
    apiSecret2: { type: String, default: "" },  // Account 2 (Shorts)
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

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let userEntry = tokenCache.get(token);
    if (!userEntry) {
        const user = await UserModel.findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        userEntry = { user, lastAccessed: Date.now() };
        tokenCache.set(token, userEntry);
    }
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

// ==================== ML ENGINE ====================
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
    return { confidence: Math.min(Math.abs(finalPred - 0.5) * 200, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.wins = 0; this.losses = 0; this.winRate = 0; this.totalTradesCount = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++;
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        this.totalNetPnl += trade.netPnl || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
}

// ==================== USER BOT INSTANCE (DUAL API HEDGE) ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.metrics = new PerformanceMetrics(this.userId);
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat' };
        this.mlRawBuffer = []; this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const opt = { agent: keepAliveAgent, enableRateLimit: false, options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } };
        // Primary account for Longs, Secondary for Shorts
        this.htxLong = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", ...opt });
        this.htxShort = new ccxt.pro.htx({ apiKey: user.apiKey2 || "demo", secret: user.apiSecret2 || "demo", ...opt });
    }
    
    async initialize() {
        await this.metrics.init(); 
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htxLong.loadMarkets(); await this.htxShort.loadMarkets();
                const posLong = (await this.htxLong.fetchPositions([this.config.htxSymbol])).find(p => p.contracts > 0);
                const posShort = (await this.htxShort.fetchPositions([this.config.htxSymbol])).find(p => p.contracts > 0);
                const openPos = posLong || posShort;
                if (openPos) {
                    let ep = openPos.entryPrice; if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) ep = ep * 1000;
                    const size = openPos.contracts * this.config.contractSize * ep;
                    this.activePositions = [{ side: openPos.side, entryPrice: ep, contracts: openPos.contracts, size, marginUsed: size/FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, dcaStep: 0, isPaper: false, stepHistory: [] }];
                } else this.activePositions = [];
                await this.saveState();
            }
            return { success: true };
        } catch (e) { return { success: false, message: e.message }; }
    }

    async evaluateAIEntry() {
        let mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
        this.mlRawBuffer.push(mlSig.rawValue); if (this.mlRawBuffer.length > this.config.mlAverageTicks) this.mlRawBuffer.shift();
        let avgRaw = this.mlRawBuffer.reduce((a,b)=>a+b,0)/this.mlRawBuffer.length;
        this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, avgType: avgRaw >= 0.5 ? 'bull' : 'bear', avgConf: Math.abs(avgRaw-0.5)*200 };

        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        const activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
        const activeConf = this.config.mlUseAverage ? this.currentMl.avgConf : mlSig.confidence;
        const signal = activeConf >= this.config.mlThreshold ? (activeType === 'bull' ? 'long' : 'short') : null;

        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            if (signal && pos.side !== signal) {
                if (!this.config.flipOnlyInProfit || pos.exchangeROI >= (this.config.flipThresholdPct || 0)) {
                    await this.forceClosePosition("ML_FLIP");
                    setTimeout(() => this.syncState(signal), 500);
                }
            }
        } else if (signal) await this.syncState(signal);
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        if (roi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (roi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
        else {
            const reqDca = -(Math.abs(this.config.dcaRoiThresholdPct));
            const reqScale = this.config.profitRoiThresholdPct;
            if (roi <= reqDca && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(false);
            else if (roi >= reqScale && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(true);
        }
    }

    async syncState(targetSide) {
        this.isTrading = true;
        try {
            const ex = targetSide === 'long' ? this.htxLong : this.htxShort;
            let price = globalMarketData.binance.mid;
            let qty = Math.max(1, Math.floor(this.walletBalance * 1));
            if (this.liveTradingEnabled) {
                const res = await ex.createMarketOrder(this.config.htxSymbol, targetSide==='long'?'buy':'sell', qty, undefined, { offset: 'open' });
                price = res.average || price;
            }
            const size = qty * this.config.contractSize * price;
            this.activePositions = [{ side: targetSide, entryPrice: price, contracts: qty, size, marginUsed: size/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, dcaStep: 0, isPaper: !this.liveTradingEnabled, stepHistory: [{ step: 0, type: 'OPEN', price, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } catch (e) { this.activePositions = []; } finally { this.isTrading = false; }
    }

    async addDcaPosition(isProfit = false) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const ex = pos.side === 'long' ? this.htxLong : this.htxShort;
            const mult = isProfit ? this.config.profitMultiplier : this.config.dcaMultiplier;
            const qtyToAdd = Math.floor(pos.contracts * (mult - 1));
            if (qtyToAdd < 1) return;
            if (isProfit && pos.contracts + qtyToAdd > this.config.maxContracts) return;
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'buy':'sell', qtyToAdd, undefined, { offset: 'open' });
            pos.contracts += qtyToAdd; pos.lastDcaTime = Date.now(); pos.dcaStep++;
            await this.saveState();
        } catch (e) {} finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const ex = pos.side === 'long' ? this.htxLong : this.htxShort;
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'sell':'buy', pos.contracts, undefined, { reduceOnly: true, offset: 'close' });
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, marginUsed: math.margin, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } catch (e) {} finally { this.isTrading = false; }
    }

    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const b1 = await this.htxLong.fetchBalance({ type: 'swap' });
                    const b2 = await this.htxShort.fetchBalance({ type: 'swap' });
                    this.walletBalance = (b1.total?.USDT || 0) + (b2.total?.USDT || 0);
                    if (this.activePositions.length > 0) {
                        const side = this.activePositions[0].side;
                        const ex = side === 'long' ? this.htxLong : this.htxShort;
                        const p = (await ex.fetchPositions([this.config.htxSymbol])).find(x => x.contracts > 0);
                        if (p) this.activePositions[0].exchangeROI = p.percentage; else this.activePositions = [];
                    }
                } catch(e){}
            }
        }, 1000);
    }
    getExportData() { return { config: this.config, metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, walletBalance: this.walletBalance, liveTradingEnabled: this.liveTradingEnabled }; }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    await publicBinance.loadMarkets();
    (async function streamBinance() {
        while (true) {
            try {
                const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (t.bid + t.ask) / 2;
                globalMarketData.binance = { mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                for (const w of activeWorkers.values()) { w.checkExits(); w.evaluateAIEntry(); }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 1000));
        }
    })();
}

async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) { const w = new UserTradeInstance(u); await w.initialize(); activeWorkers.set(u._id.toString(), w); }
}

// ==================== API ROUTES ====================
const app = express(); app.use(express.json());
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
    const w = new UserTradeInstance(user); await w.initialize(); activeWorkers.set(user._id.toString(), w);
    tokenCache.set(user.token, { user }); res.json({ token: user.token });
});
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save();
        const w = new UserTradeInstance(user); await w.initialize(); activeWorkers.set(user._id.toString(), w);
        tokenCache.set(user.token, { user }); res.json({ token: user.token });
    } else res.status(401).json({ error: 'Invalid' });
});
app.get('/api/data', authMiddleware, (req, res) => res.json(activeWorkers.get(req.user._id.toString())?.getExportData() || {}));
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    Object.assign(req.user, req.body); await req.user.save();
    activeWorkers.get(req.user._id.toString()).applyUserKeys(req.user); res.json({ status: 'ok' });
});
app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = activeWorkers.get(req.user._id.toString()); Object.assign(w.config, req.body);
    req.user.config = w.config; req.user.markModified('config'); await req.user.save(); res.json({ status: 'ok' });
});
app.get('/api/close-all', authMiddleware, async (req, res) => { await activeWorkers.get(req.user._id.toString()).forceClosePosition(); res.json({status:'ok'}); });

// ==================== DASHBOARD UI ====================
app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBotPille | SHIB Hedge AI</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f3f4f6; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; text-align: center; width: 100%; }
        .view-section { display: none; } .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">
    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2 cursor-pointer" onclick="nav('home')">
                <span class="material-symbols-outlined text-black text-3xl">api</span>
                <span class="font-bold text-lg">TradeBotPille</span>
            </div>
            <nav id="nav-private" class="flex items-center gap-6 text-sm font-medium">
                <button onclick="nav('dashboard')" class="hover:text-black transition">Dashboard</button>
                <button onclick="logout()" class="text-red-500">Logout</button>
            </nav>
        </div>
    </header>

    <main class="flex-grow p-8">
        <!-- AUTH -->
        <section id="view-home" class="view-section active-view max-w-md mx-auto py-20">
            <div class="ui-card p-8">
                <h2 class="text-2xl font-bold mb-6 text-center">Terminal Access</h2>
                <div class="space-y-4">
                    <input type="email" id="email" placeholder="Email" class="input-minimal">
                    <input type="password" id="pass" placeholder="Password" class="input-minimal">
                    <button onclick="login()" class="btn-primary">Enter Terminal</button>
                </div>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section max-w-7xl mx-auto">
            <div class="flex justify-between items-center mb-8">
                <h2 class="text-2xl font-bold">Hedge Terminal <span id="statusBadge" class="ml-2 text-xs bg-gray-100 px-2 py-1 rounded">Offline</span></h2>
                <div class="flex gap-2">
                    <button onclick="nav('settings')" class="px-4 py-2 bg-white border rounded-md text-sm font-bold">Setup API</button>
                    <button onclick="closeAll()" class="px-4 py-2 bg-red-50 text-red-600 rounded-md text-sm font-bold">Close All</button>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400">NET PNL</p><p id="netPnl" class="text-xl font-mono font-bold">$0.00</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400">WALLET BALANCE</p><p id="balance" class="text-xl font-mono font-bold">$0.00</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400">LIVE ROI</p><p id="roi" class="text-xl font-mono font-bold">0.00%</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400">AI SIGNAL</p><p id="ai" class="text-xl font-mono font-bold">WAITING</p></div>
                    </div>
                    <div class="ui-card p-6">
                        <h3 class="font-bold mb-4">Trade History</h3>
                        <table class="w-full text-sm text-left"><thead class="text-gray-400"><tr><th>Side</th><th>Reason</th><th>Net PnL</th></tr></thead><tbody id="thistory" class="font-mono"></tbody></table>
                    </div>
                </div>

                <div class="lg:col-span-4 h-fit">
                    <div class="ui-card p-6">
                        <h3 class="font-bold mb-4 border-b pb-2">Strategy Settings</h3>
                        <div class="space-y-4 text-xs font-bold text-gray-500">
                            <div>TP %<input id="s-tp" class="input-minimal mt-1 text-green-600"></div>
                            <div>SL %<input id="s-sl" class="input-minimal mt-1 text-red-600"></div>
                            <hr>
                            <div>DCA Multiplier<input id="s-dca-m" class="input-minimal mt-1"></div>
                            <div>Profit Multiplier<input id="s-p-m" class="input-minimal mt-1"></div>
                            <div>Max Contracts<input id="s-max" class="input-minimal mt-1"></div>
                            <hr>
                            <div>ML Threshold %<input id="s-ml-t" class="input-minimal mt-1 text-blue-600"></div>
                            <div>ML Lookback<input id="s-look" class="input-minimal mt-1"></div>
                            <button onclick="saveConfig()" class="btn-primary mt-4">Save Strategy</button>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <!-- SETUP API -->
        <section id="view-settings" class="view-section max-w-lg mx-auto py-10">
            <div class="ui-card p-8">
                <h3 class="text-xl font-bold mb-6">Dual API Hedge Setup</h3>
                <div class="space-y-6">
                    <div class="flex items-center gap-2"><input type="checkbox" id="liveTrade" class="w-4 h-4"> <label class="font-bold">Enable Live Trading</label></div>
                    <div class="p-4 bg-gray-50 rounded-lg">
                        <p class="text-[10px] font-bold text-green-600 uppercase mb-2">ACCOUNT 1 (LONG ONLY)</p>
                        <input type="password" id="key1" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec1" placeholder="API Secret" class="input-minimal">
                    </div>
                    <div class="p-4 bg-gray-50 rounded-lg">
                        <p class="text-[10px] font-bold text-red-600 uppercase mb-2">ACCOUNT 2 (SHORT ONLY)</p>
                        <input type="password" id="key2" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec2" placeholder="API Secret" class="input-minimal">
                    </div>
                    <button onclick="saveKeys()" class="btn-primary">Update API Integration</button>
                    <button onclick="nav('dashboard')" class="w-full text-sm mt-2 text-gray-400">Cancel</button>
                </div>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('token');
        async function api(path, method='GET', body=null) {
            const res = await fetch(path, { method, headers: {'Content-Type':'application/json', 'Authorization':token}, body: body?JSON.stringify(body):null });
            return res.json();
        }
        function nav(id) { document.querySelectorAll('.view-section').forEach(s=>s.classList.remove('active-view')); document.getElementById('view-'+id).classList.add('active-view'); }
        async function login() { 
            const r = await api('/api/auth/login','POST',{email:document.getElementById('email').value, password:document.getElementById('pass').value});
            if(r.token) { token=r.token; localStorage.setItem('token',token); location.reload(); }
        }
        function logout() { localStorage.removeItem('token'); location.reload(); }
        async function saveKeys() {
            await api('/api/user/keys','POST',{apiKey:document.getElementById('key1').value, apiSecret:document.getElementById('sec1').value, apiKey2:document.getElementById('key2').value, apiSecret2:document.getElementById('sec2').value, liveTradingEnabled:document.getElementById('liveTrade').checked});
            alert('Connected'); nav('dashboard');
        }
        async function saveConfig() {
            await api('/api/user/config','POST',{takeProfitPct:parseFloat(document.getElementById('s-tp').value), stopLossPct:parseFloat(document.getElementById('s-sl').value), dcaMultiplier:parseFloat(document.getElementById('s-dca-m').value), profitMultiplier:parseFloat(document.getElementById('s-p-m').value), maxContracts:parseInt(document.getElementById('s-max').value), mlThreshold:parseFloat(document.getElementById('s-ml-t').value), mlLookback:parseInt(document.getElementById('s-look').value)});
            alert('Saved');
        }
        async function closeAll() { if(confirm('Close?')) await api('/api/close-all'); }
        
        if(token) {
            nav('dashboard');
            setInterval(async () => {
                const d = await api('/api/data');
                if(!d.metrics) return;
                document.getElementById('netPnl').innerText = '$'+d.metrics.totalNetPnl.toFixed(2);
                document.getElementById('balance').innerText = '$'+d.walletBalance.toFixed(2);
                document.getElementById('roi').innerText = (d.activePositions[0]?.exchangeROI || 0).toFixed(2)+'%';
                document.getElementById('ai').innerText = d.mlSignal.confidence.toFixed(1)+'% '+d.mlSignal.type.toUpperCase();
                document.getElementById('statusBadge').innerText = d.activePositions.length > 0 ? d.activePositions[0].side.toUpperCase() : (d.liveTradingEnabled ? 'LIVE WAIT' : 'PAPER WAIT');
                
                const h = document.getElementById('thistory'); h.innerHTML = '';
                d.metrics.trades.reverse().slice(0,10).forEach(t => {
                    h.innerHTML += '<tr class="border-b"><td>'+t.side.toUpperCase()+'</td><td>'+t.exitReason+'</td><td class="'+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$'+t.netPnl.toFixed(2)+'</td></tr>';
                });

                if(!document.getElementById('s-tp').value) {
                    document.getElementById('s-tp').value = d.config.takeProfitPct; document.getElementById('s-sl').value = d.config.stopLossPct;
                    document.getElementById('s-dca-m').value = d.config.dcaMultiplier; document.getElementById('s-p-m').value = d.config.profitMultiplier;
                    document.getElementById('s-max').value = d.config.maxContracts; document.getElementById('s-ml-t').value = d.config.mlThreshold;
                    document.getElementById('s-look').value = d.config.mlLookback;
                    document.getElementById('liveTrade').checked = d.liveTradingEnabled;
                }
            }, 1000);
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => { await loadAllUsers(); startMasterStreams(); });
