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
    apiKey: { type: String, default: "" },      // Primary Account (Longs)
    apiSecret: { type: String, default: "" },
    apiKey2: { type: String, default: "" },     // Secondary Account (Shorts)
    apiSecret2: { type: String, default: "" },
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
    maxContracts: 100, chartTicks: 800
};

const globalMarketData = { binance: { mid: 0 }, tickBuffer: [] };
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

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

// ==================== ML ENGINE ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000,
        ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000
    ];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getFeatures(i));
        y.push((prices[i+1] - prices[i]) > 0 ? 1 : 0);
    }
    let w = [0,0,0,0], b = 0, lr = 0.05;
    for (let e=0; e<20; e++) {
        for (let i=0; i<X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b)));
            let err = pred - y[i];
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }
    let curX = getFeatures(prices.length - 1);
    let finalPred = 1 / (1 + Math.exp(-(w[0]*curX[0] + w[1]*curX[1] + w[2]*curX[2] + w[3]*curX[3] + b)));
    finalPred = 1 - finalPred;
    return { confidence: Math.min(Math.abs(finalPred - 0.5) * 200, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== HEDGED USER INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat' };
        this.mlRawBuffer = []; this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        const opt = { agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } };
        this.htxLong = new ccxt.pro.htx({ apiKey: user.apiKey, secret: user.apiSecret, ...opt });
        this.htxShort = new ccxt.pro.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opt });
    }
    async initialize() {
        if (this.liveTradingEnabled) {
            try { 
                await this.htxLong.loadMarkets(); await this.htxShort.loadMarkets();
            } catch(e){}
        }
        this.startSync();
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async evaluateAIEntry() {
        if (globalMarketData.tickBuffer.length < 20) return;
        const mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
        this.mlRawBuffer.push(mlSig.rawValue); if (this.mlRawBuffer.length > this.config.mlAverageTicks) this.mlRawBuffer.shift();
        const avgRaw = this.mlRawBuffer.reduce((a,b)=>a+b,0)/this.mlRawBuffer.length;
        this.currentMl = { confidence: mlSig.confidence, type: mlSig.type, avgConf: Math.abs(avgRaw-0.5)*200, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' };

        if (this.isTrading || Date.now() - this.lastCloseTime < 3000) return;
        
        const activeType = this.config.mlUseAverage ? this.currentMl.avgType : this.currentMl.type;
        const activeConf = this.config.mlUseAverage ? this.currentMl.avgConf : this.currentMl.confidence;
        const signal = activeConf >= this.config.mlThreshold ? (activeType === 'bull' ? 'long' : 'short') : null;

        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            if (signal && pos.side !== signal) {
                if (!this.config.flipOnlyInProfit || (pos.exchangeROI || 0) >= (this.config.flipThresholdPct || 0)) {
                    await this.closePosition("ML_FLIP");
                    setTimeout(() => this.openPosition(signal), 500);
                }
            }
        } else if (signal) await this.openPosition(signal);
    }
    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        if (roi >= this.config.takeProfitPct) await this.closePosition("TAKE_PROFIT");
        else if (roi <= this.config.stopLossPct) await this.closePosition("STOP_LOSS");
    }
    async openPosition(side) {
        this.isTrading = true;
        try {
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            let qty = Math.max(1, Math.floor(this.walletBalance * 1));
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, side==='long'?'buy':'sell', qty, { offset: 'open' });
            this.activePositions = [{ side, entryPrice: globalMarketData.binance.mid, contracts: qty, size: qty*1000*globalMarketData.binance.mid, marginUsed: (qty*1000*globalMarketData.binance.mid)/75, entryTime: Date.now(), exchangeROI: 0 }];
            await this.saveState();
        } catch(e) {} finally { this.isTrading = false; }
    }
    async closePosition(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const ex = pos.side === 'long' ? this.htxLong : this.htxShort;
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'sell':'buy', pos.contracts, { reduceOnly: true, offset: 'close' });
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, 75, 0.0004);
            await TradeModel.create({ ...math, userId: this.userId, side: pos.side, contracts: pos.contracts, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now();
            await this.saveState();
        } catch(e) {} finally { this.isTrading = false; }
    }
    startSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const b1 = await this.htxLong.fetchBalance({ type: 'swap' });
                    const b2 = await this.htxShort.fetchBalance({ type: 'swap' });
                    this.walletBalance = (b1.total?.USDT || 0) + (b2.total?.USDT || 0);
                    if (this.activePositions.length > 0) {
                        const side = this.activePositions[0].side;
                        const ex = side === 'long' ? this.htxLong : this.htxShort;
                        const p = (await ex.fetchPositions([this.config.htxSymbol])).find(x => x.contracts > 0);
                        if (p) this.activePositions[0].exchangeROI = p.percentage; else this.activePositions = [];
                    }
                } catch(e){}
            }
        }, 1000);
    }
}

// ==================== MASTER LOOP ====================
const workers = new Map();
async function masterLoop() {
    (async function stream() {
        while(true) {
            try {
                const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance.mid = (t.bid + t.ask) / 2;
                globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
                if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                for (const w of workers.values()) { w.evaluateAIEntry(); w.checkExits(); }
            } catch(e){}
            await new Promise(r => setTimeout(r, 1000));
        }
    })();
}

// ==================== API ====================
const app = express(); app.use(express.json());
app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ ...req.body, passwordHash: hashPassword(req.body.password, salt), salt, token: generateToken() });
    res.json({ token: user.token });
});
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save();
        if(!workers.has(user._id.toString())) { const w = new UserTradeInstance(user); await w.initialize(); workers.set(user._id.toString(), w); }
        res.json({ token: user.token });
    } else res.status(401).json({ error: 'Invalid Credentials' });
});
app.get('/api/data', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    const trades = await TradeModel.find({ userId: req.user._id.toString() }).sort({ timestamp: -1 }).limit(10).lean();
    const totalPnl = (await TradeModel.find({ userId: req.user._id.toString() })).reduce((a,b)=>a+(b.netPnl||0),0);
    res.json({ config: w.config, metrics: { totalNetPnl: totalPnl, trades }, activePositions: w.activePositions, mlSignal: w.currentMl, walletBalance: w.walletBalance, liveTradingEnabled: w.liveTradingEnabled });
});
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    Object.assign(req.user, req.body); await req.user.save();
    workers.get(req.user._id.toString()).applyUserKeys(req.user); res.json({status:'ok'});
});
app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString()); Object.assign(w.config, req.body);
    req.user.config = w.config; req.user.markModified('config'); await req.user.save(); res.json({status:'ok'});
});
app.get('/api/close-all', authMiddleware, async (req, res) => { await workers.get(req.user._id.toString()).closePosition("MANUAL"); res.json({status:'ok'}); });

// ==================== DASHBOARD UI (WHITE NEAT) ====================
app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBotPille | Hedge AI</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); border: 1px solid #f0f0f0; padding: 24px; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-primary { background: #000; color: #fff; border-radius: 8px; padding: 12px; font-weight: 500; text-align: center; width: 100%; cursor: pointer; transition: 0.2s; }
        .btn-primary:hover { background: #333; }
        .view-section { display: none; } .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">
    <header class="bg-white border-b h-16 flex items-center px-8 justify-between sticky top-0 z-50">
        <div class="flex items-center gap-2 cursor-pointer" onclick="location.reload()">
            <span class="material-symbols-outlined text-black text-3xl">api</span>
            <span class="font-bold text-xl tracking-tight">TradeBotPille</span>
        </div>
        <div id="nav-private" class="hidden flex items-center gap-6 text-sm font-medium">
            <button onclick="nav('dashboard')" class="text-gray-500 hover:text-black">Terminal</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </div>
    </header>

    <main class="flex-grow p-8">
        <section id="view-home" class="view-section active-view max-w-md mx-auto py-20">
            <div class="ui-card">
                <h2 class="text-2xl font-bold mb-6 text-center">Login to Terminal</h2>
                <div class="space-y-4">
                    <input type="email" id="email" placeholder="Email Address" class="input-minimal">
                    <input type="password" id="pass" placeholder="Password" class="input-minimal">
                    <button onclick="login()" class="btn-primary">Access Engine</button>
                </div>
            </div>
        </section>

        <section id="view-dashboard" class="view-section max-w-7xl mx-auto">
            <div class="flex justify-between items-center mb-8">
                <h2 class="text-2xl font-bold">Hedge AI Terminal <span id="status" class="ml-2 text-xs font-normal text-gray-400"></span></h2>
                <div class="flex gap-3">
                    <button onclick="nav('settings')" class="px-4 py-2 bg-white border rounded-md text-sm font-bold">Setup API</button>
                    <button onclick="closeAll()" class="px-4 py-2 bg-red-50 text-red-600 rounded-md text-sm font-bold">Close All</button>
                </div>
            </div>

            <div class="grid lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 space-y-6">
                    <div class="grid grid-cols-4 gap-4">
                        <div class="ui-card"><p class="text-[10px] font-bold text-gray-400 uppercase">Total PnL</p><p id="net" class="text-xl font-bold">$0.00</p></div>
                        <div class="ui-card"><p class="text-[10px] font-bold text-gray-400 uppercase">Balance Sum</p><p id="bal" class="text-xl font-bold">$0.00</p></div>
                        <div class="ui-card"><p class="text-[10px] font-bold text-gray-400 uppercase">Live ROI</p><p id="roi" class="text-xl font-bold">0.00%</p></div>
                        <div class="ui-card"><p class="text-[10px] font-bold text-gray-400 uppercase">AI Prob</p><p id="ai" class="text-xl font-bold">0%</p></div>
                    </div>
                    <div class="ui-card">
                        <h3 class="font-bold mb-4 border-b pb-4">Closed Trade History</h3>
                        <table class="w-full text-sm text-left"><thead class="text-gray-400 border-b"><tr><th class="py-2">Side</th><th>Reason</th><th class="text-right">Net PnL</th></tr></thead><tbody id="history" class="font-mono"></tbody></table>
                    </div>
                </div>

                <div class="lg:col-span-4 space-y-6 h-fit">
                    <div class="ui-card">
                        <h3 class="font-bold mb-6 border-b pb-4">Strategy Settings</h3>
                        <div class="space-y-4 text-xs font-bold text-gray-500">
                            <div>TP % <input id="s-tp" class="input-minimal mt-1 text-green-600"></div>
                            <div>SL % <input id="s-sl" class="input-minimal mt-1 text-red-600"></div>
                            <hr class="my-4">
                            <div>ML Threshold % <input id="s-ml-t" class="input-minimal mt-1 text-blue-600"></div>
                            <div>ML Lookback <input id="s-look" class="input-minimal mt-1"></div>
                            <button onclick="saveConfig()" class="btn-primary mt-4">Save Configuration</button>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <section id="view-settings" class="view-section max-w-lg mx-auto py-10">
            <div class="ui-card">
                <h3 class="text-xl font-bold mb-6">Dual Account Hedge API</h3>
                <div class="space-y-6">
                    <div class="flex items-center gap-2 mb-4"><input type="checkbox" id="liveTrade" class="w-4 h-4"> <label class="font-bold">Enable Live Execution</label></div>
                    <div class="p-4 bg-gray-50 rounded-lg border">
                        <p class="text-[10px] font-bold text-green-600 uppercase mb-2">Long Account (Primary)</p>
                        <input type="password" id="key1" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec1" placeholder="Secret Key" class="input-minimal">
                    </div>
                    <div class="p-4 bg-gray-50 rounded-lg border">
                        <p class="text-[10px] font-bold text-red-600 uppercase mb-2">Short Account (Secondary)</p>
                        <input type="password" id="key2" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec2" placeholder="Secret Key" class="input-minimal">
                    </div>
                    <button onclick="saveKeys()" class="btn-primary">Update Hedge Integration</button>
                    <button onclick="nav('dashboard')" class="w-full text-sm mt-4 text-gray-400">Return to Terminal</button>
                </div>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('token');
        function nav(id) { document.querySelectorAll('.view-section').forEach(s=>s.classList.remove('active-view')); document.getElementById('view-'+id).classList.add('active-view'); }
        async function login() { 
            const email = document.getElementById('email').value;
            const password = document.getElementById('pass').value;
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password }) });
            const data = await res.json();
            if(data.token) { localStorage.setItem('token',data.token); location.reload(); } else { alert(data.error); }
        }
        function logout() { localStorage.removeItem('token'); location.reload(); }
        async function saveKeys() {
            await fetch('/api/user/keys', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': token}, body: JSON.stringify({ apiKey: document.getElementById('key1').value, apiSecret: document.getElementById('sec1').value, apiKey2: document.getElementById('key2').value, apiSecret2: document.getElementById('sec2').value, liveTradingEnabled: document.getElementById('liveTrade').checked }) });
            alert('API Connected'); nav('dashboard');
        }
        async function saveConfig() {
            await fetch('/api/user/config', { method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': token}, body: JSON.stringify({ takeProfitPct: parseFloat(document.getElementById('s-tp').value), stopLossPct: parseFloat(document.getElementById('s-sl').value), mlThreshold: parseFloat(document.getElementById('s-ml-t').value), mlLookback: parseInt(document.getElementById('s-look').value) }) });
            alert('Strategy Saved');
        }
        async function closeAll() { if(confirm('Close current position?')) await fetch('/api/close-all', { headers: {'Authorization': token} }); }
        
        if(token) {
            document.getElementById('nav-private').classList.remove('hidden');
            nav('dashboard');
            setInterval(async () => {
                const d = await (await fetch('/api/data', { headers: {'Authorization': token} })).json();
                if(!d.metrics) return;
                document.getElementById('net').innerText = '$'+d.metrics.totalNetPnl.toFixed(2);
                document.getElementById('bal').innerText = '$'+d.walletBalance.toFixed(2);
                document.getElementById('roi').innerText = (d.activePositions[0]?.exchangeROI || 0).toFixed(2)+'%';
                document.getElementById('ai').innerText = d.mlSignal.confidence.toFixed(1)+'% '+d.mlSignal.type.toUpperCase();
                document.getElementById('status').innerText = d.activePositions.length > 0 ? d.activePositions[0].side.toUpperCase() : 'WAITING';
                
                const h = document.getElementById('history'); h.innerHTML = '';
                d.metrics.trades.forEach(t => {
                    h.innerHTML += '<tr class="border-b last:border-0"><td class="py-3 '+(t.side==='long'?'text-green-600':'text-red-600')+' font-bold">'+t.side.toUpperCase()+'</td><td class="text-xs text-gray-400 uppercase">'+t.exitReason+'</td><td class="text-right font-bold">$'+t.netPnl.toFixed(2)+'</td></tr>';
                });

                if(!document.getElementById('s-tp').value) {
                    document.getElementById('s-tp').value = d.config.takeProfitPct; document.getElementById('s-sl').value = d.config.stopLossPct;
                    document.getElementById('s-ml-t').value = d.config.mlThreshold; document.getElementById('s-look').value = d.config.mlLookback;
                    document.getElementById('liveTrade').checked = d.liveTradingEnabled;
                }
            }, 1000);
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => { await masterLoop(); console.log('Hedge Server Online'); });
