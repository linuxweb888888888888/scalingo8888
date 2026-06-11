require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const { spawn } = require('child_process');

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

// Dynamic config that AI can modify
let config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 75,  // This is the ACTUAL leverage used on exchange
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 10,
    takeProfitPct: 15,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.1,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 0.25,
    dogePerContract: 100,
    stepCooldownMs: 10 * 60 * 1000,
    aiEnabled: true,
    ollamaModel: 'llama3.2:3b',
    aiControlInterval: 60000,
    lastAIConfigUpdate: 0,
    
    // HTX DOGE OPTIMAL PARAMETERS
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
    minRiskPercent: 0.1,
    maxRiskPercent: 5,
    optimalSpreadPct: 0.05,
    maxAllowedSpread: 0.2
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
    exchangeLeverage: parseInt(process.env.LEVERAGE) || 75  // Track actual exchange leverage
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let lastStepTime = {};

// ==================== UPDATE LEVERAGE ON EXCHANGE ====================
async function updateExchangeLeverage(account, newLeverage) {
    try {
        console.log(`🔄 Updating leverage on HTX to ${newLeverage}x for account ${account.accountId}...`);
        
        const res = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_level_switch', {
            contract_code: config.symbol,
            lever_rate: newLeverage
        });
        
        if (res?.status === 'ok') {
            console.log(`✅ Leverage successfully updated to ${newLeverage}x on exchange`);
            market.exchangeLeverage = newLeverage;
            return true;
        } else {
            console.error(`❌ Failed to update leverage:`, res);
            return false;
        }
    } catch (error) {
        console.error(`❌ Error updating leverage:`, error.message);
        return false;
    }
}

// ==================== CHECK OLLAMA ====================
async function checkOllama() {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        await execPromise('ollama list');
        market.ollamaAvailable = true;
        console.log('✅ Ollama is running and available');
        return true;
    } catch (error) {
        market.ollamaAvailable = false;
        console.log('⚠️ Ollama not detected. AI will use local intelligent mode.');
        return false;
    }
}

// ==================== LOCAL INTELLIGENT AI CONTROLLER ====================
async function localAIController() {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const drawdownPercent = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100) : 0;
    const winRate = market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100) : 0;
    const volatility = market.dogeVolatility || 2;
    
    let newLeverage = config.leverage;
    let newRiskPercent = config.riskPercent;
    let newBaseVolume = config.baseVolume;
    let reason = '';
    
    // Intelligent leverage adjustment based on conditions
    if (drawdownPercent > 30) {
        newLeverage = 10;
        reason = `Critical drawdown (${drawdownPercent.toFixed(1)}%) - reducing to minimum leverage 10x`;
    } else if (drawdownPercent > 20) {
        newLeverage = 25;
        reason = `High drawdown (${drawdownPercent.toFixed(1)}%) - reducing leverage to 25x`;
    } else if (drawdownPercent > 10) {
        newLeverage = 50;
        reason = `Moderate drawdown (${drawdownPercent.toFixed(1)}%) - reducing leverage to 50x`;
    } else if (volatility > 5) {
        newLeverage = 25;
        reason = `High volatility (${volatility.toFixed(1)}%) - reducing leverage to 25x`;
    } else if (volatility > 3) {
        newLeverage = 50;
        reason = `Elevated volatility (${volatility.toFixed(1)}%) - using 50x leverage`;
    } else if (market.spread > 0.15) {
        newLeverage = 25;
        reason = `Wide spread (${market.spread.toFixed(2)}%) - reducing leverage to 25x`;
    } else if (winRate > 70 && market.totalTrades > 10) {
        newLeverage = 75;
        reason = `Excellent win rate (${winRate.toFixed(0)}%) - using maximum leverage 75x`;
    } else if (totalEquity > market.initialTotalEquity && market.totalTrades > 5) {
        newLeverage = 75;
        reason = `Profitable strategy (${market.growthPct.toFixed(1)}% gain) - using 75x leverage`;
    } else {
        newLeverage = 50;
        reason = `Standard market conditions - using 50x leverage`;
    }
    
    // Adjust risk percent based on win rate and drawdown
    if (drawdownPercent > 25) {
        newRiskPercent = 0.15;
    } else if (drawdownPercent > 15) {
        newRiskPercent = 0.2;
    } else if (winRate > 70 && market.totalTrades > 10) {
        newRiskPercent = Math.min(0.5, config.riskPercent + 0.1);
    } else if (winRate > 50 && market.totalTrades > 5) {
        newRiskPercent = config.riskPercent;
    } else {
        newRiskPercent = 0.25;
    }
    
    // Adjust base volume
    if (drawdownPercent > 25) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.5);
    } else if (drawdownPercent > 15) {
        newBaseVolume = Math.max(1, config.baseVolume * 0.7);
    } else if (winRate > 70) {
        newBaseVolume = Math.min(10, config.baseVolume * 1.2);
    } else {
        newBaseVolume = config.baseVolume;
    }
    
    newBaseVolume = Math.floor(Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, newBaseVolume)));
    newRiskPercent = Math.min(config.maxRiskPercent, Math.max(config.minRiskPercent, newRiskPercent));
    
    const newTakeProfit = config.leverageTPMapping[newLeverage];
    const priceMove = (newTakeProfit / newLeverage).toFixed(3);
    
    let changes = [];
    let leverageUpdated = false;
    
    // Update leverage on exchange if changed
    if (newLeverage !== config.leverage) {
        console.log(`\n🔧 AI wants to change leverage from ${config.leverage}x to ${newLeverage}x`);
        console.log(`📡 Sending update to HTX exchange...`);
        
        // Update leverage for each account
        let allSuccess = true;
        for (const acc of config.accounts) {
            const success = await updateExchangeLeverage(acc, newLeverage);
            if (!success) allSuccess = false;
        }
        
        if (allSuccess) {
            changes.push(`Leverage: ${config.leverage}x → ${newLeverage}x (TP: ${newTakeProfit}%, move: ${priceMove}%)`);
            config.leverage = newLeverage;
            config.takeProfitPct = newTakeProfit;
            leverageUpdated = true;
            
            // Update target prices for active positions
            for (const acc of config.accounts) {
                const state = accountStates[acc.accountId];
                if (state.volume > 0 && state.entryPrice > 0) {
                    state.targetPrice = calculateTargetPrice(state);
                    console.log(`🔄 Updated ${state.direction} TP to ${state.targetPrice.toFixed(8)}`);
                }
            }
        } else {
            console.log(`⚠️ Failed to update leverage on exchange, keeping current ${config.leverage}x`);
        }
    }
    
    if (newRiskPercent !== config.riskPercent) {
        changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}%`);
        config.riskPercent = newRiskPercent;
    }
    
    if (newBaseVolume !== config.baseVolume) {
        changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume}`);
        config.baseVolume = newBaseVolume;
        if (!config.autoCompound) {
            market.currentBaseVolume = newBaseVolume;
        }
    }
    
    if (changes.length > 0) {
        console.log(`\n🔧 LOCAL AI CONTROLLER CHANGES:`);
        changes.forEach(c => console.log(`   ${c}`));
        console.log(`   Reason: ${reason}`);
        
        market.aiConfigChanges.unshift({
            timestamp: Date.now(),
            time: new Date().toLocaleString(),
            changes: changes,
            reason: reason,
            type: 'local',
            exchangeLeverage: config.leverage
        });
        if (market.aiConfigChanges.length > 20) market.aiConfigChanges.pop();
    }
    
    const recommendationText = `🧠 LOCAL AI CONTROLLER ACTIVE\n\n📊 Current Exchange Settings:\n• Leverage: ${config.leverage}x (TP: ${config.takeProfitPct}%)\n• Required Price Move: ${priceMove}%\n• Risk: ${config.riskPercent}% | Volume: ${config.baseVolume}\n\n${changes.length > 0 ? '✅ Changes Made:\n' + changes.map(c => '• ' + c).join('\n') : '⚙️ Settings optimized'}\n\n📈 Reason: ${reason}`;
    
    market.aiRecommendation = {
        text: recommendationText,
        timestamp: Date.now(),
        time: new Date().toLocaleString(),
        type: 'local',
        configSnapshot: {
            leverage: config.leverage,
            takeProfitPct: config.takeProfitPct,
            riskPercent: config.riskPercent,
            baseVolume: config.baseVolume
        }
    };
    
    return true;
}

// ==================== OLLAMA AI CONTROLLER ====================
async function ollamaAIController() {
    try {
        const s1 = accountStates[1];
        const s2 = accountStates[2];
        const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
        const drawdownPercent = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100).toFixed(2) : 0;
        const winRate = market.totalTrades > 0 ? ((market.winningTrades / market.totalTrades) * 100).toFixed(1) : 0;
        const volatility = market.dogeVolatility || 2;
        
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        
        const prompt = `Analyze this DOGE trading data and output NEW CONFIGURATION values ONLY:

DATA:
Wallet: $${totalEquity.toFixed(4)} (${market.growthPct.toFixed(1)}% P&L)
Drawdown: ${drawdownPercent}%
Win Rate: ${winRate}% (${market.totalTrades} trades)
Spread: ${market.spread.toFixed(3)}%
Volatility: ${volatility.toFixed(1)}%
LONG ROI: ${s1?.roi || 0}% | SHORT ROI: ${s2?.roi || 0}%

HTX DOGE RULES:
- Leverage MUST be: 75, 50, 25, or 10
- 75x = 15% TP, 50x = 10% TP, 25x = 5% TP, 10x = 1.5% TP
- Risk percent between 0.1-5%
- Base volume between 1-10000

Output EXACTLY this format:
LEVERAGE: [75/50/25/10]
RISK_PERCENT: [number]
BASE_VOLUME: [number]

No explanation, just values.`;

        const { stdout } = await execPromise(`ollama run ${config.ollamaModel} "${prompt.replace(/"/g, '\\"')}"`, { timeout: 30000 });
        
        console.log('🤖 Ollama Response:', stdout);
        
        let newLeverage = config.leverage;
        let newRiskPercent = config.riskPercent;
        let newBaseVolume = config.baseVolume;
        
        const leverageMatch = stdout.match(/LEVERAGE:\s*(\d+)/i);
        if (leverageMatch) {
            const suggested = parseInt(leverageMatch[1]);
            if (config.allowedLeverages.includes(suggested)) {
                newLeverage = suggested;
            }
        }
        
        const riskMatch = stdout.match(/RISK_PERCENT:\s*(\d+(?:\.\d+)?)/i);
        if (riskMatch) {
            newRiskPercent = Math.min(config.maxRiskPercent, Math.max(config.minRiskPercent, parseFloat(riskMatch[1])));
        }
        
        const volumeMatch = stdout.match(/BASE_VOLUME:\s*(\d+)/i);
        if (volumeMatch) {
            newBaseVolume = Math.min(config.maxBaseVolume, Math.max(config.minBaseVolume, parseInt(volumeMatch[1])));
        }
        
        const newTakeProfit = config.leverageTPMapping[newLeverage];
        const priceMove = (newTakeProfit / newLeverage).toFixed(3);
        
        let changes = [];
        
        // Update leverage on exchange if changed
        if (newLeverage !== config.leverage) {
            console.log(`\n🔧 Ollama AI wants to change leverage from ${config.leverage}x to ${newLeverage}x`);
            console.log(`📡 Sending update to HTX exchange...`);
            
            let allSuccess = true;
            for (const acc of config.accounts) {
                const success = await updateExchangeLeverage(acc, newLeverage);
                if (!success) allSuccess = false;
            }
            
            if (allSuccess) {
                changes.push(`Leverage: ${config.leverage}x → ${newLeverage}x (TP: ${newTakeProfit}%)`);
                config.leverage = newLeverage;
                config.takeProfitPct = newTakeProfit;
                
                for (const acc of config.accounts) {
                    const state = accountStates[acc.accountId];
                    if (state.volume > 0 && state.entryPrice > 0) {
                        state.targetPrice = calculateTargetPrice(state);
                    }
                }
            } else {
                console.log(`⚠️ Failed to update leverage on exchange, keeping current ${config.leverage}x`);
            }
        }
        
        if (newRiskPercent !== config.riskPercent) {
            changes.push(`Risk: ${config.riskPercent}% → ${newRiskPercent}%`);
            config.riskPercent = newRiskPercent;
        }
        
        if (newBaseVolume !== config.baseVolume) {
            changes.push(`Base Volume: ${config.baseVolume} → ${newBaseVolume}`);
            config.baseVolume = newBaseVolume;
            if (!config.autoCompound) {
                market.currentBaseVolume = newBaseVolume;
            }
        }
        
        if (changes.length > 0) {
            console.log(`\n🔧 OLLAMA AI CONTROLLER CHANGES:`);
            changes.forEach(c => console.log(`   ${c}`));
            
            market.aiConfigChanges.unshift({
                timestamp: Date.now(),
                time: new Date().toLocaleString(),
                changes: changes,
                type: 'ollama',
                exchangeLeverage: config.leverage
            });
            if (market.aiConfigChanges.length > 20) market.aiConfigChanges.pop();
        }
        
        const recommendationText = `🧠 OLLAMA AI CONTROLLER ACTIVE\n\n📊 Current Exchange Settings:\n• Leverage: ${config.leverage}x (TP: ${config.takeProfitPct}%)\n• Required Price Move: ${priceMove}%\n• Risk: ${config.riskPercent}% | Volume: ${config.baseVolume}\n\n${changes.length > 0 ? '✅ Changes Made:\n' + changes.map(c => '• ' + c).join('\n') : '⚙️ Settings optimized'}\n\n📈 Market: Spread ${market.spread.toFixed(3)}% | Volatility ${volatility.toFixed(1)}%`;
        
        market.aiRecommendation = {
            text: recommendationText,
            timestamp: Date.now(),
            time: new Date().toLocaleString(),
            type: 'ollama',
            configSnapshot: {
                leverage: config.leverage,
                takeProfitPct: config.takeProfitPct,
                riskPercent: config.riskPercent,
                baseVolume: config.baseVolume
            }
        };
        
        return true;
        
    } catch (error) {
        console.log('⚠️ Ollama error:', error.message);
        return false;
    }
}

// ==================== MAIN AI CONTROLLER ====================
async function aiController() {
    if (!config.aiEnabled) return;
    
    console.log('\n🤖 AI CONTROLLER running...');
    console.log(`   Current exchange leverage: ${config.leverage}x`);
    console.log(`   Current TP: ${config.takeProfitPct}%`);
    
    calculateDogeVolatility();
    
    let success = false;
    if (market.ollamaAvailable) {
        success = await ollamaAIController();
    }
    
    if (!success) {
        await localAIController();
    }
    
    market.aiLastUpdate = Date.now();
    config.lastAIConfigUpdate = Date.now();
}

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    let volume = Math.floor(riskAmount / 0.005);
    volume = Math.max(config.minBaseVolume, Math.min(config.maxBaseVolume, volume));
    
    if (market.spread > config.optimalSpreadPct * 2) {
        volume = Math.floor(volume * 0.7);
    } else if (market.spread > config.optimalSpreadPct) {
        volume = Math.floor(volume * 0.85);
    }
    
    const leverageFactor = 75 / config.leverage;
    volume = Math.floor(volume * Math.min(1.5, Math.max(0.5, leverageFactor)));
    volume = Math.max(config.minBaseVolume, volume);
    
    const dogeAmountTotal = volume * config.dogePerContract;
    market.currentRiskAmount = riskAmount;
    market.currentBaseDoge = dogeAmountTotal;
    
    console.log(`\n💰 AUTO-COMPOUNDING: ${volume} contracts = ${dogeAmountTotal.toLocaleString()} DOGE (${config.leverage}x leverage)`);
    
    return volume;
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

function calculateVolumeForStep(step, baseVolume, multiplier) {
    let totalVolume = 0;
    for (let i = 0; i <= step; i++) {
        const stepVolume = i === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, i));
        totalVolume += stepVolume;
    }
    return totalVolume;
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

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
    
    const lastRecord = market.walletHistory[market.walletHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000 || Math.abs(lastRecord.equity - totalEquity) > 0.000001) {
        market.walletHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            equity: totalEquity,
            pnl: totalEquity - market.initialTotalEquity,
            pnlPercent: market.initialTotalEquity > 0 ? ((totalEquity - market.initialTotalEquity) / market.initialTotalEquity) * 100 : 0,
            baseVolume: market.currentBaseVolume,
            baseDoge: market.currentBaseDoge,
            riskAmount: market.currentRiskAmount,
            configSnapshot: {
                leverage: config.leverage,
                takeProfitPct: config.takeProfitPct,
                riskPercent: config.riskPercent
            }
        });
        
        if (market.walletHistory.length > 100) market.walletHistory.shift();
    }
    
    if (totalEquity > market.peakEquity) {
        market.peakEquity = totalEquity;
    }
    
    if (market.peakEquity > 0) {
        const currentDrawdown = ((market.peakEquity - totalEquity) / market.peakEquity) * 100;
        if (currentDrawdown > market.maxDrawdown) {
            market.maxDrawdown = currentDrawdown;
        }
    }
}

function calculateDogeVolatility() {
    if (market.walletHistory.length < 10) return 2;
    
    let returns = [];
    for (let i = 1; i < Math.min(20, market.walletHistory.length); i++) {
        const prev = market.walletHistory[i-1].equity;
        const curr = market.walletHistory[i].equity;
        if (prev > 0) {
            returns.push(Math.abs((curr - prev) / prev) * 100);
        }
    }
    
    if (returns.length === 0) return 2;
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    market.dogeVolatility = avgReturn;
    return avgReturn;
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
        roiLatencyMs: 0,
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
        const { timestamp, signature, sortedParams } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        
        const options = {
            method,
            url,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 5000
        };
        
        if (method === 'POST') {
            options.data = data;
        }
        
        const res = await axios(options);
        return res.data;
    } catch (e) {
        console.error(`API Error: ${e.message}`);
        return { status: 'error', msg: e.message };
    }
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

    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) {
        return;
    }
    lastPositionFetch[acc.accountId] = now;

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', {
        contract_code: config.symbol
    });

    if (posRes?.status === 'ok' && posRes.data) {
        const positions = posRes.data;
        const pos = positions.find(p => p.direction === state.direction);
        
        if (pos && parseFloat(pos.volume) > 0) {
            const newVolume = parseFloat(pos.volume);
            const newEntryPrice = parseFloat(pos.cost_open);
            const rawProfitRate = parseFloat(pos.profit_rate);
            const newExchangeRoi = rawProfitRate * 100;
            const newUnrealizedUsdt = parseFloat(pos.profit);
            
            state.volume = newVolume;
            state.entryPrice = newEntryPrice;
            state.unrealizedUsdt = newUnrealizedUsdt;
            
            const calculatedStep = calculateStepFromVolume(newVolume, market.currentBaseVolume, config.multiplier);
            
            if (Math.abs(newExchangeRoi - state.roi) > 0.01) {
                const timeSinceLastUpdate = now - state.lastRoiUpdateTime;
                
                state.roiLatencyMs = timeSinceLastUpdate;
                state.roiLatencyHistory.unshift({
                    timestamp: now,
                    exchangeRoi: newExchangeRoi,
                    botRoi: state.roi,
                    latencyMs: timeSinceLastUpdate,
                    difference: Math.abs(newExchangeRoi - state.roi).toFixed(2),
                    volume: newVolume,
                    step: calculatedStep
                });
                
                if (state.roiLatencyHistory.length > 10) state.roiLatencyHistory.pop();
                
                console.log(`[${state.direction.toUpperCase()}] ROI: ${newExchangeRoi.toFixed(2)}% | Vol: ${newVolume}`);
                
                state.roi = newExchangeRoi;
                state.lastExchangeRoi = newExchangeRoi;
                state.lastRoiUpdateTime = now;
            }
            
            state.targetPrice = calculateTargetPrice(state);
            
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else {
            if (state.volume !== 0) {
                console.log(`✅ [${state.direction.toUpperCase()}] Position closed`);
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.lastExchangeRoi = 0;
                state.targetPrice = 0;
            }
        }
    }

    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) {
        return;
    }
    lastBalanceFetch[acc.accountId] = now;

    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', {
        margin_asset: 'USDT'
    });

    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const oldEquity = state.currentEquity;
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        
        if (state.initialEquity === null) {
            state.initialEquity = state.currentEquity;
        }
        
        if (oldEquity > 0 && Math.abs(state.currentEquity - oldEquity) > 0.000001) {
            const change = state.currentEquity - oldEquity;
            if (Math.abs(change) > 0.0001) {
                console.log(`[${state.direction.toUpperCase()}] Equity: $${oldEquity.toFixed(8)} → $${state.currentEquity.toFixed(8)}`);
            }
        }
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    const estimatedFee = Math.abs(finalPnl) * config.takerFeeRate;
    
    market.totalTrades++;
    if (finalPnl >= 0) {
        market.winningTrades++;
    } else {
        market.losingTrades++;
    }
    market.totalFeesPaid += estimatedFee;
    
    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        step: step,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8),
        estimatedFee: estimatedFee.toFixed(8),
        configAtTrade: {
            leverage: config.leverage,
            takeProfitPct: config.takeProfitPct,
            riskPercent: config.riskPercent
        }
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
    
    console.log(`📊 TRADE CLOSED: ${state.direction.toUpperCase()} | ROI: ${finalRoi.toFixed(2)}% | PnL: ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(8)}`);
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
                if (msg.tick && msg.ch && msg.ch.includes('bbo')) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                    market.lastPriceUpdate = Date.now();
                }
                if (msg.ping) {
                    ws.send(JSON.stringify({ pong: msg.ping }));
                }
            } catch (e) {}
        });
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
    
    ws.on('close', () => {
        console.log('WebSocket disconnected, reconnecting in 5s...');
        setTimeout(startWS, 5000);
    });
}

async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (currentPrice === 0) continue;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread && market.spread > 0) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}% > ${config.maxStartSpread}%)`;
                continue;
            }
            
            console.log(`🚀 Opening ${state.direction} position at ${currentPrice.toFixed(8)} with ${market.currentBaseVolume} contract(s) at ${config.leverage}x leverage`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: market.currentBaseVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,  // USING CURRENT CONFIG LEVERAGE
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Position Opening";
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Position opened at ${state.entryPrice.toFixed(8)} with ${config.leverage}x leverage, TP: ${state.targetPrice.toFixed(8)} (${config.takeProfitPct}%)`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
                state.lastAction = "Open Failed";
                console.error(`Open order failed:`, res);
            }
            continue;
        }

        let shouldTakeProfit = false;
        let exitPrice = 0;
        
        if (state.direction === 'buy') {
            if (market.ask >= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.ask;
                console.log(`🎯 LONG TP triggered! Target: ${config.takeProfitPct}% @ ${config.leverage}x`);
            }
        } else {
            if (market.bid <= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.bid;
                console.log(`🎯 SHORT TP triggered! Target: ${config.takeProfitPct}% @ ${config.leverage}x`);
            }
        }
        
        if (shouldTakeProfit) {
            const finalRoi = config.takeProfitPct;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            
            console.log(`✅ Taking ${state.direction} profit (${finalRoi}% ROI)`);
            state.isLocked = true;
            state.lastAction = "Taking Profit...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,  // USING CURRENT CONFIG LEVERAGE
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl);
                
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.targetPrice = 0;
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
                console.error(`Take profit failed:`, res);
            }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const now = Date.now();
        const timeSinceLastStep = now - (lastStepTime[acc.accountId] || 0);
        
        if (state.roi <= -config.stepDistancePct && state.volume > 0 && timeSinceLastStep >= config.stepCooldownMs) {
            const nextStepNumber = currentStep + 1;
            let nextVol;
            
            if (nextStepNumber === 1) {
                nextVol = Math.ceil(market.currentBaseVolume * config.multiplier);
            } else {
                nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            }
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} - ROI: ${state.roi.toFixed(2)}% | Adding: ${nextVol} contracts at ${config.leverage}x`);
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: nextVol,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,  // USING CURRENT CONFIG LEVERAGE
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${nextStepNumber}`;
                lastStepTime[acc.accountId] = now;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        } else {
            state.lastAction = `Active - Step ${currentStep} | ROI: ${state.roi.toFixed(2)}% | ${config.leverage}x TP: ${config.takeProfitPct}%`;
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) {
            await fetchPriceRest();
        }
        
        for (const acc of config.accounts) {
            await syncAccount(acc, accountStates[acc.accountId]);
        }
        
        const s1 = accountStates[1];
        const s2 = accountStates[2];
        
        if (s1 && s2) {
            if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
                market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                market.peakEquity = market.initialTotalEquity;
                console.log(`\n💰 INITIAL TOTAL EQUITY: $${market.initialTotalEquity.toFixed(8)} USDT\n`);
            }
            
            if (market.initialTotalEquity > 0) {
                const totalEquity = s1.currentEquity + s2.currentEquity;
                
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedHours = (Date.now() - market.startTime) / (1000 * 60 * 60);
                market.dgr = elapsedHours > 0 ? (market.growthPct / elapsedHours) : 0;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        console.log(`📈 AUTO-COMPOUND: ${market.currentBaseVolume} → ${newBaseVolume} contracts`);
                        market.currentBaseVolume = newBaseVolume;
                        market.lastBaseUpdate = Date.now();
                    }
                }
                
                updateWalletGrowth(totalEquity);
            }
        }
        
        if (market.status === 'Active') {
            await processMartingale();
        }
        
        // Run AI controller every 60 seconds
        if (config.aiEnabled && (!config.lastAIConfigUpdate || (Date.now() - config.lastAIConfigUpdate) > config.aiControlInterval)) {
            await aiController();
        }
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const totalRealizedPnl = (s1?.realizedPnl || 0) + (s2?.realizedPnl || 0);
    const totalFees = (s1?.totalFees || 0) + (s2?.totalFees || 0);
    
    const accountsWithInfo = Object.values(accountStates).map(state => {
        const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
        
        return {
            direction: state.direction,
            roi: state.roi,
            volume: state.volume,
            dogeAmount: state.volume * config.dogePerContract,
            step: step,
            unrealizedUsdt: state.unrealizedUsdt,
            entryPrice: state.entryPrice,
            lastAction: state.lastAction,
            startTime: state.startTime,
            targetPrice: state.targetPrice,
            requiredPriceMoveForTP: `${requiredPriceMovePct}%`,
            currentEquity: state.currentEquity,
            initialEquity: state.initialEquity,
            realizedPnl: state.realizedPnl,
            totalFees: state.totalFees
        };
    });
    
    res.json({
        market: {
            ...market,
            totalEquity: totalEquity,
            totalRealizedPnl: totalRealizedPnl,
            totalFeesPaid: totalFees,
            totalNetGain: market.totalNetGain,
            growthPct: market.growthPct,
            dgr: market.dgr,
            peakEquity: market.peakEquity,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winningTrades: market.winningTrades,
            losingTrades: market.losingTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            walletHistory: market.walletHistory.slice(-20),
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            currentBaseVolume: market.currentBaseVolume,
            currentBaseDoge: market.currentBaseDoge,
            currentRiskAmount: market.currentRiskAmount,
            dogePerContract: config.dogePerContract,
            aiRecommendation: market.aiRecommendation,
            aiEnabled: config.aiEnabled,
            ollamaAvailable: market.ollamaAvailable,
            currentConfig: {
                leverage: config.leverage,
                takeProfitPct: config.takeProfitPct,
                requiredPriceMove: (config.takeProfitPct / config.leverage).toFixed(3) + '%',
                riskPercent: config.riskPercent,
                baseVolume: config.baseVolume,
                multiplier: config.multiplier,
                stepDistancePct: config.stepDistancePct
            }
        },
        accounts: accountsWithInfo,
        tradeHistory: tradeHistory.slice(0, 20)
    });
});

app.post('/api/close', async (req, res) => {
    console.log("🔴 EMERGENCY CLOSE INITIATED");
    market.status = "LIQUIDATING";
    
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            console.log(`Closing ${s.direction} position...`);
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: s.volume,
                direction: s.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
        }
    }
    
    setTimeout(() => market.status = "Active", 5000);
    res.json({ status: 'ok' });
});

app.post('/api/force-sync', async (req, res) => {
    console.log("🔄 Force syncing all positions...");
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        await syncAccount(acc, state);
    }
    res.json({ status: 'ok' });
});

app.post('/api/ai-refresh', async (req, res) => {
    await aiController();
    res.json({ recommendation: market.aiRecommendation });
});

app.post('/api/set-leverage', async (req, res) => {
    const { leverage } = req.body;
    if (!config.allowedLeverages.includes(leverage)) {
        return res.json({ error: `Leverage must be one of: ${config.allowedLeverages.join(', ')}` });
    }
    
    console.log(`🔧 Manual leverage change request to ${leverage}x`);
    
    let allSuccess = true;
    for (const acc of config.accounts) {
        const success = await updateExchangeLeverage(acc, leverage);
        if (!success) allSuccess = false;
    }
    
    if (allSuccess) {
        config.leverage = leverage;
        config.takeProfitPct = config.leverageTPMapping[leverage];
        
        for (const acc of config.accounts) {
            const state = accountStates[acc.accountId];
            if (state.volume > 0 && state.entryPrice > 0) {
                state.targetPrice = calculateTargetPrice(state);
            }
        }
        
        res.json({ status: 'ok', leverage: config.leverage, takeProfit: config.takeProfitPct });
    } else {
        res.json({ error: 'Failed to update leverage on exchange' });
    }
});

app.get('/api/wallet-history', (req, res) => {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    
    res.json({
        currentWallet: {
            totalEquity: (s1?.currentEquity || 0) + (s2?.currentEquity || 0),
            totalRealizedPnl: (s1?.realizedPnl || 0) + (s2?.realizedPnl || 0),
            totalFees: (s1?.totalFees || 0) + (s2?.totalFees || 0),
            growthPct: market.growthPct,
            peakEquity: market.peakEquity,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0
        },
        history: market.walletHistory,
        trades: tradeHistory.slice(0, 20)
    });
});

// HTML Dashboard
app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - AI Controlled DOGE Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #F3BA2F40; }
        .ai-card { background: linear-gradient(135deg, #1E1B4B 0%, #131824 100%); border: 1px solid #6366F1; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .ai-text { font-size: 13px; line-height: 1.5; color: #C4B5FD; white-space: pre-line; }
        .refresh-ai { background: #6366F120; border-color: #6366F1; color: #6366F1; font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; }
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
        button:hover { background: #FF4D6D40; }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
        .tp-badge { background: #00D1B220; color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 10px; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .leverage-select { background: #1F2A3E; border: 1px solid #6366F1; color: white; padding: 4px 8px; border-radius: 6px; margin-left: 10px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-amber-500">DOGE</span> <span class="text-xs bg-indigo-500/20 px-2 py-1 rounded">AI CONTROLLED</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="tp-badge">🎯 EXCHANGE: ${config.leverage}x = ${config.takeProfitPct}% TP (${requiredPriceMovePct}% move)</span>
                    <select id="leverageSelect" class="leverage-select" onchange="setLeverage(this.value)">
                        <option value="75" ${config.leverage === 75 ? 'selected' : ''}>75x (15% TP)</option>
                        <option value="50" ${config.leverage === 50 ? 'selected' : ''}>50x (10% TP)</option>
                        <option value="25" ${config.leverage === 25 ? 'selected' : ''}>25x (5% TP)</option>
                        <option value="10" ${config.leverage === 10 ? 'selected' : ''}>10x (1.5% TP)</option>
                    </select>
                </div>
            </div>
            <div>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <!-- AI CONTROLLER CARD -->
        <div class="ai-card mb-6">
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center gap-2">
                    <span class="text-xl">🧠</span>
                    <h3 class="font-bold text-indigo-400">AI Controller Active</h3>
                    <span class="text-[9px] bg-indigo-500/30 px-2 py-0.5 rounded" id="aiTypeBadge">CONFIGURES EXCHANGE LEVERAGE</span>
                </div>
                <button onclick="refreshAI()" class="refresh-ai rounded">🔄 Force AI Reconfig</button>
            </div>
            <div id="aiRecommendation" class="ai-text">
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
                    <span>AI Controller initializing...</span>
                </div>
            </div>
            <div id="aiTimestamp" class="text-[9px] text-slate-500 mt-2"></div>
        </div>

        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
                <div><p class="stat-label">TOTAL WALLET</p><p id="totalWallet" class="stat-number">$0.00</p><p id="walletChange" class="text-xs"></p></div>
                <div><p class="stat-label">TOTAL P&L</p><p id="totalPnl" class="stat-number">$0.00</p><p id="pnlPercent" class="text-xs"></p></div>
                <div><p class="stat-label">REALIZED P&L</p><p id="realizedPnl" class="stat-number">$0.00</p><p id="feesPaid" class="text-xs">Fees: $0.00</p></div>
                <div><p class="stat-label">PERFORMANCE</p><p id="peakEquity" class="text-sm">Peak: $0.00</p><p id="maxDrawdown" class="text-sm text-red-400">DD: 0%</p></div>
                <div><p class="stat-label">STATISTICS</p><p id="tradeStats" class="text-sm">Trades: 0</p><p id="winRate" class="text-sm text-green-400">Win Rate: 0%</p></div>
            </div>
            <div class="mt-4 pt-4 border-t border-slate-700/50">
                <div class="flex justify-between">
                    <div><p class="text-xs text-slate-400">📈 AUTO-COMPOUNDING</p><p id="baseVolumeDisplay" class="text-sm font-bold text-green-400">Volume: 0 contracts</p></div>
                    <div><p class="text-xs text-slate-400">Risk Amount</p><p id="riskAmount" class="text-sm font-bold">$0.00</p></div>
                    <div><p class="text-xs text-slate-400">Exchange Leverage</p><p id="exchangeLeverage" class="text-sm font-bold text-indigo-400">${config.leverage}x</p></div>
                </div>
            </div>
        </div>

        <div class="card mb-8"><h3 class="font-bold mb-4">📈 WALLET GROWTH CHART</h3><div class="chart-container"><canvas id="walletChart"></canvas></div></div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card"><p class="stat-label mb-2">MARKET</p><p id="spread" class="text-2xl font-black">0.000%</p><p class="text-[10px]">BID: <span id="bidPrice">0.00000000</span><br>ASK: <span id="askPrice">0.00000000</span></p></div>
            <div class="card"><p class="stat-label mb-2">LONG</p><p id="lRoi" class="text-2xl font-black">0.00%</p><p id="lPnl" class="text-sm">$0.00</p><p id="lAction" class="text-[10px] text-indigo-400"></p><p id="lDoge" class="text-[9px] text-amber-500">DOGE: 0</p></div>
            <div class="card"><p class="stat-label mb-2">SHORT</p><p id="sRoi" class="text-2xl font-black">0.00%</p><p id="sPnl" class="text-sm">$0.00</p><p id="sAction" class="text-[10px] text-indigo-400"></p><p id="sDoge" class="text-[9px] text-amber-500">DOGE: 0</p></div>
            <div class="card"><p class="stat-label mb-2">AI CONFIG</p><p id="aiConfigDisplay" class="text-sm">Leverage: ${config.leverage}x<br>TP: ${config.takeProfitPct}%<br>Risk: ${config.riskPercent}%</p></div>
        </div>
    </div>

    <script>
        let walletChart = null;
        
        async function setLeverage(leverage) {
            const res = await fetch('/api/set-leverage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leverage: parseInt(leverage) })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                alert(`Leverage updated to ${data.leverage}x with ${data.takeProfit}% TP`);
                location.reload();
            } else {
                alert('Failed to update leverage: ' + data.error);
            }
        }
        
        async function forceSync() { const btn = event.target; btn.textContent = '🔄 SYNCING...'; await fetch('/api/force-sync', {method: 'POST'}); setTimeout(() => btn.textContent = '🔄 FORCE SYNC', 1000); }
        async function emergencyClose() { if(confirm('Close ALL positions?')) { await fetch('/api/close', {method: 'POST'}); alert('Emergency liquidation initiated'); } }
        async function refreshAI() { const btn = event.target; btn.textContent = '⟳ FORCING AI...'; await fetch('/api/ai-refresh', {method: 'POST'}); setTimeout(() => btn.textContent = '🔄 Force AI Reconfig', 1000); }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalWallet').textContent = '$' + (data.market.totalEquity?.toFixed(4) || '0.00');
                document.getElementById('totalPnl').textContent = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + (data.market.totalNetGain?.toFixed(4) || '0.00');
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl >= 0 ? '+' : '') + '$' + (data.market.totalRealizedPnl?.toFixed(4) || '0.00');
                document.getElementById('peakEquity').innerHTML = 'Peak: $' + (data.market.peakEquity?.toFixed(4) || '0.00');
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = 'Trades: ' + (data.market.totalTrades || 0);
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + (data.market.winRate || 0) + '%';
                document.getElementById('baseVolumeDisplay').innerHTML = 'Volume: ' + (data.market.currentBaseVolume || 0) + ' contracts (' + (data.market.currentBaseDoge?.toLocaleString() || 0) + ' DOGE)';
                document.getElementById('riskAmount').innerHTML = '$' + (data.market.currentRiskAmount?.toFixed(8) || '0.00');
                document.getElementById('exchangeLeverage').innerHTML = (data.market.currentConfig?.leverage || 75) + 'x';
                document.getElementById('aiConfigDisplay').innerHTML = 'Leverage: ' + (data.market.currentConfig?.leverage || 75) + 'x<br>TP: ' + (data.market.currentConfig?.takeProfitPct || 15) + '%<br>Risk: ' + (data.market.currentConfig?.riskPercent || 0.25) + '%';
                
                if (data.market.aiRecommendation) {
                    document.getElementById('aiRecommendation').innerHTML = data.market.aiRecommendation.text.replace(/\\n/g, '<br>');
                    document.getElementById('aiTimestamp').innerHTML = 'Last updated: ' + data.market.aiRecommendation.time;
                    if (data.market.aiRecommendation.type === 'ollama') {
                        document.getElementById('aiTypeBadge').innerHTML = 'OLLAMA AI ACTIVE';
                    } else {
                        document.getElementById('aiTypeBadge').innerHTML = 'LOCAL AI ACTIVE';
                    }
                }
                
                document.getElementById('spread').textContent = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('bidPrice').textContent = (data.market.bid || 0).toFixed(8);
                document.getElementById('askPrice').textContent = (data.market.ask || 0).toFixed(8);
                
                const long = data.accounts?.find(a => a.direction === 'buy');
                const short = data.accounts?.find(a => a.direction === 'sell');
                
                if (long) {
                    document.getElementById('lRoi').textContent = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lPnl').textContent = '$' + (long.unrealizedUsdt?.toFixed(8) || '0.00');
                    document.getElementById('lAction').textContent = long.lastAction || 'Idle';
                    document.getElementById('lDoge').innerHTML = '🐕 DOGE: ' + (long.dogeAmount?.toLocaleString() || 0);
                }
                if (short) {
                    document.getElementById('sRoi').textContent = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sPnl').textContent = '$' + (short.unrealizedUsdt?.toFixed(8) || '0.00');
                    document.getElementById('sAction').textContent = short.lastAction || 'Idle';
                    document.getElementById('sDoge').innerHTML = '🐕 DOGE: ' + (short.dogeAmount?.toLocaleString() || 0);
                }
            } catch(e) { console.error(e); }
        }, 2000);
    </script>
</body>
</html>
    `);
});

// ==================== START BOT ====================
async function start() {
    await checkOllama();
    startWS();
    setInterval(backgroundLoop, config.pollInterval);
    
    app.listen(config.port, '0.0.0.0', async () => {
        console.log(`\n✅ Martingale DOGE Bot Started`);
        console.log(`🎯 Leverage-TP Mapping: 75x=15%, 50x=10%, 25x=5%, 10x=1.5%`);
        console.log(`📊 Current Exchange Leverage: ${config.leverage}x = ${config.takeProfitPct}% TP`);
        console.log(`📊 Required Price Move: ${(config.takeProfitPct / config.leverage).toFixed(3)}%`);
        console.log(`🌐 Dashboard: http://localhost:${config.port}`);
        console.log(`🤖 AI Controller: ${market.ollamaAvailable ? 'OLLAMA ACTIVE' : 'LOCAL MODE'}`);
        console.log(`\n⚠️  IMPORTANT: AI will automatically adjust leverage on HTX exchange!\n`);
        
        // Run initial AI configuration after 5 seconds
        setTimeout(async () => {
            await aiController();
        }, 5000);
    });
}

start();
