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
    activePositions: { type: Array, default: [] }, // Stores [{side, entry, qty...}]
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V4', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, netPnl: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

// ==================== BASE CONFIGURATION ====================
const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: 75, 
    baseContracts: 100, // Starting amount
    takeProfitPct: 5.0, 
    stopLossPct: -50.0, 
    dcaRoiThresholdPct: -10.0, // DCA when -10% ROI
    dcaMultiplier: 1.5,        // Increase size by 1.5x
    maxContracts: 50000
};

const globalMarketData = { binance: { mid: 0 } };
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    const user = await UserModel.findOne({ token });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
}

// ==================== HEDGED USER INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePositions || [];
        this.isTrading = false;
        this.balances = { long: 0, short: 0 };
        this.livePositions = { long: { roi: 0, contracts: 0 }, short: { roi: 0, contracts: 0 } };
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled;
        const opt = { agent: keepAliveAgent, options: { defaultType: 'swap', positionMode: 'hedged' } };
        this.htxLong = new ccxt.pro.htx({ apiKey: user.apiKey, secret: user.apiSecret, ...opt });
        this.htxShort = new ccxt.pro.htx({ apiKey: user.apiKey2, secret: user.apiSecret2, ...opt });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePositions: this.activePositions, config: this.config } });
    }

    // Opens both Long and Short at once
    async openHedge() {
        if (this.isTrading) return;
        this.isTrading = true;
        try {
            await this.executeOrder('long', 'buy', this.config.baseContracts);
            await this.executeOrder('short', 'sell', this.config.baseContracts);
            await this.saveState();
        } catch(e) { console.error("Entry Error", e); }
        this.isTrading = false;
    }

    async executeOrder(side, type, qty) {
        const ex = side === 'long' ? this.htxLong : this.htxShort;
        if (this.liveTradingEnabled) {
            await ex.createMarketOrder(this.config.htxSymbol, type, qty, { offset: 'open' });
        }
        // Logic to track internal state
        const existing = this.activePositions.find(p => p.side === side);
        if (existing) {
            existing.contracts += qty;
        } else {
            this.activePositions.push({ side, entryPrice: globalMarketData.binance.mid, contracts: qty });
        }
    }

    async checkDCAAndExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        
        for (const pos of this.activePositions) {
            const sideData = pos.side === 'long' ? this.livePositions.long : this.livePositions.short;
            const roi = sideData.roi;

            // 1. Take Profit / Stop Loss
            if (roi >= this.config.takeProfitPct || roi <= this.config.stopLossPct) {
                await this.closeSide(pos.side, roi >= this.config.takeProfitPct ? "TP" : "SL");
            } 
            // 2. DCA Logic
            else if (roi <= this.config.dcaRoiThresholdPct) {
                const dcaQty = pos.contracts * (this.config.dcaMultiplier - 1);
                if (pos.contracts + dcaQty <= this.config.maxContracts) {
                    console.log(`DCA Triggered for ${pos.side}`);
                    await this.executeOrder(pos.side, pos.side === 'long' ? 'buy' : 'sell', dcaQty);
                }
            }
        }
    }

    async closeSide(side, reason) {
        this.isTrading = true;
        try {
            const pos = this.activePositions.find(p => p.side === side);
            if (!pos) return;
            const ex = side === 'long' ? this.htxLong : this.htxShort;
            if (this.liveTradingEnabled) {
                await ex.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'sell' : 'buy', pos.contracts, { reduceOnly: true, offset: 'close' });
            }
            await TradeModel.create({ userId: this.userId, side, contracts: pos.contracts, exitReason: reason, netPnl: 0 }); // Pnl calculation simplified
            this.activePositions = this.activePositions.filter(p => p.side !== side);
            await this.saveState();
        } catch(e) { console.error("Close Error", e); }
        this.isTrading = false;
    }

    startSync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const [b1, b2] = await Promise.all([this.htxLong.fetchBalance({type:'swap'}), this.htxShort.fetchBalance({type:'swap'})]);
                    this.balances = { long: b1.total.USDT || 0, short: b2.total.USDT || 0 };
                    
                    const [p1, p2] = await Promise.all([
                        this.htxLong.fetchPositions([this.config.htxSymbol]),
                        this.htxShort.fetchPositions([this.config.htxSymbol])
                    ]);

                    const lp = p1.find(x => x.contracts > 0);
                    const sp = p2.find(x => x.contracts > 0);

                    this.livePositions.long = lp ? { roi: lp.percentage, contracts: lp.contracts } : { roi: 0, contracts: 0 };
                    this.livePositions.short = sp ? { roi: sp.percentage, contracts: sp.contracts } : { roi: 0, contracts: 0 };
                    
                    // Sync activePositions array with exchange reality
                    if (!lp && !sp) this.activePositions = [];
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
                for (const w of workers.values()) { w.checkDCAAndExits(); }
            } catch(e){}
            await new Promise(r => setTimeout(r, 2000));
        }
    })();
}

// ==================== API ENDPOINTS ====================
const app = express(); app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hashPassword(req.body.password, user.salt) === user.passwordHash) {
        user.token = generateToken(); await user.save();
        if(!workers.has(user._id.toString())) { 
            const w = new UserTradeInstance(user); w.startSync(); workers.set(user._id.toString(), w); 
        }
        res.json({ token: user.token });
    } else res.status(401).json({ error: 'Invalid Credentials' });
});

app.get('/api/data', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    const trades = await TradeModel.find({ userId: req.user._id.toString() }).sort({ timestamp: -1 }).limit(10);
    res.json({ config: w.config, live: w.livePositions, balances: w.balances, trades, liveTradingEnabled: w.liveTradingEnabled });
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString()); 
    Object.assign(w.config, req.body);
    req.user.config = w.config; req.user.markModified('config'); 
    await req.user.save(); res.json({status:'ok'});
});

app.get('/api/open-hedge', authMiddleware, async (req, res) => {
    await workers.get(req.user._id.toString()).openHedge();
    res.json({status:'ok'});
});

app.get('/api/close-all', authMiddleware, async (req, res) => {
    const w = workers.get(req.user._id.toString());
    await w.closeSide('long', 'MANUAL'); await w.closeSide('short', 'MANUAL');
    res.json({status:'ok'});
});

// ==================== UI DASHBOARD ====================
app.get('/', (req, res) => { res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Hedge DCA Terminal</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #fafafa; color: #111; }
        .card { background: white; border: 1px solid #eee; border-radius: 12px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
        .input { border: 1px solid #ddd; padding: 8px; border-radius: 6px; width: 100%; font-size: 13px; }
        .label { font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; margin-bottom: 4px; display: block; }
    </style>
</head>
<body class="p-8">
    <div id="auth" class="max-w-sm mx-auto mt-20 card">
        <h2 class="text-xl font-bold mb-4">Hedge Login</h2>
        <input id="email" placeholder="Email" class="input mb-2">
        <input id="pass" type="password" placeholder="Password" class="input mb-4">
        <button onclick="login()" class="w-full bg-black text-white p-3 rounded-lg font-bold">Enter Terminal</button>
    </div>

    <div id="dash" class="hidden max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold">Hedge Terminal</h1>
            <div class="flex gap-4">
                <button onclick="openHedge()" class="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold text-sm">Open New Hedge</button>
                <button onclick="closeAll()" class="bg-red-500 text-white px-6 py-2 rounded-lg font-bold text-sm">Close All</button>
                <button onclick="logout()" class="text-gray-400 text-sm">Logout</button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div class="card">
                <p class="label">Long Account (Primary)</p>
                <div class="flex justify-between items-end">
                    <div>
                        <p id="l-bal" class="text-2xl font-bold">$0.00</p>
                        <p id="l-roi" class="text-lg font-semibold text-green-500">0.00%</p>
                    </div>
                    <div class="text-right">
                        <p class="label">Volume Contracts</p>
                        <p id="l-vol" class="font-mono font-bold">0</p>
                    </div>
                </div>
            </div>
            <div class="card">
                <p class="label">Short Account (Secondary)</p>
                <div class="flex justify-between items-end">
                    <div>
                        <p id="s-bal" class="text-2xl font-bold">$0.00</p>
                        <p id="s-roi" class="text-lg font-semibold text-red-500">0.00%</p>
                    </div>
                    <div class="text-right">
                        <p class="label">Volume Contracts</p>
                        <p id="s-vol" class="font-mono font-bold">0</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-6">
            <div class="card col-span-2">
                <h3 class="font-bold mb-4 border-b pb-2">DCA Strategy Settings</h3>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="label">Take Profit %</label>
                        <input id="cfg-tp" class="input">
                    </div>
                    <div>
                        <label class="label">Stop Loss %</label>
                        <input id="cfg-sl" class="input">
                    </div>
                    <div>
                        <label class="label">DCA Trigger (ROI %)</label>
                        <input id="cfg-dca-t" class="input" placeholder="e.g. -10">
                    </div>
                    <div>
                        <label class="label">DCA Multiplier</label>
                        <input id="cfg-dca-m" class="input" placeholder="e.g. 2.0">
                    </div>
                </div>
                <button onclick="saveConfig()" class="mt-4 w-full bg-gray-100 p-2 rounded font-bold text-sm hover:bg-gray-200">Update DCA Parameters</button>
            </div>
            
            <div class="card">
                <h3 class="font-bold mb-4 border-b pb-2">Recent Logs</h3>
                <div id="logs" class="text-xs space-y-2 font-mono"></div>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('token');
        async function login() {
            const res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:document.getElementById('email').value, password:document.getElementById('pass').value}) });
            const d = await res.json();
            if(d.token) { localStorage.setItem('token', d.token); location.reload(); }
        }
        function logout() { localStorage.removeItem('token'); location.reload(); }

        async function openHedge() { await fetch('/api/open-hedge', { headers:{'Authorization':token} }); }
        async function closeAll() { await fetch('/api/close-all', { headers:{'Authorization':token} }); }
        
        async function saveConfig() {
            const body = { 
                takeProfitPct: parseFloat(document.getElementById('cfg-tp').value),
                stopLossPct: parseFloat(document.getElementById('cfg-sl').value),
                dcaRoiThresholdPct: parseFloat(document.getElementById('cfg-dca-t').value),
                dcaMultiplier: parseFloat(document.getElementById('cfg-dca-m').value)
            };
            await fetch('/api/user/config', { method:'POST', headers:{'Content-Type':'application/json','Authorization':token}, body:JSON.stringify(body) });
            alert('Config Saved');
        }

        if(token) {
            document.getElementById('auth').classList.add('hidden');
            document.getElementById('dash').classList.remove('hidden');
            setInterval(async () => {
                const res = await fetch('/api/data', { headers:{'Authorization':token} });
                const d = await res.json();
                
                document.getElementById('l-bal').innerText = '$' + d.balances.long.toFixed(2);
                document.getElementById('s-bal').innerText = '$' + d.balances.short.toFixed(2);
                document.getElementById('l-roi').innerText = d.live.long.roi.toFixed(2) + '%';
                document.getElementById('s-roi').innerText = d.live.short.roi.toFixed(2) + '%';
                document.getElementById('l-vol').innerText = d.live.long.contracts;
                document.getElementById('s-vol').innerText = d.live.short.contracts;

                if(!document.getElementById('cfg-tp').value) {
                    document.getElementById('cfg-tp').value = d.config.takeProfitPct;
                    document.getElementById('cfg-sl').value = d.config.stopLossPct;
                    document.getElementById('cfg-dca-t').value = d.config.dcaRoiThresholdPct;
                    document.getElementById('cfg-dca-m').value = d.config.dcaMultiplier;
                }

                const logDiv = document.getElementById('logs');
                logDiv.innerHTML = d.trades.map(t => \`<div class="border-b pb-1">\${t.side.toUpperCase()} | \${t.exitReason} | \${t.contracts} contracts</div>\`).join('');
            }, 2000);
        }
    </script>
</body>
</html>
`)});

app.listen(process.env.PORT || 3000, async () => { await masterLoop(); console.log('Hedge DCA Server Online'); });
