const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB Connected')).catch(err => console.error('🚨 DB Error:', err));

const UserModel = mongoose.model('User_V4', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },      
    apiSecret: { type: String, default: "" },
    apiKey2: { type: String, default: "" },     
    apiSecret2: { type: String, default: "" },
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    activePositions: { type: Array, default: [] }, 
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V4', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, netPnl: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: 75, baseContracts: 100, takeProfitPct: 5.0, stopLossPct: -50.0, dcaRoiThresholdPct: -10.0, dcaMultiplier: 1.5, maxContracts: 50000
};

const globalMarketData = { binance: { mid: 0 } };
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });
const workers = new Map();

function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    const user = await UserModel.findOne({ token });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    if (!workers.has(user._id.toString())) {
        const w = new UserTradeInstance(user); w.startSync(); workers.set(user._id.toString(), w);
    }
    next();
}

class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePositions || [];
        this.isTrading = false;
        this.balances = { long: 0, short: 0 };
        this.status = { long: 'Checking...', short: 'Checking...' };
        this.livePositions = { long: { roi: 0, contracts: 0 }, short: { roi: 0, contracts: 0 } };
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        const opt = { agent: keepAliveAgent, options: { defaultType: 'swap', positionMode: 'hedged' } };
        this.htxLong = new ccxt.htx({ apiKey: user.apiKey, secret: user.apiSecret, ...opt });
        this.htxShort = new ccxt.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opt });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePositions: this.activePositions, config: this.config } });
    }

    async openHedge() {
        if (this.isTrading) return; this.isTrading = true;
        try {
            await this.executeOrder('long', 'buy', this.config.baseContracts);
            await this.executeOrder('short', 'sell', this.config.baseContracts);
            await this.saveState();
        } catch(e) { console.error("Entry Error", e); }
        this.isTrading = false;
    }

    async executeOrder(side, type, qty) {
        const ex = side === 'long' ? this.htxLong : this.htxShort;
        if (this.liveTradingEnabled) { await ex.createMarketOrder(this.config.htxSymbol, type, qty, { offset: 'open' }); }
        const existing = this.activePositions.find(p => p.side === side);
        if (existing) { existing.contracts += qty; } else { this.activePositions.push({ side, entryPrice: globalMarketData.binance.mid, contracts: qty }); }
    }

    async checkDCAAndExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        for (const pos of this.activePositions) {
            const sideData = pos.side === 'long' ? this.livePositions.long : this.livePositions.short;
            if (sideData.roi >= this.config.takeProfitPct || sideData.roi <= this.config.stopLossPct) {
                await this.closeSide(pos.side, sideData.roi >= this.config.takeProfitPct ? "TP" : "SL");
            } else if (sideData.roi <= this.config.dcaRoiThresholdPct) {
                const dcaQty = pos.contracts * (this.config.dcaMultiplier - 1);
                if (pos.contracts + dcaQty <= this.config.maxContracts) await this.executeOrder(pos.side, pos.side === 'long' ? 'buy' : 'sell', dcaQty);
            }
        }
    }

    async closeSide(side, reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions.find(p => p.side === side);
            if (pos && this.liveTradingEnabled) {
                const ex = side === 'long' ? this.htxLong : this.htxShort;
                await ex.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'sell' : 'buy', pos.contracts, { reduceOnly: true, offset: 'close' });
            }
            this.activePositions = this.activePositions.filter(p => p.side !== side); await this.saveState();
        } catch(e) { console.error("Close Error", e); }
        this.isTrading = false;
    }

    startSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const [b1, b2] = await Promise.all([
                        this.htxLong.fetchBalance({type:'swap'}).catch(() => null),
                        this.htxShort.fetchBalance({type:'swap'}).catch(() => null)
                    ]);
                    if(b1) { this.balances.long = b1.total.USDT || 0; this.status.long = "Connected"; } else { this.status.long = "Auth Error"; }
                    if(b2) { this.balances.short = b2.total.USDT || 0; this.status.short = "Connected"; } else { this.status.short = "Auth Error"; }
                    const [p1, p2] = await Promise.all([this.htxLong.fetchPositions([this.config.htxSymbol]).catch(() => []), this.htxShort.fetchPositions([this.config.htxSymbol]).catch(() => [])]);
                    const lp = p1.find(x => x.contracts > 0); const sp = p2.find(x => x.contracts > 0);
                    this.livePositions.long = lp ? { roi: lp.percentage, contracts: lp.contracts } : { roi: 0, contracts: 0 };
                    this.livePositions.short = sp ? { roi: sp.percentage, contracts: sp.contracts } : { roi: 0, contracts: 0 };
                } catch(e){}
            } else { this.status = { long: "Live Mode Off", short: "Live Mode Off" }; }
        }, 2000);
    }
}

async function masterLoop() {
    (async function stream() {
        while(true) {
            try {
                const t = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol);
                globalMarketData.binance.mid = (t.bid + t.ask) / 2;
                for (const w of workers.values()) { w.checkDCAAndExits(); }
            } catch(e){}
            await new Promise(r => setTimeout(r, 2000));
        }
    })();
}

const app = express(); app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save(); res.json({ token: user.token });
    } else res.status(401).json({ error: 'Invalid Credentials' });
});

app.get('/api/data', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    const trades = await TradeModel.find({ userId: req.user._id.toString() }).sort({ timestamp: -1 }).limit(5);
    res.json({ config: w.config, live: w.livePositions, balances: w.balances, trades, status: w.status, liveTradingEnabled: req.user.liveTradingEnabled, keys: { k1: req.user.apiKey, k2: req.user.apiKey2 } });
});

app.post('/api/user/settings', authMiddleware, async (req, res) => {
    const u = req.user;
    if(req.body.apiKey !== undefined) u.apiKey = req.body.apiKey;
    if(req.body.apiSecret !== undefined) u.apiSecret = req.body.apiSecret;
    if(req.body.apiKey2 !== undefined) u.apiKey2 = req.body.apiKey2;
    if(req.body.apiSecret2 !== undefined) u.apiSecret2 = req.body.apiSecret2;
    if(req.body.liveTradingEnabled !== undefined) u.liveTradingEnabled = req.body.liveTradingEnabled;
    await u.save(); 
    const w = workers.get(u._id.toString()); w.applyUserKeys(u);
    res.json({status:'ok'});
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString()); Object.assign(w.config, req.body);
    req.user.config = w.config; req.user.markModified('config'); await req.user.save(); res.json({status:'ok'});
});

app.get('/api/open-hedge', authMiddleware, async (req, res) => { await workers.get(req.user._id.toString()).openHedge(); res.json({status:'ok'}); });
app.get('/api/close-all', authMiddleware, async (req, res) => { const w = workers.get(req.user._id.toString()); await w.closeSide('long', 'MANUAL'); await w.closeSide('short', 'MANUAL'); res.json({status:'ok'}); });

app.get('/', (req, res) => { res.send(`
<!DOCTYPE html><html><head><title>Hedge Terminal</title><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{font-family:'Inter',sans-serif;background:#fafafa;color:#111;}.card{background:white;border:1px solid #eee;border-radius:12px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.02);}.input{border:1px solid #ddd;padding:8px;border-radius:6px;width:100%;font-size:13px;}.label{font-size:11px;font-weight:700;color:888;text-transform:uppercase;margin-bottom:4px;display:block;}</style></head>
<body class="p-8">
    <div id="auth" class="max-w-sm mx-auto mt-20 card"><h2 class="text-xl font-bold mb-4">Hedge Login</h2><input id="email" placeholder="Email" class="input mb-2"><input id="pass" type="password" placeholder="Password" class="input mb-4"><button onclick="login()" class="w-full bg-black text-white p-3 rounded-lg font-bold">Enter Terminal</button></div>
    <div id="dash" class="hidden max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8"><h1 class="text-2xl font-bold">Hedge Terminal</h1><div class="flex gap-4"><button onclick="openHedge()" class="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold text-sm">Open New Hedge</button><button onclick="closeAll()" class="bg-red-500 text-white px-6 py-2 rounded-lg font-bold text-sm">Close All</button></div></div>
        <div class="grid grid-cols-2 gap-6 mb-6">
            <div class="card"><div class="flex justify-between"><p class="label">Long Account</p><span id="l-stat" class="text-[10px] font-bold uppercase px-2 rounded bg-gray-100"></span></div><p id="l-bal" class="text-2xl font-bold">$0.00</p><p id="l-roi" class="text-lg font-semibold text-green-500">0.00%</p><p class="label mt-2">Volume: <span id="l-vol">0</span></p></div>
            <div class="card"><div class="flex justify-between"><p class="label">Short Account</p><span id="s-stat" class="text-[10px] font-bold uppercase px-2 rounded bg-gray-100"></span></div><p id="s-bal" class="text-2xl font-bold">$0.00</p><p id="s-roi" class="text-lg font-semibold text-red-500">0.00%</p><p class="label mt-2">Volume: <span id="s-vol">0</span></p></div>
        </div>
        <div class="grid grid-cols-3 gap-6">
            <div class="card col-span-2">
                <h3 class="font-bold mb-4 border-b pb-2">API & Live System</h3>
                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div><label class="label">HTX API Key 1 (Long)</label><input id="set-k1" class="input" type="password"></div>
                    <div><label class="label">HTX Secret 1 (Long)</label><input id="set-s1" class="input" type="password"></div>
                    <div><label class="label">HTX API Key 2 (Short)</label><input id="set-k2" class="input" type="password"></div>
                    <div><label class="label">HTX Secret 2 (Short)</label><input id="set-s2" class="input" type="password"></div>
                </div>
                <div class="flex items-center gap-2 mb-4"><input type="checkbox" id="set-live"><label class="font-bold text-sm">Enable Live Trading (Balance Sync)</label></div>
                <button onclick="saveSettings()" class="w-full bg-blue-500 text-white p-2 rounded font-bold text-sm mb-6">Update API Keys & Mode</button>
                
                <h3 class="font-bold mb-4 border-b pb-2">Strategy Parameters</h3>
                <div class="grid grid-cols-4 gap-4">
                    <div><label class="label">TP %</label><input id="cfg-tp" class="input"></div>
                    <div><label class="label">SL %</label><input id="cfg-sl" class="input"></div>
                    <div><label class="label">DCA ROI %</label><input id="cfg-dca-t" class="input"></div>
                    <div><label class="label">DCA Mult</label><input id="cfg-dca-m" class="input"></div>
                </div>
                <button onclick="saveConfig()" class="mt-4 w-full bg-gray-100 p-2 rounded font-bold text-sm">Save Strategy</button>
            </div>
            <div class="card"><h3 class="font-bold mb-4 border-b pb-2">Logs</h3><div id="logs" class="text-xs space-y-2 font-mono"></div></div>
        </div>
    </div>
    <script>
        let token = localStorage.getItem('token');
        async function login(){ const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pass').value})}); const d=await res.json(); if(d.token){localStorage.setItem('token',d.token); location.reload();}}
        async function saveSettings(){
            const body = { apiKey: document.getElementById('set-k1').value, apiSecret: document.getElementById('set-s1').value, apiKey2: document.getElementById('set-k2').value, apiSecret2: document.getElementById('set-s2').value, liveTradingEnabled: document.getElementById('set-live').checked };
            await fetch('/api/user/settings',{method:'POST',headers:{'Content-Type':'application/json','Authorization':token},body:JSON.stringify(body)}); alert('Settings Updated');
        }
        async function saveConfig(){
            const body = { takeProfitPct:parseFloat(document.getElementById('cfg-tp').value), stopLossPct:parseFloat(document.getElementById('cfg-sl').value), dcaRoiThresholdPct:parseFloat(document.getElementById('cfg-dca-t').value), dcaMultiplier:parseFloat(document.getElementById('cfg-dca-m').value) };
            await fetch('/api/user/config',{method:'POST',headers:{'Content-Type':'application/json','Authorization':token},body:JSON.stringify(body)}); alert('Config Saved');
        }
        async function openHedge(){ await fetch('/api/open-hedge',{headers:{'Authorization':token}}); }
        async function closeAll(){ await fetch('/api/close-all',{headers:{'Authorization':token}}); }
        if(token){
            document.getElementById('auth').classList.add('hidden'); document.getElementById('dash').classList.remove('hidden');
            setInterval(async()=>{
                const res=await fetch('/api/data',{headers:{'Authorization':token}}); const d=await res.json();
                document.getElementById('l-bal').innerText='$'+d.balances.long.toFixed(2); document.getElementById('s-bal').innerText='$'+d.balances.short.toFixed(2);
                document.getElementById('l-roi').innerText=d.live.long.roi.toFixed(2)+'%'; document.getElementById('s-roi').innerText=d.live.short.roi.toFixed(2)+'%';
                document.getElementById('l-vol').innerText=d.live.long.contracts; document.getElementById('s-vol').innerText=d.live.short.contracts;
                document.getElementById('l-stat').innerText=d.status.long; document.getElementById('s-stat').innerText=d.status.short;
                if(!document.getElementById('cfg-tp').value){ 
                    document.getElementById('cfg-tp').value=d.config.takeProfitPct; document.getElementById('cfg-sl').value=d.config.stopLossPct; document.getElementById('cfg-dca-t').value=d.config.dcaRoiThresholdPct; document.getElementById('cfg-dca-m').value=d.config.dcaMultiplier;
                    document.getElementById('set-live').checked = d.liveTradingEnabled;
                }
            },2000);
        }
    </script>
</body></html>`)});

app.listen(process.env.PORT || 3000, async () => { await masterLoop(); console.log('Hedge DCA Server Online'); });
