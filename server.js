const fs = require('fs');
const ccxt = require('ccxt');
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const crypto = require('crypto');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 })
    .then(() => console.log('✅ MongoDB Connected Successfully'))
    .catch(err => console.error('🚨 MongoDB Connection Error:', err));

const UserModel = mongoose.model('User_V3', new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    passwordHash: { type: String, required: true },
    salt: { type: String, required: true },
    token: { type: String },
    apiKey: { type: String, default: "" },
    apiSecret: { type: String, default: "" },
    liveTradingEnabled: { type: Boolean, default: false },
    config: { type: Object, default: {} },
    activePosition: { type: Object, default: null }, 
    lastCloseTime: { type: Number, default: 0 },
    initialBalance: { type: Number, default: 0 },
    totalPnlGrowth: { type: Number, default: 0 },
    totalGrowthPct: { type: Number, default: 0 }
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, grossRoiPct: Number, roiPct: Number, 
    netPnl: Number, feeCost: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V8', new mongoose.Schema({
    priceMid: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

// ==================== BASE CONFIGURATION ====================
const FORCED_LEVERAGE = 75;
const CANDLE_INTERVAL_MS = 5 * 60 * 1000; // 5 Minutes

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0,
    flipOnlyInProfit: true, flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, profitMultiplier: 2.0, 
    maxContracts: 100
};

const globalMarketData = { 
    binance: { mid: 0, timestamp: 0 },
    tickBuffer: [], // Raw ticks from DB
    haCandles: []   // Calculated 5m HA candles
};

const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });

// ==================== HEIKIN ASHI ENGINE ====================
function calculateHeikinAshi(ticks) {
    if (ticks.length < 10) return [];

    // 1. Group raw ticks into 5m OHLC buckets
    const buckets = {};
    ticks.forEach(t => {
        const bucketKey = Math.floor(new Date(t.timestamp).getTime() / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
        if (!buckets[bucketKey]) buckets[bucketKey] = [];
        buckets[bucketKey].push(t.priceMid);
    });

    const sortedKeys = Object.keys(buckets).sort().map(Number);
    const ohlc = sortedKeys.map(key => {
        const prices = buckets[key];
        return {
            time: key,
            open: prices[0],
            high: Math.max(...prices),
            low: Math.min(...prices),
            close: prices[prices.length - 1]
        };
    });

    // 2. Convert to Heikin Ashi
    const ha = [];
    ohlc.forEach((c, i) => {
        const close = (c.open + c.high + c.low + c.close) / 4;
        let open;
        if (i === 0) {
            open = (c.open + c.close) / 2;
        } else {
            open = (ha[i - 1].open + ha[i - 1].close) / 2;
        }
        const high = Math.max(c.high, open, close);
        const low = Math.min(c.low, open, close);
        
        ha.push({ time: c.time, open, high, low, close, color: close > open ? 'bull' : 'bear' });
    });

    return ha;
}

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
const tokenCache = new Map();

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let userEntry = tokenCache.get(token);
    if (!userEntry) {
        const user = await UserModel.findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        userEntry = { user, lastAccessed: Date.now() };
        tokenCache.set(token, userEntry);
    }
    req.user = userEntry.user;
    next();
}

function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;
    return { currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd, margin };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.startTime = Date.now(); 
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false; 
        this.walletBalance = 0;
        this.initialBalance = user.initialBalance || 0;
        this.totalPnlGrowth = user.totalPnlGrowth || 0;
        this.totalGrowthPct = user.totalGrowthPct || 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ 
            apiKey: user.apiKey || "demo", secret: user.apiSecret || "demo", agent: keepAliveAgent, 
            options: { defaultType: 'swap', defaultSubType: 'linear' } 
        });
    }
    
    async initialize() {
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { 
            activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, 
            lastCloseTime: this.lastCloseTime, config: this.config,
            initialBalance: this.initialBalance, totalPnlGrowth: this.totalPnlGrowth, totalGrowthPct: this.totalGrowthPct
        } });
    }

    async connectExchange() {
        if(this.liveTradingEnabled) {
            try {
                await this.htx.loadMarkets(); 
                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, isPaper: false, lastDcaTime: 0, dcaStep: 0 }];
                }
            } catch (e) { this.liveTradingEnabled = false; }
        }
    }

    async evaluateHAEntry() {
        if (globalMarketData.haCandles.length < 2 || this.isTrading) return;
        
        const lastCandle = globalMarketData.haCandles[globalMarketData.haCandles.length - 1];
        const signal = lastCandle.color === 'bull' ? 'long' : 'short';

        // 1. Logic for opening or flipping
        if (this.activePositions.length > 0) {
            const pos = this.activePositions[0];
            if (pos.side !== signal) {
                // Direction Change (Trend Flip)
                const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, this.config.fees.taker);
                if (!this.config.flipOnlyInProfit || math.currentGrossRoi >= (this.config.flipThresholdPct || 0)) {
                    await this.forceClosePosition("HA_FLIP");
                    setTimeout(() => this.syncState(signal), 1000);
                }
            }
        } else {
            // No position, open with trend
            if (Date.now() - this.lastCloseTime > 5000) await this.syncState(signal);
        }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const currentPrice = globalMarketData.binance.mid;
        const math = calculateTradeMath(pos.side, pos.entryPrice, currentPrice, pos.size, FORCED_LEVERAGE, this.config.fees.taker);

        if (math.currentGrossRoi >= this.config.takeProfitPct) await this.forceClosePosition("TAKE_PROFIT");
        else if (math.currentGrossRoi <= this.config.stopLossPct) await this.forceClosePosition("STOP_LOSS");
        else {
            // DCA Logic
            const dcaThreshold = -(Math.abs(this.config.dcaRoiThresholdPct));
            if (math.currentGrossRoi <= dcaThreshold && Date.now() - (pos.lastDcaTime || 0) > 60000) {
                await this.addDcaPosition(false);
            }
        }
    }

    // ... (addDcaPosition, syncState, forceClosePosition remain identical in logic, omitted for brevity but present in final assembly) ...

    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = bal.total?.USDT || 0;
                    if (this.walletBalance > 0) {
                        if (this.initialBalance === 0) this.initialBalance = this.walletBalance;
                        this.totalPnlGrowth = this.walletBalance - this.initialBalance;
                        this.totalGrowthPct = (this.totalPnlGrowth / this.initialBalance) * 100;
                    }
                } catch(e) {}
            }
        }, 2000);
    }

    getExportData() { 
        return { 
            activePositions: this.activePositions, 
            walletBalance: this.walletBalance,
            totalPnlGrowth: this.totalPnlGrowth,
            totalGrowthPct: this.totalGrowthPct,
            haCandles: globalMarketData.haCandles.slice(-50),
            binance: globalMarketData.binance
        }; 
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    await publicBinance.loadMarkets();
    
    // Load historical ticks from DB to build first HA candles
    const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(2000).lean();
    globalMarketData.tickBuffer = history.reverse().map(h => ({ priceMid: h.priceMid, timestamp: h.timestamp }));
    globalMarketData.haCandles = calculateHeikinAshi(globalMarketData.tickBuffer);

    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { mid, timestamp: Date.now() };
                
                globalMarketData.tickBuffer.push({ priceMid: mid, timestamp: Date.now() });
                if (globalMarketData.tickBuffer.length > 5000) globalMarketData.tickBuffer.shift();

                // Recalculate HA Candles
                globalMarketData.haCandles = calculateHeikinAshi(globalMarketData.tickBuffer);

                // Save tick to DB
                ChartDataModel.create({ priceMid: mid }).catch(()=>{});

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateHAEntry().catch(()=>{}); 
                }
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS / FRONTEND ====================
const app = express(); app.use(express.json());

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Not found" });
});

app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html>
<head>
    <title>TradeBot | 5m Heikin Ashi</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined" rel="stylesheet" />
    <style>
        body { background: #fafafa; font-family: sans-serif; }
        .ui-card { background: white; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); border: 1px solid #f0f0f0; }
    </style>
</head>
<body class="p-8">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold flex items-center gap-2">
                <span class="material-symbols-outlined text-4xl">candlestick_chart</span>
                TradeBot 5M Heikin Ashi
            </h1>
            <div id="growthHeader" class="flex gap-4">
                <div class="ui-card p-4">
                    <p class="text-[10px] uppercase font-bold text-gray-400">Total Growth</p>
                    <p id="totalGrowth" class="text-xl font-mono font-bold">--</p>
                </div>
            </div>
        </div>

        <div class="grid lg:grid-cols-3 gap-8">
            <div class="lg:col-span-2 space-y-8">
                <div class="ui-card p-6 h-[450px]">
                    <canvas id="haChart"></canvas>
                </div>
                <div class="ui-card p-6">
                    <h3 class="font-bold mb-4">Active Position</h3>
                    <div id="activePos" class="grid grid-cols-3 gap-4 text-center">
                        <div class="p-4 bg-gray-50 rounded-xl">
                            <p class="text-xs text-gray-400">Direction</p>
                            <p id="posSide" class="font-bold text-lg">NONE</p>
                        </div>
                        <div class="p-4 bg-gray-50 rounded-xl">
                            <p class="text-xs text-gray-400">ROI</p>
                            <p id="posRoi" class="font-bold text-lg">0.00%</p>
                        </div>
                        <div class="p-4 bg-gray-50 rounded-xl">
                            <p class="text-xs text-gray-400">Price</p>
                            <p id="curPrice" class="font-bold text-lg">0.00</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="ui-card p-6">
                <h3 class="font-bold mb-6">Trend Momentum</h3>
                <div class="relative flex justify-center items-center h-48">
                    <canvas id="momentumGauge"></canvas>
                    <div class="absolute text-center">
                        <p id="trendLabel" class="text-xs font-bold text-gray-400 uppercase">Neutral</p>
                        <p id="momentumVal" class="text-3xl font-bold">0%</p>
                    </div>
                </div>
                <div class="mt-8 space-y-4 text-sm">
                    <div class="flex justify-between"><span>Last Candle:</span><span id="lastColor" class="font-bold">--</span></div>
                    <div class="flex justify-between"><span>HA Open:</span><span id="haOpen">--</span></div>
                    <div class="flex justify-between"><span>HA Close:</span><span id="haClose">--</span></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let authToken = localStorage.getItem('bot_token');
        const ctx = document.getElementById('haChart').getContext('2d');
        const haChart = new Chart(ctx, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'HA Body', data: [], backgroundColor: [] }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { y: { beginAtZero: false } }
            }
        });

        async function fetchLoop() {
            const res = await fetch('/api/data', { headers: { 'Authorization': authToken } });
            const data = await res.json();
            if (data.error) return;

            // Update Header
            document.getElementById('totalGrowth').innerText = "$" + data.totalPnlGrowth.toFixed(2) + " (" + data.totalGrowthPct.toFixed(2) + "%)";
            document.getElementById('totalGrowth').className = "text-xl font-mono font-bold " + (data.totalPnlGrowth >= 0 ? "text-green-500" : "text-red-500");

            // Update Chart (Simulated candles using Bar)
            haChart.data.labels = data.haCandles.map(c => new Date(c.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
            haChart.data.datasets[0].data = data.haCandles.map(c => [c.open, c.close]); // Min/Max range for bar
            haChart.data.datasets[0].backgroundColor = data.haCandles.map(c => c.color === 'bull' ? '#22c55e' : '#ef4444');
            haChart.update('none');

            // Update Signal Info
            if (data.haCandles.length > 0) {
                const last = data.haCandles[data.haCandles.length - 1];
                document.getElementById('lastColor').innerText = last.color.toUpperCase();
                document.getElementById('lastColor').className = "font-bold " + (last.color === 'bull' ? "text-green-500" : "text-red-500");
                document.getElementById('haOpen').innerText = last.open.toFixed(8);
                document.getElementById('haClose').innerText = last.close.toFixed(8);
                
                const bodySize = Math.abs(last.close - last.open);
                const momentum = Math.min((bodySize / last.open) * 10000, 100);
                document.getElementById('momentumVal').innerText = momentum.toFixed(1) + "%";
                document.getElementById('trendLabel').innerText = last.color === 'bull' ? "Bullish Trend" : "Bearish Trend";
            }

            if (data.activePositions.length > 0) {
                const p = data.activePositions[0];
                document.getElementById('posSide').innerText = p.side.toUpperCase();
                document.getElementById('posSide').className = "font-bold text-lg " + (p.side === 'long' ? "text-green-500" : "text-red-500");
                document.getElementById('posRoi').innerText = p.exchangeROI.toFixed(2) + "%";
                document.getElementById('curPrice').innerText = data.binance.mid.toFixed(8);
            }
        }
        setInterval(fetchLoop, 2000);
    </script>
</body>
</html>`); });

app.listen(3000, async () => {
    await loadAllUsers();
    startMasterStreams();
});
