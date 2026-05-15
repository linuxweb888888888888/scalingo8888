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

// Keeping User_V3 to ensure compatibility with your existing database entries
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
    contracts: Number, marginUsed: Number, grossPnl: Number, netPnl: Number, 
    exitReason: String, timestamp: { type: Date, default: Date.now }
}));

// ==================== CORE ALPHA ENGINE ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const HTX_SYMBOL = 'SHIB/USDT:USDT'; // Targeted for HTX.com
const FORCED_LEVERAGE = 75;

// GLOBAL MARKET STATE
const ALPHA_STATE = {
    mid: 0,
    vwap: 0,
    atr: 0,
    rsi: 50,
    ema: 0,
    prices: [],
    volumes: [],
    lookback: 200 // 200 tick quantitative analysis
};

const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

/**
 * INSTITUTIONAL QUANTITATIVE MATH
 * Calculates fair value (VWAP), Volatility (ATR), and Momentum (RSI)
 */
function calculateAlphaMetrics(prices, volumes) {
    if (prices.length < 50) return;

    // 1. VWAP (Fair Value)
    let totalValue = 0, totalVol = 0;
    prices.forEach((p, i) => { totalValue += p * volumes[i]; totalVol += volumes[i]; });
    ALPHA_STATE.vwap = totalValue / totalVol;

    // 2. ATR (Risk Management)
    let tr = 0;
    for (let i = 1; i < prices.length; i++) tr += Math.abs(prices[i] - prices[i-1]);
    ALPHA_STATE.atr = tr / prices.length;

    // 3. EMA (Trend Confirmation)
    const k = 2 / (50 + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = (prices[i] * k) + (ema * (1 - k));
    ALPHA_STATE.ema = ema;

    // 4. RSI (Momentum)
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

        // Initialize HTX.com Client
        this.htx = new ccxt.pro.htx({ 
            apiKey: user.apiKey, 
            secret: user.apiSecret, 
            agent: keepAliveAgent,
            enableRateLimit: true,
            options: { defaultType: 'swap', defaultSubType: 'linear' }
        });
    }

    async init() {
        if (this.htx.apiKey && this.htx.apiKey !== "") {
            try { 
                await this.htx.loadMarkets(); 
                this.syncExchange(); 
                setInterval(() => this.syncExchange(), 5000);
            } catch(e) { console.log(`[HTX API Error - User ${this.userId}]`, e.message); }
        }
    }

    async syncExchange() {
        try {
            const bal = await this.htx.fetchBalance({ type: 'swap' });
            this.walletBalance = bal.total.USDT || 0;
            
            const positions = await this.htx.fetchPositions([HTX_SYMBOL]);
            const openPos = positions.find(p => p.contracts > 0);
            
            if (openPos) {
                if(!this.activePositions[0]) this.activePositions = [{}];
                this.activePositions[0].side = openPos.side;
                this.activePositions[0].entryPrice = openPos.entryPrice;
                this.activePositions[0].contracts = openPos.contracts;
                this.activePositions[0].roi = openPos.percentage || 0;
                this.activePositions[0].pnl = openPos.unrealizedPnl || 0;
            } else {
                this.activePositions = [];
            }
        } catch (e) {}
    }

    async process() {
        if (this.isExecuting || ALPHA_STATE.mid === 0) return;
        
        const price = ALPHA_STATE.mid;
        const { vwap, atr, rsi, ema } = ALPHA_STATE;

        // --- INSTITUTIONAL ENTRY (VWAP + TREND + MOMENTUM) ---
        if (this.activePositions.length === 0 && (Date.now() - this.lastCloseTime > 15000)) {
            const undervalued = price < vwap * 0.998 && rsi < 30 && price > ema;
            const overextended = price > vwap * 1.002 && rsi > 70 && price < ema;

            if (undervalued) await this.executeEntry('long', 'VWAP_BULL_ENTRY');
            else if (overextended) await this.executeEntry('short', 'VWAP_BEAR_ENTRY');
        }

        // --- EXPERT RISK MANAGEMENT ---
        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            const roi = pos.roi || 0;

            // 1. DYNAMIC PROFIT SCALING (Add to winners)
            if (roi > 5 && pos.contracts < 1000 && (Date.now() - (pos.lastScaleTime || 0) > 30000)) {
                await this.executeScaleIn(Math.floor(pos.contracts * 0.5), 'ALPHA_SCALING');
            }

            // 2. ATR VOLATILITY STOP (Trailing)
            const stopDistance = atr * 5; 
            const stopPrice = pos.side === 'long' ? pos.entryPrice - stopDistance : pos.entryPrice + stopDistance;
            const hitStop = pos.side === 'long' ? price < stopPrice : price > stopPrice;

            if (hitStop) await this.executeClose('ATR_VOL_STOP');
            else if (roi > 25) await this.executeClose('QUANTUM_TP_REACHED');
            else if (roi < -50) await this.executeClose('HARD_STOP_LIQUIDITY');
        }
    }

    async executeEntry(side, reason) {
        this.isExecuting = true;
        try {
            // Risk 1% of total account balance per trade
            const riskUsd = Math.max(1, this.walletBalance * 0.01);
            const qty = Math.floor(riskUsd / (price * 0.000001)); // Normalized for SHIB size

            if (this.liveTradingEnabled) {
                await this.htx.createMarketOrder(HTX_SYMBOL, side === 'long' ? 'buy' : 'sell', qty);
            }
            this.activePositions = [{ side, entryPrice: ALPHA_STATE.mid, contracts: qty, lastScaleTime: Date.now() }];
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] } });
            console.log(`[Expert Entry] ${side.toUpperCase()} : ${reason}`);
        } catch(e) { console.error(`[HTX Error]`, e.message); }
        finally { this.isExecuting = false; }
    }

    async executeScaleIn(qty, reason) {
        this.isExecuting = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(HTX_SYMBOL, pos.side === 'long' ? 'buy' : 'sell', qty);
            pos.contracts += qty; pos.lastScaleTime = Date.now();
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: pos } });
            console.log(`[Scaling Winner] Added ${qty} contracts`);
        } catch(e) {}
        finally { this.isExecuting = false; }
    }

    async executeClose(reason) {
        this.isExecuting = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(HTX_SYMBOL, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true });
            
            await TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: ALPHA_STATE.mid, contracts: pos.contracts, netPnl: pos.pnl || 0, exitReason: reason });
            this.activePositions = [];
            this.lastCloseTime = Date.now();
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: null, lastCloseTime: this.lastCloseTime } });
            console.log(`[Alpha Exit] ${reason}`);
        } catch(e) {}
        finally { this.isExecuting = false; }
    }
}

// ==================== WORKER CONTROLLER ====================
const activeWorkers = new Map();

async function startAlphaSystem() {
    (async function streamMarket() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker('1000SHIB/USDT:USDT');
                const mid = (ticker.bid + ticker.ask) / 2;
                ALPHA_STATE.prices.push(mid);
                ALPHA_STATE.volumes.push(ticker.quoteVolume || 1);
                
                if (ALPHA_STATE.prices.length > ALPHA_STATE.lookback) {
                    ALPHA_STATE.prices.shift();
                    ALPHA_STATE.volumes.shift();
                }

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
    if (user && hash(req.body.password, user.salt) === user.passwordHash) res.json({ token: user.token });
    else res.status(401).json({ error: "Auth Error" });
});

app.get('/api/data', async (req, res) => {
    const user = await UserModel.findOne({ token: req.headers.authorization });
    if (!user) return res.status(401).send();
    const w = activeWorkers.get(user._id.toString());
    const trades = await TradeModel.find({ userId: user._id.toString() }).sort({ timestamp: -1 }).limit(10);
    res.json({ 
        activePositions: w.activePositions, 
        balance: w.walletBalance,
        market: { mid: ALPHA_STATE.mid, vwap: ALPHA_STATE.vwap, atr: ALPHA_STATE.atr, rsi: ALPHA_STATE.rsi },
        trades: trades
    });
});

app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>Alpha V6 Institutional</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#050505] text-gray-200 font-sans selection:bg-blue-500/30">
    <nav class="h-16 border-b border-white/5 flex items-center justify-between px-10 bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-50">
        <div class="flex items-center gap-2">
            <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-black">A</div>
            <span class="text-xl font-black tracking-tighter">ALPHA<span class="text-blue-500">V6</span></span>
        </div>
        <div id="auth-nav" class="flex gap-6 text-xs font-bold uppercase tracking-widest text-gray-500">
            <button onclick="nav('login')">Sign In</button>
            <button onclick="nav('register')" class="bg-blue-600 text-white px-4 py-1.5 rounded-md hover:bg-blue-500">Get Access</button>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto py-16 px-10">
        <!-- LANDING -->
        <section id="view-home" class="text-center">
            <h1 class="text-8xl font-black tracking-tighter mb-6 bg-gradient-to-b from-white to-gray-500 bg-clip-text text-transparent">Quant Trading.</h1>
            <p class="text-gray-500 text-lg max-w-2xl mx-auto leading-relaxed">High-Frequency SHIB Engine for HTX.com. Utilizing Institutional VWAP Fair Value and ATR Volatility Risk Models.</p>
            <div class="grid md:grid-cols-3 gap-8 mt-16 text-left">
                <div class="bg-[#0d0d0d] p-8 rounded-3xl border border-white/5">
                    <h3 class="text-blue-500 font-black text-sm mb-2 uppercase tracking-widest">VWAP Core</h3>
                    <p class="text-gray-500 text-sm">Automated fair-value discovery. The engine entries strictly on volume-weighted undervaluation.</p>
                </div>
                <div class="bg-[#0d0d0d] p-8 rounded-3xl border border-white/5">
                    <h3 class="text-green-500 font-black text-sm mb-2 uppercase tracking-widest">ATR Volatility</h3>
                    <p class="text-gray-500 text-sm">Dynamic stops that breathe with the market. Protecting capital from liquidations.</p>
                </div>
                <div class="bg-[#0d0d0d] p-8 rounded-3xl border border-white/5">
                    <h3 class="text-purple-500 font-black text-sm mb-2 uppercase tracking-widest">Smart Scaling</h3>
                    <p class="text-gray-500 text-sm">Compound winners automatically. Increasing position size only when the alpha trend is confirmed.</p>
                </div>
            </div>
        </section>

        <!-- DASHBOARD -->
        <section id="view-dashboard" class="hidden space-y-8">
            <div class="grid grid-cols-4 gap-6">
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Institutional VWAP</p>
                    <p id="d-vwap" class="text-2xl font-mono font-bold text-blue-500">0.000000</p>
                </div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Market RSI</p>
                    <p id="d-rsi" class="text-2xl font-mono font-bold text-yellow-500">50.0</p>
                </div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">HTX.com USDT</p>
                    <p id="d-bal" class="text-2xl font-mono font-bold text-green-500">$0.00</p>
                </div>
                <div class="bg-[#0d0d0d] p-6 rounded-2xl border border-white/5">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Active ROI</p>
                    <p id="d-roi" class="text-2xl font-mono font-bold">0.00%</p>
                </div>
            </div>

            <div class="bg-[#0d0d0d] rounded-3xl border border-white/5 overflow-hidden">
                <div class="p-6 border-b border-white/5 flex justify-between items-center bg-white/5">
                    <h3 class="font-black text-sm uppercase tracking-widest">HTX Execution Ledger</h3>
                    <div class="flex items-center gap-2">
                        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                        <span class="text-[10px] font-black text-green-500 uppercase">Quant Node Active</span>
                    </div>
                </div>
                <table class="w-full text-left text-sm">
                    <thead class="text-gray-500 uppercase text-[10px] font-black tracking-widest border-b border-white/5">
                        <tr><th class="p-6">Side</th><th class="p-6">Qty</th><th class="p-6">Strategy</th><th class="p-6 text-right">Net PnL</th></tr>
                    </thead>
                    <tbody id="d-ledger" class="font-mono"></tbody>
                </table>
            </div>
        </section>

        <!-- AUTH -->
        <section id="view-auth" class="hidden max-w-sm mx-auto bg-[#0d0d0d] p-10 rounded-3xl border border-white/5 shadow-2xl">
            <h2 id="auth-title" class="text-2xl font-black mb-8 text-center uppercase tracking-widest">Link Engine</h2>
            <div class="space-y-4">
                <input type="text" id="a-name" placeholder="Name" class="w-full bg-black p-4 rounded-xl border border-white/5 outline-none hidden">
                <input type="email" id="a-email" placeholder="Email" class="w-full bg-black p-4 rounded-xl border border-white/5 outline-none">
                <input type="password" id="a-pass" placeholder="Password" class="w-full bg-black p-4 rounded-xl border border-white/5 outline-none">
                <button onclick="auth()" class="w-full bg-blue-600 py-4 rounded-xl font-black hover:bg-blue-500 transition mt-4 uppercase text-xs tracking-widest">Establish Connection</button>
            </div>
        </section>
    </main>

    <script>
        let mode = 'login';
        let token = localStorage.getItem('alpha_token');

        function nav(v) {
            document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
            if(v === 'login' || v === 'register') {
                mode = v;
                document.getElementById('view-auth').classList.remove('hidden');
                document.getElementById('auth-title').innerText = v === 'login' ? 'Engine Login' : 'Register Node';
                document.getElementById('a-name').classList.toggle('hidden', v === 'login');
            } else document.getElementById('view-' + v).classList.remove('hidden');
        }

        async function auth() {
            const body = { email: document.getElementById('a-email').value, password: document.getElementById('a-pass').value, name: document.getElementById('a-name').value };
            const res = await fetch('/api/auth/' + mode, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
            const data = await res.json();
            if(data.token) { localStorage.setItem('alpha_token', data.token); location.reload(); }
        }

        if(token) {
            nav('dashboard');
            setInterval(async () => {
                const res = await fetch('/api/data', { headers: {'Authorization': token} });
                const data = await res.json();
                document.getElementById('d-vwap').innerText = data.market.vwap.toFixed(8);
                document.getElementById('d-rsi').innerText = data.market.rsi.toFixed(1);
                document.getElementById('d-bal').innerText = '$' + data.balance.toFixed(2);
                
                if(data.activePositions.length > 0) {
                    const p = data.activePositions[0];
                    document.getElementById('d-roi').innerText = p.roi.toFixed(2) + '%';
                    document.getElementById('d-roi').className = 'text-2xl font-mono font-bold ' + (p.roi >= 0 ? 'text-green-500' : 'text-red-500');
                }

                document.getElementById('d-ledger').innerHTML = data.trades.map(t => \`
                    <tr class="border-t border-white/5 hover:bg-white/5 transition">
                        <td class="p-6 font-bold \${t.side==='long'?'text-green-500':'text-red-500'}">\${t.side.toUpperCase()}</td>
                        <td class="p-6">\${t.contracts}</td>
                        <td class="p-6 text-gray-500 text-[10px] uppercase">\${t.exitReason}</td>
                        <td class="p-6 text-right font-bold \${t.netPnl>=0?'text-green-500':'text-red-500'}">$\${t.netPnl.toFixed(4)}</td>
                    </tr>
                \`).join('');
            }, 1000);
        }
    </script>
</body></html>`));

// ==================== APP INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { 
        const w = new ExpertAlphaInstance(u); 
        await w.init(); 
        activeWorkers.set(u._id.toString(), w); 
    }
    startAlphaSystem();
    console.log(`✅ Institutional Engine V6 Online on Port ${CUSTOM_PORT}`);
});
