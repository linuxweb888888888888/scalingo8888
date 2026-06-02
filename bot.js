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
    activeCycle: { type: Object, default: null },
    isWaitingForNextCycle: { type: Boolean, default: false },
    nextCycleStartTime: { type: Number, default: 0 },
    cycleHistory: { type: Array, default: [] }
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
    for (const [token, data] of tokenCache.entries()) {
        if (now - data.lastAccessed > 3600000) tokenCache.delete(token);
    }
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

// ==================== HELPER: CORE MATH ====================
function calculateTradeMath(side, entryPrice, currentPrice, sizeUsd, leverage, takerFee) {
    const sideMult = side === 'long' ? 1 : -1;
    const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100 * sideMult;
    const margin = sizeUsd / leverage;
    const grossPnlUsd = (grossPnlPercent / 100) * sizeUsd;
    const grossRoiPct = (grossPnlUsd / margin) * 100;
    const feeCost = sizeUsd * (takerFee * 2);
    const netPnlUsd = grossPnlUsd - feeCost;

    return { grossPnlPercent, currentGrossRoi: grossPnlPercent * leverage, grossPnlUsd, grossRoiPct, netPnlUsd, netRoiPct: (netPnlUsd / margin) * 100, feeCost, margin };
}

// ==================== MACHINE LEARNING MATH ENGINE ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15 || lookback < 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000,
        ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000
    ];

    const trainEnd = prices.length - 2; 
    const trainStart = trainEnd - lookback;
    let upCount = 0, downCount = 0;

    for (let i = trainStart; i <= trainEnd; i++) {
        X.push(getFeatures(i));
        let diff = prices[i+1] - prices[i];
        let label = 0.5;
        if (diff > 0) { label = 1; upCount++; } else if (diff < 0) { label = 0; downCount++; }
        y.push(label);
    }

    let n = X.length, totalDirectional = upCount + downCount;
    let upWeight = totalDirectional > 0 && upCount > 0 ? (totalDirectional / (2 * upCount)) : 1;
    let downWeight = totalDirectional > 0 && downCount > 0 ? (totalDirectional / (2 * downCount)) : 1;

    let means = [0, 0, 0, 0], stds = [0, 0, 0, 0];
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) means[j] += X[i][j];
    for(let j=0; j<4; j++) means[j] /= n;
    
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) stds[j] += Math.pow(X[i][j] - means[j], 2);
    for(let j=0; j<4; j++) { stds[j] = Math.sqrt(stds[j] / n); if (stds[j] === 0) stds[j] = 1; }
    for(let i=0; i<n; i++) for(let j=0; j<4; j++) X[i][j] = (X[i][j] - means[j]) / stds[j];

    let w = [0, 0, 0, 0], b = 0, lr = 0.05, epochs = 20; 
    for (let e = 0; e < epochs; e++) {
        for (let i = 0; i < n; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b;
            let pred = 1 / (1 + Math.exp(-Math.max(Math.min(z, 20), -20))); 
            let weight = y[i] === 1 ? upWeight : (y[i] === 0 ? downWeight : 1);
            let err = (pred - y[i]) * weight;
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }

    let currX = getFeatures(prices.length - 1);
    for(let j=0; j<4; j++) currX[j] = (currX[j] - means[j]) / stds[j];
    let zCur = w[0]*currX[0] + w[1]*currX[1] + w[2]*currX[2] + w[3]*currX[3] + b;
    let finalPred = 1 / (1 + Math.exp(-Math.max(Math.min(zCur, 20), -20)));
    
    finalPred = 1 - finalPred;
    
    let confidence = Math.abs(finalPred - 0.5) * 200; 
    return { confidence: Math.min(confidence, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== METRICS ENGINE ====================
class PerformanceMetrics {
    constructor(userId) {
        this.userId = userId; this.trades = []; 
        this.totalGrossPnl = 0; this.totalNetPnl = 0; this.totalFees = 0; this.totalRoiPct = 0;
        this.wins = 0; this.losses = 0; this.winRate = 0; this.totalTradesCount = 0; this.maxMarginUsed = 0; 
    }
    async init() { 
        const dbTrades = await TradeModel.find({ userId: this.userId }).sort({ timestamp: -1 }).limit(2000).lean(); 
        dbTrades.reverse().forEach(t => this.processTrade(t, false)); 
    }
    recordTrade(trade) { this.processTrade(trade, true); }
    processTrade(trade, saveToDb = true) {
        this.totalTradesCount++; if (!trade.timestamp) trade.timestamp = Date.now();
        this.trades.push(trade); if (this.trades.length > 2000) this.trades.shift(); 
        if (trade.marginUsed > this.maxMarginUsed) this.maxMarginUsed = trade.marginUsed;
        this.totalNetPnl += trade.netPnl || 0; this.totalFees += trade.feeCost || 0; this.totalRoiPct += trade.roiPct || 0; 
        if (trade.netPnl > 0) this.wins++; else this.losses++;
        this.winRate = this.trades.length ? ((this.wins / this.trades.length) * 100).toFixed(2) : 0;
        if (saveToDb) TradeModel.create({ ...trade, userId: this.userId }).catch(()=>{});
    }
    updateMaxMargin(margin) { if (margin > this.maxMarginUsed) this.maxMarginUsed = margin; }
}

// ==================== DGR CYCLE TRACKING ====================
class GrowthCycleManager {
    constructor(userId) {
        this.userId = userId;
        this.activeCycle = null;
        this.cycleHistory = [];
        this.isWaitingForNextCycle = false;
        this.nextCycleStartTime = 0;
    }
    
    async init() {
        const user = await UserModel.findById(this.userId);
        if (user && user.activeCycle) {
            this.activeCycle = user.activeCycle;
            this.isWaitingForNextCycle = user.isWaitingForNextCycle || false;
            this.nextCycleStartTime = user.nextCycleStartTime || 0;
        }
        if (user && user.cycleHistory) {
            this.cycleHistory = user.cycleHistory;
        }
    }
    
    async startNewCycle(targetGrowthPct, targetTimeUnit, targetValue, startBalance) {
        const now = Date.now();
        let durationMs = 0;
        
        switch(targetTimeUnit) {
            case 'minute': durationMs = 60000 * targetValue; break;
            case 'minute10': durationMs = 600000 * targetValue; break;
            case 'minute30': durationMs = 1800000 * targetValue; break;
            case 'hour': durationMs = 3600000 * targetValue; break;
            case 'hour2': durationMs = 7200000 * targetValue; break;
            case 'hour10': durationMs = 36000000 * targetValue; break;
            case 'day': durationMs = 86400000 * targetValue; break;
            case 'week': durationMs = 604800000 * targetValue; break;
            case 'month': durationMs = 2592000000 * targetValue; break;
            case 'year': durationMs = 31536000000 * targetValue; break;
            default: durationMs = 86400000;
        }
        
        const targetAmountUsd = (startBalance * targetGrowthPct) / 100;
        const shibPrice = globalMarketData.binance.mid || 0.00001;
        const targetAmountShib = targetAmountUsd / shibPrice;
        
        this.activeCycle = {
            id: Date.now(),
            startTime: now,
            endTime: now + durationMs,
            startBalance: startBalance,
            targetGrowthPct: targetGrowthPct,
            targetAmountUsd: targetAmountUsd,
            targetAmountShib: targetAmountShib,
            targetTimeUnit: targetTimeUnit,
            targetValue: targetValue,
            achievedGrowthPct: 0,
            achievedAmountUsd: 0,
            achievedAmountShib: 0,
            achievedAt: null,
            status: 'active'
        };
        
        this.isWaitingForNextCycle = false;
        await this.saveState();
        return this.activeCycle;
    }
    
    async checkCycleCompletion(currentBalance) {
        if (!this.activeCycle || this.activeCycle.status !== 'active') return false;
        
        const now = Date.now();
        const currentGrowthPct = ((currentBalance - this.activeCycle.startBalance) / this.activeCycle.startBalance) * 100;
        const currentGrowthUsd = currentBalance - this.activeCycle.startBalance;
        const shibPrice = globalMarketData.binance.mid || 0.00001;
        const currentGrowthShib = currentGrowthUsd / shibPrice;
        
        if (currentGrowthPct >= this.activeCycle.targetGrowthPct) {
            this.activeCycle.achievedGrowthPct = currentGrowthPct;
            this.activeCycle.achievedAmountUsd = currentGrowthUsd;
            this.activeCycle.achievedAmountShib = currentGrowthShib;
            this.activeCycle.achievedAt = now;
            this.activeCycle.status = 'achieved';
            
            this.cycleHistory.unshift(this.activeCycle);
            if (this.cycleHistory.length > 100) this.cycleHistory.pop();
            
            this.isWaitingForNextCycle = true;
            this.nextCycleStartTime = now + (this.activeCycle.endTime - this.activeCycle.startTime);
            
            await this.saveState();
            return true;
        }
        
        if (now > this.activeCycle.endTime && currentGrowthPct < this.activeCycle.targetGrowthPct) {
            this.activeCycle.achievedGrowthPct = currentGrowthPct;
            this.activeCycle.achievedAmountUsd = currentGrowthUsd;
            this.activeCycle.achievedAmountShib = currentGrowthShib;
            this.activeCycle.achievedAt = now;
            this.activeCycle.status = 'failed';
            
            this.cycleHistory.unshift(this.activeCycle);
            if (this.cycleHistory.length > 100) this.cycleHistory.pop();
            
            this.isWaitingForNextCycle = true;
            this.nextCycleStartTime = now + (this.activeCycle.endTime - this.activeCycle.startTime);
            
            await this.saveState();
            return false;
        }
        
        return false;
    }
    
    async shouldAllowTrading() {
        if (this.isWaitingForNextCycle) {
            if (Date.now() >= this.nextCycleStartTime) {
                this.isWaitingForNextCycle = false;
                this.activeCycle = null;
                await this.saveState();
                return true;
            }
            return false;
        }
        return true;
    }
    
    async getCycleStatus(currentBalance) {
        if (this.activeCycle && this.activeCycle.status === 'active') {
            const now = Date.now();
            const timeRemaining = Math.max(0, this.activeCycle.endTime - now);
            const currentGrowthPct = ((currentBalance - this.activeCycle.startBalance) / this.activeCycle.startBalance) * 100;
            const currentGrowthUsd = currentBalance - this.activeCycle.startBalance;
            const shibPrice = globalMarketData.binance.mid || 0.00001;
            const currentGrowthShib = currentGrowthUsd / shibPrice;
            
            return {
                hasActiveCycle: true,
                targetGrowthPct: this.activeCycle.targetGrowthPct,
                targetAmountUsd: this.activeCycle.targetAmountUsd,
                targetAmountShib: this.activeCycle.targetAmountShib,
                currentGrowthPct: currentGrowthPct,
                currentGrowthUsd: currentGrowthUsd,
                currentGrowthShib: currentGrowthShib,
                remainingToTarget: Math.max(0, this.activeCycle.targetGrowthPct - currentGrowthPct),
                remainingUsdToTarget: Math.max(0, this.activeCycle.targetAmountUsd - currentGrowthUsd),
                remainingShibToTarget: Math.max(0, this.activeCycle.targetAmountShib - currentGrowthShib),
                timeRemainingMs: timeRemaining,
                timeRemainingFormatted: this.formatTime(timeRemaining),
                startBalance: this.activeCycle.startBalance,
                endTime: this.activeCycle.endTime,
                status: 'active'
            };
        }
        
        if (this.isWaitingForNextCycle) {
            const waitRemaining = Math.max(0, this.nextCycleStartTime - Date.now());
            return {
                hasActiveCycle: false,
                isWaiting: true,
                waitRemainingMs: waitRemaining,
                waitRemainingFormatted: this.formatTime(waitRemaining),
                nextCycleStart: this.nextCycleStartTime,
                lastCycle: this.cycleHistory[0] || null
            };
        }
        
        return {
            hasActiveCycle: false,
            isWaiting: false,
            canStartNew: true
        };
    }
    
    formatTime(ms) {
        if (ms <= 0) return "0s";
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }
    
    async saveState() {
        await UserModel.updateOne(
            { _id: this.userId },
            { 
                $set: { 
                    activeCycle: this.activeCycle,
                    isWaitingForNextCycle: this.isWaitingForNextCycle,
                    nextCycleStartTime: this.nextCycleStartTime,
                    cycleHistory: this.cycleHistory.slice(0, 50)
                } 
            }
        );
    }
    
    async resetCycle() {
        this.activeCycle = null;
        this.isWaitingForNextCycle = false;
        this.nextCycleStartTime = 0;
        await this.saveState();
    }
}

// ==================== BACKTEST SIMULATION ENGINE ====================
async function runBacktestSimulation(config, tickCount, symbol) {
    try {
        await publicBinance.loadMarkets();
    } catch (e) { return { error: `Market resolution error: ${e.message}` }; }

    let allCandles = [], since = Date.now() - (tickCount * 60 * 1000); 
    try {
        while (allCandles.length < tickCount) {
            const limit = Math.min(1000, tickCount - allCandles.length);
            const ohlcv = await publicBinance.fetchOHLCV(symbol, '1m', since, limit);
            if (!ohlcv || ohlcv.length === 0) break;
            allCandles.push(...ohlcv);
            since = ohlcv[ohlcv.length - 1][0] + 60000;
            if (allCandles.length < tickCount) await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {
        if (allCandles.length === 0) allCandles = await publicBinance.fetchOHLCV(symbol, '1m', undefined, Math.min(tickCount, 1000)).catch(()=>[]) || [];
    }

    const ticks = allCandles.map(c => ({ timestamp: c[0], priceMid: c[4] }));
    if (!ticks || ticks.length === 0) return { error: `No historical tick data fetched for ${symbol}.` };

    let activePos = null, closedTrades = [], netPnl = 0, wins = 0, losses = 0, totalTradeDurationMs = 0, maxMarginUsed = 0;
    const { mlLookback=50, mlThreshold=60.0, mlAverageTicks=5, mlUseAverage=false, flipOnlyInProfit=true, flipThresholdPct=0.5 } = config;
    const dcaRoiThresholdPct = config.dcaRoiThresholdPct || 1.0;
    const profitRoiThresholdPct = config.profitRoiThresholdPct !== undefined ? config.profitRoiThresholdPct : 2.0;
    const maxContracts = config.maxContracts !== undefined ? Number(config.maxContracts) : 100;
    
    let priceBuffer = [], mlRawBuffer = [];
    const totalSpanMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;

    for (const tick of ticks) {
        const price = tick.priceMid, tickTime = tick.timestamp;

        if (priceBuffer.length === 0 || price !== priceBuffer[priceBuffer.length - 1]) {
            priceBuffer.push(price); if (priceBuffer.length > 500) priceBuffer.shift();
        }
        
        if (ticks.indexOf(tick) % 500 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }

        const mlSig = calculateMLSignal(priceBuffer, mlLookback);

        mlRawBuffer.push(mlSig.rawValue); if (mlRawBuffer.length > mlAverageTicks) mlRawBuffer.shift();
        let avgRaw = mlRawBuffer.reduce((a,b)=>a+b,0) / mlRawBuffer.length;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        let avgType = avgRaw >= 0.5 ? 'bull' : 'bear';

        let activeType = mlUseAverage ? avgType : mlSig.type;
        let activeConf = mlUseAverage ? avgConf : mlSig.confidence;

        let signal = (activeType === 'bull' && activeConf >= mlThreshold) ? 'long' : (activeType === 'bear' && activeConf >= mlThreshold) ? 'short' : null;

        if (!activePos && signal) {
            let bC = parseInt(config.baseContracts) || 1;
            const sizeUsd = bC * config.contractSize * price; 
            const margin = sizeUsd / FORCED_LEVERAGE;
            activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: margin, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
            if (margin > maxMarginUsed) maxMarginUsed = margin;
            continue;
        }

        if (activePos) {
            const math = calculateTradeMath(activePos.side, activePos.entryPrice, price, activePos.size, FORCED_LEVERAGE, config.fees.taker);
            let forceExitReason = null;
            
            if (signal && activePos.side !== signal) {
                if (flipOnlyInProfit) {
                    if (math.currentGrossRoi >= flipThresholdPct) forceExitReason = "ML_FLIP";
                } else forceExitReason = "ML_FLIP";
            }
            
            if (!forceExitReason && math.currentGrossRoi >= config.takeProfitPct) forceExitReason = "TAKE_PROFIT";
            else if (!forceExitReason && math.currentGrossRoi <= config.stopLossPct) forceExitReason = "STOP_LOSS";

            if (forceExitReason) {
                netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
                totalTradeDurationMs += (tickTime - activePos.entryTime);

                closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: price, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: forceExitReason, time: tick.timestamp });
                
                if (forceExitReason === "ML_FLIP") {
                    let bC = parseInt(config.baseContracts) || 1;
                    const sizeUsd = bC * config.contractSize * price; 
                    activePos = { side: signal, entryPrice: price, contracts: bC, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, entryTime: tickTime, lastDcaTime: 0, dcaStep: 0 };
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                } else activePos = null;
            } else {
                const requiredRoiForDca = -(Math.abs(dcaRoiThresholdPct || 1.0));
                
                if (math.currentGrossRoi <= requiredRoiForDca && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1;
                    let mult = Number(config.dcaMultiplier) || 2.0;
                    let step = Number(activePos.dcaStep) || 0;
                    
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    
                    const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                    
                    activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                    activePos.size = Number(activePos.size) + addedSizeUsd; 
                    activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                    activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                    activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                    if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                    
                } else if (math.currentGrossRoi >= profitRoiThresholdPct && tickTime - (activePos.lastDcaTime || 0) >= 3000) {
                    let bC = Number(config.baseContracts) || 1;
                    let mult = Number(config.profitMultiplier) || 2.0;
                    let step = Number(activePos.dcaStep) || 0;
                    
                    let contractsToAdd = parseInt(Math.max(1, Math.floor(bC * Math.pow(mult, step))), 10);
                    
                    if (Number(activePos.contracts) + contractsToAdd <= maxContracts) {
                        const addedSizeUsd = contractsToAdd * Number(config.contractSize) * price;
                        
                        activePos.entryPrice = ((Number(activePos.entryPrice) * Number(activePos.size)) + (price * addedSizeUsd)) / (Number(activePos.size) + addedSizeUsd);
                        activePos.size = Number(activePos.size) + addedSizeUsd; 
                        activePos.contracts = Number(activePos.contracts) + contractsToAdd;
                        activePos.marginUsed = Number(activePos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
                        activePos.lastDcaTime = tickTime; activePos.dcaStep = step + 1;
                        if (activePos.marginUsed > maxMarginUsed) maxMarginUsed = activePos.marginUsed;
                    }
                }
            }
        }
    }

    if (activePos) {
        const lastTick = ticks[ticks.length - 1]; 
        const math = calculateTradeMath(activePos.side, activePos.entryPrice, lastTick.priceMid, activePos.size, FORCED_LEVERAGE, config.fees.taker);
        netPnl += math.netPnlUsd; math.netPnlUsd > 0 ? wins++ : losses++;
        totalTradeDurationMs += (lastTick.timestamp - activePos.entryTime);
        closedTrades.push({ side: activePos.side, entryPrice: activePos.entryPrice, exitPrice: lastTick.priceMid, contracts: activePos.contracts, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, exitReason: "END_OF_TEST", time: lastTick.timestamp });
    }

    const totalTradesCount = closedTrades.length;
    const formatTime = (ms) => {
        if (ms < 1000) return "< 1s";
        let s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (d > 0) return `${d}d ${h%24}h`; if (h > 0) return `${h}h ${m%60}m`; if (m > 0) return `${m}m ${s%60}s`; return `${s}s`;
    };

    return { 
        ticksAnalyzed: ticks.length, totalTradesCount, wins, losses, 
        winRate: totalTradesCount > 0 ? ((wins / totalTradesCount) * 100).toFixed(2) : 0, 
        netPnl, depositNeeded: maxMarginUsed, 
        avgDuration: formatTime(totalTradesCount > 0 ? totalTradeDurationMs / totalTradesCount : 0), 
        totalSpan: formatTime(totalSpanMs), trades: closedTrades.slice(-200) 
    };
}

// ==================== USER BOT INSTANCE ====================
class UserTradeInstance {
    constructor(user) {
        this.userId = user._id.toString(); 
        this.config = { ...BASE_CONFIG, ...(user.config || {}) }; 
        
        if (!this.config.htxSymbol || this.config.htxSymbol.includes('1000')) {
            this.config.htxSymbol = 'SHIB/USDT:USDT';
            this.config.binanceSymbol = '1000SHIB/USDT:USDT';
        }
        if (!this.config.contractSize) this.config.contractSize = 1000;
        this.config.leverage = FORCED_LEVERAGE;
        this.config.marginMode = 'cross'; 

        this.startTime = Date.now(); this.metrics = new PerformanceMetrics(this.userId);
        this.activePositions = user.activePosition ? [user.activePosition] : []; 
        this.lastCloseTime = user.lastCloseTime || 0;
        
        this.isTrading = false; 
        this.currentMl = { confidence: 0, type: 'flat', rawValue: 0.5 };
        this.mlRawBuffer = [];
        this.lastEvalPrice = 0;
        this.walletBalance = 0;

        this.cycleManager = new GrowthCycleManager(this.userId);
        
        this.applyUserKeys(user);
    }

    applyUserKeys(user) {
        this.liveTradingEnabled = user.liveTradingEnabled; 
        const key = user.apiKey || "demo", secret = user.apiSecret || "demo";
        this.htx = new ccxt.pro.htx({ 
            apiKey: key, 
            secret: secret, 
            agent: keepAliveAgent, 
            enableRateLimit: false, 
            options: { 
                defaultType: 'swap', 
                defaultSubType: 'linear', 
                defaultMarginMode: 'cross', 
                positionMode: 'hedged' 
            } 
        });
    }
    
    async initialize() {
        await this.metrics.init(); 
        await this.cycleManager.init();
        if (this.activePositions.length > 0) this.metrics.updateMaxMargin(this.activePositions[0].marginUsed);
        await this.connectExchange();
        this.startExchangeROISync();
    }

    async saveState() {
        await UserModel.updateOne(
            { _id: this.userId },
            { $set: { activePosition: this.activePositions.length > 0 ? this.activePositions[0] : null, lastCloseTime: this.lastCloseTime, config: this.config } }
        );
        const cacheEntry = tokenCache.get(this.userId);
        if(cacheEntry) cacheEntry.user.activePosition = this.activePositions.length > 0 ? this.activePositions[0] : null; 
    }

    async connectExchange() {
        try {
            if(this.liveTradingEnabled) {
                await this.htx.loadMarkets(); 
                
                try { await this.htx.setMarginMode('cross', this.config.htxSymbol); } catch(e){}
                try { await this.htx.setLeverage(FORCED_LEVERAGE, this.config.htxSymbol); } catch(e){}

                const positions = await this.htx.fetchPositions([this.config.htxSymbol]); 
                const openPos = positions.find(p => p.contracts > 0);
                
                if (openPos) {
                    let entryP = openPos.entryPrice;
                    if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;

                    const sizeUsd = openPos.contracts * this.config.contractSize * entryP;
                    this.activePositions = [{ id: Date.now(), side: openPos.side, entryPrice: entryP, contracts: openPos.contracts, size: sizeUsd, marginUsed: sizeUsd / FORCED_LEVERAGE, exchangeROI: openPos.percentage || 0, exchangePnl: openPos.unrealizedPnl || 0, entryTime: Date.now(), isPaper: false, lastDcaTime: 0, dcaStep: 0, stepHistory: [] }];
                    this.metrics.updateMaxMargin(this.activePositions[0].marginUsed); await this.saveState();
                } else {
                    this.activePositions = []; await this.saveState();
                }
            }
            return { success: true };
        } catch (error) { 
            console.log(`[Worker ${this.userId}] Exchange Init Error:`, error.message); 
            this.liveTradingEnabled = false; return { success: false, message: error.message }; 
        }
    }

    async evaluateAIEntry() {
        let allowTrading = await this.cycleManager.shouldAllowTrading();
        if (!allowTrading) return;
        
        let mlSig = mlSignalCache.get(this.config.mlLookback);
        if (!mlSig) {
            mlSig = calculateMLSignal(globalMarketData.tickBuffer, this.config.mlLookback || 50);
            mlSignalCache.set(this.config.mlLookback, mlSig);
        }
        
        if (this.lastEvalPrice !== globalMarketData.binance.mid) {
            this.mlRawBuffer.push(mlSig.rawValue);
            if (this.mlRawBuffer.length > (this.config.mlAverageTicks || 5)) this.mlRawBuffer.shift();
            this.lastEvalPrice = globalMarketData.binance.mid;
        }
        
        let avgRaw = this.mlRawBuffer.length > 0 ? (this.mlRawBuffer.reduce((a,b)=>a+b,0) / this.mlRawBuffer.length) : mlSig.rawValue;
        let avgConf = Math.min(Math.abs(avgRaw - 0.5) * 200, 100);
        
        this.currentMl = { 
            confidence: mlSig.confidence, type: mlSig.type, rawValue: mlSig.rawValue,
            avgRaw: avgRaw, avgConfidence: avgConf, avgType: avgRaw >= 0.5 ? 'bull' : 'bear' 
        };

        if (this.isTrading || (Date.now() - this.lastCloseTime < 3000)) return;

        try {
            let activeType = this.config.mlUseAverage ? this.currentMl.avgType : mlSig.type;
            let activeConf = this.config.mlUseAverage ? this.currentMl.avgConfidence : mlSig.confidence;

            let signal = (activeType === 'bull' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'long' : 
                         (activeType === 'bear' && activeConf >= (this.config.mlThreshold || 60.0)) ? 'short' : null;
            
            if (this.activePositions.length > 0) {
                const pos = this.activePositions[0];
                
                if (signal && pos.side !== signal) {
                    let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                    if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                    const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                    let instantRoi = pnlPercent * FORCED_LEVERAGE;

                    if (this.config.flipOnlyInProfit !== false) {
                        const threshold = this.config.flipThresholdPct || 0.0;
                        if (instantRoi >= threshold) {
                            await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50);
                        }
                    } else {
                        await this.forceClosePosition("ML_FLIP"); setTimeout(() => this.syncState(signal), 50);
                    }
                }
            } else {
                if (signal) await this.syncState(signal);
            }
        } catch (e) {
            console.error(`🚨 [Eval Error]:`, e.message);
        }
    }

    async checkExits() {
        if (this.isTrading || this.activePositions.length === 0) return;
        
        try {
            const pos = this.activePositions[0];
            let effectiveRoi = 0;
            if (this.liveTradingEnabled && !pos.isPaper) {
                effectiveRoi = pos.exchangeROI || 0;
            } else {
                let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
                if (!currentPrice) currentPrice = globalMarketData.binance.mid;
                const pnlPercent = pos.side === 'long' ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
                effectiveRoi = pnlPercent * FORCED_LEVERAGE;
            }
            
            if (effectiveRoi >= this.config.takeProfitPct) {
                await this.forceClosePosition("TAKE_PROFIT");
                await this.cycleManager.checkCycleCompletion(this.walletBalance);
            } else if (effectiveRoi <= this.config.stopLossPct) {
                await this.forceClosePosition("STOP_LOSS");
                await this.cycleManager.checkCycleCompletion(this.walletBalance);
            } else {
                const requiredRoiForDca = -(Math.abs(this.config.dcaRoiThresholdPct || 1.0));
                const profitScaleThreshold = this.config.profitRoiThresholdPct !== undefined ? this.config.profitRoiThresholdPct : 2.0;
                
                if (effectiveRoi <= requiredRoiForDca && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    await this.addDcaPosition(false);
                } 
                else if (effectiveRoi >= profitScaleThreshold && Date.now() - (pos.lastDcaTime || 0) > 10000) {
                    await this.addDcaPosition(true);
                }
            }
        } catch (e) {
             console.error(`🚨 [Exit Check Error]:`, e.message);
        }
    }

    async addDcaPosition(isProfitScale = false) {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const pos = this.activePositions[0];
            const orderSide = pos.side === 'long' ? 'buy' : 'sell';
            
            let multiplier = isProfitScale ? (Number(this.walletBalance) * 1) : this.config.dcaMultiplier;
            multiplier = Number(multiplier);
            if (isNaN(multiplier) || multiplier < 1.0) multiplier = 2.0;
            
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            
            let step = Number(pos.dcaStep);
            if (isNaN(step)) step = 0;

            let contractsToAdd = parseInt(Math.max(1, Math.floor(baseC * Math.pow(multiplier, step))), 10);
            
            if (isProfitScale) {
                const maxC = (Number(this.walletBalance) * 2);
                if (Number(pos.contracts) + contractsToAdd > maxC) {
                    pos.lastDcaTime = Date.now();
                    await this.saveState();
                    this.isTrading = false;
                    return; 
                }
            }

            pos.lastDcaTime = Date.now();
            await this.saveState();
            
            let realExecPrice = pos.side === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!realExecPrice) realExecPrice = globalMarketData.binance.mid;

            if (!pos.isPaper && this.liveTradingEnabled) {
                console.log(`[User ${this.userId}] Requesting Scale: ${contractsToAdd} contracts on HTX`);
                try {
                    const res = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contractsToAdd, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                    await new Promise(r => setTimeout(r, 150)); 
                    const order = await this.htx.fetchOrder(res.id, this.config.htxSymbol); 
                    if (order && order.average) {
                        realExecPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? order.average * 1000 : order.average;
                    }
                } catch(e) {
                    console.error(`[User ${this.userId}] HTX API Error, cancelling local state update to prevent desync:`, e.message);
                    return; 
                }
            }

            if(!pos.stepHistory) pos.stepHistory = [];
            pos.stepHistory.push({
                step: step + 1,
                type: isProfitScale ? 'SCALE' : 'DCA',
                price: realExecPrice,
                roi: pos.exchangeROI || 0,
                time: Date.now()
            });

            const addedSizeUsd = contractsToAdd * (Number(this.config.contractSize) || 1000) * realExecPrice;
            
            pos.entryPrice = ((Number(pos.entryPrice) * Number(pos.size)) + (Number(realExecPrice) * addedSizeUsd)) / (Number(pos.size) + addedSizeUsd);
            pos.size = Number(pos.size) + addedSizeUsd;
            pos.contracts = Number(pos.contracts) + contractsToAdd; 
            pos.marginUsed = Number(pos.marginUsed) + (addedSizeUsd / FORCED_LEVERAGE);
            pos.dcaStep = step + 1;
            
            this.metrics.updateMaxMargin(pos.marginUsed);
            await this.saveState();
            console.log(`[User ${this.userId}] ${pos.isPaper ? 'Paper' : 'LIVE'} ${isProfitScale ? 'PROFIT SCALE' : 'LOSS DCA'} Executed (Step ${pos.dcaStep}). Added ${contractsToAdd} to ${pos.side.toUpperCase()}`);
        } catch (err) {
            console.error(`🚨 [Scale Error - User ${this.userId}]:`, err.message);
        } finally { this.isTrading = false; }
    }

    async syncState(targetSide) {
        if (this.isTrading || this.activePositions.length > 0) return;
        this.isTrading = true;
        try {
            const isPaper = !this.liveTradingEnabled; 
            const orderSide = targetSide === 'long' ? 'buy' : 'sell'; 
            
            let baseC = Number(this.walletBalance) * 1000;
            if (isNaN(baseC) || baseC < 1) baseC = 1;
            const contracts = parseInt(Math.max(1, Math.floor(baseC)), 10);
            
            let executionPrice = targetSide === 'long' ? globalMarketData.binance.ask : globalMarketData.binance.bid;
            if (!executionPrice) executionPrice = globalMarketData.binance.mid;

            if (!isPaper) {
                const openRes = await this.htx.createMarketOrder(this.config.htxSymbol, orderSide, contracts, undefined, { offset: 'open', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                await new Promise(r => setTimeout(r, 150)); 
                try { 
                    const oOrder = await this.htx.fetchOrder(openRes.id, this.config.htxSymbol); 
                    if (oOrder && oOrder.average) {
                        executionPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? oOrder.average * 1000 : oOrder.average;
                    }
                } catch(e){}
            }

            const sizeUsd = contracts * (Number(this.config.contractSize) || 1000) * executionPrice;
            const marginUsed = sizeUsd / FORCED_LEVERAGE;
            
            this.activePositions = [{ id: Date.now(), side: targetSide, entryPrice: Number(executionPrice), contracts: Number(contracts), size: Number(sizeUsd), marginUsed: Number(marginUsed), entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0, isPaper, lastDcaTime: 0, dcaStep: 0, stepHistory: [{ step: 0, type: 'OPEN', price: executionPrice, roi: 0, time: Date.now() }] }];
            
            this.metrics.updateMaxMargin(marginUsed); 
            await this.saveState();
            console.log(`[User ${this.userId}] ${isPaper?'Paper':'LIVE'} OPEN: ${targetSide.toUpperCase()} at $${executionPrice}`);
        } catch (err) { 
            console.error(`🚨 [Open Error - User ${this.userId}]:`, err.message); this.activePositions = []; 
        } finally { this.isTrading = false; }
    }

    async forceClosePosition(reason = "MANUAL") {
        if (this.isTrading || this.activePositions.length === 0) return;
        this.isTrading = true;
        try {
            const snapPos = { ...this.activePositions[0] };
            const closeSide = snapPos.side === 'long' ? 'sell' : 'buy';
            let realExitPrice = closeSide === 'sell' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!realExitPrice) realExitPrice = globalMarketData.binance.mid;

            if (!snapPos.isPaper && this.liveTradingEnabled) {
                const closeRes = await this.htx.createMarketOrder(this.config.htxSymbol, closeSide, snapPos.contracts, undefined, { reduceOnly: true, offset: 'close', marginMode: 'cross', lever_rate: FORCED_LEVERAGE });
                this.activePositions = []; await new Promise(r => setTimeout(r, 150));
                try { 
                    const cOrder = await this.htx.fetchOrder(closeRes.id, this.config.htxSymbol); 
                    if (cOrder && cOrder.average) {
                        realExitPrice = this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000') ? cOrder.average * 1000 : cOrder.average;
                    }
                } catch(e){}
            } else {
                this.activePositions = [];
            }

            const math = calculateTradeMath(snapPos.side, snapPos.entryPrice, realExitPrice, snapPos.size, FORCED_LEVERAGE, this.config.fees.taker);
            this.metrics.recordTrade({ 
                side: snapPos.side, contracts: snapPos.contracts, entryPrice: snapPos.entryPrice, exitPrice: realExitPrice, 
                marginUsed: math.margin, grossPnl: math.grossPnlUsd, grossRoiPct: math.grossRoiPct, netPnl: math.netPnlUsd, roiPct: math.netRoiPct, feeCost: math.feeCost, exitReason: reason 
            });
            
            this.lastCloseTime = Date.now(); await this.saveState();
            console.log(`[User ${this.userId}] ${snapPos.isPaper?'Paper':'LIVE'} CLOSED: ${reason}`);
        } catch (err) {
            console.error(`🚨 [Close Error - User ${this.userId}]:`, err.message);
        } finally { this.isTrading = false; }
    }
    
    startExchangeROISync() {
        setInterval(async () => {
            if (this.activePositions.length === 0 || this.isTrading) {
                if (this.liveTradingEnabled) {
                    try {
                        const bal = await this.htx.fetchBalance({ type: 'swap' });
                        this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    } catch(e){}
                }
                return;
            }
            const pos = this.activePositions[0];
            
            if (this.liveTradingEnabled && !pos.isPaper) {
                try {
                    const bal = await this.htx.fetchBalance({ type: 'swap' });
                    this.walletBalance = (bal.total && bal.total.USDT) ? bal.total.USDT : 0;
                    const positions = await this.htx.fetchPositions([this.config.htxSymbol]);
                    const openPos = positions.find(p => p.contracts > 0);
                    
                    if (openPos) {
                        let entryP = openPos.entryPrice;
                        if (this.config.htxSymbol.includes('SHIB') && !this.config.htxSymbol.includes('1000')) entryP = entryP * 1000;
                        pos.entryPrice = entryP;
                        
                        pos.exchangeROI = openPos.percentage || 0; 
                        pos.exchangePnl = openPos.unrealizedPnl || 0;
                        return;
                    } else {
                        this.activePositions = [];
                        await this.saveState();
                        return;
                    }
                } catch(e) {}
            }
            
            let currentPrice = pos.side === 'long' ? globalMarketData.binance.bid : globalMarketData.binance.ask;
            if (!currentPrice) currentPrice = globalMarketData.binance.mid;
            
            if (currentPrice && pos.entryPrice > 0) { 
                const sideMult = pos.side === 'long' ? 1 : -1;
                const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * sideMult;
                
                pos.exchangeROI = pnlPercent * FORCED_LEVERAGE;
                pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed; 
            }
        }, 1000);
    }

    getExportData() { 
        return { 
            config: this.config, liveTradingEnabled: this.liveTradingEnabled, uptime: Math.floor((Date.now() - this.startTime) / 1000),
            metrics: this.metrics, activePositions: this.activePositions, mlSignal: this.currentMl, binance: globalMarketData.binance,
            walletBalance: this.walletBalance
        }; 
    }
    
    async getCycleStatus() {
        return await this.cycleManager.getCycleStatus(this.walletBalance);
    }
    
    async startCycle(targetGrowthPct, targetTimeUnit, targetValue) {
        return await this.cycleManager.startNewCycle(targetGrowthPct, targetTimeUnit, targetValue, this.walletBalance);
    }
}

// ==================== WORKER MANAGER ====================
const activeWorkers = new Map();

async function startMasterStreams() {
    let marketsLoaded = false; 
    while (!marketsLoaded) { 
        try { await publicBinance.loadMarkets(); await publicHtx.loadMarkets(); marketsLoaded = true; } 
        catch (e) { await new Promise(r => setTimeout(r, 5000)); } 
    }

    try {
        const history = await ChartDataModel.find().sort({ timestamp: -1 }).limit(800).lean();
        if (history) history.reverse().forEach(doc => memoryChartHistory.push({ priceMid: doc.priceMid, mlPlot: doc.mlPlot || 0.5, timestamp: doc.timestamp }));
    } catch(e) {}

    (async function streamBinance() {
        let lastHistorySave = 0, lastSavedMid = null, lastSavedMlPlot = null;
        
        try {
            const seedData = await publicBinance.fetchOHLCV(BASE_CONFIG.binanceSymbol, '1m', undefined, 100);
            if (seedData && seedData.length > 0) {
                seedData.forEach(c => {
                    const seedMid = c[4];
                    if (globalMarketData.tickBuffer.length === 0 || globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] !== seedMid) {
                        globalMarketData.tickBuffer.push(seedMid);
                    }
                });
            }
        } catch (e) { console.log("Seeding failed, starting empty."); }

        while (true) {
            try {
                let mid = 0;
                try {
                    const ticker = await Promise.race([
                        publicBinance.watchTicker(BASE_CONFIG.binanceSymbol),
                        new Promise((_, r) => setTimeout(() => r(new Error('WS_TIMEOUT')), 3000))
                    ]);
                    let bid = ticker.bid !== undefined ? ticker.bid : ticker.last;
                    let ask = ticker.ask !== undefined ? ticker.ask : ticker.last;
                    mid = (bid + ask) / 2;
                } catch(wsErr) {
                    const ticker = await publicBinance.fetchTicker(BASE_CONFIG.binanceSymbol); 
                    let bid = ticker.bid !== undefined ? ticker.bid : ticker.last;
                    let ask = ticker.ask !== undefined ? ticker.ask : ticker.last;
                    mid = (bid + ask) / 2;
                    await new Promise(r => setTimeout(r, 1000)); 
                }

                if (!mid || isNaN(mid)) { await new Promise(r => setTimeout(r, 1000)); continue; }

                globalMarketData.binance = { bid: mid, ask: mid, mid: mid, timestamp: Date.now() };
                
                const lastTick = globalMarketData.tickBuffer.length > 0 ? globalMarketData.tickBuffer[globalMarketData.tickBuffer.length - 1] : null;
                if (mid !== lastTick) {
                    globalMarketData.tickBuffer.push(mid);
                    if (globalMarketData.tickBuffer.length > 500) globalMarketData.tickBuffer.shift();
                }

                mlSignalCache.clear();
                const globalMl = calculateMLSignal(globalMarketData.tickBuffer, BASE_CONFIG.mlLookback);
                globalMarketData.mlSignal = globalMl;
                mlSignalCache.set(BASE_CONFIG.mlLookback, globalMl); 

                if (Date.now() - lastHistorySave > 2000) { 
                    if (mid !== lastSavedMid || globalMl.rawValue !== lastSavedMlPlot) {
                        const doc = { priceMid: mid, mlPlot: globalMl.rawValue, timestamp: Date.now() };
                        memoryChartHistory.push(doc); if (memoryChartHistory.length > 800) memoryChartHistory.shift(); 
                        ChartDataModel.create(doc).catch(()=>{}); 
                        lastHistorySave = Date.now(); lastSavedMid = mid; lastSavedMlPlot = globalMl.rawValue;
                    }
                }

                for (const worker of activeWorkers.values()) {
                    worker.checkExits().catch(()=>{}); 
                    worker.evaluateAIEntry().catch(()=>{}); 
                }

                await new Promise(r => setTimeout(r, 100)); 
            } catch (e) { 
                await new Promise(r => setTimeout(r, 2000)); 
            }
        }
    })();
}

async function loadAllUsers() {
    try {
        const users = await UserModel.find({});
        for(const u of users) {
            try {
                const worker = new UserTradeInstance(u);
                await worker.initialize();
                activeWorkers.set(u._id.toString(), worker);
                if (u.token) tokenCache.set(u.token, { user: u, lastAccessed: Date.now() });
            } catch(we) { console.error(`Worker error for ${u.email}:`, we.message); }
        }
    } catch(e) {}
}

// ==================== ANALYTICS ENGINE ====================
const activeSessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [sid, data] of activeSessions.entries()) {
        if (now - data.lastSeen > 15000) activeSessions.delete(sid);
    }
}, 5000);

// ==================== EXPRESS SERVER & API ====================
const app = express(); app.use(express.json());

app.post('/api/analytics/track', async (req, res) => {
    const { sessionId, page, isView } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing session' });
    activeSessions.set(sessionId, { page: page || 'unknown', lastSeen: Date.now() });

    if (isView) {
        try {
            let doc = await AnalyticsModel.findOne({ key: "global" });
            if (!doc) doc = await AnalyticsModel.create({ key: "global" });
            doc.views += 1;
            if (!doc.knownIds.includes(sessionId)) { doc.knownIds.push(sessionId); doc.uniques += 1; }
            await doc.save();
        } catch(e) {}
    }
    res.json({ status: 'ok' });
});

app.get('/api/analytics/stats', async (req, res) => {
    try {
        let doc = await AnalyticsModel.findOne({ key: "global" });
        const pageBreakdown = {};
        for (const data of activeSessions.values()) pageBreakdown[data.page] = (pageBreakdown[data.page] || 0) + 1;
        res.json({ online: activeSessions.size, views: doc ? doc.views : 0, uniques: doc ? doc.uniques : 0, pages: pageBreakdown });
    } catch(e) { res.status(500).json({ error: 'Failed to load stats' }); }
});

app.post('/api/backtest', async (req, res) => {
    const bConfig = { ...BASE_CONFIG,
        takeProfitPct: parseFloat(req.body.tpPct) || 10.0, stopLossPct: parseFloat(req.body.slPct) || -50.0,
        baseContracts: parseInt(req.body.baseContracts) || 1, mlLookback: parseInt(req.body.mlLookback) || 50,
        mlThreshold: parseFloat(req.body.mlThreshold) || 60.0, mlAverageTicks: parseInt(req.body.mlAverageTicks) || 5,
        mlUseAverage: (req.body.mlUseAverage === 'true'), flipOnlyInProfit: (req.body.flipOnlyInProfit === 'true'),
        flipThresholdPct: parseFloat(req.body.flipThresholdPct) || 0.5,
        dcaRoiThresholdPct: parseFloat(req.body.dcaRoiThresholdPct) || 1.0, 
        dcaMultiplier: parseFloat(req.body.dcaMultiplier) || 2.0,
        profitRoiThresholdPct: parseFloat(req.body.profitRoiThresholdPct) || 2.0,
        profitMultiplier: parseFloat(req.body.profitMultiplier) || 2.0,
        maxContracts: parseInt(req.body.maxContracts) || 100
    };
    try {
        const results = await runBacktestSimulation(bConfig, parseInt(req.body.ticks) || 5000, BASE_CONFIG.binanceSymbol);
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if(await UserModel.findOne({ email })) return res.status(400).json({ error: 'Email already exists' });
        
        const salt = crypto.randomBytes(16).toString('hex');
        const user = await UserModel.create({ name, email, passwordHash: hashPassword(password, salt), salt, token: generateToken() });
        
        const worker = new UserTradeInstance(user);
        await worker.initialize();
        activeWorkers.set(user._id.toString(), worker);
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Registration failed' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const user = await UserModel.findOne({ email: req.body.email });
        if(!user || hashPassword(req.body.password, user.salt) !== user.passwordHash) return res.status(400).json({ error: 'Invalid credentials' });

        user.token = generateToken(); await user.save();
        tokenCache.set(user.token, { user, lastAccessed: Date.now() });

        res.json({ token: user.token, user: { name: user.name, email: user.email } });
    } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/user/me', authMiddleware, (req, res) => {
    res.json({ name: req.user.name, email: req.user.email, apiKey: req.user.apiKey, liveTradingEnabled: req.user.liveTradingEnabled });
});

app.post('/api/user/keys', authMiddleware, async (req, res) => {
    try {
        const { apiKey, apiSecret, liveTradingEnabled } = req.body;
        
        let worker = activeWorkers.get(req.user._id.toString());
        if(worker) {
            if (Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && worker.activePositions[0].isPaper) {
                worker.activePositions = [];
            }
            if (!Boolean(liveTradingEnabled) && worker.activePositions.length > 0 && !worker.activePositions[0].isPaper) {
                worker.activePositions = [];
            }
            
            worker.applyUserKeys({ apiKey, apiSecret, liveTradingEnabled });
            const connectionResult = await worker.connectExchange();
            
            if (liveTradingEnabled && !connectionResult.success) {
                worker.liveTradingEnabled = false; 
                return res.json({ error: 'Exchange Error: ' + connectionResult.message });
            }
            req.user.liveTradingEnabled = worker.liveTradingEnabled;
        } else {
            req.user.liveTradingEnabled = Boolean(liveTradingEnabled);
        }

        req.user.apiKey = apiKey; req.user.apiSecret = apiSecret; 
        await req.user.save();
        res.json({ status: 'ok' });
    } catch(e) { res.status(500).json({ error: 'Failed to update settings' }); }
});

app.post('/api/user/config', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if(!worker) return res.status(400).json({ error: 'Worker not active' });
    
    const { tpPct, slPct, baseContracts, contractSize, mlLookbackSens, mlThresholdSens, mlAverageTicksSens, mlUseAverageSens, flipOnlyInProfitSens, flipThresholdSens, dcaRoiThresholdSens, dcaMultiplierSens, profitRoiThresholdSens, profitMultiplierSens, maxContractsSens } = req.body;
    const pSet = (v, f, k) => { if (v !== undefined && v !== "") { const p = f(v); if (!isNaN(p)) worker.config[k] = p; } };

    pSet(tpPct, parseFloat, 'takeProfitPct'); pSet(slPct, parseFloat, 'stopLossPct');
    pSet(baseContracts, parseInt, 'baseContracts'); pSet(contractSize, parseFloat, 'contractSize'); 
    pSet(mlLookbackSens, parseInt, 'mlLookback'); pSet(mlThresholdSens, parseFloat, 'mlThreshold');
    pSet(mlAverageTicksSens, parseInt, 'mlAverageTicks'); 
    pSet(dcaRoiThresholdSens, parseFloat, 'dcaRoiThresholdPct'); 
    pSet(dcaMultiplierSens, parseFloat, 'dcaMultiplier'); 
    pSet(profitRoiThresholdSens, parseFloat, 'profitRoiThresholdPct');
    pSet(profitMultiplierSens, parseFloat, 'profitMultiplier');
    pSet(flipThresholdSens, parseFloat, 'flipThresholdPct');
    pSet(maxContractsSens, parseInt, 'maxContracts'); 
    
    if (mlUseAverageSens !== undefined) worker.config.mlUseAverage = (mlUseAverageSens === 'true');
    if (flipOnlyInProfitSens !== undefined) worker.config.flipOnlyInProfit = (flipOnlyInProfitSens === 'true');

    req.user.config = worker.config; req.user.markModified('config'); await req.user.save();
    res.json({status: 'ok', config: worker.config});
});

app.post('/api/user/reset-metrics', authMiddleware, async (req, res) => {
    try {
        const worker = activeWorkers.get(req.user._id.toString());
        if(worker) { await TradeModel.deleteMany({ userId: req.user._id.toString() }); worker.metrics = new PerformanceMetrics(worker.userId); }
        res.json({status: 'ok'});
    } catch(err) { res.status(500).json({error: 'Failed to reset metrics'}); }
});

app.get('/api/data', authMiddleware, (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    res.json(worker ? worker.getExportData() : { error: "Worker not found" });
});

app.get('/api/cycle-status', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if (!worker) return res.json({ error: "Worker not found" });
    const status = await worker.getCycleStatus();
    res.json(status);
});

app.post('/api/start-cycle', authMiddleware, async (req, res) => {
    const worker = activeWorkers.get(req.user._id.toString());
    if (!worker) return res.json({ error: "Worker not found" });
    const { targetGrowthPct, targetTimeUnit, targetValue } = req.body;
    const cycle = await worker.startCycle(targetGrowthPct, targetTimeUnit, targetValue);
    res.json(cycle);
});

app.get('/api/chart-history', (req, res) => res.json(memoryChartHistory.slice(-800))); 
app.get('/api/close-all', authMiddleware, async (req, res) => { 
    const worker = activeWorkers.get(req.user._id.toString());
    if(worker) await worker.forceClosePosition("MANUAL_FORCE_CLOSE").catch(()=>{}); 
    res.json({status: 'ok'}); 
});

// ==================== FRONTEND UI ====================
app.get('/', (req, res) => { res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TradeBotPille | SHIB AI Engine with DGR Cycle Tracking</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Roboto', sans-serif; background: #fafafa; }
        .font-mono { font-family: 'Roboto Mono', monospace; }
        .cycle-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .cycle-achieved { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
        .cycle-waiting { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
    </style>
</head>
<body class="min-h-screen">
    <div class="max-w-7xl mx-auto px-4 py-8">
        <div class="bg-white rounded-2xl shadow-xl overflow-hidden">
            <div class="bg-gradient-to-r from-gray-900 to-gray-800 px-6 py-4">
                <h1 class="text-2xl font-bold text-white">TradeBotPille <span class="text-sm font-normal text-gray-400">DGR Cycle Trading Engine</span></h1>
            </div>
            
            <div class="p-6">
                <!-- Cycle Status Card -->
                <div id="cycleStatusCard" class="mb-6 rounded-xl p-6 cycle-card text-white">
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="text-xl font-bold mb-2">📊 DGR Cycle Status</h2>
                            <p id="cycleStatusText" class="text-sm opacity-90">No active cycle</p>
                        </div>
                        <div id="cycleProgress" class="text-right">
                            <div class="text-3xl font-bold">0%</div>
                            <div class="text-xs opacity-75">Progress</div>
                        </div>
                    </div>
                    <div class="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div><span class="opacity-75">Target Growth:</span> <br><span id="cycleTargetGrowth" class="font-bold">-</span></div>
                        <div><span class="opacity-75">Target USDT:</span> <br><span id="cycleTargetUsdt" class="font-bold">-</span></div>
                        <div><span class="opacity-75">Target SHIB:</span> <br><span id="cycleTargetShib" class="font-bold">-</span></div>
                        <div><span class="opacity-75">Time Remaining:</span> <br><span id="cycleTimeRemaining" class="font-bold">-</span></div>
                    </div>
                    <div class="mt-4 pt-3 border-t border-white/20">
                        <div class="flex justify-between text-xs">
                            <span>Current Growth: <span id="cycleCurrentGrowth" class="font-bold">0%</span></span>
                            <span>Current USDT: <span id="cycleCurrentUsdt" class="font-bold">$0</span></span>
                            <span>Current SHIB: <span id="cycleCurrentShib" class="font-bold">0</span></span>
                        </div>
                        <div class="mt-2 w-full bg-white/20 rounded-full h-2 overflow-hidden">
                            <div id="cycleProgressBar" class="bg-white h-2 rounded-full transition-all duration-500" style="width: 0%"></div>
                        </div>
                    </div>
                </div>
                
                <!-- DGR Controls -->
                <div class="bg-gray-50 rounded-xl p-6 mb-6">
                    <h3 class="text-lg font-bold mb-4">🎯 Set Daily Growth Rate Target</h3>
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <label class="block text-xs font-semibold text-gray-600 mb-1">Time Unit</label>
                            <select id="cycleTimeUnit" class="w-full border rounded-lg px-3 py-2">
                                <option value="minute">Minute</option>
                                <option value="minute10">10 Minutes</option>
                                <option value="minute30">30 Minutes</option>
                                <option value="hour">Hour</option>
                                <option value="hour2">2 Hours</option>
                                <option value="hour10">10 Hours</option>
                                <option value="day">Day</option>
                                <option value="week">Week</option>
                                <option value="month">Month</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-gray-600 mb-1">Target Value</label>
                            <input type="number" id="cycleTargetValue" class="w-full border rounded-lg px-3 py-2" value="1" min="1">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-gray-600 mb-1">Growth Rate (%)</label>
                            <input type="number" id="cycleGrowthRate" class="w-full border rounded-lg px-3 py-2" value="5" step="0.1">
                        </div>
                        <div class="flex items-end">
                            <button onclick="startNewCycle()" class="w-full bg-blue-600 text-white rounded-lg px-4 py-2 font-semibold hover:bg-blue-700 transition">
                                Start Cycle
                            </button>
                        </div>
                    </div>
                    <div class="mt-4 p-3 bg-blue-50 rounded-lg text-sm">
                        <p class="text-gray-700">📈 <strong>Example:</strong> Set "Hour" + "1" + "5%" = Target 5% growth in 1 hour. Trading stops until target achieved or cycle ends!</p>
                    </div>
                </div>
                
                <!-- Dashboard Placeholder -->
                <div id="dashboardPlaceholder" class="text-center py-12 text-gray-500">
                    <p>⚠️ Please login to access the full trading dashboard with ML signals and trade execution.</p>
                    <button onclick="alert('Please use the original login system')" class="mt-4 bg-black text-white px-6 py-2 rounded-lg">Login / Register</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let authToken = localStorage.getItem('bot_token');
        
        async function doAPI(endpoint, method, body) {
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = authToken;
            const res = await fetch(endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
            return await res.json();
        }
        
        async function fetchCycleStatus() {
            if (!authToken) return;
            const data = await doAPI('/api/cycle-status', 'GET');
            if (data.hasActiveCycle) {
                document.getElementById('cycleStatusCard').className = 'mb-6 rounded-xl p-6 cycle-card text-white';
                document.getElementById('cycleStatusText').innerHTML = '🎯 <strong>Active Cycle</strong> - Trading until target achieved';
                document.getElementById('cycleTargetGrowth').innerHTML = data.targetGrowthPct.toFixed(2) + '%';
                document.getElementById('cycleTargetUsdt').innerHTML = '$' + data.targetAmountUsd.toFixed(2);
                document.getElementById('cycleTargetShib').innerHTML = data.targetAmountShib.toLocaleString();
                document.getElementById('cycleTimeRemaining').innerHTML = data.timeRemainingFormatted;
                document.getElementById('cycleCurrentGrowth').innerHTML = data.currentGrowthPct.toFixed(2) + '%';
                document.getElementById('cycleCurrentUsdt').innerHTML = '$' + data.currentGrowthUsd.toFixed(2);
                document.getElementById('cycleCurrentShib').innerHTML = Math.floor(data.currentGrowthShib).toLocaleString();
                const progress = (data.currentGrowthPct / data.targetGrowthPct) * 100;
                document.getElementById('cycleProgressBar').style.width = Math.min(progress, 100) + '%';
                document.getElementById('cycleProgress').innerHTML = '<div class="text-3xl font-bold">' + Math.min(progress, 100).toFixed(1) + '%</div><div class="text-xs opacity-75">Progress</div>';
            } else if (data.isWaiting) {
                document.getElementById('cycleStatusCard').className = 'mb-6 rounded-xl p-6 cycle-waiting text-white';
                document.getElementById('cycleStatusText').innerHTML = '⏳ <strong>Waiting Period</strong> - Cycle achieved, next cycle starts in ' + data.waitRemainingFormatted;
                document.getElementById('cycleTargetGrowth').innerHTML = data.lastCycle ? data.lastCycle.targetGrowthPct.toFixed(2) + '%' : '-';
                document.getElementById('cycleTargetUsdt').innerHTML = data.lastCycle ? '$' + data.lastCycle.targetAmountUsd.toFixed(2) : '-';
                document.getElementById('cycleTargetShib').innerHTML = data.lastCycle ? data.lastCycle.targetAmountShib.toLocaleString() : '-';
                document.getElementById('cycleTimeRemaining').innerHTML = data.waitRemainingFormatted;
                document.getElementById('cycleCurrentGrowth').innerHTML = data.lastCycle ? data.lastCycle.achievedGrowthPct.toFixed(2) + '%' : '0%';
                document.getElementById('cycleProgressBar').style.width = '100%';
                document.getElementById('cycleProgress').innerHTML = '<div class="text-3xl font-bold">✓</div><div class="text-xs opacity-75">Completed</div>';
            } else {
                document.getElementById('cycleStatusCard').className = 'mb-6 rounded-xl p-6 bg-gray-600 text-white';
                document.getElementById('cycleStatusText').innerHTML = '💡 <strong>No Active Cycle</strong> - Set a DGR target above to start';
                document.getElementById('cycleTargetGrowth').innerHTML = '-';
                document.getElementById('cycleTargetUsdt').innerHTML = '-';
                document.getElementById('cycleTargetShib').innerHTML = '-';
                document.getElementById('cycleTimeRemaining').innerHTML = '-';
                document.getElementById('cycleCurrentGrowth').innerHTML = '0%';
                document.getElementById('cycleProgressBar').style.width = '0%';
                document.getElementById('cycleProgress').innerHTML = '<div class="text-3xl font-bold">0%</div><div class="text-xs opacity-75">Progress</div>';
            }
        }
        
        async function startNewCycle() {
            const timeUnit = document.getElementById('cycleTimeUnit').value;
            const targetValue = parseInt(document.getElementById('cycleTargetValue').value);
            const growthRate = parseFloat(document.getElementById('cycleGrowthRate').value);
            
            const res = await doAPI('/api/start-cycle', 'POST', {
                targetGrowthPct: growthRate,
                targetTimeUnit: timeUnit,
                targetValue: targetValue
            });
            
            if (res.id) {
                alert('✅ Cycle started! Target: ' + growthRate + '% in ' + targetValue + ' ' + timeUnit + '(s)');
                fetchCycleStatus();
            } else {
                alert('❌ Failed to start cycle');
            }
        }
        
        // Check auth and redirect to original dashboard if needed
        if (authToken) {
            fetchCycleStatus();
            setInterval(fetchCycleStatus, 2000);
        }
        
        // Poll cycle status every 2 seconds
        setInterval(() => { if(authToken) fetchCycleStatus(); }, 2000);
    </script>
</body>
</html>`); });

// ==================== APP INITIALIZATION ====================
app.listen(CUSTOM_PORT, async () => {
    console.log(`✅ Server running on port ${CUSTOM_PORT}`);
    await loadAllUsers();
    startMasterStreams();
});
