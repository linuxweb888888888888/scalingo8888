const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== INSTITUTIONAL DB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ Quantitative Engine Connected to MongoDB'))
    .catch(err => console.error('🚨 Connection Error:', err));

const UserModel = mongoose.model('User_V4', new mongoose.Schema({
    name: String, email: { type: String, unique: true }, passwordHash: String, salt: String, token: String,
    apiKey: { type: String, default: "" }, apiSecret: { type: String, default: "" },
    liveTradingEnabled: { type: Boolean, default: false },
    activePosition: { type: Object, default: null }, 
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V4', new mongoose.Schema({
    userId: String, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, netPnl: Number, exitReason: String, timestamp: { type: Date, default: Date.now }
}));

// ==================== CORE FINANCIAL ENGINE ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75; // Institutional High-Frequency Setting

const MARKET_STATE = {
    binance: { bid: 0, ask: 0, mid: 0, vwap: 0, atr: 0 },
    priceHistory: [],
    volumeHistory: [],
    lookback: 100 // Ticks for VWAP/ATR calculation
};

const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// QUANTITATIVE MATH
function calculateTechnicalData(prices, volumes) {
    if (prices.length < 20) return { vwap: prices[prices.length-1], atr: 0 };

    // 1. VWAP Calculation
    let tpvSum = 0, volSum = 0;
    for (let i = 0; i < prices.length; i++) {
        tpvSum += prices[i] * volumes[i];
        volSum += volumes[i];
    }
    const vwap = tpvSum / volSum;

    // 2. ATR (Volatility) Calculation
    let trSum = 0;
    for (let i = 1; i < prices.length; i++) {
        trSum += Math.abs(prices[i] - prices[i-1]);
    }
    const atr = trSum / (prices.length - 1);

    return { vwap, atr };
}

// ==================== PROFESSIONAL TRADE INSTANCE ====================
class ProfessionalEngine {
    constructor(user) {
        this.userId = user._id.toString();
        this.liveTradingEnabled = user.liveTradingEnabled;
        this.activePositions = user.activePosition ? [user.activePosition] : [];
        this.lastCloseTime = user.lastCloseTime || 0;
        this.walletBalance = 0;
        this.isExecuting = false;

        this.htx = new ccxt.pro.htx({ 
            apiKey: user.apiKey || "demo", 
            secret: user.apiSecret || "demo", 
            agent: keepAliveAgent,
            options: { defaultType: 'swap', defaultSubType: 'linear' }
        });
    }

    async init() { this.syncExchange(); setInterval(() => this.syncExchange(), 3000); }

    async syncExchange() {
        if (!this.liveTradingEnabled) return;
        try {
            const bal = await this.htx.fetchBalance({ type: 'swap' });
            this.walletBalance = bal.total.USDT || 0;
            const pos = await this.htx.fetchPositions(['SHIB/USDT:USDT']);
            const open = pos.find(p => p.contracts > 0);
            if (open) {
                if(!this.activePositions[0]) this.activePositions = [{}];
                this.activePositions[0].exchangeROI = open.percentage || 0;
                this.activePositions[0].exchangePnl = open.unrealizedPnl || 0;
                this.activePositions[0].contracts = open.contracts;
            } else { this.activePositions = []; }
        } catch (e) {}
    }

    async monitor() {
        if (this.isExecuting) return;
        const price = MARKET_STATE.binance.mid;
        const { vwap, atr } = MARKET_STATE.binance;

        // ENTRY LOGIC: VWAP DEVIATION
        if (this.activePositions.length === 0 && (Date.now() - this.lastCloseTime > 10000)) {
            const deviation = ((price - vwap) / vwap) * 100;
            
            // Buy if price is undervalued (below VWAP) and starts recovering
            if (deviation < -0.2) await this.executeOrder('long', 'VWAP_UNDERVALUED');
            // Short if price is overextended (above VWAP)
            else if (deviation > 0.2) await this.executeOrder('short', 'VWAP_OVEREXTENDED');
        }

        // EXIT & SCALING LOGIC
        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            const roi = pos.exchangeROI || 0;

            // 1. SMART SCALING (Add to winners)
            if (roi > 5 && pos.contracts < 100 && (Date.now() - (pos.lastScaleTime || 0) > 30000)) {
                await this.scalePosition('add', 10, 'PROFIT_SCALING');
            }

            // 2. DYNAMIC STOP (Volatility based)
            const stopPrice = pos.side === 'long' ? pos.entryPrice - (atr * 3) : pos.entryPrice + (atr * 3);
            const isStopped = pos.side === 'long' ? price < stopPrice : price > stopPrice;
            
            if (isStopped) await this.executeClose('ATR_STOP_LOSS');
            if (roi > 15) await this.executeClose('DYNAMIC_TAKE_PROFIT');
        }
    }

    async executeOrder(side, reason) {
        this.isExecuting = true;
        try {
            const qty = Math.max(1, Math.floor(this.walletBalance * 0.1)); // Risk 10% of wallet per entry
            if (this.liveTradingEnabled) await this.htx.createMarketOrder('SHIB/USDT:USDT', side === 'long' ? 'buy' : 'sell', qty);
            
            this.activePositions = [{ 
                side, entryPrice: MARKET_STATE.binance.mid, contracts: qty, 
                lastScaleTime: Date.now(), entryTime: Date.now() 
            }];
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] } });
            console.log(`[EXECUTION] ${side.toUpperCase()} via ${reason}`);
        } finally { this.isExecuting = false; }
    }

    async scalePosition(type, qty, reason) {
        this.isExecuting = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder('SHIB/USDT:USDT', pos.side === 'long' ? 'buy' : 'sell', qty);
            pos.contracts += qty;
            pos.lastScaleTime = Date.now();
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: pos } });
            console.log(`[SCALING] Added ${qty} contracts via ${reason}`);
        } finally { this.isExecuting = false; }
    }

    async executeClose(reason) {
        this.isExecuting = true;
        try {
            const pos = this.activePositions[0];
            if (this.liveTradingEnabled) await this.htx.createMarketOrder('SHIB/USDT:USDT', pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true });
            
            await TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: MARKET_STATE.binance.mid, contracts: pos.contracts, netPnl: pos.exchangePnl || 0, exitReason: reason });
            this.activePositions = [];
            this.lastCloseTime = Date.now();
            await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: null, lastCloseTime: this.lastCloseTime } });
            console.log(`[LIQUIDATION] Position Closed via ${reason}`);
        } finally { this.isExecuting = false; }
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startSystem() {
    (async function streamData() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker('1000SHIB/USDT:USDT');
                const mid = (ticker.bid + ticker.ask) / 2;
                MARKET_STATE.binance.mid = mid;
                
                MARKET_STATE.priceHistory.push(mid);
                MARKET_STATE.volumeHistory.push(ticker.quoteVolume || 1);
                
                if (MARKET_STATE.priceHistory.length > MARKET_STATE.lookback) {
                    MARKET_STATE.priceHistory.shift();
                    MARKET_STATE.volumeHistory.shift();
                }

                const { vwap, atr } = calculateTechnicalData(MARKET_STATE.priceHistory, MARKET_STATE.volumeHistory);
                MARKET_STATE.binance.vwap = vwap;
                MARKET_STATE.binance.atr = atr;

                for (const worker of activeWorkers.values()) { worker.monitor(); }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== PROFESSIONAL API & UI ====================
const app = express(); app.use(express.json());

function hash(p, s) { return crypto.scryptSync(p, s, 64).toString('hex'); }

app.post('/api/auth/register', async (req, res) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = await UserModel.create({ name: req.body.name, email: req.body.email, salt, passwordHash: hash(req.body.password, salt), token: crypto.randomBytes(32).toString('hex') });
    const worker = new ProfessionalEngine(user); worker.init(); activeWorkers.set(user._id.toString(), worker);
    res.json({ token: user.token });
});

app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (user && hash(req.body.password, user.salt) === user.passwordHash) res.json({ token: user.token });
    else res.status(401).json({ error: "Auth Failed" });
});

app.get('/api/data', async (req, res) => {
    const user = await UserModel.findOne({ token: req.headers.authorization });
    if (!user) return res.status(401).send();
    const worker = activeWorkers.get(user._id.toString());
    const trades = await TradeModel.find({ userId: user._id.toString() }).sort({ timestamp: -1 }).limit(10);
    res.json({ 
        activePositions: worker.activePositions, 
        walletBalance: worker.walletBalance,
        market: MARKET_STATE.binance,
        trades: trades
    });
});

app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>Quantum Terminal</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-[#0a0a0c] text-gray-100 font-sans">
    <nav class="border-b border-gray-800 h-16 flex items-center justify-between px-10 bg-[#0f0f12]">
        <div class="flex items-center gap-2">
            <div class="w-8 h-8 bg-blue-600 rounded flex items-center justify-center font-bold">Q</div>
            <span class="font-bold tracking-tighter text-xl">QUANTUM<span class="text-blue-500">ENGINE</span></span>
        </div>
        <div id="auth-nav" class="flex gap-6 text-sm font-medium text-gray-400">
            <button onclick="show('login')">Login</button>
            <button onclick="show('register')" class="bg-blue-600 text-white px-4 py-1.5 rounded shadow-lg shadow-blue-900/20">Register</button>
        </div>
    </nav>

    <main class="max-w-6xl mx-auto py-12 px-6">
        <!-- HOME SECTION -->
        <section id="view-home" class="text-center">
            <h1 class="text-7xl font-black tracking-tighter mb-6 bg-gradient-to-b from-white to-gray-500 bg-clip-text text-transparent">Professional Execution.</h1>
            <p class="text-gray-400 text-lg max-w-2xl mx-auto leading-relaxed">Quantitative fair-value trading for SHIB/USDT. Using institutional VWAP deviation and ATR volatility risk management.</p>
            <div class="grid md:grid-cols-3 gap-6 mt-16 text-left">
                <div class="bg-[#141417] p-8 rounded-2xl border border-gray-800">
                    <h3 class="text-blue-500 font-bold mb-2">VWAP Analysis</h3>
                    <p class="text-sm text-gray-500">Identifies Institutional Fair Value. The bot only buys when price is undervalued relative to volume.</p>
                </div>
                <div class="bg-[#141417] p-8 rounded-2xl border border-gray-800">
                    <h3 class="text-green-500 font-bold mb-2">ATR Volatility</h3>
                    <p class="text-sm text-gray-500">Dynamic Risk Mitigation. Stops are calculated based on market noise, not static percentages.</p>
                </div>
                <div class="bg-[#141417] p-8 rounded-2xl border border-gray-800">
                    <h3 class="text-purple-500 font-bold mb-2">Geometric Scaling</h3>
                    <p class="text-sm text-gray-500">Winner Compounding. The bot automatically adds to profitable trends while protecting capital.</p>
                </div>
            </div>
        </section>

        <!-- DASHBOARD (Hidden until login) -->
        <section id="view-dashboard" class="hidden space-y-8">
            <div class="grid grid-cols-4 gap-6">
                <div class="bg-[#141417] p-6 rounded-xl border border-gray-800">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Market VWAP</p>
                    <p id="dash-vwap" class="text-2xl font-mono font-bold text-blue-400">0.000000</p>
                </div>
                <div class="bg-[#141417] p-6 rounded-xl border border-gray-800">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Volatility (ATR)</p>
                    <p id="dash-atr" class="text-2xl font-mono font-bold text-yellow-400">0.00%</p>
                </div>
                <div class="bg-[#141417] p-6 rounded-xl border border-gray-800">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Active ROI</p>
                    <p id="dash-roi" class="text-2xl font-mono font-bold">0.00%</p>
                </div>
                <div class="bg-[#141417] p-6 rounded-xl border border-gray-800">
                    <p class="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Wallet USDT</p>
                    <p id="dash-bal" class="text-2xl font-mono font-bold text-green-400">$0.00</p>
                </div>
            </div>

            <div class="bg-[#141417] rounded-2xl border border-gray-800 overflow-hidden">
                <div class="p-6 border-b border-gray-800 flex justify-between items-center">
                    <h3 class="font-bold">Trade Execution Ledger</h3>
                    <span class="text-[10px] bg-green-900/30 text-green-500 px-3 py-1 rounded-full font-bold">ENGINE LIVE</span>
                </div>
                <table class="w-full text-left text-sm">
                    <thead class="bg-[#0f0f12] text-gray-500 uppercase text-[10px]">
                        <tr><th class="p-4">Side</th><th class="p-4">Contracts</th><th class="p-4">Reason</th><th class="p-4 text-right">PnL</th></tr>
                    </thead>
                    <tbody id="trade-ledger" class="font-mono"></tbody>
                </table>
            </div>
        </section>

        <!-- AUTH FORMS -->
        <section id="view-auth" class="hidden max-w-sm mx-auto bg-[#141417] p-10 rounded-3xl border border-gray-800 shadow-2xl">
            <h2 id="auth-title" class="text-3xl font-bold mb-8 text-center">Login</h2>
            <div class="space-y-4">
                <input type="text" id="auth-name" placeholder="Name" class="w-full bg-[#0a0a0c] p-4 rounded-xl outline-none border border-gray-800 hidden">
                <input type="email" id="auth-email" placeholder="Email" class="w-full bg-[#0a0a0c] p-4 rounded-xl outline-none border border-gray-800">
                <input type="password" id="auth-pass" placeholder="Password" class="w-full bg-[#0a0a0c] p-4 rounded-xl outline-none border border-gray-800">
                <button onclick="auth()" id="auth-btn" class="w-full bg-blue-600 py-4 rounded-xl font-bold shadow-lg shadow-blue-900/20 mt-4">Continue</button>
            </div>
        </section>
    </main>

    <script>
        let mode = 'login';
        let token = localStorage.getItem('q_token');

        function show(v) {
            document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
            if(v === 'login' || v === 'register') {
                mode = v;
                document.getElementById('view-auth').classList.remove('hidden');
                document.getElementById('auth-title').innerText = v === 'login' ? 'Login' : 'Create Account';
                document.getElementById('auth-name').classList.toggle('hidden', v === 'login');
            } else document.getElementById('view-' + v).classList.remove('hidden');
        }

        async function auth() {
            const email = document.getElementById('auth-email').value;
            const password = document.getElementById('auth-pass').value;
            const name = document.getElementById('auth-name').value;
            const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const res = await fetch(endpoint, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password, name })});
            const data = await res.json();
            if(data.token) { localStorage.setItem('q_token', data.token); location.reload(); }
        }

        if(token) {
            show('dashboard');
            setInterval(async () => {
                const res = await fetch('/api/data', { headers: {'Authorization': token} });
                const data = await res.json();
                document.getElementById('dash-vwap').innerText = data.market.vwap.toFixed(8);
                document.getElementById('dash-atr').innerText = (data.market.atr / data.market.mid * 100).toFixed(4) + '%';
                document.getElementById('dash-bal').innerText = '$' + data.walletBalance.toFixed(2);
                
                if(data.activePositions.length > 0) {
                    const p = data.activePositions[0];
                    document.getElementById('dash-roi').innerText = (p.exchangeROI || 0).toFixed(2) + '%';
                    document.getElementById('dash-roi').className = 'text-2xl font-mono font-bold ' + (p.exchangeROI >= 0 ? 'text-green-500' : 'text-red-500');
                }

                document.getElementById('trade-ledger').innerHTML = data.trades.map(t => \`
                    <tr class="border-t border-gray-800/50">
                        <td class="p-4 font-bold \${t.side==='long'?'text-green-500':'text-red-500'}">\${t.side.toUpperCase()}</td>
                        <td class="p-4">\${t.contracts}</td>
                        <td class="p-4 text-gray-500 text-[10px] uppercase">\${t.exitReason}</td>
                        <td class="p-4 text-right font-bold \${t.netPnl>=0?'text-green-500':'text-red-500'}">$\${t.netPnl.toFixed(4)}</td>
                    </tr>
                \`).join('');
            }, 1000);
        }
    </script>
</body></html>`));

// ==================== INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { 
        const w = new ProfessionalEngine(u); 
        await w.init(); 
        activeWorkers.set(u._id.toString(), w); 
    }
    startSystem();
    console.log(`✅ Institutional Engine Running on Port ${CUSTOM_PORT}`);
});
