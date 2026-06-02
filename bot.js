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
    baseContracts: 1, 
    contractSize: 1000, 
    marginMode: 'cross', 
    fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    manualTrend: 'long', // REPLACED AI: User chooses trend
    dcaRoiThresholdPct: 1.0, 
    dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, 
    profitMultiplier: 2.0, 
    maxContracts: 100
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
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

// ==================== METRICS ENGINE ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.wins = 0; this.losses = 0; this.winRate = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
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
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? openPos.entryPrice * 1000 : openPos.entryPrice;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else this.activePositions = [];
                await this.saveState();
            }
            return { success: true };
        } catch (e) { this.liveTradingEnabled = false; return { success: false, message: e.message }; }
    }

    async evaluateManualEntry() {
        if (this.isTrading || this.activePositions.length > 0 || (Date.now() - this.lastCloseTime < 3000)) return;
        const trend = this.config.manualTrend || 'long';
        await this.syncState(trend);
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        try {
            const pos = this.activePositions[0];
            let effectiveRoi = pos.exchangeROI || 0;
            
            if (effectiveRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
            else if (effectiveRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
            else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0));
                const profitScaleThreshold = this.config.profitRoiThresholdPct || 2.0;
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(false);
                else if (effectiveRoi >= profitScaleThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.addDcaPosition(true);
            }
        } catch (e) {}
    }

    async addDcaPosition(isProfitScale = false) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const multiplier = isProfitScale ? (this.config.profitMultiplier || 2.0) : (this.config.dcaMultiplier || 2.0);
            const baseC = Number(this.config.baseContracts) || 1;
            const contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, pos.dcaStep))), 10);

            if (isProfitScale && (Number(pos.contracts) + contractsToAdd > (this.config.maxContracts || 100))) {
                pos.lastDcaTime = Date.now(); this.isTrading = false; return;
            }

            let execPrice = globalMarketData.binance.mid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                const side = pos.side === 'long' ? 'buy' : 'sell';
                const res = await this.htx.createMarketOrder(this.config.htxSymbol, side, contractsToAdd, undefined, { offset: 'open' });
                await new Promise(r => setTimeout(r, 200));
                const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol);
                if (order.average) execPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
            }

            const addedSizeUsd = contractsToAdd * this.config.contractSize * execPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (execPrice * addedSizeUsd)) / (pos.size + addedSizeUsd);
            pos.size += addedSizeUsd; pos.contracts += contractsToAdd; pos.marginUsed += (addedSizeUsd / FORCED_LEVERAGE);
            pos.dcaStep += 1; pos.lastDcaTime = Date.now();
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: isProfitScale ? 'SCALE' : 'DCA', price: execPrice, roi: pos.exchangeROI, time: Date.now() });
            await this.saveState();
        } catch (e) { console.error("DCA Error:", e.message); } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled;
            const contracts = parseInt(this.config.baseContracts || 1, 10);
            let execPrice = globalMarketData.binance.mid;
            if (!isPaper) {
                const side = targetSide === 'long' ? 'buy' : 'sell';
                const res = await this.htx.createMarketOrder(this.config.htxSymbol, side, contracts, undefined, { offset: 'open' });
                await new Promise(r => setTimeout(r, 200));
                const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol);
                if (order.average) execPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
            }
            const sizeUsd = contracts * this.config.contractSize * execPrice;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: execPrice, contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: execPrice, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } catch (e) { console.error("Open Error:", e.message); } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snap = { ...this.activePositions[0] };
            let exitPrice = globalMarketData.binance.mid;
            if (!snap.isPaper && this.liveTradingEnabled) {
                const side = snap.side === 'long' ? 'sell' : 'buy';
                const res = await this.htx.createMarketOrder(this.config.htxSymbol, side, snap.contracts, undefined, { reduceOnly: true, offset: 'close' });
                await new Promise(r => setTimeout(r, 200));
                const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol);
                if (order.average) exitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
            }
            const math = calculateTradeMath(snap.side, snap.entryPrice, exitPrice, snap.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snap.side, contracts: snap.contracts, entryPrice: snap.entryPrice, exitPrice, marginUsed: math.margin, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } catch (e) { console.error("Close Error:", e.message); } finally { this.isTrading = false; }
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
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = bal.total?.USDT || 0;
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const open = positions.find(p => p.contracts > 0);
                    if (open) { pos.exchangeROI = open.percentage || 0; pos.exchangePnl = open.unrealizedPnl || 0; }
                    else { this.activePositions = []; await this.saveState(); }
                } catch(e) {}
            } else {
                const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                pos.exchangeROI = math.currentGrossRoi; pos.exchangePnl = math.netPnlUsd;
            }
        }, 1000);
    }

    getExportData() { 
        const days = Math.max(1, (Date.now() - this.startTime) / 86400000);
        const dgr = (this.metrics.totalNetPnl / (this.metrics.maxMarginUsed || 1)) / days * 100;
        return { config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000), metrics: this.metrics, activePositions: this.activePositions, walletBalance: this.walletBalance, dgr: dgr.toFixed(2) }; 
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
                globalMarketData.binance = { mid: (ticker.bid + ticker.ask) / 2, timestamp: Date.now() };
                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateManualEntry().catch(()=>{}); 
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u); await worker.initialize();
        activeWorkers.set(u._id.toString(), worker);
        if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
    }
}

// ==================== EXPRESS SERVER & API ====================
const app = express(); app.use(express.json());

app.post('/api/analytics/track', async (req, res) => { res.json({ status: 'ok' }); });
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        const worker = new UserTradeInstance(user); await worker.initialize();
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

app.get('/api/user/me', authMiddleware, (req, res) => res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled }));

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const { apiKey, apiSecret, liveTradingEnabled } = req.body;
    let worker = activeWorkers.get(req.user._id.toString());
    if(worker) {
        worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled });
        await worker.connectExchange();
    }
    req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; req.user.liveTradingEnabled = liveTradingEnabled;
    await req.user.save(); res.json({ status: 'ok' });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(!worker) return res.status(400).json({ error: 'Worker not active' });
    Object.assign(worker.config, req.body);
    req.user.config = worker.config; req.user.markModified('config'); await req.user.save();
    res.json({status: 'ok'});
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Worker not found" });
});

app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) await worker.forceClosePosition("MANUAL_FORCE_CLOSE");
    res.json({status: 'ok'}); 
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBot Manual Trend</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=JetBrains+Mono&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #09090b; color: #fafafa; }
        .ui-card { background: #121214; border: 1px solid #27272a; border-radius: 12px; }
        .input-minimal { background: #18181b; border: 1px solid #27272a; border-radius: 6px; padding: 8px; color: #fff; width: 100%; outline: none; }
        .input-minimal:focus { border-color: #4f46e5; }
        .btn-primary { background: #4f46e5; color: #fff; font-weight: 700; padding: 10px; border-radius: 6px; transition: 0.2s; }
        .btn-primary:hover { background: #4338ca; }
        .view-section { display: none; } .active-view { display: block; }
    </style>
</head>
<body class="p-4 md:p-8">
    <header class="flex justify-between items-center mb-8">
        <h1 class="text-xl font-black italic tracking-tighter">TRADEBOT<span class="text-indigo-500">PRO</span></h1>
        <div id="nav-private" class="hidden gap-4 text-xs font-bold uppercase tracking-widest">
            <button onclick="nav('dashboard')">Terminal</button>
            <button onclick="nav('settings')">API</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </div>
    </header>

    <main class="max-w-6xl mx-auto">
        <!-- AUTH -->
        <section id="view-login" class="view-section active-view max-w-sm mx-auto py-20">
            <div class="ui-card p-8">
                <h2 class="text-2xl font-black mb-6">Login</h2>
                <input type="email" id="l-email" placeholder="Email" class="input-minimal mb-4">
                <input type="password" id="l-pass" placeholder="Password" class="input-minimal mb-6">
                <button onclick="doLogin()" class="btn-primary w-full">Access Terminal</button>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-zinc-500 uppercase">Net PnL</p>
                    <p id="netPnl" class="text-3xl font-black font-mono">$0.00</p>
                </div>
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-zinc-500 uppercase">Live ROI</p>
                    <p id="activeRoi" class="text-3xl font-black font-mono">0.00%</p>
                </div>
                <div class="ui-card p-6">
                    <p class="text-[10px] font-bold text-zinc-500 uppercase">Daily Growth (DGR)</p>
                    <p id="dgr" class="text-3xl font-black font-mono text-indigo-400">0.00%</p>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div class="lg:col-span-8 ui-card p-6">
                    <h3 class="font-black uppercase text-xs text-zinc-500 mb-4">Market Execution Tape</h3>
                    <div class="overflow-x-auto"><table class="w-full text-left text-xs"><tbody id="history" class="divide-y divide-zinc-800"></tbody></table></div>
                </div>
                
                <aside class="lg:col-span-4 space-y-6">
                    <div class="ui-card p-6">
                        <h3 class="font-black uppercase text-xs text-zinc-500 mb-6">Execution Config</h3>
                        <div class="space-y-4">
                            <div><label class="text-[10px] font-bold uppercase block mb-1">Manual Trend</label>
                            <select id="manualTrend" class="input-minimal"><option value="long">LONG Trend</option><option value="short">SHORT Trend</option></select></div>
                            <div><label class="text-[10px] font-bold uppercase block mb-1">Start Contracts</label><input type="number" id="baseContracts" class="input-minimal"></div>
                            <div><label class="text-[10px] font-bold uppercase block mb-1">DCA Multiplier</label><input type="number" id="dcaMultiplier" class="input-minimal"></div>
                            <div><label class="text-[10px] font-bold uppercase block mb-1">DCA Trigger (ROI % Drop)</label><input type="number" id="dcaTrigger" class="input-minimal"></div>
                            <button onclick="saveConfig()" class="btn-primary w-full mt-4">Apply Settings</button>
                        </div>
                    </div>
                    <button onclick="closeAll()" class="btn-primary w-full bg-red-600 hover:bg-red-700">EMERGENCY CLOSE ALL</button>
                </aside>
            </div>
        </section>

        <!-- SETTINGS -->
        <section id="view-settings" class="view-section max-w-md mx-auto py-10">
            <div class="ui-card p-8">
                <h2 class="text-2xl font-black mb-6">API Setup</h2>
                <div class="flex items-center gap-2 mb-6"><input type="checkbox" id="liveTrade"> <label class="text-xs font-bold uppercase">Enable Live Trading</label></div>
                <input type="password" id="apiKey" placeholder="HTX Key" class="input-minimal mb-4">
                <input type="password" id="apiSecret" placeholder="HTX Secret" class="input-minimal mb-6">
                <button onclick="saveApi()" class="btn-primary w-full">Save Connection</button>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('token');
        function nav(v) { document.querySelectorAll('.view-section').forEach(e=>e.classList.remove('active-view')); document.getElementById('view-'+v).classList.add('active-view'); if(v==='dashboard') startLoop(); }
        async function doAPI(u,m,b) { const r=await fetch(u,{method:m,headers:{'Authorization':token,'Content-Type':'application/json'},body:b?JSON.stringify(b):null}); return r.json(); }
        async function doLogin() { const r=await doAPI('/api/auth/login','POST',{email:document.getElementById('l-email').value,password:document.getElementById('l-pass').value}); if(r.token){token=r.token;localStorage.setItem('token',token);nav('dashboard');} }
        function logout() { localStorage.removeItem('token'); location.reload(); }
        async function saveConfig() { await doAPI('/api/user/config','POST',{manualTrend:document.getElementById('manualTrend').value,baseContracts:document.getElementById('baseContracts').value,dcaMultiplier:document.getElementById('dcaMultiplier').value,dcaRoiThresholdPct:document.getElementById('dcaTrigger').value}); alert("Config Saved"); }
        async function saveApi() { await doAPI('/api/user/keys','POST',{apiKey:document.getElementById('apiKey').value,apiSecret:document.getElementById('apiSecret').value,liveTradingEnabled:document.getElementById('liveTrade').checked}); nav('dashboard'); }
        async function closeAll() { if(confirm("Close all positions?")) await doAPI('/api/close-all','GET'); }

        let loop=null;
        function startLoop() { if(loop) clearInterval(loop); loop=setInterval(async()=>{
            const d=await doAPI('/api/data','GET'); if(d.error) return;
            document.getElementById('nav-private').classList.add('flex');
            document.getElementById('netPnl').innerText = '$'+d.metrics.totalNetPnl.toFixed(4);
            document.getElementById('dgr').innerText = d.dgr + '%';
            if(d.activePositions.length){
                const p=d.activePositions[0];
                document.getElementById('activeRoi').innerText = p.exchangeROI.toFixed(2)+'%';
                document.getElementById('activeRoi').style.color = p.exchangeROI>=0?'#22c55e':'#ef4444';
            } else { document.getElementById('activeRoi').innerText = 'IDLE'; document.getElementById('activeRoi').style.color = '#52525b'; }
            
            document.getElementById('history').innerHTML = d.metrics.trades.slice(-10).reverse().map(t=>'<tr><td class="p-3 uppercase font-bold">'+t.side+'</td><td class="p-3">'+t.contracts+'</td><td class="p-3 text-right font-mono">$'+t.netPnl.toFixed(4)+'</td></tr>').join('');
        },1000); }
        if(token) nav('dashboard');
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => { console.log(`✅ Server: ${CUSTOM_PORT}`); await loadAllUsers(); startMasterStreams(); });
