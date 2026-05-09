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
    binance: { mid: 0, bid: 0, ask: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = [];
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const mlSignalCache = new Map();
const tokenCache = new Map();

// ==================== SECURITY ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let user = await UserModel.findOne({ token });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
}

// ==================== ENGINE MATH ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const grossRoiPct = (grossPnlUsd / margin) * 100;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;
    return { currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getF = (idx) => [((prices[idx]-prices[idx-1])/prices[idx-1])*1000, ((prices[idx]-prices[idx-5])/prices[idx-5])*1000];
    for (let i = prices.length - 2 - lookback; i <= prices.length - 2; i++) {
        X.push(getF(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0, 0], b = 0, lr = 0.05;
    for (let e = 0; e < 15; e++) {
        for (let i = 0; i < X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    let cur = getF(prices.length - 1);
    let final = 1 - (1 / (1 + Math.exp(-(w[0]*cur[0] + w[1]*cur[1] + b))));
    return { confidence: Math.abs(final-0.5)*200, type: final>=0.5?'bull':'bear', rawValue: final };
}

// ==================== WORKER ====================
class PerformanceMetrics {
    constructor(userId) { this.userId = userId; this.trades = []; this.totalNetPnl = 0; this.winRate = 0; }
    async init() {
        const db = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(50).lean();
        this.trades = db;
        this.totalNetPnl = db.reduce((a, b) => a + b.netPnl, 0);
        let wins = db.filter(t => t.netPnl > 0).length;
        this.winRate = db.length ? ((wins / db.length) * 100).toFixed(1) : 0;
    }
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
        this.walletBalance = 1000;
        this.metrics = new PerformanceMetrics(this.userId);
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async syncState(side) {
        const contracts = Math.floor(this.walletBalance * 1000); // REQUESTED: 1000X
        const price = globalMarketData.binance.mid;
        const sizeUsd = contracts * 1000 * price;
        this.activePositions = [{ side, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, exchangeROI: 0, timestamp: Date.now() }];
        await this.saveState();
    }
    async forceClose() {
        if (!this.activePositions.length) return;
        const pos = this.activePositions[0];
        const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
        await TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, contracts: pos.contracts, netPnl: math.netPnlUsd, exitReason: "SIGNAL_EXIT" });
        this.activePositions = []; this.lastCloseTime = Date.now();
        await this.metrics.init(); await this.saveState();
    }
    async runCycle() {
        const ml = mlSignalCache.get(this.config.mlLookback);
        if (!ml) return;
        if (this.activePositions.length) {
            const pos = this.activePositions[0];
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
            pos.exchangeROI = math.currentGrossRoi;
            if (pos.exchangeROI >= this.config.takeProfitPct || pos.exchangeROI <= this.config.stopLossPct) await this.forceClose();
        } else if (ml.confidence >= this.config.mlThreshold && Date.now() - this.lastCloseTime > 10000) {
            await this.syncState(ml.type === 'bull' ? 'long' : 'short');
        }
    }
}

// ==================== CORE APP ====================
const workers = new Map();

async function init() {
    const users = await UserModel.find({});
    for (const u of users) {
        const w = new UserTradeInstance(u);
        await w.metrics.init();
        workers.set(u._id.toString(), w);
    }
    setInterval(async () => {
        try {
            const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
            globalMarketData.binance = { mid: (t.bid + t.ask) / 2, bid: t.bid, ask: t.ask };
            globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
            if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
            const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
            mlSignalCache.set(BASE_CONFIG.mlLookback, ml);
            for (const w of workers.values()) w.runCycle();
        } catch (e) {}
    }, 2500);
}

const app = express(); app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
    const u = await UserModel.findOne({ email: req.body.email });
    if (!u) return res.status(400).send();
    res.json({ token: u.token });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const w = workers.get(req.user._id.toString());
    res.json({ metrics: w.metrics, active: w.activePositions[0], ml: mlSignalCache.get(w.config.mlLookback), config: w.config, wallet: w.walletBalance });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    w.config = { ...w.config, ...req.body };
    req.user.config = w.config; await req.user.save();
    res.json({status:'ok'});
});

// ==================== ANDROID UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>TradeBot Android</title>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Google Sans', sans-serif; background: #F7F9FC; padding: 70px 0 90px; }
        .android-bar { background: #FFF; position: fixed; top: 0; width: 100%; height: 60px; display: flex; align-items: center; padding: 0 20px; border-bottom: 1px solid #EEE; z-index: 100; font-weight: 700; }
        .android-card { background: #FFF; border-radius: 28px; padding: 20px; margin: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .bottom-nav { background: #FFF; border-top: 1px solid #EEE; position: fixed; bottom: 0; width: 100%; display: flex; padding: 12px 0 25px; z-index: 100; }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; color: #5F6368; }
        .nav-item.active { color: #1A73E8; font-variation-settings: 'FILL' 1; }
        .view { display: none; } .view.active { display: block; }
        
        /* SETTINGS PREFERENCES */
        .pref-header { color: #1A73E8; font-size: 12px; font-weight: 700; padding: 20px 20px 8px; text-transform: uppercase; }
        .pref-row { background: #FFF; padding: 16px 20px; display: flex; align-items: center; border-bottom: 1px solid #F8F8F8; }
        .pref-text { flex: 1; }
        .pref-title { font-size: 15px; color: #1C1B1F; font-weight: 500; }
        .pref-sub { font-size: 12px; color: #70757A; }
        .pref-input { width: 75px; text-align: right; background: #F1F3F4; border-radius: 8px; padding: 5px; font-family: 'Roboto Mono'; font-weight: 700; color: #1A73E8; border: none; }
    </style>
</head>
<body>

    <div class="android-bar">TradeBot Terminal <span class="ml-auto material-symbols-rounded text-green-500">sensors</span></div>

    <!-- TERMINAL VIEW -->
    <section id="terminal" class="view active">
        <div class="grid grid-cols-2 gap-0">
            <div class="android-card !mr-1 p-4">
                <p class="text-[10px] font-bold text-gray-400 uppercase">Total Net PnL</p>
                <p id="totalPnl" class="text-lg font-mono font-bold">$0.00</p>
            </div>
            <div class="android-card !ml-1 p-4">
                <p class="text-[10px] font-bold text-gray-400 uppercase">Win Rate</p>
                <p id="winRate" class="text-lg font-mono font-bold">0.0%</p>
            </div>
        </div>

        <div class="android-card">
            <div class="flex items-center mb-2">
                <span class="font-bold text-sm">AI Prediction</span>
                <span id="mlPct" class="ml-auto font-mono text-blue-600 font-bold">0%</span>
            </div>
            <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden"><div id="mlBar" class="h-full bg-blue-600 w-0"></div></div>
            <p id="mlType" class="text-[10px] font-bold mt-2 text-gray-400 uppercase">Analyzing Market...</p>
        </div>

        <div class="android-card">
            <h3 class="font-bold text-xs uppercase text-gray-400 mb-4">Active Position</h3>
            <div id="activeBox" class="space-y-3">
                <p class="text-center py-4 text-gray-400 italic">No active trades</p>
            </div>
        </div>

        <div class="android-card">
            <h3 class="font-bold text-xs uppercase text-gray-400 mb-4">Recent Executions</h3>
            <div id="historyBox" class="text-xs space-y-3"></div>
        </div>
    </section>

    <!-- SETTINGS VIEW -->
    <section id="settings" class="view">
        <div class="pref-header">Geometric Strategy</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Take Profit (%)</div></div><input type="number" id="tpPct" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Stop Loss (%)</div></div><input type="number" id="slPct" class="pref-input"></div>
        
        <div class="pref-header">ML Logic</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Lookback Ticks</div><div class="pref-sub">Baseline training size</div></div><input type="number" id="mlLook" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Confidence (%)</div><div class="pref-sub">Minimum entry trigger</div></div><input type="number" id="mlThres" class="pref-input"></div>
        
        <div class="pref-header">Risk Management</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">DCA Multiplier</div><div class="pref-sub">Multiplier on loss steps</div></div><input type="number" id="dcaMult" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Max Contracts</div><div class="pref-sub">Hard position limit</div></div><input type="number" id="maxC" class="pref-input"></div>

        <div class="p-4"><button onclick="save()" class="w-full bg-black text-white rounded-2xl py-4 font-bold">Update Strategy</button></div>
    </section>

    <nav class="bottom-nav">
        <div onclick="nav('terminal')" class="nav-item active" id="nav-term"><span class="material-symbols-rounded">monitoring</span><span class="text-[10px] mt-1">Terminal</span></div>
        <div onclick="nav('settings')" class="nav-item" id="nav-set"><span class="material-symbols-rounded">settings</span><span class="text-[10px] mt-1">Settings</span></div>
    </nav>

    <script>
        let token = localStorage.getItem('token') || "dummy";
        function nav(id) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            document.getElementById(id === 'terminal' ? 'nav-term' : 'nav-set').classList.add('active');
        }

        async function sync() {
            const res = await fetch('/api/data', { headers: { 'Authorization': token } });
            const d = await res.json();
            if (d.error) return;

            document.getElementById('totalPnl').innerText = '$' + d.metrics.totalNetPnl.toFixed(2);
            document.getElementById('totalPnl').style.color = d.metrics.totalNetPnl >= 0 ? '#22C55E' : '#EF4444';
            document.getElementById('winRate').innerText = d.metrics.winRate + '%';

            if (d.ml) {
                document.getElementById('mlPct').innerText = d.ml.confidence.toFixed(1) + '%';
                document.getElementById('mlBar').style.width = d.ml.confidence + '%';
                document.getElementById('mlType').innerText = d.ml.type + ' Trend Identified';
            }

            const activeBox = document.getElementById('activeBox');
            if (d.active) {
                activeBox.innerHTML = \`<div class="flex justify-between font-bold text-blue-600"><span>\${d.active.side.toUpperCase()}</span><span>\${d.active.exchangeROI.toFixed(2)}%</span></div>
                                        <div class="flex justify-between text-gray-500"><span>Size</span><span>\${d.active.contracts.toLocaleString()} C</span></div>\`;
            } else activeBox.innerHTML = '<p class="text-center py-4 text-gray-400 italic">No active trades</p>';

            const historyBox = document.getElementById('historyBox');
            historyBox.innerHTML = d.metrics.trades.map(t => \`<div class="flex justify-between border-b pb-2">
                <span class="\${t.netPnl > 0 ? 'text-green-500' : 'text-red-500'} font-bold">\${t.side.toUpperCase()}</span>
                <span>$\${t.netPnl.toFixed(2)}</span>
            </div>\`).join('');

            if (!window.loaded) {
                document.getElementById('tpPct').value = d.config.takeProfitPct;
                document.getElementById('slPct').value = d.config.stopLossPct;
                document.getElementById('mlLook').value = d.config.mlLookback;
                document.getElementById('mlThres').value = d.config.mlThreshold;
                document.getElementById('dcaMult').value = d.config.dcaMultiplier;
                document.getElementById('maxC').value = d.config.maxContracts;
                window.loaded = true;
            }
        }

        async function save() {
            const body = {
                takeProfitPct: parseFloat(document.getElementById('tpPct').value),
                stopLossPct: parseFloat(document.getElementById('slPct').value),
                mlLookback: parseInt(document.getElementById('mlLook').value),
                mlThreshold: parseFloat(document.getElementById('mlThres').value),
                dcaMultiplier: parseFloat(document.getElementById('dcaMult').value),
                maxContracts: parseInt(document.getElementById('maxC').value)
            };
            await fetch('/api/user/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify(body) });
            alert("Strategy Updated");
        }
        setInterval(sync, 2500); sync();
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    await init();
    console.log(`✅ Android Server running on port ${CUSTOM_PORT}`);
});
