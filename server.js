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
    lastCloseTime: { type: Number, default: 0 }      
}));

const TradeModel = mongoose.model('TradeLog_V3', new mongoose.Schema({
    userId: { type: String, required: true }, side: String, entryPrice: Number, exitPrice: Number,
    contracts: Number, marginUsed: Number, grossPnl: Number, grossRoiPct: Number, roiPct: Number, 
    netPnl: Number, feeCost: Number, timestamp: { type: Date, default: Date.now }, exitReason: String
}));

const ChartDataModel = mongoose.model('ChartData_V8', new mongoose.Schema({
    priceMid: Number, mlPlot: Number, timestamp: { type: Date, default: Date.now, expires: 86400 } 
}));

const AnalyticsModel = mongoose.model('SiteAnalytics_V3', new mongoose.Schema({
    key: { type: String, default: "global" }, views: { type: Number, default: 0 },
    uniques: { type: Number, default: 0 }, knownIds: { type: [String], default: [] }
}));

// ==================== BASE CONFIGURATION ====================
const CUSTOM_PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;

const BASE_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, baseContracts: 1, contractSize: 1000, marginMode: 'cross', fees: { taker: 0.0004 }, 
    takeProfitPct: 10.0, stopLossPct: -50.0, mlLookback: 50, mlThreshold: 60.0, 
    mlAverageTicks: 5, mlUseAverage: false, flipOnlyInProfit: true, flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, profitMultiplier: 2.0, 
    maxContracts: 100, 
    maxDcaStepsBeforeReverse: 10,
    
    // SMART SCALING CONFIGS
    microScalpRoi: 0.5,       // Start taking small profits at 0.5%
    microScalpQty: 5,         // How many contracts to close to bank profit
    microDcaRoi: -0.5,        // Start improving entry at -0.5%
    microDcaQty: 3,           // How many contracts to add to improve entry
    closeProfitQtyThreshold: 50, // Auto close whole position if qty reaches this and is in profit
    
    chartTicks: 800
};

const globalMarketData = { 
    binance: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    htx: { bid: 0, ask: 0, mid: 0, timestamp: 0 },
    tickBuffer: [],
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5 } 
};
const memoryChartHistory = []; 
const publicBinance = new ccxt.pro.binance({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const publicHtx = new ccxt.pro.htx({ options: { defaultType: 'swap', defaultSubType: 'linear' } });
const mlSignalCache = new Map();

// ==================== SECURITY & AUTH ====================
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
const tokenCache = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [token, data] of tokenCache.entries()) { if (now - data.lastAccessed > 3600000) tokenCache.delete(token); }
}, 600000);

async function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let userEntry = tokenCache.get(token);
    if (!userEntry) {
        const user = await UserModel.findOne({ token });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        userEntry = { user, lastAccessed: Date.now() };
        tokenCache.set(token, userEntry);
    } else userEntry.lastAccessed = Date.now();
    req.user = userEntry.user;
    next();
}

// ==================== MATH & ML ENGINE ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const feeCost = sizeUsd * (takerFee * 2);
    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, netPnlUsd: grossPnlUsd - feeCost, margin };
}

function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [((prices[idx]-prices[idx-1])/prices[idx-1])*1000, ((prices[idx]-prices[idx-3])/prices[idx-3])*1000, ((prices[idx]-prices[idx-5])/prices[idx-5])*1000, ((prices[idx]-prices[idx-10])/prices[idx-10])*1000];
    const trainEnd = prices.length-2, trainStart = trainEnd-lookback;
    let upC=0, downC=0;
    for (let i=trainStart; i<=trainEnd; i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1]-prices[i];
        let label=0.5; if(diff>0){label=1; upC++;} else if(diff<0){label=0; downC++;}
        y.push(label);
    }
    let n=X.length, totalD=upC+downC;
    let upW = totalD>0 && upC>0 ? (totalD/(2*upC)) : 1;
    let downW = totalD>0 && downC>0 ? (totalD/(2*downC)) : 1;
    let means=[0,0,0,0], stds=[0,0,0,0];
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) means[j]+=X[i][j];
    for(let j=0; j<4; j++) means[j]/=n;
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) stds[j]+=Math.pow(X[i][j]-means[j],2);
    for(let j=0; j<4; j++) {stds[j]=Math.sqrt(stds[j]/n); if(stds[j]===0) stds[j]=1;}
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) X[i][j]=(X[i][j]-means[j])/stds[j];
    let w=[0,0,0,0], b=0, lr=0.05, epochs=20; 
    for(let e=0; e<epochs; e++){
        for(let i=0; i<n; i++){
            let z=w[0]*X[i][0]+w[1]*X[i][1]+w[2]*X[i][2]+w[3]*X[i][3]+b;
            let pred=1/(1+Math.exp(-Math.max(Math.min(z,20),-20))); 
            let err=(pred-y[i])*(y[i]===1?upW:downW);
            for(let j=0; j<4; j++) w[j]-=lr*err*X[i][j];
            b-=lr*err;
        }
    }
    let currX=getFeatures(prices.length-1);
    for(let j=0; j<4; j++) currX[j]=(currX[j]-means[j])/stds[j];
    let finalP=1/(1+Math.exp(-Math.max(Math.min(w[0]*currX[0]+w[1]*currX[1]+w[2]*currX[2]+w[3]*currX[3]+b, 20),-20)));
    finalP=1-finalP;
    return { confidence: Math.min(Math.abs(finalP-0.5)*200, 100), type: finalP>=0.5?'bull':'bear', rawValue: finalP };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        this.metrics = { totalNetPnl: 0, winRate: 0, trades: [], maxMarginUsed: 0, wins:0, losses:0 };
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        this.isTrading = false;
        this.currentMl = { confidence:0, type:'flat', rawValue:0.5 };
        this.walletBalance = 0;
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        this.htx = new ccxt.pro.htx({ apiKey: user.apiKey||"demo", secret: user.apiSecret||"demo", agent: keepAliveAgent, options: { defaultType: 'swap', defaultSubType: 'linear' } });
    }

    async saveState() {
        await UserModel.updateOne({ _id: this.userId }, { $set: { activePosition: this.activePositions[0] || null, lastCloseTime: this.lastCloseTime, config: this.config } });
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        const pos = this.activePositions[0];
        const roi = pos.exchangeROI || 0;
        const mlVal = globalMarketData.mlSignal.rawValue;

        try {
            // 1. HARD EXITS
            if (roi >= this.config.takeProfitPct) return await this.forceClosePosition("TAKE_PROFIT");
            if (roi <= this.config.stopLossPct) return await this.forceClosePosition("STOP_LOSS");

            // 2. QTY PROFIT TARGET (New Setting)
            if (pos.contracts >= (this.config.closeProfitQtyThreshold || 50) && roi > 0) {
                return await this.forceClosePosition("QTY_PROFIT_TARGET");
            }

            // 3. SMARTER SCALING: MICRO-SCALPING (Take small profits if trend weakens)
            const mlWeakening = (pos.side === 'long' && mlVal < 0.52) || (pos.side === 'short' && mlVal > 0.48);
            if (roi >= (this.config.microScalpRoi || 0.5) && mlWeakening && pos.contracts > (this.config.microScalpQty || 5)) {
                await this.executeMicroAdjustment('close', this.config.microScalpQty || 5, "MICRO_SCALP");
            }

            // 4. SMARTER SCALING: MICRO-DCA (Improve entry if signal remains strong)
            const mlStrong = (pos.side === 'long' && mlVal > 0.65) || (pos.side === 'short' && mlVal < 0.35);
            if (roi <= (this.config.microDcaRoi || -0.5) && mlStrong && (Date.now() - (pos.lastDcaTime || 0) > 20000)) {
                await this.executeMicroAdjustment('open', this.config.microDcaQty || 3, "ENTRY_IMPROVE");
            }

            // 5. MAIN DCA / REVERSE LOGIC
            if (roi <= -(Math.abs(this.config.dcaRoiThresholdPct))) {
                if (pos.dcaStep >= (this.config.maxDcaStepsBeforeReverse || 10)) {
                    const revSide = pos.side === 'long' ? 'short' : 'long';
                    await this.forceClosePosition("MAX_DCA_REVERSE");
                    setTimeout(() => this.syncState(revSide), 200);
                } else if (Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    await this.addDcaPosition(false);
                }
            } else if (roi >= (this.config.profitRoiThresholdPct || 2.0) && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                await this.addDcaPosition(true);
            }

        } catch (e) { console.error("Exit Check Error:", e.message); }
    }

    async executeMicroAdjustment(action, qty, reason) {
        if (this.isTrading) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = action === 'open' ? (pos.side === 'long' ? 'buy' : 'sell') : (pos.side === 'long' ? 'sell' : 'buy');
            const price = globalMarketData.binance.mid;

            if (this.liveTradingEnabled && !pos.isPaper) {
                await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, qty, undefined, action === 'close' ? { reduceOnly: true } : {});
            }

            if (action === 'open') {
                const addedSize = qty * this.config.contractSize * price;
                pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
                pos.contracts += qty; pos.size += addedSize; pos.lastDcaTime = Date.now();
            } else {
                pos.contracts -= qty; pos.size = pos.contracts * this.config.contractSize * pos.entryPrice;
            }
            
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: reason, price: price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
            console.log(`[User ${this.userId}] ${reason}: ${qty} contracts at ${price}`);
        } finally { this.isTrading = false; }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const multiplier = isProfitScale ? 1.5 : (this.config.dcaMultiplier || 2.0);
            const qtyToAdd = Math.max(1, Math.floor(pos.contracts * (multiplier - 1)));
            
            if (isProfitScale && (pos.contracts + qtyToAdd > (this.config.maxContracts || 100))) { return; }

            const side = pos.side === 'long' ? 'buy' : 'sell';
            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled && !pos.isPaper) await this.htx.createMarketOrder(this.config.htxSymbol, side, qtyToAdd);
            
            const addedSize = qtyToAdd * this.config.contractSize * price;
            pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addedSize)) / (pos.size + addedSize);
            pos.contracts += qtyToAdd; pos.size += addedSize; pos.dcaStep++; pos.lastDcaTime = Date.now();
            
            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({ step: pos.dcaStep, type: isProfitScale ? 'SCALE' : 'DCA', price, roi: pos.exchangeROI || 0, time: Date.now() });
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const side = pos.side === 'long' ? 'sell' : 'buy';
            if (this.liveTradingEnabled && !pos.isPaper) await this.htx.createMarketOrder(this.config.htxSymbol, side, pos.contracts, undefined, { reduceOnly: true });
            
            const math = calculateTradeMath(pos.side, pos.entryPrice, globalMarketData.binance.mid, pos.size, FORCED_LEVERAGE, 0.0004);
            TradeModel.create({ userId: this.userId, side: pos.side, entryPrice: pos.entryPrice, exitPrice: globalMarketData.binance.mid, contracts: pos.contracts, netPnl: math.netPnlUsd, exitReason: reason });
            
            this.activePositions = []; this.lastCloseTime = Date.now(); await this.saveState();
        } finally { this.isTrading = false; }
    }

    async syncState(side) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const contracts = this.config.baseContracts || 1;
            const price = globalMarketData.binance.mid;
            if (this.liveTradingEnabled) await this.htx.createMarketOrder(this.config.htxSymbol, side === 'long' ? 'buy' : 'sell', contracts);
            this.activePositions = [{ side, entryPrice: price, contracts, size: contracts * this.config.contractSize * price, dcaStep: 0, entryTime: Date.now(), isPaper: !this.liveTradingEnabled, stepHistory: [{ step: 0, type: 'OPEN', price, roi: 0, time: Date.now() }] }];
            await this.saveState();
        } finally { this.isTrading = false; }
    }

    startExchangeROISync() {
        setInterval(async () => {
            if (this.liveTradingEnabled && this.activePositions.length > 0) {
                try {
                    const pos = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const open = pos.find(p => p.contracts > 0);
                    if (open) { this.activePositions[0].exchangeROI = open.percentage || 0; this.activePositions[0].exchangePnl = open.unrealizedPnl || 0; }
                    else { this.activePositions = []; await this.saveState(); }
                    const bal = await this.htx.fetchBalance({ type: 'swap' }); this.walletBalance = bal.total.USDT || 0;
                } catch(e){}
            }
        }, 2000);
    }
}

// ==================== MASTER CONTROLLER ====================
const activeWorkers = new Map();
async function startMasterStreams() {
    (async function streamBinance() {
        while (true) {
            try {
                const ticker = await publicBinance.watchTicker(BASE_CONFIG.binanceSymbol);
                const mid = (ticker.bid + ticker.ask) / 2;
                globalMarketData.binance = { bid: ticker.bid, ask: ticker.ask, mid, timestamp: Date.now() };
                globalMarketData.tickBuffer.push(mid); if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                globalMarketData.mlSignal = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                for (const w of activeWorkers.values()) { w.checkExits(); if(w.activePositions.length === 0) {
                    const sig = globalMarketData.mlSignal;
                    if(sig.confidence >= w.config.mlThreshold) w.syncState(sig.type === 'bull' ? 'long' : 'short');
                }}
            } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
        }
    })();
}

// ==================== EXPRESS SERVER & UI ====================
const app = express(); app.use(express.json());
app.get('/', (req, res) => res.send(`
<!DOCTYPE html><html><head><title>TradeBot Improved</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-900 text-white p-10 font-sans">
    <div class="max-w-4xl mx-auto">
        <h1 class="text-4xl font-bold mb-4">TradeBot: Smarter Scaling Active</h1>
        <div class="grid grid-cols-2 gap-4">
            <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                <h2 class="text-xl font-bold text-green-400 mb-2">Micro-Scalping</h2>
                <p class="text-sm text-gray-400">Banks small profits automatically when the ML signal shows the trend is weakening, keeping the trade running with less risk.</p>
            </div>
            <div class="bg-gray-800 p-6 rounded-xl border border-gray-700">
                <h2 class="text-xl font-bold text-blue-400 mb-2">Micro-Averaging</h2>
                <p class="text-sm text-gray-400">Adds tiny amounts to the position on small pullbacks to lower the average entry price while the trend is still strong.</p>
            </div>
        </div>
        <p class="mt-10 text-gray-500 italic">Login to the dashboard to monitor live smart-scaling logs in the Step History tab.</p>
    </div>
</body></html>`));

app.listen(CUSTOM_PORT, async () => {
    const users = await UserModel.find({});
    for(const u of users) { const w = new UserTradeInstance(u); w.startExchangeROISync(); activeWorkers.set(u._id.toString(), w); }
    startMasterStreams();
    console.log(`✅ Smart Scaling Engine Live on ${CUSTOM_PORT}`);
});
