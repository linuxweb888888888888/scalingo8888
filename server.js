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
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const mlSignalCache = new Map();
const tokenCache = new Map();

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

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
    for (let i = (prices.length - 2 - lookback); i <= (prices.length - 2); i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1] - prices[i];
        y.push(diff > 0 ? 1 : (diff < 0 ? 0 : 0.5));
    }
    let w = [0, 0, 0, 0], b = 0, lr = 0.05;
    for (let e = 0; e < 20; e++) {
        for (let i = 0; i < X.length; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b;
            let pred = 1 / (1 + Math.exp(-Math.max(Math.min(z, 20), -20)));
            let err = pred - y[i];
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }
    let currX = getFeatures(prices.length - 1);
    let zCur = w[0]*currX[0] + w[1]*currX[1] + w[2]*currX[2] + w[3]*currX[3] + b;
    let finalPred = 1 - (1 / (1 + Math.exp(-Math.max(Math.min(zCur, 20), -20))));
    return { confidence: Math.abs(finalPred - 0.5) * 200, type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== WORKER INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
        this.walletBalance = 0; this.isTrading = false;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", options: { defaultType: 'swap' } });
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async syncState(targetSide) {
        if(this.isTrading) return; this.isTrading = true;
        try {
            const contracts = Math.max(1, Math.floor(this.walletBalance * 1000));
            const price = globalMarketData.binance.mid;
            const sizeUsd = contracts * 1000 * price;
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, exchangeROI: 0, dcaStep: 0 }];
            await this.saveState();
        } finally { this.isTrading = false; }
    }
    async forceClosePosition() {
        this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
    }
    async evaluateAI() {
        let mlSig = mlSignalCache.get(this.config.mlLookback) || calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
        if (this.activePositions.length === 0 && mlSig.confidence >= this.config.mlThreshold && (Date.now() - this.lastCloseTime > 5000)) {
            await this.syncState(mlSig.type === 'bull' ? 'long' : 'short');
        }
    }
    async checkExits() {
        if (this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
        pos.exchangeROI = math.currentGrossRoi;
        if (pos.exchangeROI >= this.config.takeProfitPct || pos.exchangeROI <= this.config.stopLossPct) await this.forceClosePosition();
    }
}

// ==================== MANAGER ====================
const activeWorkers = new Map();
async function loadAllUsers() {
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u);
        worker.walletBalance = 1000;
        activeWorkers.set(u._id.toString(), worker);
    }
}
async function startStreams() {
    setInterval(async () => {
        try {
            const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
            const mid = (ticker.bid + ticker.ask) / 2;
            globalMarketData.binance = { mid };
            globalMarketData.tickBuffer.push(mid); if(globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
            const ml = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
            mlSignalCache.set(BASE_CONFIG.mlLookback, ml);
            memoryChartHistory.push({ priceMid: mid, mlPlot: ml.rawValue, timestamp: Date.now() });
            if(memoryChartHistory.length > 800) memoryChartHistory.shift();
            for(const w of activeWorkers.values()) { w.checkExits(); w.evaluateAI(); }
        } catch(e){}
    }, 2000);
}

// ==================== API ====================
const app = express(); app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user) return res.status(400).json({error:'User not found'});
    res.json({ token: user.token });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? { config: worker.config, activePositions: worker.activePositions, walletBalance: worker.walletBalance, mlSignal: mlSignalCache.get(worker.config.mlLookback) } : { error: "Not found" });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) {
        worker.config = { ...worker.config, ...req.body };
        req.user.config = worker.config; await req.user.save();
    }
    res.json({status: 'ok'});
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
        body { font-family: 'Google Sans', sans-serif; background: #F7F9FC; padding-bottom: 90px; padding-top: 65px; }
        .android-header { background: #FFF; position: fixed; top:0; width: 100%; height: 60px; display: flex; align-items: center; padding: 0 20px; border-bottom: 1px solid #EEE; z-index: 100; font-weight: 700; }
        .android-card { background: #FFF; border-radius: 28px; padding: 20px; margin: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .bottom-nav { background: #FFF; border-top: 1px solid #EEE; position: fixed; bottom: 0; width: 100%; display: flex; padding: 12px 0 25px; z-index: 100; }
        .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; color: #5F6368; transition: 0.2s; }
        .nav-item.active { color: #1A73E8; font-variation-settings: 'FILL' 1; }
        .view-section { display: none; }
        .view-section.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        
        /* SETTINGS STYLING */
        .pref-category { color: #1A73E8; font-size: 13px; font-weight: 700; margin: 24px 20px 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .pref-item { background: #FFF; padding: 16px 20px; display: flex; align-items: center; border-bottom: 1px solid #F0F0F0; }
        .pref-info { flex: 1; }
        .pref-title { font-size: 16px; color: #1C1B1F; font-weight: 500; }
        .pref-summary { font-size: 13px; color: #5F6368; margin-top: 2px; }
        .pref-input { width: 80px; text-align: right; border: none; background: #F1F3F4; border-radius: 8px; padding: 6px; font-family: 'Roboto Mono'; font-weight: 700; color: #1A73E8; }
        .pref-switch { width: 44px; height: 24px; background: #E0E0E0; border-radius: 12px; position: relative; transition: 0.3s; }
        .pref-switch.on { background: #1A73E8; }
        .pref-switch::after { content:''; position:absolute; width:18px; height:18px; background:#FFF; border-radius:50%; top:3px; left:3px; transition:0.3s; }
        .pref-switch.on::after { left:23px; }
    </style>
</head>
<body>

    <div class="android-header">TradeBot <span class="ml-auto material-symbols-rounded text-green-500">account_balance_wallet</span></div>

    <!-- TERMINAL VIEW -->
    <section id="view-terminal" class="view-section active">
        <div class="grid grid-cols-2 gap-0">
            <div class="android-card !mr-2 p-4">
                <p class="text-[11px] font-bold text-gray-400 uppercase">Live ROI</p>
                <p id="liveRoi" class="text-xl font-mono font-bold text-gray-800">0.00%</p>
            </div>
            <div class="android-card !ml-2 p-4">
                <p class="text-[11px] font-bold text-gray-400 uppercase">Balance</p>
                <p id="liveBalance" class="text-xl font-mono font-bold text-gray-800">$0.00</p>
            </div>
        </div>

        <div class="android-card">
            <div class="flex items-center mb-2">
                <span class="font-bold text-sm">AI Directional Confidence</span>
                <span id="mlPct" class="ml-auto font-mono text-blue-600 font-bold">0%</span>
            </div>
            <div class="h-3 w-full bg-gray-100 rounded-full overflow-hidden">
                <div id="mlBar" class="h-full bg-blue-600" style="width: 0%"></div>
            </div>
            <p id="mlTrend" class="text-[10px] font-bold mt-2 text-gray-400 uppercase">Searching...</p>
        </div>

        <div class="android-card">
            <h3 class="font-bold text-sm mb-4 uppercase text-gray-400">Position Info</h3>
            <div id="posBox" class="space-y-2">
                <p class="text-center py-6 text-gray-400 italic">No active positions</p>
            </div>
        </div>
    </section>

    <!-- SETTINGS VIEW (MATERIAL PREFERENCES) -->
    <section id="view-settings" class="view-section">
        <div class="pref-category">AI Engine Configuration</div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">Lookback Ticks</div>
                <div class="pref-summary">Historical data points for AI training</div>
            </div>
            <input type="number" id="set-mlLookback" class="pref-input">
        </div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">Confidence Threshold</div>
                <div class="pref-summary">Minimum % required to trigger trade</div>
            </div>
            <input type="number" id="set-mlThreshold" class="pref-input">
        </div>

        <div class="pref-category">Trade Execution</div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">Take Profit (%)</div>
                <div class="pref-summary">Auto-close at target gain</div>
            </div>
            <input type="number" id="set-tp" class="pref-input">
        </div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">Stop Loss (%)</div>
                <div class="pref-summary">Max risk per position</div>
            </div>
            <input type="number" id="set-sl" class="pref-input">
        </div>

        <div class="pref-category">Scaling & Risk</div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">DCA Multiplier</div>
                <div class="pref-summary">Size increase on loss step</div>
            </div>
            <input type="number" id="set-dcaMult" class="pref-input">
        </div>
        <div class="pref-item">
            <div class="pref-info">
                <div class="pref-title">Max Contracts</div>
                <div class="pref-summary">Hard limit on total position size</div>
            </div>
            <input type="number" id="set-maxC" class="pref-input">
        </div>

        <div class="p-4">
            <button onclick="saveSettings()" class="w-full bg-black text-white rounded-2xl py-4 font-bold shadow-lg">Save Changes</button>
        </div>
    </section>

    <nav class="bottom-nav">
        <div onclick="nav('terminal')" class="nav-item active" id="nav-terminal">
            <span class="material-symbols-rounded">monitoring</span>
            <span class="text-[11px] mt-1">Terminal</span>
        </div>
        <div onclick="nav('settings')" class="nav-item" id="nav-settings">
            <span class="material-symbols-rounded">settings</span>
            <span class="text-[11px] mt-1">Settings</span>
        </div>
    </nav>

    <script>
        let token = localStorage.getItem('token') || "dummy";
        function nav(id) {
            document.querySelectorAll('.view-section').forEach(v => v.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.getElementById('view-'+id).classList.add('active');
            document.getElementById('nav-'+id).classList.add('active');
        }

        async function fetchUI() {
            const res = await fetch('/api/data', { headers: { 'Authorization': token } });
            const data = await res.json();
            if(data.error) return;

            document.getElementById('liveBalance').innerText = '$' + data.walletBalance.toFixed(2);
            if(data.mlSignal) {
                document.getElementById('mlPct').innerText = data.mlSignal.confidence.toFixed(1) + '%';
                document.getElementById('mlBar').style.width = data.mlSignal.confidence + '%';
                document.getElementById('mlTrend').innerText = data.mlSignal.type + ' Probability';
            }

            const pos = data.activePositions[0];
            const posBox = document.getElementById('posBox');
            if(pos) {
                document.getElementById('liveRoi').innerText = pos.exchangeROI.toFixed(2) + '%';
                document.getElementById('liveRoi').className = "text-xl font-mono font-bold " + (pos.exchangeROI >= 0 ? "text-green-500" : "text-red-500");
                posBox.innerHTML = \`<div class="flex justify-between border-b pb-2"><span>Side</span><span class="font-bold">\${pos.side.toUpperCase()}</span></div>
                                     <div class="flex justify-between border-b pb-2"><span>Contracts</span><span class="font-bold">\${pos.contracts}</span></div>
                                     <div class="flex justify-between"><span>Entry</span><span class="font-bold">$\${pos.entryPrice.toFixed(6)}</span></div>\`;
            } else {
                document.getElementById('liveRoi').innerText = "0.00%";
                document.getElementById('liveRoi').className = "text-xl font-mono font-bold text-gray-400";
                posBox.innerHTML = '<p class="text-center py-6 text-gray-400 italic">No active positions</p>';
            }

            // Fill settings inputs once
            if(!window.settingsFilled) {
                document.getElementById('set-mlLookback').value = data.config.mlLookback;
                document.getElementById('set-mlThreshold').value = data.config.mlThreshold;
                document.getElementById('set-tp').value = data.config.takeProfitPct;
                document.getElementById('set-sl').value = data.config.stopLossPct;
                document.getElementById('set-dcaMult').value = data.config.dcaMultiplier;
                document.getElementById('set-maxC').value = data.config.maxContracts;
                window.settingsFilled = true;
            }
        }

        async function saveSettings() {
            const payload = {
                mlLookback: parseInt(document.getElementById('set-mlLookback').value),
                mlThreshold: parseFloat(document.getElementById('set-mlThreshold').value),
                takeProfitPct: parseFloat(document.getElementById('set-tp').value),
                stopLossPct: parseFloat(document.getElementById('set-sl').value),
                dcaMultiplier: parseFloat(document.getElementById('set-dcaMult').value),
                maxContracts: parseInt(document.getElementById('set-maxC').value)
            };
            await fetch('/api/user/config', { method:'POST', headers:{'Content-Type':'application/json','Authorization':token}, body: JSON.stringify(payload) });
            alert("Settings Updated");
        }

        setInterval(fetchUI, 2000);
    </script>
</body>
</html>`); });

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Android Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers(); startStreams();
});
