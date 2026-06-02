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
    apiSecret: { type: String, default: "" },
    apiKey2: { type: String, default: "" },     // Account 2 (Shorts)
    apiSecret2: { type: String, default: "" },
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    activePositionLong: { type: Object, default: null }, 
    activePositionShort: { type: Object, default: null },
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, netPnl: Number, roiPct: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, 
    baseContracts: 1, 
    contractSize: 1000, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    dcaRoiThresholdPct: 1.0, 
    dcaMultiplier: 2.0, 
    maxContracts: 500
};

const globalMarketData = { binance: { mid: 0 } };
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// ==================== SECURITY ====================
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
        userEntry = { user }; tokenCache.set(token, userEntry);
    }
    req.user = userEntry.user;
    next();
}

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const netPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    return { netPnlUsd, roiPct: grossPnlPercent * leverage, margin };
}

// ==================== HEDGED USER INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activeLong = user.activePositionLong || null;
        this.activeShort = user.activePositionShort || null;
        this.isTrading = false;
        this.balances = { longAcc: 0, shortAcc: 0 };
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        const opt = { agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } };
        this.htxLong = new ccxt.pro.htx({ apiKey: user.apiKey, secret: user.apiSecret, ...opt });
        this.htxShort = new ccxt.pro.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opt });
    }

    async initialize() {
        if (this.liveTradingEnabled) {
            try { await this.htxLong.loadMarkets(); await this.htxShort.loadMarkets(); } catch(e){}
        }
        this.startSync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePositionLong: this.activeLong, activePositionShort: this.activeShort, config: this.config } });
    }

    async startHedge() {
        if (this.isTrading) return;
        if (!this.activeLong) await this.openPosition('long');
        if (!this.activeShort) await this.openPosition('short');
    }

    async openPosition(side) {
        this.isTrading = true;
        try {
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            const qty = this.config.baseContracts;
            if (this.liveTradingEnabled) {
                await ex.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', qty);
            }
            const price = globalMarketData.binance.mid;
            const size = qty * this.config.contractSize * price;
            const pos = { side, entryPrice: price, contracts: qty, size, marginUsed: size/FORCED_LEVERAGE, entryTime: Date.now(), exchangeROI: 0, lastDcaTime: 0 };
            if (side === 'long') this.activeLong = pos; else this.activeShort = pos;
            await this.saveState();
        } catch(e) { console.log("Open Error:", e.message); } finally { this.isTrading = false; }
    }

    async checkExitsAndDca() {
        if (this.isTrading) return;
        const legs = [this.activeLong, this.activeShort];
        for (let pos of legs) {
            if (!pos) continue;
            const roi = pos.exchangeROI || 0;
            
            // TAKE PROFIT / STOP LOSS
            if (roi >= this.config.takeProfitPct) await this.closePosition(pos.side, "TAKE_PROFIT");
            else if (roi <= this.config.stopLossPct) await this.closePosition(pos.side, "STOP_LOSS");
            
            // DCA
            else if (roi <= -(Math.abs(this.config.dcaRoiThresholdPct)) && (Date.now() - (pos.lastDcaTime || 0) > 30000)) {
                await this.dcaPosition(pos.side);
            }
        }
    }

    async dcaPosition(side) {
        this.isTrading = true;
        try {
            const pos = side === 'long' ? this.activeLong : this.activeShort;
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            const qtyToAdd = Math.max(1, Math.floor(pos.contracts * (this.config.dcaMultiplier - 1)));
            
            if (pos.contracts + qtyToAdd > this.config.maxContracts) return;

            if (this.liveTradingEnabled) {
                await ex.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', qtyToAdd);
            }

            const currentPrice = globalMarketData.binance.mid;
            const oldTotalCost = pos.entryPrice * pos.contracts;
            const newTotalCost = oldTotalCost + (currentPrice * qtyToAdd);
            
            pos.contracts += qtyToAdd;
            pos.entryPrice = newTotalCost / pos.contracts;
            pos.size = pos.contracts * this.config.contractSize * pos.entryPrice;
            pos.lastDcaTime = Date.now();
            await this.saveState();
        } catch(e){} finally { this.isTrading = false; }
    }

    async closePosition(side, reason) {
        this.isTrading = true;
        try {
            const pos = side === 'long' ? this.activeLong : this.activeShort;
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            if (this.liveTradingEnabled) {
                await ex.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'sell' : 'buy', pos.contracts, { reduceOnly: true });
            }
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, 75);
            await TradeModel.create({ userId: this.userId, side: pos.side, contracts: pos.contracts, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, netPnl: math.netPnlUsd, roiPct: math.roiPct, exitReason: reason });
            
            if (side === 'long') this.activeLong = null; else this.activeShort = null;
            await this.saveState();
            // Automatically reopen leg to maintain hedge
            setTimeout(() => this.openPosition(side), 5000);
        } catch(e) {} finally { this.isTrading = false; }
    }

    startSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const b1 = await this.htxLong.fetchBalance({ type: 'swap' });
                    const b2 = await this.htxShort.fetchBalance({ type: 'swap' });
                    this.balances = { longAcc: b1.total?.USDT || 0, shortAcc: b2.total?.USDT || 0 };
                    
                    if (this.activeLong) {
                        const p = (await this.htxLong.fetchPositions([this.config.htxSymbol])).find(x => x.side === 'long' && x.contracts > 0);
                        if (p) this.activeLong.exchangeROI = p.percentage;
                    }
                    if (this.activeShort) {
                        const p = (await this.htxShort.fetchPositions([this.config.htxSymbol])).find(x => x.side === 'short' && x.contracts > 0);
                        if (p) this.activeShort.exchangeROI = p.percentage;
                    }
                } catch(e){}
            }
        }, 2000);
    }
}

// ==================== CONTROLLER ====================
const workers = new Map();
async function masterLoop() {
    (async function stream() {
        while(true) {
            try {
                const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance.mid = (t.bid + t.ask) / 2;
                for (const w of workers.values()) { w.checkExitsAndDca(); }
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
    res.json({ config: w.config, metrics: { trades }, activeLong: w.activeLong, activeShort: w.activeShort, balances: w.balances, liveTradingEnabled: w.liveTradingEnabled });
});
app.post('/api/user/keys', authMiddleware, async (req, res) => {
    Object.assign(req.user, req.body); await req.user.save();
    workers.get(req.user._id.toString()).applyUserKeys(req.user); res.json({status:'ok'});
});
app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString()); Object.assign(w.config, req.body);
    req.user.config = w.config; req.user.markModified('config'); await req.user.save(); res.json({status:'ok'});
});
app.get('/api/start-hedge', authMiddleware, async (req, res) => { await workers.get(req.user._id.toString()).startHedge(); res.json({status:'ok'}); });
app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const w = workers.get(req.user._id.toString());
    if (w.activeLong) await w.closePosition('long', "MANUAL");
    if (w.activeShort) await w.closePosition('short', "MANUAL");
    res.json({status:'ok'}); 
});

// ==================== DASHBOARD UI ====================
app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBotPille | Constant Hedge</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700&family=Roboto+Mono&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        body { font-family: 'Roboto', sans-serif; background-color: #fafafa; color: #111827; }
        .ui-card { background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); border: 1px solid #f0f0f0; padding: 24px; }
        .input-minimal { width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 14px; outline: none; background: #fafafa; }
        .btn-black { background: #000; color: #fff; border-radius: 8px; padding: 12px; font-weight: 500; text-align: center; width: 100%; cursor: pointer; }
        .view-section { display: none; } .active-view { display: block; }
    </style>
</head>
<body class="antialiased min-h-screen flex flex-col">
    <header class="bg-white border-b h-16 flex items-center px-8 justify-between sticky top-0 z-50">
        <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-black text-3xl">api</span>
            <span class="font-bold text-xl tracking-tight">TradeBotPille</span>
        </div>
        <div id="nav-private" class="hidden flex items-center gap-6 text-sm font-medium">
            <button onclick="nav('dashboard')" class="text-gray-500 hover:text-black">Dashboard</button>
            <button onclick="logout()" class="text-red-500">Logout</button>
        </div>
    </header>

    <main class="flex-grow p-8">
        <section id="view-home" class="view-section active-view max-w-md mx-auto py-20">
            <div class="ui-card">
                <h2 class="text-2xl font-bold mb-6 text-center">Login to Terminal</h2>
                <div class="space-y-4">
                    <input type="email" id="email" placeholder="Email" class="input-minimal">
                    <input type="password" id="pass" placeholder="Password" class="input-minimal">
                    <button onclick="login()" class="btn-black">Access Terminal</button>
                </div>
            </div>
        </section>

        <section id="view-dashboard" class="view-section max-w-7xl mx-auto">
            <div class="flex justify-between items-center mb-8">
                <h2 class="text-2xl font-bold">Hedge Terminal</h2>
                <div class="flex gap-3">
                    <button onclick="startHedge()" class="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-bold">Start Hedge</button>
                    <button onclick="nav('settings')" class="px-4 py-2 bg-white border rounded-md text-sm font-bold">API Setup</button>
                    <button onclick="closeAll()" class="px-4 py-2 bg-red-50 text-red-600 rounded-md text-sm font-bold">Emergency Stop</button>
                </div>
            </div>

            <div class="grid lg:grid-cols-2 gap-8 mb-8">
                <!-- ACCOUNT 1 -->
                <div class="ui-card border-t-4 border-green-500">
                    <h3 class="font-bold text-green-600 mb-4">ACCOUNT 1 (LONG LEG)</h3>
                    <div class="grid grid-cols-3 gap-4">
                        <div><p class="text-[10px] text-gray-400">BALANCE</p><p id="bal1" class="font-mono font-bold">$0.00</p></div>
                        <div><p class="text-[10px] text-gray-400">VOLUME</p><p id="vol1" class="font-mono font-bold">0</p></div>
                        <div><p class="text-[10px] text-gray-400">ROI</p><p id="roi1" class="font-mono font-bold">0.00%</p></div>
                    </div>
                </div>
                <!-- ACCOUNT 2 -->
                <div class="ui-card border-t-4 border-red-500">
                    <h3 class="font-bold text-red-600 mb-4">ACCOUNT 2 (SHORT LEG)</h3>
                    <div class="grid grid-cols-3 gap-4">
                        <div><p class="text-[10px] text-gray-400">BALANCE</p><p id="bal2" class="font-mono font-bold">$0.00</p></div>
                        <div><p class="text-[10px] text-gray-400">VOLUME</p><p id="vol2" class="font-mono font-bold">0</p></div>
                        <div><p class="text-[10px] text-gray-400">ROI</p><p id="roi2" class="font-mono font-bold">0.00%</p></div>
                    </div>
                </div>
            </div>

            <div class="grid lg:grid-cols-12 gap-8">
                <div class="lg:col-span-8 ui-card">
                    <h3 class="font-bold mb-4 border-b pb-4">Recent Closed Trades</h3>
                    <table class="w-full text-sm text-left"><thead class="text-gray-400"><tr><th>Side</th><th>Reason</th><th>Qty</th><th class="text-right">PnL</th></tr></thead><tbody id="history" class="font-mono"></tbody></table>
                </div>
                <div class="lg:col-span-4 ui-card">
                    <h3 class="font-bold mb-4 border-b pb-4">DCA Settings</h3>
                    <div class="space-y-4 text-xs font-bold text-gray-500">
                        <div>Take Profit %<input id="s-tp" class="input-minimal mt-1 text-green-600"></div>
                        <div>DCA ROI Drop %<input id="s-dca-t" class="input-minimal mt-1"></div>
                        <div>DCA Multiplier<input id="s-dca-m" class="input-minimal mt-1"></div>
                        <div>Base Contracts<input id="s-base" class="input-minimal mt-1"></div>
                        <button onclick="saveConfig()" class="btn-black mt-4">Save Config</button>
                    </div>
                </div>
            </div>
        </section>

        <section id="view-settings" class="view-section max-w-lg mx-auto py-10">
            <div class="ui-card">
                <h3 class="text-xl font-bold mb-6">Dual Hedge API</h3>
                <div class="space-y-6">
                    <div class="flex items-center gap-2 mb-4"><input type="checkbox" id="liveTrade" class="w-4 h-4"> <label class="font-bold">Enable Live Trading</label></div>
                    <div class="p-4 bg-gray-50 rounded-lg border">
                        <p class="text-[10px] font-bold text-green-600 mb-2 uppercase">Account 1 (Primary)</p>
                        <input type="password" id="key1" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec1" placeholder="Secret Key" class="input-minimal">
                    </div>
                    <div class="p-4 bg-gray-50 rounded-lg border">
                        <p class="text-[10px] font-bold text-red-600 mb-2 uppercase">Account 2 (Secondary)</p>
                        <input type="password" id="key2" placeholder="API Key" class="input-minimal mb-2">
                        <input type="password" id="sec2" placeholder="Secret Key" class="input-minimal">
                    </div>
                    <button onclick="saveKeys()" class="btn-black">Update Hedge Keys</button>
                    <button onclick="nav('dashboard')" class="w-full text-sm mt-4 text-gray-400">Cancel</button>
                </div>
            </div>
        </section>
    </main>

    <script>
        let token = localStorage.getItem('token');
        async function api(path, method='GET', body=null) {
            const res = await fetch(path, { method, headers: {'Content-Type': 'application/json', 'Authorization': token}, body: body?JSON.stringify(body):null });
            return res.json();
        }
        function nav(id) { document.querySelectorAll('.view-section').forEach(s=>s.classList.remove('active-view')); document.getElementById('view-'+id).classList.add('active-view'); }
        async function login() { 
            const email = document.getElementById('email').value;
            const password = document.getElementById('pass').value;
            const res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password }) });
            const data = await res.json();
            if(data.token) { localStorage.setItem('token',data.token); location.reload(); } else { alert(data.error); }
        }
        function logout() { localStorage.removeItem('token'); location.reload(); }
        async function startHedge() { await api('/api/start-hedge'); }
        async function saveKeys() {
            await api('/api/user/keys', 'POST', { apiKey: document.getElementById('key1').value, apiSecret: document.getElementById('sec1').value, apiKey2: document.getElementById('key2').value, apiSecret2: document.getElementById('sec2').value, liveTradingEnabled: document.getElementById('liveTrade').checked });
            alert('Saved'); nav('dashboard');
        }
        async function saveConfig() {
            await api('/api/user/config', 'POST', { takeProfitPct: parseFloat(document.getElementById('s-tp').value), dcaRoiThresholdPct: parseFloat(document.getElementById('s-dca-t').value), dcaMultiplier: parseFloat(document.getElementById('s-dca-m').value), baseContracts: parseInt(document.getElementById('s-base').value) });
            alert('Saved');
        }
        async function closeAll() { if(confirm('Emergency Stop?')) await api('/api/close-all'); }
        
        if(token) {
            document.getElementById('nav-private').classList.remove('hidden'); nav('dashboard');
            setInterval(async () => {
                const d = await api('/api/data');
                document.getElementById('bal1').innerText = '$'+(d.balances?.longAcc || 0).toFixed(2);
                document.getElementById('bal2').innerText = '$'+(d.balances?.shortAcc || 0).toFixed(2);
                document.getElementById('roi1').innerText = (d.activeLong?.exchangeROI || 0).toFixed(2)+'%';
                document.getElementById('roi2').innerText = (d.activeShort?.exchangeROI || 0).toFixed(2)+'%';
                document.getElementById('vol1').innerText = d.activeLong?.contracts || 0;
                document.getElementById('vol2').innerText = d.activeShort?.contracts || 0;
                
                const h = document.getElementById('history'); h.innerHTML = '';
                d.metrics.trades.forEach(t => {
                    h.innerHTML += '<tr class="border-b"><td class="py-3 '+(t.side==='long'?'text-green-600':'text-red-600')+' font-bold">'+t.side.toUpperCase()+'</td><td class="text-xs text-gray-400 uppercase">'+t.exitReason+'</td><td>'+t.contracts+'</td><td class="text-right font-bold '+(t.netPnl>=0?'text-green-600':'text-red-600')+'">$'+t.netPnl.toFixed(2)+'</td></tr>';
                });

                if(!document.getElementById('s-tp').value) {
                    document.getElementById('s-tp').value = d.config.takeProfitPct; document.getElementById('s-dca-t').value = d.config.dcaRoiThresholdPct;
                    document.getElementById('s-dca-m').value = d.config.dcaMultiplier; document.getElementById('s-base').value = d.config.baseContracts;
                    document.getElementById('liveTrade').checked = d.liveTradingEnabled;
                }
            }, 1000);
        }
    </script>
</body>
</html>
`)});

app.listen(CUSTOM_PORT, async () => { await masterLoop(); console.log('Hedge Server Online'); });
