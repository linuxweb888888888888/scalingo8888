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
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://user:pass@cluster.mongodb.net/botdb";
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    initialBalance: { type: Number, default: 0 },
    storedRealizedProfit: { type: Number, default: 0 },
    storedProfitPct: { type: Number, default: 0 }
});
const BotModel = mongoose.model('BotConfig_V30', BotSchema);

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
    realizedProfit: 0,
    profitPct: 0,      
    walletBalance: 0,  
    initialBalance: 0, 
    maxSafeBase: 0,
    safetyOrdersFilled: 0,
    distToNext: 0, // % Distance to next step
    settings: {
        baseOrder: 0, 
        priceDrop: 0.1,      
        volumeMult: 1.2,     
        takeProfit: 1.5, 
        maxSteps: 10
    }
};

// ==================== HTX API SIGNER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        const [posRes, accRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol }),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' })
        ]);

        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        
        // Update Wallet Balance
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance) || 0;
                const unrealized = pos ? (parseFloat(pos.unrealized_pnl) || 0) : 0;
                botState.walletBalance = equity - unrealized;
                
                if (botState.initialBalance <= 0) {
                    botState.initialBalance = botState.walletBalance;
                    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance }, { upsert: true });
                }
            }
        }

        // Calculate Max Base Order size based on wallet
        if (botState.currentPrice > 0 && botState.walletBalance > 0) {
            const m = botState.settings.volumeMult, n = botState.settings.maxSteps;
            const multiplierSum = (1 - Math.pow(m, n + 1)) / (1 - m);
            const rawBase = (botState.walletBalance * config.leverage) / (multiplierSum * botState.currentPrice * 1000);
            botState.maxSafeBase = Math.floor(rawBase * 0.85);
            botState.settings.baseOrder = botState.maxSafeBase;
        }

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.totalContracts = parseFloat(pos.volume);
            botState.roi = parseFloat(pos.profit_rate) * 100;

            // --- DISTANCE CALCULATION ---
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            const diff = botState.currentPrice - triggerPrice;
            botState.distToNext = Math.max(0, (diff / botState.currentPrice) * 100);

            // TAKE PROFIT logic
            if (botState.roi >= botState.settings.takeProfit) {
                const closeRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.totalContracts,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (closeRes?.status === 'ok') {
                    setTimeout(async () => {
                        const finalAcc = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
                        const newStaticBal = parseFloat(finalAcc.data[0].margin_balance);
                        botState.realizedProfit = newStaticBal - botState.initialBalance;
                        botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
                        await BotModel.updateOne({ id: "htx_martingale" }, { storedRealizedProfit: botState.realizedProfit, storedProfitPct: botState.profitPct });
                    }, 2000);
                    botState.safetyOrdersFilled = 0;
                }
            } 
            // SAFETY ORDER logic
            else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.max(1, Math.floor(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
            }
        } else {
            // OPEN INITIAL POSITION
            botState.distToNext = 0;
            if (botState.maxSafeBase > 0) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: botState.settings.baseOrder,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            }
        }
    } catch (e) { console.log("Logic Error", e); }
    botState.isTrading = false;
}

// ==================== STARTUP & WS ====================
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
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
                    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
                } catch (e) {}
            }
        });
    });
    setInterval(runLogic, 3000);
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Martingale V3</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .ui-card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.03); padding: 24px; border: 1px solid #f0f0f0; }
    </style>
</head>
<body class="bg-slate-50 p-4 md:p-12 text-slate-900">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-xl font-bold tracking-tight">HTX MARTINGALE</h1>
                <p class="text-xs font-bold text-slate-400 uppercase tracking-widest">${config.symbol} • ${config.leverage}X</p>
            </div>
            <div class="flex items-center gap-3">
                <div class="h-2 w-2 bg-green-500 rounded-full animate-pulse"></div>
                <span class="text-xs font-bold uppercase">System Active</span>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div class="ui-card"><p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Profit</p><p id="p1" class="text-xl font-mono font-bold text-green-600">$0.00</p></div>
            <div class="ui-card"><p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Gain</p><p id="p2" class="text-xl font-mono font-bold text-green-600">0.00%</p></div>
            <div class="ui-card"><p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Live ROI</p><p id="roi" class="text-xl font-mono font-bold text-slate-300">0.00%</p></div>
            <div class="ui-card"><p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Wallet</p><p id="bal" class="text-xl font-mono font-bold text-slate-700">$0.00</p></div>
        </div>

        <!-- Progress Bar Section -->
        <div class="ui-card mb-6">
            <div class="flex justify-between items-end mb-4">
                <div>
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Safety Steps Filled</p>
                    <p id="stepText" class="text-4xl font-mono font-bold text-slate-800">0 / 10</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-bold text-slate-400 uppercase mb-1">Dist. to Next Step</p>
                    <p id="distText" class="text-4xl font-mono font-bold text-orange-500">0.000%</p>
                </div>
            </div>
            
            <!-- Progress Bar -->
            <div class="w-full bg-slate-100 rounded-full h-4 overflow-hidden flex">
                <div id="progressBar" class="bg-blue-600 h-full transition-all duration-500" style="width: 0%"></div>
            </div>
            
            <div class="flex justify-between mt-3">
                <span class="text-[10px] font-bold text-slate-400 uppercase">Base Entry</span>
                <span class="text-[10px] font-bold text-slate-400 uppercase">Liquidation Risk Zone</span>
            </div>
        </div>

        <!-- Footer / Controls -->
        <div class="flex flex-col md:flex-row justify-between items-center gap-4 bg-white p-6 rounded-2xl border border-slate-100">
            <div class="text-center md:text-left">
                <p class="text-[10px] font-bold text-slate-400 uppercase">Current Market Price</p>
                <p id="curPrice" class="text-lg font-mono font-bold text-blue-600">0.00000000</p>
            </div>
            <div class="flex gap-4">
                <button onclick="resetStats()" class="px-6 py-2 bg-red-50 text-red-600 text-[10px] font-bold rounded-lg hover:bg-red-100 transition-colors uppercase">Reset Session</button>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-xl font-mono font-bold ' + (d.roi >= 0 ? 'text-green-500' : 'text-red-500');
                
                document.getElementById('bal').innerText = '$' + d.walletBalance.toFixed(2);
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                
                // Progress & Distance
                document.getElementById('stepText').innerText = d.safetyOrdersFilled + ' / ' + d.settings.maxSteps;
                document.getElementById('distText').innerText = d.distToNext.toFixed(3) + '%';
                
                const progressPct = (d.safetyOrdersFilled / d.settings.maxSteps) * 100;
                const bar = document.getElementById('progressBar');
                bar.style.width = progressPct + '%';
                
                if (progressPct > 80) bar.className = "bg-red-500 h-full transition-all";
                else if (progressPct > 50) bar.className = "bg-orange-500 h-full transition-all";
                else bar.className = "bg-blue-600 h-full transition-all";
                
            } catch (e) {}
        }
        async function resetStats() { if(confirm("Reset profit tracking?")) await fetch('/api/reset-stats', {method:'POST'}); update(); }
        setInterval(update, 1000); 
        update();
    </script>
</body>
</html>`);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.walletBalance; 
    botState.realizedProfit = 0; botState.profitPct = 0;
    await BotModel.updateOne({ id: "htx_martingale" }, { initialBalance: botState.initialBalance, storedRealizedProfit: 0, storedProfitPct: 0 }, { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, boot);
