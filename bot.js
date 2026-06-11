require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

// Try to load ollama
let ollama = null;
try {
    ollama = require('ollama');
    console.log('✅ Ollama package loaded');
} catch (e) {
    console.log('⚠️ Ollama package not available');
}

const app = express();
app.use(express.json());

// ==================== HTX DOGE OPTIMIZED CONFIGURATION ====================
const apiAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}

// Dynamic config - ALL parameters controlled by AI
let config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 50,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 10,
    takeProfitPct: 10,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.1,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 0.25,
    dogePerContract: 100,
    stepCooldownMs: 10 * 60 * 1000,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    
    // AI Settings - Analyze every 10 seconds
    aiEnabled: true,
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    aiControlInterval: 10000, // 10 seconds analysis
    lastAIConfigUpdate: 0,
    
    // HTX DOGE OPTIMAL RANGES
    allowedLeverages: [75, 50, 25, 10],
    leverageTPMapping: {
        75: 15,
        50: 10,
        25: 5,
        10: 1.5
    },
    minLeverage: 10,
    maxLeverage: 75,
    minTakeProfit: 1.5,
    maxTakeProfit: 15,
    minBaseVolume: 1,
    maxBaseVolume: 10000,
    minMultiplier: 1.1,
    maxMultiplier: 2.0,
    minStepDistance: 5,
    maxStepDistance: 20,
    minRiskPercent: 0.1,
    maxRiskPercent: 5,
    minMaxStartSpread: 0.05,
    maxMaxStartSpread: 0.5,
    
    // Profit & Spending Optimization
    maxDailyFees: 0.01,
    profitTarget: 5,
    stopLossThreshold: 10,
    imbalanceThreshold: 3
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0,
    walletHistory: [],
    peakEquity: 0,
    maxDrawdown: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalFeesPaid: 0,
    currentBaseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    currentBaseDoge: 0,
    currentRiskAmount: 0,
    lastBaseUpdate: Date.now(),
    aiRecommendation: null,
    aiLastUpdate: 0,
    aiConfigChanges: [],
    dogeVolatility: 0,
    ollamaAvailable: false,
    dailyFees: 0,
    lastFeeReset: Date.now(),
    lastActionTime: 0
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let lastStepTime = {};

// ==================== HELPER FUNCTIONS ====================

function calculateTakeProfitFromLeverage(leverage) {
    return config.leverageTPMapping[leverage] || 10;
}

function calculateTargetPrice(state) {
    const requiredPriceMovePct = config.takeProfitPct / config.leverage;
    
    if (state.direction === 'buy') {
        const targetPrice = state.entryPrice * (1 + (requiredPriceMovePct / 100));
        const feeAdjustedTarget = targetPrice * (1 + config.takerFeeRate);
        return feeAdjustedTarget;
    } else {
        const targetPrice = state.entryPrice * (1 - (requiredPriceMovePct / 100));
        const feeAdjustedTarget = targetPrice * (1 - config.takerFeeRate);
        return feeAdjustedTarget;
    }
}

function calculateStepFromVolume(volume, baseVolume, multiplier) {
    if (volume === 0) return 0;
    
    let totalVolume = 0;
    let step = 0;
    
    while (totalVolume < volume) {
        const stepVolume = step === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, step));
        totalVolume += stepVolume;
        if (totalVolume <= volume) {
            step++;
        } else {
            break;
        }
    }
    return step;
}

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    let volume = Math.floor(riskAmount / 0.005);
    volume = Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, volume));
    
    if (market.spread > 0.1) volume = Math.floor(volume * 0.7);
    else if (market.spread > 0.05) volume = Math.floor(volume * 0.85);
    
    const leverageFactor = 75 / config.leverage;
    volume = Math.floor(volume * Math.min(1.5, Math.max(0.5, leverageFactor)));
    volume = Math.max(config.minBaseVolume, volume);
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseDoge = volume * config.dogePerContract;
    
    return volume;
}

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
    
    if (now - market.lastFeeReset > 86400000) {
        market.dailyFees = 0;
        market.lastFeeReset = now;
    }
    
    const lastRecord = market.walletHistory[market.walletHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000) {
        market.walletHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            equity: totalEquity,
            pnl: totalEquity - market.initialTotalEquity,
            pnlPercent: market.initialTotalEquity > 0 ? ((totalEquity - market.initialTotalEquity) / market.initialTotalEquity) * 100 : 0,
            longRoi: accountStates[1]?.roi || 0,
            shortRoi: accountStates[2]?.roi || 0
        });
        if (market.walletHistory.length > 100) market.walletHistory.shift();
    }
    
    if (totalEquity > market.peakEquity) market.peakEquity = totalEquity;
    if (market.peakEquity > 0) {
        const currentDrawdown = ((market.peakEquity - totalEquity) / market.peakEquity) * 100;
        if (currentDrawdown > market.maxDrawdown) market.maxDrawdown = currentDrawdown;
    }
}

function calculateDogeVolatility() {
    if (market.walletHistory.length < 10) return 2;
    let returns = [];
    for (let i = 1; i < Math.min(20, market.walletHistory.length); i++) {
        const prev = market.walletHistory[i-1].equity;
        const curr = market.walletHistory[i].equity;
        if (prev > 0) returns.push(Math.abs((curr - prev) / prev) * 100);
    }
    if (returns.length === 0) return 2;
    market.dogeVolatility = returns.reduce((a, b) => a + b, 0) / returns.length;
    return market.dogeVolatility;
}

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false,
        pendingOrderId: null,
        lastAction: 'Idle',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastExchangeRoi: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0,
        realizedPnl: 0,
        totalFees: 0
    };
    lastStepTime[account.accountId] = 0;
});

function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = {
        AccessKeyId: account.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp,
        ...params
    };
    const sortedParams = Object.keys(allParams).sort().map(key => `${key}=${encodeURIComponent(allParams[key])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedParams].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    return { timestamp, signature, sortedParams };
}

async function htxRequest(account, method, path, data = {}) {
    try {
        const { sortedParams, signature } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        const options = { method, url, headers: { 'Content-Type': 'application/json' }, timeout: 5000 };
        if (method === 'POST') options.data = data;
        const res = await axios(options);
        return res.data;
    } catch (e) {
        return { status: 'error', msg: e.message };
    }
}

async function closePosition(account, state) {
    if (state.volume === 0) return true;
    console.log(`🔒 Closing ${state.direction} position...`);
    const res = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbol,
        volume: state.volume,
        direction: state.direction === 'buy' ? 'sell' : 'buy',
        offset: 'close',
        lever_rate: config.leverage,
        order_price_type: 'optimal_20'
    });
    if (res?.status === 'ok') {
        state.volume = 0;
        state.roi = 0;
        state.unrealizedUsdt = 0;
        state.entryPrice = 0;
        state.targetPrice = 0;
        return true;
    }
    return false;
}

async function fetchPriceRest() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`;
        const res = await axios.get(url, { timeout: 3000 });
        if (res.data?.tick) {
            market.bid = parseFloat(res.data.tick.bid[0]);
            market.ask = parseFloat(res.data.tick.ask[0]);
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
            market.lastPriceUpdate = Date.now();
        }
    } catch (e) {}
}

async function syncAccount(acc, state) {
    const now = Date.now();
    
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol,
            order_id: state.pendingOrderId
        });
        if (orderRes?.data?.[0]?.status === 6 || orderRes?.data?.[0]?.status === 7) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else if (orderRes?.data?.[0]?.status === 4 || orderRes?.data?.[0]?.status === 5) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else {
            return;
        }
    }
    if (state.isLocked) return;
    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) return;
    lastPositionFetch[acc.accountId] = now;

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos && parseFloat(pos.volume) > 0) {
            const newVolume = parseFloat(pos.volume);
            const newEntryPrice = parseFloat(pos.cost_open);
            const newExchangeRoi = parseFloat(pos.profit_rate) * 100;
            const newUnrealizedUsdt = parseFloat(pos.profit);
            
            state.volume = newVolume;
            state.entryPrice = newEntryPrice;
            state.unrealizedUsdt = newUnrealizedUsdt;
            state.roi = newExchangeRoi;
            state.targetPrice = calculateTargetPrice(state);
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else if (state.volume !== 0) {
            console.log(`✅ ${state.direction.toUpperCase()} position closed`);
            state.volume = 0;
            state.roi = 0;
            state.unrealizedUsdt = 0;
            state.entryPrice = 0;
            state.targetPrice = 0;
            state.startTime = null;
        }
    }

    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) return;
    lastBalanceFetch[acc.accountId] = now;

    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTrade(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    const fee = Math.abs(finalPnl) * config.takerFeeRate;
    market.totalTrades++;
    if (finalPnl >= 0) market.winningTrades++;
    else market.losingTrades++;
    market.totalFeesPaid += fee;
    market.dailyFees += fee;
    
    tradeHistory.unshift({
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        step: step,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        pnl: finalPnl.toFixed(8),
        fee: fee.toFixed(8)
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
    state.realizedPnl += finalPnl;
    console.log(`📊 CLOSED ${state.direction} | ROI: ${finalRoi.toFixed(2)}% | PnL: $${finalPnl.toFixed(8)}`);
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        console.log('✅ WebSocket connected');
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                if (msg.tick && msg.ch?.includes('bbo')) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                }
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            } catch (e) {}
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== OLLAMA AI ANALYZES EVERY 10 SECONDS ====================

async function ollamaAIAnalysis() {
    if (!config.aiEnabled) return;
    
    const long = accountStates[1];
    const short = accountStates[2];
    const totalEquity = (long?.currentEquity || 0) + (short?.currentEquity || 0);
    const drawdown = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100) : 0;
    const winRate = market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100) : 0;
    const combinedPnL = (long?.unrealizedUsdt || 0) + (short?.unrealizedUsdt || 0);
    
    // Build dashboard data for AI
    const dashboardData = `
DASHBOARD DATA (${new Date().toLocaleTimeString()}):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 WALLET: $${totalEquity.toFixed(4)} (${market.growthPct.toFixed(2)}% P&L)
📉 DRAWDOWN: ${drawdown.toFixed(2)}%
🎯 WIN RATE: ${winRate.toFixed(1)}% (${market.totalTrades} trades)
💵 FEES TODAY: $${market.dailyFees.toFixed(6)}

📈 LONG POSITION:
   • ROI: ${long?.roi?.toFixed(2) || 0}%
   • PnL: $${long?.unrealizedUsdt?.toFixed(4) || 0}
   • Volume: ${long?.volume || 0} contracts
   • Step: ${calculateStepFromVolume(long?.volume || 0, market.currentBaseVolume, config.multiplier)}

📉 SHORT POSITION:
   • ROI: ${short?.roi?.toFixed(2) || 0}%
   • PnL: $${short?.unrealizedUsdt?.toFixed(4) || 0}
   • Volume: ${short?.volume || 0} contracts
   • Step: ${calculateStepFromVolume(short?.volume || 0, market.currentBaseVolume, config.multiplier)}

📊 COMBINED: $${combinedPnL.toFixed(4)} | Both Profitable: ${(long?.roi || 0) > 0 && (short?.roi || 0) > 0 ? 'YES' : 'NO'}

⚙️ CURRENT SETTINGS:
   • Leverage: ${config.leverage}x (TP: ${config.takeProfitPct}%)
   • Base Volume: ${config.baseVolume} | Risk: ${config.riskPercent}%
   • Multiplier: ${config.multiplier}x | Step Trigger: -${config.stepDistancePct}%
   • Max Spread: ${config.maxStartSpread}%

🎯 MARKET:
   • Price: $${market.bid?.toFixed(6) || 0}
   • Spread: ${market.spread?.toFixed(3) || 0}%
   • Volatility: ${market.dogeVolatility.toFixed(2)}%

Based on this data, what actions should I take to MAXIMIZE PROFIT and REDUCE SPENDING/WASTED FEES?
Output in this EXACT format:

ACTION: [Close LONG|Close SHORT|Close Both|Reduce Volume|Increase Volume|Wait|Adjust Leverage|Adjust Risk]
REASON: [brief explanation]
NEW_CONFIG: [leave blank or specify changes]

Be aggressive about closing losing positions that are bleeding profit. The goal is to have ONE profitable direction, not two fighting each other.`;

    try {
        console.log('\n🤖 OLLAMA AI Analyzing Dashboard (10s interval)...');
        
        // Try Ollama if available
        if (ollama) {
            try {
                const response = await ollama.chat({
                    model: config.ollamaModel,
                    messages: [{ role: 'user', content: dashboardData }],
                    options: { temperature: 0.5, num_predict: 300 }
                });
                const aiOutput = response.message.content;
                console.log('🤖 AI Response:\n', aiOutput);
                
                // Parse AI decision
                const actionMatch = aiOutput.match(/ACTION:\s*(.+)/i);
                const reasonMatch = aiOutput.match(/REASON:\s*(.+)/i);
                const configMatch = aiOutput.match(/NEW_CONFIG:\s*(.+)/i);
                
                const action = actionMatch ? actionMatch[1].trim() : '';
                const reason = reasonMatch ? reasonMatch[1].trim() : 'AI optimization';
                
                // Execute AI decision
                if (action.includes('Close LONG') && long?.volume > 0) {
                    console.log(`🔴 AI DECISION: Closing LONG position - ${reason}`);
                    await closePosition(config.accounts[0], long);
                } else if (action.includes('Close SHORT') && short?.volume > 0) {
                    console.log(`🔴 AI DECISION: Closing SHORT position - ${reason}`);
                    await closePosition(config.accounts[1], short);
                } else if (action.includes('Close Both')) {
                    console.log(`🔴 AI DECISION: Closing BOTH positions - ${reason}`);
                    await closePosition(config.accounts[0], long);
                    await closePosition(config.accounts[1], short);
                } else if (action.includes('Reduce Volume')) {
                    const newVol = Math.max(1, config.baseVolume * 0.7);
                    console.log(`📉 AI DECISION: Reducing volume to ${newVol} - ${reason}`);
                    config.baseVolume = newVol;
                    if (!config.autoCompound) market.currentBaseVolume = newVol;
                } else if (action.includes('Increase Volume') && totalEquity > market.initialTotalEquity) {
                    const newVol = Math.min(10, config.baseVolume * 1.2);
                    console.log(`📈 AI DECISION: Increasing volume to ${newVol} - ${reason}`);
                    config.baseVolume = newVol;
                } else if (action.includes('Adjust Leverage')) {
                    const levMatch = action.match(/(\d+)x/);
                    if (levMatch) {
                        let newLev = parseInt(levMatch[1]);
                        if (config.allowedLeverages.includes(newLev)) {
                            console.log(`⚙️ AI DECISION: Adjusting leverage to ${newLev}x - ${reason}`);
                            config.leverage = newLev;
                            config.takeProfitPct = config.leverageTPMapping[newLev];
                            if (long?.volume > 0) long.targetPrice = calculateTargetPrice(long);
                            if (short?.volume > 0) short.targetPrice = calculateTargetPrice(short);
                        }
                    }
                } else if (action.includes('Adjust Risk')) {
                    const riskMatch = action.match(/(\d+(?:\.\d+)?)%/);
                    if (riskMatch) {
                        let newRisk = parseFloat(riskMatch[1]);
                        newRisk = Math.min(5, Math.max(0.1, newRisk));
                        console.log(`⚙️ AI DECISION: Adjusting risk to ${newRisk}% - ${reason}`);
                        config.riskPercent = newRisk;
                    }
                } else {
                    console.log(`⏳ AI DECISION: ${action || 'Wait'} - ${reason}`);
                }
                
                // Build recommendation text
                const recommendationText = `🤖 OLLAMA ANALYSIS (${new Date().toLocaleTimeString()})\n\n${aiOutput}\n\n📊 Current Wallet: $${totalEquity.toFixed(4)}\n💵 Daily Fees: $${market.dailyFees.toFixed(6)}`;
                
                market.aiRecommendation = {
                    text: recommendationText,
                    timestamp: Date.now(),
                    time: new Date().toLocaleString(),
                    action: action,
                    reason: reason
                };
                
                return;
            } catch (ollamaError) {
                console.log('⚠️ Ollama error:', ollamaError.message);
            }
        }
        
        // FALLBACK: Smart local decision engine
        console.log('📊 Using local smart decision engine...');
        let action = 'Wait';
        let reason = '';
        
        // Check for hedge bleed (LONG profitable, SHORT losing OR vice versa)
        const longRoi = long?.roi || 0;
        const shortRoi = short?.roi || 0;
        const longProfitable = longRoi > 0;
        const shortProfitable = shortRoi > 0;
        
        if (longProfitable && !shortProfitable && short?.volume > 0) {
            action = 'Close SHORT';
            reason = `SHORT position losing ${Math.abs(shortRoi).toFixed(2)}% while LONG is profitable. Stopping the bleeding.`;
            await closePosition(config.accounts[1], short);
        } else if (!longProfitable && shortProfitable && long?.volume > 0) {
            action = 'Close LONG';
            reason = `LONG position losing ${Math.abs(longRoi).toFixed(2)}% while SHORT is profitable. Stopping the bleeding.`;
            await closePosition(config.accounts[0], long);
        } else if (!longProfitable && !shortProfitable && (long?.volume > 0 || short?.volume > 0)) {
            action = 'Close Both';
            reason = `Both positions losing (LONG: ${longRoi.toFixed(2)}%, SHORT: ${shortRoi.toFixed(2)}%). Cutting losses.`;
            if (long?.volume > 0) await closePosition(config.accounts[0], long);
            if (short?.volume > 0) await closePosition(config.accounts[1], short);
        } else if (longProfitable && shortProfitable && combinedPnL > 0.05) {
            action = 'Take Partial Profits';
            reason = `Both positions profitable! Combined profit $${combinedPnL.toFixed(4)}. Consider taking profits.`;
        } else if (market.dailyFees > 0.005) {
            action = 'Reduce Volume';
            reason = `Fees accumulating ($${market.dailyFees.toFixed(6)} today). Reducing position size.`;
            config.baseVolume = Math.max(1, config.baseVolume * 0.8);
        } else if (drawdown > 8) {
            action = 'Close Both - Emergency';
            reason = `Drawdown ${drawdown.toFixed(1)}% approaching limit. Protecting capital.`;
            if (long?.volume > 0) await closePosition(config.accounts[0], long);
            if (short?.volume > 0) await closePosition(config.accounts[1], short);
        } else {
            action = 'Wait';
            reason = `No immediate action needed. Monitoring market conditions.`;
        }
        
        console.log(`🧠 LOCAL DECISION: ${action} - ${reason}`);
        
        const recommendationText = `🧠 SMART LOCAL AI (${new Date().toLocaleTimeString()})\n\nACTION: ${action}\nREASON: ${reason}\n\n📊 Wallet: $${totalEquity.toFixed(4)}\nLONG: ${longRoi.toFixed(2)}% | SHORT: ${shortRoi.toFixed(2)}%\nFees Today: $${market.dailyFees.toFixed(6)}`;
        
        market.aiRecommendation = {
            text: recommendationText,
            timestamp: Date.now(),
            time: new Date().toLocaleString(),
            action: action,
            reason: reason
        };
        
    } catch (error) {
        console.error('AI Analysis error:', error.message);
    }
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        if (currentPrice === 0) continue;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}% > ${config.maxStartSpread}%)`;
                continue;
            }
            
            console.log(`🚀 Opening ${state.direction} at ${currentPrice.toFixed(8)} | ${market.currentBaseVolume} contracts @ ${config.leverage}x`);
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: market.currentBaseVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Opened at ${state.entryPrice.toFixed(8)} | TP: ${state.targetPrice.toFixed(8)}`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
            }
            continue;
        }

        let shouldTakeProfit = false;
        let exitPrice = 0;
        
        if (state.direction === 'buy' && market.ask >= state.targetPrice && state.targetPrice > 0) {
            shouldTakeProfit = true;
            exitPrice = market.ask;
        } else if (state.direction === 'sell' && market.bid <= state.targetPrice && state.targetPrice > 0) {
            shouldTakeProfit = true;
            exitPrice = market.bid;
        }
        
        if (shouldTakeProfit) {
            console.log(`✅ Taking ${state.direction} profit (${config.takeProfitPct}% ROI)`);
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                logTrade(state, exitPrice, new Date().toLocaleString(), config.takeProfitPct, state.unrealizedUsdt);
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.targetPrice = 0;
                state.startTime = null;
            } else {
                state.isLocked = false;
            }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const now = Date.now();
        const timeSinceLastStep = now - (lastStepTime[acc.accountId] || 0);
        
        if (state.roi <= -config.stepDistancePct && state.volume > 0 && timeSinceLastStep >= config.stepCooldownMs) {
            const nextStepNumber = currentStep + 1;
            let nextVol = nextStepNumber === 1 ? Math.ceil(market.currentBaseVolume * config.multiplier) : Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} | Adding: ${nextVol} contracts`);
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: nextVol,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                lastStepTime[acc.accountId] = now;
            }
            state.isLocked = false;
        } else {
            state.lastAction = `Step ${currentStep} | ROI: ${state.roi.toFixed(2)}% | TP: ${config.takeProfitPct}%`;
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
        for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
        
        const long = accountStates[1];
        const short = accountStates[2];
        
        if (long && short) {
            if (market.initialTotalEquity === 0 && long.initialEquity !== null && short.initialEquity !== null) {
                market.initialTotalEquity = long.initialEquity + short.initialEquity;
                market.peakEquity = market.initialTotalEquity;
                console.log(`\n💰 INITIAL EQUITY: $${market.initialTotalEquity.toFixed(4)}\n`);
            }
            
            if (market.initialTotalEquity > 0) {
                const totalEquity = long.currentEquity + short.currentEquity;
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        market.currentBaseVolume = newBaseVolume;
                    }
                }
                updateWalletGrowth(totalEquity);
            }
        }
        
        if (market.status === 'Active') await processMartingale();
        
        // Run AI analysis every 10 seconds
        if (config.aiEnabled && (!market.aiLastUpdate || (Date.now() - market.aiLastUpdate) > config.aiControlInterval)) {
            calculateDogeVolatility();
            await ollamaAIAnalysis();
            market.aiLastUpdate = Date.now();
        }
    } catch (e) {
        console.error('Background error:', e.message);
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const long = accountStates[1];
    const short = accountStates[2];
    const totalEquity = (long?.currentEquity || 0) + (short?.currentEquity || 0);
    
    res.json({
        market: {
            ...market,
            totalEquity: totalEquity,
            totalNetGain: market.totalNetGain,
            growthPct: market.growthPct,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            currentBaseVolume: market.currentBaseVolume,
            currentBaseDoge: market.currentBaseDoge,
            aiRecommendation: market.aiRecommendation,
            dailyFees: market.dailyFees,
            currentConfig: {
                leverage: config.leverage,
                takeProfitPct: config.takeProfitPct,
                riskPercent: config.riskPercent,
                baseVolume: config.baseVolume,
                multiplier: config.multiplier,
                stepDistancePct: config.stepDistancePct,
                maxStartSpread: config.maxStartSpread
            },
            dualMetrics: {
                longRoi: long?.roi || 0,
                shortRoi: short?.roi || 0,
                longVolume: long?.volume || 0,
                shortVolume: short?.volume || 0,
                combinedPnL: (long?.unrealizedUsdt || 0) + (short?.unrealizedUsdt || 0)
            }
        },
        accounts: [
            { direction: 'buy', roi: long?.roi || 0, volume: long?.volume || 0, dogeAmount: (long?.volume || 0) * 100, unrealizedUsdt: long?.unrealizedUsdt || 0, entryPrice: long?.entryPrice || 0, targetPrice: long?.targetPrice || 0, lastAction: long?.lastAction || 'Idle' },
            { direction: 'sell', roi: short?.roi || 0, volume: short?.volume || 0, dogeAmount: (short?.volume || 0) * 100, unrealizedUsdt: short?.unrealizedUsdt || 0, entryPrice: short?.entryPrice || 0, targetPrice: short?.targetPrice || 0, lastAction: short?.lastAction || 'Idle' }
        ],
        tradeHistory: tradeHistory.slice(0, 20)
    });
});

app.post('/api/close', async (req, res) => {
    console.log("🔴 EMERGENCY CLOSE");
    const long = accountStates[1];
    const short = accountStates[2];
    if (long?.volume > 0) await closePosition(config.accounts[0], long);
    if (short?.volume > 0) await closePosition(config.accounts[1], short);
    res.json({ status: 'ok' });
});

app.post('/api/force-sync', async (req, res) => {
    for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
    res.json({ status: 'ok' });
});

app.post('/api/ai-refresh', async (req, res) => {
    await ollamaAIAnalysis();
    res.json({ recommendation: market.aiRecommendation });
});

// Dashboard HTML
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale DOGE - Ollama AI Control</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        body { background: #f0f2f5; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px; }
        h1 { font-size: 24px; color: #1a1a2e; }
        .badge { background: #10b981; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
        .ai-badge { background: #8b5cf6; }
        .btn { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-weight: 500; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-outline { background: white; border: 1px solid #ddd; }
        .card { background: white; border-radius: 16px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .ai-card { background: linear-gradient(135deg, #667eea, #764ba2); color: white; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; border-radius: 12px; padding: 15px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .stat-label { font-size: 11px; color: #888; text-transform: uppercase; }
        .stat-value { font-size: 24px; font-weight: 700; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .positions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .position-card { background: #f8f9fa; border-radius: 12px; padding: 15px; }
        .position-title.long { color: #10b981; }
        .position-title.short { color: #ef4444; }
        .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
        .config-item { background: #f8f9fa; border-radius: 8px; padding: 10px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
        .update-time { font-size: 11px; color: #888; margin-top: 10px; }
        @media (max-width: 768px) { .positions-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>MARTINGALE DOGE <span class="badge">AI CONTROLLED</span><span class="badge ai-badge">OLLAMA</span></h1>
                <p style="color: #666; font-size: 13px; margin-top: 5px;">AI analyzes dashboard every 10 seconds to optimize profit & reduce spending</p>
            </div>
            <div>
                <button class="btn btn-outline" onclick="forceSync()">🔄 Force Sync</button>
                <button class="btn btn-danger" onclick="emergencyClose()">⚠️ Emergency Close</button>
            </div>
        </div>

        <div class="card ai-card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div><strong>🧠 OLLAMA AI ANALYZING EVERY 10 SECONDS</strong></div>
                <button class="btn" style="background: rgba(255,255,255,0.2); color: white;" onclick="refreshAI()">🔄 Force AI Analysis</button>
            </div>
            <div id="aiRecommendation" style="margin-top: 15px; font-size: 13px; white-space: pre-line;">Initializing AI...</div>
            <div id="aiTime" class="update-time" style="color: rgba(255,255,255,0.7);"></div>
        </div>

        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">TOTAL WALLET</div><div class="stat-value" id="totalWallet">$0.00</div><div id="walletChange" class="stat-label"></div></div>
            <div class="stat-card"><div class="stat-label">TOTAL P&L</div><div class="stat-value" id="totalPnl">$0.00</div><div id="pnlPercent" class="stat-label"></div></div>
            <div class="stat-card"><div class="stat-label">DRAWDOWN</div><div class="stat-value" id="drawdown">0%</div><div class="stat-label">Peak: <span id="peakEquity">$0.00</span></div></div>
            <div class="stat-card"><div class="stat-label">WIN RATE</div><div class="stat-value" id="winRate">0%</div><div class="stat-label">Trades: <span id="tradeCount">0</span></div></div>
            <div class="stat-card"><div class="stat-label">DAILY FEES</div><div class="stat-value" id="dailyFees">$0.00</div><div class="stat-label">Limit: $0.01</div></div>
            <div class="stat-card"><div class="stat-label">MARKET</div><div class="stat-value" id="spread">0.000%</div><div class="stat-label">BID: <span id="bidPrice">0</span></div></div>
        </div>

        <div class="positions-grid">
            <div class="position-card"><div class="position-title long">📈 LONG POSITION</div>
                <div><span class="stat-label">ROI:</span> <strong id="lRoi" class="positive">0%</strong></div>
                <div><span class="stat-label">PnL:</span> <strong id="lPnl">$0.00</strong></div>
                <div><span class="stat-label">Volume:</span> <span id="lVol">0</span> contracts</div>
                <div><span class="stat-label">DOGE:</span> <span id="lDoge">0</span></div>
                <div><span class="stat-label">Entry:</span> <span id="lEntry">0</span></div>
                <div><span class="stat-label">Target:</span> <span id="lTarget">0</span></div>
                <div><span class="stat-label">Status:</span> <span id="lAction">Idle</span></div>
            </div>
            <div class="position-card"><div class="position-title short">📉 SHORT POSITION</div>
                <div><span class="stat-label">ROI:</span> <strong id="sRoi" class="negative">0%</strong></div>
                <div><span class="stat-label">PnL:</span> <strong id="sPnl">$0.00</strong></div>
                <div><span class="stat-label">Volume:</span> <span id="sVol">0</span> contracts</div>
                <div><span class="stat-label">DOGE:</span> <span id="sDoge">0</span></div>
                <div><span class="stat-label">Entry:</span> <span id="sEntry">0</span></div>
                <div><span class="stat-label">Target:</span> <span id="sTarget">0</span></div>
                <div><span class="stat-label">Status:</span> <span id="sAction">Idle</span></div>
            </div>
        </div>

        <div class="card">
            <div class="stat-label">⚙️ AI CONTROLLED CONFIGURATION</div>
            <div class="config-grid" style="margin-top: 15px;">
                <div class="config-item"><div class="stat-label">LEVERAGE</div><strong id="cfgLeverage">${config.leverage}</strong>x</div>
                <div class="config-item"><div class="stat-label">TAKE PROFIT</div><strong id="cfgTP">${config.takeProfitPct}</strong>%</div>
                <div class="config-item"><div class="stat-label">BASE VOLUME</div><strong id="cfgVolume">${config.baseVolume}</strong></div>
                <div class="config-item"><div class="stat-label">MULTIPLIER</div><strong id="cfgMultiplier">${config.multiplier}</strong>x</div>
                <div class="config-item"><div class="stat-label">STEP TRIGGER</div>-<strong id="cfgStep">${config.stepDistancePct}</strong>%</div>
                <div class="config-item"><div class="stat-label">RISK</div><strong id="cfgRisk">${config.riskPercent}</strong>%</div>
                <div class="config-item"><div class="stat-label">MAX SPREAD</div><strong id="cfgSpread">${config.maxStartSpread}</strong>%</div>
                <div class="config-item"><div class="stat-label">AUTO-COMPOUND</div><strong id="cfgCompound">ON</strong></div>
            </div>
        </div>

        <div class="card">
            <div class="stat-label">📋 CLOSED TRADES</div>
            <div style="overflow-x: auto; margin-top: 15px;">
                <table><thead><tr><th>SIDE</th><th>TIME</th><th>VOL</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>PNL</th></tr></thead>
                <tbody id="tradesBody"><tr><td colspan="7" style="text-align: center;">No trades</td></tr></tbody></table>
            </div>
        </div>
    </div>

    <script>
        async function forceSync() { await fetch('/api/force-sync', {method: 'POST'}); }
        async function emergencyClose() { if(confirm('Close ALL positions?')) await fetch('/api/close', {method: 'POST'}); }
        async function refreshAI() { await fetch('/api/ai-refresh', {method: 'POST'}); }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalWallet').innerHTML = '$' + (data.market.totalEquity?.toFixed(4) || '0.00');
                document.getElementById('totalPnl').innerHTML = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + (data.market.totalNetGain?.toFixed(4) || '0.00');
                document.getElementById('drawdown').innerHTML = (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('peakEquity').innerHTML = '$' + (data.market.peakEquity?.toFixed(4) || '0.00');
                document.getElementById('winRate').innerHTML = (data.market.winRate || 0) + '%';
                document.getElementById('tradeCount').innerHTML = data.market.totalTrades || 0;
                document.getElementById('dailyFees').innerHTML = '$' + (data.market.dailyFees?.toFixed(6) || '0.00');
                document.getElementById('spread').innerHTML = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('bidPrice').innerHTML = (data.market.bid || 0).toFixed(6);
                
                if (data.market.aiRecommendation) {
                    document.getElementById('aiRecommendation').innerHTML = data.market.aiRecommendation.text.replace(/\\n/g, '<br>');
                    document.getElementById('aiTime').innerHTML = 'Last analysis: ' + data.market.aiRecommendation.time;
                }
                
                const long = data.accounts?.[0];
                const short = data.accounts?.[1];
                
                if (long) {
                    document.getElementById('lRoi').innerHTML = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + '$' + (long.unrealizedUsdt?.toFixed(4) || '0.00');
                    document.getElementById('lVol').innerHTML = long.volume || 0;
                    document.getElementById('lDoge').innerHTML = long.dogeAmount || 0;
                    document.getElementById('lEntry').innerHTML = long.entryPrice?.toFixed(8) || '0';
                    document.getElementById('lTarget').innerHTML = long.targetPrice?.toFixed(8) || '0';
                    document.getElementById('lAction').innerHTML = long.lastAction || 'Idle';
                    document.getElementById('lRoi').className = long.roi >= 0 ? 'positive' : 'negative';
                }
                if (short) {
                    document.getElementById('sRoi').innerHTML = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + '$' + (short.unrealizedUsdt?.toFixed(4) || '0.00');
                    document.getElementById('sVol').innerHTML = short.volume || 0;
                    document.getElementById('sDoge').innerHTML = short.dogeAmount || 0;
                    document.getElementById('sEntry').innerHTML = short.entryPrice?.toFixed(8) || '0';
                    document.getElementById('sTarget').innerHTML = short.targetPrice?.toFixed(8) || '0';
                    document.getElementById('sAction').innerHTML = short.lastAction || 'Idle';
                    document.getElementById('sRoi').className = short.roi >= 0 ? 'positive' : 'negative';
                }
                
                if (data.market.currentConfig) {
                    document.getElementById('cfgLeverage').innerHTML = data.market.currentConfig.leverage;
                    document.getElementById('cfgTP').innerHTML = data.market.currentConfig.takeProfitPct;
                    document.getElementById('cfgVolume').innerHTML = data.market.currentConfig.baseVolume;
                    document.getElementById('cfgMultiplier').innerHTML = data.market.currentConfig.multiplier;
                    document.getElementById('cfgStep').innerHTML = data.market.currentConfig.stepDistancePct;
                    document.getElementById('cfgRisk').innerHTML = data.market.currentConfig.riskPercent;
                    document.getElementById('cfgSpread').innerHTML = data.market.currentConfig.maxStartSpread;
                }
                
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 10).forEach(t => {
                        tradesHtml += `<tr><td class="${t.side === 'LONG' ? 'positive' : 'negative'}">${t.side}</td>
                        <td>${t.closeTime?.split(',')[1] || ''}</td>
                        <td>${t.volume}</td><td>${t.entryPrice}</td><td>${t.exitPrice}</td>
                        <td class="${parseFloat(t.roi) >= 0 ? 'positive' : 'negative'}">${t.roi}</td>
                        <td class="${parseFloat(t.pnl) >= 0 ? 'positive' : 'negative'}">$${t.pnl}</td></tr>`;
                    });
                } else {
                    tradesHtml = '<tr><td colspan="7" style="text-align: center;">No trades</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
            } catch(e) { console.error(e); }
        }, 2000);
    </script>
</body>
</html>`;
    res.send(html);
});

// ==================== START BOT ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale DOGE Bot Started`);
    console.log(`🎯 Leverage: ${config.leverage}x = ${config.takeProfitPct}% TP`);
    console.log(`🤖 Ollama AI analyzes dashboard EVERY 10 SECONDS`);
    console.log(`💰 Goal: Maximize profit & reduce spending/fees`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
