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
    takerFeeRate: 0.00153, // 0.153% per direction (from exchange data)
    pollInterval: 500,
    contractMultiplier: 0.001,
    autoCompound: true,
    riskPercent: 2,
    shibPerContract: 1000,
    walletPerContract: 0.0066135,
    virtualMode: true
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 1000.00,
    startTime: Date.now(),
    lastPriceUpdate: 0,
    walletHistory: [],
    peakEquity: 1000.00,
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

function calculateBaseVolumeFromWallet(totalEquity, currentPrice) {
    if (!config.autoCompound || totalEquity <= 0) {
        return config.baseVolume;
    }
    
    let volume = Math.floor(totalEquity / config.walletPerContract);
    volume = Math.max(1, volume);
    const MAX_VOLUME = 1000000;
    if (volume > MAX_VOLUME) volume = MAX_VOLUME;
    
    const riskAmount = totalEquity * (config.riskPercent / 100);
    const positionUsdt = riskAmount * config.leverage;
    const shibAmount = volume * config.shibPerContract;
    
    market.currentRiskAmount = riskAmount;
    market.currentBaseShib = shibAmount;
    
    console.log(`\n💰 AUTO-COMPOUNDING CALCULATION:`);
    console.log(`   Wallet: $${totalEquity.toFixed(8)}`);
    console.log(`   ${config.riskPercent}% Risk: $${riskAmount.toFixed(8)}`);
    console.log(`   @ ${config.leverage}x → $${positionUsdt.toFixed(8)} position`);
    console.log(`   Volume: ${volume.toLocaleString()} contract(s) = ${shibAmount.toLocaleString()} SHIB`);
    
    return volume;
}

function calculateStepFromVolume(volume, baseVolume, multiplier) {
    if (volume === 0) return 0;
    let totalVolume = 0;
    let step = 0;
    while (totalVolume < volume) {
        const stepVolume = step === 0 ? baseVolume : Math.ceil(baseVolume * Math.pow(multiplier, step));
        totalVolume += stepVolume;
        if (totalVolume <= volume) step++;
        else break;
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
        return state.entryPrice * (1 + (requiredPriceMovePct / 100)) * (1 + config.takerFeeRate);
    } else {
        return state.entryPrice * (1 - (requiredPriceMovePct / 100)) * (1 - config.takerFeeRate);
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
            riskAmount: market.currentRiskAmount
        });
        if (market.walletHistory.length > 100) market.walletHistory.shift();
    }
    if (totalEquity > market.peakEquity) market.peakEquity = totalEquity;
    if (market.peakEquity > 0) {
        const currentDrawdown = ((market.peakEquity - totalEquity) / market.peakEquity) * 100;
        if (currentDrawdown > market.maxDrawdown) market.maxDrawdown = currentDrawdown;
    }
}

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 500.00,
        availableMargin: 500.00,
        initialEquity: 500.00,
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
});

function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp, ...params };
    const sortedParams = Object.keys(allParams).sort().map(key => `${key}=${encodeURIComponent(allParams[key])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedParams].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    return { timestamp, signature, sortedParams };
}

async function htxRequest(account, method, path, data = {}) {
    if (config.virtualMode) {
        console.log(`[VIRTUAL] ${method} ${path} - Skipping real API call`);
        return { status: 'ok', data: [], msg: 'virtual mode' };
    }
    try {
        const { timestamp, signature, sortedParams } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        const options = { method, url, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 };
        if (method === 'POST') options.data = data;
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
    if (config.virtualMode) {
        const now = Date.now();
        if (state.volume > 0 && market.bid > 0 && market.ask > 0) {
            const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
            let priceChangePct, leveragedRoi;
            if (state.direction === 'buy') {
                priceChangePct = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
                leveragedRoi = priceChangePct * config.leverage;
            } else {
                priceChangePct = ((state.entryPrice - currentPrice) / state.entryPrice) * 100;
                leveragedRoi = priceChangePct * config.leverage;
            }
            const positionValue = state.volume * state.entryPrice * config.shibPerContract;
            const currentValue = state.volume * currentPrice * config.shibPerContract;
            let newUnrealizedUsdt;
            if (state.direction === 'buy') newUnrealizedUsdt = currentValue - positionValue;
            else newUnrealizedUsdt = positionValue - currentValue;
            state.roi = leveragedRoi;
            state.unrealizedUsdt = newUnrealizedUsdt;
            state.lastRoiUpdateTime = now;
            state.targetPrice = calculateTargetPrice(state);
        }
        return;
    }
    
    const now = Date.now();
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol, order_id: state.pendingOrderId
        });
        if (orderRes?.data?.[0]?.status === 6 || orderRes?.data?.[0]?.status === 7 || 
            orderRes?.data?.[0]?.status === 4 || orderRes?.data?.[0]?.status === 5) {
            state.pendingOrderId = null;
            state.isLocked = false;
        } else return;
    }
    if (state.isLocked) return;
    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) return;
    lastPositionFetch[acc.accountId] = now;
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos && parseFloat(pos.volume) > 0) {
            state.volume = parseFloat(pos.volume);
            state.entryPrice = parseFloat(pos.cost_open);
            state.unrealizedUsdt = parseFloat(pos.profit);
            state.targetPrice = calculateTargetPrice(state);
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else if (state.volume !== 0) {
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
            state.lastStepPrice = 0; state.startTime = null; state.targetPrice = 0;
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

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalGrossPnl) {
    const step = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
    
    // Calculate fee based on leveraged position value (matching exchange data)
    // Fee = Volume × Entry Price × Leverage × Contract Size × Fee Rate (0.00153 total)
    const leveragedPositionValue = state.volume * state.entryPrice * config.leverage * config.shibPerContract;
    const estimatedFee = leveragedPositionValue * 0.00153; // 0.153% total fee (from exchange data)
    
    // Net PnL = Gross PnL - Fee
    const netPnl = finalGrossPnl - estimatedFee;
    
    // Round to 6 decimal places for display (matching exchange)
    const roundedNetPnl = Math.abs(netPnl) < 0.000001 ? 0 : netPnl;
    
    market.totalTrades++;
    if (roundedNetPnl >= 0) market.winningTrades++;
    else market.losingTrades++;
    market.totalFeesPaid += estimatedFee;
    
    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume.toFixed(4),
        step: step,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        grossProfit: finalGrossPnl.toFixed(8),
        fee: estimatedFee.toFixed(8),
        netPnlUsdt: roundedNetPnl.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
    
    state.realizedPnl += roundedNetPnl;
    state.totalFees += estimatedFee;
    
    console.log(`📊 TRADE CLOSED: ${state.direction.toUpperCase()}`);
    console.log(`   Entry: ${state.entryPrice.toFixed(8)} | Exit: ${exitPrice.toFixed(8)}`);
    console.log(`   Volume: ${state.volume} | Leveraged Value: $${leveragedPositionValue.toFixed(8)}`);
    console.log(`   Gross Profit: $${finalGrossPnl.toFixed(8)} | Fee: $${estimatedFee.toFixed(8)} | Net: ${roundedNetPnl >= 0 ? '+' : ''}$${roundedNetPnl.toFixed(8)}`);
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
                if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
            } catch (e) {}
        });
    });
    ws.on('error', (err) => console.error('WebSocket error:', err.message));
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
            console.log(`🚀 [VIRTUAL] Opening ${state.direction} position at ${currentPrice.toFixed(8)} with ${market.currentBaseVolume} contract(s)`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            if (config.virtualMode) {
                state.volume = market.currentBaseVolume;
                state.entryPrice = currentPrice;
                state.targetPrice = calculateTargetPrice(state);
                state.startTime = new Date().toLocaleString();
                state.lastStepPrice = currentPrice;
                state.isLocked = false;
                console.log(`✅ [VIRTUAL] Position opened at ${state.entryPrice.toFixed(8)}, TP target: ${state.targetPrice.toFixed(8)}`);
                continue;
            }
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: market.currentBaseVolume, direction: state.direction,
                offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Position Opening";
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol, order_id: res.data.order_id_str
                    });
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state);
                        state.isLocked = false;
                    }
                }, 2000);
            } else {
                state.isLocked = false;
                state.lastAction = "Open Failed";
            }
            continue;
        }

        let shouldTakeProfit = false;
        let exitPrice = 0;
        if (state.direction === 'buy') {
            if (market.ask >= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.ask;
            }
        } else {
            if (market.bid <= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.bid;
            }
        }
        
        if (shouldTakeProfit) {
            const finalGrossPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
            console.log(`✅ [VIRTUAL] Taking ${state.direction} profit at ${exitPrice.toFixed(8)} (Target ROI: ${config.takeProfitPct}%, Step ${currentStep})`);
            state.isLocked = true;
            state.lastAction = "Taking Profit...";
            if (config.virtualMode) {
                logTradeExchangeStyle(state, exitPrice, exitTime, config.takeProfitPct, finalGrossPnl);
                const totalEquity = (accountStates[1]?.currentEquity || 0) + (accountStates[2]?.currentEquity || 0);
                const leveragedPositionValue = state.volume * state.entryPrice * config.leverage * config.shibPerContract;
                const estimatedFee = leveragedPositionValue * 0.00153;
                const netPnl = finalGrossPnl - estimatedFee;
                const newTotalEquity = totalEquity + netPnl;
                accountStates[1].currentEquity = newTotalEquity / 2;
                accountStates[2].currentEquity = newTotalEquity / 2;
                accountStates[1].availableMargin = accountStates[1].currentEquity;
                accountStates[2].availableMargin = accountStates[2].currentEquity;
                market.totalNetGain = newTotalEquity - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
                state.lastStepPrice = 0; state.startTime = null; state.targetPrice = 0;
                state.isLocked = false;
                continue;
            }
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, exitPrice, exitTime, config.takeProfitPct, finalGrossPnl);
                state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0;
                state.lastStepPrice = 0; state.startTime = null; state.targetPrice = 0;
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
            }
            continue;
        }

        const currentStep = calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier);
        if (state.roi <= -10 && state.volume > 0) {
            const nextStepNumber = currentStep + 1;
            let nextVol = nextStepNumber === 1 ? Math.ceil(market.currentBaseVolume * config.multiplier) : 
                          Math.ceil(market.currentBaseVolume * Math.pow(config.multiplier, nextStepNumber));
            console.log(`📈 [VIRTUAL] MARTINGALE STEP ${nextStepNumber} for ${state.direction} - ROI: ${state.roi.toFixed(2)}%`);
            state.isLocked = true;
            if (config.virtualMode) {
                const oldTotalValue = state.volume * state.entryPrice;
                const newTotalValue = nextVol * currentPrice;
                const newTotalVolume = state.volume + nextVol;
                const newAvgPrice = (oldTotalValue + newTotalValue) / newTotalVolume;
                state.entryPrice = newAvgPrice;
                state.volume = newTotalVolume;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${nextStepNumber} (Added: ${nextVol}, New Avg: ${newAvgPrice.toFixed(8)})`;
                state.isLocked = false;
                continue;
            }
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVol, direction: state.direction,
                offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${nextStepNumber}`;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
        for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
        const s1 = accountStates[1], s2 = accountStates[2];
        if (s1 && s2 && market.initialTotalEquity > 0) {
            const totalEquity = s1.currentEquity + s2.currentEquity;
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
        if (market.status === 'Active') await processMartingale();
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

app.get('/api/status', (req, res) => {
    const s1 = accountStates[1], s2 = accountStates[2];
    const totalEquity = (s1?.currentEquity || 0) + (s2?.currentEquity || 0);
    const accountsWithInfo = Object.values(accountStates).map(state => ({
        direction: state.direction, roi: state.roi, volume: state.volume,
        step: calculateStepFromVolume(state.volume, market.currentBaseVolume, config.multiplier),
        unrealizedUsdt: state.unrealizedUsdt, entryPrice: state.entryPrice,
        lastAction: state.lastAction, startTime: state.startTime, targetPrice: state.targetPrice,
        currentEquity: state.currentEquity, realizedPnl: state.realizedPnl, totalFees: state.totalFees
    }));
    res.json({ market: { ...market, totalEquity }, accounts: accountsWithInfo, tradeHistory, config });
});

app.post('/api/close', async (req, res) => {
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0 && config.virtualMode) {
            s.volume = 0; s.roi = 0; s.unrealizedUsdt = 0; s.entryPrice = 0;
            s.lastStepPrice = 0; s.startTime = null; s.targetPrice = 0;
        }
    }
    res.json({ status: 'ok' });
});

app.post('/api/force-sync', async (req, res) => {
    for (const acc of config.accounts) await syncAccount(acc, accountStates[acc.accountId]);
    res.json({ status: 'ok' });
});

app.get('/api/wallet-history', (req, res) => {
    res.json({ history: market.walletHistory, trades: tradeHistory.slice(0, 20) });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Martingale Pro - VIRTUAL MODE</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0A0E17; color: #E8EDF2; font-family: monospace; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .stat-number { font-size: 28px; font-weight: 900; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <h1 class="text-3xl font-black mb-4">MARTINGALE PRO - VIRTUAL MODE</h1>
        <div class="card mb-4">
            <div class="grid grid-cols-4 gap-4">
                <div><p class="text-slate-400 text-sm">TOTAL WALLET</p><p id="wallet" class="stat-number value-positive">$1000.00</p></div>
                <div><p class="text-slate-400 text-sm">TOTAL P&L</p><p id="pnl" class="stat-number">$0.00</p></div>
                <div><p class="text-slate-400 text-sm">TOTAL FEES</p><p id="fees" class="stat-number">$0.00</p></div>
                <div><p class="text-slate-400 text-sm">WIN RATE</p><p id="winrate" class="stat-number">0%</p></div>
            </div>
        </div>
        <div class="card">
            <h3 class="font-bold mb-4">📋 TRADE HISTORY (Format: SIDE | VOL | ENTRY | EXIT | ROI | GROSS | FEE | NET)</h3>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="text-slate-400">
                        <tr><th>SIDE</th><th>VOL</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>GROSS</th><th>FEE</th><th>NET</th></tr>
                    </thead>
                    <tbody id="trades"></tbody>
                </table>
            </div>
        </div>
    </div>
    <script>
        function formatNum(n) { return parseFloat(n).toFixed(8); }
        setInterval(async () => {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('wallet').innerHTML = '$' + formatNum(data.market.totalEquity);
            document.getElementById('pnl').innerHTML = (data.market.totalNetGain >= 0 ? '+' : '') + '$' + formatNum(data.market.totalNetGain);
            document.getElementById('fees').innerHTML = '$' + formatNum(data.market.totalFeesPaid);
            document.getElementById('winrate').innerHTML = data.market.winRate + '%';
            let html = '';
            data.tradeHistory.slice(0, 20).forEach(t => {
                html += '<tr><td class="' + (t.side === 'LONG' ? 'text-green-400' : 'text-red-400') + '">' + t.side + 
                        '</td><td>' + t.volume + '</td><td class="mono">' + t.entryPrice + 
                        '</td><td class="mono">' + t.exitPrice + '</td><td class="' + (parseFloat(t.roi) >= 0 ? 'value-positive' : 'value-negative') + '">' + t.roi + 
                        '</td><td class="' + (parseFloat(t.grossProfit) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(t.grossProfit) >= 0 ? '+' : '') + t.grossProfit +
                        '</td><td class="text-red-400">-' + t.fee +
                        '</td><td class="' + (parseFloat(t.netPnlUsdt) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(t.netPnlUsdt) >= 0 ? '+' : '') + t.netPnlUsdt + '</td></tr>';
            });
            document.getElementById('trades').innerHTML = html || '<tr><td colspan="8" class="text-center p-8">No trades yet</td></tr>';
        }, 1000);
    </script>
</body>
</html>
    `);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro - VIRTUAL MODE`);
    console.log(`💰 Starting Balance: $1000.00`);
    console.log(`📊 Fee Rate: 0.153% per direction (0.306% total) from exchange data`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
