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
const TAKE_PROFIT = 15.0; 
const STOP_LOSS = -30.0; 

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI).then(() => console.log(`✅ ALWAYS-TREND Engine Connected ($10.00 Mode)`));

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

// ==================== AI & TRADING ENGINE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' }, enableRateLimit: true });

let botStatus = {
    active: false,
    side: 'IDLE',
    currentRoi: 0,
    currentPnl: 0,
    currentBalance: 0,
    totalClosedRoi: 0, 
    lastUpdate: 'INIT'
};

// AI Weighted Kernels (Gaussian-like)
function calculateAI(series, window) {
    let results = [];
    for (let i = 0; i < series.length; i++) {
        if (i < window) { results.push(series[i]); continue; }
        let sumW = 0, sumV = 0;
        for (let j = 0; j < window; j++) {
            let w = Math.pow(1 - (j / window), 2);
            sumV += series[i - j] * w; sumW += w;
        }
        results.push(sumV / sumW);
    }
    return results;
}

async function syncAccount() {
    try {
        let balanceDoc = await BotState.findOne({ key: "paper_balance" });
        if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 10.00 });
        botStatus.currentBalance = balanceDoc.value;
        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, trade) => sum + (trade.roi || 0), 0);
    } catch (e) { console.log("Sync Error:", e.message); }
}

async function tradingLoop() {
    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 100);
            const prices = ohlcv.map(x => x[4]);
            const currentPrice = prices[prices.length - 1];

            const fast = calculateAI(prices, 10); // Fast line
            const slow = calculateAI(prices, 30); // Slow line
            const fC = fast[fast.length - 1];
            const sC = slow[slow.length - 1];

            // TREND COLOR: Fast > Slow = BUY (Green), Fast < Slow = SELL (Red)
            const currentTrend = fC > sC ? "buy" : "sell";

            let activePos = await PaperPosition.findOne({ symbol: SYMBOL });

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                
                // Calculate live stats
                const diff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (diff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (diff * activePos.contracts * 0.1);

                // LOGIC: Flip if trend changes OR hit safety limits
                const trendFlipped = activePos.side !== currentTrend;
                const safetyHit = botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS;

                if (trendFlipped || safetyHit) {
                    // Close Trade
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await Trade.create({ 
                        side: activePos.side, 
                        entryPrice: activePos.entryPrice, 
                        exitPrice: currentPrice, 
                        roi: botStatus.currentRoi, 
                        pnl: botStatus.currentPnl, 
                        reason: trendFlipped ? "TREND_FLIP" : "SAFETY_EXIT" 
                    });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    
                    // If we closed because of a Flip, immediately open the new side
                    if (trendFlipped) {
                        const qty = Math.floor((botStatus.currentBalance / (currentPrice * 0.1)) * LEVERAGE);
                        if (qty >= 1) {
                            await PaperPosition.create({ symbol: SYMBOL, side: currentTrend, entryPrice: currentPrice, contracts: qty });
                        }
                    }
                }
            } else {
                // NO POSITION? Jump into current trend color immediately
                const qty = Math.floor((botStatus.currentBalance / (currentPrice * 0.1)) * LEVERAGE);
                if (qty >= 1) {
                    await PaperPosition.create({ symbol: SYMBOL, side: currentTrend, entryPrice: currentPrice, contracts: qty });
                    console.log(`🚀 Entering ${currentTrend} trend at ${currentPrice}`);
                }
                botStatus.active = true;
                botStatus.side = currentTrend.toUpperCase();
            }
        } catch (e) {
            console.log("Trading Loop Error:", e.message);
        }
        await new Promise(r => setTimeout(r, 4000));
    }
}
tradingLoop();

// ==================== WEB APP ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));

app.get('/api/chart', async (req, res) => {
    try {
        const ohlcv = await htx.fetchOHLCV(SYMBOL, '1m', undefined, 100);
        const prices = ohlcv.map(x => x[4]);
        const fast = calculateAI(prices, 10);
        const slow = calculateAI(prices, 30);
        
        let trendData = [];
        for (let i = 0; i < prices.length; i++) {
            trendData.push({
                t: new Date(ohlcv[i][0]).toLocaleTimeString(),
                y: ohlcv[i][4],
                color: fast[i] > slow[i] ? '#10b981' : '#f43f5e'
            });
        }
        res.json(trendData);
    } catch (e) { res.json([]); }
});

app.post('/api/reset-baseline', async (req, res) => {
    await BotState.updateOne({ key: "paper_balance" }, { value: 10.00 });
    await PaperPosition.deleteMany({});
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON TREND BOT</title><script src="https://cdn.tailwindcss.com"></script><script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}</style></head>
    <body class="p-6 md:p-12"><div class="max-w-6xl mx-auto"><header class="flex justify-between items-center mb-10"><div>
    <h1 class="text-2xl font-bold text-emerald-500 italic uppercase">TON.ALWAYS.TREND</h1>
    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">REAL-TIME TREND FOLLOWER (75X)</p></div>
    <button onclick="resetBaseline()" class="text-[10px] bg-slate-800 px-4 py-2 rounded-lg font-bold border border-slate-700 hover:bg-rose-900 transition-all">RESET $10</button>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8 text-center">
        <div class="card bg-slate-900/50 p-6 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-1">TREND STATUS</div><div id="side" class="text-xl font-bold">INIT</div></div>
        <div class="card bg-slate-900/50 p-6 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-1">PAPER BALANCE</div><div id="bal" class="text-xl font-bold text-emerald-400">$0.00</div></div>
        <div class="card bg-slate-900/50 p-6 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-1">LIVE ROI</div><div id="roi" class="text-xl font-bold">0%</div></div>
        <div class="card bg-slate-900/50 p-6 rounded-xl border border-slate-800"><div class="text-slate-500 text-[10px] mb-1">SESSION ROI</div><div id="t-roi" class="text-xl font-bold text-yellow-500">0%</div></div>
    </div>

    <div class="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 mb-8" style="height:400px;"><canvas id="c"></canvas></div>
    <div class="bg-slate-900/50 rounded-2xl border border-slate-800 overflow-hidden"><table class="w-full text-left text-xs"><tbody id="h"></tbody></table></div></div>

    <script>
    let chart;
    async function resetBaseline() { if(confirm("Reset to $10?")) { await fetch('/api/reset-baseline', { method: 'POST' }); location.reload(); } }
    
    function initChart() {
        chart = new Chart(document.getElementById('c').getContext('2d'), {
            type: 'line', data: { labels: [], datasets: [{ 
                label: 'Trend', data: [], borderWidth: 3, pointRadius: 0, tension: 0.4, fill: false,
                segment: { borderColor: ctx => ctx.p0.options.backgroundColor }
            }]}, 
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { grid: { color: '#1e293b' }, ticks: { color: '#64748b' } } } }
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
            chart.data.labels = cData.map(d=>d.t); 
            chart.data.datasets[0].data = cData.map(d=>d.y);
            // Assign point colors to the segment logic
            chart.data.datasets[0].pointBackgroundColor = cData.map(d=>d.color);
            chart.data.datasets[0].backgroundColor = cData.map(d=>d.color);
            chart.update('none');

            const hRes = await fetch('/api/history'); const hData = await hRes.json();
            document.getElementById('h').innerHTML = hData.map(t => \`<tr class="border-b border-slate-800/50"><td class="p-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td><td class="p-4 text-slate-300">Entry: \${t.entryPrice.toFixed(4)}</td><td class="p-4 text-right \${t.roi>=0?'text-emerald-400':'text-rose-500'} font-bold">\${t.roi.toFixed(2)}%</td><td class="p-4 text-right text-slate-500">\${t.reason}</td></tr>\`).join('');
        } catch(e){}
    }
    initChart(); setInterval(update, 3000); update();
    </script></body></html>
    `);
});

app.listen(PORT, () => console.log("🌐 TREND ENGINE ONLINE ON PORT " + PORT));
