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
    leverage: FORCED_LEVERAGE, 
    baseContracts: 10,           // START CONTRACTS
    contractSize: 1000, 
    marginMode: 'cross', 
    fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    dcaRoiThresholdPct: 1.0,    // DCA TRIGGER PERCENTAGE
    dcaMultiplier: 2.0,         // DCA MULTIPLIER
    profitRoiThresholdPct: 2.0, 
    profitMultiplier: 2.0, 
    maxContracts: 5000, 
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

// ==================== MATH ENGINE ====================
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

// ==================== METRICS ENGINE ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.winRate = 0; this.totalTradesCount = 0;
        this.dailyGrowthRate = 0; this.startTime = Date.now();
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; 
        this.trades.push(trade); 
        this.totalNetPnl += trade.netPnl || 0;
        const wins = this.trades.filter(t => t.netPnl > 0).length;
        this.winRate = this.trades.length ? ((wins / this.trades.length) * 100).toFixed(2) : 0;
        const daysActive = (Date.now() - this.startTime) / (1000 * 60 * 60 * 24);
        this.dailyGrowthRate = daysActive > 0 ? (this.totalNetPnl / Math.max(1, daysActive)).toFixed(4) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.isTrading = false; 
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const key = user.apiKey || "demo", secret = user.apiSecret || "demo";
        this.htx = new ccxt.pro.htx({ 
            apiKey: key, secret: secret, agent: keepAliveAgent, 
            options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } 
        });
    }
    
    async initialize() {
        await this.metrics.init(); 
        await this.connectExchange();
        this.startExchangeSync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, config: this.config } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else { this.activePositions = []; }
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
        if (!currentPrice) currentPrice = globalMarketData.binance.mid;
        
        const sideMult = pos.side === 'long' ? 1 : -1;
        const effectiveRoi = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;

        if (effectiveRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (effectiveRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
        else {
            const trigger = -(Math.abs(this.config.dcaRoiThresholdPct));
            if (effectiveRoi <= trigger && Date.now() - (pos.lastDcaTime || 0) > 8000) await this.addDcaPosition();
        }
    }

    async manualOpen(side) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const startC = Number(this.config.baseContracts) || 10;
            let execPrice = side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (this.liveTradingEnabled) {
                const orderSide = side === 'long' ? 'buy' : 'sell';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, startC, undefined, { offset: 'open' });
            }
            const sizeUsd = startC * this.config.contractSize * execPrice;
            this.activePositions = [{ id: Date.now(), side: side, entryPrice: execPrice, contracts: startC, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), isPaper: !this.liveTradingEnabled, lastDcaTime: 0, dcaStep: 0, stepHistory: [{step: 0, type: 'OPEN', price: execPrice, time: Date.now()}] }];
            await this.saveState();
        } catch (e) { console.error("Manual Open Error:", e.message); } finally { this.isTrading = false; }
    }

    async addDcaPosition() {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const multiplier = Number(this.config.dcaMultiplier) || 2.0;
            const startC = Number(this.config.baseContracts) || 10;
            let step = Number(pos.dcaStep) || 0;
            let contractsToAdd = Math.floor(startC * Math.pow(multiplier, step));

            if (pos.contracts + contractsToAdd > this.config.maxContracts) { this.isTrading = false; return; }

            let execPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                const orderSide = pos.side === 'long' ? 'buy' : 'sell';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open' });
            }
            const addedSize = contractsToAdd * this.config.contractSize * execPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (execPrice * addedSize)) / (pos.size + addedSize);
            pos.size += addedSize; pos.contracts += contractsToAdd; pos.dcaStep = step + 1; pos.lastDcaTime = Date.now();
            pos.stepHistory.push({step: pos.dcaStep, type: 'DCA', price: execPrice, time: Date.now()});
            await this.saveState();
        } catch (e) { console.error("DCA Error:", e.message); } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            let exitPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!pos.isPaper && this.liveTradingEnabled) {
                const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, pos.contracts, undefined, { reduceOnly: true, offset: 'close' });
            }
            const math = calculateTradeMath(pos.side, pos.entryPrice, exitPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice, netPnl: math.netPnlUsd, exitReason: reason, timestamp: Date.now() });
            this.activePositions = []; await this.saveState();
        } catch (e) { console.error("Close Error:", e.message); } finally { this.isTrading = false; }
    }
    
    startExchangeSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total?.USDT || 0;
                } catch(e){}
            }
        }, 5000);
    }

    getExportData() { 
        return { config: this.config, metrics: this.metrics, activePositions: this.activePositions, walletBalance: this.walletBalance, binance: globalMarketData.binance }; 
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    await publicBinance.loadMarkets();
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                if (memoryChartHistory.length === 0 || Date.now() - memoryChartHistory[memoryChartHistory.length-1].timestamp > 2000) {
                    memoryChartHistory.push({ priceMid: mid, timestamp: Date.now() });
                    if (memoryChartHistory.length > 800) memoryChartHistory.shift();
                }
                for (const worker of activeWorkers.values()) { worker.checkExits().catch(()=>{}); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS SERVER & API ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        const worker = new UserTradeInstance(user); await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
        res.json({ token: user.token });
    } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    tokenCache.set(user.token, { user, lastAccessed: Date.now() });
    res.json({ token: user.token });
});

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    req.user.apiKey = req.body.apiKey; req.user.apiSecret = req.body.apiSecret; 
    req.user.liveTradingEnabled = req.body.liveTradingEnabled;
    await req.user.save(); worker.applyUserKeys(req.user);
    res.json({ status: 'ok' });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    const { tpPct, slPct, dcaMultiplier, dcaTrigger, baseContracts } = req.body;
    if (tpPct) worker.config.takeProfitPct = parseFloat(tpPct);
    if (slPct) worker.config.stopLossPct = parseFloat(slPct);
    if (dcaMultiplier) worker.config.dcaMultiplier = parseFloat(dcaMultiplier);
    if (dcaTrigger) worker.config.dcaRoiThresholdPct = parseFloat(dcaTrigger);
    if (baseContracts) worker.config.baseContracts = parseInt(baseContracts);
    req.user.config = worker.config; await req.user.save();
    res.json({ status: 'ok' });
});

app.get('/api/open/:side', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) await worker.manualOpen(req.params.side);
    res.json({ status: 'ok' });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : {});
});

app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) await worker.forceClosePosition("MANUAL_ABORT"); 
    res.json({status: 'ok'}); 
});

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBotPille | SHIB Controller</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #fafafa; color: #09090b; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .ui-card { background: #ffffff; border-radius: 12px; border: 1px solid #e4e4e7; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .input-minimal { width: 100%; border: 1px solid #e4e4e7; border-radius: 8px; padding: 10px; font-size: 14px; outline: none; }
        .btn-primary { background: #09090b; color: #fff; border-radius: 8px; padding: 12px; font-weight: 600; width: 100%; }
        .btn-long { background: #22c55e; color: #fff; border-radius: 8px; padding: 16px; font-weight: 800; font-size: 18px; flex: 1; }
        .btn-short { background: #ef4444; color: #fff; border-radius: 8px; padding: 16px; font-weight: 800; font-size: 18px; flex: 1; }
        .status-pill { padding: 4px 10px; border-radius: 9999px; font-size: 10px; font-weight: 800; text-transform: uppercase; }
        .view-section { display: none; } .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen">

    <header class="bg-white border-b border-zinc-200 h-16 flex items-center justify-between px-6 sticky top-0 z-50">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded bg-zinc-950 flex items-center justify-center shadow-lg"><span class="material-symbols-outlined text-white text-[18px]">bolt</span></div>
            <span class="font-extrabold tracking-tighter text-base uppercase">TRADEBOT<span class="text-indigo-600">PILLE</span></span>
        </div>
        <nav id="nav-private" class="hidden items-center gap-4 text-sm font-bold">
            <button onclick="nav('dashboard')" class="text-zinc-600 hover:text-zinc-950">Terminal</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </nav>
    </header>

    <main class="max-w-7xl mx-auto p-6">
        
        <!-- AUTH -->
        <section id="view-login" class="view-section active-view max-w-md mx-auto pt-20">
            <div class="ui-card p-10 space-y-6">
                <h2 class="text-3xl font-black italic tracking-tighter">AUTHENTICATE.</h2>
                <input type="email" id="login-email" placeholder="Email" class="input-minimal">
                <input type="password" id="login-pass" placeholder="Password" class="input-minimal">
                <button onclick="doLogin()" class="btn-primary">ENTER SYSTEM</button>
                <p class="text-[10px] text-center font-bold text-zinc-400">NO ACCOUNT? <button onclick="nav('register')" class="text-zinc-950">REGISTER</button></p>
            </div>
        </section>

        <section id="view-register" class="view-section max-w-md mx-auto pt-20">
            <div class="ui-card p-10 space-y-6">
                <h2 class="text-3xl font-black italic tracking-tighter">NEW OPERATOR.</h2>
                <input type="text" id="reg-name" placeholder="Full Name" class="input-minimal">
                <input type="email" id="reg-email" placeholder="Email" class="input-minimal">
                <input type="password" id="reg-pass" placeholder="Password" class="input-minimal">
                <button onclick="doRegister()" class="btn-primary">INITIALIZE</button>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section space-y-8">
            <div class="flex justify-between items-end">
                <div>
                    <h2 class="text-4xl font-black italic tracking-tighter">LIVE TERMINAL</h2>
                    <span id="statusBadge" class="status-pill bg-zinc-100 text-zinc-400">Scanning...</span>
                </div>
                <div class="flex gap-3">
                    <button onclick="nav('settings')" class="px-4 py-2 bg-white border rounded-md font-bold text-xs flex items-center gap-2"><span class="material-symbols-outlined text-[16px]">settings</span> SETTINGS</button>
                    <button onclick="closeAll()" class="px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-md font-bold text-xs">ABORT POSITION</button>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">DGR (DAILY GROWTH)</p><p id="dgrStat" class="text-3xl font-mono font-black text-indigo-600">$0.0000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">TOTAL NET PNL</p><p id="netPnl" class="text-3xl font-mono font-black">$0.0000</p></div>
                <div class="ui-card p-6"><p class="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">WALLET BALANCE</p><p id="walletBal" class="text-3xl font-mono font-black">$0.0000</p></div>
                <div class="ui-card p-6 bg-zinc-950 border-zinc-950"><p class="text-[10px] font-black text-zinc-500 uppercase tracking-widest mb-1">LIVE POSITION ROI</p><p id="activeRoi" class="text-3xl font-mono font-black text-white">IDLE</p></div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="ui-card p-6 h-[400px]"><canvas id="mainChart"></canvas></div>
                    <div class="flex gap-4">
                        <button onclick="openTrade('long')" class="btn-long shadow-lg shadow-green-100">OPEN LONG</button>
                        <button onclick="openTrade('short')" class="btn-short shadow-lg shadow-red-100">OPEN SHORT</button>
                    </div>
                </div>
                <aside class="lg:col-span-4 space-y-6">
                    <div class="ui-card p-8 border-t-4 border-t-indigo-600">
                        <h3 class="text-xs font-black uppercase tracking-widest mb-6 border-b pb-4">Strategy Config</h3>
                        <div class="space-y-4">
                            <div><label class="text-[10px] font-black text-zinc-400 uppercase">Start Contracts</label><input type="number" id="cfg-base" class="input-minimal font-mono"></div>
                            <div><label class="text-[10px] font-black text-zinc-400 uppercase">DCA Multiplier</label><input type="number" step="0.1" id="cfg-mult" class="input-minimal font-mono"></div>
                            <div><label class="text-[10px] font-black text-zinc-400 uppercase">DCA Trigger % (Loss)</label><input type="number" step="0.1" id="cfg-trigger" class="input-minimal font-mono"></div>
                            <div class="grid grid-cols-2 gap-2">
                                <div><label class="text-[10px] font-black text-zinc-400 uppercase">TP %</label><input type="number" id="cfg-tp" class="input-minimal font-mono"></div>
                                <div><label class="text-[10px] font-black text-zinc-400 uppercase">SL %</label><input type="number" id="cfg-sl" class="input-minimal font-mono"></div>
                            </div>
                            <button onclick="saveConfig()" class="btn-primary mt-2">SAVE STRATEGY</button>
                        </div>
                    </div>
                </aside>
            </div>
        </section>

        <!-- SETTINGS -->
        <section id="view-settings" class="view-section max-w-xl mx-auto pt-20">
            <div class="ui-card p-10 space-y-8 border-t-4 border-t-zinc-950">
                <h2 class="text-3xl font-black italic tracking-tighter">API INTEGRATION</h2>
                <div class="flex items-center gap-3 p-4 bg-zinc-50 rounded border border-dashed border-zinc-200">
                    <input type="checkbox" id="liveTrade" class="w-5 h-5 accent-zinc-950"><label class="text-xs font-black uppercase tracking-widest">Enable Live Exchange Execution</label>
                </div>
                <div><label class="text-[10px] font-black text-zinc-400 uppercase">HTX API Key</label><input type="password" id="apiKey" class="input-minimal font-mono"></div>
                <div><label class="text-[10px] font-black text-zinc-400 uppercase">HTX Secret</label><input type="password" id="apiSecret" class="input-minimal font-mono"></div>
                <button onclick="saveKeys()" class="btn-primary">ESTABLISH CONNECTION</button>
                <button onclick="nav('dashboard')" class="w-full text-[10px] font-bold text-zinc-400 uppercase">Back to Terminal</button>
            </div>
        </section>

    </main>

    <script>
        let authToken = localStorage.getItem('bt_token');
        const ctx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'SHIB', data: [], borderColor: '#09090b', borderWidth: 2, pointRadius: 0, tension: 0.1 }] }, options: { maintainAspectRatio: false, animation: false, scales: { x: { display: false } } } });

        function nav(id) { document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active-view')); document.getElementById('view-'+id).classList.add('active-view'); if(id==='dashboard') initDash(); }
        function logout() { localStorage.removeItem('bt_token'); location.reload(); }

        async function doLogin() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value }) });
            const data = await res.json(); if(data.token) { authToken = data.token; localStorage.setItem('bt_token', data.token); location.reload(); }
        }

        async function doRegister() {
            const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value }) });
            const data = await res.json(); if(data.token) { authToken = data.token; localStorage.setItem('bt_token', data.token); location.reload(); }
        }

        async function initDash() {
            const res = await fetch('/api/data', { headers: {'Authorization': authToken} });
            const data = await res.json();
            document.getElementById('cfg-base').value = data.config.baseContracts;
            document.getElementById('cfg-mult').value = data.config.dcaMultiplier;
            document.getElementById('cfg-trigger').value = data.config.dcaRoiThresholdPct;
            document.getElementById('cfg-tp').value = data.config.takeProfitPct;
            document.getElementById('cfg-sl').value = data.config.stopLossPct;
            document.getElementById('apiKey').value = data.config.apiKey || "";
            document.getElementById('apiSecret').value = data.config.apiSecret || "";
            document.getElementById('liveTrade').checked = data.liveTradingEnabled;
        }

        async function saveConfig() {
            await fetch('/api/user/config', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': authToken}, body: JSON.stringify({ baseContracts: document.getElementById('cfg-base').value, dcaMultiplier: document.getElementById('cfg-mult').value, dcaTrigger: document.getElementById('cfg-trigger').value, tpPct: document.getElementById('cfg-tp').value, slPct: document.getElementById('cfg-sl').value }) });
            alert("STRATEGY SAVED");
        }

        async function saveKeys() {
            await fetch('/api/user/keys', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': authToken}, body: JSON.stringify({ apiKey: document.getElementById('apiKey').value, apiSecret: document.getElementById('apiSecret').value, liveTradingEnabled: document.getElementById('liveTrade').checked }) });
            alert("KEYS UPDATED");
        }

        async function openTrade(side) { await fetch('/api/open/'+side, { headers: {'Authorization': authToken} }); }
        async function closeAll() { if(confirm("ABORT POSITION?")) await fetch('/api/close-all', { headers: {'Authorization': authToken} }); }

        async function updateData() {
            if(!authToken) return;
            const res = await fetch('/api/data', { headers: {'Authorization': authToken} });
            const data = await res.json(); if(!data.metrics) return;
            
            document.getElementById('netPnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById('dgrStat').innerText = '$' + data.metrics.dailyGrowthRate;
            document.getElementById('walletBal').innerText = '$' + Number(data.walletBalance).toFixed(2);
            
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('activeRoi').innerText = (p.exchangeROI || 0).toFixed(2) + '%';
                document.getElementById('activeRoi').className = 'text-3xl font-mono font-black ' + (p.exchangeROI >= 0 ? 'text-green-400' : 'text-red-400');
                document.getElementById('statusBadge').innerText = 'COMMAND ACTIVE | STEP ' + p.dcaStep;
                document.getElementById('statusBadge').className = 'status-pill bg-zinc-950 text-white';
            } else {
                document.getElementById('activeRoi').innerText = 'IDLE';
                document.getElementById('activeRoi').className = 'text-3xl font-mono font-black text-white';
                document.getElementById('statusBadge').innerText = 'SCANNING MARKET';
                document.getElementById('statusBadge').className = 'status-pill bg-zinc-100 text-zinc-400';
            }

            if(data.binance) {
                chart.data.labels.push(''); chart.data.datasets[0].data.push(data.binance.mid);
                if(chart.data.labels.length > 100) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
                chart.update();
            }
        }

        if(authToken) { document.getElementById('nav-private').classList.remove('hidden'); nav('dashboard'); setInterval(updateData, 1000); }
    </script>
</body>
</html>`)});

// ==================== APP INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u); await worker.initialize();
        activeWorkers.set(u._id.toString(), worker);
        if(u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
    }
    startMasterStreams();
});
