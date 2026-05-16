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
    emaShort: 9,
    emaLong: 21,
    errorMsg: null,
    lastUpdate: 'INIT',
    mode: PAPER_TRADING ? "PAPER" : "REAL"
};

function calculateEMA(series, length) {
    let k = 2 / (length + 1);
    let ema = [series[0]];
    for (let i = 1; i < series.length; i++) {
        ema.push((series[i] * k) + (ema[i - 1] * (1 - k)));
    }
    return ema;
}

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

        let sEma = await BotState.findOne({ key: "ema_short" });
        if (!sEma) sEma = await BotState.create({ key: "ema_short", value: 9 });
        botStatus.emaShort = sEma.value;

        let lEma = await BotState.findOne({ key: "ema_long" });
        if (!lEma) lEma = await BotState.create({ key: "ema_long", value: 21 });
        botStatus.emaLong = lEma.value;

        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, trade) => sum + (trade.roi || 0), 0);
    } catch (e) { botStatus.errorMsg = "Sync Error: " + e.message; }
}

async function tradingLoop() {
    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 100);
            const prices = ohlcv.map(x => x[4]);
            const currentPrice = prices[prices.length - 1];

            const emaS = calculateEMA(prices, botStatus.emaShort);
            const emaL = calculateEMA(prices, botStatus.emaLong);

            const prevS = emaS[emaS.length - 2];
            const prevL = emaL[emaL.length - 2];
            const currS = emaS[emaS.length - 1];
            const currL = emaL[emaL.length - 1];

            let signal = "NONE";
            if (prevS <= prevL && currS > currL) signal = "BUY";
            if (prevS >= prevL && currS < currL) signal = "SELL";

            let activePos = PAPER_TRADING ? await PaperPosition.findOne({ symbol: SYMBOL }) : null;

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                const diff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (diff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (diff * activePos.contracts * 0.1);

                const oppositeSignal = (activePos.side === 'buy' && signal === "SELL") || (activePos.side === 'sell' && signal === "BUY");
                
                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS || oppositeSignal) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "EXIT" });
                }
            } else if (signal !== "NONE") {
                const qty = Math.floor((botStatus.availableBalance / (currentPrice * 0.1)) * LEVERAGE);
                if (qty >= 1) {
                    await PaperPosition.create({ symbol: SYMBOL, side: signal.toLowerCase(), entryPrice: currentPrice, contracts: qty });
                    botStatus.lastQty = qty;
                }
            }
        } catch (e) { botStatus.errorMsg = e.message.substring(0, 50); }
        await new Promise(r => setTimeout(r, 5000));
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
    res.json({ p, s: calculateEMA(p, botStatus.emaShort), l: calculateEMA(p, botStatus.emaLong), t: ohlcv.map(x => new Date(x[0]).toLocaleTimeString()) });
});

app.post('/api/settings', async (req, res) => {
    const { short, long } = req.body;
    await BotState.updateOne({ key: "ema_short" }, { value: parseInt(short) }, { upsert: true });
    await BotState.updateOne({ key: "ema_long" }, { value: parseInt(long) }, { upsert: true });
    res.json({ success: true });
});

app.post('/api/reset-baseline', async (req, res) => {
    await BotState.updateOne({ key: "paper_balance" }, { value: 10.00 });
    await PaperPosition.deleteMany({});
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON Smooth Crossover</title>
    <script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;}</style></head>
    <body class="p-6 md:p-12"><div class="max-w-6xl mx-auto"><header class="flex justify-between items-center mb-10"><div>
    <h1 class="text-2xl font-bold text-blue-500 italic uppercase">TON.SMOOTH.V4</h1>
    <p class="text-[10px] text-rose-500 font-bold uppercase tracking-widest">⚠️ PAPER MODE ($10)</p></div>
    <div class="flex gap-2">
        <div class="flex items-center gap-2 bg-slate-800 px-3 py-1 rounded-lg border border-slate-700 text-[10px] font-bold">
            S: <input id="eS" type="number" class="bg-transparent w-8 text-blue-400 outline-none" value="9">
            L: <input id="eL" type="number" class="bg-transparent w-8 text-yellow-400 outline-none" value="21">
            <button onclick="save()" class="text-emerald-400">SAVE</button>
        </div>
        <button onclick="reset()" class="bg-slate-800 px-4 py-2 rounded-lg text-[10px] font-bold border border-slate-700">RESET</button>
    </div></header>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8 text-center">
        <div class="card p-6 border-t-2 border-blue-500"><div class="text-slate-500 text-[10px]">DIRECTION</div><div id="side" class="text-xl font-bold">IDLE</div></div>
        <div class="card p-6 border-t-2 border-emerald-500"><div class="text-slate-500 text-[10px]">BALANCE</div><div id="bal" class="text-xl font-bold text-emerald-400">$0.00</div></div>
        <div class="card p-6 border-t-2 border-rose-500"><div class="text-slate-500 text-[10px]">LIVE ROI</div><div id="roi" class="text-xl font-bold">0%</div></div>
        <div class="card p-6 border-t-2 border-yellow-500"><div class="text-slate-500 text-[10px]">TOTAL ROI</div><div id="t-roi" class="text-xl font-bold text-yellow-400">0%</div></div>
    </div>

    <div class="card p-6 mb-8" style="height:350px;"><canvas id="c"></canvas></div>
    <div class="card overflow-hidden"><table class="w-full text-left text-xs"><tbody id="h"></tbody></table></div></div>

    <script>
    let chart;
    async function save(){ await fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({short:document.getElementById('eS').value, long:document.getElementById('eL').value}) }); }
    async function reset(){ if(confirm("Reset to $10?")) { await fetch('/api/reset-baseline', { method: 'POST' }); location.reload(); } }
    
    function initChart() {
        const ctx = document.getElementById('c').getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 400);
        grad.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
        grad.addColorStop(1, 'rgba(59, 130, 246, 0)');

        chart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [
                { label: 'Price', data: [], borderColor: '#3b82f6', tension: 0.4, cubicInterpolationMode: 'monotone', borderWidth: 3, pointRadius: 0, fill: true, backgroundColor: grad },
                { label: 'Short', data: [], borderColor: '#60a5fa', tension: 0.4, borderWidth: 1, pointRadius: 0, borderDash:[3,3] },
                { label: 'Long', data: [], borderColor: '#fbbf24', tension: 0.4, borderWidth: 1, pointRadius: 0 }
            ]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } } }
        });
    }

    async function update(){
        try {
            const res = await fetch('/api/status'); const s = await res.json();
            document.getElementById('bal').innerText = '$' + s.currentBalance.toFixed(2);
            document.getElementById('roi').innerText = s.currentRoi.toFixed(2)+'%';
            document.getElementById('roi').className = 'text-xl font-bold '+(s.currentRoi>=0?'text-emerald-400':'text-rose-500');
            document.getElementById('t-roi').innerText = s.totalClosedRoi.toFixed(2)+'%';
            document.getElementById('side').innerText = s.side;
            document.getElementById('side').className = 'text-xl font-bold ' + (s.side === 'BUY' ? 'text-emerald-400' : (s.side === 'SELL' ? 'text-rose-500' : 'text-white'));
            
            const cRes = await fetch('/api/chart'); const cData = await cRes.json();
            chart.data.labels = cData.t; chart.data.datasets[0].data = cData.p;
            chart.data.datasets[1].data = cData.s; chart.data.datasets[2].data = cData.l;
            chart.update('none');

            const hRes = await fetch('/api/history'); const hData = await hRes.json();
            document.getElementById('h').innerHTML = hData.map(t => \`<tr class="border-b border-slate-800/50"><td class="p-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td><td class="p-4 text-right \${t.roi>=0?'text-emerald-400':'text-rose-500'} font-bold">\${t.roi.toFixed(2)}%</td><td class="p-4 text-right text-slate-500">\${new Date(t.timestamp).toLocaleTimeString()}</td></tr>\`).join('');
        } catch(e){}
    }
    initChart(); setInterval(update, 2000); update();
    </script></body></html>
    `);
});

app.listen(PORT, () => console.log("🌐 Server active."));
