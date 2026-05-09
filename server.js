const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI)
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

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0
};

const globalMarketData = { 
    binance: { mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};

const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const user = await UserModel.findOne({ token });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
}

// ==================== CORE MATH & ML ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = (side === 'long' ? 1 : -1);
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;
    return { grossPnlUsd, netPnlUsd, netRoiPct: (netPnlUsd / margin) * 100, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000
    ];
    for (let i = (prices.length - lookback - 2); i < prices.length - 2; i++) {
        X.push(getFeatures(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0, 0], b = 0, lr = 0.05;
    for (let e = 0; e < 10; e++) {
        for (let i = 0; i < X.length; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + b;
            let pred = 1 / (1 + Math.exp(-z));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    let currX = getFeatures(prices.length - 1);
    let zCur = w[0]*currX[0] + w[1]*currX[1] + b;
    let finalPred = 1 / (1 + Math.exp(-zCur));
    return { confidence: Math.abs(finalPred - 0.5) * 200, type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== INSTANCE CLASS ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.metrics = { totalNetPnl: 0, trades: [] };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
    }

    async init() {
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(50).lean();
        this.metrics.trades = dbTrades;
        this.metrics.totalNetPnl = dbTrades.reduce((sum, t) => sum + (t.netPnl || 0), 0);
    }

    async evaluateAI() {
        const mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
        if (this.activePositions.length === 0 && mlSig.confidence >= this.config.mlThreshold) {
            if (Date.now() - this.lastCloseTime < 5000) return;
            const side = mlSig.type === 'bull' ? 'long' : 'short';
            const price = globalMarketData.binance.mid;
            const sizeUsd = this.config.baseContracts * this.config.contractSize * price;
            this.activePositions = [{ side, entryPrice: price, contracts: this.config.baseContracts, size: sizeUsd, marginUsed: sizeUsd/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0 }];
            await UserModel.updateOne({ _id: this.userId }, { activePosition: this.activePositions[0] });
        } else if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            const sideMult = pos.side === 'long' ? 1 : -1;
            pos.exchangeROI = ((globalMarketData.binance.mid - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;
            
            if (pos.exchangeROI >= this.config.takeProfitPct || pos.exchangeROI <= this.config.stopLossPct) {
                await this.closePos("STRATEGY_EXIT");
            }
        }
    }

    async closePos(reason) {
        if (!this.activePositions.length) return;
        const pos = this.activePositions[0];
        const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
        const tradeLog = { userId: this.userId, ...pos, exitPrice: globalMarketData.binance.mid, netPnl: math.netPnlUsd, roiPct: pos.exchangeROI, exitReason: reason };
        await TradeModel.create(tradeLog);
        this.metrics.trades.push(tradeLog);
        this.metrics.totalNetPnl += math.netPnlUsd;
        this.activePositions = [];
        this.lastCloseTime = Date.now();
        await UserModel.updateOne({ _id: this.userId }, { activePosition: null, lastCloseTime: this.lastCloseTime });
    }
}

const activeWorkers = new Map();
async function startMasterStreams() {
    (async function stream() {
        while (true) {
            try {
                const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance.mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
                if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                globalMarketData.mlSignal = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                for (const worker of activeWorkers.values()) { await worker.evaluateAI(); }
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
        }
    })();
}

// ==================== API ROUTES ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, salt, passwordHash: hashPassword(req.body.password, salt), token: generateToken() });
    const worker = new UserTradeInstance(user); await worker.init();
    activeWorkers.set(user._id.toString(), worker);
    res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid' });
    user.token = generateToken(); await user.save();
    if (!activeWorkers.has(user._id.toString())) {
        const worker = new UserTradeInstance(user); await worker.init();
        activeWorkers.set(user._id.toString(), worker);
    }
    res.json({ token: user.token });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? { metrics: worker.metrics, activePositions: worker.activePositions, mlSignal: globalMarketData.mlSignal } : { error: 'No Worker' });
});

app.get('/api/close-all', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if (worker) await worker.closePos("MANUAL_EXIT");
    res.json({ status: 'ok' });
});

// ==================== FRONTEND ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
    <title>TradeBot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        .view-section { display: none; }
        .active-view { display: block; }
        .auth-only { display: none; }
    </style>
</head>
<body class="bg-slate-50 text-slate-900 font-sans">
    <main class="p-4 pb-24">
        <!-- Home View -->
        <section id="view-home" class="view-section active-view text-center py-12">
            <h1 class="text-4xl font-black mb-4">SHIB AI</h1>
            <p class="text-slate-400 mb-10">Autonomous Machine Learning Bot</p>
            <div id="home-auth-btns" class="space-y-4">
                <button onclick="nav('login')" class="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold">Sign In</button>
                <button onclick="nav('register')" class="w-full py-4 bg-white border border-slate-200 rounded-2xl font-bold">Register</button>
            </div>
        </section>

        <!-- Dashboard View -->
        <section id="view-dashboard" class="view-section">
            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-100">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Net PnL</p>
                    <h2 id="netPnl" class="text-xl font-black mt-1">$0.00</h2>
                </div>
                <div class="bg-white p-5 rounded-3xl shadow-sm border border-slate-100">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Live ROI</p>
                    <h2 id="activeRoi" class="text-xl font-black mt-1">0%</h2>
                </div>
            </div>

            <div class="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 mb-6 text-center">
                <div id="mlStatus" class="inline-block px-6 py-2 rounded-full text-xs font-black mb-3">WAITING...</div>
                <div class="text-xs text-slate-400">ML CONFIDENCE: <span id="mlValue" class="text-slate-900 font-bold">0%</span></div>
            </div>

            <div class="bg-white p-6 rounded-3xl shadow-sm border border-slate-100">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-xs font-black text-slate-400 uppercase">Last 10 Executions</h3>
                    <button onclick="manualClose()" class="text-[10px] font-bold text-red-500 uppercase">Force Close</button>
                </div>
                <div id="tradeHistoryBody" class="space-y-4"></div>
            </div>
        </section>

        <!-- Auth Views -->
        <section id="view-login" class="view-section"><h2 class="text-2xl font-bold mb-6">Login</h2><input id="l-email" placeholder="Email" class="w-full p-4 rounded-2xl border mb-4"><input id="l-pass" type="password" placeholder="Password" class="w-full p-4 rounded-2xl border mb-6"><button onclick="doLogin()" class="w-full py-4 bg-black text-white rounded-2xl font-bold">Login</button></section>
        <section id="view-register" class="view-section"><h2 class="text-2xl font-bold mb-6">Register</h2><input id="r-name" placeholder="Name" class="w-full p-4 rounded-2xl border mb-4"><input id="r-email" placeholder="Email" class="w-full p-4 rounded-2xl border mb-4"><input id="r-pass" type="password" placeholder="Password" class="w-full p-4 rounded-2xl border mb-6"><button onclick="doRegister()" class="w-full py-4 bg-black text-white rounded-2xl font-bold">Join Now</button></section>
    </main>

    <nav class="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-100 flex justify-around p-5">
        <button onclick="nav('home')" class="text-slate-400 hover:text-blue-600"><span class="material-symbols-outlined">home</span></button>
        <button onclick="nav('dashboard')" class="auth-only text-slate-400 hover:text-blue-600"><span class="material-symbols-outlined">show_chart</span></button>
        <button onclick="logout()" class="auth-only text-slate-400 hover:text-red-500"><span class="material-symbols-outlined">logout</span></button>
    </nav>

    <script>
        let token = localStorage.getItem('bot_token');
        let loop = null;

        function updateUI() {
            document.querySelectorAll('.auth-only').forEach(el => el.style.display = token ? 'block' : 'none');
            if(token) document.getElementById('home-auth-btns').style.display = 'none';
        }

        function nav(v) {
            document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active-view'));
            document.getElementById('view-' + v).classList.add('active-view');
            if(v === 'dashboard' && token) { if(!loop) loop = setInterval(fetchData, 2000); fetchData(); }
            else { clearInterval(loop); loop = null; }
        }

        async function fetchData() {
            const res = await fetch('/api/data', { headers: {'Authorization': token} });
            const data = await res.json();
            if(data.error) return;

            document.getElementById('netPnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(2);
            document.getElementById('netPnl').className = 'text-xl font-black mt-1 ' + (data.metrics.totalNetPnl >= 0 ? 'text-green-600' : 'text-red-600');
            
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('activeRoi').innerText = p.exchangeROI.toFixed(2) + '%';
                document.getElementById('activeRoi').className = 'text-xl font-black mt-1 ' + (p.exchangeROI >= 0 ? 'text-green-600' : 'text-red-600');
            } else {
                document.getElementById('activeRoi').innerText = '0%';
                document.getElementById('activeRoi').className = 'text-xl font-black mt-1 text-slate-300';
            }

            const ml = data.mlSignal;
            const sigLabel = ml.type === 'bull' ? 'LONG' : 'SHORT';
            const statusBox = document.getElementById('mlStatus');
            statusBox.innerText = 'SIGNAL: ' + sigLabel;
            statusBox.className = 'inline-block px-6 py-2 rounded-full text-xs font-black mb-3 ' + (ml.type === 'bull' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700');
            document.getElementById('mlValue').innerText = ml.confidence.toFixed(1) + '%';

            const hist = document.getElementById('tradeHistoryBody');
            hist.innerHTML = '';
            data.metrics.trades.slice(-10).reverse().forEach(t => {
                hist.innerHTML += '<div class="flex flex-col border-b border-slate-50 pb-3">' +
                    '<div class="flex justify-between items-center mb-1">' +
                        '<span class="text-xs font-black ' + (t.side === 'long' ? 'text-green-600' : 'text-red-600') + '">' + t.side.toUpperCase() + '</span>' +
                        '<span class="text-xs font-mono font-bold ' + (t.netPnl >= 0 ? 'text-green-600' : 'text-red-600') + '">$' + t.netPnl.toFixed(2) + '</span>' +
                    '</div>' +
                    '<div class="flex justify-between text-[10px] text-slate-400 font-bold uppercase">' +
                        '<span>Qty: ' + t.contracts + '</span>' +
                        '<span>ROI: ' + (t.roiPct ? t.roiPct.toFixed(2) : '0.00') + '%</span>' +
                    '</div>' +
                '</div>';
            });
        }

        async function doLogin() {
            const email = document.getElementById('l-email').value;
            const password = document.getElementById('l-pass').value;
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
            const d = await res.json();
            if(d.token) { localStorage.setItem('bot_token', d.token); token = d.token; updateUI(); nav('dashboard'); }
        }

        async function doRegister() {
            const name = document.getElementById('r-name').value;
            const email = document.getElementById('r-email').value;
            const password = document.getElementById('r-pass').value;
            const res = await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name, email, password}) });
            const d = await res.json();
            if(d.token) { localStorage.setItem('bot_token', d.token); token = d.token; updateUI(); nav('dashboard'); }
        }

        async function manualClose() { if(confirm('Close Position?')) await fetch('/api/close-all', { headers: {'Authorization': token} }); }
        function logout() { localStorage.removeItem('bot_token'); location.reload(); }

        updateUI();
        if(token) nav('dashboard');
    </script>
</body>
</html>`);
});

// ==================== START SERVER ====================
app.listen(CUSTOM_PORT, async () => { 
    console.log(`✅ Server running on port ${CUSTOM_PORT}`); 
    const users = await UserModel.find({}); 
    for(const u of users) { 
        const w = new UserTradeInstance(u); 
        await w.init(); 
        activeWorkers.set(u._id.toString(), w); 
    }
    startMasterStreams(); 
});
