const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== DB CONFIG (PRESERVING USERS) ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ Quantitative Engine Linked to MongoDB'))
    .catch(err => console.error('🚨 Connection Error:', err));

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
    contracts: Number, netPnl: Number, exitReason: String, timestamp: { type: Date, default: Date.now }
}));

// ==================== INSTITUTIONAL BASE CONFIG ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const HTX_SYMBOL = 'SHIB/USDT:USDT'; 
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    takeProfitPct: 25.0,
    stopLossPct: -50.0,
    riskPercent: 1.0,           // Risk 1% of equity per trade
    atrMultiplier: 5,           // ATR-based Volatility Stop distance
    minVwapDeviation: 0.2       // Price must be 0.2% away from fair value to enter
};

// GLOBAL MARKET STATE
const ALPHA_STATE = {
    mid: 0, vwap: 0, atr: 0, rsi: 50, ema: 0,
    prices: [], volumes: [], lookback: 150 
};

const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// QUANTITATIVE CALCULATION ENGINE
function calculateAlphaMetrics(prices, volumes) {
    if (prices.length < 50) return;
    let totalValue = 0, totalVol = 0, tr = 0;
    prices.forEach((p, i) => { totalValue += p * volumes[i]; totalVol += volumes[i]; });
    ALPHA_STATE.vwap = totalValue / (totalVol || 1);
    for (let i = 1; i < prices.length; i++) tr += Math.abs(prices[i] - prices[i-1]);
    ALPHA_STATE.atr = tr / prices.length;
    const k = 2 / (50 + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = (prices[i] * k) + (ema * (1 - k));
    ALPHA_STATE.ema = ema;
    let up = 0, down = 0;
    for (let i = prices.length - 14; i < prices.length; i++) {
        let diff = prices[i] - prices[i-1];
        if (diff >= 0) up += diff; else down -= diff;
    }
    ALPHA_STATE.rsi = 100 - (100 / (1 + (up / (down || 1))));
    ALPHA_STATE.mid = prices[prices.length - 1];
}

// ==================== HTX.COM EXPERT INSTANCE ====================
class ExpertAlphaInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.config = { ...BASE_CONFIG, ...(user.config || {}) };
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.walletBalance = 0;
        this.isExecuting = false;
        this.lastCloseTime = user.lastCloseTime || 0;

        this.htx = new ccxt.pro.htx({ 
            apiKey: user.apiKey, secret: user.apiSecret, agent: keepAliveAgent,
            options: { defaultType: 'swap', defaultSubType: 'linear' }
        });
    }

    async init() {
        if (this.htx.apiKey && this.htx.apiKey !== "") {
            try { 
                await this.htx.loadMarkets(); 
                this.syncExchange(); 
                setInterval(() => this.syncExchange(), 5000);
            } catch(e) {}
        }
    }

    async syncExchange() {
        if (!user.liveTradingEnabled) return;
        try {
            const bal = await this.htx.fetchBalance({ type: 'swap' });
            this.walletBalance = bal.total.USDT || 0;
            const positions = await this.htx.fetchPositions([HTX_SYMBOL]);
            const openPos = positions.find(p => p.contracts > 0);
            if (openPos) {
                if(!this.activePositions[0]) this.activePositions = [{}];
                this.activePositions[0] = { 
                    side: openPos.side, entryPrice: openPos.entryPrice, contracts: openPos.contracts, 
                    roi: openPos.percentage || 0, pnl: openPos.unrealizedPnl || 0 
                };
            } else { this.activePositions = []; }
        } catch (e) {}
    }

    async process() {
        if (this.isExecuting || ALPHA_STATE.mid === 0) return;
        const price = ALPHA_STATE.mid;
        const { vwap, atr, rsi, ema } = ALPHA_STATE;

        // ENTRY: Devation from fair value (Institutional Buy/Sell Zones)
        if (this.activePositions.length === 0 && (Date.now() - this.lastCloseTime > 15000)) {
            const undervalued = price < vwap * (1 - (this.config.minVwapDeviation/100)) && rsi < 35 && price > ema;
            const overextended = price > vwap * (1 + (this.config.minVwapDeviation/100)) && rsi > 65 && price < ema;

            if (undervalued) await this.executeEntry('long');
            else if (overextended) await this.executeEntry('short');
        }

        // RISK: Dynamic Volatility Trailing Stop
        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            const stopDist = atr * this.config.atrMultiplier;
            const stopPrice = pos.side === 'long' ? pos.entryPrice - stopDist : pos.entryPrice + stopDist;
            const isStopped = pos.side === 'long' ? price < stopPrice : price > stopPrice;

            if (isStopped) await this.executeClose('ATR_VOL_STOP');
            else if (pos.roi > this.config.takeProfitPct) await this.executeClose('INSTITUTIONAL_TP');
        }
    }

    async executeEntry(side) {
        this.isExecuting = true;
        try {
            const riskUsd = Math.max(1, this.walletBalance * (this.config.riskPercent / 100));
            const qty = Math.floor(riskUsd / (ALPHA_STATE.mid * 0.000001)); // Normalized for HTX SHIB size
            if (user.liveTradingEnabled) await this.htx.createMarketOrder(HTX_SYMBOL, side === 'long' ? 'buy' : 'sell', qty);
            this.activePositions = [{ side, entryPrice: ALPHA_STATE.mid, contracts: qty, entryTime: Date.now() }];
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] } });
        } catch(e) { console.error("HTX Order Failed:", e.message); }
        finally { this.isExecuting = false; }
    }

    async executeClose(reason) {
        this.isExecuting = true;
        try {
            const pos = this.activePositions[0];
            if (user.liveTradingEnabled) await this.htx.createMarketOrder(HTX_SYMBOL, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true });
            await TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: ALPHA_STATE.mid, contracts: pos.contracts, netPnl: pos.pnl || 0, exitReason: reason });
            this.activePositions = []; this.lastCloseTime = Date.now();
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: null, lastCloseTime: this.lastCloseTime } });
        } catch(e) {}
        finally { this.isExecuting = false; }
    }
}

// ==================== SYSTEM CORE ====================
const activeWorkers = new Map();
async function startAlphaSystem() {
    (async function streamMarket() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker('1000SHIB/USDT:USDT');
                const mid = (ticker.bid + ticker.ask) / 2;
                ALPHA_STATE.prices.push(mid);
                ALPHA_STATE.volumes.push(ticker.quoteVolume || 1);
                if (ALPHA_STATE.prices.length > ALPHA_STATE.lookback) { ALPHA_STATE.prices.shift(); ALPHA_STATE.volumes.shift(); }
                calculateAlphaMetrics(ALPHA_STATE.prices, ALPHA_STATE.volumes);
                for (const worker of activeWorkers.values()) { worker.process(); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPERT API & UI ====================
const app = express(); app.use(express.json());
const hash = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name: req.body.name, email: req.body.email, salt, passwordHash: hash(req.body.password, salt), token: crypto.randomBytes(32).toString('hex') });
    const worker = new ExpertAlphaInstance(user); await worker.init(); activeWorkers.set(user._id.toString(), worker);
    res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hash(req.body.password, user.salt) === user.passwordHash) {
        user.token = crypto.randomBytes(32).toString('hex'); await user.save();
        res.json({ token: user.token });
    } else res.status(401).json({ error: "Auth Error" });
});

app.get('/api/data', async (req, res) => {
    const user = await UserModel.findOne({ token: req.headers.authorization });
    if (!user) return res.status(401).send();
    let worker = activeWorkers.get(user._id.toString());
    if (!worker) { worker = new ExpertAlphaInstance(user); await worker.init(); activeWorkers.set(user._id.toString(), worker); }
    const trades = await TradeModel.find({ userId: user._id.toString() }).sort({ timestamp: -1 }).limit(10);
    res.json({ activePositions: worker.activePositions, balance: worker.walletBalance, market: ALPHA_STATE, trades });
});

app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>Quantum Expert HTX</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#050505] text-gray-200 font-sans">
    <nav class="h-16 border-b border-white/5 flex items-center justify-between px-10 bg-[#0a0a0a]">
        <div class="font-black text-xl tracking-tighter text-white">ALPHA<span class="text-blue-500">EXPERT</span></div>
        <div class="flex gap-6 text-xs font-bold uppercase text-gray-500">
            <button onclick="nav('login')">Sign In</button>
            <button onclick="nav('register')" class="bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-500">Deploy</button>
        </div>
    </nav>
    <main class="max-w-6xl mx-auto py-16 px-10">
        <section id="v-home" class="text-center">
            <h1 class="text-8xl font-black tracking-tighter mb-6 text-white">Quantitative Core.</h1>
            <p class="text-gray-500 text-lg max-w-2xl mx-auto leading-relaxed">High-Frequency SHIB Engine for HTX.com. Defined by VWAP Fair Value Discovery and ATR Volatility Risk Models.</p>
        </section>
        <section id="v-dash" class="hidden space-y-8">
            <div class="grid grid-cols-4 gap-6">
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5"><p class="text-[10px] text-gray-500 uppercase font-bold mb-2">VWAP (Fair Value)</p><p id="d-vwap" class="text-2xl font-mono text-blue-500">0.000000</p></div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5"><p class="text-[10px] text-gray-500 uppercase font-bold mb-2">HTX.com USDT</p><p id="d-bal" class="text-2xl font-mono text-green-500">$0.00</p></div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5"><p class="text-[10px] text-gray-500 uppercase font-bold mb-2">Volatility (ATR)</p><p id="d-atr" class="text-2xl font-mono text-yellow-500">0.00%</p></div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5"><p class="text-[10px] text-gray-500 uppercase font-bold mb-2">Active ROI</p><p id="d-roi" class="text-2xl font-mono">0.00%</p></div>
            </div>
            <div class="bg-[#0d0d0d] rounded-3xl border border-white/5 overflow-hidden">
                <table class="w-full text-left text-sm"><thead class="text-gray-500 bg-white/5"><tr><th class="p-6">Side</th><th class="p-6">Units</th><th class="p-6">Trigger</th><th class="p-6 text-right">PnL</th></tr></thead><tbody id="d-ledger" class="font-mono"></tbody></table>
            </div>
        </section>
        <section id="v-auth" class="hidden max-w-sm mx-auto bg-[#0d0d0d] p-10 rounded-3xl border border-white/5 shadow-2xl">
            <h2 id="a-title" class="text-2xl font-black mb-8 text-center uppercase">Secure Access</h2>
            <div class="space-y-4">
                <input type="text" id="i-name" placeholder="Name" class="w-full bg-black p-4 rounded-xl border border-white/5 hidden">
                <input type="email" id="i-email" placeholder="Email" class="w-full bg-black p-4 rounded-xl border border-white/5">
                <input type="password" id="i-pass" placeholder="Key" class="w-full bg-black p-4 rounded-xl border border-white/5">
                <button onclick="auth()" class="w-full bg-blue-600 py-4 rounded-xl font-black uppercase text-xs">Establish Link</button>
            </div>
        </section>
    </main>
    <script>
        let mode = 'login', token = localStorage.getItem('alpha_token');
        function nav(v){ document.querySelectorAll('main > section').forEach(s=>s.classList.add('hidden')); document.getElementById('v-'+v).classList.remove('hidden'); if(v==='register'){mode='register'; document.getElementById('i-name').classList.remove('hidden'); document.getElementById('a-title').innerText='Register Node';} }
        async function auth(){
            const body={email:document.getElementById('i-email').value,password:document.getElementById('i-pass').value,name:document.getElementById('i-name').value};
            const res=await fetch('/api/auth/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            const data=await res.json(); if(data.token){localStorage.setItem('alpha_token',data.token); location.reload();}
        }
        if(token){
            nav('dash');
            setInterval(async()=>{
                const res=await fetch('/api/data',{headers:{'Authorization':token}}); const data=await res.json();
                document.getElementById('d-vwap').innerText=data.market.vwap.toFixed(8);
                document.getElementById('d-bal').innerText='$'+data.balance.toFixed(2);
                document.getElementById('d-atr').innerText=(data.market.atr/data.market.mid*100).toFixed(3)+'%';
                if(data.activePositions.length>0){ document.getElementById('d-roi').innerText=data.activePositions[0].roi.toFixed(2)+'%'; document.getElementById('d-roi').className='text-2xl font-mono '+(data.activePositions[0].roi>=0?'text-green-500':'text-red-500'); }
                document.getElementById('d-ledger').innerHTML=data.trades.map(t=>\`<tr class="border-t border-white/5"><td class="p-6 font-bold \${t.side==='long'?'text-green-500':'text-red-500'}">\${t.side.toUpperCase()}</td><td class="p-6">\${t.contracts}</td><td class="p-6 text-gray-500 text-[10px] uppercase">\${t.exitReason}</td><td class="p-6 text-right font-bold \${t.netPnl>=0?'text-green-500':'text-red-500'}">$\${t.netPnl.toFixed(4)}</td></tr>\`).join('');
            },1000);
        }
    </script>
</body></html>`));

app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { const w = new ExpertAlphaInstance(u); await w.init(); activeWorkers.set(u._id.toString(), w); }
    startAlphaSystem();
    console.log(`✅ Institutional Engine Online on Port ${CUSTOM_PORT}`);
});
