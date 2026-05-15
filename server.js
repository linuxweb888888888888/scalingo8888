const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const PAPER_TRADING = false; 
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/ton_trading_bot?retryWrites=true&w=majority&appName=Clusterweb8888";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'SHIB/USDT:USDT'; 
const LEVERAGE = 75;
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 
const CONTRACT_SIZE = 1000; 

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI);
const Trade = mongoose.model('Trade_History', new mongoose.Schema({ side: String, entryPrice: Number, exitPrice: Number, roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now } }));
const BotState = mongoose.model('Bot_State', new mongoose.Schema({ key: String, value: Number }));
const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({ symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now } }));

// ==================== ENGINE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' }, enableRateLimit: true });

let botStatus = { active: false, side: 'IDLE', currentRoi: 0, currentPnl: 0, currentBalance: 0, availableBalance: 0, lastQty: 0, errorMsg: null, lastUpdate: 'INIT' };

async function syncAccount() {
    let balanceDoc = await BotState.findOne({ key: "paper_balance" });
    if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 1000.00 });
    botStatus.currentBalance = balanceDoc.value;
    botStatus.availableBalance = balanceDoc.value;
}

async function tradingLoop() {
    await htx.loadMarkets();
    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;

            let activePos = await PaperPosition.findOne({ symbol: SYMBOL });

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.lastQty = activePos.contracts;
                const priceDiff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (priceDiff * activePos.contracts * CONTRACT_SIZE); 

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AUTO_EXIT" });
                }
            } else {
                botStatus.active = false;
                botStatus.side = "IDLE";
                botStatus.currentRoi = 0;

                // --- DEBUG LOGGING START ---
                const marginNeededForOne = (currentPrice * CONTRACT_SIZE) / LEVERAGE;
                const maxQty = Math.floor(botStatus.availableBalance / marginNeededForOne);

                console.log(`[LOG] Price: ${currentPrice} | Balance: ${botStatus.availableBalance.toFixed(6)} | Needed for 1: ${marginNeededForOne.toFixed(6)} | Result Qty: ${maxQty}`);

                if (maxQty >= 1) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: maxQty });
                    botStatus.lastQty = maxQty;
                    console.log(`✅ Opened ${side.toUpperCase()} with ${maxQty} contracts`);
                } else {
                    botStatus.errorMsg = `Need ${marginNeededForOne.toFixed(6)} USDT but only have ${botStatus.availableBalance.toFixed(6)}`;
                }
                // --- DEBUG LOGGING END ---
            }
        } catch (e) { 
            console.log("HTX Error:", e.message);
            botStatus.errorMsg = e.message.substring(0, 50); 
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

tradingLoop();

// ==================== WEB APP ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>SHIB Bot</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-200 p-10 font-mono">
        <h1 class="text-blue-500 font-bold mb-4">SHIB EXTREME V4</h1>
        <div class="grid grid-cols-2 gap-4 mb-4">
            <div class="bg-slate-900 p-4 rounded">ROI: <span id="roi">0%</span></div>
            <div class="bg-slate-900 p-4 rounded">QTY: <span id="qty">0</span></div>
            <div class="bg-slate-900 p-4 rounded text-emerald-400">Cash: <span id="wallet">0</span></div>
            <div class="bg-slate-900 p-4 rounded text-blue-400">Sync: <span id="sync">...</span></div>
        </div>
        <div id="log-display" class="bg-rose-950/30 text-rose-400 p-4 rounded text-xs border border-rose-900/50">Waiting for logs...</div>
        <script>
            async function update(){
                const res = await fetch('/api/status');
                const s = await res.json();
                document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                document.getElementById('qty').innerText = s.lastQty;
                document.getElementById('wallet').innerText = s.availableBalance.toFixed(6);
                document.getElementById('sync').innerText = s.lastUpdate;
                if(s.errorMsg) document.getElementById('log-display').innerText = "WHY NO TRADE: " + s.errorMsg;
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});
app.listen(PORT);
