const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ MongoDB Connected Successfully'))
    .catch(err => console.error('🚨 MongoDB Connection Error:', err));

const UserModel = mongoose.model('User_V4', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    // Account 1 (Long)
    apiKey1: { type: String, default: process.env.HTX_API_KEY_1 || "" },
    apiSecret1: { type: String, default: process.env.HTX_SECRET_KEY_1 || "" },
    config1: { type: Object, default: {} },
    activePos1: { type: Object, default: null },
    // Account 2 (Short)
    apiKey2: { type: String, default: process.env.HTX_API_KEY_2 || "" },
    apiSecret2: { type: String, default: process.env.HTX_SECRET_KEY_2 || "" },
    config2: { type: Object, default: {} },
    activePos2: { type: Object, default: null },
    
    liveTradingEnabled: { type: Boolean, default: false },
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V4', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, accountNum: Number, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, netPnl: Number, roiPct: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const DEFAULT_CFG = {
    htxSymbol: 'SHIB/USDT:USDT', binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, 
    takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, maxContracts: 100, fees: { taker: 0.0004 }
};

const globalMarketData = { binance: { mid: 0 }, tickBuffer: [], mlSignal: { confidence: 0, type: 'flat' } };
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== ML ENGINE (NO VISUALS, LOGIC ONLY) ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000
    ];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getFeatures(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    let w = [0, 0], b = 0, lr = 0.05;
    for (let e = 0; e < 15; e++) {
        for (let i = 0; i < X.length; i++) {
            let pred = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    let cur = getFeatures(prices.length - 1);
    let finalPred = 1 / (1 + Math.exp(-(w[0]*cur[0] + w[1]*cur[1] + b)));
    return { confidence: Math.abs(finalPred - 0.5) * 200, type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== USER BOT INSTANCE (DUAL ACCOUNT) ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString();
        this.liveTradingEnabled = user.liveTradingEnabled;
        
        // Settings are separate for Account 1 (Long) and Account 2 (Short)
        this.config1 = { ...DEFAULT_CFG, ...(user.config1 || {}) };
        this.config2 = { ...DEFAULT_CFG, ...(user.config2 || {}) };
        
        this.activePos1 = user.activePos1 || null; // Account 1 (Long)
        this.activePos2 = user.activePos2 || null; // Account 2 (Short)
        
        this.initExchanges(user);
    }

    initExchanges(user) {
        const createEx = (key, secret) => new ccxt.pro.htx({ 
            apiKey: key, secret: secret, agent: keepAliveAgent, 
            options: { defaultType: 'swap', positionMode: 'hedged' } 
        });
        this.htx1 = createEx(user.apiKey1, user.apiSecret1); // For Longs
        this.htx2 = createEx(user.apiKey2, user.apiSecret2); // For Shorts
    }

    async evaluate() {
        const sig = globalMarketData.mlSignal;
        const mid = globalMarketData.binance.mid;
        if (!mid) return;

        // ACCOUNT 1: Restricted to LONG
        if (!this.activePos1 && sig.type === 'bull' && sig.confidence >= this.config1.mlThreshold) {
            await this.openPosition(1, 'long', mid);
        } else if (this.activePos1) {
            await this.checkExitOrDca(1, mid);
        }

        // ACCOUNT 2: Restricted to SHORT
        if (!this.activePos2 && sig.type === 'bear' && sig.confidence >= this.config2.mlThreshold) {
            await this.openPosition(2, 'short', mid);
        } else if (this.activePos2) {
            await this.checkExitOrDca(2, mid);
        }
    }

    async openPosition(accNum, side, price) {
        const config = accNum === 1 ? this.config1 : this.config2;
        const htx = accNum === 1 ? this.htx1 : this.htx2;
        const contracts = config.baseContracts;
        
        console.log(`[Acc ${accNum}] Opening ${side.toUpperCase()}...`);
        if (this.liveTradingEnabled) {
            try {
                const orderSide = side === 'long' ? 'buy' : 'sell';
                await htx.createMarketOrder(config.htxSymbol, orderSide, contracts, undefined, { offset: 'open' });
            } catch (e) { console.error(`Acc ${accNum} Open Error:`, e.message); return; }
        }

        const sizeUsd = contracts * config.contractSize * price;
        const pos = { side, entryPrice: price, contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, dcaStep: 0, lastDcaTime: Date.now() };
        
        if (accNum === 1) this.activePos1 = pos; else this.activePos2 = pos;
        await this.save();
    }

    async checkExitOrDca(accNum, currentPrice) {
        const pos = accNum === 1 ? this.activePos1 : this.activePos2;
        const config = accNum === 1 ? this.config1 : this.config2;
        
        const sideMult = pos.side === 'long' ? 1 : -1;
        const roi = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;

        // EXIT LOGIC
        if (roi >= config.takeProfitPct || roi <= config.stopLossPct) {
            await this.closePosition(accNum, roi >= config.takeProfitPct ? "TAKE_PROFIT" : "STOP_LOSS", currentPrice, roi);
            return;
        }

        // DCA LOGIC
        if (roi <= -config.dcaRoiThresholdPct && (Date.now() - pos.lastDcaTime > 30000)) {
            const htx = accNum === 1 ? this.htx1 : this.htx2;
            const contractsToAdd = Math.floor(pos.contracts * config.dcaMultiplier);
            
            if (pos.contracts + contractsToAdd > config.maxContracts) return;

            console.log(`[Acc ${accNum}] DCA Adding ${contractsToAdd} contracts...`);
            if (this.liveTradingEnabled) {
                try {
                    const orderSide = pos.side === 'long' ? 'buy' : 'sell';
                    await htx.createMarketOrder(config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open' });
                } catch (e) { return; }
            }

            const addedSize = contractsToAdd * config.contractSize * currentPrice;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (currentPrice * addedSize)) / (pos.size + addedSize);
            pos.size += addedSize;
            pos.contracts += contractsToAdd;
            pos.marginUsed = pos.size / FORCED_LEVERAGE;
            pos.dcaStep++;
            pos.lastDcaTime = Date.now();
            await this.save();
        }
    }

    async closePosition(accNum, reason, price, roi) {
        const pos = accNum === 1 ? this.activePos1 : this.activePos2;
        const config = accNum === 1 ? this.config1 : this.config2;
        const htx = accNum === 1 ? this.htx1 : this.htx2;

        if (this.liveTradingEnabled) {
            try {
                const orderSide = pos.side === 'long' ? 'sell' : 'buy';
                await htx.createMarketOrder(config.htxSymbol, orderSide, pos.contracts, undefined, { reduceOnly: true, offset: 'close' });
            } catch (e) { console.error(`Acc ${accNum} Close Error:`, e.message); }
        }

        await TradeModel.create({ userId: this.userId, side: pos.side, accountNum: accNum, entryPrice: pos.entryPrice, exitPrice: price, contracts: pos.contracts, marginUsed: pos.marginUsed, roiPct: roi, exitReason: reason });
        
        if (accNum === 1) this.activePos1 = null; else this.activePos2 = null;
        await this.save();
    }

    async save() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePos1: this.activePos1, activePos2: this.activePos2, config1: this.config1, config2: this.config2 } });
    }
}

// ==================== WORKER MANAGER & STREAM ====================
const activeWorkers = new Map();

async function startEngine() {
    await publicBinance.loadMarkets();
    const users = await UserModel.find({});
    users.forEach(u => activeWorkers.set(u._id.toString(), new UserTradeInstance(u)));

    (async () => {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(DEFAULT_CFG.binanceSymbol);
                globalMarketData.binance.mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.tickBuffer.push(globalMarketData.binance.mid);
                if (globalMarketData.tickBuffer.length > 200) globalMarketData.tickBuffer.shift();
                
                globalMarketData.mlSignal = calculateMLSignal(globalMarketData.tickBuffer, 50);

                for (const worker of activeWorkers.values()) {
                    worker.evaluate().catch(() => {});
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS API ====================
const app = express(); app.use(express.json());

// Simplified Auth for keeping the code small
app.post('/api/auth/login', async (req, res) => {
    const user = await UserModel.findOne({ email: req.body.email });
    if (!user) return res.status(400).json({ error: 'User not found' });
    const token = crypto.randomBytes(16).toString('hex');
    user.token = token; await user.save();
    res.json({ token, name: user.name });
});

app.get('/api/data', async (req, res) => {
    const token = req.headers['authorization'];
    const user = await UserModel.findOne({ token });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const worker = activeWorkers.get(user._id.toString());
    const trades = await TradeModel.find({ userId: user._id.toString() }).sort({ timestamp: -1 }).limit(10);
    res.json({
        activePos1: worker.activePos1,
        activePos2: worker.activePos2,
        config1: worker.config1,
        config2: worker.config2,
        liveTradingEnabled: worker.liveTradingEnabled,
        trades
    });
});

app.post('/api/user/config', async (req, res) => {
    const user = await UserModel.findOne({ token: req.headers['authorization'] });
    const worker = activeWorkers.get(user._id.toString());
    if (req.body.accNum === 1) worker.config1 = { ...worker.config1, ...req.body.config };
    else worker.config2 = { ...worker.config2, ...req.body.config };
    await worker.save();
    res.json({ status: 'ok' });
});

// ==================== FRONTEND (MODIFIED: NO CHART/ML GAUGE) ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TradeBotPille | Dual Hedged Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>body { font-family: 'Inter', sans-serif; background: #f9fafb; }</style>
</head>
<body class="p-4 sm:p-8">
    <div id="auth-box" class="max-w-md mx-auto bg-white p-8 rounded-xl shadow-lg mt-20">
        <h2 class="text-2xl font-bold mb-6 text-center">Engine Login</h2>
        <input id="email" type="email" placeholder="Email" class="w-full border p-3 rounded mb-4">
        <input id="pass" type="password" placeholder="Password" class="w-full border p-3 rounded mb-6">
        <button onclick="login()" class="w-full bg-black text-white p-3 rounded font-bold">Enter Terminal</button>
    </div>

    <div id="dashboard" class="hidden max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-3xl font-black italic">TradeBotPille <span class="text-sm font-normal not-italic text-gray-400">v4 Dual-Acc</span></h1>
            <button onclick="logout()" class="text-red-500 font-bold">Logout</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <!-- Account 1: Long -->
            <div class="bg-white p-6 rounded-xl shadow-sm border-t-4 border-green-500">
                <h2 class="text-lg font-bold mb-4">Account 1 (LONG ONLY)</h2>
                <div id="pos1-info" class="space-y-2 font-mono text-sm">Waiting for signal...</div>
                <hr class="my-4">
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="text-xs text-gray-400">TP %</label><input id="tp1" type="number" class="w-full border p-1 text-sm"></div>
                    <div><label class="text-xs text-gray-400">SL %</label><input id="sl1" type="number" class="w-full border p-1 text-sm"></div>
                </div>
                <button onclick="saveCfg(1)" class="w-full bg-green-600 text-white mt-4 py-2 rounded text-sm font-bold">Update Long Config</button>
            </div>

            <!-- Account 2: Short -->
            <div class="bg-white p-6 rounded-xl shadow-sm border-t-4 border-red-500">
                <h2 class="text-lg font-bold mb-4">Account 2 (SHORT ONLY)</h2>
                <div id="pos2-info" class="space-y-2 font-mono text-sm">Waiting for signal...</div>
                <hr class="my-4">
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="text-xs text-gray-400">TP %</label><input id="tp2" type="number" class="w-full border p-1 text-sm"></div>
                    <div><label class="text-xs text-gray-400">SL %</label><input id="sl2" type="number" class="w-full border p-1 text-sm"></div>
                </div>
                <button onclick="saveCfg(2)" class="w-full bg-red-600 text-white mt-4 py-2 rounded text-sm font-bold">Update Short Config</button>
            </div>
        </div>

        <div class="bg-white p-6 rounded-xl shadow-sm">
            <h2 class="font-bold mb-4">Recent Hedged Executions</h2>
            <table class="w-full text-left text-sm font-mono">
                <thead><tr class="text-gray-400"><th>Acc</th><th>Side</th><th>Entry</th><th>Exit</th><th>ROI</th></tr></thead>
                <tbody id="trade-history"></tbody>
            </table>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('bt_token');
        if(token) showDash();

        async function login() {
            const res = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email: document.getElementById('email').value}) });
            const data = await res.json();
            if(data.token) { localStorage.setItem('bt_token', data.token); token = data.token; showDash(); }
        }

        function logout() { localStorage.removeItem('bt_token'); location.reload(); }

        function showDash() {
            document.getElementById('auth-box').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            setInterval(update, 1000);
        }

        async function update() {
            const res = await fetch('/api/data', { headers: {'Authorization': token} });
            const data = await res.json();
            
            document.getElementById('pos1-info').innerHTML = data.activePos1 ? 
                'Price: $' + data.activePos1.entryPrice.toFixed(8) + '<br>Size: ' + data.activePos1.contracts + ' contracts' : 'No Active Long';
            document.getElementById('pos2-info').innerHTML = data.activePos2 ? 
                'Price: $' + data.activePos2.entryPrice.toFixed(8) + '<br>Size: ' + data.activePos2.contracts + ' contracts' : 'No Active Short';

            const tbody = document.getElementById('trade-history');
            tbody.innerHTML = data.trades.map(t => '<tr><td>'+t.accountNum+'</td><td class="'+(t.side==='long'?'text-green-500':'text-red-500')+'">'+t.side.toUpperCase()+'</td><td>'+t.entryPrice.toFixed(8)+'</td><td>'+t.exitPrice.toFixed(8)+'</td><td class="font-bold">'+t.roiPct.toFixed(2)+'%</td></tr>').join('');
        }

        async function saveCfg(num) {
            const config = { takeProfitPct: parseFloat(document.getElementById('tp'+num).value), stopLossPct: parseFloat(document.getElementById('sl'+num).value) };
            await fetch('/api/user/config', { method:'POST', headers:{'Content-Type':'application/json', 'Authorization': token}, body: JSON.stringify({accNum: num, config}) });
            alert('Acc ' + num + ' Config Updated');
        }
    </script>
</body>
</html>`);
});

app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Dual-Account Engine running on port ${CUSTOM_PORT}`);
    startEngine();
});
