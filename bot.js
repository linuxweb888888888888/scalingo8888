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
    stepDistancePct: 0.2,
    takeProfitPct: 15,
    maxStartSpread: parseFloat(process.env.MAX_START_SPREAD) || 0.2,
    takerFeeRate: 0.0005,
    pollInterval: 500,
    contractMultiplier: 0.001
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0
};

let tradeHistory = [];
let accountStates = {};
let lastPositionFetch = {};
let lastBalanceFetch = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false,
        pendingOrderId: null,
        lastAction: 'Idle',
        step: 0, lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastExchangeRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        targetPrice: 0  // Store target take profit price
    };
});

// ==================== HTX API CORE ====================
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
    } catch (e) {
        // Silent fail
    }
}

// Calculate exact take profit target price using order book
function calculateTargetPrice(state, currentPrice) {
    if (state.direction === 'buy') {
        // For LONG: Need to exit when ASK price reaches target
        // Target = entry price × (1 + takeProfit%)
        const targetPrice = state.entryPrice * (1 + (config.takeProfitPct / 100));
        // Adjust for fees (add fee since you pay when selling)
        const feeAdjustedTarget = targetPrice * (1 + config.takerFeeRate);
        
        console.log(`[LONG TP Calc] Entry: ${state.entryPrice.toFixed(8)}, Target: ${targetPrice.toFixed(8)}, Fee Adj: ${feeAdjustedTarget.toFixed(8)}`);
        return feeAdjustedTarget;
    } else {
        // For SHORT: Need to exit when BID price reaches target
        // Target = entry price × (1 - takeProfit%)
        const targetPrice = state.entryPrice * (1 - (config.takeProfitPct / 100));
        // Adjust for fees (subtract fee since you pay when buying to close)
        const feeAdjustedTarget = targetPrice * (1 - config.takerFeeRate);
        
        console.log(`[SHORT TP Calc] Entry: ${state.entryPrice.toFixed(8)}, Target: ${targetPrice.toFixed(8)}, Fee Adj: ${feeAdjustedTarget.toFixed(8)}`);
        return feeAdjustedTarget;
    }
}

async function syncAccount(acc, state) {
    const now = Date.now();
    
    // Check pending orders
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

    // Rate limit position fetches
    if (lastPositionFetch[acc.accountId] && (now - lastPositionFetch[acc.accountId]) < config.pollInterval) {
        return;
    }
    lastPositionFetch[acc.accountId] = now;

    // Get position info
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
            
            // Use exchange's ROI - this is always correct
            if (Math.abs(newExchangeRoi - state.roi) > 0.01) {
                const timeSinceLastUpdate = now - state.lastRoiUpdateTime;
                
                state.roiLatencyMs = timeSinceLastUpdate;
                state.roiLatencyHistory.unshift({
                    timestamp: now,
                    exchangeRoi: newExchangeRoi,
                    botRoi: state.roi,
                    latencyMs: timeSinceLastUpdate,
                    difference: Math.abs(newExchangeRoi - state.roi).toFixed(2)
                });
                
                if (state.roiLatencyHistory.length > 10) state.roiLatencyHistory.pop();
                
                console.log(`[${state.direction.toUpperCase()}] Exchange ROI: ${newExchangeRoi.toFixed(2)}% (delay: ${timeSinceLastUpdate}ms)`);
                
                state.roi = newExchangeRoi;
                state.lastExchangeRoi = newExchangeRoi;
                state.lastRoiUpdateTime = now;
            }
            
            // Update target price whenever entry price changes (Martingale steps)
            state.targetPrice = calculateTargetPrice(state, state.direction === 'buy' ? market.ask : market.bid);
            
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else {
            // Position closed
            if (state.volume !== 0) {
                console.log(`✅ [${state.direction.toUpperCase()}] Position closed at ${new Date().toLocaleTimeString()}`);
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.step = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.lastExchangeRoi = 0;
                state.targetPrice = 0;
            }
        }
    }

    // Rate limit balance fetches to once per 10 seconds
    if (lastBalanceFetch[acc.accountId] && (now - lastBalanceFetch[acc.accountId]) < 10000) {
        return;
    }
    lastBalanceFetch[acc.accountId] = now;

    // Get account balance
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', {
        margin_asset: 'USDT'
    });

    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
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

// ==================== MARTINGALE LOGIC WITH EXACT TAKE PROFIT ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (currentPrice === 0) continue;

        // Open initial position
        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread && market.spread > 0) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}% > ${config.maxStartSpread}%)`;
                continue;
            }
            
            console.log(`🚀 Opening ${state.direction} position at ${currentPrice.toFixed(8)} (spread: ${market.spread.toFixed(2)}%)`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: config.baseVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Position Opening";
                
                // Wait for order to fill and get actual entry price
                setTimeout(async () => {
                    const orderInfo = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                        contract_code: config.symbol,
                        order_id: res.data.order_id_str
                    });
                    
                    if (orderInfo?.data?.[0]?.status === 6) {
                        state.entryPrice = parseFloat(orderInfo.data[0].price_avg);
                        state.targetPrice = calculateTargetPrice(state, currentPrice);
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

        // ============ TAKE PROFIT CHECK USING ORDER BOOK PRICES ============
        let shouldTakeProfit = false;
        let exitPrice = 0;
        
        if (state.direction === 'buy') {
            // For LONG: Check if ASK price reached target
            if (market.ask >= state.targetPrice && state.targetPrice > 0) {
                shouldTakeProfit = true;
                exitPrice = market.ask;
                console.log(`🎯 LONG TP triggered! ASK: ${market.ask.toFixed(8)} >= Target: ${state.targetPrice.toFixed(8)}`);
            }
        } else {
            // For SHORT: Check if BID price reached target
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
            
            console.log(`✅ Taking ${state.direction} profit at ${exitPrice.toFixed(8)} (Target: ${state.targetPrice.toFixed(8)})`);
            state.isLocked = true;
            state.lastAction = "Taking Profit...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: state.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'  // Market order
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl);
                
                // Reset position data
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.step = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
                state.entryPrice = 0;
                state.targetPrice = 0;
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
                console.error(`Take profit failed:`, res);
            }
            continue;
        }

        // Martingale step logic
        let priceMove = 0;
        if (state.direction === 'buy') {
            priceMove = ((state.lastStepPrice - currentPrice) / state.lastStepPrice) * 100;
        } else {
            priceMove = ((currentPrice - state.lastStepPrice) / state.lastStepPrice) * 100;
        }
        
        if (priceMove >= config.stepDistancePct && state.lastStepPrice > 0) {
            console.log(`📈 Martingale step ${state.step + 1} for ${state.direction} - Move: ${priceMove.toFixed(2)}%`);
            state.isLocked = true;
            const nextVol = Math.max(1, Math.ceil((state.lastAddedVolume || config.baseVolume) * config.multiplier));
            
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
                state.step++;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${state.step}`;
                
                // Target price will be recalculated on next sync with new weighted average entry
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        }
    }
}

async function backgroundLoop() {
    try {
        // Update prices if WebSocket hasn't updated recently
        if (Date.now() - market.lastPriceUpdate > 2000) {
            await fetchPriceRest();
        }
        
        // Sync accounts sequentially to avoid rate limits
        for (const acc of config.accounts) {
            await syncAccount(acc, accountStates[acc.accountId]);
        }
        
        // Calculate totals
        const s1 = accountStates[1];
        const s2 = accountStates[2];
        
        if (s1 && s2) {
            if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
                market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                console.log(`Initial Total Equity: ${market.initialTotalEquity.toFixed(8)} USDT`);
            }
            
            if (market.initialTotalEquity > 0) {
                market.totalNetGain = (s1.currentEquity + s2.currentEquity) - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedDays = (Date.now() - market.startTime) / (1000 * 60 * 60 * 24);
                market.dgr = elapsedDays > 0 ? (market.growthPct / elapsedDays) : 0;
            }
        }
        
        if (market.status === 'Active') {
            await processMartingale();
        }
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// ==================== ENDPOINTS ====================
app.get('/api/status', (req, res) => {
    const latencySummary = {};
    Object.keys(accountStates).forEach(accId => {
        const state = accountStates[accId];
        const avgLatency = state.roiLatencyHistory.length > 0 
            ? state.roiLatencyHistory.reduce((sum, record) => sum + record.latencyMs, 0) / state.roiLatencyHistory.length 
            : 0;
        
        latencySummary[`account_${accId}_${state.direction}`] = {
            currentLatencyMs: state.roiLatencyMs,
            avgLatencyMs: Math.round(avgLatency),
            lastUpdateTime: new Date(state.lastRoiUpdateTime).toLocaleTimeString(),
            history: state.roiLatencyHistory.slice(0, 5),
            targetPrice: state.targetPrice,
            entryPrice: state.entryPrice
        };
    });
    
    res.json({
        market,
        accounts: Object.values(accountStates),
        tradeHistory,
        latency: latencySummary,
        config: {
            maxStartSpread: config.maxStartSpread,
            takeProfitPct: config.takeProfitPct,
            pollInterval: config.pollInterval
        }
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
    res.json({ status: 'ok', message: 'Force sync completed' });
});

app.get('/api/verify', async (req, res) => {
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
                    matches: Math.abs((parseFloat(pos.profit_rate) * 100) - state.roi) < 0.01
                });
            }
        }
    }
    
    res.json({
        verified: verification,
        message: "Take profit now uses ORDER BOOK prices (BID/ASK) with fee adjustment for exact 15%",
        take_profit_logic: "LONG: market.ask >= targetPrice | SHORT: market.bid <= targetPrice",
        fee_adjustment: `${config.takerFeeRate * 100}% included`
    });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Exact Take Profit</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .mono { font-family: 'SF Mono', monospace; font-size: 12px; }
        .tp-target { background: #00D1B220; color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 10px; }
        button { background: #FF4D6D20; border: 1px solid #FF4D6D; color: #FF4D6D; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
        button:hover { background: #FF4D6D40; }
        .sync-btn { background: #00D1B220; border-color: #00D1B2; color: #00D1B2; margin-left: 10px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">EXACT TP</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span class="tp-target">🎯 TP: ${config.takeProfitPct}% (Order Book)</span>
                </div>
            </div>
            <div>
                <button onclick="forceSync()" class="sync-btn">🔄 FORCE SYNC</button>
                <button onclick="emergencyClose()">⚠️ EMERGENCY CLOSE</button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label mb-2">TARGET TP</p>
                <p class="text-2xl font-black">${config.takeProfitPct}%</p>
                <p class="text-[10px] text-slate-500 mt-1">STEP: ${config.stepDistancePct}%</p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">MARKET SPREAD</p>
                <p id="spread" class="text-2xl font-black">0.000%</p>
                <p class="text-[10px] text-slate-500 mt-1">Max Start: ${config.maxStartSpread}%</p>
                <p class="text-[10px] text-slate-500">BID: <span id="bidPrice">0.00000000</span> | ASK: <span id="askPrice">0.00000000</span></p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">LONG ACCOUNT</p>
                <p id="lRoi" class="text-2xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="lAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="lTarget" class="text-[9px] text-green-400 mt-1"></p>
            </div>
            <div class="card">
                <p class="stat-label mb-2">SHORT ACCOUNT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="sAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="sTarget" class="text-[9px] text-green-400 mt-1"></p>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📊 ROI SYNC HISTORY</h3>
            <div id="longHistory" class="mb-4">
                <p class="text-xs text-slate-500 mb-2">LONG POSITION</p>
                <div id="longHistoryList" class="space-y-1 max-h-32 overflow-y-auto"></div>
            </div>
            <div id="shortHistory">
                <p class="text-xs text-slate-500 mb-2">SHORT POSITION</p>
                <div id="shortHistoryList" class="space-y-1 max-h-32 overflow-y-auto"></div>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📋 CLOSED TRADES</h3>
            <div class="overflow-x-auto">
                <table class="w-full border-collapse">
                    <thead class="bg-[#0F141C]">
                        <tr>
                            <th class="text-left p-3 text-xs text-slate-500">SIDE</th>
                            <th class="text-left p-3 text-xs text-slate-500">OPEN</th>
                            <th class="text-left p-3 text-xs text-slate-500">CLOSE</th>
                            <th class="text-right p-3 text-xs text-slate-500">VOL</th>
                            <th class="text-right p-3 text-xs text-slate-500">ENTRY</th>
                            <th class="text-right p-3 text-xs text-slate-500">EXIT</th>
                            <th class="text-right p-3 text-xs text-slate-500">ROI</th>
                            <th class="text-right p-3 text-xs text-slate-500">PNL</th>
                        </tr>
                    </thead>
                    <tbody id="tradesBody">
                        <tr><td colspan="8" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
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
        
        function getDelayColor(ms) {
            if (ms < 1000) return '#00D1B2';
            if (ms < 5000) return '#FFB700';
            return '#FF4D6D';
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('spread').textContent = data.market.spread?.toFixed(3) + '%';
                document.getElementById('bidPrice').textContent = data.market.bid?.toFixed(8) || '0';
                document.getElementById('askPrice').textContent = data.market.ask?.toFixed(8) || '0';
                
                const long = data.accounts.find(a => a.direction === 'buy');
                const short = data.accounts.find(a => a.direction === 'sell');
                
                if (long) {
                    const roi = parseFloat(long.roi);
                    const roiElem = document.getElementById('lRoi');
                    roiElem.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                    roiElem.className = 'text-2xl font-black ' + (roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('lPnl').textContent = (long.unrealizedUsdt >= 0 ? '+' : '') + long.unrealizedUsdt?.toFixed(8) || '0';
                    document.getElementById('lStep').textContent = 'STEP ' + (long.step || 0) + ' | VOL ' + (long.volume || 0);
                    document.getElementById('lAction').textContent = long.lastAction || 'Idle';
                    
                    if (long.targetPrice > 0) {
                        document.getElementById('lTarget').innerHTML = '🎯 TP: ' + long.targetPrice.toFixed(8);
                    } else {
                        document.getElementById('lTarget').innerHTML = '';
                    }
                    
                    if (long.roiLatencyHistory && long.roiLatencyHistory.length > 0) {
                        let html = '';
                        long.roiLatencyHistory.slice(0, 5).forEach(h => {
                            html += `<div class="text-xs"><span class="text-slate-500">${new Date(h.timestamp).toLocaleTimeString()}</span> - ROI: <span class="font-bold">${h.exchangeRoi.toFixed(2)}%</span> <span style="color: ${getDelayColor(h.latencyMs)}">(delay: ${h.latencyMs}ms)</span></div>`;
                        });
                        document.getElementById('longHistoryList').innerHTML = html;
                    }
                }
                
                if (short) {
                    const roi = parseFloat(short.roi);
                    const roiElem = document.getElementById('sRoi');
                    roiElem.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';
                    roiElem.className = 'text-2xl font-black ' + (roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('sPnl').textContent = (short.unrealizedUsdt >= 0 ? '+' : '') + short.unrealizedUsdt?.toFixed(8) || '0';
                    document.getElementById('sStep').textContent = 'STEP ' + (short.step || 0) + ' | VOL ' + (short.volume || 0);
                    document.getElementById('sAction').textContent = short.lastAction || 'Idle';
                    
                    if (short.targetPrice > 0) {
                        document.getElementById('sTarget').innerHTML = '🎯 TP: ' + short.targetPrice.toFixed(8);
                    } else {
                        document.getElementById('sTarget').innerHTML = '';
                    }
                    
                    if (short.roiLatencyHistory && short.roiLatencyHistory.length > 0) {
                        let html = '';
                        short.roiLatencyHistory.slice(0, 5).forEach(h => {
                            html += `<div class="text-xs"><span class="text-slate-500">${new Date(h.timestamp).toLocaleTimeString()}</span> - ROI: <span class="font-bold">${h.exchangeRoi.toFixed(2)}%</span> <span style="color: ${getDelayColor(h.latencyMs)}">(delay: ${h.latencyMs}ms)</span></div>`;
                        });
                        document.getElementById('shortHistoryList').innerHTML = html;
                    }
                }
                
                // Build trades table
                let tradesHtml = '';
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.slice(0, 10).forEach(t => {
                        const roiVal = parseFloat(t.roi);
                        tradesHtml += `<tr class="border-b border-[#1A212E]">
                            <td class="p-3"><span class="${t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'} font-bold">${t.side}</span></td>
                            <td class="p-3 text-xs">${t.openTime || '--'}</td>
                            <td class="p-3 text-xs">${t.closeTime || '--'}</td>
                            <td class="p-3 text-right">${t.volume}</td>
                            <td class="p-3 text-right mono">${t.entryPrice}</td>
                            <td class="p-3 text-right mono">${t.exitPrice}</td>
                            <td class="p-3 text-right ${roiVal >= 0 ? 'value-positive' : 'value-negative'}">${roiVal >= 0 ? '+' : ''}${t.roi}</td>
                            <td class="p-3 text-right mono">${t.netPnlUsdt} USDT</td>
                        </tr>`;
                    });
                } else {
                    tradesHtml = '<tr><td colspan="8" class="text-center text-slate-500 p-12">No closed trades yet</td></tr>';
                }
                document.getElementById('tradesBody').innerHTML = tradesHtml;
                
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>`);
});

// ==================== START ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro Started (EXACT TAKE PROFIT VERSION)`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}% (using ORDER BOOK prices)`);
    console.log(`📈 Step Distance: ${config.stepDistancePct}%`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`💰 Fee Adjustment: ${config.takerFeeRate * 100}% included`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`\n🔴 HOW TP WORKS NOW:`);
    console.log(`   LONG: Closes when ASK price >= Target (${config.takeProfitPct}% above entry + fee)`);
    console.log(`   SHORT: Closes when BID price <= Target (${config.takeProfitPct}% below entry - fee)`);
    console.log(`   Market orders with exact target calculation\n`);
});
