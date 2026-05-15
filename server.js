const express = require('express');
const mongoose = require('mongoose');
const ccxt = require('ccxt');

// ==================== CONFIGURATION ====================
const PAPER_TRADING = false; // SET TO FALSE FOR LIVE TRADING
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const MONGO_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/ton_trading_bot?retryWrites=true&w=majority&appName=Clusterweb8888";

const PORT = process.env.PORT || 3000;
const SYMBOL = 'SHIB/USDT:USDT'; 
const LEVERAGE = 75;
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 
const CONTRACT_SIZE = 1000; // Adjust based on HTX contract specifications

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI);
const Trade = mongoose.model('Trade_History', new mongoose.Schema({ side: String, entryPrice: Number, exitPrice: Number, roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now } }));
const BotState = mongoose.model('Bot_State', new mongoose.Schema({ key: String, value: Number }));
const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({ symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now } }));

// ==================== ENGINE ====================
const htx = new ccxt.htx({ 
    apiKey: API_KEY, 
    secret: API_SECRET, 
    options: { defaultType: 'swap' }, 
    enableRateLimit: true 
});

let botStatus = { active: false, side: 'IDLE', currentRoi: 0, currentPnl: 0, currentBalance: 0, availableBalance: 0, lastQty: 0, errorMsg: null, lastUpdate: 'INIT' };

async function syncAccount() {
    if (PAPER_TRADING) {
        let balanceDoc = await BotState.findOne({ key: "paper_balance" });
        if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 1000.00 });
        botStatus.currentBalance = balanceDoc.value;
        botStatus.availableBalance = balanceDoc.value;
    } else {
        // LIVE: Fetch actual USDT balance from HTX Futures account
        const balance = await htx.fetchBalance();
        botStatus.currentBalance = balance.total.USDT || 0;
        botStatus.availableBalance = balance.free.USDT || 0;
    }
}

async function tradingLoop() {
    console.log("🚀 Bot Starting...");
    await htx.loadMarkets();
    
    // Set leverage on the exchange for live trading
    if (!PAPER_TRADING) {
        try {
            await htx.setLeverage(LEVERAGE, SYMBOL);
            console.log(`✅ Leverage set to ${LEVERAGE}x on HTX`);
        } catch (e) {
            console.log("⚠️ Leverage set error (might already be set):", e.message);
        }
    }

    while (true) {
        botStatus.lastUpdate = new Date().toLocaleTimeString();
        try {
            await syncAccount();
            const ticker = await htx.fetchTicker(SYMBOL);
            const currentPrice = ticker.last;

            // We use the Database to track if our bot has an open position
            let activePos = await PaperPosition.findOne({ symbol: SYMBOL });

            if (activePos) {
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.lastQty = activePos.contracts;
                
                const priceDiff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (priceDiff * activePos.contracts * CONTRACT_SIZE); 

                // EXIT LOGIC (Take Profit or Stop Loss)
                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    console.log(`🎯 Closing Position: ROI ${botStatus.currentRoi.toFixed(2)}%`);

                    if (!PAPER_TRADING) {
                        const closeSide = activePos.side === 'buy' ? 'sell' : 'buy';
                        // Execute LIVE Market Order to Close
                        await htx.createOrder(SYMBOL, 'market', closeSide, activePos.contracts);
                    } else {
                        await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                    }

                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AUTO_EXIT" });
                    await PaperPosition.deleteOne({ _id: activePos._id });
                    botStatus.active = false;
                }
            } else {
                // ENTRY LOGIC
                botStatus.active = false;
                botStatus.side = "IDLE";
                botStatus.currentRoi = 0;

                const marginNeededForOne = (currentPrice * CONTRACT_SIZE) / LEVERAGE;
                const maxQty = Math.floor((botStatus.availableBalance * 0.9) / marginNeededForOne); // Use 90% of balance to be safe

                if (maxQty >= 1) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    
                    console.log(`[LOG] Price: ${currentPrice} | Opening ${side.toUpperCase()} with ${maxQty} contracts`);

                    if (!PAPER_TRADING) {
                        // Execute LIVE Market Order to Open
                        await htx.createOrder(SYMBOL, 'market', side, maxQty);
                    }

                    await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: maxQty });
                    botStatus.lastQty = maxQty;
                    botStatus.errorMsg = null;
                } else {
                    botStatus.errorMsg = `Inadequate Funds. Need ${marginNeededForOne.toFixed(4)} USDT`;
                }
            }
        } catch (e) { 
            console.log("HTX/Engine Error:", e.message);
            botStatus.errorMsg = e.message.substring(0, 50); 
        }
        await new Promise(r => setTimeout(r, 5000)); // 5 second heartbeat
    }
}

tradingLoop();

// ==================== WEB APP (Unchanged) ====================
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>SHIB Bot Live</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-slate-200 p-10 font-mono">
        <h1 class="text-blue-500 font-bold mb-4">SHIB EXTREME V4 ${PAPER_TRADING ? '(PAPER)' : '(LIVE)'}</h1>
        <div class="grid grid-cols-2 gap-4 mb-4">
            <div class="bg-slate-900 p-4 rounded">ROI: <span id="roi">0%</span></div>
            <div class="bg-slate-900 p-4 rounded">QTY: <span id="qty">0</span></div>
            <div class="bg-slate-900 p-4 rounded text-emerald-400">Wallet: <span id="wallet">0</span></div>
            <div class="bg-slate-900 p-4 rounded text-blue-400">Sync: <span id="sync">...</span></div>
        </div>
        <div id="log-display" class="bg-rose-950/30 text-rose-400 p-4 rounded text-xs border border-rose-900/50">Waiting for logs...</div>
        <script>
            async function update(){
                try {
                    const res = await fetch('/api/status');
                    const s = await res.json();
                    document.getElementById('roi').innerText = s.currentRoi.toFixed(2) + '%';
                    document.getElementById('qty').innerText = s.lastQty;
                    document.getElementById('wallet').innerText = s.availableBalance.toFixed(4) + ' USDT';
                    document.getElementById('sync').innerText = s.lastUpdate;
                    if(s.errorMsg) document.getElementById('log-display').innerText = "STATUS: " + s.errorMsg;
                    else document.getElementById('log-display').innerText = "STATUS: Running Healthy";
                } catch(e) {}
            }
            setInterval(update, 2000);
        </script>
    </body></html>`);
});
app.listen(PORT, () => console.log(`Web Dashboard on port ${PORT}`));
