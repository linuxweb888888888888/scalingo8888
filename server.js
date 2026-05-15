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
    
    // SMART SCALING CONFIGS
    microScalpRoi: 0.5,       // Take small profit at 0.5%
    microScalpQty: 5,         // Contracts to close
    microDcaRoi: -0.5,        // Entry improve at -0.5%
    microDcaQty: 3,           // Contracts to add
    closeProfitQtyThreshold: 50
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

// ==================== MACHINE LEARNING MATH ENGINE ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (i) => [((prices[i]-prices[i-1])/prices[i-1])*1000, ((prices[i]-prices[i-3])/prices[i-3])*1000];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getFeatures(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0,0], b = 0, lr = 0.05;
    for (let e = 0; e < 20; e++) {
        for (let i = 0; i < X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    let curX = getFeatures(prices.length - 1);
    let finalP = 1 / (1 + Math.exp(-(w[0]*curX[0] + w[1]*curX[1] + b)));
    finalP = 1 - finalP;
    return { confidence: Math.abs(finalP - 0.5) * 200, type: finalP >= 0.5 ? 'bull' : 'bear', rawValue: finalP };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.metrics = { totalNetPnl: 0, winRate: 0, trades: [], wins: 0, losses: 0 };
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false;
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, config: this.config, lastCloseTime: this.lastCloseTime } });
    }

    // THIS IS THE METHOD THAT WAS MISSING OR MISNAMED
    async startSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled && this.activePositions.length > 0) {
                try {
                    const res = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const open = res.find(p => p.contracts > 0);
                    if (open) {
                        let entryP = open.entryPrice;
                        if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP *= 1000;
                        this.activePositions[0].entryPrice = entryP;
                        this.activePositions[0].exchangeROI = open.percentage || 0;
                        this.activePositions[0].exchangePnl = open.unrealizedPnl || 0;
                    } else {
                        this.activePositions = []; await this.saveState();
                    }
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total.USDT || 0;
                } catch(e){}
            }
        }, 2000);
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

            // SMART SCALING: MICRO-SCALPING
            const weakening = (pos.side === 'long' && mlVal < 0.52) || (pos.side === 'short' && mlVal > 0.48);
            if (roi >= (this.config.microScalpRoi || 0.5) && weakening && pos.contracts > 5) {
                await this.microOrder('close', this.config.microScalpQty || 5, "MICRO_SCALP");
            }

            // SMART SCALING: MICRO-DCA
            const strong = (pos.side === 'long' && mlVal > 0.65) || (pos.side === 'short' && mlVal < 0.35);
            if (roi <= (this.config.microDcaRoi || -0.5) && strong && (Date.now() - (pos.lastDcaTime || 0) > 20000)) {
                await this.microOrder('open', this.config.microDcaQty || 3, "ENTRY_IMPROVE");
            }

            // MAIN DCA
            if (roi <= -(Math.abs(this.config.dcaRoiThresholdPct)) && (Date.now() - (pos.lastDcaTime || 0) > 15000)) {
                await this.mainDca();
            }
        } catch (e) {}
    }

    async microOrder(action, qty, reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const side = action === 'open' ? (pos.side === 'long' ? 'buy' : 'sell') : (pos.side === 'long' ? 'sell' : 'buy');
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side, qty, undefined, action === 'close' ? { reduceOnly: true } : {});
            
            const price = globalMarketData.binance.mid;
            if (action === 'open') {
                const addedSize = qty * this.config.contractSize * price;
                pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
                pos.contracts += qty; pos.size += addedSize; pos.lastDcaTime = Date.now();
            } else {
                pos.contracts -= qty; pos.size = pos.contracts * this.config.contractSize * pos.entryPrice;
            }
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.contracts, type: reason, price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async mainDca() {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const qty = Math.floor(pos.contracts);
            const side = pos.side === 'long' ? 'buy' : 'sell';
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side, qty);
            
            const price = globalMarketData.binance.mid;
            const addedSize = qty * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
            pos.contracts += qty; pos.size += addedSize; pos.dcaStep++; pos.lastDcaTime = Date.now();
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: 'DCA', price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async closeFull(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true });
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } finally { this.isTrading = false; }
    }

    async evaluateEntry() {
        if (this.isTrading || this.activePositions.length > 0 || Date.now() - this.lastCloseTime < 5000) return;
        const sig = globalMarketData.mlSignal;
        if (sig.confidence >= this.config.mlThreshold) {
            const side = sig.type === 'bull' ? 'long' : 'short';
            const price = globalMarketData.binance.mid;
            const contracts = this.config.baseContracts || 1;
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', contracts);
            const sizeUsd = contracts * this.config.contractSize * price;
            this.activePositions = [{ id: Date.now(), side, entryPrice: price, contracts, size: sizeUsd, dcaStep: 0, entryTime: Date.now(), isPaper: !this.liveTradingEnabled, stepHistory: [{ step: 0, type: 'OPEN', price, roi: 0, time: Date.now() }] }];
            await this.saveState();
        }
    }
}

// ==================== STREAMS & WORKER MANAGER ====================
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
                for (const w of activeWorkers.values()) { w.checkExits(); w.evaluateEntry(); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS APP & UI ====================
const app = express(); app.use(express.json());

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        const worker = new UserTradeInstance(user);
        worker.startSync();
        activeWorkers.set(user._id.toString(), worker);
        res.json({ status: 'ok' });
    } catch(e) { res.status(400).json({ error: 'Email exists' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if(user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        const token = generateToken(); user.token = token; await user.save();
        tokenCache.set(token, { user, lastAccessed: Date.now() });
        res.json({ token });
    } else res.status(400).json({ error: 'Invalid' });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? { activePositions: worker.activePositions, metrics: worker.metrics, mlSignal: globalMarketData.mlSignal, walletBalance: worker.walletBalance } : { error: 'Not found' });
});

app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>TradeBot Smarter Scaling</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 text-gray-900 font-sans">
    <header class="bg-white shadow-sm h-16 flex items-center justify-between px-10">
        <div class="font-bold text-xl cursor-pointer" onclick="nav('home')">TradeBotPille</div>
        <nav id="nav-public" class="flex gap-4 text-sm font-medium">
            <button onclick="nav('login')">Login</button>
            <button onclick="nav('register')" class="bg-black text-white px-4 py-2 rounded-lg">Sign Up</button>
        </nav>
        <nav id="nav-private" class="hidden gap-4 text-sm font-medium">
            <button onclick="nav('dashboard')">Dashboard</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </nav>
    </header>

    <main>
        <!-- HOME -->
        <section id="view-home" class="view-section py-20 px-10 text-center">
            <h1 class="text-6xl font-black mb-6">TradeBot: <span class="text-blue-600">Smarter Scaling Active</span></h1>
            <div class="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto mt-12 text-left">
                <div class="bg-white p-8 rounded-3xl shadow-sm border">
                    <h2 class="text-xl font-bold text-green-600 mb-2">Micro-Scalping</h2>
                    <p class="text-gray-500">Banks small profits automatically when the ML signal shows the trend is weakening, keeping the trade running with less risk.</p>
                </div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border">
                    <h2 class="text-xl font-bold text-blue-600 mb-2">Micro-Averaging</h2>
                    <p class="text-gray-500">Adds tiny amounts to the position on small pullbacks to lower the average entry price while the trend is still strong.</p>
                </div>
            </div>
            <p class="mt-12 text-gray-400 italic">Login to the dashboard to monitor live smart-scaling logs in the Step History tab.</p>
        </section>

        <!-- LOGIN -->
        <section id="view-login" class="view-section hidden max-w-md mx-auto py-20 px-6">
            <div class="bg-white p-10 rounded-3xl shadow-xl border">
                <h2 class="text-3xl font-bold mb-6 text-center">Login</h2>
                <input type="email" id="l-email" placeholder="Email" class="w-full p-4 mb-4 bg-gray-50 rounded-xl">
                <input type="password" id="l-pass" placeholder="Password" class="w-full p-4 mb-6 bg-gray-50 rounded-xl">
                <button onclick="doLogin()" class="w-full bg-black text-white py-4 rounded-xl font-bold">Login</button>
            </div>
        </section>

        <!-- REGISTER -->
        <section id="view-register" class="view-section hidden max-w-md mx-auto py-20 px-6">
            <div class="bg-white p-10 rounded-3xl shadow-xl border">
                <h2 class="text-3xl font-bold mb-6 text-center">Sign Up</h2>
                <input type="text" id="r-name" placeholder="Name" class="w-full p-4 mb-4 bg-gray-50 rounded-xl">
                <input type="email" id="r-email" placeholder="Email" class="w-full p-4 mb-4 bg-gray-50 rounded-xl">
                <input type="password" id="r-pass" placeholder="Password" class="w-full p-4 mb-6 bg-gray-50 rounded-xl">
                <button onclick="doRegister()" class="w-full bg-black text-white py-4 rounded-xl font-bold">Register</button>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="view-section hidden max-w-6xl mx-auto py-10 px-6">
            <div class="grid grid-cols-3 gap-6">
                <div class="bg-white p-8 rounded-3xl shadow-sm border"><p class="text-xs font-bold text-gray-400 uppercase">Net PnL</p><p id="netPnl" class="text-3xl font-bold">$0.00</p></div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border"><p class="text-xs font-bold text-gray-400 uppercase">Contracts</p><p id="activeQty" class="text-3xl font-bold">0</p></div>
                <div class="bg-white p-8 rounded-3xl shadow-sm border"><p class="text-xs font-bold text-gray-400 uppercase">ROI</p><p id="activeRoi" class="text-3xl font-bold">0.00%</p></div>
            </div>
            <div class="mt-10 bg-white p-10 rounded-3xl shadow-sm border">
                <h3 class="font-bold mb-4">Step History (Smarter Scaling)</h3>
                <div id="stepHistory" class="text-sm font-mono text-gray-500">No activity yet.</div>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('bot_token');
        function nav(id) { document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden')); document.getElementById('view-'+id).classList.remove('hidden'); }
        async function doLogin() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email: document.getElementById('l-email').value, password: document.getElementById('l-pass').value })});
            const data = await res.json(); if(data.token) { localStorage.setItem('bot_token', data.token); location.reload(); }
        }
        async function doRegister() {
            await fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: document.getElementById('r-name').value, email: document.getElementById('r-email').value, password: document.getElementById('r-pass').value })}); nav('login');
        }
        function logout() { localStorage.removeItem('bot_token'); location.reload(); }
        if(token) { document.getElementById('nav-public').classList.add('hidden'); document.getElementById('nav-private').classList.remove('hidden'); nav('dashboard'); setInterval(updateDashboard, 1000); }
        async function updateDashboard() {
            const res = await fetch('/api/data', { headers: {'Authorization': token} }); const data = await res.json();
            if(data.activePositions && data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('activeQty').innerText = p.contracts;
                document.getElementById('activeRoi').innerText = (p.exchangeROI || 0).toFixed(2) + '%';
                if(p.stepHistory) { document.getElementById('stepHistory').innerHTML = p.stepHistory.map(s => '<div>['+s.type+'] Qty: '+s.step+' @ '+s.price+'</div>').join(''); }
            }
        }
    </script>
</body></html>`));

// ==================== APP START ====================
app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { 
        const w = new UserTradeInstance(u); 
        w.startSync(); // Now correctly defined in the class
        activeWorkers.set(u._id.toString(), w); 
    }
    startStreams();
    console.log(`✅ Server ready on port ${CUSTOM_PORT}`);
});
