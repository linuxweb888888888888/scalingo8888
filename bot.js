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
    priceMid: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
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
    baseContracts: 10,           // START CONTRACTS
    contractSize: 1000, 
    marginMode: 'cross', 
    fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    dcaRoiThresholdPct: 1.5,    // DCA TRIGGER PERCENTAGE
    dcaMultiplier: 2.0,         // DCA MULTIPLIER
    profitRoiThresholdPct: 2.0, 
    profitMultiplier: 1.5, 
    maxContracts: 5000, 
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    htx: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: []
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

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
    } else userEntry.lastAccessed = Date.now();
    req.user = userEntry.user;
    next();
}

// ==================== MATH ENGINE ====================
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

// ==================== METRICS ENGINE (ADDED DGR) ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.winRate = 0; this.totalTradesCount = 0;
        this.dailyGrowthRate = 0; this.startTime = Date.now();
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; 
        this.trades.push(trade); 
        this.totalNetPnl += trade.netPnl || 0;
        const wins = this.trades.filter(t => t.netPnl > 0).length;
        this.winRate = this.trades.length ? ((wins / this.trades.length) * 100).toFixed(2) : 0;
        
        // Calculate DGR (Daily Growth Rate)
        const daysActive = (Date.now() - this.startTime) / (1000 * 60 * 60 * 24);
        this.dailyGrowthRate = daysActive > 0 ? (this.totalNetPnl / Math.max(1, daysActive)).toFixed(4) : 0;

        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
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
        this.startExchangeSync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, config: this.config } });
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                } else { this.activePositions = []; }
            }
            return { success: true };
        } catch (error) { this.liveTradingEnabled = false; return { success: false, message: error.message }; }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
        if (!currentPrice) currentPrice = globalMarketData.binance.mid;
        
        const sideMult = pos.side === 'long' ? 1 : -1;
        const effectiveRoi = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;

        if (effectiveRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (effectiveRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
        else {
            const trigger = -(Math.abs(this.config.dcaRoiThresholdPct));
            if (effectiveRoi <= trigger && Date.now() - (pos.lastDcaTime || 0) > 5000) await this.addDcaPosition();
        }
    }

    async addDcaPosition() {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const multiplier = Number(this.config.dcaMultiplier) || 2.0;
            const startContracts = Number(this.config.baseContracts) || 10;
            let step = Number(pos.dcaStep) || 0;

            let contractsToAdd = Math.floor(startContracts * Math.pow(multiplier, step));
            if (pos.contracts + contractsToAdd > (this.config.maxContracts || 10000)) return;

            let execPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!pos.isPaper && this.liveTradingEnabled) {
                const orderSide = pos.side === 'long' ? 'buy' : 'sell';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open' });
            }

            const addedSize = contractsToAdd * this.config.contractSize * execPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (execPrice * addedSize)) / (pos.size + addedSize);
            pos.size += addedSize;
            pos.contracts += contractsToAdd;
            pos.dcaStep = step + 1;
            pos.lastDcaTime = Date.now();
            await this.saveState();
        } catch (e) { console.error("DCA Error:", e.message); } finally { this.isTrading = false; }
    }

    async manualOpen(side) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const startContracts = Number(this.config.baseContracts) || 10;
            let execPrice = side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            
            if (this.liveTradingEnabled) {
                const orderSide = side === 'long' ? 'buy' : 'sell';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, startContracts, undefined, { offset: 'open' });
            }

            const sizeUsd = startContracts * this.config.contractSize * execPrice;
            this.activePositions = [{ id: Date.now(), side: side, entryPrice: execPrice, contracts: startContracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: Date.now(), isPaper: !this.liveTradingEnabled, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
            await this.saveState();
        } catch (e) { console.error("Open Error:", e.message); } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            let exitPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!pos.isPaper && this.liveTradingEnabled) {
                const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, pos.contracts, undefined, { reduceOnly: true, offset: 'close' });
            }
            const math = calculateTradeMath(pos.side, pos.entryPrice, exitPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice, netPnl: math.netPnlUsd, exitReason: reason, timestamp: Date.now() });
            this.activePositions = [];
            await this.saveState();
        } catch (e) { console.error("Close Error:", e.message); } finally { this.isTrading = false; }
    }
    
    startExchangeSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total?.USDT || 0;
                } catch(e){}
            }
        }, 5000);
    }

    getExportData() { 
        return { config: this.config, metrics: this.metrics, activePositions: this.activePositions, walletBalance: this.walletBalance, binance: globalMarketData.binance }; 
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
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                
                if (memoryChartHistory.length === 0 || Date.now() - memoryChartHistory[memoryChartHistory.length-1].timestamp > 2000) {
                    memoryChartHistory.push({ priceMid: mid, timestamp: Date.now() });
                    if (memoryChartHistory.length > 800) memoryChartHistory.shift();
                }

                for (const worker of activeWorkers.values()) { worker.checkExits().catch(()=>{}); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== API ====================
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

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    req.user.apiKey = req.body.apiKey; req.user.apiSecret = req.body.apiSecret; 
    req.user.liveTradingEnabled = req.body.liveTradingEnabled;
    await req.user.save(); worker.applyUserKeys(req.user);
    res.json({ status: 'ok' });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    const { tpPct, slPct, dcaMultiplier, dcaTrigger, baseContracts } = req.body;
    if (tpPct) worker.config.takeProfitPct = parseFloat(tpPct);
    if (slPct) worker.config.stopLossPct = parseFloat(slPct);
    if (dcaMultiplier) worker.config.dcaMultiplier = parseFloat(dcaMultiplier);
    if (dcaTrigger) worker.config.dcaRoiThresholdPct = parseFloat(dcaTrigger);
    if (baseContracts) worker.config.baseContracts = parseInt(baseContracts);
    req.user.config = worker.config; await req.user.save();
    res.json({ status: 'ok' });
});

app.get('/api/open/:side', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    await worker.manualOpen(req.params.side);
    res.json({ status: 'ok' });
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : {});
});

app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    await worker.forceClosePosition("MANUAL_EXIT"); 
    res.json({status: 'ok'}); 
});

app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>SHIB Controller | No-AI Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; background: #fafafa; } .font-mono { font-family: 'JetBrains Mono', monospace; }</style>
</head>
<body class="p-4 md:p-10">
    <div id="auth-view" class="max-w-md mx-auto space-y-4">
        <h1 class="text-3xl font-black italic">TERMINAL LOGIN</h1>
        <input id="email" type="email" placeholder="Email" class="w-full p-3 border rounded">
        <input id="pass" type="password" placeholder="Password" class="w-full p-3 border rounded">
        <button onclick="login()" class="w-full bg-black text-white p-3 rounded font-bold">ENTER SYSTEM</button>
    </div>

    <div id="main-view" class="hidden max-w-6xl mx-auto space-y-6">
        <div class="flex justify-between items-center">
            <h1 class="text-2xl font-black">SHIB <span class="text-indigo-600">DCA</span> SYSTEM</h1>
            <button onclick="logout()" class="text-red-500 font-bold">Logout</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="bg-white p-6 border rounded shadow-sm">
                <p class="text-xs font-bold text-gray-400 uppercase">Daily Growth Rate (DGR)</p>
                <p id="dgr" class="text-2xl font-mono font-black">$0.00</p>
            </div>
            <div class="bg-white p-6 border rounded shadow-sm">
                <p class="text-xs font-bold text-gray-400 uppercase">Net PnL</p>
                <p id="pnl" class="text-2xl font-mono font-black">$0.00</p>
            </div>
            <div class="bg-white p-6 border rounded shadow-sm">
                <p class="text-xs font-bold text-gray-400 uppercase">Start Contracts</p>
                <p id="cur-contracts" class="text-2xl font-mono font-black">0</p>
            </div>
            <div class="bg-black p-6 rounded shadow-lg text-white">
                <p class="text-xs font-bold text-gray-500 uppercase">Live ROI</p>
                <p id="roi" class="text-2xl font-mono font-black">0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div class="lg:col-span-2 space-y-6">
                <div class="bg-white p-4 border rounded h-64"><canvas id="chart"></canvas></div>
                <div class="flex gap-4">
                    <button onclick="openTrade('long')" class="flex-1 bg-green-500 text-white p-6 rounded-xl font-black text-xl hover:bg-green-600 transition">OPEN LONG</button>
                    <button onclick="openTrade('short')" class="flex-1 bg-red-500 text-white p-6 rounded-xl font-black text-xl hover:bg-red-600 transition">OPEN SHORT</button>
                </div>
                <button onclick="closePos()" class="w-full border-2 border-black p-4 rounded-xl font-black hover:bg-gray-100">EMERGENCY EXIT</button>
            </div>

            <div class="bg-white p-6 border rounded space-y-4">
                <h2 class="font-black border-b pb-2 uppercase text-sm">Strategy Settings</h2>
                <div><label class="text-xs font-bold">Start Contracts</label><input id="cfg-base" type="number" class="w-full p-2 border rounded font-mono"></div>
                <div><label class="text-xs font-bold">DCA Multiplier</label><input id="cfg-mult" type="number" step="0.1" class="w-full p-2 border rounded font-mono"></div>
                <div><label class="text-xs font-bold">DCA Trigger % (Loss)</label><input id="cfg-trigger" type="number" step="0.1" class="w-full p-2 border rounded font-mono"></div>
                <div class="grid grid-cols-2 gap-2">
                    <div><label class="text-xs font-bold">TP %</label><input id="cfg-tp" type="number" class="w-full p-2 border rounded font-mono"></div>
                    <div><label class="text-xs font-bold">SL %</label><input id="cfg-sl" type="number" class="w-full p-2 border rounded font-mono"></div>
                </div>
                <button onclick="saveCfg()" class="w-full bg-indigo-600 text-white p-3 rounded font-bold">SAVE CONFIG</button>
                
                <div class="pt-4 space-y-2">
                   <h2 class="font-black border-b pb-2 uppercase text-sm">API Settings</h2>
                   <input id="api-key" type="password" placeholder="HTX Key" class="w-full p-2 border rounded text-xs">
                   <input id="api-sec" type="password" placeholder="HTX Secret" class="w-full p-2 border rounded text-xs">
                   <div class="flex items-center gap-2"><input type="checkbox" id="api-live"><label class="text-xs font-bold">Enable Live Trading</label></div>
                   <button onclick="saveKeys()" class="w-full bg-gray-200 p-2 rounded text-xs font-bold">Update Keys</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('bt_token');
        const chart = new Chart(document.getElementById('chart'), { type: 'line', data: { labels: [], datasets: [{ label: 'SHIB', data: [], borderColor: '#000', pointRadius: 0, borderWidth: 2 }] }, options: { maintainAspectRatio: false, animation: false, scales: { x: { display: false } } } });

        async function login() {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pass').value }) });
            const data = await res.json();
            if(data.token) { token = data.token; localStorage.setItem('bt_token', token); location.reload(); }
        }

        function logout() { localStorage.removeItem('bt_token'); location.reload(); }

        async function saveCfg() {
            await fetch('/api/user/config', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': token}, body: JSON.stringify({ baseContracts: document.getElementById('cfg-base').value, dcaMultiplier: document.getElementById('cfg-mult').value, dcaTrigger: document.getElementById('cfg-trigger').value, tpPct: document.getElementById('cfg-tp').value, slPct: document.getElementById('cfg-sl').value }) });
            alert("Saved");
        }

        async function saveKeys() {
            await fetch('/api/user/keys', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': token}, body: JSON.stringify({ apiKey: document.getElementById('api-key').value, apiSecret: document.getElementById('api-sec').value, liveTradingEnabled: document.getElementById('api-live').checked }) });
            alert("Keys Updated");
        }

        async function openTrade(side) { await fetch('/api/open/'+side, { headers: {'Authorization': token} }); }
        async function closePos() { await fetch('/api/close-all', { headers: {'Authorization': token} }); }

        async function refresh() {
            if(!token) return;
            document.getElementById('auth-view').classList.add('hidden');
            document.getElementById('main-view').classList.remove('hidden');
            const res = await fetch('/api/data', { headers: {'Authorization': token} });
            const data = await res.json();
            
            document.getElementById('pnl').innerText = '$' + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById('dgr').innerText = '$' + data.metrics.dailyGrowthRate;
            
            if(data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('cur-contracts').innerText = p.contracts;
                document.getElementById('roi').innerText = (p.exchangeROI || 0).toFixed(2) + '%';
                document.getElementById('roi').className = p.exchangeROI >= 0 ? 'text-2xl font-mono font-black text-green-400' : 'text-2xl font-mono font-black text-red-400';
            } else {
                document.getElementById('cur-contracts').innerText = '0';
                document.getElementById('roi').innerText = 'IDLE';
                document.getElementById('roi').className = 'text-2xl font-mono font-black text-gray-500';
            }

            if(data.binance) {
                chart.data.labels.push('');
                chart.data.datasets[0].data.push(data.binance.mid);
                if(chart.data.labels.length > 50) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
                chart.update();
            }
        }

        if(token) {
            setInterval(refresh, 1000);
            fetch('/api/data', { headers: {'Authorization': token} }).then(r => r.json()).then(data => {
                document.getElementById('cfg-base').value = data.config.baseContracts;
                document.getElementById('cfg-mult').value = data.config.dcaMultiplier;
                document.getElementById('cfg-trigger').value = data.config.dcaRoiThresholdPct;
                document.getElementById('cfg-tp').value = data.config.takeProfitPct;
                document.getElementById('cfg-sl').value = data.config.stopLossPct;
            });
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    const users = await UserModel.find({});
    for(const u of users) {
        const worker = new UserTradeInstance(u); await worker.initialize();
        activeWorkers.set(u._id.toString(), worker);
    }
    startMasterStreams();
});
