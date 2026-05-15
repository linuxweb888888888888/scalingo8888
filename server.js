const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const PAPER_TRADING = false; // <--- SET TO FALSE TO USE REAL MONEY
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/shib_trading_bot?retryWrites=true&w=majority";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'SHIB/USDT:USDT';
const LEVERAGE = 75;
const CONTRACT_SIZE = 1000; // 1 HTX contract = 1000 SHIB tokens
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 
const RISK_PERCENT = 0.98; // Use 10% of available margin per trade

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI).then(() => console.log(`✅ MongoDB Connected | SHIB ${PAPER_TRADING ? 'PAPER' : 'REAL'} MODE`));

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
    errorMsg: null,
    lastUpdate: 'INIT',
    mode: PAPER_TRADING ? "PAPER" : "REAL"
};

async function syncAccount() {
    try {
        if (PAPER_TRADING) {
            let balanceDoc = await BotState.findOne({ key: "paper_balance" });
            if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 1000.00 });
            botStatus.currentBalance = balanceDoc.value;
            botStatus.availableBalance = balanceDoc.value;
        } else {
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.currentBalance = bal.total?.USDT || 0;
            botStatus.availableBalance = bal.free?.USDT || 0;
        }

        const history = await Trade.find();
        botStatus.totalClosedRoi = history.reduce((sum, trade) => sum + (trade.roi || 0), 0);

        let startDoc = await BotState.findOne({ key: "initial_balance" });
        if (!startDoc) startDoc = await BotState.create({ key: "initial_balance", value: botStatus.currentBalance });
        botStatus.initialBalance = startDoc.value;
        botStatus.growthPnl = botStatus.currentBalance - startDoc.value;
        botStatus.growthPct = (botStatus.growthPnl / (startDoc.value || 1)) * 100;
    } catch (e) { botStatus.errorMsg = "Sync Failed: " + e.message; }
}

async function tradingLoop() {
    if (!PAPER_TRADING) {
        console.log("🔧 Initializing Live Leverage...");
        try {
            await htx.loadMarkets();
            // Critical: Set leverage before starting any logic
            await htx.setLeverage(LEVERAGE, SYMBOL);
            console.log(`✅ Leverage successfully synced to ${LEVERAGE}x`);
        } catch (e) {
            console.log(`⚠️ Leverage Error: ${e.message}`);
            if (e.message.includes('1349') || e.message.includes('match')) {
                botStatus.errorMsg = "LEVERAGE MISMATCH: Close all SHIB trades on HTX first!";
                console.log("🚨 STOPPING: You must close existing SHIB positions/orders manually.");
                return; // Stop the bot to prevent liquidations
            }
        }
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

                // --- CALC ROI & PNL ---
                const direction = (activePos.side === 'buy' || activePos.side === 'long') ? 1 : -1;
                const priceDiff = (currentPrice - activePos.entryPrice) * direction;
                
                if (PAPER_TRADING) {
                    botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                    botStatus.currentPnl = priceDiff * activePos.contracts * CONTRACT_SIZE;
                } else {
                    botStatus.currentRoi = parseFloat(activePos.percentage) || 0;
                    botStatus.currentPnl = parseFloat(activePos.unrealizedPnl) || 0;
                }

                // --- EXIT LOGIC ---
                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    const reason = botStatus.currentRoi >= TAKE_PROFIT ? "TAKE_PROFIT" : "STOP_LOSS";
                    if (PAPER_TRADING) {
                        await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                        await PaperPosition.deleteOne({ _id: activePos._id });
                    } else {
                        const exitSide = (activePos.side === 'long' || activePos.side === 'buy') ? 'sell' : 'buy';
                        await htx.createMarketOrder(SYMBOL, exitSide, activePos.contracts, undefined, { 'reduceOnly': true });
                    }
                    
                    await Trade.create({
                        side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice,
                        roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: reason
                    });
                    console.log(`🚩 Position Closed: ${reason}`);
                    await new Promise(r => setTimeout(r, 10000));
                }
            } else {
                // --- ENTRY LOGIC (SHIB MINIMUM 1000 CONTRACTS) ---
                botStatus.active = false;
                botStatus.side = "IDLE";
                botStatus.currentRoi = 0;

                const contractValueUsd = currentPrice * CONTRACT_SIZE;
                const buyingPower = botStatus.availableBalance * LEVERAGE * RISK_PERCENT;
                let contractsToBuy = Math.floor(buyingPower / contractValueUsd);

                // HTX API Minimum for SHIB is 1,000 contracts
                if (contractsToBuy < 1000) contractsToBuy = 1000;

                // Total trade value must be at least ~$5.00 for most APIs
                const totalTradeValue = contractsToBuy * contractValueUsd;
                const requiredMargin = totalTradeValue / LEVERAGE;

                if (botStatus.availableBalance >= requiredMargin && totalTradeValue >= 5.0) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    
                    if (PAPER_TRADING) {
                        await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: contractsToBuy });
                    } else {
                        console.log(`🚀 Opening Live ${side.toUpperCase()} for ${contractsToBuy} contracts...`);
                        await htx.createMarketOrder(SYMBOL, side, contractsToBuy);
                    }
                    botStatus.lastQty = contractsToBuy;
                    botStatus.errorMsg = null;
                    await new Promise(r => setTimeout(r, 5000));
                } else if (botStatus.availableBalance > 0 && !PAPER_TRADING) {
                    botStatus.errorMsg = `Need min ~$${requiredMargin.toFixed(2)} USDT to trade SHIB.`;
                }
            }
        } catch (e) { 
            botStatus.errorMsg = e.message.substring(0, 80);
            await new Promise(r => setTimeout(r, 4000)); 
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}

tradingLoop();

// ==================== WEB APP (UI) ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => {
    const history = await Trade.find().sort({ timestamp: -1 }).limit(10);
    res.json(history);
});
app.post('/api/reset-baseline', async (req, res) => {
    try {
        if (PAPER_TRADING) {
            await BotState.updateOne({ key: "paper_balance" }, { value: 1000 });
            await PaperPosition.deleteMany({});
        }
        await BotState.deleteOne({ key: "initial_balance" });
        await syncAccount();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>SHIB EXTREME</title><script src="https://cdn.tailwindcss.com"></script>
    <style>@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
    body{background:#020617;color:#f8fafc;font-family:'JetBrains+Mono',monospace;}.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;}</style></head>
    <body class="p-6 md:p-12"><div class="max-w-6xl mx-auto"><header class="flex justify-between items-center mb-10"><div>
    <h1 class="text-2xl font-bold tracking-tighter text-orange-500 uppercase font-black italic">SHIB.75X.BOT</h1>
    <p class="text-[10px] text-rose-500 font-bold uppercase tracking-widest">${PAPER_TRADING ? '⚠️ PAPER TRADING MODE' : 'LIVE TRADING ACTIVE'}</p></div>
    <button onclick="resetBaseline()" class="text-[10px] bg-slate-800 hover:bg-rose-900 px-4 py-2 rounded-lg font-bold border border-slate-700 transition-colors">RESET PORTFOLIO</button>
    </header>

    <div id="err" class="mb-6 p-3 bg-rose-500/10 border border-rose-500/40 text-rose-500 text-[10px] font-bold rounded-lg text-center uppercase hidden"></div>
    
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div class="card p-8 border-t-2 border-yellow-500">
            <div class="text-slate-500 text-[10px] uppercase font-bold mb-2 tracking-widest">Total ROI</div>
            <div id="total-roi" class="text-4xl font-bold text-yellow-400">0.00%</div>
        </div>
        <div class="card p-8 border-t-2 border-emerald-500">
            <div class="text-slate-500 text-[10px] uppercase font-bold mb-2 tracking-widest">Growth %</div>
            <div id="g-pct" class="text-4xl font-bold text-emerald-400">0.00%</div>
        </div>
        <div class="card p-8 border-t-2 border-blue-500">
            <div class="text-slate-500 text-[10px] uppercase font-bold mb-2 tracking-widest">Session PnL</div>
            <div id="g-pnl" class="text-4xl font-bold text-blue-400">+0.0000</div>
        </div>
        <div class="card p-8 border-t-2 border-slate-600">
            <div class="text-slate-500 text-[10px] uppercase font-bold mb-2 tracking-widest">Wallet USDT</div>
            <div id="s-bal" class="text-4xl font-bold text-slate-400">0.0000</div>
        </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div class="card p-6 text-center"><div class="text-slate-500 text-[10px] mb-1 uppercase">Live ROI</div><div id="roi" class="text-xl font-bold">0%</div></div>
        <div class="card p-6 text-center"><div class="text-slate-500 text-[10px] mb-1 uppercase">Contracts (1k/ea)</div><div id="qty" class="text-xl font-bold text-white">0</div></div>
        <div class="card p-6 text-center"><div class="text-slate-500 text-[10px] mb-1 uppercase">Available</div><div id="wallet" class="text-xl font-bold text-emerald-400">0</div></div>
        <div class="card p-6 text-center"><div class="text-slate-500 text-[10px] mb-1 uppercase">Sync</div><div id="sync" class="text-xl font-bold text-blue-500">...</div></div>
    </div>

    <div class="card overflow-hidden"><table class="w-full text-left">
    <thead class="bg-slate-900/50 text-[10px] text-slate-500 font-bold uppercase tracking-widest"><tr><th class="px-6 py-4">Side</th><th class="px-6 py-4 text-right">ROI %</th><th class="px-6 py-4 text-right">PnL</th><th class="px-6 py-4 text-right">Time</th></tr></thead>
    <tbody id="history" class="text-xs"></tbody></table></div></div>

    <script>
    async function resetBaseline() {
        if(confirm("Reset all portfolio stats?")) { await fetch('/api/reset-baseline', { method: 'POST' }); location.reload(); }
    }
    async function update(){try{const res=await fetch('/api/status');const s=await res.json();
    document.getElementById('total-roi').innerText=s.totalClosedRoi.toFixed(2)+'%';
    document.getElementById('g-pct').innerText=s.growthPct.toFixed(2)+'%';
    document.getElementById('g-pnl').innerText=(s.growthPnl>=0?'+':'')+s.growthPnl.toFixed(4);
    document.getElementById('s-bal').innerText=s.currentBalance.toFixed(2);
    document.getElementById('roi').innerText=s.currentRoi.toFixed(2)+'%';
    document.getElementById('roi').className='text-xl font-bold '+(s.currentRoi>=0?'text-emerald-400':'text-rose-500');
    document.getElementById('wallet').innerText=s.availableBalance.toFixed(4);
    document.getElementById('qty').innerText=s.lastQty;
    document.getElementById('sync').innerText=s.lastUpdate;
    const e=document.getElementById('err');if(s.errorMsg){e.innerText=s.errorMsg;e.classList.remove('hidden');}else{e.classList.add('hidden');}
    const hRes=await fetch('/api/history');const history=await hRes.json();
    document.getElementById('history').innerHTML=history.map(t=>\`<tr class="border-b border-slate-800/50">
    <td class="px-6 py-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td>
    <td class="px-6 py-4 text-right font-bold \${t.roi>=0?'text-emerald-400':'text-rose-500'}">\${t.roi.toFixed(2)}%</td>
    <td class="px-6 py-4 text-right font-bold text-slate-300">\${t.pnl.toFixed(4)}</td>
    <td class="px-6 py-4 text-right text-slate-500 font-bold uppercase">\${new Date(t.timestamp).toLocaleTimeString()}</td></tr>\`).join('');
    }catch(err){}}setInterval(update,1000);update();</script></body></html>
    `);
});

app.listen(PORT, () => console.log(`🌐 Engine active on port ${PORT}`));
