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
mongoose.connect(MONGO_URI).then(() => console.log(`✅ Direction Engine & QTY Tracker Active`));

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number, roi: Number, pnl: Number, 
    contracts: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number, startDate: { type: Date, default: Date.now }
}));

const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({
    symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now }
}));

// ==================== MATH ENGINE (DIRECTION) ====================
let priceHistory = []; 
function getReliableDirection() {
    if (priceHistory.length < 10) return null;
    const n = priceHistory.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i; sumY += priceHistory[i];
        sumXY += i * priceHistory[i]; sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    // Sensitivity: How steep the price move must be to trigger a trade
    const sensitivity = 0.0001; 
    
    // Check slope + confirmation that price is currently moving in that direction
    if (slope > sensitivity && priceHistory[n-1] > priceHistory[n-3]) return 'buy';
    if (slope < -sensitivity && priceHistory[n-1] < priceHistory[n-3]) return 'sell';
    return null;
}

// ==================== CORE BOT ENGINE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' }, enableRateLimit: true });

let botStatus = { 
    active: false, 
    side: 'SCANNING', 
    currentRoi: 0, 
    currentPnl: 0, 
    qty: 0, 
    initialBalance: 0, 
    currentBalance: 0, 
    availableBalance: 0, 
    totalClosedRoi: 0, 
    lastUpdate: 'INIT' 
};

async function syncAccount() {
    try {
        if (PAPER_TRADING) {
            let res = await BotState.findOne({ key: "paper_balance" });
            if (!res) res = await BotState.create({ key: "paper_balance", value: 10.00 });
            botStatus.currentBalance = res.value;
            botStatus.availableBalance = res.value;
        } else {
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.currentBalance = bal.total?.USDT || 0;
            botStatus.availableBalance = bal.free?.USDT || 0;
        }
        const hist = await Trade.find();
        botStatus.totalClosedRoi = hist.reduce((sum, t) => sum + (t.roi || 0), 0);
    } catch (e) { botStatus.errorMsg = e.message; }
}

async function tradingLoop() {
    if (!PAPER_TRADING) {
        try { await htx.loadMarkets(); await htx.setLeverage(LEVERAGE, SYMBOL); } catch (e) {}
    }

    while (true) {
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;
            
            // Add to math buffer
            priceHistory.push(currentPrice);
            if (priceHistory.length > 15) priceHistory.shift();

            let activePos = PAPER_TRADING 
                ? await PaperPosition.findOne({ symbol: SYMBOL }) 
                : (await htx.fetchPositions([SYMBOL])).find(p => p.symbol === SYMBOL && p.contracts > 0);

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.qty = activePos.contracts;
                
                const entry = activePos.entryPrice || activePos.entry_price;
                const dir = (activePos.side === 'buy' || activePos.side === 'long') ? 1 : -1;
                
                botStatus.currentRoi = ((currentPrice - entry) / entry) * LEVERAGE * 100 * dir;
                botStatus.currentPnl = (currentPrice - entry) * activePos.contracts * 0.1 * dir;

                // EXIT LOGIC
                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    if (PAPER_TRADING) {
                        await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                        await PaperPosition.deleteOne({ _id: activePos._id });
                    } else {
                        await htx.createMarketOrder(SYMBOL, activePos.side === 'buy' ? 'sell' : 'buy', activePos.contracts, undefined, { 'reduceOnly': true });
                    }
                    
                    await Trade.create({ 
                        side: activePos.side, entryPrice: entry, exitPrice: currentPrice, 
                        roi: botStatus.currentRoi, pnl: botStatus.currentPnl, 
                        contracts: activePos.contracts, reason: "ALGO_EXIT" 
                    });
                    
                    botStatus.qty = 0;
                    priceHistory = []; 
                    await new Promise(r => setTimeout(r, 5000));
                }
            } else {
                // ENTRY LOGIC
                botStatus.active = false;
                botStatus.side = "SCANNING";
                botStatus.qty = 0;
                botStatus.currentRoi = 0;
                
                const direction = getReliableDirection();
                if (direction) {
                    // Calc Qty: (Balance / Margin per contract) * Leverage
                    const unitValue = currentPrice * 0.1;
                    const maxQty = Math.floor((botStatus.availableBalance / unitValue) * LEVERAGE * 0.9);
                    
                    if (maxQty >= 1) {
                        if (PAPER_TRADING) {
                            await PaperPosition.create({ symbol: SYMBOL, side: direction, entryPrice: currentPrice, contracts: maxQty });
                        } else {
                            await htx.createMarketOrder(SYMBOL, direction, maxQty);
                        }
                        botStatus.qty = maxQty;
                        console.log(`🚀 ${direction.toUpperCase()} Entry: ${maxQty} contracts`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
        } catch (e) { console.log("Engine Error: ", e.message); }
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        await new Promise(r => setTimeout(r, 1000)); // Tick every second
    }
}

tradingLoop();

// ==================== WEB DASHBOARD ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>TON Direction Bot</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#020617;color:#f8fafc;font-family:monospace;}.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;}</style></head>
    <body class="p-10"><div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-xl font-bold text-blue-500 italic">TON.DIRECTION_PRO.V6</h1>
            <div id="sync" class="text-xs text-slate-500 font-bold uppercase tracking-widest">...</div>
        </div>
        
        <div class="grid grid-cols-4 gap-6 mb-8">
            <div class="card p-6 border-t-2 border-blue-500"><div class="text-slate-500 text-[10px] mb-2 uppercase">Total ROI</div><div id="roi-total" class="text-3xl font-bold">0%</div></div>
            <div class="card p-6 border-t-2 border-emerald-500"><div class="text-slate-500 text-[10px] mb-2 uppercase">Live ROI</div><div id="roi-live" class="text-3xl font-bold">0%</div></div>
            <div class="card p-6 border-t-2 border-yellow-500"><div class="text-slate-500 text-[10px] mb-2 uppercase">Active Contracts</div><div id="qty" class="text-3xl font-bold text-yellow-400">0</div></div>
            <div class="card p-6 border-t-2 border-slate-700"><div class="text-slate-500 text-[10px] mb-2 uppercase">Balance</div><div id="bal" class="text-xl font-bold text-slate-300">...</div></div>
        </div>

        <div class="card overflow-hidden">
            <div class="p-4 bg-slate-900/50 border-b border-slate-800 text-[10px] font-bold uppercase text-slate-400 tracking-widest">Recent Trade History</div>
            <table class="w-full text-left text-xs">
                <thead class="text-slate-500 uppercase bg-slate-900/20">
                    <tr><th class="p-4">Side</th><th class="p-4">Qty</th><th class="p-4 text-right">ROI%</th><th class="p-4 text-right">Time</th></tr>
                </thead>
                <tbody id="hist"></tbody>
            </table>
        </div>
    </div><script>
        setInterval(async ()=>{
            try {
                const s = await (await fetch('/api/status')).json();
                document.getElementById('roi-total').innerText = s.totalClosedRoi.toFixed(2)+'%';
                document.getElementById('roi-live').innerText = s.currentRoi.toFixed(2)+'%';
                document.getElementById('roi-live').className = 'text-3xl font-bold ' + (s.currentRoi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                document.getElementById('qty').innerText = s.qty;
                document.getElementById('bal').innerText = '$' + s.currentBalance.toFixed(2);
                document.getElementById('sync').innerText = 'Last Sync: ' + s.lastUpdate;
                
                const h = await (await fetch('/api/history')).json();
                document.getElementById('hist').innerHTML = h.map(t=>\`<tr class="border-b border-slate-800">
                    <td class="p-4 font-bold \${t.side==='buy'?'text-emerald-500':'text-rose-500'}">\${t.side.toUpperCase()}</td>
                    <td class="p-4 text-slate-300">\${t.contracts || 0}</td>
                    <td class="p-4 text-right font-bold \${t.roi >= 0 ? 'text-emerald-400' : 'text-rose-500'}">\${t.roi.toFixed(2)}%</td>
                    <td class="p-4 text-right text-slate-500">\${new Date(t.timestamp).toLocaleTimeString()}</td></tr>\`).join('');
            } catch(e) {}
        }, 1000);
    </script></body></html>`);
});
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));
