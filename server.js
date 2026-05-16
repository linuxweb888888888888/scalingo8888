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
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI).then(() => console.log(`✅ MongoDB Connected`));

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
    currentBalance: 0,
    availableBalance: 0,
    totalClosedRoi: 0,
    lastUpdate: 'INIT'
};

async function syncAccount() {
    try {
        if (PAPER_TRADING) {
            let balanceDoc = await BotState.findOne({ key: "paper_balance" });
            if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 10.00 });
            botStatus.currentBalance = balanceDoc.value;
            botStatus.availableBalance = balanceDoc.value;
        } else {
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.currentBalance = bal.total.USDT || 0;
            botStatus.availableBalance = bal.free.USDT || 0;
        }
        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, t) => sum + (t.roi || 0), 0);
    } catch (e) { botStatus.errorMsg = e.message; }
}

async function tradingLoop() {
    while (true) {
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;
            botStatus.lastUpdate = new Date().toLocaleTimeString();

            let activePos = PAPER_TRADING ? await PaperPosition.findOne({ symbol: SYMBOL }) : null;

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                const diff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (diff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (diff * activePos.contracts * 0.1);

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "EXIT" });
                }
            } else {
                botStatus.active = false;
                botStatus.side = "IDLE";
                if (botStatus.availableBalance > 0.5) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    const qty = Math.floor((botStatus.availableBalance / (currentPrice * 0.1)) * LEVERAGE);
                    if (qty >= 1) await PaperPosition.create({ symbol: SYMBOL, side, entryPrice: currentPrice, contracts: qty });
                }
            }
        } catch (e) { console.log(e.message); }
        await new Promise(r => setTimeout(r, 2000));
    }
}
tradingLoop();

// ==================== WEB APP ====================
const app = express();

app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));

// NEW: Endpoint for Chart Data
app.get('/api/chart', async (req, res) => {
    try {
        const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 30);
        const chartData = ohlcv.map(c => ({ t: c[0], y: c[4] })); // timestamp and close price
        res.json(chartData);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/reset-baseline', async (req, res) => {
    await BotState.updateOne({ key: "paper_balance" }, { value: 10.00 });
    await PaperPosition.deleteMany({});
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON Extreme Chart</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}</style></head>
    <body class="p-6">
        <div class="max-w-6xl mx-auto">
            <div class="flex justify-between items-center mb-6">
                <h1 class="text-xl font-bold text-blue-500 italic">TON.EXTREME.CHART</h1>
                <button onclick="reset()" class="bg-slate-800 px-4 py-2 rounded text-[10px] font-bold">RESET $10</button>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6 text-center">
                <div class="bg-slate-900 p-4 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px]">BALANCE</div><div id="bal" class="text-xl font-bold">$0.00</div></div>
                <div id="side-card" class="bg-slate-900 p-4 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px]">DIRECTION</div><div id="side" class="text-xl font-bold">IDLE</div></div>
                <div class="bg-slate-900 p-4 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px]">LIVE ROI</div><div id="roi" class="text-xl font-bold">0%</div></div>
                <div class="bg-slate-900 p-4 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px]">TOTAL ROI</div><div id="total-roi" class="text-xl font-bold text-yellow-500">0%</div></div>
            </div>

            <!-- CHART SECTION -->
            <div class="bg-slate-900 p-6 rounded-xl border border-slate-800 mb-6">
                <canvas id="priceChart" height="100"></canvas>
            </div>

            <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <table class="w-full text-left text-xs"><tbody id="history"></tbody></table>
            </div>
        </div>

        <script>
            let chart;
            function initChart() {
                const ctx = document.getElementById('priceChart').getContext('2d');
                chart = new Chart(ctx, {
                    type: 'line',
                    data: { labels: [], datasets: [{ label: 'TON/USDT', data: [], borderColor: '#3b82f6', tension: 0.4, borderWidth: 2, pointRadius: 0 }] },
                    options: { 
                        plugins: { legend: { display: false } },
                        scales: { 
                            x: { display: false }, 
                            y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } 
                        } 
                    }
                });
            }

            async function update() {
                const res = await fetch('/api/status');
                const s = await res.json();
                document.getElementById('bal').innerText = '$' + s.currentBalance.toFixed(2);
                document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                document.getElementById('roi').className = 'text-xl font-bold ' + (s.currentRoi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                document.getElementById('total-roi').innerText = s.totalClosedRoi.toFixed(2) + '%';
                
                const sideEl = document.getElementById('side');
                sideEl.innerText = s.side;
                sideEl.className = 'text-xl font-bold ' + (s.side === 'BUY' ? 'text-emerald-400' : (s.side === 'SELL' ? 'text-rose-500' : 'text-white'));

                // Update Chart Data
                const chartRes = await fetch('/api/chart');
                const data = await chartRes.json();
                chart.data.labels = data.map(d => '');
                chart.data.datasets[0].data = data.map(d => d.y);
                chart.update('none');

                const hRes = await fetch('/api/history');
                const history = await hRes.json();
                document.getElementById('history').innerHTML = history.map(t => \`
                    <tr class="border-b border-slate-800">
                        <td class="p-4 font-bold \${t.side === 'buy' ? 'text-emerald-500' : 'text-rose-500'}">\${t.side.toUpperCase()}</td>
                        <td class="p-4 text-right">\${t.roi.toFixed(2)}%</td>
                        <td class="p-4 text-right text-slate-500">\${new Date(t.timestamp).toLocaleTimeString()}</td>
                    </tr>\`).join('');
            }

            async function reset() { if(confirm("Reset to $10?")) { await fetch('/api/reset-baseline', {method:'POST'}); location.reload(); } }
            
            initChart();
            setInterval(update, 2000);
            update();
        </script>
    </body></html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
