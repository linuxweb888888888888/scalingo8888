const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ MongoDB Connected Successfully'))
    .catch(err => console.error('🚨 MongoDB Connection Error:', err));

const UserModel = mongoose.model('User_V_Hedged', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    // Account 1 - Longs Only
    apiKey1: { type: String, default: "" },
    apiSecret1: { type: String, default: "" },
    activePosition1: { type: Object, default: null },
    // Account 2 - Shorts Only
    apiKey2: { type: String, default: "" },
    apiSecret2: { type: String, default: "" },
    activePosition2: { type: Object, default: null },
    
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V_Hedged', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, accountNum: Number, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, netPnl: Number, roiPct: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V_Hedged', new mongoose.Schema({
    priceMid: Number, mlPlot: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

const AnalyticsModel = mongoose.model('SiteAnalytics_V_Hedged', new mongoose.Schema({
    key: { type: String, default: "global" }, views: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 }, knownIds: { type: [String], default: [] }
}));

// ==================== BASE CONFIGURATION ====================
const FORCED_LEVERAGE = 75;
const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT', binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, 
    takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0, 
    mlAverageTicks: 5, mlUseAverage: false, flipOnlyInProfit: true, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, maxContracts: 100, fees: { taker: 0.0004 }
};

const globalMarketData = { 
    binance: { mid: 0 }, tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });
const mlSignalCache = new Map();

// ==================== MATH & SECURITY ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
const tokenCache = new Map();

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnl = (pnlPct / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    return { grossPnlUsd: grossPnl, netPnlUsd: grossPnl - feeCost, roiPct: pnlPct * leverage, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getF = (i) => [((prices[i] - prices[i-1]) / prices[i-1]) * 1000, ((prices[i] - prices[i-5]) / prices[i-5]) * 1000];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getF(i)); y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0, 0], b = 0, lr = 0.05;
    for (let e = 0; e < 15; e++) {
        for (let i = 0; i < X.length; i++) {
            let p = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = p - y[i]; w[0] -= lr*err*X[i][0]; w[1] -= lr*err*X[i][1]; b -= lr*err;
        }
    }
    let cur = getF(prices.length - 1);
    let res = 1 / (1 + Math.exp(-(w[0]*cur[0] + w[1]*cur[1] + b)));
    return { confidence: Math.abs(res - 0.5) * 200, type: res >= 0.5 ? 'bull' : 'bear', rawValue: res };
}

// ==================== USER BOT INSTANCE (HEDGED) ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.liveTradingEnabled = user.liveTradingEnabled;
        this.activePositions = [user.activePosition1, user.activePosition2].filter(p => p !== null);
        
        const opts = { agent: keepAliveAgent, options: { defaultType: 'swap', positionMode: 'hedged' } };
        this.htx1 = new ccxt.pro.htx({ apiKey: user.apiKey1, secret: user.apiSecret1, ...opts });
        this.htx2 = new ccxt.pro.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opts });
        
        this.currentMl = { confidence: 0, type: 'flat' };
        this.startTime = Date.now();
        this.totalNetPnl = 0;
    }

    async saveState() {
        const p1 = this.activePositions.find(p => p.side === 'long') || null;
        const p2 = this.activePositions.find(p => p.side === 'short') || null;
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition1: p1, activePosition2: p2, config: this.config } });
    }

    async evaluateAIEntry() {
        let mlSig = mlSignalCache.get(this.config.mlLookback) || calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
        this.currentMl = mlSig;
        if (!this.liveTradingEnabled || !globalMarketData.binance.mid) return;

        const price = globalMarketData.binance.mid;
        const threshold = this.config.mlThreshold || 60;

        // Account 1: Handle Longs
        if (!this.activePositions.find(p => p.side === 'long') && mlSig.type === 'bull' && mlSig.confidence >= threshold) {
            await this.syncState(1, 'long', price);
        }
        // Account 2: Handle Shorts
        if (!this.activePositions.find(p => p.side === 'short') && mlSig.type === 'bear' && mlSig.confidence >= threshold) {
            await this.syncState(2, 'short', price);
        }
    }

    async checkExits() {
        for (const pos of this.activePositions) {
            const accNum = pos.side === 'long' ? 1 : 2;
            const price = globalMarketData.binance.mid;
            const math = calculateTradeMath(pos.side, pos.entryPrice, price, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            
            if (math.roiPct >= this.config.takeProfitPct) await this.closeHedged(accNum, "TAKE_PROFIT", price);
            else if (math.roiPct <= this.config.stopLossPct) await this.closeHedged(accNum, "STOP_LOSS", price);
            else if (math.roiPct <= -this.config.dcaRoiThresholdPct && Date.now() - pos.lastDca > 30000) {
                await this.dcaHedged(accNum, price);
            }
        }
    }

    async syncState(accNum, side, price) {
        const htx = accNum === 1 ? this.htx1 : this.htx2;
        const contracts = this.config.baseContracts;
        try {
            await htx.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', contracts, undefined, { offset: 'open' });
            const sizeUsd = contracts * this.config.contractSize * price;
            this.activePositions.push({ side, entryPrice: price, contracts, size: sizeUsd, margin: sizeUsd/FORCED_LEVERAGE, lastDca: Date.now() });
            await this.saveState();
        } catch(e) { console.error(`Open Acc ${accNum} Error:`, e.message); }
    }

    async dcaHedged(accNum, price) {
        const posIdx = this.activePositions.findIndex(p => (accNum === 1 ? p.side === 'long' : p.side === 'short'));
        const pos = this.activePositions[posIdx];
        const htx = accNum === 1 ? this.htx1 : this.htx2;
        const addC = Math.floor(pos.contracts * this.config.dcaMultiplier);
        if (pos.contracts + addC > this.config.maxContracts) return;

        try {
            await htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'buy' : 'sell', addC, undefined, { offset: 'open' });
            const addSize = addC * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addSize)) / (pos.size + addSize);
            pos.contracts += addC;
            pos.size += addSize;
            pos.lastDca = Date.now();
            await this.saveState();
        } catch(e) { console.error(`DCA Acc ${accNum} Error:`, e.message); }
    }

    async closeHedged(accNum, reason, price) {
        const htx = accNum === 1 ? this.htx1 : this.htx2;
        const posIdx = this.activePositions.findIndex(p => (accNum === 1 ? p.side === 'long' : p.side === 'short'));
        const pos = this.activePositions[posIdx];
        try {
            await htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { offset: 'close', reduceOnly: true });
            const math = calculateTradeMath(pos.side, pos.entryPrice, price, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            await TradeModel.create({ userId: this.userId, accountNum: accNum, side: pos.side, entryPrice: pos.entryPrice, exitPrice: price, contracts: pos.contracts, netPnl: math.netPnlUsd, roiPct: math.roiPct, exitReason: reason });
            this.activePositions.splice(posIdx, 1);
            await this.saveState();
        } catch(e) { console.error(`Close Acc ${accNum} Error:`, e.message); }
    }

    getExportData() {
        return { 
            config: this.config, 
            activePositions: this.activePositions, 
            mlSignal: this.currentMl, 
            binance: globalMarketData.binance,
            liveTradingEnabled: this.liveTradingEnabled,
            uptime: Math.floor((Date.now() - this.startTime) / 1000)
        };
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    await publicBinance.loadMarkets();
    (async function stream() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance.mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
                if (globalMarketData.tickBuffer.length > 200) globalMarketData.tickBuffer.shift();
                
                const sig = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = sig; mlSignalCache.set(BASE_CONFIG.mlLookback, sig);

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); worker.evaluateAIEntry().catch(()=>{});
                }
                await new Promise(r => setTimeout(r, 100));
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS SERVER & API ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    activeWorkers.set(user._id.toString(), new UserTradeInstance(user));
    res.json({ token: user.token, user: { name: user.name } });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    res.json({ token: user.token, user: { name: user.name } });
});

async function auth(req, res, next) {
    const user = await UserModel.findOne({ token: req.headers['authorization'] });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user; next();
}

app.get('/api/data', auth, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker.getExportData());
});

app.post('/api/user/keys', auth, async (req, res) => {
    const { apiKey1, apiSecret1, apiKey2, apiSecret2, liveTradingEnabled } = req.body;
    req.user.apiKey1 = apiKey1; req.user.apiSecret1 = apiSecret1;
    req.user.apiKey2 = apiKey2; req.user.apiSecret2 = apiSecret2;
    req.user.liveTradingEnabled = liveTradingEnabled;
    await req.user.save();
    activeWorkers.set(req.user._id.toString(), new UserTradeInstance(req.user));
    res.json({ status: 'ok' });
});

app.post('/api/user/config', auth, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    worker.config = { ...worker.config, ...req.body };
    req.user.config = worker.config; await req.user.save();
    res.json({ status: 'ok' });
});

// ==================== FRONTEND UI (HEDGED) ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html>
<head>
    <title>TradeBotPille | Hedged Dual Account</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 text-gray-900">
    <header class="bg-white border-b p-4 flex justify-between items-center sticky top-0 z-50">
        <h1 class="font-bold text-xl flex items-center gap-2"><span class="material-symbols-outlined">account_balance_wallet</span> TradeBotPille <span class="text-xs bg-black text-white px-2 py-0.5 rounded">HEDGED</span></h1>
        <div id="nav-private" class="hidden gap-4 text-sm font-medium">
            <button onclick="view('dashboard')">Terminal</button>
            <button onclick="view('settings')">Setup API</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </div>
    </header>

    <main class="max-w-6xl mx-auto p-4 sm:p-8">
        <!-- AUTH -->
        <section id="view-login" class="max-w-md mx-auto mt-20 bg-white p-8 rounded-xl shadow-sm border">
            <h2 class="text-2xl font-bold mb-6 text-center">Engine Access</h2>
            <input id="email" type="email" placeholder="Email" class="w-full border p-3 rounded mb-4">
            <input id="pass" type="password" placeholder="Password" class="w-full border p-3 rounded mb-6">
            <button onclick="login()" class="w-full bg-black text-white p-3 rounded font-bold">Login</button>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="hidden space-y-8">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <!-- Status & ML -->
                <div class="bg-white p-6 rounded-xl border shadow-sm col-span-1">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4">ML Engine Status</p>
                    <div id="ml-display" class="text-2xl font-mono font-bold">CALCULATING...</div>
                    <p id="ml-type" class="text-xs mt-1 font-bold uppercase"></p>
                    <hr class="my-4">
                    <p class="text-xs text-gray-400">SHIB Mid: <span id="price" class="font-mono text-gray-800">0.00000000</span></p>
                </div>

                <!-- Active Pos 1 (Long Account) -->
                <div class="bg-white p-6 rounded-xl border shadow-sm border-t-4 border-t-green-500">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Account 1 (Long)</p>
                    <div id="acc1-pos" class="text-lg font-mono">No Active Long</div>
                </div>

                <!-- Active Pos 2 (Short Account) -->
                <div class="bg-white p-6 rounded-xl border shadow-sm border-t-4 border-t-red-500">
                    <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Account 2 (Short)</p>
                    <div id="acc2-pos" class="text-lg font-mono">No Active Short</div>
                </div>
            </div>

            <!-- Chart -->
            <div class="bg-white p-6 rounded-xl border shadow-sm h-80">
                <canvas id="mainChart"></canvas>
            </div>
        </section>

        <!-- SETTINGS -->
        <section id="view-settings" class="hidden max-w-2xl mx-auto space-y-8">
            <div class="bg-white p-8 rounded-xl border shadow-sm">
                <h3 class="text-xl font-bold mb-6">Hedged API Configuration</h3>
                <div class="space-y-6">
                    <div class="flex items-center gap-2 bg-gray-50 p-4 rounded-lg">
                        <input type="checkbox" id="live" class="w-5 h-5">
                        <label class="font-bold">Enable Live Execution</label>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="col-span-2 text-xs font-bold text-green-600 uppercase">Account 1 (Long Account)</div>
                        <input id="k1" type="password" placeholder="HTX Key 1" class="border p-3 rounded text-sm">
                        <input id="s1" type="password" placeholder="HTX Secret 1" class="border p-3 rounded text-sm">
                        
                        <div class="col-span-2 text-xs font-bold text-red-600 uppercase mt-4">Account 2 (Short Account)</div>
                        <input id="k2" type="password" placeholder="HTX Key 2" class="border p-3 rounded text-sm">
                        <input id="s2" type="password" placeholder="HTX Secret 2" class="border p-3 rounded text-sm">
                    </div>
                    <button onclick="saveKeys()" class="w-full bg-black text-white p-4 rounded font-bold">Restart Engine & Save</button>
                </div>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('bt_token');
        const chartCtx = document.getElementById('mainChart').getContext('2d');
        const chart = new Chart(chartCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ label:'Price', data:[], borderColor:'#000', pointRadius:0, tension:0.1 }] },
            options: { responsive:true, maintainAspectRatio:false, scales:{ x:{display:false} } }
        });

        function view(v) {
            document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
            document.getElementById('view-'+v).classList.remove('hidden');
        }

        async function login() {
            const res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:document.getElementById('email').value, password:document.getElementById('pass').value}) });
            const d = await res.json();
            if(d.token) { localStorage.setItem('bt_token', d.token); token=d.token; location.reload(); }
        }

        function logout() { localStorage.removeItem('bt_token'); location.reload(); }

        async function saveKeys() {
            await fetch('/api/user/keys', { 
                method:'POST', 
                headers:{'Authorization':token, 'Content-Type':'application/json'}, 
                body:JSON.stringify({
                    apiKey1: document.getElementById('k1').value, apiSecret1: document.getElementById('s1').value,
                    apiKey2: document.getElementById('k2').value, apiSecret2: document.getElementById('s2').value,
                    liveTradingEnabled: document.getElementById('live').checked
                }) 
            });
            alert("Keys Updated");
        }

        async function update() {
            if(!token) return;
            const res = await fetch('/api/data', { headers:{'Authorization':token} });
            const d = await res.json();
            document.getElementById('nav-private').classList.remove('hidden');
            document.getElementById('nav-private').classList.add('flex');

            document.getElementById('price').innerText = d.binance.mid.toFixed(8);
            document.getElementById('ml-display').innerText = d.mlSignal.confidence.toFixed(1) + "%";
            document.getElementById('ml-type').innerText = d.mlSignal.type + " SIGNAL";
            document.getElementById('ml-type').className = "text-xs mt-1 font-bold uppercase " + (d.mlSignal.type === 'bull' ? 'text-green-500' : 'text-red-500');

            const p1 = d.activePositions.find(p => p.side === 'long');
            const p2 = d.activePositions.find(p => p.side === 'short');
            
            document.getElementById('acc1-pos').innerHTML = p1 ? '<div class="text-green-600 font-bold">LONG ACTIVE</div><div class="text-xs text-gray-400">Entry: '+p1.entryPrice.toFixed(8)+'</div>' : '<span class="text-gray-300">No Long</span>';
            document.getElementById('acc2-pos').innerHTML = p2 ? '<div class="text-red-600 font-bold">SHORT ACTIVE</div><div class="text-xs text-gray-400">Entry: '+p2.entryPrice.toFixed(8)+'</div>' : '<span class="text-gray-300">No Short</span>';

            chart.data.labels.push(""); chart.data.datasets[0].data.push(d.binance.mid);
            if(chart.data.labels.length > 50) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
            chart.update();
        }

        if(token) { view('dashboard'); setInterval(update, 1000); }
    </script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, async () => {
    console.log("✅ Hedged Engine Online");
    await startMasterStreams();
    const users = await UserModel.find({});
    users.forEach(u => activeWorkers.set(u._id.toString(), new UserTradeInstance(u)));
});
