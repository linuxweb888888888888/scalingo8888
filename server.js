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
    maxDcaStepsBeforeReverse: 10,
    
    // SMARTER SCALING LOGIC VALUES
    microScalpRoi: 0.5,
    microScalpQty: 5,
    microDcaRoi: -0.5,
    microDcaQty: 3,
    closeProfitQtyThreshold: 50,
    
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
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

// ==================== ENGINE MATH ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push([(prices[i]-prices[i-1])/prices[i-1]]);
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0], b = 0, lr = 0.05;
    for(let e=0; e<20; e++) {
        for(let i=0; i<X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + b)));
            w[0] -= lr * (pred - y[i]) * X[i][0];
            b -= lr * (pred - y[i]);
        }
    }
    let finalP = 1 / (1 + Math.exp(-(w[0]*((prices[prices.length-1]-prices[prices.length-2])/prices[prices.length-2]) + b)));
    finalP = 1 - finalP;
    return { confidence: Math.abs(finalP-0.5)*200, type: finalP>=0.5?'bull':'bear', rawValue: finalP };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.isTrading = false;
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, config: this.config } });
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        const mlVal = globalMarketData.mlSignal.rawValue;

        try {
            if (roi >= this.config.takeProfitPct) return await this.closeFull("TAKE_PROFIT");
            if (roi <= this.config.stopLossPct) return await this.closeFull("STOP_LOSS");
            if (pos.contracts >= (this.config.closeProfitQtyThreshold || 50) && roi > 0) return await this.closeFull("QTY_PROFIT_TARGET");

            // MICRO SCALING LOGIC
            const weakening = (pos.side === 'long' && mlVal < 0.52) || (pos.side === 'short' && mlVal > 0.48);
            if (roi >= (this.config.microScalpRoi || 0.5) && weakening && pos.contracts > 5) {
                await this.microOrder('close', this.config.microScalpQty || 5, "MICRO_SCALP");
            }
            const strong = (pos.side === 'long' && mlVal > 0.65) || (pos.side === 'short' && mlVal < 0.35);
            if (roi <= (this.config.microDcaRoi || -0.5) && strong && (Date.now() - (pos.lastDcaTime || 0) > 20000)) {
                await this.microOrder('open', this.config.microDcaQty || 3, "ENTRY_IMPROVE");
            }

            if (roi <= -(Math.abs(this.config.dcaRoiThresholdPct)) && (Date.now() - (pos.lastDcaTime || 0) > 15000)) {
                await this.mainDca();
            }
        } catch (e) {}
    }

    async microOrder(action, qty, reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, action === 'open' ? (pos.side==='long'?'buy':'sell') : (pos.side==='long'?'sell':'buy'), qty);
            if (action === 'open') {
                pos.contracts += qty; pos.lastDcaTime = Date.now();
            } else {
                pos.contracts -= qty;
            }
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.contracts, type: reason, price: globalMarketData.binance.mid, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async mainDca() {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const qty = Math.floor(pos.contracts);
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'buy':'sell', qty);
            pos.contracts += qty; pos.dcaStep++; pos.lastDcaTime = Date.now();
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async closeFull(reason) {
        this.isTrading = true;
        try {
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, this.activePositions[0].side==='long'?'sell':'buy', this.activePositions[0].contracts);
            this.activePositions = []; await this.saveState();
        } finally { this.isTrading = false; }
    }
}

// ==================== SERVER & STREAMS ====================
const activeWorkers = new Map();
async function startStreams() {
    (async function stream() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { mid };
                globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                globalMarketData.mlSignal = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                for (const w of activeWorkers.values()) { w.checkExits(); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

const app = express(); app.use(express.json());

// UI RESPONSE WITH ALL SECTIONS RESTORED
app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>TradeBot Smarter Scaling</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet"></head>
<body class="bg-gray-50 text-gray-900 font-sans">
    <header class="bg-white shadow-sm sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="font-bold text-xl cursor-pointer" onclick="nav('home')">TradeBotPille</div>
            <nav id="nav-public" class="flex gap-4 text-sm font-medium">
                <button onclick="nav('login')" class="hover:text-black">Login</button>
                <button onclick="nav('register')" class="bg-black text-white px-4 py-2 rounded-lg">Sign Up</button>
            </nav>
            <nav id="nav-private" class="hidden gap-4 text-sm font-medium">
                <button onclick="nav('dashboard')" class="hover:text-black">Dashboard</button>
                <button onclick="logout()" class="text-red-500">Logout</button>
            </nav>
        </div>
    </header>

    <main>
        <!-- HOME SECTION -->
        <section id="view-home" class="view-section active-view max-w-5xl mx-auto py-20 px-6 text-center">
            <h1 class="text-6xl font-black mb-6">TradeBot: <span class="text-blue-600">Smarter Scaling Active</span></h1>
            
            <div class="grid md:grid-cols-2 gap-8 mt-12 text-left">
                <div class="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                    <h2 class="text-2xl font-bold text-green-600 mb-4">Micro-Scalping</h2>
                    <p class="text-gray-500">Banks small profits automatically when the ML signal shows the trend is weakening, keeping the trade running with less risk.</p>
                </div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                    <h2 class="text-2xl font-bold text-blue-600 mb-4">Micro-Averaging</h2>
                    <p class="text-gray-500">Adds tiny amounts to the position on small pullbacks to lower the average entry price while the trend is still strong.</p>
                </div>
            </div>
            
            <p class="mt-12 text-gray-400 italic">Login to the dashboard to monitor live smart-scaling logs in the Step History tab.</p>
            <button onclick="nav('register')" class="mt-8 bg-black text-white px-10 py-4 rounded-full font-bold text-lg shadow-xl">Get Started Now</button>
        </section>

        <!-- LOGIN SECTION -->
        <section id="view-login" class="view-section hidden max-w-md mx-auto py-20 px-6">
            <div class="bg-white p-10 rounded-3xl shadow-xl border border-gray-100">
                <h2 class="text-3xl font-bold mb-6 text-center">Welcome Back</h2>
                <input type="email" id="login-email" placeholder="Email" class="w-full p-4 mb-4 bg-gray-50 rounded-xl border-none outline-none">
                <input type="password" id="login-pass" placeholder="Password" class="w-full p-4 mb-6 bg-gray-50 rounded-xl border-none outline-none">
                <button onclick="doLogin()" class="w-full bg-black text-white py-4 rounded-xl font-bold">Login to Terminal</button>
                <div id="login-err" class="text-red-500 text-center mt-4"></div>
            </div>
        </section>

        <!-- REGISTER SECTION -->
        <section id="view-register" class="view-section hidden max-w-md mx-auto py-20 px-6">
            <div class="bg-white p-10 rounded-3xl shadow-xl border border-gray-100">
                <h2 class="text-3xl font-bold mb-6 text-center">Create Account</h2>
                <input type="text" id="reg-name" placeholder="Full Name" class="w-full p-4 mb-4 bg-gray-50 rounded-xl border-none outline-none">
                <input type="email" id="reg-email" placeholder="Email Address" class="w-full p-4 mb-4 bg-gray-50 rounded-xl border-none outline-none">
                <input type="password" id="reg-pass" placeholder="Password" class="w-full p-4 mb-6 bg-gray-50 rounded-xl border-none outline-none">
                <button onclick="doRegister()" class="w-full bg-black text-white py-4 rounded-xl font-bold">Start Trading</button>
            </div>
        </section>

        <!-- DASHBOARD SECTION -->
        <section id="view-dashboard" class="view-section hidden max-w-7xl mx-auto py-10 px-6">
             <div class="flex justify-between items-center mb-10">
                <h2 class="text-3xl font-bold">Trading Dashboard</h2>
                <div class="flex gap-4">
                    <div class="bg-green-100 text-green-700 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest">Smarter Scaling: On</div>
                    <button onclick="nav('settings')" class="text-gray-400 hover:text-black font-bold">Setup API</button>
                </div>
             </div>
             <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase mb-2">Net PnL</p>
                    <p id="netPnl" class="text-3xl font-mono font-bold">$0.0000</p>
                </div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase mb-2">Active Qty</p>
                    <p id="activeQty" class="text-3xl font-mono font-bold">0</p>
                </div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                    <p class="text-xs font-bold text-gray-400 uppercase mb-2">Live ROI</p>
                    <p id="activeRoi" class="text-3xl font-mono font-bold">0.00%</p>
                </div>
             </div>
             <div class="mt-10 bg-white p-10 rounded-3xl shadow-sm border border-gray-100">
                 <h3 class="font-bold mb-6 text-xl">Smarter Scaling Activity (Step History)</h3>
                 <div id="step-history" class="text-gray-400 font-mono text-sm">No recent scaling activity.</div>
             </div>
        </section>

    </main>

    <script>
        let authToken = localStorage.getItem('bot_token');
        function nav(id) {
            document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
            document.getElementById('view-' + id).classList.remove('hidden');
        }
        function logout() { localStorage.removeItem('bot_token'); location.reload(); }
        async function doLogin() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-pass').value })});
            const data = await res.json();
            if(data.token) { localStorage.setItem('bot_token', data.token); location.reload(); }
            else { document.getElementById('login-err').innerText = data.error; }
        }
        async function doRegister() {
            await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-pass').value })});
            nav('login');
        }
        if(authToken) { 
            document.getElementById('nav-public').classList.add('hidden'); 
            document.getElementById('nav-private').classList.remove('hidden'); 
            nav('dashboard'); 
        }
    </script>
</body></html>`));

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    await UserModel.create({ name: req.body.name, email: req.body.email, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    res.json({status: 'ok'});
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        res.json({token: user.token});
    } else { res.status(400).json({error: 'Invalid Credentials'}); }
});

app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { const w = new UserTradeInstance(u); w.startSync(); activeWorkers.set(u._id.toString(), w); }
    startStreams();
    console.log(`✅ Smarter Scaling Engine with UI Live on ${CUSTOM_PORT}`);
});
