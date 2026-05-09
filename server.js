const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');

// Safe Bcrypt Fallback for Vercel
let bcrypt;
try {
    bcrypt = require('bcryptjs');
} catch (err) {
    bcrypt = require('bcrypt');
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_this_in_production';

// DATABASE URL
const MONGO_URI = 'mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888';

// ==========================================
// 1. MONGODB DATABASE SETUP
// ==========================================
let cachedDb = global.mongoose;
if (!cachedDb) {
    cachedDb = global.mongoose = { conn: null, promise: null };
}

const connectDB = async () => {
    if (cachedDb.conn) return cachedDb.conn;
    if (!cachedDb.promise) {
        cachedDb.promise = mongoose.connect(MONGO_URI, { 
            bufferCommands: false,
            maxPoolSize: 10 
        }).then((mongoose) => {
            console.log('✅ Connected to MongoDB successfully!');
            return mongoose;
        }).catch(err => {
            console.error('❌ MongoDB Connection Error:', err);
            cachedDb.promise = null; 
        });
    }
    cachedDb.conn = await cachedDb.promise;
    return cachedDb.conn;
};

// ==========================================
// 2. MONGOOSE SCHEMAS (DUAL-MODE)
// ==========================================
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    plainPassword: { type: String }, 
    isPaper: { type: Boolean, default: true } 
});
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const CoinSettingSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    botActive: { type: Boolean, default: true } 
});

const SubAccountSchema = new mongoose.Schema({
    name: { type: String, required: true },
    apiKey: { type: String, required: true },
    secret: { type: String, required: true },
    side: { type: String, default: 'long' }, 
    leverage: { type: Number, default: 10 },
    baseQty: { type: Number, default: 1 },
    takeProfitPct: { type: Number, default: 5.0 },
    stopLossPct: { type: Number, default: -25.0 },
    triggerRoiPct: { type: Number, default: -15.0 },
    dcaTargetRoiPct: { type: Number, default: -2.0 },
    maxContracts: { type: Number, default: 1000 },
    realizedPnl: { type: Number, default: 0 },
    coins: [CoinSettingSchema]
});

const SettingsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    qtyMultiplier: { type: Number, default: 1 },
    globalTargetPnl: { type: Number, default: 0 },       
    globalTrailingPnl: { type: Number, default: 0 },     
    smartOffsetNetProfit: { type: Number, default: 0 },
    smartOffsetBottomRowV1: { type: Number, default: 5 }, 
    smartOffsetBottomRowV1StopLoss: { type: Number, default: 0 }, 
    smartOffsetStopLoss: { type: Number, default: 0 }, 
    smartOffsetNetProfit2: { type: Number, default: 0 }, 
    smartOffsetStopLoss2: { type: Number, default: 0 }, 
    smartOffsetMaxLossPerMinute: { type: Number, default: 0 }, 
    smartOffsetMaxLossTimeframeSeconds: { type: Number, default: 60 },
    minuteCloseAutoDynamic: { type: Boolean, default: false },
    minuteCloseTpMinPnl: { type: Number, default: 0 }, 
    minuteCloseTpMaxPnl: { type: Number, default: 0 },
    minuteCloseSlMinPnl: { type: Number, default: 0 }, 
    minuteCloseSlMaxPnl: { type: Number, default: 0 },
    noPeakSlTimeframeSeconds: { type: Number, default: 1800 }, 
    noPeakSlGatePnl: { type: Number, default: 0 }, 
    subAccounts: [SubAccountSchema],
    
    currentGlobalPeak: { type: Number, default: 0 },
    lastStopLossTime: { type: Number, default: 0 },
    lastNoPeakSlTime: { type: Number, default: 0 },
    rollingStopLosses: { type: Array, default: [] },
    autoDynamicLastExecution: { type: Object, default: null }
});

// UNIVERSAL HISTORY SCHEMA
const OffsetRecordSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String }, 
    reason: { type: String }, 
    winnerSymbol: { type: String },
    winnerPnl: { type: Number },
    loserSymbol: { type: String },
    loserPnl: { type: Number },
    netProfit: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
});

const ProfileStateSchema = new mongoose.Schema({
    profileId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    logs: { type: [String], default: [] },
    coinStates: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastUpdated: { type: Date, default: Date.now }
});

const MainTemplateSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    settings: { type: Object, required: true }
});

// MULTI-MODE DB COLLECTIONS
const RealSettings = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema, 'settings');
const PaperSettings = mongoose.models.PaperSettings || mongoose.model('PaperSettings', SettingsSchema, 'paper_settings');
const RealOffsetRecord = mongoose.models.OffsetRecord || mongoose.model('OffsetRecord', OffsetRecordSchema, 'offset_records');
const PaperOffsetRecord = mongoose.models.PaperOffsetRecord || mongoose.model('PaperOffsetRecord', OffsetRecordSchema, 'paper_offset_records');
const RealProfileState = mongoose.models.ProfileState || mongoose.model('ProfileState', ProfileStateSchema, 'profile_states');
const PaperProfileState = mongoose.models.PaperProfileState || mongoose.model('PaperProfileState', ProfileStateSchema, 'paper_profile_states');
const MainTemplate = mongoose.models.MainTemplate || mongoose.model('MainTemplate', MainTemplateSchema, 'main_settings_template');

// ==========================================
// 3. MULTI-MODE BOT ENGINE STATE
// ==========================================
global.activeBots = global.activeBots || new Map();
const activeBots = global.activeBots;

function logForProfile(profileId, msg) {
    console.log(`[Profile: ${profileId}] ${msg}`);
    const bot = activeBots.get(profileId);
    if (bot) {
        bot.state.logs.unshift(`${new Date().toLocaleTimeString()} - ${msg}`);
        if (bot.state.logs.length > 50) bot.state.logs.pop();
    }
}

function calculateDcaQty(side, P0, Pc, C0, leverage, targetRoiPct) {
    const R = targetRoiPct / 100;
    let Pnew, Cn;
    if (side === 'long') {
        Pnew = Pc / (1 + (R / leverage));
        Cn = C0 * (P0 - Pnew) / (Pnew - Pc);
    } else {
        Pnew = Pc / (1 - (R / leverage));
        Cn = C0 * (Pnew - P0) / (Pc - Pnew);
    }
    if (Cn <= 0 || isNaN(Cn) || !isFinite(Cn)) return 0;
    return Math.ceil(Cn); 
}

async function startBot(userId, subAccount, isPaper) {
    const userDoc = await User.findById(userId);
    if (userDoc && userDoc.username === 'webcoin8888') {
        console.log(`[Profile: ${subAccount._id}] 🛑 Engine Disabled: Master account (webcoin8888) is for database template editing only.`);
        return;
    }

    const profileId = subAccount._id.toString();
    if (activeBots.has(profileId)) stopBot(profileId);

    if (!subAccount.apiKey || !subAccount.secret) return;

    const exchange = new ccxt.htx({ 
        apiKey: subAccount.apiKey, 
        secret: subAccount.secret, 
        options: { defaultType: 'swap' },
        enableRateLimit: true 
    });
    
    const ProfileStateModel = isPaper ? PaperProfileState : RealProfileState;
    const SettingsModel = isPaper ? PaperSettings : RealSettings;

    let dbState = await ProfileStateModel.findOne({ profileId });
    if (!dbState) {
        dbState = await ProfileStateModel.create({ profileId, userId, logs: [], coinStates: {} });
    }
    
    const state = { logs: dbState.logs || [], coinStates: dbState.coinStates || {} };
    let isProcessing = false;
    let lastError = '';

    const intervalId = setInterval(async () => {
        if (isProcessing) return; 
        isProcessing = true;

        const botData = activeBots.get(profileId);
        if (!botData) { isProcessing = false; return; }
        
        const currentSettings = botData.settings;
        
        // --- FORCE ALL COINS ACTIVE ALWAYS ---
        let forcedStart = false;
        currentSettings.coins.forEach(c => {
            if (!c.botActive) {
                c.botActive = true;
                forcedStart = true;
            }
        });
        
        if (forcedStart) {
            logForProfile(profileId, `🔄 Auto-Healed: Restarted stopped coins to keep them active always.`);
            SettingsModel.updateOne(
                { "subAccounts._id": currentSettings._id },
                { $set: { "subAccounts.$.coins": currentSettings.coins } }
            ).catch(()=>{});
        }
        
        const activeCoins = currentSettings.coins;

        if (activeCoins.length === 0) { isProcessing = false; return; }

        try {
            if (!exchange.markets) await exchange.loadMarkets().catch(()=>{});
            const symbolsToFetch = activeCoins.map(c => c.symbol);
            
            let positions = [];
            let allTickers = {};

            if (!isPaper) {
                const [fetchedPos, fetchedTick] = await Promise.all([
                    exchange.fetchPositions(symbolsToFetch).catch(e => { throw new Error('Positions: ' + e.message); }),
                    exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); })
                ]);
                positions = fetchedPos;
                allTickers = fetchedTick;
            } else {
                allTickers = await exchange.fetchTickers(symbolsToFetch).catch(e => { throw new Error('Tickers: ' + e.message); });
            }

            for (let coin of activeCoins) {
                try {
                    const activeLeverage = 10;
                    const activeSide = coin.side || currentSettings.side;
                    const market = exchange.markets[coin.symbol];
                    const contractSize = (market && market.contractSize) ? market.contractSize : 1;

                    if (!state.coinStates[coin.symbol]) {
                        state.coinStates[coin.symbol] = { status: 'Running', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0, lastDcaTime: 0, lockUntil: 0 };
                    }

                    let cState = state.coinStates[coin.symbol];
                    if (cState.lockUntil && Date.now() < cState.lockUntil) continue;
                    
                    const ticker = allTickers[coin.symbol];
                    if (!ticker || !ticker.last) continue; 
                    
                    cState.currentPrice = ticker.last;
                    cState.activeSide = activeSide;

                    const ESTIMATED_FEE_RATE = 0.001; 

                    if (!isPaper) {
                        const pos = positions.find(p => p.symbol === coin.symbol && p.side === activeSide);
                        cState.contracts = pos ? pos.contracts : 0;
                        cState.avgEntry = pos ? pos.entryPrice : 0;
                        
                        let grossPnl = 0;
                        if (pos) {
                            if (pos.unrealizedPnl !== undefined && pos.unrealizedPnl !== null) {
                                grossPnl = pos.unrealizedPnl;
                            } else {
                                grossPnl = (activeSide === 'long') 
                                    ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                    : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            }
                        }

                        const positionValue = cState.contracts * contractSize * cState.currentPrice;
                        const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                        cState.unrealizedPnl = cState.contracts > 0 ? (grossPnl - estimatedFee) : 0;
                        cState.margin = pos ? (pos.initialMargin || pos.cost || 0) : 0;
                        cState.currentRoi = (cState.margin > 0 && cState.contracts > 0) ? (cState.unrealizedPnl / cState.margin) * 100 : 0; 
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                    } else {
                        cState.status = cState.contracts > 0 ? 'In Position' : 'Waiting to Enter';
                        if (cState.contracts > 0) {
                            let margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                            let grossPnl = (activeSide === 'long') 
                                ? (cState.currentPrice - cState.avgEntry) * cState.contracts * contractSize 
                                : (cState.avgEntry - cState.currentPrice) * cState.contracts * contractSize;
                            
                            const positionValue = cState.contracts * contractSize * cState.currentPrice;
                            const estimatedFee = positionValue * ESTIMATED_FEE_RATE;

                            cState.unrealizedPnl = grossPnl - estimatedFee;
                            cState.margin = margin;
                            cState.currentRoi = margin > 0 ? (cState.unrealizedPnl / margin) * 100 : 0;
                        } else {
                            cState.unrealizedPnl = 0;
                            cState.margin = 0;
                            cState.currentRoi = 0;
                        }
                    }

                    // 1. OPEN BASE POSITION
                    if (cState.contracts <= 0) {
                        const safeBaseQty = Math.max(1, Math.floor(currentSettings.baseQty));
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        logForProfile(profileId, `[${modeTxt}] 🛒 Opening base position of ${safeBaseQty} contracts (${activeSide}) at ~${cState.currentPrice}.`);
                        
                        if (!isPaper) {
                            const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                            await exchange.createOrder(coin.symbol, 'market', orderSide, safeBaseQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                        } else {
                            cState.avgEntry = cState.currentPrice; 
                            cState.contracts = safeBaseQty; 
                            cState.currentRoi = 0; 
                            cState.unrealizedPnl = 0; 
                            cState.margin = (cState.avgEntry * cState.contracts * contractSize) / activeLeverage;
                        }

                        // PRECISE EXCHANGE LOG: Opening Position
                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({
                            userId: userId,
                            symbol: coin.symbol,
                            winnerSymbol: coin.symbol, 
                            reason: `Open Base Position (${safeBaseQty} contracts)`,
                            netProfit: 0
                        }).catch(()=>{});
                        
                        cState.lockUntil = Date.now() + 5000; 
                        continue; 
                    }

                    // 2. TAKE PROFIT OR STOP LOSS
                    const isTakeProfit = cState.currentRoi >= currentSettings.takeProfitPct;
                    const isStopLoss = currentSettings.stopLossPct < 0 && cState.currentRoi <= currentSettings.stopLossPct;

                    if (isTakeProfit || isStopLoss) {
                        const reasonTxt = isTakeProfit ? `Take Profit Hit (ROI >= ${currentSettings.takeProfitPct}%)` : `Stop Loss Hit (ROI <= ${currentSettings.stopLossPct}%)`;
                        const modeTxt = isPaper ? "PAPER" : "REAL";
                        logForProfile(profileId, `[${modeTxt}] ${reasonTxt}. Closing ${cState.contracts} contracts.`);
                        
                        if (!isPaper) {
                            const closeSide = activeSide === 'long' ? 'sell' : 'buy';
                            await exchange.createOrder(coin.symbol, 'market', closeSide, cState.contracts, undefined, { offset: 'close' });
                        }

                        cState.lockUntil = Date.now() + 5000;
                        currentSettings.realizedPnl = (currentSettings.realizedPnl || 0) + cState.unrealizedPnl;
                        
                        // PRECISE EXCHANGE LOG: Close Position
                        const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                        OffsetModel.create({
                            userId: userId,
                            symbol: coin.symbol,
                            winnerSymbol: coin.symbol,
                            reason: reasonTxt,
                            netProfit: cState.unrealizedPnl
                        }).catch(()=>{});

                        if (isPaper) {
                            cState.contracts = 0; cState.unrealizedPnl = 0; cState.currentRoi = 0; cState.avgEntry = 0;
                        }

                        SettingsModel.updateOne({ "subAccounts._id": currentSettings._id }, { $set: { "subAccounts.$.realizedPnl": currentSettings.realizedPnl } }).catch(()=>{});
                        continue; 
                    }

                    // 3. DCA TRIGGER
                    if (cState.currentRoi <= currentSettings.triggerRoiPct && (Date.now() - (cState.lastDcaTime || 0) > 12000)) {
                        const reqQty = calculateDcaQty(activeSide, cState.avgEntry, cState.currentPrice, cState.contracts, activeLeverage, currentSettings.dcaTargetRoiPct);

                        if (reqQty <= 0) {
                            cState.lastDcaTime = Date.now();
                        } else if ((cState.contracts + reqQty) > currentSettings.maxContracts) {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] 🛡️ DCA Safety Triggered. Max contracts reached.`);
                            cState.lastDcaTime = Date.now(); 
                        } else {
                            logForProfile(profileId, `[${isPaper ? 'PAPER' : 'REAL'}] ⚡ Executing DCA: Buying ${reqQty} contracts at ~${cState.currentPrice}`);
                            
                            if (!isPaper) {
                                const orderSide = activeSide === 'long' ? 'buy' : 'sell';
                                await exchange.createOrder(coin.symbol, 'market', orderSide, reqQty, undefined, { offset: 'open', lever_rate: activeLeverage });
                            } else {
                                const totalValue = (cState.contracts * cState.avgEntry) + (reqQty * cState.currentPrice);
                                cState.contracts += reqQty;
                                cState.avgEntry = totalValue / cState.contracts;
                            }

                            // PRECISE EXCHANGE LOG: DCA Addition
                            const OffsetModel = isPaper ? PaperOffsetRecord : RealOffsetRecord;
                            OffsetModel.create({
                                userId: userId,
                                symbol: coin.symbol,
                                winnerSymbol: coin.symbol,
                                reason: `DCA Added ${reqQty} Contracts (ROI dropped to ${currentSettings.triggerRoiPct}%)`,
                                netProfit: 0
                            }).catch(()=>{});

                            cState.lockUntil = Date.now() + 5000; 
                            cState.lastDcaTime = Date.now(); 
                        }
                    }
                } catch (coinErr) {
                    if (coinErr.message !== lastError) logForProfile(profileId, `[${coin.symbol}] ❌ Warning: ${coinErr.message}`);
                }
            } 
            lastError = '';

            await ProfileStateModel.updateOne(
                { profileId },
                { $set: { logs: state.logs, coinStates: state.coinStates, lastUpdated: Date.now() } }
            ).catch(()=>{});

        } catch (err) {
            if (err.message !== lastError) {
                logForProfile(profileId, `❌ Global API Error (Retrying next cycle): ${err.message}`);
                lastError = err.message;
            }
        } finally {
            isProcessing = false;
        }
    }, 6000);

    activeBots.set(profileId, { userId: String(userId), isPaper, settings: subAccount, state, exchange, intervalId });
    logForProfile(profileId, `🚀 ${isPaper ? 'Paper' : 'Real Live'} Engine Started for: ${subAccount.name}`);
}

function stopBot(profileId) {
    if (activeBots.has(profileId)) {
        clearInterval(activeBots.get(profileId).intervalId);
        activeBots.delete(profileId);
        console.log(`[Profile: ${profileId}] ⏹ Bot Stopped.`);
    }
}

// =========================================================================
// 4. BACKGROUND TASKS (DUAL-MODE)
// =========================================================================
const executeOneMinuteCloser = async () => {
    try {
        await connectDB();
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];

        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            
            let rawTpMin = Math.abs(parseFloat(userSetting.minuteCloseTpMinPnl) || 0);
            let rawTpMax = Math.abs(parseFloat(userSetting.minuteCloseTpMaxPnl) || 0);
            let rawSlMin = -Math.abs(parseFloat(userSetting.minuteCloseSlMinPnl) || 0);
            let rawSlMax = -Math.abs(parseFloat(userSetting.minuteCloseSlMaxPnl) || 0);
            const autoDynamic = userSetting.minuteCloseAutoDynamic || false;
            
            let activeCandidates = [];
            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper,
                            pnl: parseFloat(cState.unrealizedPnl) || 0,
                            contracts: cState.contracts,
                            side: cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side,
                            subAccount: botData.settings,
                            cState: cState
                        });
                    }
                }
            }

            activeCandidates.sort((a, b) => b.pnl - a.pnl);
            const totalCoins = activeCandidates.length;
            const totalPairs = Math.floor(totalCoins / 2);

            if (totalPairs === 0) continue;

            if (autoDynamic) {
                let runningAccumulation = 0;
                let peakAccumulation = 0;

                for (let i = 0; i < totalPairs; i++) {
                    const netResult = activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                    runningAccumulation += netResult;
                    if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; }
                }

                if (peakAccumulation > 0) { 
                    rawTpMin = peakAccumulation * 0.8; rawTpMax = peakAccumulation * 1.2;
                    rawSlMin = -(peakAccumulation * 5.0); rawSlMax = -(peakAccumulation * 0.5); 
                } else {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }

                const multiplier = userSetting.qtyMultiplier || 1;
                if (Math.abs(rawTpMax - rawTpMin) <= 0.000101 * multiplier) {
                    rawTpMin = 0; rawTpMax = 0; rawSlMin = 0; rawSlMax = 0;
                }
            }

            const tpMin = Math.min(rawTpMin, rawTpMax); const tpMax = Math.max(rawTpMin, rawTpMax);
            const slMin = Math.min(rawSlMin, rawSlMax); const slMax = Math.max(rawSlMax, rawSlMin); 

            if (tpMax === 0 && slMax === 0) continue; 

            let runningAccumulation = 0;
            let executedGroup = false;

            for (let i = 0; i < totalPairs; i++) {
                const w = activeCandidates[i];
                const l = activeCandidates[totalCoins - totalPairs + i];
                runningAccumulation += (w.pnl + l.pnl);

                const isPositiveMatch = (tpMax > 0 && runningAccumulation > 0 && runningAccumulation >= tpMin && runningAccumulation <= tpMax);
                const isNegativeMatch = (slMin < 0 && runningAccumulation < 0 && runningAccumulation >= slMin && runningAccumulation <= slMax);

                if (!executedGroup && (isPositiveMatch || isNegativeMatch)) {
                    const executionType = isPositiveMatch ? "Group Take Profit" : "Group Stop Loss";
                    
                    const autoDynData = { time: Date.now(), type: executionType, symbol: `Group up to Row ${i + 1} (WINNERS ONLY)`, pnl: runningAccumulation };
                    await SettingsModel.updateOne({ userId: dbUserId }, { $set: { autoDynamicLastExecution: autoDynData } }).catch(console.error);

                    const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;
                    OffsetModel.create({
                        userId: dbUserId,
                        symbol: `Group of ${i + 1} Coins`,
                        winnerSymbol: `Group of ${i + 1} Coins`,
                        reason: `1-Min Closer Executed (${executionType})`,
                        netProfit: runningAccumulation
                    }).catch(()=>{});

                    logForProfile(activeCandidates[0].profileId, `⏳ 1-Min Group Closer: Group Accumulation $${runningAccumulation.toFixed(4)} matches boundary. Closing ${i + 1} WINNERS ONLY. [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);

                    for (let k = 0; k <= i; k++) {
                        const cw = activeCandidates[k];
                        try {
                            if (!cw.isPaper) {
                                const closeSide = cw.side === 'long' ? 'sell' : 'buy';
                                await cw.exchange.createOrder(cw.symbol, 'market', closeSide, cw.contracts, undefined, { offset: 'close' });
                            } else {
                                cw.cState.contracts = 0; cw.cState.unrealizedPnl = 0; cw.cState.currentRoi = 0; cw.cState.avgEntry = 0;
                            }
                            
                            cw.cState.lockUntil = Date.now() + 5000;
                            cw.subAccount.realizedPnl = (cw.subAccount.realizedPnl || 0) + cw.pnl;
                            SettingsModel.updateOne({ "subAccounts._id": cw.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": cw.subAccount.realizedPnl } }).catch(()=>{});
                        } catch (e) {
                            console.error(`Group Close Error [${cw.symbol}]:`, e.message);
                        }
                    }

                    executedGroup = true;
                    break; 
                }
            }
        }
    } catch (err) {
        console.error("1-Min Group Closer Error:", err);
    }
};

const executeGlobalProfitMonitor = async () => {
    if (global.isGlobalMonitoring) return;
    global.isGlobalMonitoring = true;

    try {
        await connectDB(); 
        const paperUsers = await PaperSettings.find({}).lean();
        const realUsers = await RealSettings.find({}).lean();
        
        const allUsersSettings = [
            ...paperUsers.map(s => ({ ...s, isPaper: true })),
            ...realUsers.map(s => ({ ...s, isPaper: false }))
        ];
        
        for (let userSetting of allUsersSettings) {
            const dbUserId = String(userSetting.userId);
            const SettingsModel = userSetting.isPaper ? PaperSettings : RealSettings;
            const OffsetModel = userSetting.isPaper ? PaperOffsetRecord : RealOffsetRecord;

            let dbUpdates = {}; 
            const multiplier = userSetting.qtyMultiplier || 1;
            
            const globalTargetPnl = parseFloat(userSetting.globalTargetPnl) || 0;
            const globalTrailingPnl = parseFloat(userSetting.globalTrailingPnl) || 0;
            const smartOffsetNetProfit = parseFloat(userSetting.smartOffsetNetProfit) || 0;
            const smartOffsetBottomRowV1 = parseInt(userSetting.smartOffsetBottomRowV1) !== undefined && !isNaN(parseInt(userSetting.smartOffsetBottomRowV1)) ? parseInt(userSetting.smartOffsetBottomRowV1) : 5;
            const smartOffsetBottomRowV1StopLoss = parseFloat(userSetting.smartOffsetBottomRowV1StopLoss) || 0; 
            const smartOffsetStopLoss = parseFloat(userSetting.smartOffsetStopLoss) || 0; 
            const smartOffsetNetProfit2 = parseFloat(userSetting.smartOffsetNetProfit2) || 0;
            const smartOffsetStopLoss2 = parseFloat(userSetting.smartOffsetStopLoss2) || 0; 
            
            const smartOffsetMaxLossPerMinute = parseFloat(userSetting.smartOffsetMaxLossPerMinute) || 0;
            const smartOffsetMaxLossTimeframeSeconds = parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds)) ? parseInt(userSetting.smartOffsetMaxLossTimeframeSeconds) : 60;
            const timeframeMs = smartOffsetMaxLossTimeframeSeconds * 1000;

            const noPeakSlTimeframeSeconds = parseInt(userSetting.noPeakSlTimeframeSeconds) !== undefined && !isNaN(parseInt(userSetting.noPeakSlTimeframeSeconds)) ? parseInt(userSetting.noPeakSlTimeframeSeconds) : 1800;
            const noPeakMs = noPeakSlTimeframeSeconds * 1000; 
            
            // Read value strictly as inputted/saved in DB.
            const noPeakSlGatePnl = parseFloat(userSetting.noPeakSlGatePnl) || 0; 
            
            // Core logic scaling ONLY
            const peakThreshold = 0.0001 * multiplier;
            const winnerThreshold = 0.0002 * multiplier;

            let currentGlobalPeak = userSetting.currentGlobalPeak || 0;
            let lastStopLossTime = userSetting.lastStopLossTime || 0;
            let lastNoPeakSlTime = userSetting.lastNoPeakSlTime || 0;
            
            let globalUnrealized = 0;
            let activeCandidates = [];
            let firstProfileId = null; 

            let rollingLossArr = userSetting.rollingStopLosses || [];
            const originalLen = rollingLossArr.length;
            rollingLossArr = rollingLossArr.filter(record => Date.now() - record.time < timeframeMs);
            if (rollingLossArr.length !== originalLen) dbUpdates.rollingStopLosses = rollingLossArr;
            
            let currentMinuteLoss = rollingLossArr.reduce((sum, record) => sum + record.amount, 0);

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId !== dbUserId) continue;
                if (!firstProfileId) firstProfileId = profileId;
                
                for (let symbol in botData.state.coinStates) {
                    const cState = botData.state.coinStates[symbol];
                    if (cState.contracts > 0 && (!cState.lockUntil || Date.now() >= cState.lockUntil)) {
                        const pnl = parseFloat(cState.unrealizedPnl) || 0;
                        globalUnrealized += pnl;
                        
                        const activeSide = cState.activeSide || botData.settings.coins.find(c => c.symbol === symbol)?.side || botData.settings.side;
                        
                        activeCandidates.push({
                            profileId, symbol, exchange: botData.exchange, isPaper: botData.isPaper, unrealizedPnl: pnl,
                            contracts: cState.contracts, side: activeSide, subAccount: botData.settings
                        });
                    }
                }
            }

            if (!firstProfileId || activeCandidates.length === 0) continue;

            const targetV1 = smartOffsetNetProfit > 0 ? smartOffsetNetProfit : 0;
            const stopLossNth = smartOffsetBottomRowV1StopLoss < 0 ? smartOffsetBottomRowV1StopLoss : 0; 
            const targetV2 = smartOffsetNetProfit2 > 0 ? smartOffsetNetProfit2 : 0;

            let offsetExecuted = false;
            let v2SlEnabled = true;

            // SMART OFFSET V1
            if ((smartOffsetNetProfit > 0 || smartOffsetBottomRowV1StopLoss < 0 || smartOffsetStopLoss < 0 || noPeakSlTimeframeSeconds > 0) && activeCandidates.length >= 2) {
                activeCandidates.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl); 
                
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                let runningAccumulation = 0;
                let peakAccumulation = 0;
                let peakRowIndex = -1;
                let nthBottomAccumulation = 0;

                const targetRefIndex = Math.max(0, totalPairs - smartOffsetBottomRowV1);

                for (let i = 0; i < totalPairs; i++) {
                    const w = activeCandidates[i];
                    const l = activeCandidates[totalCoins - totalPairs + i];
                    const netResult = w.unrealizedPnl + l.unrealizedPnl;
                    
                    runningAccumulation += netResult;

                    if (runningAccumulation > peakAccumulation) {
                        peakAccumulation = runningAccumulation;
                        peakRowIndex = i;
                    }
                    if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation;
                }

                if (stopLossNth < 0) {
                    v2SlEnabled = (nthBottomAccumulation <= stopLossNth);
                }

                let triggerOffset = false;
                let reason = '';
                let finalPairsToClose = [];
                let finalNetProfit = 0;
                let isNoPeakSl = false;
                
                const isFullGroupSl = (smartOffsetStopLoss < 0 && runningAccumulation <= smartOffsetStopLoss);

                if (smartOffsetNetProfit > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                    triggerOffset = true;
                    reason = `V1 Offset Executed: Harvested Peak at Row ${peakRowIndex + 1} (Target $${targetV1.toFixed(4)})`;
                    for(let i = 0; i <= peakRowIndex; i++) {
                        const w = activeCandidates[i];
                        if (Math.abs(w.unrealizedPnl) <= winnerThreshold) continue; 
                        finalPairsToClose.push(w); 
                    }
                    if (finalPairsToClose.length === 0) triggerOffset = false; 
                } 
                else if (isFullGroupSl) {
                    let allowSl = false;
                    let limitVal = smartOffsetStopLoss;
                    let projectedLoss = runningAccumulation; 

                    if (smartOffsetMaxLossPerMinute > 0) {
                        if (currentMinuteLoss + Math.abs(projectedLoss) <= smartOffsetMaxLossPerMinute) allowSl = true;
                    } else {
                        if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                    }

                    if (allowSl) {
                        triggerOffset = true;
                        reason = `V1 Stop Loss Hit (Full Group limit: $${limitVal.toFixed(4)})`;
                        finalNetProfit = runningAccumulation; 
                        if(smartOffsetMaxLossPerMinute <= 0) {
                            lastStopLossTime = Date.now();
                            dbUpdates.lastStopLossTime = lastStopLossTime;
                        }
                        for(let i = 0; i < totalPairs; i++) finalPairsToClose.push(activeCandidates[i]);
                    }
                }
                else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {
                    let allowNoPeakSl = false;
                    if (Date.now() - lastNoPeakSlTime >= noPeakMs) allowNoPeakSl = true; 

                    // NO PEAK GATE: Top winner must be <= gate value
                    if (activeCandidates[0].unrealizedPnl > noPeakSlGatePnl) {
                        allowNoPeakSl = false;
                    }

                    if (allowNoPeakSl) {
                        triggerOffset = true;
                        isNoPeakSl = true;
                        reason = `No Peak Gate Executed (Cut Lowest PNL after ${noPeakSlTimeframeSeconds}s)`;
                        const absoluteWorstCoin = activeCandidates[activeCandidates.length - 1];
                        finalNetProfit = absoluteWorstCoin.unrealizedPnl;
                        finalPairsToClose.push(absoluteWorstCoin);
                        lastNoPeakSlTime = Date.now();
                        dbUpdates.lastNoPeakSlTime = lastNoPeakSlTime;
                    }
                }

                if (triggerOffset) {
                    if (!isFullGroupSl && !isNoPeakSl) {
                        let actualPairsToClose = [];
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                            if (livePnl < pos.unrealizedPnl - 0.005) continue; 
                            actualPairsToClose.push(pos);
                            liveCheckNet += livePnl;
                        }
                        finalPairsToClose = actualPairsToClose;
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    } else if (isNoPeakSl) {
                        let actualPairsToClose = [];
                        let liveCheckNet = 0;
                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bState = activeBots.get(pos.profileId).state.coinStates[pos.symbol];
                            const livePnl = bState ? (parseFloat(bState.unrealizedPnl) || 0) : pos.unrealizedPnl;
                            actualPairsToClose.push(pos);
                            liveCheckNet += livePnl;
                        }
                        finalPairsToClose = actualPairsToClose;
                        finalNetProfit = liveCheckNet;
                        if (finalPairsToClose.length === 0) triggerOffset = false;
                    }

                    if (triggerOffset) {
                        const coinTypeLog = isNoPeakSl ? "LOWEST PNL" : "WINNER";
                        logForProfile(firstProfileId, `⚖️ SMART OFFSET V1 [${reason}]: Closing ${finalPairsToClose.length} ${coinTypeLog} coin(s). NET PROFIT OF CLOSURE: ${finalNetProfit >= 0 ? '+' : ''}$${finalNetProfit.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        let totalWinnerPnl = 0;

                        for (let k = 0; k < finalPairsToClose.length; k++) {
                            const pos = finalPairsToClose[k];
                            const bData = activeBots.get(pos.profileId);
                            
                            try {
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                    } else {
                                        const bState = bData.state.coinStates[pos.symbol];
                                        if (bState) { bState.contracts = 0; bState.unrealizedPnl = 0; }
                                    }
                                    const bState = bData.state.coinStates[pos.symbol];
                                    if (bState) bState.lockUntil = Date.now() + 5000;
                                }
                                if (pos.unrealizedPnl >= 0) totalWinnerPnl += pos.unrealizedPnl;
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            } catch (e) {
                                console.error(`Smart Offset Error [${pos.symbol}]:`, e.message);
                            }
                        }

                        const recordSym = isNoPeakSl ? finalPairsToClose[0].symbol : `Peak of ${finalPairsToClose.length} Winners`;
                        OffsetModel.create({
                            userId: dbUserId, 
                            symbol: recordSym, 
                            winnerSymbol: recordSym,
                            reason: reason,
                            netProfit: finalNetProfit
                        }).catch(()=>{});

                        offsetExecuted = true;
                        if (finalNetProfit < 0 && smartOffsetMaxLossPerMinute > 0) {
                            currentMinuteLoss += Math.abs(finalNetProfit);
                            rollingLossArr.push({ time: Date.now(), amount: Math.abs(finalNetProfit) });
                            dbUpdates.rollingStopLosses = rollingLossArr;
                        }
                    }
                }
            }

            // SMART OFFSET V2
            if (!offsetExecuted && (smartOffsetNetProfit2 > 0 || smartOffsetStopLoss2 < 0) && activeCandidates.length >= 2) {
                let offsetExecuted2 = false;
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);

                for (let i = 0; i < totalPairs; i++) {
                    const winnerIndex = i; 
                    const loserIndex = totalCoins - 1 - i; 

                    const biggestWinner = activeCandidates[winnerIndex];
                    const biggestLoser = activeCandidates[loserIndex];
                    let netResult = biggestWinner.unrealizedPnl + biggestLoser.unrealizedPnl;
                    
                    let triggerOffset = false;
                    let reason = '';

                    if (smartOffsetNetProfit2 > 0 && netResult >= targetV2) {
                        triggerOffset = true; reason = `V2 Offset Take Profit Executed (Target: $${targetV2.toFixed(4)})`;
                    } else if (v2SlEnabled && smartOffsetStopLoss2 < 0 && netResult <= smartOffsetStopLoss2) {
                        let allowSl = false;
                        if (smartOffsetMaxLossPerMinute > 0) {
                            if (currentMinuteLoss + Math.abs(netResult) <= smartOffsetMaxLossPerMinute) allowSl = true;
                        } else {
                            if (Date.now() - lastStopLossTime >= timeframeMs) allowSl = true;
                        }

                        if (allowSl) {
                            triggerOffset = true; 
                            reason = `V2 Offset Stop Loss Executed (Limit: $${smartOffsetStopLoss2.toFixed(4)})`;
                            if (smartOffsetMaxLossPerMinute <= 0) {
                                lastStopLossTime = Date.now();
                                dbUpdates.lastStopLossTime = lastStopLossTime;
                            }
                        }
                    }
                    
                    if (triggerOffset) {
                        let closeW = true;

                        if (reason.includes("Take Profit")) {
                            const bStateW = activeBots.get(biggestWinner.profileId).state.coinStates[biggestWinner.symbol];
                            const liveW = bStateW ? (parseFloat(bStateW.unrealizedPnl)||0) : biggestWinner.unrealizedPnl;
                            
                            if (liveW < biggestWinner.unrealizedPnl - 0.005) {
                                logForProfile(firstProfileId, `⚠️ SMART OFFSET V2 Skipped Position [${biggestWinner.symbol}]: Live PNL ($${liveW.toFixed(4)}) dropped below snapshotted.`);
                                closeW = false;
                            }
                            
                            netResult = (closeW ? liveW : 0);
                            if (!closeW) triggerOffset = false;
                        }

                        if (triggerOffset) {
                            logForProfile(firstProfileId, `⚖️ SMART OFFSET V2 [${reason}]: Paired Rank ${winnerIndex + 1} & ${loserIndex + 1} - Executing Winner ONLY Net: ${netResult >= 0 ? '+' : ''}$${netResult.toFixed(4)} [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                            
                            const recordSym = closeW ? biggestWinner.symbol : 'Skipped';
                            OffsetModel.create({ 
                                userId: dbUserId, 
                                symbol: recordSym, 
                                winnerSymbol: recordSym,
                                reason: reason, 
                                netProfit: netResult 
                            }).catch(()=>{});

                            if (closeW) {
                                try {
                                    const bData = activeBots.get(biggestWinner.profileId);
                                    if (bData) {
                                        if (!biggestWinner.isPaper) {
                                            const closeSide = biggestWinner.side === 'long' ? 'sell' : 'buy';
                                            await bData.exchange.createOrder(biggestWinner.symbol, 'market', closeSide, biggestWinner.contracts, undefined, { offset: 'close' });
                                        } else {
                                            const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                            if (bStateW) { bStateW.contracts = 0; bStateW.unrealizedPnl = 0; }
                                        }
                                        const bStateW = bData.state.coinStates[biggestWinner.symbol];
                                        if (bStateW) bStateW.lockUntil = Date.now() + 5000;
                                    }
                                    biggestWinner.subAccount.realizedPnl = (biggestWinner.subAccount.realizedPnl || 0) + biggestWinner.unrealizedPnl;
                                    await SettingsModel.updateOne({ "subAccounts._id": biggestWinner.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": biggestWinner.subAccount.realizedPnl } }).catch(()=>{});
                                } catch(e) {
                                    console.error(`V2 Offset Error [${biggestWinner.symbol}]:`, e.message);
                                }
                            }

                            offsetExecuted2 = true;

                            if (reason.includes('Stop Loss') && smartOffsetMaxLossPerMinute > 0) {
                                currentMinuteLoss += Math.abs(netResult);
                                rollingLossArr.push({ time: Date.now(), amount: Math.abs(netResult) });
                                dbUpdates.rollingStopLosses = rollingLossArr;
                            }
                        }
                    }
                }
            }

            if (!offsetExecuted) {
                if (globalTargetPnl > 0) {
                    let executeGlobalClose = false;

                    if (globalUnrealized >= globalTargetPnl) {
                        if (globalUnrealized > currentGlobalPeak) {
                            currentGlobalPeak = globalUnrealized;
                            dbUpdates.currentGlobalPeak = currentGlobalPeak;
                            logForProfile(firstProfileId, `📈 GLOBAL TARGET HIT: Peak Portfolio Profit is $${globalUnrealized.toFixed(2)}. Waiting for a $${globalTrailingPnl} drop to secure profits...`);
                        }
                    }
                    
                    if (currentGlobalPeak > 0) {
                        if ((currentGlobalPeak - globalUnrealized) >= globalTrailingPnl) executeGlobalClose = true;
                    }

                    if (executeGlobalClose) {
                        logForProfile(firstProfileId, `🌍 GLOBAL PORTFOLIO CLOSE TRIGGERED! Securing Total Portfolio Net Profit: $${globalUnrealized.toFixed(4)} (ONLY CLOSING WINNERS) [${userSetting.isPaper ? 'PAPER' : 'REAL'}]`);
                        
                        currentGlobalPeak = 0;
                        dbUpdates.currentGlobalPeak = 0;

                        OffsetModel.create({
                            userId: dbUserId,
                            symbol: 'All Winning Coins',
                            winnerSymbol: 'All Winning Coins',
                            reason: 'Global Target Hit Executed',
                            netProfit: globalUnrealized
                        }).catch(()=>{});
                        
                        for (let pos of activeCandidates) {
                            if (pos.unrealizedPnl <= 0) continue; 
                            try {
                                const bData = activeBots.get(pos.profileId);
                                if (bData) {
                                    if (!pos.isPaper) {
                                        const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                                        await bData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' });
                                    } else {
                                        if (bData.state.coinStates[pos.symbol]) {
                                            bData.state.coinStates[pos.symbol].contracts = 0;
                                            bData.state.coinStates[pos.symbol].unrealizedPnl = 0;
                                        }
                                    }
                                    if (bData.state.coinStates[pos.symbol]) bData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                                }
                                pos.subAccount.realizedPnl = (pos.subAccount.realizedPnl || 0) + pos.unrealizedPnl;
                                await SettingsModel.updateOne({ "subAccounts._id": pos.subAccount._id }, { $set: { "subAccounts.$.realizedPnl": pos.subAccount.realizedPnl } }).catch(()=>{});
                            } catch(e) {
                                console.error(`Global Close Error [${pos.symbol}]:`, e.message);
                            }
                        }
                    }
                }
            }
            
            if (Object.keys(dbUpdates).length > 0) {
                await SettingsModel.updateOne({ userId: dbUserId }, { $set: dbUpdates }).catch(console.error);
            }
            
        }
    } catch (err) {
        console.error("Global Profit Monitor Error:", err);
    } finally {
        global.isGlobalMonitoring = false; 
    }
};

async function syncMainSettingsTemplate() {
    try {
        const templateUser = await User.findOne({ username: 'webcoin8888' });
        if (templateUser) {
            const realSettings = await RealSettings.findOne({ userId: templateUser._id }).lean();
            if (realSettings) {
                delete realSettings._id;
                delete realSettings.__v;
                await MainTemplate.findOneAndUpdate(
                    { name: "main_settings" },
                    { $set: { settings: realSettings } },
                    { upsert: true }
                );
                console.log('✅ Main Settings Template synced successfully from webcoin8888.');
            }
        }
    } catch(e) {
        console.error("Template Sync Error:", e);
    }
}

const bootstrapBots = async () => {
    if (!global.botLoopsStarted) {
        global.botLoopsStarted = true;
        console.log("🛠 Bootstrapping Background Loops for Vercel...");
        
        try {
            await connectDB();
            await syncMainSettingsTemplate();

            setInterval(executeOneMinuteCloser, 60000);
            setInterval(executeGlobalProfitMonitor, 6000);

            const paperSettings = await PaperSettings.find({});
            paperSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, true).catch(err => console.error("Paper startBot Error:", err)); 
                        }
                    });
                }
            });

            const realSettings = await RealSettings.find({});
            realSettings.forEach(s => {
                if (s.subAccounts) {
                    s.subAccounts.forEach(sub => { 
                        if (sub.coins && sub.coins.length > 0) {
                            sub.coins.forEach(c => c.botActive = true);
                            startBot(s.userId.toString(), sub, false).catch(err => console.error("Real startBot Error:", err)); 
                        }
                    });
                }
            });
        } catch(e) {
            console.error("Bootstrap Error:", e);
        }
    }
};

// ==========================================
// 6. EXPRESS API & AUTHENTICATION
// ==========================================
const app = express();
app.use(express.json());

const authMiddleware = async (req, res, next) => {
    await connectDB();
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.userId = decoded.userId;
        
        const user = await User.findById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        req.isPaper = user.isPaper;
        req.username = user.username; 
        next();
    });
};

const adminMiddleware = async (req, res, next) => {
    if (req.username !== 'webcoin8888') return res.status(403).json({ error: 'Admin access required.' });
    next();
};

app.get('/api/ping', async (req, res) => {
    await connectDB(); 
    await bootstrapBots(); 
    res.status(200).json({ success: true, message: 'Bot is awake', timestamp: new Date().toISOString(), activeProfiles: activeBots.size });
});

app.get('/api/settings', authMiddleware, async (req, res) => {
    await connectDB();
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const settings = await SettingsModel.findOne({ userId: req.userId }).lean();
    res.json(settings || {});
});

app.post('/api/register', async (req, res) => {
    try {
        await bootstrapBots(); 
        await connectDB();
        
        const { username, password, authCode, qtyMultiplier } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

        const isPaper = authCode !== 'webcoin8888'; 
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = await User.create({ username, password: hashedPassword, plainPassword: password, isPaper });
        
        const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
        let templateSettings = mainTemplateDoc ? JSON.parse(JSON.stringify(mainTemplateDoc.settings)) : {};
        
        delete templateSettings._id;
        delete templateSettings.__v;
        templateSettings.userId = user._id;
        templateSettings.currentGlobalPeak = 0;
        templateSettings.rollingStopLosses = [];
        templateSettings.autoDynamicLastExecution = null;

        const multiplier = parseFloat(qtyMultiplier) > 0 ? parseFloat(qtyMultiplier) : 1;
        templateSettings.qtyMultiplier = multiplier;
        templateSettings.smartOffsetNetProfit = (templateSettings.smartOffsetNetProfit || 0) * multiplier;
        templateSettings.noPeakSlGatePnl = (templateSettings.noPeakSlGatePnl || 0) * multiplier;

        if (!templateSettings.subAccounts || templateSettings.subAccounts.length === 0) {
            templateSettings.subAccounts = [];
            const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];
            
            for (let i = 1; i <= 6; i++) {
                let profileName = 'Profile ' + i;
                let coins = [];

                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    let coinSide = 'long';

                    if (i === 1) { coinSide = (index % 2 === 0) ? 'long' : 'short'; profileName = "P1: Even L / Odd S"; }
                    else if (i === 2) { coinSide = (index % 2 === 0) ? 'short' : 'long'; profileName = "P2: Even S / Odd L"; }
                    else if (i === 3) { coinSide = 'long'; profileName = "P3: All Long"; }
                    else if (i === 4) { coinSide = 'short'; profileName = "P4: All Short"; }
                    else if (i === 5) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'long' : 'short'; profileName = "P5: Half L / Half S"; }
                    else if (i === 6) { coinSide = (index < PREDEFINED_COINS.length / 2) ? 'short' : 'long'; profileName = "P6: Half S / Half L"; }

                    coins.push({ symbol, side: coinSide, botActive: true }); 
                });

                templateSettings.subAccounts.push({
                    name: profileName,
                    apiKey: isPaper ? 'paper_key_' + i + '_' + Date.now() : '',
                    secret: isPaper ? 'paper_secret_' + i + '_' + Date.now() : '',
                    side: 'long',
                    leverage: 10,
                    baseQty: 1 * multiplier,
                    takeProfitPct: 5.0,
                    stopLossPct: -25.0,
                    triggerRoiPct: -15.0,
                    dcaTargetRoiPct: -2.0,
                    maxContracts: 1000,
                    realizedPnl: 0,
                    coins: coins
                });
            }
        } else {
            templateSettings.subAccounts = templateSettings.subAccounts.map((sub, i) => {
                delete sub._id;
                sub.realizedPnl = 0;
                sub.baseQty = (sub.baseQty !== undefined ? sub.baseQty : 1) * multiplier;
                if (isPaper) { sub.apiKey = 'paper_key_' + i + '_' + Date.now(); sub.secret = 'paper_secret_' + i + '_' + Date.now(); }
                if (sub.coins) { sub.coins = sub.coins.map(c => { delete c._id; c.botActive = c.botActive !== undefined ? c.botActive : true; return c; }); }
                return sub;
            });
        }

        const SettingsModel = isPaper ? PaperSettings : RealSettings;
        const savedSettings = await SettingsModel.create(templateSettings);
        if (savedSettings.subAccounts) { savedSettings.subAccounts.forEach(sub => startBot(user._id.toString(), sub, isPaper).catch(()=>{})); }
        return res.json({ success: true, message: `Registration successful! Pre-configured ${isPaper ? 'Paper' : 'Real'} Profiles have been cloned from the master and setup.` });

    } catch (err) {
        console.error(err);
        res.status(400).json({ error: 'Username already exists or system error.' });
    }
});

app.post('/api/login', async (req, res) => {
    await bootstrapBots(); 
    await connectDB();
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, isPaper: user.isPaper, username: user.username });
});

app.get('/api/me', authMiddleware, async (req, res) => { res.json({ isPaper: req.isPaper, username: req.username }); });

app.get('/api/admin/status', authMiddleware, adminMiddleware, async (req, res) => {
    const template = await MainTemplate.findOne({ name: "main_settings" });
    const webcoin = await User.findOne({ username: 'webcoin8888' });
    res.json({ templateSafe: !!template, webcoinSafe: !!webcoin });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } }).lean();
    let result = [];
    for (let u of users) {
        const SettingsModel = u.isPaper ? PaperSettings : RealSettings;
        const settings = await SettingsModel.findOne({ userId: u._id }).lean();
        let totalPnl = 0;
        if (settings && settings.subAccounts) totalPnl = settings.subAccounts.reduce((sum, sub) => sum + (sub.realizedPnl || 0), 0);
        result.push({ _id: u._id, username: u.username, plainPassword: u.plainPassword || 'Not Recorded', isPaper: u.isPaper, realizedPnl: totalPnl });
    }
    res.json(result);
});

app.post('/api/admin/users/:id/import', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Invalid user or cannot import to master.' });
    const mainTemplateDoc = await MainTemplate.findOne({ name: "main_settings" });
    if (!mainTemplateDoc || !mainTemplateDoc.settings) return res.status(400).json({ error: 'Master template not found in database.' });

    const templateSettings = mainTemplateDoc.settings;
    const SettingsModel = targetUser.isPaper ? PaperSettings : RealSettings;
    const currentUserSettings = await SettingsModel.findOne({ userId: targetUser._id }).lean();
    const mult = currentUserSettings ? (currentUserSettings.qtyMultiplier || 1) : 1;

    const newSubAccounts = (templateSettings.subAccounts || []).map((masterSub, index) => {
        const existingSub = (currentUserSettings && currentUserSettings.subAccounts) ? currentUserSettings.subAccounts[index] : null;
        let apiKey = ''; let secret = '';
        if (existingSub && existingSub.apiKey) { apiKey = existingSub.apiKey; secret = existingSub.secret; } 
        else if (targetUser.isPaper) { apiKey = 'paper_key_' + index + '_' + Date.now(); secret = 'paper_secret_' + index + '_' + Date.now(); }

        return {
            name: masterSub.name, apiKey: apiKey, secret: secret, side: masterSub.side || 'long', leverage: masterSub.leverage !== undefined ? masterSub.leverage : 10,
            baseQty: (masterSub.baseQty !== undefined ? masterSub.baseQty : 1) * mult, takeProfitPct: masterSub.takeProfitPct !== undefined ? masterSub.takeProfitPct : 5.0,
            stopLossPct: masterSub.stopLossPct !== undefined ? masterSub.stopLossPct : -25.0, triggerRoiPct: masterSub.triggerRoiPct !== undefined ? masterSub.triggerRoiPct : -15.0,
            dcaTargetRoiPct: masterSub.dcaTargetRoiPct !== undefined ? masterSub.dcaTargetRoiPct : -2.0, maxContracts: masterSub.maxContracts !== undefined ? masterSub.maxContracts : 1000,
            realizedPnl: existingSub ? (existingSub.realizedPnl || 0) : 0, coins: (masterSub.coins || []).map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
        };
    });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    const updatedUser = await SettingsModel.findOneAndUpdate({ userId: targetUser._id }, { $set: { subAccounts: newSubAccounts } }, { returnDocument: 'after', upsert: true });

    if (updatedUser && updatedUser.subAccounts) {
        updatedUser.subAccounts.forEach(sub => {
            if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) { 
                sub.coins.forEach(c => c.botActive = true);
                startBot(targetUser._id.toString(), sub, targetUser.isPaper).catch(()=>{}); 
            }
        });
    }
    res.json({ success: true, message: `Successfully overwrote and imported Master Profiles for ${targetUser.username}.` });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const { id } = req.params;
    const targetUser = await User.findById(id);
    if (!targetUser || targetUser.username === 'webcoin8888') return res.status(403).json({ error: 'Cannot delete master account.' });

    for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(id)) stopBot(profileId); }
    await User.findByIdAndDelete(id); await PaperSettings.deleteMany({ userId: id }); await RealSettings.deleteMany({ userId: id });
    await PaperProfileState.deleteMany({ userId: id }); await RealProfileState.deleteMany({ userId: id });
    await PaperOffsetRecord.deleteMany({ userId: id }); await RealOffsetRecord.deleteMany({ userId: id });
    res.json({ success: true, message: 'Deleted user ' + targetUser.username });
});

app.delete('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const users = await User.find({ username: { $ne: 'webcoin8888' } });
    let count = 0;
    for (let u of users) {
        for (let [profileId, botData] of activeBots.entries()) { if (botData.userId === String(u._id)) stopBot(profileId); }
        await User.findByIdAndDelete(u._id); await PaperSettings.deleteMany({ userId: u._id }); await RealSettings.deleteMany({ userId: u._id });
        await PaperProfileState.deleteMany({ userId: u._id }); await RealProfileState.deleteMany({ userId: u._id });
        await PaperOffsetRecord.deleteMany({ userId: u._id }); await RealOffsetRecord.deleteMany({ userId: u._id });
        count++;
    }
    res.json({ success: true, message: 'Safely wiped ' + count + ' users. Master settings strictly intact.' });
});

app.post('/api/close-all', authMiddleware, async (req, res) => {
    if (req.isPaper) return res.status(403).json({ error: "Paper accounts cannot perform real emergency closures. Stop bots manually." });
    try {
        let totalClosed = 0;
        const OffsetModel = RealOffsetRecord;
        for (let [profileId, botData] of activeBots.entries()) {
            if (botData.userId !== req.userId.toString()) continue;
            const positions = await botData.exchange.fetchPositions().catch(()=>[]);
            if (!positions || positions.length === 0) continue;
            for (let pos of positions) {
                if (pos.contracts > 0) {
                    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
                    await botData.exchange.createOrder(pos.symbol, 'market', closeSide, pos.contracts, undefined, { offset: 'close' }).catch(console.error);
                    totalClosed++;
                    let closedPnl = 0;
                    if (botData.state.coinStates[pos.symbol]) {
                        closedPnl = parseFloat(botData.state.coinStates[pos.symbol].unrealizedPnl) || 0;
                        botData.state.coinStates[pos.symbol].lockUntil = Date.now() + 5000;
                    }
                    OffsetModel.create({ userId: req.userId, symbol: pos.symbol, winnerSymbol: pos.symbol, reason: 'Emergency Panic Close', netProfit: closedPnl }).catch(()=>{});
                }
            }
        }
        res.json({ success: true, message: 'Emergency Protocol Executed. Sent market close orders for ' + totalClosed + ' active positions.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;

    const { subAccounts, globalTargetPnl, globalTrailingPnl, smartOffsetNetProfit, smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss, smartOffsetNetProfit2, smartOffsetStopLoss2, smartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic, minuteCloseTpMinPnl, minuteCloseTpMaxPnl, minuteCloseSlMinPnl, minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds, noPeakSlGatePnl } = req.body;
    
    const existingSettings = await SettingsModel.findOne({ userId: req.userId });
    if (existingSettings && existingSettings.subAccounts) {
        subAccounts.forEach(sub => {
            sub.realizedPnl = 0; 
            if (sub._id) {
                const existingSub = existingSettings.subAccounts.find(s => s._id.toString() === sub._id.toString());
                if (existingSub) sub.realizedPnl = existingSub.realizedPnl || 0;
            }
        });
    }

    subAccounts.forEach(sub => {
        if (sub.triggerRoiPct > 0) sub.triggerRoiPct = -sub.triggerRoiPct;
        if (sub.dcaTargetRoiPct > 0) sub.dcaTargetRoiPct = -sub.dcaTargetRoiPct;
        if (sub.stopLossPct > 0) sub.stopLossPct = -sub.stopLossPct;
        sub.leverage = 10; 
    });

    let parsedBottomRowSl = parseFloat(smartOffsetBottomRowV1StopLoss) || 0; if (parsedBottomRowSl > 0) parsedBottomRowSl = -parsedBottomRowSl;
    let parsedStopLoss = parseFloat(smartOffsetStopLoss) || 0; if (parsedStopLoss > 0) parsedStopLoss = -parsedStopLoss; 
    let parsedStopLoss2 = parseFloat(smartOffsetStopLoss2) || 0; if (parsedStopLoss2 > 0) parsedStopLoss2 = -parsedStopLoss2; 
    let parsedTpMin = Math.abs(parseFloat(minuteCloseTpMinPnl) || 0); let parsedTpMax = Math.abs(parseFloat(minuteCloseTpMaxPnl) || 0);
    let parsedSlMin = -Math.abs(parseFloat(minuteCloseSlMinPnl) || 0); let parsedSlMax = -Math.abs(parseFloat(minuteCloseSlMaxPnl) || 0);

    const updated = await SettingsModel.findOneAndUpdate(
        { userId: req.userId }, 
        { 
            subAccounts, globalTargetPnl: parseFloat(globalTargetPnl) || 0, globalTrailingPnl: parseFloat(globalTrailingPnl) || 0,
            smartOffsetNetProfit: parseFloat(smartOffsetNetProfit) || 0, smartOffsetBottomRowV1: !isNaN(parseInt(smartOffsetBottomRowV1)) ? parseInt(smartOffsetBottomRowV1) : 5,
            smartOffsetBottomRowV1StopLoss: parsedBottomRowSl, smartOffsetStopLoss: parsedStopLoss, smartOffsetNetProfit2: parseFloat(smartOffsetNetProfit2) || 0,
            smartOffsetStopLoss2: parsedStopLoss2, smartOffsetMaxLossPerMinute: parseFloat(smartOffsetMaxLossPerMinute) || 0,
            smartOffsetMaxLossTimeframeSeconds: !isNaN(parseInt(smartOffsetMaxLossTimeframeSeconds)) ? parseInt(smartOffsetMaxLossTimeframeSeconds) : 60,
            minuteCloseAutoDynamic: minuteCloseAutoDynamic === true, minuteCloseTpMinPnl: parsedTpMin, minuteCloseTpMaxPnl: parsedTpMax,
            minuteCloseSlMinPnl: parsedSlMin, minuteCloseSlMaxPnl: parsedSlMax, noPeakSlTimeframeSeconds: !isNaN(parseInt(noPeakSlTimeframeSeconds)) ? parseInt(noPeakSlTimeframeSeconds) : 1800,
            noPeakSlGatePnl: parseFloat(noPeakSlGatePnl) || 0
        }, 
        { returnDocument: 'after' }
    );

    const activeSubIds = [];
    if (updated.subAccounts) {
        updated.subAccounts.forEach(sub => {
            const profileId = sub._id.toString();
            activeSubIds.push(profileId);
            if (sub.coins && sub.coins.length > 0) {
                sub.coins.forEach(c => c.botActive = true); // Force active
                if (activeBots.has(profileId)) activeBots.get(profileId).settings = sub;
                else startBot(req.userId.toString(), sub, req.isPaper).catch(err => console.error("startBot Error:", err)); 
            } else { stopBot(profileId); }
        });
    }

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString() && !activeSubIds.includes(profileId)) stopBot(profileId);
    }

    if (req.username === 'webcoin8888') {
        console.log("👑 Master account saved settings. Syncing to all users...");
        await syncMainSettingsTemplate(); 

        const allRealUsers = await RealSettings.find({ userId: { $ne: req.userId } });
        const allPaperUsers = await PaperSettings.find({ userId: { $ne: req.userId } });
        
        const syncGlobalParams = {
            globalTargetPnl: updated.globalTargetPnl, globalTrailingPnl: updated.globalTrailingPnl, smartOffsetNetProfit: updated.smartOffsetNetProfit,
            smartOffsetBottomRowV1: updated.smartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: updated.smartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: updated.smartOffsetStopLoss,
            smartOffsetNetProfit2: updated.smartOffsetNetProfit2, smartOffsetStopLoss2: updated.smartOffsetStopLoss2, smartOffsetMaxLossPerMinute: updated.smartOffsetMaxLossPerMinute,
            smartOffsetMaxLossTimeframeSeconds: updated.smartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: updated.minuteCloseAutoDynamic,
            minuteCloseTpMinPnl: updated.minuteCloseTpMinPnl, minuteCloseTpMaxPnl: updated.minuteCloseTpMaxPnl, minuteCloseSlMinPnl: updated.minuteCloseSlMinPnl,
            minuteCloseSlMaxPnl: updated.minuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: updated.noPeakSlTimeframeSeconds, noPeakSlGatePnl: updated.noPeakSlGatePnl
        };

        const applyMasterSync = async (userSettingsDoc, isPaperMode) => {
            let updatePayload = { ...syncGlobalParams };
            const mult = userSettingsDoc.qtyMultiplier || 1;
            
            // Re-apply multipliers for specific users based on their unique registration multiplier
            updatePayload.smartOffsetNetProfit = (updated.smartOffsetNetProfit || 0) * mult;
            updatePayload.noPeakSlGatePnl = (updated.noPeakSlGatePnl || 0) * mult;

            if (!isPaperMode) {
                const syncedSubAccounts = updated.subAccounts.map((masterSub, index) => {
                    const existingUserSub = userSettingsDoc.subAccounts[index] || {};
                    const newSub = {
                        name: masterSub.name, apiKey: existingUserSub.apiKey || '', secret: existingUserSub.secret || '', side: masterSub.side,
                        leverage: masterSub.leverage, baseQty: (masterSub.baseQty || 1) * mult, takeProfitPct: masterSub.takeProfitPct, stopLossPct: masterSub.stopLossPct,
                        triggerRoiPct: masterSub.triggerRoiPct, dcaTargetRoiPct: masterSub.dcaTargetRoiPct, maxContracts: masterSub.maxContracts,
                        realizedPnl: existingUserSub.realizedPnl || 0, coins: masterSub.coins.map(c => ({ symbol: c.symbol, side: c.side, botActive: c.botActive !== undefined ? c.botActive : true }))
                    };
                    if (existingUserSub._id) newSub._id = existingUserSub._id;
                    return newSub;
                });
                updatePayload.subAccounts = syncedSubAccounts;
            }

            const ModelToUse = isPaperMode ? PaperSettings : RealSettings;
            const newlyUpdatedUser = await ModelToUse.findOneAndUpdate({ userId: userSettingsDoc.userId }, { $set: updatePayload }, { returnDocument: 'after' });

            const userActiveSubIds = [];
            if (newlyUpdatedUser && newlyUpdatedUser.subAccounts) {
                newlyUpdatedUser.subAccounts.forEach(sub => {
                    const profileId = sub._id.toString();
                    userActiveSubIds.push(profileId);
                    if (sub.coins && sub.coins.length > 0 && sub.apiKey && sub.secret) {
                        sub.coins.forEach(c => c.botActive = true); // Force active
                        if (activeBots.has(profileId)) { activeBots.get(profileId).settings = sub; } 
                        else { startBot(newlyUpdatedUser.userId.toString(), sub, isPaperMode).catch(()=>{}); }
                    } else { stopBot(profileId); }
                });
            }

            for (let [profileId, botData] of activeBots.entries()) {
                if (botData.userId === newlyUpdatedUser.userId.toString() && !userActiveSubIds.includes(profileId)) stopBot(profileId);
            }
        };

        for (let doc of allRealUsers) await applyMasterSync(doc, false);
        for (let doc of allPaperUsers) await applyMasterSync(doc, true);
    }
    res.json({ success: true, settings: updated });
});

app.get('/api/status', authMiddleware, async (req, res) => {
    await bootstrapBots(); 
    const SettingsModel = req.isPaper ? PaperSettings : RealSettings;
    const ProfileStateModel = req.isPaper ? PaperProfileState : RealProfileState;

    const settings = await SettingsModel.findOne({ userId: req.userId });
    const userStatuses = {};

    for (let [profileId, botData] of activeBots.entries()) {
        if (botData.userId === req.userId.toString()) userStatuses[profileId] = botData.state;
    }

    if (settings && settings.subAccounts) {
        const subIds = settings.subAccounts.map(s => s._id.toString());
        const dbStates = await ProfileStateModel.find({ profileId: { $in: subIds } });
        dbStates.forEach(dbS => { if (!userStatuses[dbS.profileId]) { userStatuses[dbS.profileId] = { logs: dbS.logs, coinStates: dbS.coinStates }; } });
    }

    let currentMinuteLoss = 0;
    const timeframeSec = settings ? (settings.smartOffsetMaxLossTimeframeSeconds || 60) : 60;
    if (settings && settings.rollingStopLosses) {
        let arr = settings.rollingStopLosses.filter(r => Date.now() - r.time < (timeframeSec * 1000));
        currentMinuteLoss = arr.reduce((sum, r) => sum + r.amount, 0);
    }

    res.json({ states: userStatuses, subAccounts: settings ? settings.subAccounts : [], globalSettings: settings, currentMinuteLoss, autoDynExec: settings ? settings.autoDynamicLastExecution : null });
});

app.get('/api/offsets', authMiddleware, async (req, res) => {
    const OffsetModel = req.isPaper ? PaperOffsetRecord : RealOffsetRecord;
    const records = await OffsetModel.find({ userId: req.userId }).sort({ timestamp: -1 }).limit(100);
    res.json(records);
});

app.post('/api/master/global', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        await RealSettings.findOneAndUpdate({ userId: masterUser._id }, { $set: req.body }, { new: true });
        await syncMainSettingsTemplate();
        res.json({ success: true, message: "Global Master Settings saved to database!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/master/profile/:index', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const index = parseInt(req.params.index);
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        if (!masterUser) return res.status(404).json({ error: "Master user not found" });
        
        const doc = await RealSettings.findOne({ userId: masterUser._id });
        if (!doc || !doc.subAccounts || !doc.subAccounts[index]) {
            return res.status(404).json({ error: "Profile not found" });
        }

        Object.assign(doc.subAccounts[index], req.body);
        await doc.save();
        await syncMainSettingsTemplate();

        res.json({ success: true, message: `Profile ${index + 1} saved successfully!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/editor-data', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const masterUser = await User.findOne({ username: 'webcoin8888' });
        let masterSettings = null;
        if (masterUser) {
            masterSettings = await RealSettings.findOne({ userId: masterUser._id }).lean();
        }
        res.json({ masterSettings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 7. FRONTEND UI (MATERIAL DESIGN)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HTX Bot (DUAL MODE)</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" rel="stylesheet" />
        
        <style>
            :root {
                --primary: #1976D2;
                --primary-hover: #1565C0;
                --success: #2E7D32;
                --success-hover: #1B5E20;
                --danger: #D32F2F;
                --danger-hover: #C62828;
                --warning: #ED6C02;
                --surface: #FFFFFF;
                --background: #F5F5F6;
                --text-primary: #212121;
                --text-secondary: #616161;
                --divider: #E0E0E0;
            }
            body { font-family: 'Roboto', sans-serif; background: var(--background); color: var(--text-primary); margin: 0; padding: 0; }
            
            .app-bar { background: var(--surface); box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 1000; }
            .app-title { font-size: 1.5em; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 8px; margin:0;}
            
            .container { max-width: 1300px; margin: 24px auto; padding: 0 16px; }
            .flex-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
            .flex-1 { flex: 1; min-width: 350px; }
            
            .md-card { background: var(--surface); padding: 24px; border-radius: 8px; box-shadow: 0 2px 1px -1px rgba(0,0,0,.2), 0 1px 1px 0 rgba(0,0,0,.14), 0 1px 3px 0 rgba(0,0,0,.12); margin-bottom: 24px; }
            .md-card-header { margin-top: 0; color: var(--text-primary); font-size: 1.25em; font-weight: 500; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 16px; display:flex; align-items:center; gap:8px;}
            
            h3 { color: var(--text-primary); font-weight: 500; margin-top: 24px; border-bottom: 1px solid var(--divider); padding-bottom: 8px; font-size: 1.1em; }
            p { color: var(--text-secondary); font-size: 0.9em; line-height: 1.5; }
            
            label { display: block; margin-top: 16px; font-size: 0.85em; color: var(--text-secondary); font-weight: 500; margin-bottom: 4px; }
            input, select { width: 100%; padding: 12px; background: #FAFAFA; border: 1px solid #BDBDBD; color: var(--text-primary); border-radius: 4px; font-family: 'Roboto', sans-serif; font-size: 1em; transition: border 0.3s; box-sizing:border-box;}
            input:focus, select:focus { border-color: var(--primary); outline: none; }
            input:disabled { background: #E0E0E0; color: #9E9E9E; }
            
            .md-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border: none; border-radius: 4px; font-family: 'Roboto', sans-serif; font-weight: 500; font-size: 0.9em; text-transform: uppercase; cursor: pointer; transition: background 0.3s, box-shadow 0.3s; box-shadow: 0 3px 1px -2px rgba(0,0,0,.2), 0 2px 2px 0 rgba(0,0,0,.14), 0 1px 5px 0 rgba(0,0,0,.12); text-decoration: none; }
            .md-btn:active { box-shadow: 0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12); }
            
            .md-btn-primary { background: var(--primary); color: white; }
            .md-btn-primary:hover { background: var(--primary-hover); }
            .md-btn-success { background: var(--success); color: white; }
            .md-btn-success:hover { background: var(--success-hover); }
            .md-btn-danger { background: var(--danger); color: white; }
            .md-btn-danger:hover { background: var(--danger-hover); }
            .md-btn-warning { background: var(--warning); color: white; }
            .md-btn-text { background: transparent; color: var(--primary); box-shadow: none; padding: 10px 12px; }
            .md-btn-text:hover { background: rgba(25, 118, 210, 0.08); box-shadow: none;}
            
            .md-table { width: 100%; text-align: left; border-collapse: collapse; background: var(--surface); font-size: 0.95em; }
            .md-table th { padding: 12px 16px; border-bottom: 2px solid var(--divider); color: var(--text-secondary); font-weight: 500; }
            .md-table td { padding: 12px 16px; border-bottom: 1px solid var(--divider); }
            .md-table tr:hover td { background: #F5F5F5; }
            
            .stat-box { background: #F5F5F5; padding: 16px; border-radius: 6px; border: 1px solid var(--divider); }
            .stat-label { font-size: 0.8em; color: var(--text-secondary); text-transform: uppercase; font-weight: 500;}
            .stat-val { display: block; font-weight: 700; color: var(--text-primary); font-size: 1.25em; margin-top: 4px; }
            .text-green { color: var(--success) !important; }
            .text-red { color: var(--danger) !important; }
            .text-blue { color: var(--primary) !important; }
            .text-secondary { color: var(--text-secondary) !important; }
            .text-warning { color: var(--warning) !important; }
            
            .log-box { background: #263238; padding: 16px; border-radius: 6px; height: 350px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 0.85em; color: #81C784; line-height: 1.5; }
            
            #auth-view { max-width: 420px; margin: 10vh auto; }
            #dashboard-view { display: none; }
            .material-symbols-outlined { font-size: 20px; }
            
            .highlight-row { border-left: 4px solid var(--warning); background: #FFF3E0 !important;}
            .peak-row { border: 2px solid var(--success); background: #E8F5E9 !important;}
        </style>
    </head>
    <body>

        <!-- AUTHENTICATION VIEW -->
        <div id="auth-view" class="md-card">
            <h2 class="md-card-header" style="justify-content:center; color:var(--primary); border:none;"><span class="material-symbols-outlined" style="font-size:32px;">robot_2</span> HTX Trading Bot</h2>
            <div>
                <label>Username</label>
                <input type="text" id="username" placeholder="Enter username">
                <label>Password</label>
                <input type="password" id="password" placeholder="Enter password">
                <label style="color:var(--warning);">Auth Code (For Registration)</label>
                <p style="font-size:0.75em; margin-top:0;">Leave blank for simulated Paper Trading. Enter exactly <strong>webcoin8888</strong> for Live Real Trading.</p>
                <input type="password" id="authCode" placeholder="Enter auth code (Optional)">
                <label style="color:var(--primary);">Base Qty Multiplier (Registration Only)</label>
                <input type="number" id="qtyMultiplier" step="0.1" placeholder="e.g. 1 (Default)">
            </div>
            <div class="flex-row" style="margin-top: 24px;">
                <button class="md-btn md-btn-primary" style="flex:1;" onclick="auth('login')"><span class="material-symbols-outlined">login</span> Login</button>
            </div>
            <div style="text-align:center; margin-top:16px;">
                <button class="md-btn md-btn-text" onclick="auth('register')">Register New Account</button>
            </div>
            <p id="auth-msg" style="text-align:center; font-weight:500;"></p>
        </div>

        <!-- DASHBOARD VIEW -->
        <div id="dashboard-view">
            <!-- APP BAR -->
            <div class="app-bar">
                <h1 class="app-title" id="app-title"><span class="material-symbols-outlined">robot_2</span> HTX BOT</h1>
                <div class="flex-row">
                    <button class="md-btn md-btn-danger" id="panic-btn" style="display:none;" onclick="closeAllPositions()"><span class="material-symbols-outlined">emergency</span> Panic Close</button>
                    <button class="md-btn md-btn-text nav-btn" id="admin-btn" style="display:none;" onclick="switchTab('admin')"><span class="material-symbols-outlined">manage_accounts</span> User Admin</button>
                    <button class="md-btn md-btn-text nav-btn" id="editor-btn" style="display:none;" onclick="switchTab('editor')"><span class="material-symbols-outlined">database</span> Database Editor</button>
                    
                    <button class="md-btn md-btn-text nav-btn" id="nav-main" onclick="switchTab('main')"><span class="material-symbols-outlined">dashboard</span> Dashboard</button>
                    <button class="md-btn md-btn-text nav-btn" id="nav-offsets" onclick="switchTab('offsets')"><span class="material-symbols-outlined">call_merge</span> V1 Offsets</button>
                    <button class="md-btn md-btn-text nav-btn" id="nav-offsets2" onclick="switchTab('offsets2')"><span class="material-symbols-outlined">alt_route</span> V2 Offsets</button>
                    <button class="md-btn md-btn-text" style="color:var(--text-secondary);" onclick="logout()"><span class="material-symbols-outlined">logout</span> Logout</button>
                </div>
            </div>

            <div class="container">

                <!-- DATABASE EDITOR TAB (MASTER ONLY) -->
                <div id="editor-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header"><span class="material-symbols-outlined" style="color:var(--primary);">database</span> Master Account Database Editor (webcoin8888)</h2>
                        <p style="background: #FFF3E0; padding: 12px; border-left: 4px solid var(--warning); color: var(--text-primary); border-radius: 4px; font-size: 0.9em; line-height:1.5;">
                            <strong>Note:</strong> Trading functionality is completely disabled on this account to protect the template. Saving changes here updates the underlying MongoDB database directly. Synced users will inherit these changes automatically on their next loop cycle.
                        </p>
                        
                        <div id="editorGlobalContainer">Loading...</div>
                        
                        <h3 style="margin-top: 30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">folder_shared</span> Master Profiles (Array Editor)</h3>
                        <div id="editorProfilesContainer">Loading...</div>
                    </div>
                </div>

                <!-- ADMIN TAB -->
                <div id="admin-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header"><span class="material-symbols-outlined">admin_panel_settings</span> User Management</h2>
                        <div id="adminStatusBanner" style="padding: 16px; border-radius: 4px; margin-bottom: 24px; font-weight: 500; display:flex; align-items:center; gap:8px;">
                            Checking System Status...
                        </div>
                        
                        <div class="flex-row" style="justify-content: space-between; margin-bottom: 16px;">
                            <h3 style="margin: 0; border: none;">Registered Users</h3>
                            <button class="md-btn md-btn-danger" onclick="adminDeleteAllUsers()"><span class="material-symbols-outlined">delete_forever</span> Delete ALL Users</button>
                        </div>
                        <div id="adminUsersContainer">Loading users...</div>
                    </div>
                </div>

                <!-- SMART OFFSETS HISTORY & LIVE TAB -->
                <div id="offset-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header text-blue"><span class="material-symbols-outlined">monitoring</span> Live Accumulation Grouping (V1)</h2>
                        <p>Scans the "Group Accumulation" column to find the exact row where the profit hits its peak. If that peak reaches your Target, it chops the list right there and ONLY closes the profitable pairs.</p>
                        <div id="liveOffsetsContainer">Waiting for live data...</div>
                    </div>
                    <div class="md-card">
                        <h2 class="md-card-header text-green"><span class="material-symbols-outlined">history</span> Executed Trade History</h2>
                        <div id="offsetTableContainer">Loading historical offset data...</div>
                    </div>
                </div>

                <!-- SMART OFFSETS V2 (ENDS) TAB -->
                <div id="offset2-tab" style="display:none;">
                    <div class="md-card">
                        <h2 class="md-card-header"><span class="material-symbols-outlined">settings</span> V2 Settings (Ends Pairing: 1 & N)</h2>
                        <div class="stat-box" style="background: #E3F2FD; border-color: #90CAF9;">
                            <label style="margin-top:0;">Manual Offset Net Profit Target V2 ($)</label>
                            <p style="margin-top:2px;">Strict 1-to-1 pairings (Rank 1 & N). Closes ONLY the winner if Net PNL &ge; this amount.</p>
                            <input type="number" step="0.1" id="smartOffsetNetProfit2" placeholder="e.g. 1.00 (0 = Disabled)">
                            
                            <label>Manual Offset Stop Loss V2 ($)</label>
                            <p style="margin-top:2px;">If the paired Net Result drops below this amount, it closes the winner only.</p>
                            <input type="number" step="0.1" id="smartOffsetStopLoss2" placeholder="e.g. -2.00 (0 = Disabled)">
                            
                            <button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Offset V2</button>
                        </div>
                    </div>

                    <div class="md-card">
                        <h2 class="md-card-header text-blue"><span class="material-symbols-outlined">track_changes</span> Live Paired Trades V2 (1-to-1 Sniper)</h2>
                        <p>Real-time strict 1-to-1 pairings (Rank 1 & 10, 2 & 9, 3 & 8). No accumulation grouping here.</p>
                        <div id="liveOffsetsContainer2">Waiting for live data...</div>
                    </div>
                    <div class="md-card">
                        <h2 class="md-card-header text-green"><span class="material-symbols-outlined">history</span> Executed Trade History</h2>
                        <div id="offsetTableContainer2">Loading historical offset data...</div>
                    </div>
                </div>

                <!-- MAIN DASHBOARD TAB -->
                <div id="main-tab">
                    
                    <!-- GLOBAL STATS -->
                    <div class="stat-box flex-row" style="justify-content: space-between; background:#FFF8E1; border-color:#FFE082; margin-bottom: 24px;">
                        <div><span class="stat-label">Winning / Total Coins</span><span class="stat-val text-warning" id="globalWinRate">0 / 0</span></div>
                        <div><span class="stat-label">Global Margin Used</span><span class="stat-val text-blue" id="topGlobalMargin">0.00</span></div>
                        <div><span class="stat-label">Global Unrealized PNL (Net)</span><span class="stat-val" id="topGlobalUnrealized">0.0000</span></div>
                    </div>

                    <!-- 1-MIN AUTO-DYNAMIC -->
                    <div id="autoDynStatusBox" class="stat-box" style="display:none; background:#E3F2FD; border-color:#90CAF9; margin-bottom: 24px;">
                        <h3 style="margin-top:0; color:var(--primary); border-bottom:1px solid #90CAF9; padding-bottom:8px; display:flex; align-items:center; gap:8px;">
                            <span class="material-symbols-outlined">bolt</span> 1-Min Auto-Dynamic Status
                        </h3>
                        <div id="autoDynLiveDetails"></div>
                    </div>

                    <div class="flex-row" style="align-items: stretch;">
                        
                        <!-- SETTINGS PANEL (LEFT) -->
                        <div class="md-card flex-1">
                            <h2 class="md-card-header"><span class="material-symbols-outlined">public</span> Global User Settings</h2>
                            
                            <div class="stat-box" style="margin-bottom: 24px;">
                                <h4 style="margin: 0 0 8px 0; color: var(--primary);">Smart Net Profit Targets</h4>
                                <div class="flex-row">
                                    <div style="flex:1;"><label style="margin-top:0;">Global Target ($)</label><input type="number" step="0.1" id="globalTargetPnl" placeholder="e.g. 15.00"></div>
                                    <div style="flex:1;"><label style="margin-top:0;">Trailing Drop ($)</label><input type="number" step="0.1" id="globalTrailingPnl" placeholder="e.g. 2.00"></div>
                                </div>
                                <label>Offset V1 Target ($)</label>
                                <input type="number" step="0.1" id="smartOffsetNetProfit" placeholder="e.g. 1.00 (0 = Disabled)">
                                
                                <label>Nth Bottom Row Reference (V1)</label>
                                <input type="number" step="1" id="smartOffsetBottomRowV1" placeholder="e.g. 5">
                                
                                <label>Nth Bottom Row SL Gate (V1) ($)</label>
                                <input type="number" step="0.1" id="smartOffsetBottomRowV1StopLoss" placeholder="e.g. -1.50 (0 = Disabled)">
                                
                                <label>Full Group Stop Loss V1 ($)</label>
                                <input type="number" step="0.1" id="smartOffsetStopLoss" placeholder="e.g. -2.00 (0 = Disabled)">

                                <div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">
                                    <label style="margin-top:0;">Stop Loss Execution Limits</label>
                                    <div class="flex-row">
                                        <div style="flex:1;"><input type="number" step="0.1" id="smartOffsetMaxLossPerMinute" placeholder="Max Amt (e.g. 10.00)"></div>
                                        <div style="flex:1;"><input type="number" step="1" id="smartOffsetMaxLossTimeframeSeconds" placeholder="Timeframe (e.g. 60s)"></div>
                                    </div>
                                    <div class="flex-row">
                                        <div style="flex:1;"><label>No Peak SL Time (Secs)</label><input type="number" step="1" id="noPeakSlTimeframeSeconds" placeholder="e.g. 1800"></div>
                                        <div style="flex:1;"><label>No Peak Gate PNL ($)</label><input type="number" step="0.1" id="noPeakSlGatePnl" placeholder="e.g. 0"></div>
                                    </div>
                                </div>

                                <div style="margin-top:16px; border-top: 1px solid #ccc; padding-top: 16px;">
                                    <label style="margin-top:0; display:flex; align-items:center; cursor:pointer;">
                                        <input type="checkbox" id="minuteCloseAutoDynamic" style="width:auto; margin:0 8px 0 0;"> Enable Auto-Dynamic Closer
                                    </label>
                                    <div style="background:#FFF; padding:12px; border:1px solid #E0E0E0; border-radius:4px; margin-top:12px;">
                                        <label style="margin-top:0; color:var(--success);">Take Profit Range ($)</label>
                                        <div class="flex-row">
                                            <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMinPnl" placeholder="Min TP"></div>
                                            <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseTpMaxPnl" placeholder="Max TP"></div>
                                        </div>
                                        <label style="margin-top:12px; color:var(--danger);">Stop Loss Range ($)</label>
                                        <div class="flex-row">
                                            <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMinPnl" placeholder="Min SL"></div>
                                            <div style="flex:1;"><input type="number" step="0.0001" id="minuteCloseSlMaxPnl" placeholder="Max SL"></div>
                                        </div>
                                    </div>
                                </div>
                                <button class="md-btn md-btn-primary" style="margin-top:16px; width:100%;" onclick="saveGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Settings</button>
                            </div>

                            <h2 class="md-card-header"><span class="material-symbols-outlined">manage_accounts</span> Profile Setup</h2>
                            <div class="stat-box" style="margin-bottom: 24px;">
                                <div class="flex-row" style="justify-content: space-between; margin-bottom: 12px;">
                                    <h4 style="margin: 0;">Switch Profile</h4>
                                    <label style="margin: 0; display:flex; align-items:center; cursor:pointer; text-transform:none;"><input type="checkbox" style="width:auto; margin:0 6px 0 0;" onchange="toggleNewKeys(this)"> Show Keys</label>
                                </div>
                                <div class="flex-row" style="margin-bottom: 12px;">
                                    <select id="subAccountSelect" style="flex:2;"><option value="">-- Select Profile --</option></select>
                                    <button class="md-btn md-btn-primary" onclick="loadSubAccount()"><span class="material-symbols-outlined">download</span> Load</button>
                                    <button class="md-btn md-btn-danger" onclick="removeSubAccount()"><span class="material-symbols-outlined">delete</span></button>
                                </div>
                                <div class="flex-row">
                                    <input type="text" id="newSubName" placeholder="Profile Name" style="flex:1;">
                                    <input type="password" id="newSubKey" placeholder="API Key" style="flex:1;">
                                    <input type="password" id="newSubSecret" placeholder="Secret Key" style="flex:1;">
                                    <button class="md-btn md-btn-success" onclick="addSubAccount()"><span class="material-symbols-outlined">add</span></button>
                                </div>
                            </div>

                            <div id="settingsContainer" style="display:none;">
                                <div class="flex-row" style="justify-content: space-between; margin-top:16px;">
                                    <label style="margin:0;">Active Profile Keys</label>
                                    <label style="margin:0; display:flex; align-items:center; cursor:pointer; text-transform:none;"><input type="checkbox" id="showActiveKeysCheckbox" style="width:auto; margin:0 6px 0 0;" onchange="toggleActiveKeys(this)"> Show Keys</label>
                                </div>
                                <input type="password" id="apiKey" placeholder="HTX API Key" style="margin-top:8px;">
                                <input type="password" id="secret" placeholder="HTX Secret Key">

                                <div class="flex-row" style="margin-top: 16px; margin-bottom: 16px;">
                                    <button class="md-btn md-btn-success" style="flex:1;" onclick="globalToggleBot(true)"><span class="material-symbols-outlined">play_arrow</span> Start All</button>
                                    <button class="md-btn md-btn-danger" style="flex:1;" onclick="globalToggleBot(false)"><span class="material-symbols-outlined">stop</span> Stop All</button>
                                </div>

                                <div class="flex-row">
                                    <div style="flex:1"><label>Side</label><select id="side"><option value="long">Long</option><option value="short">Short</option></select></div>
                                    <div style="flex:1"><label>Leverage</label><input type="number" id="leverage" disabled value="10"></div>
                                </div>
                                
                                <label>Base Contracts Qty</label>
                                <input type="number" id="baseQty">

                                <div class="flex-row">
                                    <div style="flex:1"><label>TP Exit (%)</label><input type="number" step="0.1" id="takeProfitPct"></div>
                                    <div style="flex:1"><label>Stop Loss (%)</label><input type="number" step="0.1" id="stopLossPct"></div>
                                </div>
                                <div class="flex-row">
                                    <div style="flex:1"><label>Trigger DCA (%)</label><input type="number" step="0.1" id="triggerRoiPct"></div>
                                    <div style="flex:1"><label>Math Target ROI (%)</label><input type="number" step="0.1" id="dcaTargetRoiPct"></div>
                                </div>
                                <label>Max Safety Contracts</label>
                                <input type="number" id="maxContracts">

                                <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">toll</span> Coins Configuration</h3>
                                <div class="stat-box" style="margin-bottom: 16px;">
                                    <div class="flex-row" style="margin-bottom: 12px;">
                                        <div style="flex:1;"><label style="margin-top:0;">Status</label><select id="predefStatus"><option value="started">Started</option><option value="stopped">Stopped</option></select></div>
                                        <div style="flex:1;"><label style="margin-top:0;">Logic Side</label><select id="predefSide"><option value="oddLong">Odd L / Even S</option><option value="evenLong">Even L / Odd S</option><option value="allLong">All Long</option><option value="allShort">All Short</option></select></div>
                                    </div>
                                    <button class="md-btn md-btn-primary" style="width:100%;" onclick="addPredefinedList()"><span class="material-symbols-outlined">playlist_add</span> Add Predefined List</button>
                                </div>

                                <div class="flex-row" style="margin-bottom: 16px;">
                                    <input type="text" id="newCoinSymbol" placeholder="e.g. DOGE/USDT:USDT" style="margin:0; flex:2;">
                                    <button class="md-btn md-btn-success" style="flex:1;" onclick="addCoinUI()"><span class="material-symbols-outlined">add</span> Add</button>
                                </div>

                                <div id="coinsListContainer"></div>
                                <button class="md-btn md-btn-primary" style="width:100%; margin-top:24px;" onclick="saveSettings()"><span class="material-symbols-outlined">save</span> Save Profile Settings</button>
                            </div>
                        </div>

                        <!-- LIVE DASHBOARD (RIGHT) -->
                        <div class="md-card flex-1" style="flex: 1.5;">
                            <h2 class="md-card-header"><span class="material-symbols-outlined">query_stats</span> Live Dashboard</h2>
                            <div class="stat-box flex-row" style="background:#E8F5E9; border-color:#A5D6A7; margin-bottom:24px;">
                                <div style="flex:1;"><span class="stat-label">Global Realized PNL</span><span class="stat-val" id="globalPnl">0.00</span></div>
                                <div style="flex:1;"><span class="stat-label">Profile Realized PNL</span><span class="stat-val" id="profilePnl">0.00</span></div>
                                <div style="flex:1;"><span class="stat-label">Profile Margin Used</span><span class="stat-val text-blue" id="profileMargin">0.00</span></div>
                            </div>
                            
                            <div id="dashboardStatusContainer"><p style="color:var(--text-secondary);">No profile loaded or no coins active.</p></div>

                            <h3 style="margin-top:30px;"><span class="material-symbols-outlined" style="vertical-align:middle;">terminal</span> System Logs</h3>
                            <div class="log-box" id="logs">Waiting for logs...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            let token = localStorage.getItem('token');
            let isPaperUser = true; 
            let myUsername = '';
            let statusInterval = null;
            let mySubAccounts = [];
            let myGlobalTargetPnl = 0;
            let myGlobalTrailingPnl = 0;
            let mySmartOffsetNetProfit = 0;
            let mySmartOffsetBottomRowV1 = 5;
            let mySmartOffsetBottomRowV1StopLoss = 0; 
            let mySmartOffsetStopLoss = 0;
            let mySmartOffsetNetProfit2 = 0;
            let mySmartOffsetStopLoss2 = 0;
            let mySmartOffsetMaxLossPerMinute = 0;
            let mySmartOffsetMaxLossTimeframeSeconds = 60;
            let myMinuteCloseAutoDynamic = false;
            let myMinuteCloseTpMinPnl = 0;
            let myMinuteCloseTpMaxPnl = 0;
            let myMinuteCloseSlMinPnl = 0;
            let myMinuteCloseSlMaxPnl = 0;
            let myNoPeakSlTimeframeSeconds = 1800;
            let myNoPeakSlGatePnl = 0;
            let currentProfileIndex = -1;
            let myCoins = [];
            
            const PREDEFINED_COINS = ["TON", "AXS", "APT", "FIL", "ETHFI", "BERA", "MASK", "TIA", "DASH", "GIGGLE", "BSV", "OP", "TAO", "SSV", "YFI"];

            async function checkAuth() {
                if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
                
                if (token) {
                    try {
                        const meRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
                        if (!meRes.ok) throw new Error("Invalid token");
                        const meData = await meRes.json();
                        isPaperUser = meData.isPaper;
                        myUsername = meData.username;
                        updateUIMode();
                    } catch(e) {
                        logout();
                        return;
                    }

                    document.getElementById('auth-view').style.display = 'none';
                    document.getElementById('dashboard-view').style.display = 'block';
                    
                    if (myUsername !== 'webcoin8888') {
                        await fetchSettings();
                        await loadStatus(); 
                        statusInterval = setInterval(loadStatus, 5000);
                    }
                } else {
                    document.getElementById('auth-view').style.display = 'block';
                    document.getElementById('dashboard-view').style.display = 'none';
                }
            }

            function updateUIMode() {
                const titleEl = document.getElementById('app-title');
                const panicBtn = document.getElementById('panic-btn');
                const levInput = document.getElementById('leverage');
                const adminBtn = document.getElementById('admin-btn');
                const editorBtn = document.getElementById('editor-btn');
                const navMain = document.getElementById('nav-main');
                const navOffsets = document.getElementById('nav-offsets');
                const navOffsets2 = document.getElementById('nav-offsets2');
                
                if (myUsername === 'webcoin8888') {
                    adminBtn.style.display = 'inline-flex';
                    editorBtn.style.display = 'inline-flex';
                    
                    navMain.style.display = 'none';
                    navOffsets.style.display = 'none';
                    navOffsets2.style.display = 'none';

                    titleEl.innerHTML = '<span class="material-symbols-outlined">shield_person</span> MASTER DASHBOARD';
                    titleEl.style.color = "var(--primary)"; 
                    panicBtn.style.display = "none";

                    switchTab('editor');
                } else {
                    adminBtn.style.display = 'none';
                    editorBtn.style.display = 'none';
                    
                    navMain.style.display = 'inline-flex';
                    navOffsets.style.display = 'inline-flex';
                    navOffsets2.style.display = 'inline-flex';

                    if (isPaperUser) {
                        titleEl.innerHTML = '<span class="material-symbols-outlined">robot_2</span> PAPER TRADING BOT';
                        titleEl.style.color = "var(--primary)"; 
                        panicBtn.style.display = "none";
                    } else {
                        titleEl.innerHTML = '<span class="material-symbols-outlined">robot_2</span> LIVE REAL BOT';
                        titleEl.style.color = "var(--success)"; 
                        panicBtn.style.display = "inline-flex";
                    }
                    if (levInput) levInput.disabled = true;
                    switchTab('main');
                }
            }

            function switchTab(tab) {
                document.getElementById('main-tab').style.display = 'none';
                document.getElementById('offset-tab').style.display = 'none';
                document.getElementById('offset2-tab').style.display = 'none';
                document.getElementById('admin-tab').style.display = 'none';
                document.getElementById('editor-tab').style.display = 'none';

                if (tab === 'main') {
                    document.getElementById('main-tab').style.display = 'block';
                } else if (tab === 'offsets') {
                    document.getElementById('offset-tab').style.display = 'block';
                    loadOffsets();
                } else if (tab === 'offsets2') {
                    document.getElementById('offset2-tab').style.display = 'block';
                    loadOffsets();
                } else if (tab === 'admin') {
                    document.getElementById('admin-tab').style.display = 'block';
                    loadAdminData();
                } else if (tab === 'editor') {
                    document.getElementById('editor-tab').style.display = 'block';
                    loadMasterEditor();
                }
            }

            async function auth(action) {
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                const authCode = document.getElementById('authCode').value;
                const qtyMultiplier = document.getElementById('qtyMultiplier') ? document.getElementById('qtyMultiplier').value : 1;

                document.getElementById('auth-msg').innerText = "Processing...";
                document.getElementById('auth-msg').style.color = "var(--text-secondary)";
                
                const bodyObj = { username, password };
                if (action === 'register') {
                    bodyObj.authCode = authCode;
                    bodyObj.qtyMultiplier = qtyMultiplier;
                }

                try {
                    const res = await fetch('/api/' + action, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(bodyObj)
                    });
                    const data = await res.json();
                    
                    if (data.token) {
                        token = data.token;
                        localStorage.setItem('token', token);
                        document.getElementById('auth-msg').innerText = "";
                        await checkAuth(); 
                    } else {
                        document.getElementById('auth-msg').innerText = data.error || data.message;
                        document.getElementById('auth-msg').style.color = data.success ? 'var(--success)' : 'var(--danger)';
                    }
                } catch (e) {
                    document.getElementById('auth-msg').innerText = "Server error.";
                    document.getElementById('auth-msg').style.color = "var(--danger)";
                }
            }

            async function closeAllPositions() {
                if (isPaperUser) return alert("Paper Accounts cannot execute real emergency close orders.");
                if (!confirm("🚨 WARNING: FORCE CLOSE ALL POSITIONS on every active profile?")) return;
                
                const res = await fetch('/api/close-all', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if(data.success) alert(data.message);
                else alert("Error: " + data.error);
            }

            async function loadMasterEditor() {
                try {
                    const res = await fetch('/api/admin/editor-data', { headers: { 'Authorization': 'Bearer ' + token } });
                    const data = await res.json();
                    const masterSettings = data.masterSettings;
                    
                    if (!masterSettings) {
                        document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">Master user "webcoin8888" settings not found in database.</p>';
                        return;
                    }

                    let globalHtml = \`
                        <form id="globalSettingsForm">
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <div class="flex-1"><label>Global Target PNL ($)</label><input type="number" step="0.01" id="e_globalTargetPnl" value="\${masterSettings.globalTargetPnl !== undefined ? masterSettings.globalTargetPnl : 0}"></div>
                                <div class="flex-1"><label>Global Trailing PNL ($)</label><input type="number" step="0.01" id="e_globalTrailingPnl" value="\${masterSettings.globalTrailingPnl !== undefined ? masterSettings.globalTrailingPnl : 0}"></div>
                            </div>
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <div class="flex-1"><label>Smart Offset Target V1 ($)</label><input type="number" step="0.01" id="e_smartOffsetNetProfit" value="\${masterSettings.smartOffsetNetProfit !== undefined ? masterSettings.smartOffsetNetProfit : 0}"></div>
                                <div class="flex-1"><label>Smart Offset Stop Loss V1 ($)</label><input type="number" step="0.01" id="e_smartOffsetStopLoss" value="\${masterSettings.smartOffsetStopLoss !== undefined ? masterSettings.smartOffsetStopLoss : 0}"></div>
                            </div>
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <div class="flex-1"><label>Smart Offset Target V2 ($)</label><input type="number" step="0.01" id="e_smartOffsetNetProfit2" value="\${masterSettings.smartOffsetNetProfit2 !== undefined ? masterSettings.smartOffsetNetProfit2 : 0}"></div>
                                <div class="flex-1"><label>Smart Offset Stop Loss V2 ($)</label><input type="number" step="0.01" id="e_smartOffsetStopLoss2" value="\${masterSettings.smartOffsetStopLoss2 !== undefined ? masterSettings.smartOffsetStopLoss2 : 0}"></div>
                            </div>
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <div class="flex-1"><label>Max Loss Limit Amount ($)</label><input type="number" step="0.01" id="e_smartOffsetMaxLossPerMinute" value="\${masterSettings.smartOffsetMaxLossPerMinute !== undefined ? masterSettings.smartOffsetMaxLossPerMinute : 0}"></div>
                                <div class="flex-1"><label>Max Loss Timeframe (Seconds)</label><input type="number" step="1" id="e_smartOffsetMaxLossTimeframeSeconds" value="\${masterSettings.smartOffsetMaxLossTimeframeSeconds !== undefined ? masterSettings.smartOffsetMaxLossTimeframeSeconds : 60}"></div>
                            </div>
                            <div class="flex-row" style="margin-bottom: 12px;">
                                <div class="flex-1"><label>No Peak SL Timeframe (Secs)</label><input type="number" step="1" id="e_noPeakSlTimeframeSeconds" value="\${masterSettings.noPeakSlTimeframeSeconds !== undefined ? masterSettings.noPeakSlTimeframeSeconds : 1800}"></div>
                                <div class="flex-1"><label>No Peak Gate PNL ($)</label><input type="number" step="0.01" id="e_noPeakSlGatePnl" value="\${masterSettings.noPeakSlGatePnl !== undefined ? masterSettings.noPeakSlGatePnl : 0}"></div>
                            </div>
                            <div class="flex-row" style="margin-bottom: 16px;">
                                <label style="display:flex; align-items:center; cursor:pointer;"><input type="checkbox" id="e_minuteCloseAutoDynamic" \${masterSettings.minuteCloseAutoDynamic ? 'checked' : ''} style="width:auto; margin:0 8px 0 0;"> 1-Min Auto-Dynamic Status</label>
                            </div>
                            <button type="button" class="md-btn md-btn-primary" onclick="saveMasterGlobalSettings()"><span class="material-symbols-outlined">save</span> Save Global Settings</button>
                            <div id="e_globalMsg" style="margin-top: 8px; font-weight: bold;"></div>
                        </form>
                    \`;
                    document.getElementById('editorGlobalContainer').innerHTML = globalHtml;

                    let profilesHtml = '';
                    if (masterSettings.subAccounts && masterSettings.subAccounts.length > 0) {
                        masterSettings.subAccounts.forEach((sub, i) => {
                            const activeCoins = (sub.coins || []).filter(c => c.botActive);
                            const coinHtml = activeCoins.map(c => 
                                \`<span style="display:inline-block; background:\${c.side === 'short' ? '#fad2cf' : '#ceead6'}; color:\${c.side === 'short' ? '#d93025' : '#1e8e3e'}; padding:4px 8px; border-radius:12px; font-size:12px; font-weight:bold; margin:2px;">\${c.symbol} (\${c.side})</span>\`
                            ).join(' ');

                            profilesHtml += \`
                                <div class="stat-box" style="margin-bottom: 24px; border: 1px solid var(--primary); background: #fff;">
                                    <div style="background: #e8f0fe; padding: 12px 16px; margin: -16px -16px 16px -16px; border-bottom: 1px solid var(--primary); color: var(--primary); display:flex; justify-content:space-between; font-weight:bold; border-radius: 6px 6px 0 0;">
                                        <span>\${i + 1}. \${sub.name}</span>
                                        <span>Default Side: \${(sub.side || 'long').toUpperCase()}</span>
                                    </div>
                                    
                                    <div class="flex-row" style="margin-bottom: 16px;">
                                        <div class="flex-1"><label style="margin-top:0;">API Key</label><input type="text" id="p_\${i}_apiKey" value="\${sub.apiKey || ''}"></div>
                                        <div class="flex-1"><label style="margin-top:0;">Secret Key</label><input type="text" id="p_\${i}_secret" value="\${sub.secret || ''}"></div>
                                    </div>

                                    <div style="overflow-x:auto;">
                                        <table class="md-table" style="margin-bottom: 16px;">
                                            <tr>
                                                <th>Base Qty</th>
                                                <th>Take Profit %</th>
                                                <th>Stop Loss %</th>
                                                <th>DCA Trigger %</th>
                                                <th>Target ROI %</th>
                                                <th>Max Contracts</th>
                                            </tr>
                                            <tr>
                                                <td><input type="number" step="1" id="p_\${i}_baseQty" value="\${sub.baseQty !== undefined ? sub.baseQty : 1}"></td>
                                                <td><input type="number" step="0.1" id="p_\${i}_takeProfitPct" value="\${sub.takeProfitPct !== undefined ? sub.takeProfitPct : 5.0}"></td>
                                                <td><input type="number" step="0.1" id="p_\${i}_stopLossPct" value="\${sub.stopLossPct !== undefined ? sub.stopLossPct : -25.0}"></td>
                                                <td><input type="number" step="0.1" id="p_\${i}_triggerRoiPct" value="\${sub.triggerRoiPct !== undefined ? sub.triggerRoiPct : -15.0}"></td>
                                                <td><input type="number" step="0.1" id="p_\${i}_dcaTargetRoiPct" value="\${sub.dcaTargetRoiPct !== undefined ? sub.dcaTargetRoiPct : -2.0}"></td>
                                                <td><input type="number" step="1" id="p_\${i}_maxContracts" value="\${sub.maxContracts !== undefined ? sub.maxContracts : 1000}"></td>
                                            </tr>
                                        </table>
                                    </div>

                                    <p style="margin-bottom: 8px;"><strong>Active Coins Trading (\${activeCoins.length}):</strong></p>
                                    <div style="margin-bottom: 16px;">\${coinHtml || '<span class="text-secondary">No active coins</span>'}</div>

                                    <button type="button" class="md-btn md-btn-success" onclick="saveMasterProfile(\${i})"><span class="material-symbols-outlined">done</span> Save Profile \${i + 1}</button>
                                    <div id="p_\${i}_msg" style="margin-top: 8px; font-weight: bold;"></div>
                                </div>
                            \`;
                        });
                    } else {
                        profilesHtml += \`<p class="text-secondary">No profiles configured for the master account.</p>\`;
                    }
                    document.getElementById('editorProfilesContainer').innerHTML = profilesHtml;

                } catch (e) {
                    document.getElementById('editorGlobalContainer').innerHTML = '<p class="text-red">Error loading editor data.</p>';
                }
            }

            async function saveMasterGlobalSettings() {
                const payload = {
                    globalTargetPnl: document.getElementById('e_globalTargetPnl').value !== '' ? parseFloat(document.getElementById('e_globalTargetPnl').value) : 0,
                    globalTrailingPnl: document.getElementById('e_globalTrailingPnl').value !== '' ? parseFloat(document.getElementById('e_globalTrailingPnl').value) : 0,
                    smartOffsetNetProfit: document.getElementById('e_smartOffsetNetProfit').value !== '' ? parseFloat(document.getElementById('e_smartOffsetNetProfit').value) : 0,
                    smartOffsetStopLoss: document.getElementById('e_smartOffsetStopLoss').value !== '' ? parseFloat(document.getElementById('e_smartOffsetStopLoss').value) : 0,
                    smartOffsetNetProfit2: document.getElementById('e_smartOffsetNetProfit2').value !== '' ? parseFloat(document.getElementById('e_smartOffsetNetProfit2').value) : 0,
                    smartOffsetStopLoss2: document.getElementById('e_smartOffsetStopLoss2').value !== '' ? parseFloat(document.getElementById('e_smartOffsetStopLoss2').value) : 0,
                    smartOffsetMaxLossPerMinute: document.getElementById('e_smartOffsetMaxLossPerMinute').value !== '' ? parseFloat(document.getElementById('e_smartOffsetMaxLossPerMinute').value) : 0,
                    smartOffsetMaxLossTimeframeSeconds: document.getElementById('e_smartOffsetMaxLossTimeframeSeconds').value !== '' ? parseInt(document.getElementById('e_smartOffsetMaxLossTimeframeSeconds').value) : 60,
                    noPeakSlTimeframeSeconds: document.getElementById('e_noPeakSlTimeframeSeconds').value !== '' ? parseInt(document.getElementById('e_noPeakSlTimeframeSeconds').value) : 1800,
                    noPeakSlGatePnl: document.getElementById('e_noPeakSlGatePnl').value !== '' ? parseFloat(document.getElementById('e_noPeakSlGatePnl').value) : 0,
                    minuteCloseAutoDynamic: document.getElementById('e_minuteCloseAutoDynamic').checked
                };

                const msgDiv = document.getElementById('e_globalMsg');
                try {
                    const res = await fetch('/api/master/global', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    if (data.success) {
                        msgDiv.className = "text-green";
                        msgDiv.innerText = data.message;
                    } else {
                        msgDiv.className = "text-red";
                        msgDiv.innerText = "Error: " + data.error;
                    }
                } catch(err) {
                    msgDiv.className = "text-red";
                    msgDiv.innerText = "Fetch Error: " + err.message;
                }
                setTimeout(() => { msgDiv.innerText = ''; }, 3000);
            }

            async function saveMasterProfile(index) {
                const payload = {
                    apiKey: document.getElementById('p_' + index + '_apiKey').value,
                    secret: document.getElementById('p_' + index + '_secret').value,
                    baseQty: document.getElementById('p_' + index + '_baseQty').value !== '' ? parseFloat(document.getElementById('p_' + index + '_baseQty').value) : 1,
                    takeProfitPct: document.getElementById('p_' + index + '_takeProfitPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_takeProfitPct').value) : 5.0,
                    stopLossPct: document.getElementById('p_' + index + '_stopLossPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_stopLossPct').value) : -25.0,
                    triggerRoiPct: document.getElementById('p_' + index + '_triggerRoiPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_triggerRoiPct').value) : -15.0,
                    dcaTargetRoiPct: document.getElementById('p_' + index + '_dcaTargetRoiPct').value !== '' ? parseFloat(document.getElementById('p_' + index + '_dcaTargetRoiPct').value) : -2.0,
                    maxContracts: document.getElementById('p_' + index + '_maxContracts').value !== '' ? parseInt(document.getElementById('p_' + index + '_maxContracts').value) : 1000
                };

                const msgDiv = document.getElementById('p_' + index + '_msg');
                try {
                    const res = await fetch('/api/master/profile/' + index, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(payload)
                    });
                    const data = await res.json();
                    if (data.success) {
                        msgDiv.className = "text-green";
                        msgDiv.innerText = data.message;
                    } else {
                        msgDiv.className = "text-red";
                        msgDiv.innerText = "Error: " + data.error;
                    }
                } catch(err) {
                    msgDiv.className = "text-red";
                    msgDiv.innerText = "Fetch Error: " + err.message;
                }
                setTimeout(() => { msgDiv.innerText = ''; }, 3000);
            }

            async function loadAdminData() {
                try {
                    const statusRes = await fetch('/api/admin/status', { headers: { 'Authorization': 'Bearer ' + token } });
                    const statusData = await statusRes.json();

                    const banner = document.getElementById('adminStatusBanner');
                    if (statusData.templateSafe && statusData.webcoinSafe) {
                        banner.style.background = '#E8F5E9';
                        banner.style.color = 'var(--success)';
                        banner.innerHTML = '<span class="material-symbols-outlined">check_circle</span> SYSTEM SAFE: Master Template Protected.';
                    } else {
                        banner.style.background = '#FFEBEE';
                        banner.style.color = 'var(--danger)';
                        banner.innerHTML = '<span class="material-symbols-outlined">error</span> WARNING: Master Template missing!';
                    }

                    const usersRes = await fetch('/api/admin/users', { headers: { 'Authorization': 'Bearer ' + token } });
                    const users = await usersRes.json();

                    let html = '<table class="md-table">';
                    html += '<tr><th>Username</th><th>Password</th><th>Mode</th><th>Global PNL</th><th>Actions</th></tr>';

                    if (users.length === 0) {
                        html += '<tr><td colspan="5" style="text-align:center;">No users found.</td></tr>';
                    } else {
                        users.forEach(u => {
                            const modeText = u.isPaper ? '<span class="text-blue" style="font-weight:bold;">PAPER</span>' : '<span class="text-green" style="font-weight:bold;">REAL</span>';
                            const pnlColor = u.realizedPnl >= 0 ? 'text-green' : 'text-red';
                            html += '<tr>' +
                                '<td style="font-weight:bold;">' + u.username + '</td>' +
                                '<td style="font-family:monospace;">' + u.plainPassword + '</td>' +
                                '<td>' + modeText + '</td>' +
                                '<td class="' + pnlColor + '" style="font-weight:bold;">$' + u.realizedPnl.toFixed(4) + '</td>' +
                                '<td>' +
                                    '<button class="md-btn md-btn-primary" style="padding:6px 12px; margin-right:8px;" onclick="adminImportProfiles(\\'' + u._id + '\\')"><span class="material-symbols-outlined" style="font-size:16px;">download</span> Import Profiles</button>' +
                                    '<button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="adminDeleteUser(\\'' + u._id + '\\')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>' +
                                '</td>' +
                            '</tr>';
                        });
                    }
                    html += '</table>';
                    document.getElementById('adminUsersContainer').innerHTML = html;

                } catch (e) {
                    document.getElementById('adminUsersContainer').innerHTML = '<p class="text-red">Error loading admin data.</p>';
                }
            }

            async function adminImportProfiles(id) {
                if (!confirm("OVERWRITE their profiles with Master configurations?")) return;
                const res = await fetch('/api/admin/users/' + id + '/import', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);
            }

            async function adminDeleteUser(id) {
                if (!confirm("Delete this user permanently?")) return;
                const res = await fetch('/api/admin/users/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if(data.success) { loadAdminData(); } else alert("Error: " + data.error);
            }

            async function adminDeleteAllUsers() {
                if (!confirm("🚨 EXTREME WARNING: Completely wipe all users?")) return;
                const res = await fetch('/api/admin/users', { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } });
                const data = await res.json();
                if(data.success) { alert(data.message); loadAdminData(); } else alert("Error: " + data.error);
            }

            function logout() { 
                localStorage.removeItem('token'); 
                token = null; 
                mySubAccounts = [];
                myCoins = [];
                currentProfileIndex = -1;
                document.getElementById('settingsContainer').style.display = 'none';
                document.getElementById('coinsListContainer').innerHTML = '';
                document.getElementById('logs').innerHTML = '';
                document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>';
                if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
                checkAuth(); 
            }
            
            function toggleNewKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('newSubKey').type = type; document.getElementById('newSubSecret').type = type; }
            function toggleActiveKeys(cb) { const type = cb.checked ? 'text' : 'password'; document.getElementById('apiKey').type = type; document.getElementById('secret').type = type; }

            async function fetchSettings() {
                try {
                    const res = await fetch('/api/settings', { headers: { 'Authorization': 'Bearer ' + token } });
                    if (res.status === 401 || res.status === 403) return logout();
                    const config = await res.json();
                    
                    myGlobalTargetPnl = config.globalTargetPnl !== undefined ? config.globalTargetPnl : 0;
                    myGlobalTrailingPnl = config.globalTrailingPnl !== undefined ? config.globalTrailingPnl : 0;
                    mySmartOffsetNetProfit = config.smartOffsetNetProfit !== undefined ? config.smartOffsetNetProfit : 0;
                    mySmartOffsetBottomRowV1 = config.smartOffsetBottomRowV1 !== undefined ? config.smartOffsetBottomRowV1 : 5;
                    mySmartOffsetBottomRowV1StopLoss = config.smartOffsetBottomRowV1StopLoss !== undefined ? config.smartOffsetBottomRowV1StopLoss : 0; 
                    mySmartOffsetStopLoss = config.smartOffsetStopLoss !== undefined ? config.smartOffsetStopLoss : 0;
                    mySmartOffsetNetProfit2 = config.smartOffsetNetProfit2 !== undefined ? config.smartOffsetNetProfit2 : 0;
                    mySmartOffsetStopLoss2 = config.smartOffsetStopLoss2 !== undefined ? config.smartOffsetStopLoss2 : 0;
                    mySmartOffsetMaxLossPerMinute = config.smartOffsetMaxLossPerMinute !== undefined ? config.smartOffsetMaxLossPerMinute : 0;
                    mySmartOffsetMaxLossTimeframeSeconds = config.smartOffsetMaxLossTimeframeSeconds !== undefined ? config.smartOffsetMaxLossTimeframeSeconds : 60;
                    
                    myMinuteCloseAutoDynamic = config.minuteCloseAutoDynamic || false;
                    myMinuteCloseTpMinPnl = config.minuteCloseTpMinPnl !== undefined ? config.minuteCloseTpMinPnl : 0;
                    myMinuteCloseTpMaxPnl = config.minuteCloseTpMaxPnl !== undefined ? config.minuteCloseTpMaxPnl : 0;
                    myMinuteCloseSlMinPnl = config.minuteCloseSlMinPnl !== undefined ? config.minuteCloseSlMinPnl : 0;
                    myMinuteCloseSlMaxPnl = config.minuteCloseSlMaxPnl !== undefined ? config.minuteCloseSlMaxPnl : 0;

                    myNoPeakSlTimeframeSeconds = config.noPeakSlTimeframeSeconds !== undefined ? config.noPeakSlTimeframeSeconds : 1800;
                    myNoPeakSlGatePnl = config.noPeakSlGatePnl !== undefined ? config.noPeakSlGatePnl : 0;
                    
                    document.getElementById('globalTargetPnl').value = myGlobalTargetPnl;
                    document.getElementById('globalTrailingPnl').value = myGlobalTrailingPnl;
                    document.getElementById('smartOffsetNetProfit').value = mySmartOffsetNetProfit;
                    document.getElementById('smartOffsetBottomRowV1').value = mySmartOffsetBottomRowV1;
                    document.getElementById('smartOffsetBottomRowV1StopLoss').value = mySmartOffsetBottomRowV1StopLoss; 
                    document.getElementById('smartOffsetStopLoss').value = mySmartOffsetStopLoss;
                    document.getElementById('smartOffsetNetProfit2').value = mySmartOffsetNetProfit2;
                    document.getElementById('smartOffsetStopLoss2').value = mySmartOffsetStopLoss2;
                    document.getElementById('smartOffsetMaxLossPerMinute').value = mySmartOffsetMaxLossPerMinute;
                    document.getElementById('smartOffsetMaxLossTimeframeSeconds').value = mySmartOffsetMaxLossTimeframeSeconds;
                    
                    document.getElementById('minuteCloseAutoDynamic').checked = myMinuteCloseAutoDynamic;
                    document.getElementById('minuteCloseTpMinPnl').value = myMinuteCloseTpMinPnl;
                    document.getElementById('minuteCloseTpMaxPnl').value = myMinuteCloseTpMaxPnl;
                    document.getElementById('minuteCloseSlMinPnl').value = myMinuteCloseSlMinPnl;
                    document.getElementById('minuteCloseSlMaxPnl').value = myMinuteCloseSlMaxPnl;

                    document.getElementById('noPeakSlTimeframeSeconds').value = myNoPeakSlTimeframeSeconds;
                    document.getElementById('noPeakSlGatePnl').value = myNoPeakSlGatePnl;

                    mySubAccounts = config.subAccounts || [];
                    renderSubAccounts();
                    
                    if (mySubAccounts.length > 0) {
                        document.getElementById('subAccountSelect').value = 0;
                        loadSubAccount();
                    } else {
                        currentProfileIndex = -1;
                        document.getElementById('settingsContainer').style.display = 'none';
                        document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>';
                        myCoins = [];
                    }
                } catch(e) { console.error(e); }
            }

            async function saveGlobalSettings() {
                myGlobalTargetPnl = document.getElementById('globalTargetPnl').value !== '' ? parseFloat(document.getElementById('globalTargetPnl').value) : 0;
                myGlobalTrailingPnl = document.getElementById('globalTrailingPnl').value !== '' ? parseFloat(document.getElementById('globalTrailingPnl').value) : 0;
                mySmartOffsetNetProfit = document.getElementById('smartOffsetNetProfit').value !== '' ? parseFloat(document.getElementById('smartOffsetNetProfit').value) : 0;
                mySmartOffsetBottomRowV1 = document.getElementById('smartOffsetBottomRowV1').value !== '' ? parseInt(document.getElementById('smartOffsetBottomRowV1').value) : 5;
                mySmartOffsetBottomRowV1StopLoss = document.getElementById('smartOffsetBottomRowV1StopLoss').value !== '' ? parseFloat(document.getElementById('smartOffsetBottomRowV1StopLoss').value) : 0; 
                mySmartOffsetStopLoss = document.getElementById('smartOffsetStopLoss').value !== '' ? parseFloat(document.getElementById('smartOffsetStopLoss').value) : 0; 
                mySmartOffsetNetProfit2 = document.getElementById('smartOffsetNetProfit2').value !== '' ? parseFloat(document.getElementById('smartOffsetNetProfit2').value) : 0;
                mySmartOffsetStopLoss2 = document.getElementById('smartOffsetStopLoss2').value !== '' ? parseFloat(document.getElementById('smartOffsetStopLoss2').value) : 0; 
                mySmartOffsetMaxLossPerMinute = document.getElementById('smartOffsetMaxLossPerMinute').value !== '' ? parseFloat(document.getElementById('smartOffsetMaxLossPerMinute').value) : 0;
                mySmartOffsetMaxLossTimeframeSeconds = document.getElementById('smartOffsetMaxLossTimeframeSeconds').value !== '' ? parseInt(document.getElementById('smartOffsetMaxLossTimeframeSeconds').value) : 60;
                
                myMinuteCloseAutoDynamic = document.getElementById('minuteCloseAutoDynamic').checked;
                myMinuteCloseTpMinPnl = document.getElementById('minuteCloseTpMinPnl').value !== '' ? Math.abs(parseFloat(document.getElementById('minuteCloseTpMinPnl').value)) : 0;
                myMinuteCloseTpMaxPnl = document.getElementById('minuteCloseTpMaxPnl').value !== '' ? Math.abs(parseFloat(document.getElementById('minuteCloseTpMaxPnl').value)) : 0;
                myMinuteCloseSlMinPnl = document.getElementById('minuteCloseSlMinPnl').value !== '' ? -Math.abs(parseFloat(document.getElementById('minuteCloseSlMinPnl').value)) : 0;
                myMinuteCloseSlMaxPnl = document.getElementById('minuteCloseSlMaxPnl').value !== '' ? -Math.abs(parseFloat(document.getElementById('minuteCloseSlMaxPnl').value)) : 0;

                myNoPeakSlTimeframeSeconds = document.getElementById('noPeakSlTimeframeSeconds').value !== '' ? parseInt(document.getElementById('noPeakSlTimeframeSeconds').value) : 1800;
                myNoPeakSlGatePnl = document.getElementById('noPeakSlGatePnl').value !== '' ? parseFloat(document.getElementById('noPeakSlGatePnl').value) : 0;
                
                const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                alert('Global Settings Saved!');
            }

            function renderSubAccounts() {
                const select = document.getElementById('subAccountSelect');
                select.innerHTML = '<option value="">-- Create/Select Profile --</option>';
                if(mySubAccounts.length > 0) {
                    select.innerHTML = '';
                    mySubAccounts.forEach((sub, i) => select.innerHTML += '<option value="' + i + '">' + sub.name + '</option>');
                }
            }

            async function addSubAccount() {
                const name = document.getElementById('newSubName').value.trim();
                const key = document.getElementById('newSubKey').value.trim();
                const secret = document.getElementById('newSubSecret').value.trim();
                if(!name || !key || !secret) return alert("Fill all fields!");
                
                mySubAccounts.push({ name, apiKey: key, secret: secret, side: 'long', leverage: 10, baseQty: 1, takeProfitPct: 5.0, stopLossPct: -25.0, triggerRoiPct: -15.0, dcaTargetRoiPct: -2.0, maxContracts: 1000, realizedPnl: 0, coins: [] });
                await saveSettings(true);
                document.getElementById('newSubName').value = ''; document.getElementById('newSubKey').value = ''; document.getElementById('newSubSecret').value = '';
                renderSubAccounts();
                document.getElementById('subAccountSelect').value = mySubAccounts.length - 1;
                loadSubAccount();
            }

            function loadSubAccount() {
                const select = document.getElementById('subAccountSelect');
                const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    currentProfileIndex = index;
                    const profile = mySubAccounts[index];
                    
                    document.getElementById('settingsContainer').style.display = 'block';
                    document.getElementById('apiKey').value = profile.apiKey || '';
                    document.getElementById('secret').value = profile.secret || '';
                    
                    const cb = document.getElementById('showActiveKeysCheckbox');
                    if(cb) { cb.checked = false; toggleActiveKeys(cb); }

                    document.getElementById('side').value = profile.side || 'long';
                    document.getElementById('leverage').value = 10;
                    document.getElementById('baseQty').value = profile.baseQty !== undefined ? profile.baseQty : 1;
                    document.getElementById('takeProfitPct').value = profile.takeProfitPct !== undefined ? profile.takeProfitPct : 5.0;
                    document.getElementById('stopLossPct').value = profile.stopLossPct !== undefined ? profile.stopLossPct : -25.0; 
                    document.getElementById('triggerRoiPct').value = profile.triggerRoiPct !== undefined ? profile.triggerRoiPct : -15.0;
                    document.getElementById('dcaTargetRoiPct').value = profile.dcaTargetRoiPct !== undefined ? profile.dcaTargetRoiPct : -2.0;
                    document.getElementById('maxContracts').value = profile.maxContracts !== undefined ? profile.maxContracts : 1000;
                    
                    myCoins = profile.coins || [];
                    renderCoinsSettings();
                }
            }

            async function removeSubAccount() {
                const select = document.getElementById('subAccountSelect');
                const index = parseInt(select.value);
                if(!isNaN(index) && index >= 0) {
                    mySubAccounts.splice(index, 1);
                    await saveSettings(true);
                    renderSubAccounts();
                    if(mySubAccounts.length > 0) { document.getElementById('subAccountSelect').value = 0; loadSubAccount(); } 
                    else { currentProfileIndex = -1; document.getElementById('settingsContainer').style.display = 'none'; myCoins = []; document.getElementById('dashboardStatusContainer').innerHTML = '<p>No profile loaded.</p>'; document.getElementById('logs').innerHTML = ''; }
                }
            }

            async function globalToggleBot(active) {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                if(myCoins.length === 0) return alert("Add coins first!");
                myCoins.forEach(c => c.botActive = active);
                await saveSettings(true); 
                alert(active ? "Started all coins on this profile!" : "Stopped all coins.");
            }

            function addPredefinedList() {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                const sideMode = document.getElementById('predefSide').value;
                const startMode = document.getElementById('predefStatus').value === 'started';

                PREDEFINED_COINS.forEach((base, index) => {
                    const symbol = base + '/USDT:USDT';
                    if(myCoins.some(c => c.symbol === symbol)) return; 

                    let coinSide = 'long';
                    if (sideMode === 'allShort') coinSide = 'short';
                    else if (sideMode === 'oddLong') coinSide = (index % 2 === 0) ? 'long' : 'short'; 
                    else if (sideMode === 'evenLong') coinSide = (index % 2 === 0) ? 'short' : 'long'; 

                    myCoins.push({ symbol: symbol, side: coinSide, botActive: startMode });
                });
                renderCoinsSettings();
            }

            function addCoinUI() {
                if(currentProfileIndex === -1) return alert("Load a profile first!");
                const symbol = document.getElementById('newCoinSymbol').value.toUpperCase().trim();
                const masterSide = document.getElementById('side').value; 
                if(!symbol) return alert("Enter pair!");
                if(myCoins.some(c => c.symbol === symbol)) return alert("Already exists!");

                myCoins.push({ symbol: symbol, side: masterSide, botActive: true }); 
                document.getElementById('newCoinSymbol').value = '';
                renderCoinsSettings();
            }

            function removeCoinUI(index) { myCoins.splice(index, 1); renderCoinsSettings(); }

            function renderCoinsSettings() {
                const container = document.getElementById('coinsListContainer');
                container.innerHTML = '';
                myCoins.forEach((coin, i) => {
                    const box = document.createElement('div');
                    box.className = 'stat-box flex-row';
                    box.style.justifyContent = 'space-between';
                    box.style.marginBottom = '8px';
                    const displaySide = coin.side || document.getElementById('side').value;
                    const sideColor = displaySide === 'long' ? 'text-green' : 'text-red';

                    box.innerHTML = '<span style="font-weight: 500; font-size: 1.1em;">' + coin.symbol + ' <span class="' + sideColor + '" style="font-size: 0.75em; text-transform: uppercase;">(' + displaySide + ')</span></span><button class="md-btn md-btn-danger" style="padding:6px 12px; font-size:0.8em;" onclick="removeCoinUI(' + i + ')"><span class="material-symbols-outlined" style="font-size:16px;">delete</span></button>';
                    container.appendChild(box);
                });
            }

            async function saveSettings(silent = false) {
                if(currentProfileIndex === -1) return alert("Load a profile first!");

                const profile = mySubAccounts[currentProfileIndex];
                profile.apiKey = document.getElementById('apiKey').value;
                profile.secret = document.getElementById('secret').value;
                profile.side = document.getElementById('side').value;
                profile.leverage = 10;
                profile.baseQty = document.getElementById('baseQty').value !== '' ? parseFloat(document.getElementById('baseQty').value) : 1;
                profile.takeProfitPct = document.getElementById('takeProfitPct').value !== '' ? parseFloat(document.getElementById('takeProfitPct').value) : 5.0;
                profile.stopLossPct = document.getElementById('stopLossPct').value !== '' ? parseFloat(document.getElementById('stopLossPct').value) : -25.0;
                profile.triggerRoiPct = document.getElementById('triggerRoiPct').value !== '' ? parseFloat(document.getElementById('triggerRoiPct').value) : -15.0;
                profile.dcaTargetRoiPct = document.getElementById('dcaTargetRoiPct').value !== '' ? parseFloat(document.getElementById('dcaTargetRoiPct').value) : -2.0;
                profile.maxContracts = document.getElementById('maxContracts').value !== '' ? parseInt(document.getElementById('maxContracts').value) : 1000;
                profile.coins = myCoins;

                const data = { subAccounts: mySubAccounts, globalTargetPnl: myGlobalTargetPnl, globalTrailingPnl: myGlobalTrailingPnl, smartOffsetNetProfit: mySmartOffsetNetProfit, smartOffsetBottomRowV1: mySmartOffsetBottomRowV1, smartOffsetBottomRowV1StopLoss: mySmartOffsetBottomRowV1StopLoss, smartOffsetStopLoss: mySmartOffsetStopLoss, smartOffsetNetProfit2: mySmartOffsetNetProfit2, smartOffsetStopLoss2: mySmartOffsetStopLoss2, smartOffsetMaxLossPerMinute: mySmartOffsetMaxLossPerMinute, smartOffsetMaxLossTimeframeSeconds: mySmartOffsetMaxLossTimeframeSeconds, minuteCloseAutoDynamic: myMinuteCloseAutoDynamic, minuteCloseTpMinPnl: myMinuteCloseTpMinPnl, minuteCloseTpMaxPnl: myMinuteCloseTpMaxPnl, minuteCloseSlMinPnl: myMinuteCloseSlMinPnl, minuteCloseSlMaxPnl: myMinuteCloseSlMaxPnl, noPeakSlTimeframeSeconds: myNoPeakSlTimeframeSeconds, noPeakSlGatePnl: myNoPeakSlGatePnl };
                const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(data) });
                const json = await res.json();
                mySubAccounts = json.settings.subAccounts || [];
                
                if (!silent) alert('Profile Settings Saved!');
            }

            async function toggleCoinBot(symbol, active) {
                const coin = myCoins.find(c => c.symbol === symbol);
                if(coin) coin.botActive = active;
                await saveSettings(true); 
            }

            async function loadOffsets() {
                const res = await fetch('/api/offsets', { headers: { 'Authorization': 'Bearer ' + token } });
                if (!res.ok) return;
                const records = await res.json();
                
                if (records.length === 0) {
                    const noData = '<p class="text-secondary">No trades executed yet.</p>';
                    document.getElementById('offsetTableContainer').innerHTML = noData;
                    document.getElementById('offsetTableContainer2').innerHTML = noData;
                    return;
                }

                let ih = '<table class="md-table">';
                ih += '<tr><th>Date/Time</th><th>Symbol / Event</th><th>Action / Reason</th><th>Net Profit</th></tr>';
                
                records.forEach(r => {
                    const dateObj = new Date(r.timestamp);
                    const symbolText = r.symbol || r.winnerSymbol || 'Unknown';
                    const reasonText = r.reason || (r.loserSymbol ? 'Smart Offset (Legacy)' : 'Unknown');
                    const net = r.netProfit !== undefined ? r.netProfit : 0;
                    
                    const nColor = net >= 0 ? 'text-green' : 'text-red';

                    ih += '<tr>' +
                        '<td class="text-secondary">' + dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString() + '</td>' +
                        '<td class="text-blue" style="font-weight:500;">' + symbolText + '</td>' +
                        '<td style="font-weight:500;">' + reasonText + '</td>' +
                        '<td class="' + nColor + '" style="font-weight:700;">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(4) + '</td>' +
                    '</tr>';
                });
                ih += '</table>';
                document.getElementById('offsetTableContainer').innerHTML = ih;
                document.getElementById('offsetTableContainer2').innerHTML = ih;
            }

            async function loadStatus() {
                const res = await fetch('/api/status', { headers: { 'Authorization': 'Bearer ' + token } });
                if (res.status === 401 || res.status === 403) return logout();
                
                const data = await res.json();
                const allStatuses = data.states || {};
                const subAccountsUpdated = data.subAccounts || [];
                const globalSet = data.globalSettings || {};
                const currentMinuteLoss = data.currentMinuteLoss || 0;

                let globalTotal = 0;
                subAccountsUpdated.forEach(sub => {
                    globalTotal += (sub.realizedPnl || 0);
                    const localSub = mySubAccounts.find(s => s._id === sub._id);
                    if(localSub) localSub.realizedPnl = sub.realizedPnl;
                });

                let globalUnrealized = 0;
                let globalMarginUsed = 0;
                let totalTrading = 0;
                let totalAboveZero = 0;
                let activeCandidates = [];

                for (let pid in allStatuses) {
                    const st = allStatuses[pid];
                    if (st && st.coinStates) {
                        for (let sym in st.coinStates) {
                            const cs = st.coinStates[sym];
                            if (cs.contracts > 0) {
                                globalMarginUsed += (parseFloat(cs.margin) || 0);
                            }
                            if (cs.contracts > 0 && (!cs.lockUntil || Date.now() >= cs.lockUntil)) {
                                totalTrading++;
                                const pnlNum = parseFloat(cs.unrealizedPnl) || 0;
                                if (cs.currentRoi > 0) totalAboveZero++;
                                globalUnrealized += pnlNum;
                                activeCandidates.push({ symbol: sym, pnl: pnlNum });
                            }
                        }
                    }
                }

                document.getElementById('topGlobalMargin').innerText = "$" + globalMarginUsed.toFixed(2);

                const timeframeSec = globalSet.smartOffsetMaxLossTimeframeSeconds !== undefined ? globalSet.smartOffsetMaxLossTimeframeSeconds : 60;
                const maxLossPerMin = globalSet.smartOffsetMaxLossPerMinute || 0;
                const lossTrackerHtml = maxLossPerMin > 0 
                    ? '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--divider);">⏳ <strong>' + timeframeSec + 's Loss Tracker:</strong> $' + currentMinuteLoss.toFixed(2) + ' / $' + maxLossPerMin.toFixed(2) + ' Limit</div>'
                    : '<div style="margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--divider);">⏳ <strong>' + timeframeSec + 's Loss Tracker:</strong> Limited to 1 SL execution per ' + timeframeSec + 's</div>';
                
                activeCandidates.sort((a, b) => b.pnl - a.pnl);
                const totalCoins = activeCandidates.length;
                const totalPairs = Math.floor(totalCoins / 2);
                let hasDynamicBoundary = false;
                let peakAccumulation = 0;

                const multiplier = globalSet.qtyMultiplier || 1;
                const noPeakGateVal = globalSet.noPeakSlGatePnl !== undefined ? parseFloat(globalSet.noPeakSlGatePnl) : 0; 
                const peakThreshold = 0.0001 * multiplier;
                const winnerThreshold = 0.0002 * multiplier;

                if (totalPairs > 0) {
                    let rAcc = 0;
                    for (let i = 0; i < totalPairs; i++) {
                        rAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                        if (rAcc > peakAccumulation) peakAccumulation = rAcc;
                    }
                    if (peakAccumulation >= peakThreshold) hasDynamicBoundary = true;
                }

                const autoDynCheckbox = document.getElementById('minuteCloseAutoDynamic');
                const tpMinInput = document.getElementById('minuteCloseTpMinPnl');
                const tpMaxInput = document.getElementById('minuteCloseTpMaxPnl');
                const slMinInput = document.getElementById('minuteCloseSlMinPnl');
                const slMaxInput = document.getElementById('minuteCloseSlMaxPnl');
                const autoDynStatusBox = document.getElementById('autoDynStatusBox');

                if (autoDynCheckbox && autoDynCheckbox.checked) {
                    tpMinInput.disabled = true; tpMaxInput.disabled = true;
                    slMinInput.disabled = true; slMaxInput.disabled = true;
                    autoDynStatusBox.style.display = 'block';

                    let tpMinBound = peakAccumulation * 0.8;
                    let tpMaxBound = peakAccumulation * 1.2;
                    let slMaxBound = -(peakAccumulation * 0.5);
                    let slMinBound = -(peakAccumulation * 5.0);

                    if (hasDynamicBoundary) {
                        tpMinInput.value = tpMinBound.toFixed(4);
                        tpMaxInput.value = tpMaxBound.toFixed(4);
                        slMaxInput.value = slMaxBound.toFixed(4);
                        slMinInput.value = slMinBound.toFixed(4);
                    }

                    let adHtml = '';
                    if (hasDynamicBoundary && totalPairs > 0) {
                        let highestGroupAcc = -99999;
                        let lowestGroupAcc = 99999;
                        let highestGroupIndex = -1;
                        let lowestGroupIndex = -1;

                        let currentAcc = 0;
                        for (let i = 0; i < totalPairs; i++) {
                            currentAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                            if (currentAcc > highestGroupAcc) { highestGroupAcc = currentAcc; highestGroupIndex = i; }
                            if (currentAcc < lowestGroupAcc) { lowestGroupAcc = currentAcc; lowestGroupIndex = i; }
                        }

                        let distToTp = tpMinBound - highestGroupAcc;
                        let distToSl = lowestGroupAcc - slMaxBound; 

                        let tpDistText = distToTp > 0 ? '$' + distToTp.toFixed(4) + ' away' : '<span class="text-green" style="font-weight:bold;">IN RANGE</span>';
                        let slDistText = distToSl > 0 ? '$' + distToSl.toFixed(4) + ' away' : '<span class="text-red" style="font-weight:bold;">IN RANGE</span>';

                        adHtml += '<div class="flex-row" style="justify-content: space-between; margin-bottom: 12px;">';
                        adHtml += '<div><span class="stat-label">Closest to TP ($' + tpMinBound.toFixed(4) + ')</span><span class="stat-val" style="font-size:1em;">Row ' + (highestGroupIndex + 1) + ': <span class="' + (highestGroupAcc >= 0 ? 'text-green' : 'text-red') + '">$' + highestGroupAcc.toFixed(4) + '</span> (' + tpDistText + ')</span></div>';
                        adHtml += '<div><span class="stat-label">Closest to SL ($' + slMaxBound.toFixed(4) + ')</span><span class="stat-val" style="font-size:1em;">Row ' + (lowestGroupIndex + 1) + ': <span class="' + (lowestGroupAcc >= 0 ? 'text-green' : 'text-red') + '">$' + lowestGroupAcc.toFixed(4) + '</span> (' + slDistText + ')</span></div>';
                        adHtml += '</div>';
                    } else {
                        adHtml += '<p>Calculating dynamic boundaries... (needs active positive peak)</p>';
                    }

                    if (data.autoDynExec) {
                        const typeColor = data.autoDynExec.type === 'Group Take Profit' ? 'text-green' : 'text-red';
                        adHtml += '<div style="border-top:1px dashed #90CAF9; padding-top:12px; font-size:0.9em;">' +
                            '<strong>Last Execution:</strong> <span class="' + typeColor + '" style="font-weight:bold;">' + data.autoDynExec.type + '</span> on <strong>' + data.autoDynExec.symbol + '</strong> at <span class="' + typeColor + '">$' + data.autoDynExec.pnl.toFixed(4) + '</span>' +
                        '</div>';
                    }
                    document.getElementById('autoDynLiveDetails').innerHTML = adHtml;
                } else if (autoDynCheckbox) {
                    tpMinInput.disabled = false; tpMaxInput.disabled = false;
                    slMinInput.disabled = false; slMaxInput.disabled = false;
                    autoDynStatusBox.style.display = 'none';
                }

                // V1 LIVE TABLE
                if (document.getElementById('offset-tab').style.display === 'block') {
                    const targetV1 = globalSet.smartOffsetNetProfit || 0;
                    const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0; 
                    const fullGroupSl = globalSet.smartOffsetStopLoss || 0; 
                    const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;

                    if (totalPairs === 0) {
                        document.getElementById('liveOffsetsContainer').innerHTML = '<p class="text-secondary">Not enough active trades to form pairs.</p>';
                    } else {
                        let liveHtml = '<table class="md-table">';
                        liveHtml += '<tr><th>Rank Pair</th><th>Winner Coin</th><th>Winner PNL</th><th>Loser Coin</th><th>Loser PNL</th><th>Pair Net</th><th class="text-blue">Group Accumulation</th></tr>';

                        let runningAccumulation = 0; let peakAccumulation = 0; let peakRowIndex = -1; let nthBottomAccumulation = 0;
                        const targetRefIndex = Math.max(0, totalPairs - bottomRowN);

                        for (let i = 0; i < totalPairs; i++) {
                            const w = activeCandidates[i]; const l = activeCandidates[totalCoins - totalPairs + i];
                            runningAccumulation += w.pnl + l.pnl;
                            if (runningAccumulation > peakAccumulation) { peakAccumulation = runningAccumulation; peakRowIndex = i; }
                            if (i === targetRefIndex) nthBottomAccumulation = runningAccumulation;
                        }

                        let topStatusMessage = ''; let executingPeak = false; let executingSl = false; let executingNoPeakSl = false; 
                        const isHitFullGroupSl = (fullGroupSl < 0 && runningAccumulation <= fullGroupSl);

                        if (targetV1 > 0 && peakAccumulation >= targetV1 && peakAccumulation >= peakThreshold && peakRowIndex >= 0) {
                            topStatusMessage = '<span class="text-green" style="font-weight:bold;">🔥 Harvesting Peak Profit ($' + peakAccumulation.toFixed(4) + ') at Row ' + (peakRowIndex + 1) + '!</span>';
                            executingPeak = true;
                        } else if (isHitFullGroupSl) { 
                            let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(runningAccumulation)) > maxLossPerMin);
                            if (blockedByLimit) topStatusMessage = '<span class="text-red" style="font-weight:bold;">🛑 Stop Loss Blocked by Timeframe Limit!</span>';
                            else { executingSl = true; topStatusMessage = '<span class="text-red" style="font-weight:bold;">🔥 Stop Loss Hit (Group &le; $' + fullGroupSl.toFixed(4) + ')!</span>'; }
                        } else if (peakRowIndex === -1 || peakAccumulation < peakThreshold) {
                            if (activeCandidates[0].pnl > noPeakGateVal) {
                                executingNoPeakSl = false;
                                topStatusMessage = '<span class="text-warning" style="font-weight:bold;">⚠️ No Peak Found. GATED: Waiting for winners to drop &le; $' + noPeakGateVal.toFixed(4) + '.</span>';
                            } else {
                                executingNoPeakSl = true;
                                topStatusMessage = '<span class="text-red" style="font-weight:bold;">⚠️ No Peak & Winners &le; $' + noPeakGateVal.toFixed(4) + '. Ready to cut lowest PNL every ' + (globalSet.noPeakSlTimeframeSeconds !== undefined ? globalSet.noPeakSlTimeframeSeconds : 1800) + ' secs.</span>';
                            }
                        } else {
                            let pColor = peakAccumulation >= peakThreshold ? 'text-green' : 'text-secondary';
                            topStatusMessage = 'TP Status: <span class="text-blue" style="font-weight:bold;"><span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">search</span> Seeking Peak &ge; $' + targetV1.toFixed(4) + '</span> | Current Peak: <strong class="' + pColor + '">+$' + peakAccumulation.toFixed(4) + '</strong>';
                        }

                        let displayAccumulation = 0;
                        for (let i = 0; i < totalPairs; i++) {
                            const winnerIndex = i; const loserIndex = totalCoins - totalPairs + i;
                            const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex];
                            const net = w.pnl + l.pnl; displayAccumulation += net;
                            
                            let statusIcon = 'hourglass_empty Waiting';
                            if (executingPeak) {
                                if (i <= peakRowIndex) statusIcon = Math.abs(w.pnl) <= winnerThreshold ? 'pause_circle Skipped' : 'local_fire_department Harvesting';
                                else statusIcon = 'pause_circle Ignored';
                            } else if (executingSl) statusIcon = 'local_fire_department Executing SL';
                            else if (executingNoPeakSl) statusIcon = (i === totalPairs - 1) ? 'local_fire_department Cutting' : 'trending_down Waiting';
                            else statusIcon = (i <= peakRowIndex && peakAccumulation >= peakThreshold) ? 'trending_up Part of Peak' : 'trending_down Dragging down';

                            const wColor = w.pnl >= 0 ? 'text-green' : 'text-red';
                            const lColor = l.pnl >= 0 ? 'text-green' : 'text-red';
                            const nColor = net >= 0 ? 'text-green' : 'text-red';
                            const cColor = displayAccumulation >= 0 ? 'text-green' : 'text-red';

                            let rowClass = (i === peakRowIndex && peakAccumulation >= peakThreshold) ? 'peak-row' : '';
                            if (i === targetRefIndex) rowClass += ' highlight-row'; 

                            liveHtml += '<tr class="' + rowClass + '">' +
                                '<td class="text-secondary">' + (winnerIndex + 1) + ' & ' + (loserIndex + 1) + ' <br><span class="text-blue" style="font-size:0.75em"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">' + statusIcon.split(' ')[0] + '</span> ' + statusIcon.substring(statusIcon.indexOf(' ')+1) + '</span></td>' +
                                '<td style="font-weight:500;">' + w.symbol + '</td>' +
                                '<td class="' + wColor + '" style="font-weight:700;">' + (w.pnl >= 0 ? '+' : '') + '$' + w.pnl.toFixed(4) + '</td>' +
                                '<td style="font-weight:500;">' + l.symbol + '</td>' +
                                '<td class="' + lColor + '" style="font-weight:700;">' + (l.pnl >= 0 ? '+' : '') + '$' + l.pnl.toFixed(4) + '</td>' +
                                '<td class="' + nColor + '" style="font-weight:700; background: #FAFAFA;">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(4) + '</td>' +
                                '<td class="' + cColor + '" style="font-weight:700; background: #F5F5F5;">' +
                                    (displayAccumulation >= 0 ? '+' : '') + '$' + displayAccumulation.toFixed(4) +
                                    (i === targetRefIndex ? '<br><span style="font-size:0.7em; color:var(--warning);"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">star</span> Nth Row Ref Gate</span>' : '') +
                                '</td>' +
                            '</tr>';
                        }
                        liveHtml += '</table>';
                        
                        let dynamicInfoHtml = '<div class="stat-box" style="margin-bottom:16px; background:#E3F2FD; border-color:#90CAF9; color:var(--primary);">' +
                            '<div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;">' +
                                '<div><span class="material-symbols-outlined" style="vertical-align:middle;">my_location</span> Target: $' + targetV1.toFixed(4) + '</div>' +
                                '<div><span class="material-symbols-outlined" style="vertical-align:middle;">block</span> Full Group Stop: $' + fullGroupSl.toFixed(4) + '</div>' +
                                '<div><span class="material-symbols-outlined" style="vertical-align:middle; color:var(--warning);">star</span> Row ' + bottomRowN + ' Gate Limit: $' + stopLossNth.toFixed(4) + '</div>' +
                            '</div>' +
                            lossTrackerHtml +
                            '<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--divider); font-size: 1.1em;">Live Status: ' + topStatusMessage + '</div>' +
                        '</div>';

                        document.getElementById('liveOffsetsContainer').innerHTML = dynamicInfoHtml + liveHtml;
                    }
                }

                // V2 LIVE TABLE
                if (document.getElementById('offset2-tab').style.display === 'block') {
                    const targetV2 = globalSet.smartOffsetNetProfit2 || 0;
                    const limitV2 = globalSet.smartOffsetStopLoss2 || 0;
                    const stopLossNth = globalSet.smartOffsetBottomRowV1StopLoss || 0;
                    const bottomRowN = globalSet.smartOffsetBottomRowV1 !== undefined ? globalSet.smartOffsetBottomRowV1 : 5;
                    const targetRefIndex = Math.max(0, totalPairs - bottomRowN);

                    let nthBottomAccumulation = 0; let tempAcc = 0;
                    for (let i = 0; i < totalPairs; i++) {
                        tempAcc += activeCandidates[i].pnl + activeCandidates[totalCoins - totalPairs + i].pnl;
                        if (i === targetRefIndex) nthBottomAccumulation = tempAcc;
                    }

                    let v2SlEnabled = true;
                    if (stopLossNth < 0) v2SlEnabled = (nthBottomAccumulation <= stopLossNth);

                    if (totalPairs === 0) {
                        document.getElementById('liveOffsetsContainer2').innerHTML = '<p class="text-secondary">Not enough active trades to form pairs.</p>';
                    } else {
                        let liveHtml = '<table class="md-table">';
                        liveHtml += '<tr><th>Rank Pair</th><th>Winner Coin</th><th>Winner PNL</th><th>Loser Coin</th><th>Loser PNL</th><th>Live Net Profit</th></tr>';

                        let topStatusMessage2 = '<span style="color:var(--warning);"><span class="material-symbols-outlined" style="vertical-align:middle;">hourglass_empty</span> Evaluating pairs... Target not reached.</span>';

                        for (let i = 0; i < totalPairs; i++) {
                            const winnerIndex = i; const loserIndex = totalCoins - 1 - i;
                            const w = activeCandidates[winnerIndex]; const l = activeCandidates[loserIndex];
                            const net = w.pnl + l.pnl;

                            const wColor = w.pnl >= 0 ? 'text-green' : 'text-red';
                            const lColor = l.pnl >= 0 ? 'text-green' : 'text-red';
                            const nColor = net >= 0 ? 'text-green' : 'text-red';
                            
                            const isTargetHit = (targetV2 > 0 && net >= targetV2);
                            const isSlHit = (v2SlEnabled && limitV2 < 0 && net <= limitV2);
                            
                            let statusIcon = 'hourglass_empty Evaluating';
                            if (isTargetHit) {
                                statusIcon = 'local_fire_department Executing TP...';
                                topStatusMessage2 = '<span class="text-green" style="font-weight:bold;">🔥 Executing Pair ' + (winnerIndex+1) + ' for TP!</span>';
                            } else if (isSlHit) {
                                let blockedByLimit = (maxLossPerMin > 0 && (currentMinuteLoss + Math.abs(net)) > maxLossPerMin);
                                if (blockedByLimit) {
                                    statusIcon = 'block Blocked by Limit';
                                    if (topStatusMessage2.includes('Evaluating')) topStatusMessage2 = '<span class="text-red" style="font-weight:bold;">🛑 Stop Loss V2 Blocked by Limit!</span>';
                                } else {
                                    statusIcon = 'block Executing SL...';
                                    topStatusMessage2 = '<span class="text-red" style="font-weight:bold;">🛑 Executing Pair ' + (winnerIndex+1) + ' for SL!</span>';
                                }
                            } else if (!v2SlEnabled && limitV2 < 0 && net <= limitV2) {
                                statusIcon = 'pause_circle SL Gated';
                            }

                            liveHtml += '<tr>' +
                                '<td class="text-secondary">' + (winnerIndex + 1) + ' & ' + (loserIndex + 1) + ' <br><span class="text-blue" style="font-size:0.75em"><span class="material-symbols-outlined" style="font-size:12px; vertical-align:middle;">' + statusIcon.split(' ')[0] + '</span> ' + statusIcon.substring(statusIcon.indexOf(' ')+1) + '</span></td>' +
                                '<td style="font-weight:500;">' + w.symbol + '</td>' +
                                '<td class="' + wColor + '" style="font-weight:700;">' + (w.pnl >= 0 ? '+' : '') + '$' + w.pnl.toFixed(4) + '</td>' +
                                '<td style="font-weight:500;">' + l.symbol + '</td>' +
                                '<td class="' + lColor + '" style="font-weight:700;">' + (l.pnl >= 0 ? '+' : '') + '$' + l.pnl.toFixed(4) + '</td>' +
                                '<td class="' + nColor + '" style="font-weight:700; background: #FAFAFA;">' + (net >= 0 ? '+' : '') + '$' + net.toFixed(4) + '</td>' +
                            '</tr>';
                        }
                        liveHtml += '</table>';
                        
                        let slGateStatus = stopLossNth < 0 
                            ? (v2SlEnabled ? '<span class="text-red" style="font-weight:bold;">ENABLED</span> (V1 Accum &le; Limit)' : '<span style="color:var(--warning); font-weight:bold;">GATED</span> (V1 Accum &gt; Limit)')
                            : '<span class="text-green" style="font-weight:bold;">ALWAYS ENABLED</span> (No Gate Set)';

                        let dynamicInfoHtml2 = '<div class="stat-box" style="margin-bottom:16px; background:#E3F2FD; border-color:#90CAF9; color:var(--primary);">' +
                            '<div class="flex-row" style="justify-content: space-between; margin-bottom: 8px;">' +
                                '<div><span class="material-symbols-outlined" style="vertical-align:middle;">my_location</span> TP V2: $' + targetV2.toFixed(4) + '</div>' +
                                '<div><span class="material-symbols-outlined" style="vertical-align:middle;">block</span> SL V2: $' + limitV2.toFixed(4) + '</div>' +
                                '<div style="font-size:0.9em;"><span class="material-symbols-outlined" style="vertical-align:middle;">security</span> V2 Gate: ' + slGateStatus + '</div>' +
                            '</div>' +
                            lossTrackerHtml +
                            '<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--divider); font-size: 1.1em;">Live Status: ' + topStatusMessage2 + '</div>' +
                        '</div>';

                        document.getElementById('liveOffsetsContainer2').innerHTML = dynamicInfoHtml2 + liveHtml;
                    }
                }

                document.getElementById('globalWinRate').innerText = totalAboveZero + ' / ' + totalTrading;
                const topPnlEl = document.getElementById('topGlobalUnrealized');
                topPnlEl.innerText = (globalUnrealized >= 0 ? "+$" : "-$") + Math.abs(globalUnrealized).toFixed(4);
                topPnlEl.className = 'stat-val ' + (globalUnrealized >= 0 ? 'text-green' : 'text-red');

                if(currentProfileIndex === -1) return;

                const globalPnlEl = document.getElementById('globalPnl');
                globalPnlEl.innerText = (globalTotal >= 0 ? "+$" : "-$") + Math.abs(globalTotal).toFixed(4);
                globalPnlEl.className = 'stat-val ' + (globalTotal >= 0 ? 'text-green' : 'text-red');

                const profile = mySubAccounts[currentProfileIndex];
                const profilePnlEl = document.getElementById('profilePnl');
                const pPnl = profile.realizedPnl || 0;
                profilePnlEl.innerText = (pPnl >= 0 ? "+$" : "-$") + Math.abs(pPnl).toFixed(4);
                profilePnlEl.className = 'stat-val ' + (pPnl >= 0 ? 'text-green' : 'text-red');

                let profileMargin = 0;
                const stateData = allStatuses[profile._id] || { coinStates: {}, logs: [] };
                
                if(!myCoins || myCoins.length === 0) {
                    document.getElementById('dashboardStatusContainer').innerHTML = '<p class="text-secondary">No coins added to this profile.</p>';
                    document.getElementById('profileMargin').innerText = "$0.00";
                } else {
                    let html = '';
                    myCoins.forEach(coin => {
                        const state = stateData.coinStates && stateData.coinStates[coin.symbol] ? stateData.coinStates[coin.symbol] : { status: 'Stopped', currentPrice: 0, avgEntry: 0, contracts: 0, currentRoi: 0, unrealizedPnl: 0, margin: 0 };
                        
                        if (state.contracts > 0) {
                            profileMargin += (parseFloat(state.margin) || 0);
                        }

                        let statusColor = state.status === 'Running' ? 'text-green' : 'text-red';
                        let roiColorClass = state.currentRoi >= 0 ? 'text-green' : 'text-red';
                        const displaySide = coin.side || profile.side || 'long';

                        if (state.lockUntil && Date.now() < state.lockUntil) {
                            statusColor = 'text-warning';
                            state.status = 'Closing / Locked';
                        }

                        html += '<div class="stat-box" style="margin-bottom:16px;">' +
                            '<div class="flex-row" style="justify-content: space-between; border-bottom: 1px solid var(--divider); padding-bottom: 12px; margin-bottom: 12px;">' +
                                '<div style="font-size: 1.1em; font-weight: 500;">' +
                                    coin.symbol + ' <span class="text-secondary" style="font-size: 0.8em;">(' + displaySide.toUpperCase() + ')</span> - Status: <span class="' + statusColor + '" style="font-weight:700;">' + state.status + '</span>' +
                                '</div>' +
                                '<div class="flex-row">' +
                                    '<button class="md-btn md-btn-success" style="padding:6px 12px;" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', true)"><span class="material-symbols-outlined" style="font-size:18px;">play_arrow</span> Start</button>' +
                                    '<button class="md-btn md-btn-danger" style="padding:6px 12px;" onclick="toggleCoinBot(\\'' + coin.symbol + '\\', false)"><span class="material-symbols-outlined" style="font-size:18px;">stop</span> Stop</button>' +
                                '</div>' +
                            '</div>' +
                            '<div class="flex-row" style="justify-content: space-between;">' +
                                '<div><span class="stat-label">Price</span><span class="stat-val" style="font-size:1em;">' + (state.currentPrice || 0) + '</span></div>' +
                                '<div><span class="stat-label">Avg Entry</span><span class="stat-val" style="font-size:1em;">' + (state.avgEntry || 0) + '</span></div>' +
                                '<div><span class="stat-label">Contracts</span><span class="stat-val" style="font-size:1em;">' + (state.contracts || 0) + '</span></div>' +
                                '<div><span class="stat-label">Unrealized PNL</span><span class="stat-val ' + roiColorClass + '" style="font-size:1em;">' + (state.unrealizedPnl || 0).toFixed(4) + '</span></div>' +
                                '<div><span class="stat-label">ROI %</span><span class="stat-val ' + roiColorClass + '" style="font-size:1em;">' + (state.currentRoi || 0).toFixed(2) + '%</span></div>' +
                            '</div>' +
                        '</div>';
                    });
                    document.getElementById('dashboardStatusContainer').innerHTML = html;
                    document.getElementById('profileMargin').innerText = "$" + profileMargin.toFixed(2);
                }

                document.getElementById('logs').innerHTML = (stateData.logs || []).join('<br>');
            }

            checkAuth(); // Initialize
        </script>
    </body>
    </html>
    `);
});

// VERCEL EXPORT: Safe Execution Block
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Running locally on http://localhost:${PORT}`));
}
module.exports = app;
