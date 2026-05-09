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

// ==================== CORE MATH & ML ENGINE ====================
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

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000,
        ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000
    ];
    const trainEnd = prices.length - 2; const trainStart = trainEnd - lookback;
    let upCount = 0, downCount = 0;
    for (let i = trainStart; i <= trainEnd; i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1] - prices[i];
        let label = 0.5; if (diff > 0) { label = 1; upCount++; } else if (diff < 0) { label = 0; downCount++; }
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
    let confidence = Math.abs(finalPred - 0.5) * 200; 
    return { confidence: Math.min(confidence, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== USER BOT INSTANCE ====================
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
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = []; this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }
    async initialize() {
        await this.metrics.init(); await this.connectExchange(); this.startExchangeROISync();
    }
    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets();
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                const openPos = positions.find(p => p.contracts > 0);
                if (!openPos) { this.activePositions = []; await this.saveState(); }
            }
            return { success: true };
        } catch (e) { this.liveTradingEnabled = false; return { success: false, message: e.message }; }
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback) || calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
        this.currentMl = mlSig;
        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;
        let signal = (mlSig.type === 'bull' && mlSig.confidence >= (this.config.mlThreshold || 60.0)) ? 'long' : 
                     (mlSig.type === 'bear' && mlSig.confidence >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
        if (this.activePositions.length === 0 && signal) await this.syncState(signal);
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        if (roi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (roi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
    }
    async syncState(targetSide) {
        this.isTrading = true;
        try {
            const contracts = Math.max(1, Math.floor(this.walletBalance * 1000));
            const price = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            const sizeUsd = contracts * 1000 * price;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, isPaper: !this.liveTradingEnabled }];
            await this.saveState();
        } finally { this.isTrading = false; }
    }
    async forceClosePosition(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
            this.metrics.recordTrade({ ...pos, exitPrice: globalMarketData.binance.mid, netPnl: math.netPnlUsd, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } finally { this.isTrading = false; }
    }
    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total.USDT || 0;
                } catch(e){}
            }
        }, 2000);
    }
    getExportData() { return { config: this.config, uptime: Math.floor((Date.now()-this.startTime)/1000), metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, walletBalance: this.walletBalance }; }
}

// ==================== WORKER MANAGER & STREAMS ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                if (mid !== globalMarketData.tickBuffer[globalMarketData.tickBuffer.length-1]) {
                    globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                }
                const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = ml; mlSignalCache.set(BASE_CONFIG.mlLookback, ml);
                const doc = { priceMid: mid, mlPlot: ml.rawValue, timestamp: Date.now() };
                memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift();
                for (const w of activeWorkers.values()) { w.checkExits(); w.evaluateAIEntry(); }
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS SERVER ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
    const worker = new UserTradeInstance(user); await worker.initialize();
    activeWorkers.set(user._id.toString(), worker);
    res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    tokenCache.set(user.token, { user, lastAccessed: Date.now() });
    res.json({ token: user.token });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Not found" });
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory));

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>TradeBot Mobile</title>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: 'Google Sans', sans-serif; background: #F7F9FC; color: #1C1B1F; padding-bottom: 80px; padding-top: 60px; }
        .android-card { background: #FFFFFF; border-radius: 24px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 16px; }
        .nav-active { color: #000000 !important; font-variation-settings: 'FILL' 1; }
        .bottom-nav { background: #FFFFFF; border-top: 1px solid #E0E0E0; position: fixed; bottom: 0; width: 100%; display: flex; justify-content: space-around; padding: 12px 0 24px; z-index: 100; }
        .top-app-bar { background: #FFFFFF; position: fixed; top: 0; width: 100%; height: 60px; display: flex; items-center: center; padding: 0 20px; border-bottom: 1px solid #F0F0F0; z-index: 100; font-weight: 700; font-size: 18px; }
        .view-section { display: none; padding: 16px; }
        .active-view { display: block; }
        .btn-fab { background: #000000; color: #FFF; border-radius: 16px; padding: 12px 24px; font-weight: 500; width: 100%; text-align: center; margin-top: 10px; }
    </style>
</head>
<body>

    <div class="top-app-bar">
        TradeBot <span class="ml-auto text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full" id="statusBadge">Engine Live</span>
    </div>

    <!-- VIEW: HOME -->
    <section id="view-home" class="view-section active-view">
        <div class="android-card text-center py-12">
            <h1 class="text-3xl font-bold mb-4">Smart SHIB Algorithm</h1>
            <p class="text-gray-500 mb-8">AI-driven market probabilities for HTX Exchange.</p>
            <button onclick="nav('login')" class="btn-fab">Sign In</button>
            <button onclick="nav('register')" class="mt-4 text-sm font-medium w-full text-center">Create Account</button>
        </div>
    </section>

    <!-- VIEW: TERMINAL -->
    <section id="view-terminal" class="view-section">
        <div class="grid grid-cols-2 gap-3 mb-4">
            <div class="android-card !mb-0 p-4">
                <p class="text-[10px] uppercase font-bold text-gray-400">Net PnL</p>
                <p id="netPnl" class="text-lg font-mono font-bold">$0.00</p>
            </div>
            <div class="android-card !mb-0 p-4">
                <p class="text-[10px] uppercase font-bold text-gray-400">Balance</p>
                <p id="balance" class="text-lg font-mono font-bold">$0.00</p>
            </div>
        </div>

        <div class="android-card">
            <div class="flex items-center mb-4">
                <span class="font-bold">ML Probability</span>
                <span id="mlVal" class="ml-auto font-mono text-blue-600">0%</span>
            </div>
            <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                <div id="mlBar" class="h-full bg-blue-600 transition-all" style="width: 0%"></div>
            </div>
            <p id="mlType" class="text-[10px] mt-2 font-bold uppercase text-gray-400">Neutral</p>
        </div>

        <div class="android-card h-48">
            <canvas id="mainChart"></canvas>
        </div>

        <div class="android-card">
            <h3 class="font-bold mb-3">Live Position</h3>
            <div id="posContainer" class="text-sm text-gray-500">No active trades.</div>
        </div>
    </section>

    <!-- VIEW: BACKTEST -->
    <section id="view-backtest" class="view-section">
        <div class="android-card">
            <h2 class="font-bold mb-4">Simulation</h2>
            <input type="number" id="btTicks" value="5000" class="w-full border rounded-xl p-3 mb-3" placeholder="Minutes">
            <button onclick="runBT()" class="btn-fab">Run Backtest</button>
        </div>
        <div id="btResult" class="android-card hidden"></div>
    </section>

    <!-- VIEW: SETTINGS -->
    <section id="view-settings" class="view-section">
        <div class="android-card">
            <h2 class="font-bold mb-4">HTX API Keys</h2>
            <input type="password" id="apiKey" class="w-full border rounded-xl p-3 mb-3" placeholder="API Key">
            <input type="password" id="apiSecret" class="w-full border rounded-xl p-3 mb-3" placeholder="API Secret">
            <button onclick="saveKeys()" class="btn-fab">Update Exchange</button>
        </div>
        <button onclick="logout()" class="w-full text-red-500 font-bold p-4">Logout</button>
    </section>

    <!-- AUTH VIEWS -->
    <section id="view-login" class="view-section">
        <div class="android-card">
            <h2 class="font-bold mb-4">Sign In</h2>
            <input type="email" id="logEmail" class="w-full border rounded-xl p-3 mb-3" placeholder="Email">
            <input type="password" id="logPass" class="w-full border rounded-xl p-3 mb-3" placeholder="Password">
            <button onclick="login()" class="btn-fab">Login</button>
        </div>
    </section>

    <section id="view-register" class="view-section">
        <div class="android-card">
            <h2 class="font-bold mb-4">Create Account</h2>
            <input type="text" id="regName" class="w-full border rounded-xl p-3 mb-3" placeholder="Name">
            <input type="email" id="regEmail" class="w-full border rounded-xl p-3 mb-3" placeholder="Email">
            <input type="password" id="regPass" class="w-full border rounded-xl p-3 mb-3" placeholder="Password">
            <button onclick="register()" class="btn-fab">Register</button>
        </div>
    </section>

    <nav class="bottom-nav">
        <div onclick="nav('home')" class="flex flex-col items-center text-gray-400">
            <span class="material-symbols-rounded">home</span>
            <span class="text-[10px] mt-1">Home</span>
        </div>
        <div onclick="nav('terminal')" class="flex flex-col items-center text-gray-400" id="nav-term">
            <span class="material-symbols-rounded">monitoring</span>
            <span class="text-[10px] mt-1">Terminal</span>
        </div>
        <div onclick="nav('backtest')" class="flex flex-col items-center text-gray-400">
            <span class="material-symbols-rounded">science</span>
            <span class="text-[10px] mt-1">Test</span>
        </div>
        <div onclick="nav('settings')" class="flex flex-col items-center text-gray-400" id="nav-settings">
            <span class="material-symbols-rounded">settings</span>
            <span class="text-[10px] mt-1">Settings</span>
        </div>
    </nav>

    <script>
        let token = localStorage.getItem('token');
        function nav(id) {
            document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active-view'));
            document.getElementById('view-'+id).classList.add('active-view');
            if (id === 'terminal') initTerminal();
        }

        async function initTerminal() {
            if (!token) return nav('login');
            fetchMetrics();
        }

        async function fetchMetrics() {
            const res = await fetch('/api/data', { headers: {'Authorization': token} });
            const data = await res.json();
            if (data.error) return logout();
            
            document.getElementById('netPnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(2);
            document.getElementById('balance').innerText = '$' + data.walletBalance.toFixed(2);
            document.getElementById('mlVal').innerText = data.mlSignal.confidence.toFixed(1) + '%';
            document.getElementById('mlBar').style.width = data.mlSignal.confidence + '%';
            document.getElementById('mlType').innerText = data.mlSignal.type;
            
            const pos = data.activePositions[0];
            document.getElementById('posContainer').innerHTML = pos ? 
                \`<div class="font-bold text-blue-600">\${pos.side.toUpperCase()} \${pos.contracts} Contracts</div><div class="text-xs">Entry: \${pos.entryPrice}</div>\` : "No active trades.";
        }

        async function login() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email: logEmail.value, password: logPass.value}) });
            const data = await res.json();
            if (data.token) { token = data.token; localStorage.setItem('token', token); nav('terminal'); }
        }

        async function register() {
            const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name: regName.value, email: regEmail.value, password: regPass.value}) });
            const data = await res.json();
            if (data.token) { token = data.token; localStorage.setItem('token', token); nav('terminal'); }
        }

        function logout() { localStorage.removeItem('token'); token = null; nav('home'); }

        const ctx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(ctx, { type: 'line', data: { labels: [], datasets: [{ label: 'Price', data: [], borderColor: '#000', borderWidth: 2, pointRadius: 0 }] }, options: { maintainAspectRatio: false, scales: { x: { display: false } } } });

        setInterval(() => { if (token && document.getElementById('view-terminal').classList.contains('active-view')) fetchMetrics(); }, 3000);
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Android Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers(); startMasterStreams();
});
