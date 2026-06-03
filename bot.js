require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== PAPER TRADING MODE ====================
const PAPER_TRADING = true;

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
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    symbolClean: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase().replace('-', ''),
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
    // CORRECTED: At $0.00000525/SHIB, 1 contract = $0.00525 position value
    // At 75x leverage, margin per contract = $0.00525 / 75 = $0.00007
    // For $20 risk, we can open: $20 / $0.00007 = ~285,714 contracts
    walletPerContract: 0.00007  // FIXED: ~$0.00007 margin per contract at 75x
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
    lastBaseUpdate: Date.now()
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};

// ==================== PAPER TRADING STATE ====================
let paperWallet = {
    totalEquity: 1000,
    initialEquity: 1000,
    lastUpdate: Date.now()
};

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    // CORRECTED FORMULA:
    // Each contract requires $0.00007 margin at 75x leverage
    // With 2% risk ($20 on $1000), we can open: $20 ÷ $0.00007 = ~285,714 contracts
    let volume = Math.floor(totalEquity / config.walletPerContract);
    
    volume = Math.max(1, volume);
    
    const MAX_VOLUME = 1000000;
    if (volume > MAX_VOLUME) {
        volume = MAX_VOLUME;
    }
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    const positionUsdt = volume * config.shibPerContract * currentPrice;
    const shibAmount = volume * config.shibPerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseShib = shibAmount;
    
    console.log(`\n💰 AUTO-COMPOUNDING CALCULATION:`);
    console.log(`   Wallet: $${totalEquity.toFixed(2)}`);
    console.log(`   ${config.riskPercent}% Risk: $${riskAmount.toFixed(2)}`);
    console.log(`   @ ${config.leverage}x leverage`);
    console.log(`   Current price: $${currentPrice.toFixed(8)}/SHIB`);
    console.log(`   Per contract: ${config.shibPerContract.toLocaleString()} SHIB = $${(config.shibPerContract * currentPrice).toFixed(8)} position`);
    console.log(`   Margin per contract: $${config.walletPerContract.toFixed(8)}`);
    console.log(`   Volume: ${volume.toLocaleString()} contract(s) = ${shibAmount.toLocaleString()} SHIB`);
    console.log(`   Total position: $${positionUsdt.toFixed(2)}`);
    console.log(`   Total margin needed: $${(volume * config.walletPerContract).toFixed(2)}\n`);
    
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

function calculateTargetPrice(state) {
    const requiredPriceMovePct = config.takeProfitPct / config.leverage;
    
    if (state.direction === 'buy') {
        const targetPrice = state.entryPrice * (1 + (requiredPriceMovePct / 100));
        return targetPrice;
    } else {
        const targetPrice = state.entryPrice * (1 - (requiredPriceMovePct / 100));
        return targetPrice;
    }
}

function updateWalletGrowth(totalEquity) {
    const now = Date.now();
    
    const lastRecord = market.walletHistory[market.walletHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000 || Math.abs(lastRecord.equity - totalEquity) > 0.01) {
        market.walletHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            equity: totalEquity,
            pnl: totalEquity - market.initialTotalEquity,
            pnlPercent: market.initialTotalEquity > 0 ? ((totalEquity - market.initialTotalEquity) / market.initialTotalEquity) * 100 : 0,
            baseVolume: market.currentBaseVolume,
            baseShib: market.currentBaseShib,
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

// Initialize account states with PROPER margin values
config.accounts.forEach((account, idx) => {
    const initialPerAccount = PAPER_TRADING ? (paperWallet.totalEquity / config.accounts.length) : 1000;
    
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, 
        volume: 0, 
        unrealizedUsdt: 0, 
        entryPrice: 0,
        currentEquity: initialPerAccount,
        availableMargin: initialPerAccount, // CRITICAL: Initialize available margin
        initialEquity: initialPerAccount,
        isLocked: false,
        pendingOrderId: null,
        lastAction: 'Idle',
        lastStepPrice: 0, 
        lastAddedVolume: 0, 
        startTime: null,
        lastExchangeRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0,
        realizedPnl: 0,
        totalFees: 0
    };
});

// ==================== PAPER TRADING SIMULATION ====================
function simulateOrderExecution(account, state, action, volume, price) {
    // Calculate properly: each contract = 1000 SHIB
    const positionValue = volume * config.shibPerContract * price;
    const requiredMargin = positionValue / config.leverage;
    const fee = positionValue * config.takerFeeRate;
    
    console.log(`\n📊 PAPER SIM: ${action.toUpperCase()} ${volume.toLocaleString()} contracts @ $${price.toFixed(8)}`);
    console.log(`   Position value: $${positionValue.toFixed(2)}`);
    console.log(`   Margin required: $${requiredMargin.toFixed(2)}`);
    console.log(`   Available margin: $${state.availableMargin.toFixed(2)}`);
    console.log(`   Fee estimate: $${fee.toFixed(4)}`);
    
    if (action === 'open') {
        if (state.availableMargin < requiredMargin) {
            console.log(`❌ PAPER: Insufficient margin - Need $${requiredMargin.toFixed(2)}, Have $${state.availableMargin.toFixed(2)}`);
            return { success: false, error: 'Insufficient margin' };
        }
        
        // Deduct margin
        state.availableMargin -= requiredMargin;
        
        // Update position (average for martingale)
        if (state.volume === 0) {
            state.volume = volume;
            state.entryPrice = price;
        } else {
            const totalValue = (state.volume * state.entryPrice) + (volume * price);
            state.volume += volume;
            state.entryPrice = totalValue / state.volume;
        }
        
        console.log(`✅ PAPER OPENED: ${state.direction.toUpperCase()}`);
        console.log(`   Total volume: ${state.volume.toLocaleString()} contracts`);
        console.log(`   Avg entry: $${state.entryPrice.toFixed(8)}`);
        console.log(`   Margin used: $${requiredMargin.toFixed(2)}`);
        console.log(`   Remaining margin: $${state.availableMargin.toFixed(2)}\n`);
        
    } else if (action === 'close') {
        // Calculate PnL
        const closeValue = state.volume * config.shibPerContract * price;
        const openValue = state.volume * config.shibPerContract * state.entryPrice;
        
        let pnl = 0;
        if (state.direction === 'buy') {
            pnl = closeValue - openValue;
        } else {
            pnl = openValue - closeValue;
        }
        
        const netPnl = pnl - fee;
        
        // Return margin
        const usedMargin = openValue / config.leverage;
        state.availableMargin += usedMargin + netPnl;
        
        // Update paper wallet total equity
        paperWallet.totalEquity += netPnl;
        
        console.log(`✅ PAPER CLOSED: ${state.direction.toUpperCase()}`);
        console.log(`   Volume: ${state.volume.toLocaleString()} contracts`);
        console.log(`   Entry: $${state.entryPrice.toFixed(8)} → Exit: $${price.toFixed(8)}`);
        console.log(`   PnL: $${netPnl.toFixed(2)} (${((netPnl / usedMargin) * 100).toFixed(2)}% ROI)`);
        console.log(`   New wallet: $${paperWallet.totalEquity.toFixed(2)}\n`);
        
        return { success: true, pnl: netPnl, fee: fee };
    }
    
    return { success: true };
}

function updatePaperPositions() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0 && market.bid > 0 && market.ask > 0) {
            const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
            
            // Calculate unrealized PnL
            const currentValue = state.volume * config.shibPerContract * currentPrice;
            const entryValue = state.volume * config.shibPerContract * state.entryPrice;
            
            let unrealizedPnl = 0;
            if (state.direction === 'buy') {
                unrealizedPnl = currentValue - entryValue;
            } else {
                unrealizedPnl = entryValue - currentValue;
            }
            
            // Calculate ROI based on margin used
            const usedMargin = entryValue / config.leverage;
            const roi = usedMargin > 0 ? (unrealizedPnl / usedMargin) * 100 : 0;
            
            state.unrealizedUsdt = unrealizedPnl;
            state.roi = roi;
            state.targetPrice = calculateTargetPrice(state);
        }
    }
}

// ==================== HTX API FUNCTIONS ====================
async function getSignature(account, method, path, params = {}) {
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
    if (PAPER_TRADING && (path.includes('/swap_cross_order') || path.includes('/swap_cross_order_info') || 
                          path.includes('/swap_cross_position_info') || path.includes('/swap_cross_account_info'))) {
        
        const state = accountStates[account.accountId];
        
        if (path.includes('/swap_cross_order')) {
            const orderId = `paper_${Date.now()}_${Math.random()}`;
            const volume = data.volume;
            const offset = data.offset;
            const currentPrice = data.direction === 'buy' ? market.ask : market.bid;
            
            if (offset === 'open') {
                const result = simulateOrderExecution(account, state, 'open', volume, currentPrice);
                if (result.success) {
                    return { status: 'ok', data: { order_id_str: orderId } };
                }
                return { status: 'error', msg: result.error };
            } else if (offset === 'close') {
                const result = simulateOrderExecution(account, state, 'close', volume, currentPrice);
                if (result.success) {
                    return { status: 'ok', data: { order_id_str: orderId } };
                }
                return { status: 'error', msg: result.error };
            }
        }
        
        if (path.includes('/swap_cross_order_info')) {
            return {
                status: 'ok',
                data: [{
                    status: 6,
                    price_avg: state.entryPrice || market.bid,
                    volume: state.volume
                }]
            };
        }
        
        if (path.includes('/swap_cross_position_info')) {
            if (state.volume > 0) {
                return {
                    status: 'ok',
                    data: [{
                        direction: state.direction,
                        volume: state.volume.toString(),
                        cost_open: state.entryPrice.toString(),
                        profit: state.unrealizedUsdt.toString(),
                        profit_rate: (state.roi / 100).toString()
                    }]
                };
            }
            return { status: 'ok', data: [] };
        }
        
        if (path.includes('/swap_cross_account_info')) {
            return {
                status: 'ok',
                data: [{
                    margin_balance: state.currentEquity.toString(),
                    withdraw_available: state.availableMargin.toString()
                }]
            };
        }
    }
    
    // Real API call (bypass in paper mode)
    return { status: 'ok', data: [] };
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
        if (orderRes?.data?.[0]?.status === 6) {
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
        const pos = posRes.data.find(p => p.direction === state.direction);
        
        if (pos && parseFloat(pos.volume) > 0) {
            state.volume = parseFloat(pos.volume);
            state.entryPrice = parseFloat(pos.cost_open);
            state.unrealizedUsdt = parseFloat(pos.profit);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.targetPrice = calculateTargetPrice(state);
            
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else if (state.volume !== 0) {
            console.log(`✅ [${state.direction.toUpperCase()}] Position closed`);
            state.volume = 0;
            state.roi = 0;
            state.unrealizedUsdt = 0;
            state.entryPrice = 0;
            state.startTime = null;
            state.targetPrice = 0;
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
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
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
        netPnlUsdt: finalPnl.toFixed(2),
        estimatedFee: estimatedFee.toFixed(4)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
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
                    
                    if (PAPER_TRADING) {
                        updatePaperPositions();
                    }
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
            
            console.log(`\n🚀 Opening ${state.direction} position with ${market.currentBaseVolume.toLocaleString()} contracts @ $${currentPrice.toFixed(8)}`);
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
                        state.entryPrice = currentPrice;
                        state.targetPrice = calculateTargetPrice(state);
                        console.log(`✅ Position opened at $${state.entryPrice.toFixed(8)}, TP target: $${state.targetPrice.toFixed(8)}`);
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
                console.log(`\n🎯 LONG TP triggered! ASK: $${market.ask.toFixed(8)} >= Target: $${state.targetPrice.toFixed(8)}`);
            }
        } else {
            if (market.bid <= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.bid;
                console.log(`\n🎯 SHORT TP triggered! BID: $${market.bid.toFixed(8)} <= Target: $${state.targetPrice.toFixed(8)}`);
            }
        }
        
        if (shouldTakeProfit) {
            const finalRoi = config.takeProfitPct;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            
            console.log(`\n✅ Taking ${state.direction} profit at $${exitPrice.toFixed(8)}`);
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
        
        // Martingale step at -10% ROI
        if (state.roi <= -10 && state.volume > 0) {
            const nextStepNumber = currentStep + 1;
            let nextVol;
            
            if (nextStepNumber === 1) {
                nextVol = Math.ceil(market.currentBaseVolume * config.multiplier);
            } else {
                nextVol = Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            }
            
            console.log(`\n📈 MARTINGALE STEP ${nextStepNumber} for ${state.direction}`);
            console.log(`   Current ROI: ${state.roi.toFixed(2)}%`);
            console.log(`   Current volume: ${state.volume.toLocaleString()} contracts`);
            console.log(`   Adding: ${nextVol.toLocaleString()} contracts`);
            
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
                state.lastAction = `Martingale Step ${nextStepNumber} (-${Math.abs(state.roi).toFixed(1)}% loss, Added: ${nextVol.toLocaleString()})`;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        } else {
            const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            state.lastAction = `Active - Step ${step} | Vol: ${state.volume.toLocaleString()} | ROI: ${state.roi.toFixed(2)}%`;
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
                if (PAPER_TRADING) {
                    market.initialTotalEquity = paperWallet.initialEquity;
                    market.peakEquity = market.initialTotalEquity;
                    console.log(`\n💰 PAPER TRADING - INITIAL TOTAL EQUITY: $${market.initialTotalEquity.toFixed(2)} USDT\n`);
                } else {
                    market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                    market.peakEquity = market.initialTotalEquity;
                    console.log(`\n💰 INITIAL TOTAL EQUITY: $${market.initialTotalEquity.toFixed(2)} USDT\n`);
                }
            }
            
            if (market.initialTotalEquity > 0) {
                const totalEquity = PAPER_TRADING ? paperWallet.totalEquity : (s1.currentEquity + s2.currentEquity);
                const totalRealizedPnl = s1.realizedPnl + s2.realizedPnl;
                const totalFees = s1.totalFees + s2.totalFees;
                
                market.totalNetGain = totalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedHours = (Date.now() - market.startTime) / (1000 * 60 * 60);
                market.dgr = elapsedHours > 0 ? (market.growthPct / elapsedHours) : 0;
                
                if (config.autoCompound && market.bid > 0) {
                    const newBaseVolume = calculateBaseVolumeFromWallet(totalEquity, market.bid);
                    if (newBaseVolume !== market.currentBaseVolume) {
                        console.log(`📈 AUTO-COMPOUND: Base volume updated: ${market.currentBaseVolume.toLocaleString()} → ${newBaseVolume.toLocaleString()} contracts`);
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
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// ==================== EXPRESS ROUTES ====================
app.get('/api/status', (req, res) => {
    const s1 = accountStates[1];
    const s2 = accountStates[2];
    const totalEquity = PAPER_TRADING ? paperWallet.totalEquity : ((s1?.currentEquity || 0) + (s2?.currentEquity || 0));
    const totalRealizedPnl = (s1?.realizedPnl || 0) + (s2?.realizedPnl || 0);
    const totalFees = (s1?.totalFees || 0) + (s2?.totalFees || 0);
    
    const accountsWithInfo = Object.values(accountStates).map(state => {
        const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        return {
            direction: state.direction,
            roi: state.roi,
            volume: state.volume,
            step: step,
            unrealizedUsdt: state.unrealizedUsdt,
            entryPrice: state.entryPrice,
            lastAction: state.lastAction,
            startTime: state.startTime,
            targetPrice: state.targetPrice,
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
            currentBaseShib: market.currentBaseShib,
            currentRiskAmount: market.currentRiskAmount,
            shibPerContract: config.shibPerContract,
            walletPerContract: config.walletPerContract
        },
        accounts: accountsWithInfo,
        tradeHistory,
        config: {
            maxStartSpread: config.maxStartSpread,
            takeProfitPct: config.takeProfitPct,
            leverage: config.leverage,
            pollInterval: config.pollInterval,
            baseVolume: market.currentBaseVolume,
            multiplier: config.multiplier,
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            walletPerContract: config.walletPerContract
        }
    });
});

app.post('/api/close', async (req, res) => {
    console.log("\n🔴 EMERGENCY CLOSE INITIATED");
    market.status = "LIQUIDATING";
    
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            console.log(`Closing ${s.direction} position (${s.volume.toLocaleString()} contracts)...`);
            
            if (PAPER_TRADING) {
                const currentPrice = s.direction === 'buy' ? market.bid : market.ask;
                await simulateOrderExecution(acc, s, 'close', s.volume, currentPrice);
                s.volume = 0;
                s.roi = 0;
                s.unrealizedUsdt = 0;
                s.entryPrice = 0;
                s.startTime = null;
                s.targetPrice = 0;
            }
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

app.post('/api/reset-paper', (req, res) => {
    if (!PAPER_TRADING) {
        return res.json({ status: 'error', message: 'Only available in paper trading mode' });
    }
    
    paperWallet = {
        totalEquity: 1000,
        initialEquity: 1000,
        lastUpdate: Date.now()
    };
    
    // Reset account states
    config.accounts.forEach((account, idx) => {
        const initialPerAccount = paperWallet.totalEquity / config.accounts.length;
        
        accountStates[account.accountId] = {
            direction: idx === 0 ? 'buy' : 'sell',
            roi: 0, 
            volume: 0, 
            unrealizedUsdt: 0, 
            entryPrice: 0,
            currentEquity: initialPerAccount,
            availableMargin: initialPerAccount,
            initialEquity: initialPerAccount,
            isLocked: false,
            pendingOrderId: null,
            lastAction: 'Idle',
            lastStepPrice: 0, 
            lastAddedVolume: 0, 
            startTime: null,
            lastExchangeRoi: 0,
            roiLatencyMs: 0,
            roiLatencyHistory: [],
            lastRoiUpdateTime: Date.now(),
            targetPrice: 0,
            realizedPnl: 0,
            totalFees: 0
        };
    });
    
    market = {
        ...market,
        totalNetGain: 0, 
        growthPct: 0, 
        dgr: 0,
        initialTotalEquity: 1000, 
        startTime: Date.now(),
        walletHistory: [],
        peakEquity: 1000,
        maxDrawdown: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalFeesPaid: 0
    };
    
    tradeHistory = [];
    
    console.log("🔄 Paper trading wallet reset to $1000");
    res.json({ status: 'ok', message: 'Paper wallet reset to $1000' });
});

app.get('/api/wallet-history', (req, res) => {
    res.json({
        currentWallet: {
            totalEquity: PAPER_TRADING ? paperWallet.totalEquity : 0,
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

// ==================== HTML DASHBOARD ====================
app.get('/', (req, res) => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Paper Trading</title>
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
        .wallet-card { background: linear-gradient(135deg, #1A212E 0%, #131824 100%); border: 1px solid #00D1B240; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .chart-container { position: relative; height: 280px; width: 100%; }
        .compound-info { background: #00D1B210; border: 1px solid #00D1B230; border-radius: 8px; padding: 12px; margin-top: 10px; }
        .paper-badge { background: #F59E0B20; border: 1px solid #F59E0B; color: #F59E0B; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
        .reset-btn { background: #6366F120; border-color: #6366F1; color: #6366F1; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span> 
                    <span class="text-xs bg-yellow-500/20 text-yellow-500 px-2 py-1 rounded">📝 PAPER TRADING</span>
                </h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-yellow-500">SIMULATED</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price move</span>
                </div>
            </div>
            <div>
                <button onclick="resetPaperWallet()" class="reset-btn mr-2">🔄 RESET WALLET</button>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <div class="wallet-card rounded-2xl p-6 mb-8">
            <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
                <div>
                    <p class="stat-label">TOTAL WALLET (PAPER)</p>
                    <p id="totalWallet" class="stat-number value-positive">$0.00</p>
                    <p id="walletChange" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">TOTAL P&L</p>
                    <p id="totalPnl" class="stat-number">$0.00</p>
                    <p id="pnlPercent" class="text-xs"></p>
                </div>
                <div>
                    <p class="stat-label">REALIZED P&L</p>
                    <p id="realizedPnl" class="stat-number">$0.00</p>
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
                        <p class="text-xs text-slate-400" id="shibDisplay">0 SHIB per trade</p>
                        <p class="text-xs text-slate-400">Formula: $${config.walletPerContract.toFixed(8)} margin = 1 contract at ${config.leverage}x leverage</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-slate-400">Risk Amount (${config.riskPercent}%)</p>
                        <p class="text-sm font-bold" id="riskAmount">$0.00</p>
                        <p class="text-xs text-slate-400" id="compoundStatus">🟢 Active</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="card mb-8">
            <h3 class="font-bold mb-4">📈 WALLET GROWTH CHART</h3>
            <div class="chart-container">
                <canvas id="walletChart"></canvas>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label mb-2">CONFIG</p>
                <p class="text-sm">Base Vol: <span id="configBaseVol">${config.baseVolume}</span></p>
                <p class="text-sm">Multiplier: ${config.multiplier}x</p>
                <p class="text-sm">Step Trigger: <span class="text-red-400">-${config.stepDistancePct}% ROI</span></p>
                <p class="text-xs text-yellow-500 mt-2">📝 Paper Trading Mode</p>
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
                <p id="lPnl" class="text-sm mono mt-1">$0.00</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2"></p>
                <p id="lAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="lTarget" class="text-[9px] text-green-400 mt-1"></p>
                <p id="lRealized" class="text-[8px] text-slate-500 mt-1">Realized: $0.00</p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">SHORT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00</p>
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
                        </tr>
                    </thead>
                    <tbody id="tradesBody">
                        <tr><td colspan="9" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let walletChart = null;
        
        async function forceSync() {
            await fetch('/api/force-sync', {method: 'POST'});
        }
        
        async function emergencyClose() {
            if(confirm('Close ALL positions?')) {
                await fetch('/api/close', {method: 'POST'});
                alert('Emergency liquidation initiated');
            }
        }
        
        async function resetPaperWallet() {
            if(confirm('Reset paper wallet to $1000?')) {
                await fetch('/api/reset-paper', {method: 'POST'});
                alert('Paper wallet reset to $1000');
                location.reload();
            }
        }
        
        function updateChart(walletHistory) {
            if (!walletHistory || walletHistory.length === 0) return;
            
            const labels = walletHistory.map(h => new Date(h.timestamp).toLocaleTimeString());
            const equity = walletHistory.map(h => h.equity);
            
            if (walletChart) walletChart.destroy();
            
            const ctx = document.getElementById('walletChart').getContext('2d');
            walletChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Wallet Equity (USDT)',
                        data: equity,
                        borderColor: '#00D1B2',
                        backgroundColor: 'rgba(0, 209, 178, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: { labels: { color: '#E8EDF2' } }
                    },
                    scales: {
                        y: { grid: { color: '#1F2A3E' }, ticks: { color: '#E8EDF2' } },
                        x: { ticks: { color: '#E8EDF2', maxRotation: 45 } }
                    }
                }
            });
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('totalWallet').textContent = '$' + data.market.totalEquity.toFixed(2);
                document.getElementById('walletChange').innerHTML = (data.market.totalNetGain >= 0 ? '↑' : '↓') + ' $' + Math.abs(data.market.totalNetGain).toFixed(2) + ' (' + (data.market.growthPct >= 0 ? '+' : '') + data.market.growthPct.toFixed(2) + '%)';
                document.getElementById('totalPnl').textContent = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + data.market.totalNetGain.toFixed(2);
                document.getElementById('pnlPercent').innerHTML = (data.market.growthPct >= 0 ? '+' : '') + data.market.growthPct.toFixed(2) + '%';
                document.getElementById('realizedPnl').textContent = (data.market.totalRealizedPnl >= 0 ? '+' : '') + '$' + data.market.totalRealizedPnl.toFixed(2);
                document.getElementById('feesPaid').innerHTML = 'Fees: $' + data.market.totalFeesPaid.toFixed(4);
                document.getElementById('peakEquity').innerHTML = 'Peak: $' + data.market.peakEquity.toFixed(2);
                document.getElementById('maxDrawdown').innerHTML = 'DD: ' + data.market.maxDrawdown.toFixed(2) + '%';
                document.getElementById('tradeStats').innerHTML = 'Trades: ' + data.market.totalTrades;
                document.getElementById('winRate').innerHTML = 'Win Rate: ' + data.market.winRate + '%';
                document.getElementById('baseVolumeDisplay').innerHTML = 'Base Volume: ' + (data.market.currentBaseVolume || 0).toLocaleString() + ' contracts';
                document.getElementById('shibDisplay').innerHTML = (data.market.currentBaseShib || 0).toLocaleString() + ' SHIB per trade';
                document.getElementById('riskAmount').innerHTML = '$' + data.market.currentRiskAmount.toFixed(2);
                document.getElementById('configBaseVol').innerHTML = data.market.currentBaseVolume.toLocaleString();
                document.getElementById('spread').textContent = data.market.spread.toFixed(3) + '%';
                document.getElementById('bidPrice').textContent = data.market.bid.toFixed(8);
                document.getElementById('askPrice').textContent = data.market.ask.toFixed(8);
                
                if (data.market.walletHistory && data.market.walletHistory.length > 0) {
                    updateChart(data.market.walletHistory);
                }
                
                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                
                if (long) {
                    document.getElementById('lRoi').textContent = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(2) + '%';
                    document.getElementById('lRoi').className = 'text-2xl font-black ' + (long.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('lPnl').textContent = (long.unrealizedUsdt >= 0 ? '+' : '') + '$' + long.unrealizedUsdt.toFixed(2);
                    document.getElementById('lStep').innerHTML = '<span class="step-badge">STEP ' + long.step + '</span> | VOL ' + long.volume.toLocaleString();
                    document.getElementById('lAction').textContent = long.lastAction;
                    document.getElementById('lRealized').innerHTML = 'Realized: ' + (long.realizedPnl >= 0 ? '+' : '') + '$' + long.realizedPnl.toFixed(2);
                    if (long.targetPrice > 0) {
                        document.getElementById('lTarget').innerHTML = '🎯 TP: ' + long.targetPrice.toFixed(8);
                    }
                }
                
                if (short) {
                    document.getElementById('sRoi').textContent = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(2) + '%';
                    document.getElementById('sRoi').className = 'text-2xl font-black ' + (short.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('sPnl').textContent = (short.unrealizedUsdt >= 0 ? '+' : '') + '$' + short.unrealizedUsdt.toFixed(2);
                    document.getElementById('sStep').innerHTML = '<span class="step-badge">STEP ' + short.step + '</span> | VOL ' + short.volume.toLocaleString();
                    document.getElementById('sAction').textContent = short.lastAction;
                    document.getElementById('sRealized').innerHTML = 'Realized: ' + (short.realizedPnl >= 0 ? '+' : '') + '$' + short.realizedPnl.toFixed(2);
                    if (short.targetPrice > 0) {
                        document.getElementById('sTarget').innerHTML = '🎯 TP: ' + short.targetPrice.toFixed(8);
                    }
                }
                
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.forEach(t => {
                        tradesHtml += '<tr class="border-b border-[#1A212E]">' +
                            '<td class="p-3"><span class="' + (t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400') + ' font-bold">' + t.side + '</span></td>' +
                            '<td class="p-3 text-xs">' + (t.openTime || '--') + '</td>' +
                            '<td class="p-3 text-xs">' + (t.closeTime || '--') + '</td>' +
                            '<td class="p-3 text-right">' + t.step + '</td>' +
                            '<td class="p-3 text-right">' + parseInt(t.volume).toLocaleString() + '</td>' +
                            '<td class="p-3 text-right mono">' + t.entryPrice + '</td>' +
                            '<td class="p-3 text-right mono">' + t.exitPrice + '</td>' +
                            '<td class="p-3 text-right ' + (parseFloat(t.roi) >= 0 ? 'value-positive' : 'value-negative') + '">' + t.roi + '</td>' +
                            '<td class="p-3 text-right mono ' + (parseFloat(t.netPnlUsdt) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(t.netPnlUsdt) >= 0 ? '+' : '') + '$' + Math.abs(parseFloat(t.netPnlUsdt)).toFixed(2) + '</td>' +
                        '</tr>';
                    });
                } else {
                    tradesHtml = '<tr><td colspan="9" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
                
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== STARTUP ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);

app.listen(config.port, '0.0.0.0', () => {
    const requiredPriceMovePct = (config.takeProfitPct / config.leverage).toFixed(3);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ MARTINGALE PRO - PAPER TRADING MODE`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}% ROI = ${requiredPriceMovePct}% price movement`);
    console.log(`💰 Auto-Compounding: ${config.riskPercent}% of wallet`);
    console.log(`📐 Margin per contract: $${config.walletPerContract.toFixed(8)} at ${config.leverage}x`);
    console.log(`📈 Step Trigger: -${config.stepDistancePct}% ROI (adds martingale when losing)`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`🔄 Use "RESET WALLET" button to restart paper trading\n`);
});
