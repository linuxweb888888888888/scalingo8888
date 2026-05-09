--- START OF FILE text/plain ---

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
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = []; 
const mlSignalCache = new Map();
const tokenCache = new Map();

// ==================== CORE ML ENGINE (RESTORED) ====================
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
    return { confidence: Math.abs(finalPred - 0.5) * 200, type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== PERFORMANCE METRICS ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.winRate = 0; this.wins = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(100).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    processTrade(trade, saveToDb = true) {
        this.trades.push(trade); if (this.trades.length > 100) this.trades.shift(); 
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; 
        if (trade.netPnl > 0) this.wins++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(1) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat' };
        this.mlRawBuffer = []; this.walletBalance = 1000;
        this.metrics = new PerformanceMetrics(this.userId);
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async syncState(side) {
        if (this.isTrading) return; this.isTrading = true;
        try {
            const contracts = Math.floor(this.walletBalance * 1000);
            const price = globalMarketData.binance.mid;
            const sizeUsd = contracts * 1000 * price;
            this.activePositions = [{ side, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, exchangeROI: 0, dcaStep: 0, timestamp: Date.now(), stepHistory: [{step:0, type:'OPEN', price, time:Date.now()}] }];
            await this.saveState();
        } finally { this.isTrading = false; }
    }
    async forceClose(reason) {
        if (!this.activePositions.length || this.isTrading) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const pnl = pos.side === 'long' ? (globalMarketData.binance.mid - pos.entryPrice) : (pos.entryPrice - globalMarketData.binance.mid);
            const netPnl = (pnl / pos.entryPrice) * pos.size;
            this.metrics.processTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, netPnl, marginUsed: pos.marginUsed, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } finally { this.isTrading = false; }
    }
    async addDca(isProfit) {
        if (!this.activePositions.length || this.isTrading) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const mult = isProfit ? 1.5 : this.config.dcaMultiplier;
            const contractsToAdd = Math.floor(pos.contracts * (mult - 1));
            const price = globalMarketData.binance.mid;
            const newSize = (pos.contracts + contractsToAdd) * 1000 * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * (contractsToAdd * 1000 * price))) / (pos.size + (contractsToAdd * 1000 * price));
            pos.contracts += contractsToAdd; pos.size = newSize; pos.dcaStep++;
            pos.stepHistory.push({ step: pos.dcaStep, type: isProfit ? 'SCALE' : 'DCA', price, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }
    async runCycle() {
        const ml = mlSignalCache.get(this.config.mlLookback);
        if (!ml) return;
        this.currentMl = ml;
        if (this.activePositions.length) {
            const pos = this.activePositions[0];
            const roi = (pos.side === 'long' ? (globalMarketData.binance.mid - pos.entryPrice) : (pos.entryPrice - globalMarketData.binance.mid)) / pos.entryPrice * 100 * FORCED_LEVERAGE;
            pos.exchangeROI = roi;
            if (roi >= this.config.takeProfitPct) await this.forceClose("TAKE_PROFIT");
            else if (roi <= this.config.stopLossPct) await this.forceClose("STOP_LOSS");
            else if (roi <= -this.config.dcaRoiThresholdPct) await this.addDca(false);
            else if (roi >= this.config.profitRoiThresholdPct) await this.addDca(true);
        } else if (ml.confidence >= this.config.mlThreshold && Date.now() - this.lastCloseTime > 10000) {
            await this.syncState(ml.type === 'bull' ? 'long' : 'short');
        }
    }
}

// ==================== WORKER MANAGER ====================
const workers = new Map();
async function loadAllUsers() {
    const users = await UserModel.find({});
    for (const u of users) {
        const w = new UserTradeInstance(u);
        await w.metrics.init(); workers.set(u._id.toString(), w);
    }
}
async function startMasterStreams() {
    setInterval(async () => {
        try {
            const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
            const mid = (ticker.bid + ticker.ask) / 2;
            globalMarketData.binance = { mid, bid: ticker.bid, ask: ticker.ask };
            globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
            const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
            mlSignalCache.set(BASE_CONFIG.mlLookback, ml);
            for (const w of workers.values()) w.runCycle();
        } catch (e) {}
    }, 2500);
}

// ==================== API & SERVER ====================
const app = express(); app.use(express.json());
const auth = async (req, res, next) => {
    const u = await UserModel.findOne({ token: req.headers['authorization'] });
    if (!u) return res.status(401).send(); req.user = u; next();
};
app.post('/api/auth/login', async (req, res) => {
    const u = await UserModel.findOne({ email: req.body.email });
    if (u) res.json({ token: u.token }); else res.status(400).send();
});
app.get('/api/data', auth, (req, res) => {
    const w = workers.get(req.user._id.toString());
    res.json({ metrics: w.metrics, active: w.activePositions[0], ml: w.currentMl, config: w.config, wallet: w.walletBalance });
});
app.post('/api/user/config', auth, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    w.config = { ...w.config, ...req.body };
    req.user.config = w.config; await req.user.save();
    res.json({status:'ok'});
});

// ==================== ANDROID UI (FULL SETTINGS) ====================
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
        .pref-header { color: #1A73E8; font-size: 12px; font-weight: 700; padding: 20px 20px 8px; text-transform: uppercase; }
        .pref-row { background: #FFF; padding: 16px 20px; display: flex; align-items: center; border-bottom: 1px solid #F8F8F8; }
        .pref-text { flex: 1; }
        .pref-title { font-size: 15px; color: #1C1B1F; font-weight: 500; }
        .pref-sub { font-size: 12px; color: #70757A; }
        .pref-input { width: 80px; text-align: right; background: #F1F3F4; border-radius: 8px; padding: 5px; font-family: 'Roboto Mono'; font-weight: 700; color: #1A73E8; border: none; }
    </style>
</head>
<body>
    <div class="android-bar">TradeBot Terminal <span class="ml-auto material-symbols-rounded text-blue-500">memory</span></div>

    <section id="terminal" class="view active">
        <div class="grid grid-cols-2 gap-0">
            <div class="android-card !mr-1 p-4">
                <p class="text-[10px] font-bold text-gray-400 uppercase">Net PnL</p>
                <p id="totalPnl" class="text-lg font-mono font-bold">$0.00</p>
            </div>
            <div class="android-card !ml-1 p-4">
                <p class="text-[10px] font-bold text-gray-400 uppercase">Win Rate</p>
                <p id="winRate" class="text-lg font-mono font-bold">0%</p>
            </div>
        </div>
        <div class="android-card">
            <div class="flex items-center mb-2"><span class="font-bold text-sm">AI Confidence</span><span id="mlPct" class="ml-auto font-mono text-blue-600 font-bold">0%</span></div>
            <div class="h-2 w-full bg-gray-100 rounded-full overflow-hidden"><div id="mlBar" class="h-full bg-blue-600 w-0"></div></div>
            <p id="mlType" class="text-[10px] font-bold mt-2 text-gray-400 uppercase">Neural Engine Offline</p>
        </div>
        <div class="android-card"><h3 class="font-bold text-xs uppercase text-gray-400 mb-4">Active Position</h3><div id="activeBox" class="space-y-3"></div></div>
        <div class="android-card"><h3 class="font-bold text-xs uppercase text-gray-400 mb-4">Execution History</h3><div id="historyBox" class="text-xs space-y-3"></div></div>
    </section>

    <section id="settings" class="view">
        <div class="pref-header">ML Logic Config</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Lookback Ticks</div><div class="pref-sub">Training dataset size</div></div><input type="number" id="mlLook" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Entry Threshold (%)</div><div class="pref-sub">Min confidence to open</div></div><input type="number" id="mlThres" class="pref-input"></div>
        
        <div class="pref-header">Profit & Risk</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Take Profit (%)</div></div><input type="number" id="tpPct" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Stop Loss (%)</div></div><input type="number" id="slPct" class="pref-input"></div>
        
        <div class="pref-header">Geometric Scaling</div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">DCA ROI Drop (%)</div></div><input type="number" id="dcaRoi" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">DCA Multiplier</div></div><input type="number" id="dcaMult" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Profit Scale ROI (%)</div></div><input type="number" id="pScaleRoi" class="pref-input"></div>
        <div class="pref-row"><div class="pref-text"><div class="pref-title">Max Contracts</div></div><input type="number" id="maxC" class="pref-input"></div>

        <div class="p-4"><button onclick="save()" class="w-full bg-black text-white rounded-2xl py-4 font-bold shadow-lg">Apply Configuration</button></div>
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
            document.getElementById(id==='terminal'?'nav-term':'nav-set').classList.add('active');
        }
        async function sync() {
            const res = await fetch('/api/data', { headers: { 'Authorization': token } });
            const d = await res.json();
            document.getElementById('totalPnl').innerText = '$' + d.metrics.totalNetPnl.toFixed(2);
            document.getElementById('winRate').innerText = d.metrics.winRate + '%';
            if (d.ml) {
                document.getElementById('mlPct').innerText = d.ml.confidence.toFixed(1) + '%';
                document.getElementById('mlBar').style.width = d.ml.confidence + '%';
                document.getElementById('mlType').innerText = d.ml.type + ' Probability';
            }
            const activeBox = document.getElementById('activeBox');
            if (d.active) {
                activeBox.innerHTML = \`<div class="flex justify-between font-bold text-blue-600"><span>\${d.active.side.toUpperCase()}</span><span>\${d.active.exchangeROI.toFixed(2)}%</span></div>
                    <div class="text-[12px] text-gray-500">Size: \${d.active.contracts.toLocaleString()} C | Step: \${d.active.dcaStep}</div>\`;
            } else activeBox.innerHTML = '<p class="text-center py-4 text-gray-400 italic">No Active Trade</p>';
            
            document.getElementById('historyBox').innerHTML = d.metrics.trades.map(t => \`<div class="flex justify-between border-b pb-2">
                <span class="\${t.netPnl>0?'text-green-500':'text-red-500'} font-bold">\${t.side.toUpperCase()}</span>
                <span>$\${t.netPnl.toFixed(2)}</span>
            </div>\`).join('');

            if (!window.loaded) {
                document.getElementById('mlLook').value = d.config.mlLookback;
                document.getElementById('mlThres').value = d.config.mlThreshold;
                document.getElementById('tpPct').value = d.config.takeProfitPct;
                document.getElementById('slPct').value = d.config.stopLossPct;
                document.getElementById('dcaRoi').value = d.config.dcaRoiThresholdPct;
                document.getElementById('dcaMult').value = d.config.dcaMultiplier;
                document.getElementById('pScaleRoi').value = d.config.profitRoiThresholdPct;
                document.getElementById('maxC').value = d.config.maxContracts;
                window.loaded = true;
            }
        }
        async function save() {
            const body = {
                mlLookback: parseInt(document.getElementById('mlLook').value),
                mlThreshold: parseFloat(document.getElementById('mlThres').value),
                takeProfitPct: parseFloat(document.getElementById('tpPct').value),
                stopLossPct: parseFloat(document.getElementById('slPct').value),
                dcaRoiThresholdPct: parseFloat(document.getElementById('dcaRoi').value),
                dcaMultiplier: parseFloat(document.getElementById('dcaMult').value),
                profitRoiThresholdPct: parseFloat(document.getElementById('pScaleRoi').value),
                maxContracts: parseInt(document.getElementById('maxC').value)
            };
            await fetch('/api/user/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token }, body: JSON.stringify(body) });
            alert("Updated");
        }
        setInterval(sync, 2500); sync();
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    await loadAllUsers(); startMasterStreams();
    console.log(`✅ Android Server running on port ${CUSTOM_PORT}`);
});
