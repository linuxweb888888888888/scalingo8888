const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const PAPER_TRADING = true; 
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/ton_trading_bot?retryWrites=true&w=majority&appName=Clusterweb8888";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'TON/USDT:USDT';
const LEVERAGE = 75;
const MULTIPLIER = 1; 
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI).then(() => console.log(`✅ MongoDB Connected (${PAPER_TRADING ? 'PAPER' : 'REAL'} MODE)`));

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number, startDate: { type: Date, default: Date.now }
}));

const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({
    symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now }
}));

// ==================== ENGINE ====================
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
    availableBalance: 0,
    totalClosedRoi: 0, 
    lastQty: 0,
    emaLength: 14, // Default EMA
    errorMsg: null,
    lastUpdate: 'INIT',
    mode: PAPER_TRADING ? "PAPER" : "REAL"
};

// EMA Calculation Helper
function calculateEMA(prices, length) {
    if (prices.length < length) return prices;
    let k = 2 / (length + 1);
    let ema = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        ema.push((prices[i] * k) + (ema[i - 1] * (1 - k)));
    }
    return ema;
}

async function syncAccount() {
    try {
        if (PAPER_TRADING) {
            let balanceDoc = await BotState.findOne({ key: "paper_balance" });
            if (!balanceDoc) {
                balanceDoc = await BotState.create({ key: "paper_balance", value: 10.00 }); // $10 START
            }
            botStatus.currentBalance = balanceDoc.value;
            botStatus.availableBalance = balanceDoc.value;
        } else {
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.currentBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
            botStatus.availableBalance = (bal.free && bal.free.USDT) ? bal.free.USDT : 0;
        }

        // Sync EMA Setting
        let emaDoc = await BotState.findOne({ key: "ema_length" });
        if (!emaDoc) emaDoc = await BotState.create({ key: "ema_length", value: 14 });
        botStatus.emaLength = emaDoc.value;

        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, trade) => sum + (trade.roi || 0), 0);

        let startDoc = await BotState.findOne({ key: "initial_balance" });
        if (!startDoc) {
            startDoc = await BotState.create({ key: "initial_balance", value: botStatus.currentBalance });
        }
        botStatus.initialBalance = startDoc.value;
        botStatus.growthPnl = botStatus.currentBalance - startDoc.value;
        botStatus.growthPct = (botStatus.growthPnl / (startDoc.value || 1)) * 100;

    } catch (e) { botStatus.errorMsg = "Sync Failed: " + e.message; }
}

async function tradingLoop() {
    if (!PAPER_TRADING) {
        await htx.loadMarkets();
        try { await htx.setLeverage(LEVERAGE, SYMBOL); } catch (e) {}
    }

    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;

            let activePos;
            if (PAPER_TRADING) {
                activePos = await PaperPosition.findOne({ symbol: SYMBOL });
            } else {
                const positions = await htx.fetchPositions([SYMBOL]);
                activePos = positions.find(p => p.symbol === SYMBOL && p.contracts > 0);
            }

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.lastQty = activePos.contracts;

                if (PAPER_TRADING) {
                    const priceDiff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                    botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                    botStatus.currentPnl = (priceDiff * activePos.contracts * 0.1); 
                } else {
                    botStatus.currentRoi = parseFloat(activePos.percentage) || 0;
                    botStatus.currentPnl = parseFloat(activePos.unrealizedPnl) || 0;
                }

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    if (PAPER_TRADING) {
                        await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                        await PaperPosition.deleteOne({ _id: activePos._id });
                    } else {
                        await htx.createMarketOrder(SYMBOL, (activePos.side === 'long' || activePos.side === 'buy' ? 'sell' : 'buy'), activePos.contracts, undefined, { 'reduceOnly': true });
                    }
                    await Trade.create({
                        side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice,
                        roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AUTO_EXIT"
                    });
                    await new Promise(r => setTimeout(r, 10000));
                }
            } else {
                botStatus.active = false;
                botStatus.side = "IDLE";
                botStatus.currentRoi = 0;

                const unitValue = currentPrice * 0.1;
                const baseDiv = botStatus.availableBalance / unitValue;
                const maxQty = Math.floor(baseDiv * LEVERAGE * MULTIPLIER);

                if (maxQty >= 1 && botStatus.availableBalance > 0.01) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    if (PAPER_TRADING) {
                        await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: maxQty });
                    } else {
                        await htx.createMarketOrder(SYMBOL, side, maxQty);
                    }
                    botStatus.lastQty = maxQty;
                    botStatus.errorMsg = null;
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        } catch (e) { 
            botStatus.errorMsg = e.message.substring(0, 50);
            await new Promise(r => setTimeout(r, 4000)); 
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

tradingLoop();

// ==================== WEB APP ====================
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));

app.get('/api/chart', async (req, res) => {
    try {
        const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 100);
        const prices = ohlcv.map(x => x[4]);
        const ema = calculateEMA(prices, botStatus.emaLength);
        res.json({ prices, ema, labels: ohlcv.map(x => new Date(x[0]).toLocaleTimeString()) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
    const { emaLength } = req.body;
    await BotState.updateOne({ key: "ema_length" }, { value: parseInt(emaLength) }, { upsert: true });
    botStatus.emaLength = parseInt(emaLength);
    res.json({ success: true });
});

app.post('/api/reset-baseline', async (req, res) => {
    if (PAPER_TRADING) {
        await BotState.updateOne({ key: "paper_balance" }, { value: 10.00 });
        await PaperPosition.deleteMany({});
    }
    await BotState.deleteOne({ key: "initial_balance" });
    await syncAccount();
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON EMA Extreme</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;}</style></head>
    <body class="p-6 md:p-12"><div class="max-w-6xl mx-auto"><header class="flex justify-between items-center mb-10"><div>
    <h1 class="text-2xl font-bold tracking-tighter text-blue-500 uppercase font-black italic">TON.EMA.V4</h1>
    <p class="text-[10px] text-rose-500 font-bold uppercase tracking-widest">${PAPER_TRADING ? '⚠️ PAPER TRADING ($10)' : 'LIVE TRADING'}</p></div>
    <div class="flex gap-4">
        <div class="flex items-center gap-2 bg-slate-800 p-2 rounded-lg border border-slate-700">
            <span class="text-[10px] font-bold text-slate-400">EMA:</span>
            <input id="emaInput" type="number" class="bg-transparent w-12 text-[10px] font-bold text-white outline-none" value="14">
            <button onclick="saveEma()" class="text-[10px] text-blue-400 font-bold">SET</button>
        </div>
        <button onclick="resetBaseline()" class="text-[10px] bg-slate-800 hover:bg-rose-900 px-4 py-2 rounded-lg font-bold border border-slate-700 transition-colors">RESET</button>
    </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8 text-center">
        <div class="card p-6 border-t-2 border-blue-500"><div class="text-slate-500 text-[10px] mb-1">DIRECTION</div><div id="side" class="text-xl font-bold">IDLE</div></div>
        <div class="card p-6 border-t-2 border-emerald-500"><div class="text-slate-500 text-[10px] mb-1">BALANCE</div><div id="s-bal" class="text-xl font-bold text-emerald-400">$0.00</div></div>
        <div class="card p-6 border-t-2 border-rose-500"><div class="text-slate-500 text-[10px] mb-1">LIVE ROI</div><div id="roi" class="text-xl font-bold">0%</div></div>
        <div class="card p-6 border-t-2 border-yellow-500"><div class="text-slate-500 text-[10px] mb-1">TOTAL ROI</div><div id="total-roi" class="text-xl font-bold text-yellow-500">0%</div></div>
    </div>

    <!-- CHART -->
    <div class="card p-6 mb-8"><canvas id="mainChart" height="100"></canvas></div>

    <div class="card overflow-hidden"><table class="w-full text-left">
    <thead class="bg-slate-900/50 text-[10px] text-slate-500 font-bold uppercase tracking-widest"><tr><th class="px-6 py-4">Side</th><th class="px-6 py-4 text-right">ROI %</th><th class="px-6 py-4 text-right">Time</th></tr></thead>
    <tbody id="history" class="text-xs"></tbody></table></div></div>

    <script>
    let chart;
    async function resetBaseline() { if(confirm("Reset to $10?")) { await fetch('/api/reset-baseline', { method: 'POST' }); location.reload(); } }
    async function saveEma() { 
        const val = document.getElementById('emaInput').value;
        await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({emaLength: val}) });
    }

    function initChart() {
        const ctx = document.getElementById('mainChart').getContext('2d');
        chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [
                { label: 'Price', data: [], borderColor: '#3b82f6', tension: 0.1, borderWidth: 2, pointRadius: 0 },
                { label: 'EMA', data: [], borderColor: '#f59e0b', tension: 0.4, borderWidth: 1.5, pointRadius: 0, borderDash: [5, 5] }
            ]},
            options: { plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } } }
        });
    }

    async function update(){
        try {
            const res = await fetch('/api/status'); const s = await res.json();
            document.getElementById('total-roi').innerText = s.totalClosedRoi.toFixed(2)+'%';
            document.getElementById('s-bal').innerText = '$' + s.currentBalance.toFixed(2);
            document.getElementById('roi').innerText = s.currentRoi.toFixed(2)+'%';
            document.getElementById('roi').className = 'text-xl font-bold '+(s.currentRoi>=0?'text-emerald-400':'text-rose-500');
            const sideEl = document.getElementById('side');
            sideEl.innerText = s.side;
            sideEl.className = 'text-xl font-bold ' + (s.side === 'BUY' ? 'text-emerald-400' : (s.side === 'SELL' ? 'text-rose-500' : 'text-white'));
            document.getElementById('emaInput').value = s.emaLength;

            const cRes = await fetch('/api/chart'); const cData = await cRes.json();
            chart.data.labels = cData.labels;
            chart.data.datasets[0].data = cData.prices;
            chart.data.datasets[1].data = cData.ema;
            chart.update('none');

            const hRes = await fetch('/api/history'); const history = await hRes.json();
            document.getElementById('history').innerHTML = history.map(t => \`
                <tr class="border-b border-slate-800/50">
                    <td class="px-6 py-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td>
                    <td class="px-6 py-4 text-right \${t.roi>=0?'text-emerald-400':'text-rose-500'} font-bold">\${t.roi.toFixed(2)}%</td>
                    <td class="px-6 py-4 text-right text-slate-500 font-bold uppercase">\${new Date(t.timestamp).toLocaleTimeString()}</td>
                </tr>\`).join('');
        } catch(e){}
    }
    initChart(); setInterval(update, 2000); update();
    </script></body></html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
