require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    initialBalance: { type: Number, default: 0 },
    storedRealizedProfit: { type: Number, default: 0 }, // THE STATIC PROFIT
    storedProfitPct: { type: Number, default: 0 }
});
const BotModel = mongoose.model('BotConfig_V25', BotSchema);

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

let botState = {
    isRunning: true,
    isTrading: false,
    currentPrice: 0,
    avgPrice: 0,
    totalContracts: 0,
    roi: 0, 
    pnl: 0, 
    realizedProfit: 0, // This is the one we will keep static
    profitPct: 0,
    walletBalance: 0, 
    initialBalance: 0,
    maxSafeBase: 0,
    settings: {
        baseOrder: 6000,
        autoScale: true,
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.0,    
        maxSteps: 10
    }
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 8000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading || botState.currentPrice <= 0) return;
    botState.isTrading = true;
    try {
        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        // SYNC WALLET BALANCE (For UI display only, not for profit calculation)
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                botState.walletBalance = equity - unrealized;
                
                // If this is the first run, set the baseline
                if (botState.initialBalance <= 0) {
                    botState.initialBalance = botState.walletBalance;
                    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance }, { upsert: true });
                }
            }
        }

        if (pos) {
            // IN TRADE: Update ROI and PNL for UI, but leave REALIZED PROFIT STATIC
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            const priceMovePct = ((botState.currentPrice - botState.avgPrice) / botState.avgPrice) * 100;
            botState.roi = priceMovePct * config.leverage;
            botState.pnl = parseFloat(pos.unrealized_pnl);

            // TAKE PROFIT TRIGGER
            if (priceMovePct >= botState.settings.takeProfit) {
                console.log("🎯 Take Profit Hit. Closing and updating static profit.");
                const closeRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });

                // ONLY UPDATE STATIC PROFIT IF CLOSE WAS SUCCESSFUL
                if (closeRes && closeRes.status === 'ok') {
                    // Give the exchange 1 second to settle the balance
                    setTimeout(async () => {
                        const finalAcc = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
                        const newBal = parseFloat(finalAcc.data[0].margin_balance);
                        botState.realizedProfit = newBal - botState.initialBalance;
                        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                        
                        // Save to DB so it stays after restart
                        await BotModel.updateOne({ id: "htx_martingale" }, { 
                            storedRealizedProfit: botState.realizedProfit,
                            storedProfitPct: botState.profitPct
                        });
                    }, 1500);
                }
                botState.safetyOrdersFilled = 0;
            } else {
                // Safety Orders
                const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
                if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                    botState.safetyOrdersFilled++;
                    const vol = Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled));
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: vol,
                        direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                    });
                }
            }
        } else if (botState.maxSafeBase > 0) {
            // No position: Open new trade
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.safetyOrdersFilled = 0;
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== STARTUP ====================
async function boot() {
    const data = await BotModel.findOne({ id: "htx_martingale" });
    if (data) {
        botState.initialBalance = data.initialBalance || 0;
        botState.realizedProfit = data.storedRealizedProfit || 0;
        botState.profitPct = data.storedProfitPct || 0;
    }
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (err) return;
            try {
                const msg = JSON.parse(dezipped.toString());
                if (msg.tick && msg.tick.close) {
                    botState.currentPrice = parseFloat(msg.tick.close);
                    // MATH FOR MAX BASE
                    const m = 1.2, n = 10;
                    const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
                    const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
                    botState.maxSafeBase = Math.floor(rawBase * 0.75);
                    botState.settings.baseOrder = botState.maxSafeBase;
                }
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            } catch (e) {}
        });
    });
    setInterval(runLogic, 3000);
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TradeBot | Static Profit</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@700&display=swap" rel="stylesheet">
</head>
<body class="bg-gray-50 p-8 font-sans">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold uppercase tracking-tight">🤖 HTX Martingale V3</h1>
            <div id="status" class="bg-green-500 text-white px-4 py-1 rounded-full text-xs font-bold">ACTIVE</div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase mb-2">Realized Profit (Static)</p>
                <p id="p1" class="text-2xl font-mono text-green-600 tracking-tighter">$0.0000</p>
            </div>
            <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase mb-2">Total Gain</p>
                <p id="p2" class="text-2xl font-mono text-green-600 tracking-tighter">0.00%</p>
            </div>
            <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase mb-2">Live ROI</p>
                <p id="roi" class="text-2xl font-mono text-gray-400 tracking-tighter">0.00%</p>
            </div>
            <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <p class="text-xs font-bold text-gray-400 uppercase mb-2">Equity</p>
                <p id="bal" class="text-2xl font-mono text-gray-800 tracking-tighter">$0.0000</p>
            </div>
        </div>
        <div class="bg-white p-12 rounded-xl shadow-sm border border-gray-100 text-center">
            <p class="text-gray-400 text-xs font-bold uppercase mb-2">Recommended Base Order</p>
            <p id="maxBase" class="text-7xl font-mono font-bold text-black tracking-tighter">0</p>
            <div class="mt-6 flex justify-center gap-4 text-xs font-bold text-blue-500 uppercase">
                <span>TP: 1.0%</span><span>•</span><span>Drop: 0.1%</span><span>•</span><span>Mult: 1.2x</span>
            </div>
            <button onclick="resetStats()" class="mt-10 text-xs text-red-500 font-bold border border-red-100 px-6 py-2 rounded-full hover:bg-red-50 transition">RESET ALL STATS</button>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').className = 'text-2xl font-mono ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('maxBase').innerText = d.maxSafeBase.toLocaleString();
            } catch (e) {}
        }
        async function resetStats() { if(confirm("Reset everything?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); update();
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.walletBalance; 
    botState.realizedProfit = 0;
    botState.profitPct = 0;
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, boot);
