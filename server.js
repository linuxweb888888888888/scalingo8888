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
mongoose.connect(MONGO_URI).then(() => console.log(`✅ AI Engine Connected`));

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

// ==================== AI CORE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' }, enableRateLimit: true });

let botStatus = {
    active: false,
    side: 'IDLE',
    currentRoi: 0,
    currentBalance: 0,
    availableBalance: 0,
    totalClosedRoi: 0, 
    aiSensitivity: 14,
    lastUpdate: 'INIT'
};

// Quadratic Weighted kernel for Trend Prediction
function calculateAILevel(series, window) {
    if (series.length < window) return series;
    let results = [];
    for (let i = 0; i < series.length; i++) {
        if (i < window) { results.push(series[i]); continue; }
        let sumWeights = 0; let sumValues = 0;
        for (let j = 0; j < window; j++) {
            let weight = Math.pow(1 - (j / window), 2);
            sumValues += series[i - j] * weight;
            sumWeights += weight;
        }
        results.push(sumValues / sumWeights);
    }
    return results;
}

async function syncAccount() {
    try {
        let balanceDoc = await BotState.findOne({ key: "paper_balance" });
        if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 10.00 });
        botStatus.currentBalance = balanceDoc.value;
        botStatus.availableBalance = balanceDoc.value;
        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, trade) => sum + (trade.roi || 0), 0);
    } catch (e) { botStatus.errorMsg = e.message; }
}

async function tradingLoop() {
    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 100);
            const prices = ohlcv.map(x => x[4]);
            const currentPrice = prices[prices.length - 1];

            const aiFast = calculateAILevel(prices, Math.floor(botStatus.aiSensitivity / 2));
            const aiSlow = calculateAILevel(prices, botStatus.aiSensitivity);

            const fCurr = aiFast[aiFast.length - 1];
            const sCurr = aiSlow[aiSlow.length - 1];
            const fPrev = aiFast[aiFast.length - 2];
            const sPrev = aiSlow[aiSlow.length - 2];

            let signal = "NONE";
            if (fPrev <= sPrev && fCurr > sCurr) signal = "BUY";
            if (fPrev >= sPrev && fCurr < sCurr) signal = "SELL";

            let activePos = await PaperPosition.findOne({ symbol: SYMBOL });

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                const diff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (diff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (diff * activePos.contracts * 0.1);

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS || (activePos.side === 'buy' && signal === "SELL") || (activePos.side === 'sell' && signal === "BUY")) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AI_EXIT" });
                }
            } else if (signal !== "NONE") {
                const qty = Math.floor((botStatus.availableBalance / (currentPrice * 0.1)) * LEVERAGE);
                if (qty >= 1) await PaperPosition.create({ symbol: SYMBOL, side: signal.toLowerCase(), entryPrice: currentPrice, contracts: qty });
            }
        } catch (e) { }
        await new Promise(r => setTimeout(r, 4000));
    }
}
tradingLoop();

// ==================== WEB APP ====================
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));
app.get('/api/chart', async (req, res) => {
    const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 60);
    const p = ohlcv.map(x => x[4]);
    res.json({ p, f: calculateAILevel(p, 7), s: calculateAILevel(p, 14), t: ohlcv.map(x => new Date(x[0]).toLocaleTimeString()) });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON Linear Trend</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}</style></head>
    <body class="p-6 md:p-12"><div class="max-w-6xl mx-auto">
    
    <header class="flex justify-between items-center mb-8">
        <div><h1 class="text-2xl font-bold text-white tracking-tighter italic">TON.LINEAR.AI</h1><p class="text-[10px] text-blue-500 font-bold uppercase tracking-widest">Trend-Segmented Mode ($10)</p></div>
        <div id="side-status" class="px-6 py-2 rounded-full border border-slate-700 text-xs font-bold">IDLE</div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 text-center">
        <div class="bg-slate-900/50 p-8 rounded-2xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-2">VIRTUAL BALANCE</div><div id="bal" class="text-3xl font-bold">$0.00</div></div>
        <div class="bg-slate-900/50 p-8 rounded-2xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-2">ACTIVE ROI</div><div id="roi" class="text-3xl font-bold">0%</div></div>
        <div class="bg-slate-900/50 p-8 rounded-2xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-2">TOTAL PROFITS</div><div id="t-roi" class="text-3xl font-bold text-blue-500">0%</div></div>
    </div>

    <!-- STRAIGHT LINE SEGMENTED CHART -->
    <div class="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 mb-8" style="height:400px;"><canvas id="c"></canvas></div>
    
    <div class="bg-slate-900/50 rounded-2xl border border-slate-800 overflow-hidden"><table class="w-full text-left text-xs"><tbody id="h"></tbody></table></div></div>

    <script>
    let chart;
    function initChart() {
        const ctx = document.getElementById('c').getContext('2d');
        chart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ 
                label: 'Price', data: [], 
                borderWidth: 4, pointRadius: 0, tension: 0, // 0 Tension = Straight Lines
                segment: {
                    borderColor: ctx => ctx.p0.parsed.y <= ctx.p1.parsed.y ? '#10b981' : '#f43f5e', // Green if Up, Red if Down
                }
            }]}, 
            options: { 
                responsive: true, maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: { 
                    x: { display: false }, 
                    y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } 
                } 
            }
        });
    }

    async function update(){
        try {
            const res = await fetch('/api/status'); const s = await res.json();
            document.getElementById('bal').innerText = '$' + s.currentBalance.toFixed(2);
            document.getElementById('roi').innerText = s.currentRoi.toFixed(2)+'%';
            document.getElementById('roi').className = 'text-3xl font-bold '+(s.currentRoi>=0?'text-emerald-400':'text-rose-500');
            document.getElementById('t-roi').innerText = s.totalClosedRoi.toFixed(2)+'%';
            
            const sideEl = document.getElementById('side-status');
            sideEl.innerText = s.side;
            sideEl.className = 'px-6 py-2 rounded-full border text-xs font-bold ' + (s.side === 'BUY' ? 'border-emerald-500 text-emerald-500 bg-emerald-500/10' : (s.side === 'SELL' ? 'border-rose-500 text-rose-500 bg-rose-500/10' : 'border-slate-700 text-white'));
            
            const cRes = await fetch('/api/chart'); const cData = await cRes.json();
            chart.data.labels = cData.t; chart.data.datasets[0].data = cData.p;
            chart.update('none');

            const hRes = await fetch('/api/history'); const hData = await hRes.json();
            document.getElementById('h').innerHTML = hData.map(t => \`<tr class="border-b border-slate-800/50"><td class="p-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td><td class="p-4 text-right \${t.roi>=0?'text-emerald-400':'text-rose-500'} font-bold">\${t.roi.toFixed(2)}%</td><td class="p-4 text-right text-slate-500 uppercase">\${new Date(t.timestamp).toLocaleTimeString()}</td></tr>\`).join('');
        } catch(e){}
    }
    initChart(); setInterval(update, 2000); update();
    </script></body></html>
    `);
});

app.listen(PORT, () => console.log("🌐 Straight-Line AI Engine Online."));
