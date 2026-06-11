require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

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
    riskPercent: 2,
    shibPerContract: 1000,
    walletPerContract: 0.0066135,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    aiControlEnabled: true  // AI controls all actions - NO automatic steps
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
    currentBaseShib: 0,
    currentRiskAmount: 0,
    lastBaseUpdate: Date.now(),
    aiModeEnabled: true,
    lastAiCheck: 0
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};
let aiRecommendations = {
    long: { recommendation: 'HOLD: Waiting for AI analysis...', confidence: 0, lastUpdate: null, action: 'HOLD' },
    short: { recommendation: 'HOLD: Waiting for AI analysis...', confidence: 0, lastUpdate: null, action: 'HOLD' }
};

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    let volume = Math.floor(totalEquity / config.walletPerContract);
    volume = Math.max(1, volume);
    
    const MAX_VOLUME = 1000000;
    if (volume > MAX_VOLUME) {
        volume = MAX_VOLUME;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    const positionUsdt = riskAmount * config.leverage;
    const shibAmount = volume * config.shibPerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseShib = shibAmount;
    
    console.log(`\n💰 AUTO-COMPOUNDING CALCULATION:`);
    console.log(`   Wallet: $${totalEquity.toFixed(8)}`);
    console.log(`   ${config.riskPercent}% Risk: $${riskAmount.toFixed(8)}`);
    console.log(`   @ ${config.leverage}x → $${positionUsdt.toFixed(8)} position`);
    console.log(`   Volume: ${volume.toLocaleString()} contract(s) = ${shibAmount.toLocaleString()} ${config.symbol.split('-')[0]}`);
    console.log(`   Risk per contract: $${(riskAmount/volume).toFixed(8)}\n`);
    
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
            baseShib: market.currentBaseShib,
            riskAmount: market.currentRiskAmount,
            longRec: aiRecommendations.long.recommendation,
            shortRec: aiRecommendations.short.recommendation
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
        lastAction: '🤖 Waiting for AI recommendation...',
        lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastExchangeRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0,
        realizedPnl: 0,
        totalFees: 0,
        lastAiRecommendation: null,
        aiActionTaken: false
    };
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
                state.aiActionTaken = false;
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

async function getAIRecommendation(direction, state, marketData) {
    try {
        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        const nextStepVolume = currentStep === 0 ? market.currentBaseVolume : Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, currentStep + 1));
        
        const prompt = `You are a crypto futures trading advisor for HTX. Analyze this ${direction.toUpperCase()} position and give ONLY ONE of these exact recommendations:

RULES:
- If NO position exists (volume = 0) and spread < ${config.maxStartSpread}%: Recommend "OPEN POSITION"
- If position exists and ROI <= -${config.stepDistancePct}%: Recommend "STEP UP: Add ${nextStepVolume} contracts"
- If position exists and ROI >= ${config.takeProfitPct}%: Recommend "CLOSE POSITION"
- Otherwise: Recommend "HOLD"

Position Data:
- Current ROI: ${state.roi.toFixed(2)}%
- Volume: ${state.volume} contracts
- Current Step: ${currentStep}
- Entry Price: ${state.entryPrice.toFixed(8)}
- Target Price: ${state.targetPrice.toFixed(8)}
- Unrealized PnL: $${state.unrealizedUsdt.toFixed(8)}
- Current Price: $${direction === 'buy' ? market.bid : market.ask}

Market Conditions:
- Spread: ${market.spread.toFixed(3)}%
- Max Start Spread: ${config.maxStartSpread}%
- Total Wallet: $${marketData.totalEquity.toFixed(8)}

Respond with EXACTLY ONE of these formats:
- "OPEN POSITION: Start new ${direction} position with ${market.currentBaseVolume} contracts"
- "STEP UP: Add ${nextStepVolume} contracts (martingale)"
- "CLOSE POSITION: Take profit/loss now"
- "HOLD: No action needed"

DO NOT add any other text or explanation.`;

        const response = await axios.post(`${config.ollamaUrl}/api/generate`, {
            model: config.ollamaModel,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.1,
                top_p: 0.9,
                num_predict: 60
            }
        });

        let recommendation = response.data.response.trim();
        
        // Validate and clean recommendation
        if (recommendation.includes('OPEN POSITION')) {
            recommendation = `OPEN POSITION: Start new ${direction} position with ${market.currentBaseVolume} contracts`;
        } else if (recommendation.includes('STEP UP')) {
            recommendation = `STEP UP: Add ${nextStepVolume} contracts (martingale)`;
        } else if (recommendation.includes('CLOSE POSITION')) {
            recommendation = 'CLOSE POSITION: Take profit/loss now';
        } else {
            recommendation = 'HOLD: No action needed';
        }
        
        return recommendation;
        
    } catch (error) {
        console.error(`AI Error for ${direction}:`, error.message);
        // Fallback - only HOLD, no automatic actions
        return 'HOLD: No action needed';
    }
}

async function updateAIRecommendations() {
    try {
        const longState = accountStates[1];
        const shortState = accountStates[2];
        
        const totalEquity = (longState?.currentEquity || 0) + (shortState?.currentEquity || 0);
        
        const marketData = {
            totalEquity: totalEquity,
            longRoi: longState?.roi || 0,
            shortRoi: shortState?.roi || 0,
            spread: market.spread,
            bid: market.bid,
            ask: market.ask
        };
        
        // Get recommendations for both positions
        const [longRec, shortRec] = await Promise.all([
            getAIRecommendation('long', longState, marketData),
            getAIRecommendation('short', shortState, marketData)
        ]);
        
        aiRecommendations.long = {
            recommendation: longRec,
            confidence: 90,
            lastUpdate: new Date().toISOString(),
            action: longRec.split(':')[0]
        };
        
        aiRecommendations.short = {
            recommendation: shortRec,
            confidence: 90,
            lastUpdate: new Date().toISOString(),
            action: shortRec.split(':')[0]
        };
        
        console.log(`\n🤖 AI RECOMMENDATIONS (${new Date().toLocaleTimeString()}):`);
        console.log(`   LONG: ${longRec}`);
        console.log(`   SHORT: ${shortRec}\n`);
        
        // Execute AI recommendations
        await executeAIRecommendation('long', longRec, longState, 1);
        await executeAIRecommendation('short', shortRec, shortState, 2);
        
    } catch (error) {
        console.error('AI recommendation error:', error);
    }
}

async function executeAIRecommendation(direction, recommendation, state, accountId) {
    const acc = config.accounts.find(a => a.accountId === accountId);
    if (!acc || state.isLocked) return;
    
    const action = recommendation.split(':')[0];
    
    // STEP UP action
    if (action === 'STEP UP') {
        if (state.volume > 0) {
            const match = recommendation.match(/(\d+)/);
            const volumeToAdd = match ? parseInt(match[0]) : Math.ceil(market.currentBaseVolume * config.multiplier);
            
            console.log(`🤖 AI EXECUTING STEP UP: Adding ${volumeToAdd} contracts to ${direction} position`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: STEP UP +${volumeToAdd}`;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: volumeToAdd,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data?.order_id_str;
                console.log(`✅ AI STEP UP executed for ${direction}`);
            } else {
                console.error(`❌ AI STEP UP failed:`, res);
                state.lastAction = `❌ AI STEP UP Failed`;
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    // CLOSE POSITION action
    else if (action === 'CLOSE POSITION') {
        if (state.volume > 0) {
            console.log(`🤖 AI EXECUTING CLOSE POSITION: Closing ${state.volume} contracts ${direction}`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: CLOSE POSITION`;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data?.order_id_str;
                console.log(`✅ AI CLOSE POSITION executed for ${direction}`);
                
                // Log trade
                const finalRoi = state.roi;
                const finalPnl = state.unrealizedUsdt;
                const exitTime = new Date().toLocaleString();
                logTradeExchangeStyle(state, state.direction === 'buy' ? market.bid : market.ask, exitTime, finalRoi, finalPnl);
                
                // Reset position
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.targetPrice = 0;
                state.aiActionTaken = false;
            } else {
                console.error(`❌ AI CLOSE POSITION failed:`, res);
                state.lastAction = `❌ AI CLOSE Failed`;
            }
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
    }
    // OPEN POSITION action
    else if (action === 'OPEN POSITION') {
        if (state.volume === 0 && market.spread <= config.maxStartSpread) {
            console.log(`🤖 AI EXECUTING OPEN POSITION: Opening ${market.currentBaseVolume} contracts ${direction} at ${state.direction === 'buy' ? market.bid : market.ask}`);
            state.isLocked = true;
            state.lastAction = `🤖 AI: OPEN POSITION`;
            
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
                console.log(`✅ AI OPEN POSITION executed for ${direction}`);
                
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Position opened at ${state.entryPrice.toFixed(8)}, TP: ${state.targetPrice.toFixed(8)}`);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
                state.lastAction = `❌ AI OPEN Failed`;
                console.error(`❌ AI OPEN POSITION failed:`, res);
            }
        } else if (state.volume > 0) {
            console.log(`⚠️ AI recommended OPEN but position already exists for ${direction}`);
        } else if (market.spread > config.maxStartSpread) {
            console.log(`⚠️ AI recommended OPEN but spread too high: ${market.spread.toFixed(2)}% > ${config.maxStartSpread}%`);
        }
    }
    // HOLD action
    else {
        if (state.lastAction !== `🤖 AI: HOLD`) {
            state.lastAction = `🤖 AI: HOLD - No action needed`;
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
        aiRecommendation: state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation
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

async function processMartingale() {
    // AI CONTROLLED ONLY - No automatic actions
    // This function only updates status, no automatic trading
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked) continue;
        
        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        
        // Just update status display with AI recommendation
        if (state.volume > 0) {
            const aiRec = state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation;
            state.lastAction = `🤖 AI: ${aiRec} | ROI: ${state.roi.toFixed(2)}% | Step ${currentStep}`;
        } else {
            const aiRec = state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation;
            if (aiRec.includes('OPEN')) {
                state.lastAction = `🤖 AI: ${aiRec}`;
            } else {
                state.lastAction = `🤖 AI: ${aiRec} | No position`;
            }
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
                const totalRealizedPnl = s1.realizedPnl + s2.realizedPnl;
                const totalFees = s1.totalFees + s2.totalFees;
                
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedHours = (Date.now() - market.startTime) / (1000 * 60 * 60);
                market.dgr = elapsedHours > 0 ? (market.growthPct / elapsedHours) : 0;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        console.log(`📈 AUTO-COMPOUND: Base volume updated: ${market.currentBaseVolume} → ${newBaseVolume} contract(s)`);
                        market.currentBaseVolume = newBaseVolume;
                        market.lastBaseUpdate = Date.now();
                    }
                }
                
                updateWalletGrowth(totalEquity);
                
                const lastRecord = market.walletHistory[market.walletHistory.length - 2];
                if (lastRecord && Math.abs(market.growthPct - lastRecord.pnlPercent) > 0.1) {
                    console.log(`💰 WALLET: $${totalEquity.toFixed(8)} | PnL: ${market.totalNetGain >= 0 ? '+' : ''}$${market.totalNetGain.toFixed(8)} (${market.growthPct >= 0 ? '+' : ''}${market.growthPct.toFixed(2)}%)`);
                    console.log(`   Base Volume: ${market.currentBaseVolume} contract(s) (${market.currentBaseShib.toLocaleString()} ${config.symbol.split('-')[0]}) | Risk: $${market.currentRiskAmount.toFixed(8)}`);
                }
            }
        }
        
        // Update AI recommendations every 15 seconds
        if (Date.now() - market.lastAiCheck > 15000) {
            market.lastAiCheck = Date.now();
            await updateAIRecommendations();
        }
        
        if (market.status === 'Active') {
            await processMartingale();
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
            currentBaseShib: market.currentBaseShib,
            currentRiskAmount: market.currentRiskAmount,
            shibPerContract: config.shibPerContract,
            walletPerContract: config.walletPerContract,
            aiControlEnabled: config.aiControlEnabled,
            aiModel: config.ollamaModel
        },
        accounts: accountsWithInfo,
        tradeHistory,
        aiRecommendations: aiRecommendations,
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
            walletPerContract: config.walletPerContract,
            ollamaModel: config.ollamaModel,
            aiControlEnabled: config.aiControlEnabled
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
            console.log(`Closing ${s.direction} position (Step ${step}, Vol: ${s.volume})...`);
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

app.post('/api/force-ai-check', async (req, res) => {
    console.log("🤖 Force AI check initiated...");
    await updateAIRecommendations();
    res.json({ status: 'ok', message: 'AI check completed', recommendations: aiRecommendations });
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
                currentBaseShib: market.currentBaseShib,
                currentRiskAmount: market.currentRiskAmount,
                shibPerContract: config.shibPerContract,
                walletPerContract: config.walletPerContract
            }
        },
        history: market.walletHistory,
        trades: tradeHistory.slice(0, 20),
        aiRecommendations: aiRecommendations
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
                    total_fees: state.totalFees,
                    ai_recommendation: state.direction === 'buy' ? aiRecommendations.long.recommendation : aiRecommendations.short.recommendation
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
                currentBaseShib: market.currentBaseShib,
                currentRiskAmount: market.currentRiskAmount,
                shibPerContract: config.shibPerContract,
                walletPerContract: config.walletPerContract,
                formula: "Volume = Total Wallet ÷ 0.0066135"
            }
        },
        aiRecommendations: aiRecommendations,
        aiControl: {
            enabled: config.aiControlEnabled,
            model: config.ollamaModel,
            checkInterval: '15 seconds',
            message: 'All actions controlled by AI - no automatic steps'
        },
        message: `🤖 AI CONTROL ACTIVE: All trading decisions (OPEN, STEP UP, CLOSE) are made by Ollama AI (${config.ollamaModel}). No automatic martingale steps.`
    });
});

// ==================== HTML DASHBOARD ====================

app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro AI - AI Controlled Trading</title>
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
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
        button:hover { background: #FF4D6D40; transform: scale(1.02); }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
        .ai-btn { background: #6366F120; border-color: #6366F1; color: #6366F1; margin-left: 10px; }
        .step-badge { background: #6366F120; color: #6366F1; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #00D1B240; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
        .ai-card { background: linear-gradient(135deg, #6366F120 0%, #131824 100%); border: 2px solid #6366F1; border-radius: 12px; padding: 15px; margin-bottom: 20px; }
        .ai-recommendation { font-size: 14px; font-weight: bold; padding: 10px; border-radius: 8px; margin-top: 8px; }
        .step-up { background: #FF4D6D20; color: #FF4D6D; border-left: 3px solid #FF4D6D; }
        .step-down { background: #FFB34720; color: #FFB347; border-left: 3px solid #FFB347; }
        .close-position { background: #FF000020; color: #FF0000; border-left: 3px solid #FF0000; }
        .open-position { background: #00D1B220; color: #00D1B2; border-left: 3px solid #00D1B2; }
        .hold { background: #6366F120; color: #6366F1; border-left: 3px solid #6366F1; }
        .ai-badge { background: #6366F1; color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-left: 8px; }
        .control-badge { background: #FF4D6D; color: white; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; margin-left: 8px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .ai-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO AI</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">AI CONTROLLED</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price move</span>
                    <span class="ai-badge">🤖 AI: ${config.ollamaModel}</span>
                    <span class="control-badge">🎮 AI CONTROLLED</span>
                </div>
            </div>
            <div>
                <button onclick="forceAICheck()" class="ai-btn">🤖 FORCE AI CHECK</button>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <!-- AI Control Status -->
        <div class="bg-indigo-500/10 border border-indigo-500/30 rounded-lg p-3 mb-4 text-center">
            <span class="text-indigo-400 font-bold">🤖 AI CONTROL MODE ACTIVE</span>
            <span class="text-slate-400 text-sm ml-3">All trading decisions (OPEN, STEP UP, CLOSE) are made by Ollama AI every 15 seconds</span>
            <span class="ai-pulse inline-block ml-2 w-2 h-2 rounded-full bg-indigo-500"></span>
        </div>

        <!-- AI Recommendations Panel -->
        <div class="ai-card">
            <div class="flex items-center justify-between mb-3">
                <h3 class="font-bold text-indigo-400">🤖 OLLAMA AI RECOMMENDATIONS</h3>
                <span class="text-[10px] text-slate-500" id="aiLastUpdate">Updating...</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-emerald-400 font-bold">LONG POSITION</span>
                        <span class="text-[10px] text-slate-500">AI Advisor</span>
                    </div>
                    <div id="longRecommendation" class="ai-recommendation hold">🤖 Analyzing market data...</div>
                    <div class="text-[10px] text-slate-500 mt-2" id="longReasoning"></div>
                </div>
                <div>
                    <div class="flex items-center gap-2 mb-2">
                        <span class="text-red-400 font-bold">SHORT POSITION</span>
                        <span class="text-[10px] text-slate-500">AI Advisor</span>
                    </div>
                    <div id="shortRecommendation" class="ai-recommendation hold">🤖 Analyzing market data...</div>
                    <div class="text-[10px] text-slate-500 mt-2" id="shortReasoning"></div>
                </div>
            </div>
            <div class="text-[10px] text-slate-500 mt-3 text-center">
                💡 AI analyzes ROI, market conditions, spread, and wallet equity. Bot ONLY acts on AI recommendations.
            </div>
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
                        <p class="text-xs text-slate-400" id="shibDisplay">0 ${config.symbol.split('-')[0]} per trade</p>
                        <p class="text-xs text-slate-400" id="formulaDisplay">Formula: $${config.walletPerContract.toFixed(8)} wallet = 1 contract at ${config.leverage}x leverage</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-slate-400">Risk Amount (2%)</p>
                        <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                        <p class="text-xs text-slate-400" id="compoundStatus">🟢 Active</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="card mb-8">
            <h3 class="font-bold mb-4">📈 WALLET GROWTH CHART (Compounding Effect)</h3>
            <div class="chart-container">
                <canvas id="walletChart" style="max-height: 280px; width: 100%;"></canvas>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label mb-2">CONFIG</p>
                <p class="text-sm">Base Vol: <span id="configBaseVol">${config.baseVolume}</span></p>
                <p class="text-sm">Multiplier: ${config.multiplier}x</p>
                <p class="text-sm">Step Trigger: <span class="text-red-400">-${config.stepDistancePct}% ROI (AI controlled)</span></p>
                <p class="text-sm">AI Model: ${config.ollamaModel}</p>
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
            </div>
            <div class="card">
                <p class="stat-label mb-2">SHORT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2"></p>
                <p id="sAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="sTarget" class="text-[9px] text-green-400 mt-1"></p>
                <p id="sRealized" class="text-[8px] text-slate-500 mt-1">Realized: $0.00</p>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <div class="overflow-x-auto max-h-96 overflow-y-auto">
                <table class="w-full border-collapse">
                    <thead class="bg-[#0F141C] sticky top-0">
                        <tr>
                            <th class="text-left p-3 text-xs text-slate-500">SIDE</th>
                            <th class="text-left p-3 text-xs text-slate-500">OPEN</th>
                            <th class="text-left p-3 text-xs text-slate-500">CLOSE</th>
                            <th class="text-right p-3 text-xs text-slate-500">STEP</th>
                            <th class="text-right p-3 text-xs text-slate-500">VOL</th>
                            <th class="text-right p-3 text-xs text-slate-500">ENTRY</th>
                            <th class="text-right p-3 text-xs text-slate-500">EXIT</th>
                            <th class="text-right p-3 text-xs text-slate-500">ROI</th>
                            <th class="text-right p-3 text-xs text-slate-500">PNL</th>
                            <th class="text-right p-3 text-xs text-slate-500">FEE</th>
                            <th class="text-left p-3 text-xs text-slate-500">AI REC</th>
                        </tr>
                    </thead>
                    <tbody id="tradesBody">
                        <tr><td colspan="11" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let walletChart = null;
        
        function getRecommendationClass(recommendation) {
            if (recommendation.includes('STEP UP')) return 'step-up';
            if (recommendation.includes('STEP DOWN')) return 'step-down';
            if (recommendation.includes('CLOSE')) return 'close-position';
            if (recommendation.includes('OPEN')) return 'open-position';
            return 'hold';
        }
        
        async function forceSync() {
            const btn = event.target;
            btn.textContent = '🔄 SYNCING...';
            await fetch('/api/force-sync', {method: 'POST'});
            setTimeout(() => btn.textContent = '🔄 FORCE SYNC', 1000);
        }
        
        async function forceAICheck() {
            const btn = event.target;
            btn.textContent = '🤖 AI CHECK...';
            await fetch('/api/force-ai-check', {method: 'POST'});
            setTimeout(() => btn.textContent = '🤖 FORCE AI CHECK', 1000);
        }
        
        async function emergencyClose() {
            if(confirm('⚠️ EMERGENCY: Close ALL positions? This cannot be undone.')) {
                await fetch('/api/close', {method: 'POST'});
                alert('Emergency liquidation initiated');
            }
        }
        
        function formatNumber(num) {
            return parseFloat(num).toFixed(8);
        }
        
        function updateChart(walletHistory) {
            if (!walletHistory || walletHistory.length === 0) return;
            
            const labels = walletHistory.map(h => {
                const date = new Date(h.timestamp);
                return date.toLocaleTimeString();
            });
            const equity = walletHistory.map(h => h.equity);
            const pnlPercent = walletHistory.map(h => h.pnlPercent);
            
            if (walletChart) {
                walletChart.destroy();
            }
            
            const ctx = document.getElementById('walletChart').getContext('2d');
            walletChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Wallet Equity (USDT)',
                            data: equity,
                            borderColor: '#00D1B2',
                            backgroundColor: 'rgba(0, 209, 178, 0.1)',
                            fill: true,
                            tension: 0.4,
                            yAxisID: 'y',
                            pointRadius: 2,
                            pointHoverRadius: 5
                        },
                        {
                            label: 'PnL %',
                            data: pnlPercent,
                            borderColor: '#6366F1',
                            backgroundColor: 'rgba(99, 102, 241, 0.1)',
                            fill: true,
                            tension: 0.4,
                            yAxisID: 'y1',
                            pointRadius: 2,
                            pointHoverRadius: 5
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'top', labels: { color: '#E8EDF2', font: { size: 10 } } },
                        tooltip: { 
                            callbacks: { 
                                label: function(context) { 
                                    return context.dataset.label + ': ' + context.raw.toFixed(8); 
                                } 
                            },
                            bodyColor: '#E8EDF2',
                            backgroundColor: '#131824'
                        }
                    },
                    scales: {
                        y: { 
                            title: { display: true, text: 'USDT', color: '#00D1B2', font: { size: 10 } }, 
                            grid: { color: '#1F2A3E' }, 
                            ticks: { color: '#E8EDF2', font: { size: 9 } }
                        },
                        y1: { 
                            position: 'right', 
                            title: { display: true, text: 'PnL %', color: '#6366F1', font: { size: 10 } }, 
                            grid: { drawOnChartArea: false }, 
                            ticks: { color: '#E8EDF2', font: { size: 9 }, callback: function(v) { return v.toFixed(1) + '%'; } }
                        },
                        x: { 
                            ticks: { color: '#E8EDF2', font: { size: 8 }, maxRotation: 45, minRotation: 45 },
                            grid: { color: '#1F2A3E' }
                        }
                    }
                }
            });
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const totalEquity = data.market.totalEquity || 0;
                const totalPnl = data.market.totalNetGain || 0;
                const pnlPercent = data.market.growthPct || 0;
                
                document.getElementById('totalWallet').textContent = '$' + formatNumber(totalEquity);
                document.getElementById('totalWallet').className = 'stat-number ' + (totalPnl >= 0 ? 'value-positive' : 'value-negative');
                document.getElementById('walletChange').innerHTML = (totalPnl >= 0 ? '↑' : '↓') + ' $' + formatNumber(Math.abs(totalPnl)) + ' (' + (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%)';
                document.getElementById('walletChange').className = 'text-xs ' + (totalPnl >= 0 ? 'value-positive' : 'value-negative');
                
                document.getElementById('totalPnl').textContent = (totalPnl >= 0 ? '+' : '') + '$' + formatNumber(totalPnl);
                document.getElementById('totalPnl').className = 'stat-number ' + (totalPnl >= 0 ? 'value-positive' : 'value-negative');
                document.getElementById('pnlPercent').innerHTML = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
                document.getElementById('pnlPercent').className = 'text-xs ' + (pnlPercent >= 0 ? 'value-positive' : 'value-negative');
                
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl >= 0 ? '+' : '') + '$' + formatNumber(data.market.totalRealizedPnl || 0);
                document.getElementById('realizedPnl').className = 'stat-number ' + (data.market.totalRealizedPnl >= 0 ? 'value-positive' : 'value-negative');
                document.getElementById('feesPaid').innerHTML = 'Fees: $' + formatNumber(data.market.totalFeesPaid || 0);
                
                document.getElementById('peakEquity').innerHTML = 'Peak: $' + formatNumber(data.market.peakEquity || 0);
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + (data.market.maxDrawdown || 0).toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = 'Trades: ' + (data.market.totalTrades || 0);
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + (data.market.winRate || 0) + '%';
                
                document.getElementById('baseVolumeDisplay').innerHTML = 'Base Volume: ' + (data.market.currentBaseVolume || 0).toLocaleString() + ' contract(s)';
                document.getElementById('shibDisplay').innerHTML = (data.market.currentBaseShib || 0).toLocaleString() + ' ${config.symbol.split('-')[0]} per trade';
                document.getElementById('riskAmount').innerHTML = '$' + formatNumber(data.market.currentRiskAmount || 0);
                document.getElementById('configBaseVol').innerHTML = data.market.currentBaseVolume || 0;
                
                if (data.market.walletHistory && data.market.walletHistory.length > 0) {
                    updateChart(data.market.walletHistory);
                }
                
                document.getElementById('spread').textContent = (data.market.spread || 0).toFixed(3) + '%';
                document.getElementById('bidPrice').textContent = (data.market.bid || 0).toFixed(8);
                document.getElementById('askPrice').textContent = (data.market.ask || 0).toFixed(8);
                
                // Update AI Recommendations
                if (data.aiRecommendations) {
                    const longRec = data.aiRecommendations.long;
                    const shortRec = data.aiRecommendations.short;
                    
                    const longDiv = document.getElementById('longRecommendation');
                    longDiv.textContent = longRec.recommendation;
                    longDiv.className = 'ai-recommendation ' + getRecommendationClass(longRec.recommendation);
                    
                    const shortDiv = document.getElementById('shortRecommendation');
                    shortDiv.textContent = shortRec.recommendation;
                    shortDiv.className = 'ai-recommendation ' + getRecommendationClass(shortRec.recommendation);
                    
                    if (longRec.lastUpdate) {
                        document.getElementById('aiLastUpdate').textContent = 'Updated: ' + new Date(longRec.lastUpdate).toLocaleTimeString();
                    }
                    
                    document.getElementById('longReasoning').innerHTML = '🤖 Confidence: ' + (longRec.confidence || 85) + '% | AI Model: ${config.ollamaModel}';
                    document.getElementById('shortReasoning').innerHTML = '🤖 Confidence: ' + (shortRec.confidence || 85) + '% | AI Model: ${config.ollamaModel}';
                }
                
                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                
                if (long) {
                    const roi = parseFloat(long.roi);
                    const roiElem = document.getElementById('lRoi');
                    roiElem.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                    roiElem.className = 'text-2xl font-black ' + (roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('lPnl').textContent = (long.unrealizedUsdt >= 0 ? '+' : '') + (long.unrealizedUsdt || 0).toFixed(8);
                    document.getElementById('lStep').innerHTML = '<span class="step-badge">STEP ' + (long.step || 0) + '</span> | VOL ' + (long.volume || 0);
                    document.getElementById('lAction').textContent = long.lastAction || 'Idle';
                    document.getElementById('lRealized').innerHTML = 'Realized: ' + (long.realizedPnl >= 0 ? '+' : '') + '$' + (long.realizedPnl || 0).toFixed(8);
                    
                    if (long.targetPrice > 0) {
                        document.getElementById('lTarget').innerHTML = '🎯 TP: ' + long.targetPrice.toFixed(8);
                    }
                }
                
                if (short) {
                    const roi = parseFloat(short.roi);
                    const roiElem = document.getElementById('sRoi');
                    roiElem.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                    roiElem.className = 'text-2xl font-black ' + (roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('sPnl').textContent = (short.unrealizedUsdt >= 0 ? '+' : '') + (short.unrealizedUsdt || 0).toFixed(8);
                    document.getElementById('sStep').innerHTML = '<span class="step-badge">STEP ' + (short.step || 0) + '</span> | VOL ' + (short.volume || 0);
                    document.getElementById('sAction').textContent = short.lastAction || 'Idle';
                    document.getElementById('sRealized').innerHTML = 'Realized: ' + (short.realizedPnl >= 0 ? '+' : '') + '$' + (short.realizedPnl || 0).toFixed(8);
                    
                    if (short.targetPrice > 0) {
                        document.getElementById('sTarget').innerHTML = '🎯 TP: ' + short.targetPrice.toFixed(8);
                    }
                }
                
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 20).forEach(t => {
                        const roiVal = parseFloat(t.roi);
                        tradesHtml += '<tr class="border-b border-[#1A212E]">' +
                            '<td class="p-3"><span class="' + (t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400') + ' font-bold">' + t.side + '</span></td>' +
                            '<td class="p-3 text-xs">' + (t.openTime || '--') + '</td>' +
                            '<td class="p-3 text-xs">' + (t.closeTime || '--') + '</td>' +
                            '<td class="p-3 text-right">' + (t.step || 0) + '</td>' +
                            '<td class="p-3 text-right">' + t.volume + '</td>' +
                            '<td class="p-3 text-right mono">' + t.entryPrice + '</td>' +
                            '<td class="p-3 text-right mono">' + t.exitPrice + '</td>' +
                            '<td class="p-3 text-right ' + (roiVal >= 0 ? 'value-positive' : 'value-negative') + '">' + (roiVal >= 0 ? '+' : '') + t.roi + '</td>' +
                            '<td class="p-3 text-right mono ' + (parseFloat(t.netPnlUsdt) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(t.netPnlUsdt) >= 0 ? '+' : '') + t.netPnlUsdt + '</td>' +
                            '<td class="p-3 text-right mono text-slate-500">' + t.estimatedFee + '</td>' +
                            '<td class="p-3 text-left text-[10px]">' + (t.aiRecommendation || 'N/A') + '</td>' +
                        '</tr>';
                    });
                } else {
                    tradesHtml = '<tr><td colspan="11" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
                
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== START SERVER ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    console.log(`\n✅ Martingale Pro AI Started (AI CONTROLLED MODE)`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price movement`);
    console.log(`💰 Auto-Compounding: ${config.riskPercent}% of wallet`);
    console.log(`📐 Formula: $${config.walletPerContract.toFixed(8)} wallet = 1 contract`);
    console.log(`📈 Step Trigger: -${config.stepDistancePct}% ROI (AI CONTROLLED - no automatic steps)`);
    console.log(`🤖 Ollama AI: ${config.ollamaModel} @ ${config.ollamaUrl}`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`\n🎮 AI CONTROL MODE ACTIVE:`);
    console.log(`   • OPEN POSITION: Only when AI recommends`);
    console.log(`   • STEP UP: Only when AI recommends (no automatic martingale)`);
    console.log(`   • CLOSE POSITION: Only when AI recommends`);
    console.log(`   • HOLD: AI recommends no action`);
    console.log(`   • AI checks every 15 seconds\n`);
    console.log(`📊 AUTO-COMPOUNDING EXAMPLES:`);
    console.log(`   Wallet $${config.walletPerContract.toFixed(8)} → 1 contract → Risk $${(config.walletPerContract * 0.02).toFixed(8)}`);
    console.log(`   Wallet $${(config.walletPerContract * 2).toFixed(8)} → 2 contracts → Risk $${(config.walletPerContract * 2 * 0.02).toFixed(8)}`);
    console.log(`   Wallet $${(config.walletPerContract * 3).toFixed(8)} → 3 contracts → Risk $${(config.walletPerContract * 3 * 0.02).toFixed(8)}\n`);
    console.log(`🤖 API Endpoints:`);
    console.log(`   GET  /               - Dashboard`);
    console.log(`   GET  /api/status     - Trading status`);
    console.log(`   POST /api/force-ai-check - Force AI analysis`);
    console.log(`   POST /api/close      - Emergency close`);
    console.log(`   POST /api/force-sync - Force sync positions\n`);
});
