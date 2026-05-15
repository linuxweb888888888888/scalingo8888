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
const TAKE_PROFIT = 10.0; 
const STOP_LOSS = -30.0; 
const CONTRACT_SIZE = 1000; 

// ==================== DATABASE ====================
mongoose.connect(MONGO_URI);
const Trade = mongoose.model('Trade_History', new mongoose.Schema({
    side: String, entryPrice: Number, exitPrice: Number, roi: Number, pnl: Number, reason: String, timestamp: { type: Date, default: Date.now }
}));
const BotState = mongoose.model('Bot_State', new mongoose.Schema({ key: String, value: Number }));
const PaperPosition = mongoose.model('Paper_Position', new mongoose.Schema({ symbol: String, side: String, entryPrice: Number, contracts: Number, timestamp: { type: Date, default: Date.now } }));

// ==================== ENGINE ====================
const htx = new ccxt.htx({ apiKey: API_KEY, secret: API_SECRET, options: { defaultType: 'swap' }, enableRateLimit: true });

let botStatus = { active: false, side: 'IDLE', currentRoi: 0, currentPnl: 0, currentBalance: 0, availableBalance: 0, lastQty: 0, errorMsg: null, lastUpdate: 'INIT' };

async function syncAccount() {
    try {
        if (PAPER_TRADING) {
            let balanceDoc = await BotState.findOne({ key: "paper_balance" });
            if (!balanceDoc) balanceDoc = await BotState.create({ key: "paper_balance", value: 1000.00 });
            botStatus.currentBalance = balanceDoc.value;
            botStatus.availableBalance = balanceDoc.value;
        } else {
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.currentBalance = bal.total.USDT || 0;
            botStatus.availableBalance = bal.free.USDT || 0;
        }
    } catch (e) { botStatus.errorMsg = "Sync Failed"; }
}

async function tradingLoop() {
    // IMPORTANT: Load markets to get the correct precision for SHIB
    await htx.loadMarkets();

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

                const priceDiff = activePos.side === 'buy' ? (currentPrice - activePos.entryPrice) : (activePos.entryPrice - currentPrice);
                botStatus.currentRoi = (priceDiff / activePos.entryPrice) * LEVERAGE * 100;
                botStatus.currentPnl = (priceDiff * activePos.contracts * CONTRACT_SIZE); 

                if (botStatus.currentRoi >= TAKE_PROFIT || botStatus.currentRoi <= STOP_LOSS) {
                    if (PAPER_TRADING) {
                        await BotState.updateOne({ key: "paper_balance" }, { $inc: { value: botStatus.currentPnl } });
                        await PaperPosition.deleteOne({ _id: activePos._id });
                    } else {
                        // FIX: Format quantity for exit
                        const qty = htx.amountToPrecision(SYMBOL, activePos.contracts);
                        await htx.createMarketOrder(SYMBOL, (activePos.side === 'buy' ? 'sell' : 'buy'), qty, undefined, { 'reduceOnly': true });
                    }
                    await Trade.create({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: currentPrice, roi: botStatus.currentRoi, pnl: botStatus.currentPnl, reason: "AUTO_EXIT" });
                }
            } else {
                botStatus.active = false;
                botStatus.side = "IDLE";

                const marginReq = (currentPrice * CONTRACT_SIZE) / LEVERAGE;
                let maxQty = Math.floor(botStatus.availableBalance / marginReq);

                if (maxQty >= 1) {
                    const side = Math.random() > 0.5 ? 'buy' : 'sell';
                    
                    if (PAPER_TRADING) {
                        await PaperPosition.create({ symbol: SYMBOL, side: side, entryPrice: currentPrice, contracts: maxQty });
                    } else {
                        // FIX: Use amountToPrecision to fix Error 1499
                        const validQty = htx.amountToPrecision(SYMBOL, maxQty);
                        await htx.setLeverage(LEVERAGE, SYMBOL);
                        await htx.createMarketOrder(SYMBOL, side, validQty);
                    }
                    botStatus.lastQty = maxQty;
                    botStatus.errorMsg = null;
                }
            }
        } catch (e) { 
            botStatus.errorMsg = e.message.substring(0, 50); 
            console.log("HTX Error:", e.message); // This will show why 1499 is happening
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

tradingLoop();

// (Rest of the express code remains exactly the same as your previous version)
const app = express();
app.get('/api/status', (req, res) => res.json(botStatus));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;font-family:monospace;padding:50px;">
    <h1>SHIB BOT</h1><div id="data">Loading...</div>
    <script>setInterval(async()=>{const s=await(await fetch('/api/status')).json();
    document.getElementById('data').innerHTML='ROI: '+s.currentRoi.toFixed(2)+'% | QTY: '+s.lastQty+' | Cash: '+s.availableBalance.toFixed(6);},1000);</script>
    </body></html>`);
});
app.listen(PORT);
