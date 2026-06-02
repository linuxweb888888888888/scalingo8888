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

const UserModel = mongoose.model('User_V4_Hedge', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },
    apiSecret: { type: String, default: "" },
    apiKey2: { type: String, default: "" }, // ACCOUNT 2 (Shorts)
    apiSecret2: { type: String, default: "" }, // ACCOUNT 2 (Shorts)
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    activePosition: { type: Object, default: null }, 
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V4_Hedge', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, grossRoiPct: Number, roiPct: Number, 
    netPnl: Number, feeCost: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V9', new mongoose.Schema({
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

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
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

// ==================== PERFORMANCE TRACKER ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalNetPnl = 0; this.wins = 0; this.losses = 0; this.winRate = 0; this.totalTradesCount = 0;
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(100).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    processTrade(trade, save = true) {
        this.totalTradesCount++;
        this.trades.push(trade); if (this.trades.length > 100) this.trades.shift();
        this.totalNetPnl += trade.netPnl || 0;
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = ((this.wins / this.trades.length) * 100).toFixed(2);
        if (save) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
}

// ==================== HEDGED USER INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
        this.metrics = new PerformanceMetrics(this.userId);
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
        await this.metrics.init();
        if (this.liveTradingEnabled) {
            try { 
                await this.htxLong.loadMarkets(); await this.htxShort.loadMarkets();
                await this.htxLong.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol).catch(()=>{});
                await this.htxShort.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol).catch(()=>{});
            } catch(e){}
        }
        this.startSync();
    }
    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }
    async evaluateAIEntry() {
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
                if (!this.config.flipOnlyInProfit || pos.exchangeROI >= (this.config.flipThresholdPct || 0)) {
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
        else if (roi <= -(this.config.dcaRoiThresholdPct) && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.scalePosition(false);
        else if (roi >= this.config.profitRoiThresholdPct && Date.now() - (pos.lastDcaTime || 0) > 10000) await this.scalePosition(true);
    }
    async openPosition(side) {
        this.isTrading = true;
        try {
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            let price = side === 'long' ? globalMarketData.binance.mid : globalMarketData.binance.mid;
            let qty = Math.max(1, Math.floor(this.walletBalance * 1));
            if (this.liveTradingEnabled) {
                const res = await ex.createMarketOrder(this.config.htxSymbol, side==='long'?'buy':'sell', qty, { offset: 'open' });
                price = res.average || price;
            }
            const size = qty * this.config.contractSize * price;
            this.activePositions = [{ side, entryPrice: price, contracts: qty, size, marginUsed: size/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, dcaStep: 0, isPaper: !this.liveTradingEnabled }];
            await this.saveState();
        } catch(e) { console.error("Open Error", e.message); } finally { this.isTrading = false; }
    }
    async scalePosition(isProfit) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const ex = pos.side === 'long' ? this.htxLong : this.htxShort;
            const mult = isProfit ? this.config.profitMultiplier : this.config.dcaMultiplier;
            const qty = Math.floor(pos.contracts * (mult - 1));
            if (qty < 1) return;
            if (isProfit && pos.contracts + qty > this.config.maxContracts) return;
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'buy':'sell', qty, { offset: 'open' });
            pos.contracts += qty; pos.lastDcaTime = Date.now(); pos.dcaStep++;
            await this.saveState();
        } catch(e) {} finally { this.isTrading = false; }
    }
    async closePosition(reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const ex = pos.side === 'long' ? this.htxLong : this.htxShort;
            if (this.liveTradingEnabled) await ex.createMarketOrder(this.config.htxSymbol, pos.side==='long'?'sell':'buy', pos.contracts, { reduceOnly: true, offset: 'close' });
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.processTrade({ ...math, side: pos.side, contracts: pos.contracts, exitReason: reason });
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
                        if (p) { this.activePositions[0].exchangeROI = p.percentage; this.activePositions[0].entryPrice = p.entryPrice; }
                        else this.activePositions = [];
                    }
                } catch(e){}
            }
        }, 2000);
    }
    getExport() { return { config: this.config, metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, walletBalance: this.walletBalance, liveTradingEnabled: this.liveTradingEnabled }; }
}

// ==================== MASTER CONTROLLER ====================
const workers = new Map();
async function masterLoop() {
    await publicBinance.loadMarkets();
    (async function stream() {
        while(true) {
            try {
                const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance = { mid: (t.bid + t.ask) / 2, timestamp: Date.now() };
                globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
                if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                for (const w of workers.values()) { w.evaluateAIEntry(); w.checkExits(); }
            } catch(e){}
            await new Promise(r => setTimeout(r, 1000));
        }
    })();
}

// ==================== API ROUTES ====================
const app = express(); app.use(express.json());
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
    const w = new UserTradeInstance(user); await w.initialize(); workers.set(user._id.toString(), w);
    tokenCache.set(user.token, { user }); res.json({ token: user.token });
});
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save();
        const w = new UserTradeInstance(user); await w.initialize(); workers.set(user._id.toString(), w);
        tokenCache.set(user.token, { user }); res.json({ token: user.token });
    } else res.status(401).send();
});
app.get('/api/data', authMiddleware, (req, res) => res.json(workers.get(req.user._id.toString())?.getExport() || {}));
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    Object.assign(req.user, req.body); await req.user.save();
    w.applyUserKeys(req.user); res.json({ status: 'ok' });
});
app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    Object.assign(w.config, req.body); req.user.config = w.config; 
    req.user.markModified('config'); await req.user.save(); res.json({ status: 'ok' });
});

// ==================== UI HTML ====================
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
        input, select { background: #1a1a1a; border: 1px solid #333; color: #fff; padding: 8px; border-radius: 4px; width: 100%; }
        .btn { background: #fff; color: #000; font-weight: bold; padding: 10px; border-radius: 6px; cursor: pointer; text-align: center; }
        .btn-red { background: #ef4444; color: #fff; }
    </style>
</head>
<body class="p-4 max-w-7xl mx-auto">
    <div id="auth-view" class="max-w-md mx-auto mt-20">
        <div class="card space-y-4">
            <h2 class="text-xl font-bold">Terminal Access</h2>
            <input id="email" placeholder="Email">
            <input id="pass" type="password" placeholder="Password">
            <div class="btn" onclick="login()">Enter Terminal</div>
        </div>
    </div>

    <div id="dash-view" class="hidden space-y-6">
        <div class="grid grid-cols-4 gap-4">
            <div class="card"><div class="text-xs text-gray-500">NET PNL</div><div id="net-pnl" class="text-xl font-bold">$0.00</div></div>
            <div class="card"><div class="text-xs text-gray-500">LIVE ROI</div><div id="live-roi" class="text-xl font-bold">0.00%</div></div>
            <div class="card"><div class="text-xs text-gray-500">TOTAL BALANCE</div><div id="balance" class="text-xl font-bold">$0.00</div></div>
            <div class="card"><div class="text-xs text-gray-500">AI SIGNAL</div><div id="ai-sig" class="text-xl font-bold">WAITING</div></div>
        </div>

        <div class="grid grid-cols-3 gap-6">
            <div class="col-span-2 space-y-6">
                <div class="card">
                    <h3 class="font-bold mb-4">Closed Trade History</h3>
                    <table class="w-full text-xs text-left">
                        <thead class="text-gray-500 uppercase"><tr><th>Time</th><th>Side</th><th>Reason</th><th>Net PnL</th></tr></thead>
                        <tbody id="trade-history"></tbody>
                    </table>
                </div>
            </div>
            <div class="space-y-6">
                <div class="card space-y-4">
                    <h3 class="font-bold">Hedge API Setup</h3>
                    <div class="flex items-center gap-2 mb-2"><input type="checkbox" id="live-on" class="w-4 h-4"> Enable Live</div>
                    <div class="text-[10px] text-green-500 font-bold">ACCOUNT 1 (LONG)</div>
                    <input id="key1" type="password" placeholder="API Key">
                    <input id="sec1" type="password" placeholder="API Secret">
                    <div class="text-[10px] text-red-500 font-bold">ACCOUNT 2 (SHORT)</div>
                    <input id="key2" type="password" placeholder="API Key">
                    <input id="sec2" type="password" placeholder="API Secret">
                    <div class="btn" onclick="saveKeys()">Update Keys</div>
                </div>
                <div class="card space-y-4">
                    <h3 class="font-bold">DCA & AI Strategy</h3>
                    <div class="grid grid-cols-2 gap-2 text-[10px]">
                        <div>TP %<input id="s-tp"></div>
                        <div>SL %<input id="s-sl"></div>
                        <div>DCA Threshold<input id="s-dca-t"></div>
                        <div>DCA Multiplier<input id="s-dca-m"></div>
                        <div>Lookback<input id="s-look"></div>
                        <div>Threshold %<input id="s-ml-t"></div>
                    </div>
                    <div class="btn" onclick="saveConfig()">Save Strategy</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('token');
        async function api(path, method='GET', body=null) {
            const res = await fetch(path, { method, headers: {'Content-Type':'application/json', 'Authorization':token}, body: body?JSON.stringify(body):null });
            return res.json();
        }
        async function login() {
            const res = await api('/api/auth/login', 'POST', {email:document.getElementById('email').value, password:document.getElementById('pass').value});
            if(res.token) { token=res.token; localStorage.setItem('token', token); location.reload(); }
        }
        async function saveKeys() {
            await api('/api/user/keys', 'POST', {apiKey:document.getElementById('key1').value, apiSecret:document.getElementById('sec1').value, apiKey2:document.getElementById('key2').value, apiSecret2:document.getElementById('sec2').value, liveTradingEnabled:document.getElementById('live-on').checked});
            alert('Keys Updated');
        }
        async function saveConfig() {
            await api('/api/user/config', 'POST', {takeProfitPct:parseFloat(document.getElementById('s-tp').value), stopLossPct:parseFloat(document.getElementById('s-sl').value), dcaRoiThresholdPct:parseFloat(document.getElementById('s-dca-t').value), dcaMultiplier:parseFloat(document.getElementById('s-dca-m').value), mlLookback:parseInt(document.getElementById('s-look').value), mlThreshold:parseFloat(document.getElementById('s-ml-t').value)});
            alert('Config Saved');
        }
        if(token) {
            document.getElementById('auth-view').style.display='none';
            document.getElementById('dash-view').style.display='block';
            setInterval(async () => {
                const d = await api('/api/data');
                document.getElementById('net-pnl').innerText = '$' + d.metrics.totalNetPnl.toFixed(2);
                document.getElementById('balance').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('ai-sig').innerText = d.mlSignal.confidence.toFixed(1) + '% ' + d.mlSignal.type.toUpperCase();
                document.getElementById('live-roi').innerText = (d.activePositions[0]?.exchangeROI || 0).toFixed(2) + '%';
                
                const h = document.getElementById('trade-history'); h.innerHTML = '';
                d.metrics.trades.reverse().forEach(t => {
                    h.innerHTML += '<tr><td>'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="'+(t.side==='long'?'text-green-500':'text-red-500')+'">'+t.side.toUpperCase()+'</td><td>'+t.exitReason+'</td><td>$'+t.netPnl.toFixed(2)+'</td></tr>';
                });
            }, 1000);
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => { await masterLoop(); console.log('Hedge Server Online'); });
