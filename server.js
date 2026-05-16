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
    initialBalance: { type: Number, default: 0 },
    totalPnlGrowth: { type: Number, default: 0 },
    totalGrowthPct: { type: Number, default: 0 }
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
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
const TIMEFRAME_MS = 5 * 60 * 1000; // 5 Minutes

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0, 
    flipOnlyInProfit: true, flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, profitMultiplier: 2.0, 
    maxContracts: 100
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [], // Used for HA calculation
    haCandles: []   // Computed Heikin Ashi candles
};

const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// ==================== HEIKIN ASHI ENGINE ====================
function calculateHA(ticks) {
    if (ticks.length < 5) return [];

    // 1. Bucket ticks into 5m Standard OHLC
    const buckets = {};
    ticks.forEach(t => {
        const time = t.timestamp || Date.now();
        const bucket = Math.floor(time / TIMEFRAME_MS) * TIMEFRAME_MS;
        if (!buckets[bucket]) buckets[bucket] = [];
        buckets[bucket].push(t.priceMid);
    });

    const sortedBuckets = Object.keys(buckets).sort().map(Number);
    const ohlc = sortedBuckets.map(b => {
        const p = buckets[b];
        return { time: b, o: p[0], h: Math.max(...p), l: Math.min(...p), c: p[p.length - 1] };
    });

    // 2. Transform to Heikin Ashi
    const ha = [];
    ohlc.forEach((curr, i) => {
        const close = (curr.o + curr.h + curr.l + curr.c) / 4;
        let open;
        if (i === 0) open = (curr.o + curr.c) / 2;
        else open = (ha[i - 1].open + ha[i - 1].close) / 2;
        
        const high = Math.max(curr.h, open, close);
        const low = Math.min(curr.l, open, close);
        ha.push({ time: curr.time, open, high, low, close, color: close >= open ? 'bull' : 'bear' });
    });
    return ha;
}

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

const tokenCache = new Map();
async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let u = tokenCache.get(token);
    if (!u) {
        const user = await UserModel.findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        u = { user, lastAccessed: Date.now() };
        tokenCache.set(token, u);
    }
    req.user = u.user;
    next();
}

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    return { currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd: grossPnlUsd - feeCost, margin };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.startTime = Date.now(); 
        this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.walletBalance = 0;
        this.initialBalance = user.initialBalance || 0;
        this.totalPnlGrowth = user.totalPnlGrowth || 0;
        this.totalGrowthPct = user.totalGrowthPct || 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ 
            apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, 
            options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } 
        });
    }
    
    async initialize() {
        await this.metrics.init(); 
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { 
            activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, 
            lastCloseTime: this.lastCloseTime, config: this.config,
            initialBalance: this.initialBalance, totalPnlGrowth: this.totalPnlGrowth, totalGrowthPct: this.totalGrowthPct
        } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0 }];
                } else this.activePositions = [];
                await this.saveState();
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false }; }
    }

    async evaluateHAEntry() {
        if (globalMarketData.haCandles.length < 2 || this.isTrading) return;
        
        const lastCandle = globalMarketData.haCandles[globalMarketData.haCandles.length - 1];
        const signal = lastCandle.color === 'bull' ? 'long' : 'short';

        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            if (pos.side !== signal) {
                const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                if (!this.config.flipOnlyInProfit || math.currentGrossRoi >= (this.config.flipThresholdPct || 0)) {
                    await this.forceClosePosition("HA_TREND_FLIP");
                    setTimeout(() => this.syncState(signal), 1000);
                }
            }
        } else {
            if (Date.now() - this.lastCloseTime > 5000) await this.syncState(signal);
        }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            let multiplier = isProfitScale ? 1.5 : this.config.dcaMultiplier;
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, pos.dcaStep || 0))), 10);
            
            if (!pos.isPaper && this.liveTradingEnabled) {
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', lever_rate: FORCED_LEVERAGE });
            }
            const realExecPrice = globalMarketData.binance.mid;
            const addedSizeUsd = contractsToAdd * 1000 * realExecPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (realExecPrice * addedSizeUsd)) / (pos.size + addedSizeUsd);
            pos.size += addedSizeUsd;
            pos.contracts += contractsToAdd;
            pos.dcaStep = (pos.dcaStep || 0) + 1;
            pos.lastDcaTime = Date.now();
            await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            const contracts = parseInt(baseC, 10);
            if (!this.liveTradingEnabled === false) {
                await this.htx.createMarketOrder(this.config.htxSymbol, targetSide === 'long' ? 'buy' : 'sell', contracts, undefined, { offset: 'open', lever_rate: FORCED_LEVERAGE });
            }
            const execPrice = globalMarketData.binance.mid;
            const sizeUsd = contracts * 1000 * execPrice;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: execPrice, contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, isPaper: !this.liveTradingEnabled, dcaStep: 0 }];
            await this.saveState();
        } catch (err) { this.activePositions = []; } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const p = this.activePositions[0];
            if (!p.isPaper && this.liveTradingEnabled) {
                await this.htx.createMarketOrder(this.config.htxSymbol, p.side === 'long' ? 'sell' : 'buy', p.contracts, undefined, { reduceOnly: true, offset: 'close' });
            }
            const math = calculateTradeMath(p.side, p.entryPrice, globalMarketData.binance.mid, p.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: p.side, contracts: p.contracts, entryPrice: p.entryPrice, exitPrice: globalMarketData.binance.mid, marginUsed: p.marginUsed, netPnl: math.netPnlUsd, exitReason: reason });
            this.activePositions = [];
            this.lastCloseTime = Date.now();
            await this.saveState();
        } catch (err) {} finally { this.isTrading = false; }
    }

    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total?.USDT || 0;
                    if (this.walletBalance > 0) {
                        if (this.initialBalance === 0) this.initialBalance = this.walletBalance;
                        this.totalPnlGrowth = this.walletBalance - this.initialBalance;
                        this.totalGrowthPct = (this.totalPnlGrowth / this.initialBalance) * 100;
                    }
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const openPos = positions.find(p => p.contracts > 0);
                    if (this.activePositions[0] && openPos) {
                        this.activePositions[0].exchangeROI = openPos.percentage || 0;
                    }
                } catch(e) {}
            }
        }, 1000);
    }

    getExportData() { 
        return { 
            config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, activePositions: this.activePositions, haCandles: globalMarketData.haCandles.slice(-100),
            walletBalance: this.walletBalance, initialBalance: this.initialBalance, totalPnlGrowth: this.totalPnlGrowth, totalGrowthPct: this.totalGrowthPct
        }; 
    }
}

// ==================== PERFORMANCE CLASS ====================
class PerformanceMetrics {
    constructor(userId) { this.userId = userId; this.trades = []; this.totalNetPnl = 0; this.winRate = 0; }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(50).lean(); 
        dbTrades.reverse().forEach(t => { this.totalNetPnl += t.netPnl; this.trades.push(t); });
    }
    recordTrade(t) { 
        this.totalNetPnl += t.netPnl; this.trades.push(t); 
        TradeModel.create({ ...t, userId: this.userId }).catch(()=>{});
    }
}

// ==================== MASTER STREAMS ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    await publicBinance.loadMarkets();
    const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(3000).lean();
    globalMarketData.tickBuffer = history.reverse();

    (async function stream() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push({ priceMid: mid, timestamp: Date.now() });
                if (globalMarketData.tickBuffer.length > 10000) globalMarketData.tickBuffer.shift();

                globalMarketData.haCandles = calculateHA(globalMarketData.tickBuffer);
                ChartDataModel.create({ priceMid: mid }).catch(()=>{});

                for (const worker of activeWorkers.values()) {
                    worker.evaluateHAEntry().catch(()=>{});
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) {
        const w = new UserTradeInstance(u);
        await w.initialize();
        activeWorkers.set(u._id.toString(), w);
    }
}

// ==================== API ROUTES ====================
const app = express(); app.use(express.json());
app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    const w = new UserTradeInstance(user); await w.initialize();
    activeWorkers.set(user._id.toString(), w);
    res.json({ token: user.token, user: { name: user.name } });
});
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    res.json({ token: user.token, user: { name: user.name } });
});
app.get('/api/data', authMiddleware, (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    res.json(w ? w.getExportData() : { error: "Worker not found" });
});
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    if(w) { 
        w.liveTradingEnabled = req.body.liveTradingEnabled; 
        w.applyUserKeys({ apiKey: req.body.apiKey, apiSecret: req.body.apiSecret, liveTradingEnabled: req.body.liveTradingEnabled });
        await w.connectExchange();
    }
    req.user.apiKey = req.body.apiKey; req.user.apiSecret = req.body.apiSecret; req.user.liveTradingEnabled = req.body.liveTradingEnabled;
    await req.user.save(); res.json({ status: 'ok' });
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBotPille | 5m Heikin Ashi</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f0f0f0; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 10px 20px; font-weight: 500; cursor: pointer; }
        .view-section { display: none; }
        .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

    <header class="bg-white shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-2 cursor-pointer" onclick="nav('home')">
                <div class="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center relative overflow-hidden">
                    <div class="absolute inset-0 m-[5px] grid grid-cols-2 grid-rows-2 gap-[2px]">
                        <div class="bg-white"></div><div class="bg-white"></div>
                        <div class="bg-black"></div><div class="bg-[#E1AD01]"></div>
                    </div>
                    <span class="material-symbols-outlined text-[20px] font-bold text-white z-10 relative">api</span>
                </div>
                <span class="font-bold tracking-tight text-lg ml-1">TradeBotPille</span>
            </div>
            <nav id="nav-private" class="hidden items-center gap-6 text-sm font-medium">
                <button onclick="nav('dashboard')">Dashboard</button>
                <button onclick="localStorage.clear(); location.reload();" class="text-red-500">Logout</button>
            </nav>
            <nav id="nav-public" class="flex gap-4 text-sm font-medium">
                <button onclick="nav('login')">Login</button>
                <button onclick="nav('register')" class="btn-primary py-1.5 px-4">Get Started</button>
            </nav>
        </div>
    </header>

    <main class="flex-grow">
        <!-- HOME -->
        <section id="view-home" class="view-section active-view pt-24 text-center">
            <h1 class="text-6xl font-extrabold mb-6">5m Heikin Ashi Engine.</h1>
            <p class="text-lg text-gray-500 mb-10">Geometric SHIB Trend Execution via HTX.</p>
            <button onclick="nav('register')" class="btn-primary text-base px-10 py-4">Launch Terminal</button>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section max-w-7xl mx-auto px-6 py-8">
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-6">
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase mb-2">Net Growth ($)</p><p id="growthUsd" class="text-xl font-mono font-bold">$0.00</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase mb-2">Growth %</p><p id="growthPct" class="text-xl font-mono font-bold">0.00%</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase mb-2">Active ROI</p><p id="activeRoi" class="text-xl font-mono font-bold">N/A</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase mb-2">Balance</p><p id="balance" class="text-xl font-mono font-bold">$0.00</p></div>
                    </div>
                    <div class="ui-card p-6 h-[400px] relative"><canvas id="haChart"></canvas></div>
                </div>
                <div class="lg:col-span-4 h-fit"><div class="ui-card p-6">
                    <h3 class="font-bold mb-6">API Integration</h3>
                    <div class="space-y-4">
                        <div class="flex gap-2"><input type="checkbox" id="liveTrade"><label class="text-sm font-bold">Live HTX</label></div>
                        <input id="apiKey" class="input-minimal" placeholder="HTX Key" type="password">
                        <input id="apiSecret" class="input-minimal" placeholder="HTX Secret" type="password">
                        <button onclick="saveKeys()" class="btn-primary w-full">Save & Connect</button>
                    </div>
                </div></div>
            </div>
        </section>

        <!-- AUTH -->
        <section id="view-register" class="view-section max-w-md mx-auto pt-20"><div class="ui-card p-8"><h2 class="text-2xl font-bold mb-6">Register</h2><input id="reg-name" class="input-minimal mb-4" placeholder="Name"><input id="reg-email" class="input-minimal mb-4" placeholder="Email"><input id="reg-pass" class="input-minimal mb-6" type="password" placeholder="Pass"><button onclick="doReg()" class="btn-primary w-full">Join</button></div></section>
        <section id="view-login" class="view-section max-w-md mx-auto pt-20"><div class="ui-card p-8"><h2 class="text-2xl font-bold mb-6">Login</h2><input id="log-email" class="input-minimal mb-4" placeholder="Email"><input id="log-pass" class="input-minimal mb-6" type="password" placeholder="Pass"><button onclick="doLog()" class="btn-primary w-full">Enter</button></div></section>
    </main>

    <script>
        let authToken = localStorage.getItem('bot_token');
        function nav(id) { document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active-view')); document.getElementById('view-'+id).classList.add('active-view'); if(id==='dashboard') initDashboard(); }
        async function api(e, m, b) { const r = await fetch(e, { method: m, headers: { 'Content-Type': 'application/json', 'Authorization': authToken }, body: b ? JSON.stringify(b) : undefined }); return r.json(); }
        
        async function doReg() { const r = await api('/api/auth/register', 'POST', { name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value }); if(r.token) { authToken = r.token; localStorage.setItem('bot_token', r.token); nav('dashboard'); } }
        async function doLog() { const r = await api('/api/auth/login', 'POST', { email: document.getElementById('log-email').value, password: document.getElementById('log-pass').value }); if(r.token) { authToken = r.token; localStorage.setItem('bot_token', r.token); nav('dashboard'); } }
        async function saveKeys() { await api('/api/user/keys', 'POST', { apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked }); alert('Saved'); }

        const ctx = document.getElementById('haChart').getContext('2d');
        const chart = new Chart(ctx, { type: 'bar', data: { labels: [], datasets: [{ data: [], backgroundColor: [] }] }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: false } }, plugins: { legend: { display: false } } } });

        function initDashboard() {
            document.getElementById('nav-public').style.display = 'none'; document.getElementById('nav-private').classList.remove('hidden');
            setInterval(async () => {
                const d = await api('/api/data', 'GET'); if(!d || d.error) return;
                document.getElementById('growthUsd').innerText = "$" + d.totalPnlGrowth.toFixed(2);
                document.getElementById('growthUsd').className = d.totalPnlGrowth >= 0 ? "text-xl font-mono font-bold text-green-600" : "text-xl font-mono font-bold text-red-600";
                document.getElementById('growthPct').innerText = d.totalGrowthPct.toFixed(2) + "%";
                document.getElementById('balance').innerText = "$" + d.walletBalance.toFixed(2);
                
                if (d.activePositions.length > 0) {
                    document.getElementById('activeRoi').innerText = d.activePositions[0].exchangeROI.toFixed(2) + "%";
                }

                chart.data.labels = d.haCandles.map(c => new Date(c.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
                chart.data.datasets[0].data = d.haCandles.map(c => [c.open, c.close]);
                chart.data.datasets[0].backgroundColor = d.haCandles.map(c => c.color === 'bull' ? '#22c55e' : '#ef4444');
                chart.update('none');
            }, 2000);
        }
        if(authToken) nav('dashboard');
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => { console.log(`✅ Server running`); await loadAllUsers(); startMasterStreams(); });
