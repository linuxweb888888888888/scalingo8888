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
    // GROWTH TRACKING FIELDS
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
    priceMid: Number, haPlot: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

const AnalyticsModel = mongoose.model('SiteAnalytics_V3', new mongoose.Schema({
    key: { type: String, default: "global" }, views: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 }, knownIds: { type: [String], default: [] }
}));

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;
const HA_TIMEFRAME_MS = 5 * 60 * 1000; // 5 Minutes

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0, 
    flipOnlyInProfit: true, flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, profitMultiplier: 2.0, 
    maxContracts: 100, 
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    haSignal: { direction: 'flat', open: 0, close: 0 } 
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// ==================== HEIKIN ASHI ENGINE ====================
function calculateHeikinAshi(ticks) {
    if (ticks.length < 10) return { direction: 'flat', open: 0, close: 0 };
    
    // Bucket ticks into 5m windows
    const buckets = {};
    ticks.forEach(t => {
        const time = t.timestamp || Date.now();
        const slot = Math.floor(time / HA_TIMEFRAME_MS) * HA_TIMEFRAME_MS;
        if (!buckets[slot]) buckets[slot] = [];
        buckets[slot].push(t.priceMid);
    });

    const sortedSlots = Object.keys(buckets).sort().map(Number);
    const candles = sortedSlots.map(s => {
        const p = buckets[s];
        return { open: p[0], high: Math.max(...p), low: Math.min(...p), close: p[p.length - 1] };
    });

    const ha = [];
    candles.forEach((c, i) => {
        const haClose = (c.open + c.high + c.low + c.close) / 4;
        let haOpen;
        if (i === 0) haOpen = (c.open + c.close) / 2;
        else haOpen = (ha[i - 1].open + ha[i - 1].close) / 2;
        ha.push({ open: haOpen, close: haClose });
    });

    const current = ha[ha.length - 1];
    return { direction: current.close > current.open ? 'bull' : 'bear', open: current.open, close: current.close };
}

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

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd: grossPnlUsd - feeCost, feeCost, margin };
}

// ==================== METRICS ENGINE ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.winRate = 0; this.totalTradesCount = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(100).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; if (!trade.timestamp) trade.timestamp = Date.now();
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        this.totalNetPnl += trade.netPnl || 0;
        const wins = this.trades.filter(t => t.netPnl > 0).length;
        this.winRate = this.trades.length ? ((wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.walletBalance = 0;

        // GROWTH INITIALIZATION
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
        await UserModel.updateOne(
            { _id: this.userId },
            { $set: { 
                activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, 
                lastCloseTime: this.lastCloseTime, config: this.config,
                initialBalance: this.initialBalance,
                totalPnlGrowth: this.totalPnlGrowth,
                totalGrowthPct: this.totalGrowthPct
            } }
        );
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
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else { this.activePositions = []; }
                await this.saveState();
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }

    async evaluateTrendEntry() {
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        const trend = globalMarketData.haSignal.direction;
        if (trend === 'flat') return;

        const signal = trend === 'bull' ? 'long' : 'short';

        try {
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                if (pos.side !== signal) {
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const math = calculateTradeMath(pos.side, pos.entryPrice, currentPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                    
                    if (this.config.flipOnlyInProfit !== false) {
                        if (math.currentGrossRoi >= (this.config.flipThresholdPct || 0.0)) {
                            await this.forceClosePosition("HA_FLIP"); setTimeout(() => this.syncState(signal), 1000);
                        }
                    } else {
                        await this.forceClosePosition("HA_FLIP"); setTimeout(() => this.syncState(signal), 1000);
                    }
                }
            } else {
                await this.syncState(signal);
            }
        } catch (e) {}
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
        if (!currentPrice) currentPrice = globalMarketData.binance.mid;
        
        const math = calculateTradeMath(pos.side, pos.entryPrice, currentPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
        const effectiveRoi = (this.liveTradingEnabled && !pos.isPaper) ? (pos.exchangeROI || 0) : math.currentGrossRoi;

        if (effectiveRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (effectiveRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; 
            const contracts = parseInt(Math.max(1, Math.floor(Number(this.walletBalance) * 1000)), 10);
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!executionPrice) executionPrice = globalMarketData.binance.mid;

            if (!isPaper) {
                const res = await this.htx.createMarketOrder(this.config.htxSymbol, targetSide === 'long' ? 'buy' : 'sell', contracts, undefined, { offset: 'open', lever_rate: FORCED_LEVERAGE });
            }

            const sizeUsd = contracts * 1000 * executionPrice;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } catch (err) { this.activePositions = []; } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            let realExitPrice = snapPos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;

            if (!snapPos.isPaper && this.liveTradingEnabled) {
                await this.htx.createMarketOrder(this.config.htxSymbol, snapPos.side === 'long' ? 'sell' : 'buy', snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', lever_rate: FORCED_LEVERAGE });
            }
            
            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, netPnl: math.netPnlUsd, grossRoiPct: math.currentGrossRoi, exitReason: reason });
            
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
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
                        await this.saveState();
                    }

                    if (this.activePositions.length > 0 && !this.isTrading) {
                        const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                        const openPos = positions.find(p => p.contracts > 0);
                        if (openPos) this.activePositions[0].exchangeROI = openPos.percentage || 0;
                        else { this.activePositions = []; await this.saveState(); }
                    }
                } catch(e) {}
            }
        }, 1000);
    }

    getExportData() { 
        return { 
            config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, activePositions: this.activePositions, haSignal: globalMarketData.haSignal, binance: globalMarketData.binance,
            walletBalance: this.walletBalance, initialBalance: this.initialBalance, totalPnlGrowth: this.totalPnlGrowth, totalGrowthPct: this.totalGrowthPct
        }; 
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    await publicBinance.loadMarkets();
    const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(1000).lean();
    globalMarketData.tickBuffer = history.reverse();

    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push({ priceMid: mid, timestamp: Date.now() });
                if (globalMarketData.tickBuffer.length > 5000) globalMarketData.tickBuffer.shift();

                globalMarketData.haSignal = calculateHeikinAshi(globalMarketData.tickBuffer);
                ChartDataModel.create({ priceMid: mid, haPlot: globalMarketData.haSignal.close }).catch(()=>{});

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateTrendEntry().catch(()=>{}); 
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) {
        const w = new UserTradeInstance(u); await w.initialize();
        activeWorkers.set(u._id.toString(), w);
    }
}

// ==================== EXPRESS SERVER ====================
const app = express(); app.use(express.json());

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    if(w) { 
        await TradeModel.deleteMany({ userId: req.user._id.toString() }); 
        w.metrics = new PerformanceMetrics(w.userId); 
        w.initialBalance = w.walletBalance; w.totalPnlGrowth = 0; w.totalGrowthPct = 0;
        await w.saveState();
    }
    res.json({status: 'ok'});
});

app.get('/api/data', authMiddleware, (req, res) => {
    const w = activeWorkers.get(req.user._id.toString());
    res.json(w ? w.getExportData() : { error: "Worker not found" });
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBotPille | 5M Heikin Ashi</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .ui-card { background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 24px -4px rgba(0,0,0,0.04); border: 1px solid #f0f0f0; }
        .btn-primary { background: #000000; color: #ffffff; border-radius: 8px; padding: 10px 20px; font-weight: 500; cursor: pointer; }
        .view-section { display: none; }
        .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">

    <header class="bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
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
        </div>
    </header>

    <main class="flex-grow">
        <section id="view-dashboard" class="view-section active-view max-w-[1400px] w-full mx-auto px-6 py-8">
            <div class="grid grid-cols-1 lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-8">
                    <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-6">
                        <div class="ui-card p-5 relative">
                            <button onclick="resetMetrics()" class="absolute top-4 right-4 text-gray-300"><span class="material-symbols-outlined text-[16px]">refresh</span></button>
                            <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Net PnL</p>
                            <p id="netPnl" class="text-lg font-mono font-bold">$0.0000</p>
                        </div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">PnL Growth ($)</p><p id="growthUsd" class="text-lg font-mono font-bold">$0.0000</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Growth %</p><p id="growthPct" class="text-lg font-mono font-bold">0.00%</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Wallet</p><p id="walletBal" class="text-lg font-mono font-bold">$0.0000</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Active ROI</p><p id="activeRoi" class="text-lg font-mono font-bold">N/A</p></div>
                        <div class="ui-card p-5"><p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">HA Trend</p><p id="haStatus" class="text-lg font-bold">FLAT</p></div>
                    </div>
                    <div class="ui-card p-6 h-[400px]"><canvas id="haChart"></canvas></div>
                </div>
            </div>
        </section>
    </main>

    <script>
        let authToken = localStorage.getItem('bot_token');
        const ctx = document.getElementById("haChart").getContext("2d");
        const haChart = new Chart(ctx, {
            type: "line", 
            data: { labels: [], datasets: [{ label: "HA Trend", data: [], borderColor: "#000", borderWidth: 2, pointRadius: 0, segment: { borderColor: c => c.p1.parsed.y > c.p0.parsed.y ? '#22c55e' : '#ef4444' } }] },
            options: { responsive: true, maintainAspectRatio: false, animation: false, scales: { x: { display: false } } }
        });

        async function fetchMetrics() {
            const res = await fetch('/api/data', { headers: { 'Authorization': authToken } });
            const data = await res.json();
            if(data.error) return;

            document.getElementById("netPnl").innerText = "$" + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById("walletBal").innerText = "$" + data.walletBalance.toFixed(4);
            document.getElementById("growthUsd").innerText = (data.totalPnlGrowth >= 0 ? "+" : "") + "$" + data.totalPnlGrowth.toFixed(4);
            document.getElementById("growthPct").innerText = (data.totalGrowthPct >= 0 ? "+" : "") + data.totalGrowthPct.toFixed(2) + "%";
            document.getElementById("haStatus").innerText = data.haSignal.direction.toUpperCase();
            document.getElementById("haStatus").className = "text-lg font-bold " + (data.haSignal.direction === 'bull' ? 'text-green-500' : 'text-red-500');

            if(data.activePositions.length > 0) {
                document.getElementById("activeRoi").innerText = data.activePositions[0].exchangeROI.toFixed(2) + "%";
            }

            haChart.data.labels.push(""); haChart.data.datasets[0].data.push(data.haSignal.close);
            if(haChart.data.labels.length > 100) { haChart.data.labels.shift(); haChart.data.datasets[0].data.shift(); }
            haChart.update();
        }
        setInterval(fetchMetrics, 2000);
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => { await loadAllUsers(); startMasterStreams(); });
