require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const ollama = require('ollama');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
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

const config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase().replace('-', ''),
    leverage: parseInt(process.env.LEVERAGE) || 75,
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
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 0.25,
    dogePerContract: 100,
    walletPerContract: 0.0066135,
    stepCooldownMs: 10 * 60 * 1000,
    aiEnabled: true,
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b'
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
    aiLastUpdate: 0
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let lastStepTime = {};

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    let volume = Math.floor(riskAmount / 0.005);
    volume = Math.max(1, volume);
    const MAX_VOLUME = 1000000;
    if (volume > MAX_VOLUME) {
        volume = MAX_VOLUME;
    }
    
    const dogeAmountTotal = volume * config.dogePerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseDoge = dogeAmountTotal;
    
    console.log(`\n💰 AUTO-COMPOUNDING CALCULATION (DOGE):`);
    console.log(`   Wallet: $${totalEquity.toFixed(8)}`);
    console.log(`   ${config.riskPercent}% Risk: $${riskAmount.toFixed(8)}`);
    console.log(`   Rule: 1 contract per $0.005 risk`);
    console.log(`   Formula: $${riskAmount.toFixed(8)} ÷ $0.005 = ${volume} contract(s)`);
    console.log(`   Calculated Volume: ${volume.toLocaleString()} contract(s) = ${dogeAmountTotal.toLocaleString()} DOGE`);
    console.log(`   Risk Amount: $${riskAmount.toFixed(8)} → ${volume} contract(s)\n`);
    
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
            riskAmount: market.currentRiskAmount
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
                
                console.log(`[${state.direction.toUpperCase()}] ROI: ${newExchangeRoi.toFixed(2)}% | Vol: ${newVolume} | Step: ${calculatedStep} (delay: ${timeSinceLastUpdate}ms)`);
                
                state.roi = newExchangeRoi;
                state.lastExchangeRoi = newExchangeRoi;
                state.lastRoiUpdateTime = now;
            }
            
            state.targetPrice = calculateTargetPrice(state);
            
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else {
            if (state.volume !== 0) {
                console.log(`✅ [${state.direction.toUpperCase()}] Position closed at ${new Date().toLocaleTimeString()}`);
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
                console.log(`[${state.direction.toUpperCase()}] Equity: $${oldEquity.toFixed(8)} → $${state.currentEquity.toFixed(8)} (${change >= 0 ? '+' : ''}$${change.toFixed(8)})`);
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
        estimatedFee: estimatedFee.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
    
    console.log(`📊 TRADE CLOSED: ${state.direction.toUpperCase()} | ROI: ${finalRoi.toFixed(2)}% | PnL: ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(8)} | Fee: $${estimatedFee.toFixed(8)}`);
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

// Local fallback recommendation (no API required)
function getLocalRecommendation() {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const drawdownPercent = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100).toFixed(2) : 0;
    const winRate = market.totalTrades > 0 ? ((market.winningTrades / market.totalTrades) * 100).toFixed(1) : 0;
    
    let action = '';
    let recommendation = '';
    let reason = '';
    let riskLevel = '';
    
    if (parseFloat(drawdownPercent) > 90) {
        action = '🚨 CRITICAL EMERGENCY 🚨';
        recommendation = 'STOP BOT IMMEDIATELY and manually close all positions!';
        reason = `Your wallet is DOWN ${drawdownPercent}% from peak. Martingale strategy has failed.`;
        riskLevel = '🔴 CRITICAL';
    } else if (parseFloat(drawdownPercent) > 50) {
        action = '⚠️ SEVERE DRAWDOWN ⚠️';
        recommendation = 'PAUSE bot and reduce position sizes by 50%';
        reason = `${drawdownPercent}% drawdown detected. Reduce riskPercent immediately.`;
        riskLevel = '🔴 EXTREME';
    } else if (parseFloat(drawdownPercent) > 30) {
        action = '⚠️ HIGH DRAWDOWN ⚠️';
        recommendation = 'Reduce position sizing and monitor closely';
        reason = `${drawdownPercent}% drawdown. Consider lowering auto-compound risk percent.`;
        riskLevel = '🟠 HIGH';
    } else if (winRate > 80 && market.totalTrades > 10) {
        action = '✅ STRATEGY WORKING';
        recommendation = 'Continue current strategy - high win rate detected';
        reason = `${winRate}% win rate over ${market.totalTrades} trades.`;
        riskLevel = '🟢 LOW';
    } else if (s1?.volume > 0 && s1?.roi <= -10) {
        action = '📊 MARTINGALE STEP';
        recommendation = `LONG position at ${s1.roi.toFixed(1)}% loss - adding contracts`;
        reason = `Martingale step will add ${Math.ceil(market.currentBaseVolume * config.multiplier)} contracts.`;
        riskLevel = '🟠 HIGH';
    } else if (s2?.volume > 0 && s2?.roi <= -10) {
        action = '📊 MARTINGALE STEP';
        recommendation = `SHORT position at ${s2.roi.toFixed(1)}% loss - adding contracts`;
        reason = `Martingale step will add ${Math.ceil(market.currentBaseVolume * config.multiplier)} contracts.`;
        riskLevel = '🟠 HIGH';
    } else {
        action = '📊 MONITORING';
        recommendation = 'Continue monitoring market conditions';
        reason = `No strong signals. Price: BID ${market.bid?.toFixed(8)}`;
        riskLevel = '🟢 LOW';
    }
    
    const fullRecommendation = `${action}\n\n🔹 RECOMMENDATION: ${recommendation}\n🔸 REASON: ${reason}\n🔹 RISK LEVEL: ${riskLevel}`;
    
    return fullRecommendation;
}

// Ollama AI Recommendation
async function getDeepSeekRecommendation() {
    if (!config.aiEnabled) {
        return null;
    }
    
    // Check if Ollama is available
    try {
        await ollama.list();
    } catch (error) {
        console.log('⚠️ Ollama not running. Using local fallback...');
        const fallback = getLocalRecommendation();
        market.aiRecommendation = {
            text: fallback,
            timestamp: Date.now(),
            time: new Date().toLocaleString() + ' (Local Mode)'
        };
        return fallback;
    }
    
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const totalEquityInitial = market.initialTotalEquity || totalEquity;
    const drawdownPercent = market.peakEquity > 0 ? ((market.peakEquity - totalEquity) / market.peakEquity * 100).toFixed(2) : 0;
    const winRate = market.totalTrades > 0 ? ((market.winningTrades / market.totalTrades) * 100).toFixed(1) : 0;
    
    const prompt = `You are a professional crypto trading advisor for a Martingale DOGE bot. Analyze this data and give a 2-sentence actionable recommendation:

DATA:
- Wallet: $${totalEquity.toFixed(4)} (${market.growthPct.toFixed(2)}% from start)
- Drawdown: ${drawdownPercent}%
- Win Rate: ${winRate}% (${market.totalTrades} trades)
- LONG ROI: ${s1?.roi || 0}% | SHORT ROI: ${s2?.roi || 0}%
- Spread: ${market.spread.toFixed(3)}%
- Current Price: BID ${market.bid?.toFixed(8)} ASK ${market.ask?.toFixed(8)}

Give: 1. RECOMMENDATION (what to do now) 2. REASON (brief explanation) 3. RISK LEVEL (Low/Medium/High)`;

    try {
        console.log('🤖 Requesting AI recommendation from Ollama...');
        
        const response = await ollama.chat({
            model: config.ollamaModel,
            messages: [
                { role: 'system', content: 'You are a crypto trading advisor. Give concise, actionable advice.' },
                { role: 'user', content: prompt }
            ],
            options: {
                temperature: 0.7,
                num_predict: 250
            }
        });
        
        const recommendation = response.message.content;
        market.aiRecommendation = {
            text: recommendation,
            timestamp: Date.now(),
            time: new Date().toLocaleString()
        };
        market.aiLastUpdate = Date.now();
        
        console.log(`\n🤖 OLLAMA AI (${new Date().toLocaleTimeString()}):`);
        console.log(recommendation);
        console.log('');
        
        return recommendation;
        
    } catch (error) {
        console.error('Ollama error:', error.message);
        const fallback = getLocalRecommendation();
        market.aiRecommendation = {
            text: fallback,
            timestamp: Date.now(),
            time: new Date().toLocaleString() + ' (Local Fallback)'
        };
        return fallback;
    }
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
            
            console.log(`🚀 Opening ${state.direction} position at ${currentPrice.toFixed(8)} with ${market.currentBaseVolume} contract(s) (${market.currentBaseVolume * config.dogePerContract} DOGE)`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            
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
                state.lastAction = "Position Opening";
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Position opened at ${state.entryPrice.toFixed(8)}, TP target: ${state.targetPrice.toFixed(8)}`);
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
                console.log(`🎯 LONG TP triggered! ASK: ${market.ask.toFixed(8)} >= Target: ${state.targetPrice.toFixed(8)}`);
            }
        } else {
            if (market.bid <= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.bid;
                console.log(`🎯 SHORT TP triggered! BID: ${market.bid.toFixed(8)} <= Target: ${state.targetPrice.toFixed(8)}`);
            }
        }
        
        if (shouldTakeProfit) {
            const finalRoi = config.takeProfitPct;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            
            console.log(`✅ Taking ${state.direction} profit at ${exitPrice.toFixed(8)} (Target ROI: ${finalRoi}%, Step ${currentStep}, Vol: ${state.volume}, ${state.volume * config.dogePerContract} DOGE)`);
            state.isLocked = true;
            state.lastAction = "Taking Profit...";
            
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
        
        if (state.roi <= -10 && state.volume > 0 && timeSinceLastStep >= config.stepCooldownMs) {
            const nextStepNumber = currentStep + 1;
            let nextVol;
            
            if (nextStepNumber === 1) {
                nextVol = Math.ceil(market.currentBaseVolume * config.multiplier);
            } else {
                nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            }
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} for ${state.direction} - ROI: ${state.roi.toFixed(2)}% (LOSS) | Current Vol: ${state.volume} (${state.volume * config.dogePerContract} DOGE) | Adding: ${nextVol} contracts (${nextVol * config.dogePerContract} DOGE)`);
            console.log(`   ⏱️  Cooldown check: ${(timeSinceLastStep / 1000).toFixed(0)}s since last step (required: ${config.stepCooldownMs/1000}s) - PROCEEDING`);
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
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${nextStepNumber} (-${Math.abs(state.roi).toFixed(1)}% loss, Added: ${nextVol} contracts, ${nextVol * config.dogePerContract} DOGE)`;
                lastStepTime[acc.accountId] = now;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        } else if (state.roi <= -10 && state.volume > 0 && timeSinceLastStep < config.stepCooldownMs) {
            const remainingCooldown = ((config.stepCooldownMs - timeSinceLastStep) / 1000).toFixed(0);
            state.lastAction = `Step Cooldown (${remainingCooldown}s remaining) - ROI: ${state.roi.toFixed(2)}%`;
            console.log(`⏸️  [${state.direction.toUpperCase()}] Martingale step blocked - cooldown active (${remainingCooldown}s remaining until next step)`);
        } else {
            const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            state.lastAction = `Active - Step ${step} | Vol: ${state.volume} (${state.volume * config.dogePerContract} DOGE) | ROI: ${state.roi.toFixed(2)}%`;
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
                        console.log(`📈 AUTO-COMPOUND: Base volume updated: ${market.currentBaseVolume} → ${newBaseVolume} contract(s) (${newBaseVolume * config.dogePerContract} DOGE)`);
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
        
        // Update AI recommendation every 5 minutes
        if (config.aiEnabled && (!market.aiLastUpdate || (Date.now() - market.aiLastUpdate) > 300000)) {
            await getDeepSeekRecommendation();
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
        const expectedVol = calculateVolumeForStep(step, market.currentBaseVolume, config.multiplier);
        const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
        
        return {
            direction: state.direction,
            roi: state.roi,
            volume: state.volume,
            dogeAmount: state.volume * config.dogePerContract,
            step: step,
            expectedVolumeForStep: expectedVol,
            unrealizedUsdt: state.unrealizedUsdt,
            entryPrice: state.entryPrice,
            lastAction: state.lastAction,
            startTime: state.startTime,
            targetPrice: state.targetPrice,
            requiredPriceMoveForTP: `${requiredPriceMovePct}%`,
            currentEquity: state.currentEquity,
            initialEquity: state.initialEquity,
            realizedPnl: state.realizedPnl,
            totalFees: state.totalFees,
            roiLatencyHistory: state.roiLatencyHistory.slice(0, 5)
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
            aiEnabled: config.aiEnabled
        },
        accounts: accountsWithInfo,
        tradeHistory,
        config: {
            maxStartSpread: config.maxStartSpread,
            takeProfitPct: config.takeProfitPct,
            leverage: config.leverage,
            requiredPriceMovePct: (config.takeProfitPct / config.leverage).toFixed(3) + '%',
            pollInterval: config.pollInterval,
            baseVolume: market.currentBaseVolume,
            multiplier: config.multiplier,
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            dogePerContract: config.dogePerContract
        }
    });
});

app.post('/api/close', async (req, res) => {
    console.log("🔴 EMERGENCY CLOSE INITIATED");
    market.status = "LIQUIDATING";
    
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            const step = calculateStepFromVolume(s.volume, market.currentBaseVolume, config.multiplier);
            console.log(`Closing ${s.direction} position (Step ${step}, Vol: ${s.volume}, ${s.volume * config.dogePerContract} DOGE)...`);
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
    res.json({ status: 'ok', message: 'Force sync completed' });
});

app.post('/api/ai-refresh', async (req, res) => {
    await getDeepSeekRecommendation();
    res.json({ recommendation: market.aiRecommendation });
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
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            autoCompound: {
                enabled: config.autoCompound,
                riskPercent: config.riskPercent,
                currentBaseVolume: market.currentBaseVolume,
                currentBaseDoge: market.currentBaseDoge,
                currentRiskAmount: market.currentRiskAmount,
                dogePerContract: config.dogePerContract
            }
        },
        history: market.walletHistory,
        trades: tradeHistory.slice(0, 20)
    });
});

app.get('/api/verify', async (req, res) => {
    const requiredPriceMovePct = config.takeProfitPct / config.leverage;
    
    const verification = [];
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', {
            contract_code: config.symbol
        });
        
        if (posRes?.status === 'ok' && posRes.data) {
            const pos = posRes.data.find(p => p.direction === state.direction);
            if (pos) {
                verification.push({
                    account: acc.accountId,
                    direction: state.direction,
                    exchange_profit_rate: parseFloat(pos.profit_rate),
                    exchange_profit_rate_percent: (parseFloat(pos.profit_rate) * 100).toFixed(2) + '%',
                    bot_display_roi: state.roi.toFixed(2) + '%',
                    target_price: state.targetPrice,
                    entry_price: state.entryPrice,
                    current_ask: market.ask,
                    current_bid: market.bid,
                    required_price_move_for_tp: requiredPriceMovePct.toFixed(3) + '%',
                    leverage: config.leverage,
                    realized_pnl: state.realizedPnl,
                    total_fees: state.totalFees
                });
            }
        }
    }
    
    res.json({
        verified: verification,
        wallet: {
            initialEquity: market.initialTotalEquity,
            currentEquity: (accountStates[1]?.currentEquity || 0) + (accountStates[2]?.currentEquity || 0),
            totalPnL: market.totalNetGain,
            totalPnLPercent: market.growthPct,
            totalRealizedPnL: (accountStates[1]?.realizedPnl || 0) + (accountStates[2]?.realizedPnl || 0),
            totalFees: (accountStates[1]?.totalFees || 0) + (accountStates[2]?.totalFees || 0),
            peakEquity: market.peakEquity,
            maxDrawdown: market.maxDrawdown,
            totalTrades: market.totalTrades,
            winRate: market.totalTrades > 0 ? (market.winningTrades / market.totalTrades * 100).toFixed(1) : 0,
            autoCompound: {
                enabled: config.autoCompound,
                riskPercent: config.riskPercent,
                currentBaseVolume: market.currentBaseVolume,
                currentBaseDoge: market.currentBaseDoge,
                currentRiskAmount: market.currentRiskAmount,
                dogePerContract: config.dogePerContract,
                formula: "1 Contract = 100 DOGE. Volume = Risk Amount ÷ $0.005 (1 contract per $0.005 risk)"
            }
        },
        message: `Auto-compounding: ${config.riskPercent}% of wallet. 1 Contract = ${config.dogePerContract} DOGE. Volume calculation: Risk Amount (${config.riskPercent}% of wallet) ÷ $0.005 = number of contracts.`
    });
});

// HTML Dashboard (simplified for brevity - same as before with AI card)
app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - DOGE Auto-Compounding</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .mono { font-family: monospace; font-size: 12px; }
        .tp-target { background: #00D1B220; color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 10px; }
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
        button:hover { background: #FF4D6D40; }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
        .step-badge { background: #6366F120; color: #6366F1; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #F3BA2F40; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
        .doge-badge { background: #F3BA2F20; color: #F3BA2F; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; }
        .ai-card { background: linear-gradient(135deg, #1E1B4B 0%, #131824 100%); border: 1px solid #6366F1; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .ai-text { font-size: 14px; line-height: 1.5; color: #C4B5FD; white-space: pre-line; }
        .refresh-ai { background: #6366F120; border-color: #6366F1; color: #6366F1; font-size: 12px; padding: 4px 12px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-amber-500">DOGE</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">AUTO-COMPOUND</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price move</span>
                    <span class="doge-badge">🐕 1 CONTRACT = ${config.dogePerContract} DOGE</span>
                </div>
            </div>
            <div>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <!-- AI RECOMMENDATION CARD -->
        <div class="ai-card mb-6">
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center gap-2">
                    <span class="text-xl">🤖</span>
                    <h3 class="font-bold text-indigo-400">Ollama AI Trading Advisor</h3>
                    <span class="text-[9px] bg-indigo-500/30 px-2 py-0.5 rounded">LOCAL & FREE</span>
                </div>
                <button onclick="refreshAI()" class="refresh-ai rounded">🔄 Refresh</button>
            </div>
            <div id="aiRecommendation" class="ai-text">
                <div class="flex items-center gap-2">
                    <div class="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></div>
                    <span>Loading AI recommendation...</span>
                </div>
            </div>
            <div id="aiTimestamp" class="text-[9px] text-slate-500 mt-2"></div>
        </div>

        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
                <div>
                    <p class="stat-label">TOTAL WALLET</p>
                    <p id="totalWallet" class="stat-number value-positive">$0.00000000</p>
                    <p id="walletChange" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">TOTAL P&L</p>
                    <p id="totalPnl" class="stat-number">$0.00000000</p>
                    <p id="pnlPercent" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">REALIZED P&L</p>
                    <p id="realizedPnl" class="stat-number">$0.00000000</p>
                    <p id="feesPaid" class="text-xs text-slate-500">Fees: $0.00</p>
                </div>
                <div>
                    <p class="stat-label">PERFORMANCE</p>
                    <p id="peakEquity" class="text-sm">Peak: $0.00</p>
                    <p id="maxDrawdown" class="text-sm text-red-400">DD: 0%</p>
                </div>
                <div>
                    <p class="stat-label">STATISTICS</p>
                    <p id="tradeStats" class="text-sm">Trades: 0</p>
                    <p id="winRate" class="text-sm text-green-400">Win Rate: 0%</p>
                </div>
            </div>
            
            <div class="compound-info mt-4">
                <div class="flex justify-between items-center">
                    <div>
                        <p class="text-xs text-slate-400">📈 AUTO-COMPOUNDING (${config.riskPercent}% of Wallet)</p>
                        <p class="text-sm font-bold text-green-400" id="baseVolumeDisplay">Base Volume: 0 contracts</p>
                        <p class="text-xs text-slate-400" id="dogeDisplay">0 DOGE per trade</p>
                        <p class="text-xs text-slate-400" id="formulaDisplay">Formula: Risk Amount ÷ $0.005 = Contracts</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-slate-400">Risk Amount (${config.riskPercent}%)</p>
                        <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="card mb-8">
            <h3 class="font-bold mb-4">📈 WALLET GROWTH CHART</h3>
            <div class="chart-container">
                <canvas id="walletChart" style="max-height: 280px; width: 100%;"></canvas>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label mb-2">CONFIG</p>
                <p class="text-sm">Base Vol: <span id="configBaseVol">${config.baseVolume}</span></p>
                <p class="text-sm">Multiplier: ${config.multiplier}x</p>
                <p class="text-sm">Step Trigger: <span class="text-red-400">-${config.stepDistancePct}% ROI</span></p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">MARKET</p>
                <p id="spread" class="text-2xl font-black">0.000%</p>
                <p class="text-[10px] text-slate-500 mt-1">Max Start: ${config.maxStartSpread}%</p>
                <p class="text-[10px] text-slate-500">BID: <span id="bidPrice">0.00000000</span> | ASK: <span id="askPrice">0.00000000</span></p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">LONG</p>
                <p id="lRoi" class="text-2xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2"></p>
                <p id="lAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="lTarget" class="text-[9px] text-green-400 mt-1"></p>
                <p id="lRealized" class="text-[8px] text-slate-500 mt-1">Realized: $0.00</p>
                <p id="lDoge" class="text-[8px] text-amber-500 mt-1">DOGE: 0</p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">SHORT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2"></p>
                <p id="sAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="sTarget" class="text-[9px] text-green-400 mt-1"></p>
                <p id="sRealized" class="text-[8px] text-slate-500 mt-1">Realized: $0.00</p>
                <p id="sDoge" class="text-[8px] text-amber-500 mt-1">DOGE: 0</p>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <div class="overflow-x-auto max-h-96 overflow-y-auto">
                <table class="w-full border-collapse">
                    <thead class="bg-[#0F141C] sticky top-0">
                        <tr><th class="text-left p-3 text-xs">SIDE</th><th class="text-left p-3 text-xs">OPEN</th><th class="text-left p-3 text-xs">CLOSE</th><th class="text-right p-3 text-xs">STEP</th><th class="text-right p-3 text-xs">VOL</th><th class="text-right p-3 text-xs">DOGE</th><th class="text-right p-3 text-xs">ENTRY</th><th class="text-right p-3 text-xs">EXIT</th><th class="text-right p-3 text-xs">ROI</th><th class="text-right p-3 text-xs">PNL</th><th class="text-right p-3 text-xs">FEE</th></tr>
                    </thead>
                    <tbody id="tradesBody"><tr><td colspan="11" class="text-center p-12">No closed trades</td></tr></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let walletChart = null;
        
        async function forceSync() {
            const btn = event.target;
            btn.textContent = '🔄 SYNCING...';
            await fetch('/api/force-sync', {method: 'POST'});
            setTimeout(() => btn.textContent = '🔄 FORCE SYNC', 1000);
        }
        
        async function emergencyClose() {
            if(confirm('Close ALL positions?')) {
                await fetch('/api/close', {method: 'POST'});
                alert('Emergency liquidation initiated');
            }
        }
        
        async function refreshAI() {
            const btn = event.target;
            btn.textContent = '⟳ REFRESHING...';
            await fetch('/api/ai-refresh', {method: 'POST'});
            setTimeout(() => btn.textContent = '🔄 Refresh', 1000);
        }
        
        function formatNumber(num) { return parseFloat(num).toFixed(8); }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalWallet').textContent = '$' + formatNumber(data.market.totalEquity);
                document.getElementById('totalPnl').textContent = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + formatNumber(data.market.totalNetGain);
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl >= 0 ? '+' : '') + '$' + formatNumber(data.market.totalRealizedPnl);
                document.getElementById('peakEquity').innerHTML = 'Peak: $' + formatNumber(data.market.peakEquity);
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = 'Trades: ' + (data.market.totalTrades || 0);
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + (data.market.winRate || 0) + '%';
                document.getElementById('baseVolumeDisplay').innerHTML = 'Base Volume: ' + (data.market.currentBaseVolume || 0) + ' contract(s)';
                document.getElementById('dogeDisplay').innerHTML = (data.market.currentBaseDoge || 0).toLocaleString() + ' DOGE per trade';
                document.getElementById('riskAmount').innerHTML = '$' + formatNumber(data.market.currentRiskAmount || 0);
                
                if (data.market.aiRecommendation) {
                    document.getElementById('aiRecommendation').innerHTML = data.market.aiRecommendation.text.replace(/\\n/g, '<br>');
                    document.getElementById('aiTimestamp').innerHTML = 'Last updated: ' + data.market.aiRecommendation.time;
                }
                
                document.getElementById('spread').textContent = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('bidPrice').textContent = (data.market.bid || 0).toFixed(8);
                document.getElementById('askPrice').textContent = (data.market.ask || 0).toFixed(8);
                
                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                
                if (long) {
                    document.getElementById('lRoi').textContent = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lPnl').textContent = (long.unrealizedUsdt >= 0 ? '+' : '') + long.unrealizedUsdt.toFixed(8);
                    document.getElementById('lStep').innerHTML = 'STEP ' + (long.step || 0) + ' | VOL ' + (long.volume || 0);
                    document.getElementById('lAction').textContent = long.lastAction;
                    document.getElementById('lRealized').innerHTML = 'Realized: ' + (long.realizedPnl >= 0 ? '+' : '') + '$' + (long.realizedPnl || 0).toFixed(8);
                    document.getElementById('lDoge').innerHTML = '🐕 DOGE: ' + (long.dogeAmount || 0).toLocaleString();
                    if (long.targetPrice) document.getElementById('lTarget').innerHTML = '🎯 TP: ' + long.targetPrice.toFixed(8);
                }
                
                if (short) {
                    document.getElementById('sRoi').textContent = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sPnl').textContent = (short.unrealizedUsdt >= 0 ? '+' : '') + short.unrealizedUsdt.toFixed(8);
                    document.getElementById('sStep').innerHTML = 'STEP ' + (short.step || 0) + ' | VOL ' + (short.volume || 0);
                    document.getElementById('sAction').textContent = short.lastAction;
                    document.getElementById('sRealized').innerHTML = 'Realized: ' + (short.realizedPnl >= 0 ? '+' : '') + '$' + (short.realizedPnl || 0).toFixed(8);
                    document.getElementById('sDoge').innerHTML = '🐕 DOGE: ' + (short.dogeAmount || 0).toLocaleString();
                    if (short.targetPrice) document.getElementById('sTarget').innerHTML = '🎯 TP: ' + short.targetPrice.toFixed(8);
                }
                
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 20).forEach(t => {
                        tradesHtml += '<tr class="border-b border-[#1A212E]"><td class="p-3"><span class="' + (t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400') + '">' + t.side + '</span><td class="p-3 text-xs">' + (t.openTime || '--') + '<td class="p-3 text-xs">' + (t.closeTime || '--') + '<td class="p-3 text-right">' + (t.step || 0) + '<td class="p-3 text-right">' + t.volume + '<td class="p-3 text-right">' + (t.volume * 100).toLocaleString() + '<td class="p-3 text-right mono">' + t.entryPrice + '<td class="p-3 text-right mono">' + t.exitPrice + '<td class="p-3 text-right">' + t.roi + '<td class="p-3 text-right mono">' + t.netPnlUsdt + '<td class="p-3 text-right mono text-slate-500">' + t.estimatedFee + '</tr>';
                    });
                } else {
                    tradesHtml = '<tr><td colspan="11" class="text-center p-12">No closed trades</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== START BOT ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', async () => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    console.log(`\n✅ Martingale Pro Started for DOGE (Ollama AI Enabled)`);
    console.log(`🐕 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`📦 Contract Spec: 1 Contract = ${config.dogePerContract} DOGE`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price movement`);
    console.log(`💰 Auto-Compounding: ${config.riskPercent}% of wallet`);
    console.log(`📈 Step Trigger: -${config.stepDistancePct}% ROI`);
    console.log(`⏱️  Step Cooldown: 5 minutes`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`\n🤖 AI Advisor: Ollama (${config.ollamaModel})`);
    
    // Check Ollama status
    try {
        await ollama.list();
        console.log(`✅ Ollama is running! AI recommendations active.\n`);
    } catch (error) {
        console.log(`⚠️ Ollama not running. Install from https://ollama.com`);
        console.log(`   Then run: ollama pull ${config.ollamaModel}`);
        console.log(`   AI will use local fallback mode until Ollama is running.\n`);
    }
});
