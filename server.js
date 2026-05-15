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
const TAKE_PROFIT = 5.0;  // Exit at +5% ROI
const STOP_LOSS = -20.0;  // Exit at -20% ROI

// ==================== DATABASE SETUP ====================
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ Database Connection Error:', err));

const TradeSchema = new mongoose.Schema({
    side: String,
    entryPrice: Number,
    exitPrice: Number,
    roi: Number,
    pnl: Number,
    reason: String,
    timestamp: { type: Date, default: Date.now }
});
const Trade = mongoose.model('Trade_History', TradeSchema);

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
    totalSessionRoi: 0,
    balance: 0,
    lastUpdate: 'Syncing...'
};

// Sync stats from Database and Exchange
async function refreshMetrics() {
    try {
        const stats = await Trade.aggregate([
            { $group: { _id: null, totalRoi: { $sum: "$roi" } } }
        ]);
        botStatus.totalSessionRoi = stats.length > 0 ? stats[0].totalRoi : 0;

        const bal = await htx.fetchBalance({ type: 'swap' });
        botStatus.balance = bal.free.USDT || 0;
    } catch (e) { console.error("Metrics Error:", e.message); }
}

async function tradingLoop() {
    console.log("🚀 TON 75x Scalper Engine Online");
    await htx.loadMarkets();

    // Verify leverage on start
    try {
        await htx.setLeverage(LEVERAGE, SYMBOL, { 'lever_rate': LEVERAGE });
    } catch (e) { console.log("Leverage set check:", e.message); }
    
    while (true) {
        try {
            const positions = await htx.fetchPositions([SYMBOL]);
            const pos = positions.find(p => p.symbol === SYMBOL && p.contracts > 0);

            if (pos) {
                botStatus.active = true;
                botStatus.side = pos.side.toUpperCase();
                botStatus.currentRoi = parseFloat(pos.percentage) || 0;
                botStatus.currentPnl = parseFloat(pos.unrealizedPnl) || 0;

                // --- EXIT LOGIC ---
                let exitTriggered = false;
                let exitReason = "";

                if (botStatus.currentRoi >= TAKE_PROFIT) {
                    exitTriggered = true; exitReason = "TAKE PROFIT";
                } else if (botStatus.currentRoi <= STOP_LOSS) {
                    exitTriggered = true; exitReason = "STOP LOSS";
                }

                if (exitTriggered) {
                    console.log(`[EXIT] ${exitReason} at ${botStatus.currentRoi.toFixed(2)}%`);
                    
                    await htx.createMarketOrder(SYMBOL, (pos.side === 'long' ? 'sell' : 'buy'), pos.contracts, undefined, {
                        'lever_rate': LEVERAGE, 
                        'offset': 'close', 
                        'reduceOnly': true
                    });
                    
                    // Log trade to MongoDB Atlas
                    await Trade.create({
                        side: pos.side,
                        entryPrice: pos.entryPrice,
                        exitPrice: pos.markPrice,
                        roi: botStatus.currentRoi,
                        pnl: botStatus.currentPnl,
                        reason: exitReason
                    });
                    
                    await refreshMetrics();
                    await new Promise(r => setTimeout(r, 10000)); // 10s cooldown
                }
            } else {
                botStatus.active = false;
                botStatus.side = 'IDLE';
                botStatus.currentRoi = 0;
                botStatus.currentPnl = 0;

                // --- ENTRY LOGIC ---
                const bal = await htx.fetchBalance({ type: 'swap' });
                const available = bal.free.USDT || 0;
                botStatus.balance = available;

                if (available >= 0.10) {
                    const safeMargin = available * 0.90; // Keep 10% for fees
                    const ticker = await htx.fetchTicker(SYMBOL);
                    const randomSide = Math.random() > 0.5 ? 'buy' : 'sell';
                    const qty = Math.floor((safeMargin * LEVERAGE) / ticker.last);

                    if (qty >= 1) {
                        console.log(`[ENTRY] ${randomSide.toUpperCase()} for ${qty} contracts...`);
                        await htx.createMarketOrder(SYMBOL, randomSide, qty, undefined, {
                            'lever_rate': LEVERAGE, 
                            'offset': 'open'
                        });
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            }
            botStatus.lastUpdate = new Date().toLocaleTimeString();
        } catch (e) { 
            console.error("Loop Error:", e.message); 
            await new Promise(r => setTimeout(r, 5000));
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// Initial Sync
refreshMetrics();
tradingLoop();

// ==================== DASHBOARD SERVER ====================
const app = express();

app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => {
    const history = await Trade.find().sort({ timestamp: -1 }).limit(10);
    res.json(history);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Alpha TON Terminal</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
            body { background: #020617; color: #f8fafc; font-family: 'JetBrains+Mono', monospace; }
            .card { background: #0f172a; border: 1px solid #1e293b; }
            .emerald-glow { color: #34d399; text-shadow: 0 0 10px rgba(52, 211, 153, 0.3); }
            .rose-glow { color: #fb7185; text-shadow: 0 0 10px rgba(251, 113, 133, 0.3); }
        </style>
    </head>
    <body class="p-6 md:p-12">
        <div class="max-w-5xl mx-auto">
            <header class="flex justify-between items-center mb-12">
                <div>
                    <h1 class="text-xl font-bold tracking-tighter text-blue-500 uppercase">TON.Alpha.V1</h1>
                    <div class="text-[10px] text-slate-500">75X LEVERAGE RANDOM SCALPER</div>
                </div>
                <div id="status-badge" class="text-[10px] px-4 py-1 rounded-full border border-slate-700 text-slate-400 font-bold uppercase">SYNCING</div>
            </header>

            <!-- METRIC GRID -->
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div class="card p-6 rounded-xl">
                    <div class="text-slate-500 text-[10px] uppercase tracking-widest mb-2">Live ROI</div>
                    <div id="roi" class="text-3xl font-bold">0.00%</div>
                </div>
                <div class="card p-6 rounded-xl">
                    <div class="text-slate-500 text-[10px] uppercase tracking-widest mb-2">DB Session Total</div>
                    <div id="session" class="text-3xl font-bold text-blue-400">0.00%</div>
                </div>
                <div class="card p-6 rounded-xl">
                    <div class="text-slate-500 text-[10px] uppercase tracking-widest mb-2">Unrealized PnL</div>
                    <div id="pnl" class="text-3xl font-bold">0.0000</div>
                </div>
                <div class="card p-6 rounded-xl">
                    <div class="text-slate-500 text-[10px] uppercase tracking-widest mb-2">Wallet USDT</div>
                    <div id="wallet" class="text-3xl font-bold text-emerald-400">0.0000</div>
                </div>
            </div>

            <!-- LEDGER -->
            <div class="card rounded-xl overflow-hidden shadow-2xl">
                <div class="px-6 py-4 bg-slate-900/50 border-b border-slate-800 flex justify-between items-center">
                    <span class="text-xs font-bold uppercase tracking-tighter">Atlas Database Records (Closed Trades)</span>
                    <span id="last-sync" class="text-[9px] text-slate-500 font-bold"></span>
                </div>
                <table class="w-full text-left">
                    <thead class="text-[10px] text-slate-500 bg-slate-900/30">
                        <tr>
                            <th class="px-6 py-3 font-medium">SIDE</th>
                            <th class="px-6 py-3 font-medium">ROI %</th>
                            <th class="px-6 py-3 font-medium">PNL USDT</th>
                            <th class="px-6 py-3 font-medium">EXIT REASON</th>
                        </tr>
                    </thead>
                    <tbody id="history-rows" class="text-xs"></tbody>
                </table>
            </div>
        </div>

        <script>
            async function refresh() {
                try {
                    const statusRes = await fetch('/api/status');
                    const s = await statusRes.json();
                    
                    document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                    document.getElementById('roi').className = 'text-3xl font-bold ' + (s.currentRoi >= 0 ? 'emerald-glow' : 'rose-glow');
                    
                    document.getElementById('session').innerText = s.totalSessionRoi.toFixed(2) + '%';
                    document.getElementById('pnl').innerText = s.currentPnl.toFixed(4);
                    document.getElementById('wallet').innerText = s.balance.toFixed(4);
                    document.getElementById('last-sync').innerText = 'EXCHANGE TIME: ' + s.lastUpdate;

                    const badge = document.getElementById('status-badge');
                    badge.innerText = s.active ? s.side + ' ACTIVE' : 'LIQUIDITY POOL SEARCH';
                    badge.className = s.active ? 'text-[10px] px-4 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-bold uppercase' : 'text-[10px] px-4 py-1 rounded-full border border-slate-700 text-slate-500 font-bold uppercase';

                    const historyRes = await fetch('/api/history');
                    const history = await historyRes.json();
                    document.getElementById('history-rows').innerHTML = history.map(t => \`
                        <tr class="border-b border-slate-800/50 hover:bg-slate-800/20">
                            <td class="px-6 py-4 font-bold \${t.side === 'buy' ? 'text-emerald-500' : 'text-rose-500'}">\${t.side.toUpperCase()}</td>
                            <td class="px-6 py-4 font-bold \${t.roi >= 0 ? 'text-emerald-400' : 'text-rose-500'}">\${t.roi.toFixed(2)}%</td>
                            <td class="px-6 py-4 text-slate-300 font-bold">\${t.pnl.toFixed(4)}</td>
                            <td class="px-6 py-4 text-slate-500 uppercase text-[10px] font-bold">\${t.reason}</td>
                        </tr>
                    \`).join('');
                } catch (e) { }
            }
            setInterval(refresh, 1000);
            refresh();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Dashboard live at http://localhost:${PORT}`));
