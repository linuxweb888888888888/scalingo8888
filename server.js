const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const PAPER_TRADING = true; 
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/ton_trading_bot?retryWrites=true&w=majority&appName=Clusterweb8888";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'SHIB/USDT:USDT'; 
const LEVERAGE = 75;
const TAKE_PROFIT = 10.0; // Tighter targets for tiny balance
const STOP_LOSS = -30.0; 
const SHIB_CONTRACT_SIZE = 1000; // Your required size

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI);

const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number,
    roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));

const BotState = mongoose.model('Bot_State', new mongoose.Schema({
    key: String, value: Number
}));

const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({
    symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now }
}));

// ==================== ENGINE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' } });

let botStatus = { active: false, side: 'IDLE', currentRoi: 0, currentPnl: 0, currentBalance: 0, availableBalance: 0, lastQty: 0, errorMsg: null, lastUpdate: 'INIT' };

async function syncAccount() {
    let balanceDoc = await BotState.findOne({ key: "paper_balance" });
    if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 1000.00 });
    botStatus.currentBalance = balanceDoc.value;
    botStatus.availableBalance = balanceDoc.value;
}

async function tradingLoop() {
    while (true) {
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;
            botStatus.lastUpdate = new Date().toLocaleTimeString();

            let activePos = await PaperPosition.findOne({ symbol: SYMBOL });

            if (activePos) {
                // --- MANAGE POSITION ---
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.lastQty = activePos.contracts;

                const priceDiff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (priceDiff * activePos.contracts * SHIB_CONTRACT_SIZE);

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AUTO_EXIT" });
                    console.log(`[EXIT] Closed ${activePos.side} at ROI: ${botStatus.currentRoi.toFixed(2)}%`);
                }
            } else {
                // --- ENTRY LOGIC ---
                botStatus.active = false;
                botStatus.side = "IDLE";
                
                const marginPerContract = (currentPrice * SHIB_CONTRACT_SIZE) / LEVERAGE;
                const maxQty = Math.floor(botStatus.availableBalance / marginPerContract);

                // DEBUG LOGS (Check your console/terminal!)
                console.log(`[DEBUG] Price: ${currentPrice} | Balance: ${botStatus.availableBalance} | Margin/Contract: ${marginPerContract.toFixed(6)} | MaxQty: ${maxQty}`);

                if (maxQty >= 1) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: maxQty });
                    botStatus.lastQty = maxQty;
                    console.log(`[ENTRY] Opened ${side.toUpperCase()} with ${maxQty} contracts`);
                }
            }
        } catch (e) { console.log("Loop Error: " + e.message); }
        await new Promise(r => setTimeout(r, 2000)); // Scan every 2 seconds
    }
}

tradingLoop();

// ==================== WEB APP ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/api/history', async (req, res) => res.json(await Trade.find().sort({ timestamp: -1 }).limit(10)));
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>SHIB Bot</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-200 p-10 font-mono">
        <h1 class="text-xl font-bold text-blue-500 mb-5">SHIB EXTREME V4 (0.0004 MODE)</h1>
        <div class="grid grid-cols-2 gap-4 mb-10">
            <div class="bg-slate-900 p-6 rounded">ROI: <span id="roi" class="text-2xl">0%</span></div>
            <div class="bg-slate-900 p-6 rounded">QTY: <span id="qty" class="text-2xl">0</span></div>
            <div class="bg-slate-900 p-6 rounded">Cash: <span id="wallet" class="text-2xl text-emerald-400">0</span></div>
            <div class="bg-slate-900 p-6 rounded">Sync: <span id="sync">...</span></div>
        </div>
        <div class="bg-slate-900 rounded overflow-hidden">
            <table class="w-full text-left text-xs"><thead class="bg-slate-800"><tr><th class="p-4">Side</th><th class="p-4">ROI%</th><th class="p-4">PnL</th></tr></thead><tbody id="history"></tbody></table>
        </div>
        <script>
            async function update(){
                const s = await (await fetch('/api/status')).json();
                document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                document.getElementById('qty').innerText = s.lastQty;
                document.getElementById('wallet').innerText = s.availableBalance.toFixed(6);
                document.getElementById('sync').innerText = s.lastUpdate;
                const h = await (await fetch('/api/history')).json();
                document.getElementById('history').innerHTML = h.map(t => \`<tr><td class="p-4">\${t.side}</td><td class="p-4">\${t.roi.toFixed(2)}%</td><td class="p-4">\${t.pnl.toFixed(6)}</td></tr>\`).join('');
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});
app.listen(PORT);
