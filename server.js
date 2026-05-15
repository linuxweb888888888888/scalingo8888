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
// ========================================================

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number, startDate: { type: Date, default: Date.now }
}));

const htx = new ccxt.htx({
    apiKey: API_KEY,
    secret: API_SECRET,
    options: { defaultType: 'swap' },
    enableRateLimit: true
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
    lastQtyOpened: 0,
    errorMsg: "Initializing...",
    lastUpdate: 'INIT'
};

async function refreshMetrics() {
    try {
        const bal = await htx.fetchBalance({ type: 'swap' });
        const currentBal = (bal.total && bal.total.USDT) ? bal.total.USDT : (bal.USDT ? bal.USDT.total : 0);
        botStatus.currentBalance = currentBal;

        if (currentBal > 0) {
            let startDoc = await BotState.findOne({ key: "initial_balance" });
            if (!startDoc) {
                startDoc = await BotState.create({ key: "initial_balance", value: currentBal });
            }
            botStatus.initialBalance = startDoc.value;
            botStatus.growthPnl = currentBal - startDoc.value;
            botStatus.growthPct = (botStatus.growthPnl / startDoc.value) * 100;
            botStatus.errorMsg = null;
        }
    } catch (e) { botStatus.errorMsg = "Sync Error: " + e.message.substring(0, 30); }
}

async function tradingLoop() {
    await htx.loadMarkets();
    try { await htx.setLeverage(LEVERAGE, SYMBOL, { 'lever_rate': LEVERAGE }); } catch (e) {}

    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await refreshMetrics();

            const positions = await htx.fetchPositions([SYMBOL]);
            const pos = positions.find(p => p.symbol === SYMBOL && p.contracts > 0);

            if (pos) {
                botStatus.active = true;
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
                    await new Promise(r => setTimeout(r, 10000));
                }
            } else {
                botStatus.active = false;
                const ticker = await htx.fetchTicker(SYMBOL);
                const price = ticker.last;

                // --- FULL WALLET CALCULATION ---
                // Use 92% of balance to ensure there is enough for the fee
                const buyingPower = botStatus.currentBalance * 0.92 * LEVERAGE;
                const dynamicQty = Math.floor(buyingPower / price);

                if (dynamicQty >= 1 && botStatus.currentBalance >= 0.05) {
                    const randomSide = Math.random() > 0.5 ? 'buy' : 'sell';
                    await htx.createMarketOrder(SYMBOL, randomSide, dynamicQty, undefined, {
                        'lever_rate': LEVERAGE, 'offset': 'open'
                    });
                    botStatus.lastQtyOpened = dynamicQty;
                    console.log(`Opened ${randomSide.toUpperCase()} with full wallet. QTY: ${dynamicQty}`);
                    await new Promise(r => setTimeout(r, 5000));
                } else if (botStatus.currentBalance > 0 && dynamicQty < 1) {
                    botStatus.errorMsg = "Wallet too small for 1 contract";
                }
            }
        } catch (e) { 
            botStatus.errorMsg = e.message.substring(0, 50);
            await new Promise(r => setTimeout(r, 5000)); 
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

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
        <title>TON Alpha Full-Wallet</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
            body { background: #020617; color: #f8fafc; font-family: 'JetBrains+Mono', monospace; }
            .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; }
            .glow-emerald { color: #10b981; text-shadow: 0 0 15px rgba(16, 185, 129, 0.4); }
        </style>
    </head>
    <body class="p-4 md:p-12">
        <div class="max-w-6xl mx-auto">
            <header class="flex justify-between items-center mb-10">
                <div>
                    <h1 class="text-2xl font-bold tracking-tighter text-blue-500 uppercase">TON.Alpha.Full</h1>
                    <p class="text-[10px] text-slate-500 font-bold uppercase">Mode: Maximum Wallet QTY | 75X</p>
                </div>
                <div id="badge" class="px-4 py-1 rounded-full border border-slate-700 text-[10px] font-bold uppercase tracking-widest">SYNCING</div>
            </header>

            <div id="error-bar" class="hidden mb-6 p-3 bg-rose-500/10 border border-rose-500/40 text-rose-500 text-[10px] font-bold rounded-lg text-center"></div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="card p-8"><div class="text-slate-500 text-[10px] uppercase font-bold mb-2">Compounded Growth</div><div id="g-pct" class="text-4xl font-bold glow-emerald">0.00%</div></div>
                <div class="card p-8"><div class="text-slate-500 text-[10px] uppercase font-bold mb-2">Net USDT Gained</div><div id="g-pnl" class="text-4xl font-bold text-blue-400">+0.0000</div></div>
                <div class="card p-8"><div class="text-slate-500 text-[10px] uppercase font-bold mb-2">Account Baseline</div><div id="s-bal" class="text-4xl font-bold text-slate-400">0.0000</div></div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div class="card p-6"><div class="text-slate-500 text-[10px] mb-1 uppercase">Live ROI</div><div id="roi" class="text-xl font-bold">0.00%</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] mb-1 uppercase">Last QTY</div><div id="qty" class="text-xl font-bold text-white">0</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] mb-1 uppercase">Available USDT</div><div id="wallet" class="text-xl font-bold text-emerald-400">0.0000</div></div>
                <div class="card p-6"><div class="text-slate-500 text-[10px] mb-1 uppercase">Last Sync</div><div id="sync" class="text-xl font-bold text-blue-500">...</div></div>
            </div>

            <div class="card overflow-hidden">
                <table class="w-full text-left">
                    <thead class="bg-slate-900/50 text-[10px] text-slate-500 font-bold uppercase">
                        <tr><th class="px-6 py-3">Side</th><th class="px-6 py-3 text-right">ROI %</th><th class="px-6 py-3 text-right">PnL</th><th class="px-6 py-3 text-right">Exit</th></tr>
                    </thead>
                    <tbody id="history" class="text-xs"></tbody>
                </table>
            </div>
        </div>

        <script>
            async function update() {
                try {
                    const res = await fetch('/api/status');
                    const s = await res.json();
                    document.getElementById('g-pct').innerText = s.growthPct.toFixed(2) + '%';
                    document.getElementById('g-pnl').innerText = (s.growthPnl >= 0 ? '+' : '') + s.growthPnl.toFixed(4);
                    document.getElementById('s-bal').innerText = s.initialBalance.toFixed(4);
                    document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                    document.getElementById('roi').className = 'text-xl font-bold ' + (s.currentRoi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                    document.getElementById('wallet').innerText = s.currentBalance.toFixed(4);
                    document.getElementById('qty').innerText = s.active ? 'HOLDING' : s.lastQtyOpened;
                    document.getElementById('sync').innerText = s.lastUpdate;

                    const errBar = document.getElementById('error-bar');
                    if(s.errorMsg) { errBar.innerText = s.errorMsg; errBar.classList.remove('hidden'); }
                    else { errBar.classList.add('hidden'); }

                    const b = document.getElementById('badge');
                    b.innerText = s.active ? s.side + ' ACTIVE' : 'POOLING LIQUIDITY';
                    b.className = s.active ? 'px-4 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-[10px] font-bold' : 'px-4 py-1 rounded-full border border-slate-700 text-slate-500 text-[10px] font-bold';

                    const hRes = await fetch('/api/history');
                    const history = await hRes.json();
                    document.getElementById('history').innerHTML = history.map(t => \`
                        <tr class="border-b border-slate-800/50">
                            <td class="px-6 py-4 font-bold \${t.side === 'buy' ? 'text-emerald-500' : 'text-rose-500'}">\${t.side.toUpperCase()}</td>
                            <td class="px-6 py-4 text-right font-bold \${t.roi >= 0 ? 'text-emerald-400' : 'text-rose-500'}">\${t.roi.toFixed(2)}%</td>
                            <td class="px-6 py-4 text-right text-slate-300">\${t.pnl.toFixed(4)}</td>
                            <td class="px-6 py-4 text-right text-slate-500 uppercase font-bold">\${t.reason}</td>
                        </tr>
                    \`).join('');
                } catch (e) {}
            }
            setInterval(update, 2000);
            update();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Full-Wallet Engine live on port ${PORT}`));
