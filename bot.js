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

const UserModel = mongoose.model('User_V3_Hedge', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },      // Account 1 (Longs)
    apiSecret: { type: String, default: "" },   // Account 1 (Longs)
    apiKey2: { type: String, default: "" },     // Account 2 (Shorts)
    apiSecret2: { type: String, default: "" },  // Account 2 (Shorts)
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
        userEntry = { user };
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
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000, ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getFeatures(i));
        y.push((prices[i+1] - prices[i]) > 0 ? 1 : 0);
    }
    let w = [0,0], b = 0, lr = 0.05;
    for (let e=0; e<15; e++) {
        for (let i=0; i<X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    let finalPred = 1 / (1 + Math.exp(-(w[0]*getFeatures(prices.length-1)[0] + w[1]*getFeatures(prices.length-1)[1] + b)));
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
        this.trades = []; this.totalNetPnl = 0; this.wins = 0;
        this.isTrading = false; this.currentMl = { confidence: 0, type: 'flat' };
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }
    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        const opt = { agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear', positionMode: 'hedged' } };
        this.htxLong = new ccxt.pro.htx({ apiKey: user.apiKey, secret: user.apiSecret, ...opt });
        this.htxShort = new ccxt.pro.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opt });
    }
    async initialize() {
        const dbT = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(50).lean();
        this.trades = dbT;
        this.totalNetPnl = dbT.reduce((a,b)=>a+(b.netPnl||0), 0);
        this.wins = dbT.filter(t=>t.netPnl > 0).length;
        this.startSync();
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async evaluateAIEntry() {
        if (globalMarketData.tickBuffer.length < 20) return;
        const mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback);
        this.currentMl = mlSig;
        if (this.isTrading || Date.now() - this.lastCloseTime < 3000) return;
        const signal = mlSig.confidence >= this.config.mlThreshold ? (mlSig.type === 'bull' ? 'long' : 'short') : null;
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
        if (roi >= this.config.takeProfitPct) await this.closePosition("TA_PROFIT");
        else if (roi <= this.config.stopLossPct) await this.closePosition("ST_LOSS");
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
            const tradeRec = { ...math, userId: this.userId, side: pos.side, contracts: pos.contracts, exitReason: reason, timestamp: new Date() };
            await TradeModel.create(tradeRec);
            this.trades.unshift(tradeRec); this.totalNetPnl += math.netPnlUsd;
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
                        const ex = this.activePositions[0].side === 'long' ? this.htxLong : this.htxShort;
                        const p = (await ex.fetchPositions([this.config.htxSymbol])).find(x => x.contracts > 0);
                        if (p) this.activePositions[0].exchangeROI = p.percentage; else this.activePositions = [];
                    }
                } catch(e){}
            }
        }, 2000);
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
app.get('/api/data', authMiddleware, (req, res) => {
    const w = workers.get(req.user._id.toString());
    res.json({ config: w.config, metrics: { totalNetPnl: w.totalNetPnl, winRate: ((w.wins/Math.max(1,w.trades.length))*100).toFixed(2), trades: w.trades }, activePositions: w.activePositions, mlSignal: w.currentMl, walletBalance: w.walletBalance, liveTradingEnabled: w.liveTradingEnabled });
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

// ==================== UI ====================
app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TradeBot Hedge V4</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap" rel="stylesheet">
    <style>
        body { background: #0a0a0a; color: #eee; font-family: 'Roboto Mono', monospace; }
        .card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 20px; }
        .input { background: #1a1a1a; border: 1px solid #333; color: #fff; padding: 8px; border-radius: 4px; width: 100%; outline: none; }
        .btn { background: #fff; color: #000; font-weight: bold; padding: 10px; border-radius: 6px; cursor: pointer; text-align: center; }
    </style>
</head>
<body class="p-8 max-w-7xl mx-auto">
    <div id="auth-view" class="max-w-md mx-auto mt-20">
        <div class="card space-y-4">
            <h2 class="text-xl font-bold text-center">SHIB HEDGE AI</h2>
            <input id="email" class="input" placeholder="Email">
            <input id="pass" class="input" type="password" placeholder="Password">
            <div class="btn" onclick="login()">Login to Terminal</div>
        </div>
    </div>

    <div id="dash-view" class="hidden space-y-6">
        <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold">HEDGE TERMINAL <span id="status" class="text-xs ml-2 text-gray-500"></span></h2>
            <div class="flex gap-2">
                <div class="btn text-xs px-4" onclick="nav('settings')">API SETUP</div>
                <div class="btn text-xs px-4 bg-red-600 text-white" onclick="closeAll()">CLOSE ALL</div>
                <div class="btn text-xs px-4 bg-gray-700 text-white" onclick="logout()">LOGOUT</div>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-4">
            <div class="card"><div class="text-[10px] text-gray-500">NET PNL</div><div id="net" class="text-xl font-bold">$0.00</div></div>
            <div class="card"><div class="text-[10px] text-gray-500">WALLET SUM</div><div id="bal" class="text-xl font-bold">$0.00</div></div>
            <div class="card"><div class="text-[10px] text-gray-500">ACTIVE ROI</div><div id="roi" class="text-xl font-bold">0.00%</div></div>
            <div class="card"><div class="text-[10px] text-gray-500">AI PROB</div><div id="ai" class="text-xl font-bold">0%</div></div>
        </div>

        <div class="grid grid-cols-3 gap-6">
            <div class="col-span-2 card">
                <h3 class="text-xs font-bold mb-4 text-gray-400">CLOSED TRADE HISTORY</h3>
                <table class="w-full text-[10px] text-left">
                    <thead><tr class="text-gray-600"><th>TIME</th><th>SIDE</th><th>REASON</th><th>PNL</th></tr></thead>
                    <tbody id="history"></tbody>
                </table>
            </div>
            <div class="space-y-6">
                <div id="settings-view" class="card space-y-4">
                    <h3 class="text-xs font-bold">DUAL API HEDGE</h3>
                    <label class="text-[10px] flex items-center gap-2"><input type="checkbox" id="live"> LIVE TRADING</label>
                    <div class="text-[10px] text-green-500">ACC 1 (LONG)</div>
                    <input id="key1" type="password" class="input text-xs" placeholder="API Key">
                    <input id="sec1" type="password" class="input text-xs" placeholder="Secret">
                    <div class="text-[10px] text-red-500">ACC 2 (SHORT)</div>
                    <input id="key2" type="password" class="input text-xs" placeholder="API Key">
                    <input id="sec2" type="password" class="input text-xs" placeholder="Secret">
                    <div class="btn text-xs" onclick="saveKeys()">SAVE KEYS</div>
                </div>
                <div class="card space-y-4">
                    <h3 class="text-xs font-bold">STRATEGY</h3>
                    <div class="grid grid-cols-2 gap-2 text-[10px]">
                        <div>TP %<input id="s-tp" class="input mt-1"></div>
                        <div>SL %<input id="s-sl" class="input mt-1"></div>
                        <div>LOOKBACK<input id="s-look" class="input mt-1"></div>
                        <div>THRESHOLD<input id="s-ml-t" class="input mt-1"></div>
                    </div>
                    <div class="btn text-xs" onclick="saveConfig()">SAVE CONFIG</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('token');
        function nav(id) { document.getElementById('settings-view').scrollIntoView(); }
        
        async function login() {
            const email = document.getElementById('email').value;
            const password = document.getElementById('pass').value;
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ email, password })
                });
                const data = await res.json();
                if(data.token) {
                    localStorage.setItem('token', data.token);
                    location.reload();
                } else {
                    alert(data.error || 'Login Failed');
                }
            } catch(e) { alert('Server Error'); }
        }

        function logout() { localStorage.removeItem('token'); location.reload(); }

        async function saveKeys() {
            await fetch('/api/user/keys', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Authorization': token},
                body: JSON.stringify({
                    apiKey: document.getElementById('key1').value,
                    apiSecret: document.getElementById('sec1').value,
                    apiKey2: document.getElementById('key2').value,
                    apiSecret2: document.getElementById('sec2').value,
                    liveTradingEnabled: document.getElementById('live').checked
                })
            });
            alert('Keys Saved');
        }

        async function saveConfig() {
            await fetch('/api/user/config', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'Authorization': token},
                body: JSON.stringify({
                    takeProfitPct: parseFloat(document.getElementById('s-tp').value),
                    stopLossPct: parseFloat(document.getElementById('s-sl').value),
                    mlLookback: parseInt(document.getElementById('s-look').value),
                    mlThreshold: parseFloat(document.getElementById('s-ml-t').value)
                })
            });
            alert('Strategy Updated');
        }

        async function closeAll() { await fetch('/api/close-all', { headers: {'Authorization': token} }); }

        if(token) {
            document.getElementById('auth-view').classList.add('hidden');
            document.getElementById('dash-view').classList.remove('hidden');
            setInterval(async () => {
                const res = await fetch('/api/data', { headers: {'Authorization': token} });
                const d = await res.json();
                document.getElementById('net').innerText = '$' + d.metrics.totalNetPnl.toFixed(2);
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('roi').innerText = (d.activePositions[0]?.exchangeROI || 0).toFixed(2) + '%';
                document.getElementById('ai').innerText = d.mlSignal.confidence.toFixed(1) + '% ' + d.mlSignal.type.toUpperCase();
                document.getElementById('status').innerText = d.activePositions.length > 0 ? d.activePositions[0].side.toUpperCase() : 'WAITING';
                
                const h = document.getElementById('history'); h.innerHTML = '';
                d.metrics.trades.forEach(t => {
                    h.innerHTML += '<tr class="border-b border-gray-800"><td>'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="'+(t.side==='long'?'text-green-500':'text-red-500')+'">'+t.side.toUpperCase()+'</td><td>'+t.exitReason+'</td><td>$'+t.netPnl.toFixed(2)+'</td></tr>';
                });

                if(!document.getElementById('s-tp').value) {
                    document.getElementById('s-tp').value = d.config.takeProfitPct;
                    document.getElementById('s-sl').value = d.config.stopLossPct;
                    document.getElementById('s-look').value = d.config.mlLookback;
                    document.getElementById('s-ml-t').value = d.config.mlThreshold;
                    document.getElementById('live').checked = d.liveTradingEnabled;
                }
            }, 1000);
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => { await masterLoop(); console.log('Hedge Server Online'); });
