const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/ton_trading_bot?retryWrites=true&w=majority&appName=Clusterweb8888";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'TON/USDT:USDT';
const LEVERAGE = 75;
const TAKE_PROFIT = 5.0; 
const STOP_LOSS = -30.0; 

// --- NEW SETTING: AMOUNT OF TON CONTRACTS TO OPEN ---
const TRADE_QTY = 10; // Set this to the exact number of TON you want to trade
// ========================================================

// ==================== DATABASE SETUP ====================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ DB Error:', err));

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number, startDate: { type: Date, default: Date.now }
}));

// ==================== TRADING ENGINE ====================
const htx = new ccxt.htx({
    apiKey: API_KEY,
    secret: API_SECRET,
    options: { defaultType: 'swap' }
});

let botStatus = {
    active: false,
    side: 'IDLE',
    currentRoi: 0,
    currentPnl: 0,
    initialBalance: 0,
    currentBalance: 0,
    growthPnl: 0,
    growthPct: 0,
    targetQty: TRADE_QTY,
    errorMsg: null,
    lastUpdate: '...'
};

async function refreshMetrics() {
    try {
        const bal = await htx.fetchBalance({ type: 'swap' });
        const currentBal = bal.total.USDT || 0;
        botStatus.currentBalance = currentBal;

        let startDoc = await BotState.findOne({ key: "initial_balance" });
        if (!startDoc && currentBal > 0) {
            startDoc = await BotState.create({ key: "initial_balance", value: currentBal });
        }

        if (startDoc) {
            botStatus.initialBalance = startDoc.value;
            botStatus.growthPnl = currentBal - startDoc.value;
            botStatus.growthPct = (botStatus.growthPnl / startDoc.value) * 100;
        }
    } catch (e) { console.error("Sync Error:", e.message); }
}

async function tradingLoop() {
    await htx.loadMarkets();
    try { await htx.setLeverage(LEVERAGE, SYMBOL, { 'lever_rate': LEVERAGE }); } catch (e) {}

    while (true) {
        try {
            const positions = await htx.fetchPositions([SYMBOL]);
            const pos = positions.find(p => p.symbol === SYMBOL && p.contracts > 0);

            if (pos) {
                botStatus.active = true;
                botStatus.errorMsg = null;
                botStatus.side = pos.side.toUpperCase();
                botStatus.currentRoi = parseFloat(pos.percentage) || 0;
                botStatus.currentPnl = parseFloat(pos.unrealizedPnl) || 0;

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    const reason = botStatus.currentRoi >= TAKE_PROFIT ? "TAKE PROFIT" : "STOP LOSS";
                    await htx.createMarketOrder(SYMBOL, (pos.side === 'long' ? 'sell' : 'buy'), pos.contracts, undefined, {
                        'lever_rate': LEVERAGE, 'offset': 'close', 'reduceOnly': true
                    });
                    await Trade.create({
                        side: pos.side, entryPrice: pos.entryPrice, exitPrice: pos.markPrice,
                        roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: reason
                    });
                    await refreshMetrics();
                    await new Promise(r => setTimeout(r, 10000));
                }
            } else {
                botStatus.active = false;
                const bal = await htx.fetchBalance({ type: 'swap' });
                const available = bal.free.USDT || 0;
                const ticker = await htx.fetchTicker(SYMBOL);
                const price = ticker.last;

                // Check if user has enough margin for the FIXED QTY
                const marginNeeded = (TRADE_QTY * price) / LEVERAGE;
                const totalNeededWithFees = marginNeeded * 1.15; // 15% buffer for market impact and fees

                if (available >= totalNeededWithFees) {
                    botStatus.errorMsg = null;
                    const randomSide = Math.random() > 0.5 ? 'buy' : 'sell';
                    await htx.createMarketOrder(SYMBOL, randomSide, TRADE_QTY, undefined, {
                        'lever_rate': LEVERAGE, 'offset': 'open'
                    });
                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    botStatus.errorMsg = `Need min ${totalNeededWithFees.toFixed(2)} USDT for ${TRADE_QTY} QTY`;
                }
            }
            botStatus.lastUpdate = new Date().toLocaleTimeString();
        } catch (e) { 
            botStatus.errorMsg = e.message.substring(0, 50);
            await new Promise(r => setTimeout(r, 5000)); 
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}

refreshMetrics();
tradingLoop();

// ==================== WEB DASHBOARD ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => {
    const history = await Trade.find().sort({ timestamp: -1 }).limit(10);
    res.json(history);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>TON QTY Engine</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
            body { background: #020617; color: #f8fafc; font-family: 'JetBrains+Mono', monospace; }
            .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 16px; }
            .stat-value { font-size: 1.875rem; line-height: 2.25rem; font-weight: 700; }
            .growth-glow { color: #10b981; text-shadow: 0 0 20px rgba(16, 185, 129, 0.5); }
        </style>
    </head>
    <body class="p-4 md:p-12">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-end mb-12">
                <div>
                    <h1 class="text-3xl font-black tracking-tighter text-blue-500 uppercase">TON.Alpha.V3</h1>
                    <p class="text-xs text-slate-500 font-bold">QTY SETTING: <span class="text-white">${TRADE_QTY} TON</span> | LEVERAGE: 75X</p>
                </div>
                <div id="badge" class="px-4 py-1 rounded-full border border-slate-700 text-[10px] font-bold uppercase tracking-widest">SYNCING</div>
            </header>

            <div id="error-bar" class="hidden mb-6 p-4 bg-rose-500/10 border border-rose-500/50 text-rose-500 text-xs font-bold rounded-lg text-center uppercase tracking-widest"></div>

            <!-- GROWTH SUMMARY -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                <div class="card p-8 border-t-4 border-emerald-500">
                    <div class="text-slate-500 text-xs font-bold uppercase mb-2">Wallet Growth %</div>
                    <div id="g-pct" class="stat-value growth-glow">0.00%</div>
                </div>
                <div class="card p-8 border-t-4 border-blue-500">
                    <div class="text-slate-500 text-xs font-bold uppercase mb-2">Total USDT Gained</div>
                    <div id="g-pnl" class="stat-value text-blue-400">+0.0000</div>
                </div>
                <div class="card p-8 border-t-4 border-slate-700">
                    <div class="text-slate-500 text-xs font-bold uppercase mb-2">Baseline Balance</div>
                    <div id="s-bal" class="stat-value text-slate-400">0.0000</div>
                </div>
            </div>

            <!-- LIVE STATS -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-12">
                <div class="card p-6"><div class="text-slate-500 text-[10px] font-bold uppercase mb-1">Live ROI</div><div id="roi" class="text-xl font-bold">0.00%</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] font-bold uppercase mb-1">Target QTY</div><div class="text-xl font-bold text-white">${TRADE_QTY}</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] font-bold uppercase mb-1">Wallet USDT</div><div id="wallet" class="text-xl font-bold text-emerald-400">0.0000</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] font-bold uppercase mb-1">Last Update</div><div id="sync" class="text-xl font-bold text-blue-500">...</div></div>
            </div>

            <div class="card overflow-hidden">
                <table class="w-full text-left">
                    <thead class="bg-slate-900/50 text-[10px] text-slate-500 font-bold uppercase">
                        <tr><th class="px-6 py-4">Side</th><th class="px-6 py-4 text-right">ROI %</th><th class="px-6 py-4 text-right">PnL USDT</th><th class="px-6 py-4 text-right">Exit</th></tr>
                    </thead>
                    <tbody id="history" class="text-xs"></tbody>
                </table>
            </div>
        </div>

        <script>
            async function update() {
                const res = await fetch('/api/status');
                const s = await statusRes.json();
                
                document.getElementById('g-pct').innerText = s.growthPct.toFixed(2) + '%';
                document.getElementById('g-pnl').innerText = (s.growthPnl >= 0 ? '+' : '') + s.growthPnl.toFixed(4);
                document.getElementById('s-bal').innerText = s.initialBalance.toFixed(4);
                document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                document.getElementById('roi').className = 'text-xl font-bold ' + (s.currentRoi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                document.getElementById('wallet').innerText = s.currentBalance.toFixed(4);
                document.getElementById('sync').innerText = s.lastUpdate;

                const errBar = document.getElementById('error-bar');
                if(s.errorMsg) { errBar.innerText = s.errorMsg; errBar.classList.remove('hidden'); }
                else { errBar.classList.add('hidden'); }

                const b = document.getElementById('badge');
                b.innerText = s.active ? s.side + ' ACTIVE' : 'MARKET SEARCH';
                b.className = s.active ? 'px-4 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-widest' : 'px-4 py-1 rounded-full border border-slate-700 text-slate-500 text-[10px] font-bold tracking-widest';

                const hRes = await fetch('/api/history');
                const history = await hRes.json();
                document.getElementById('history').innerHTML = history.map(t => \`
                    <tr class="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                        <td class="px-6 py-4 font-bold \${t.side === 'buy' ? 'text-emerald-500' : 'text-rose-500'}">\${t.side.toUpperCase()}</td>
                        <td class="px-6 py-4 text-right font-bold \${t.roi >= 0 ? 'text-emerald-400' : 'text-rose-500'}">\${t.roi.toFixed(2)}%</td>
                        <td class="px-6 py-4 text-right font-bold text-slate-300">\${t.pnl.toFixed(4)}</td>
                        <td class="px-6 py-4 text-right text-slate-500 font-bold uppercase text-[10px]">\${t.reason}</td>
                    </tr>
                \`).join('');
            }
            setInterval(update, 1000);
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Fixed-QTY Engine live at http://localhost:${PORT}`));
