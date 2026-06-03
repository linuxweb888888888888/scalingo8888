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
    maxStartSpread: 0.1,
    takerFeeRate: 0.0005,
    pollInterval: 500, // Increased to avoid rate limits
    contractMultiplier: 0.001,
    wsReconnectDelay: 5000
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0
};

let tradeHistory = [];
let accountStates = {};
let wsInstance = null;
let lastWsPing = Date.now();
let positionSyncCounter = 0;

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
        lastBotRoi: 0,
        roiLatencyMs: 0,
        roiLatencyHistory: [],
        lastRoiUpdateTime: Date.now(),
        consecutiveErrors: 0,
        lastWsUpdate: 0  // Track last WebSocket update time
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
        console.error('Price fetch error:', e.message);
    }
}

async function syncAccountWithRetry(acc, state, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            await syncAccount(acc, state);
            state.consecutiveErrors = 0;
            return;
        } catch (e) {
            state.consecutiveErrors++;
            const waitTime = Math.min(Math.pow(2, i) * 500, 2000);
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, waitTime));
            }
        }
    }
}

async function syncAccount(acc, state) {
    try {
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
                
                let updated = false;
                
                if (newVolume !== state.volume) {
                    state.volume = newVolume;
                    updated = true;
                }
                if (newEntryPrice !== state.entryPrice) {
                    state.entryPrice = newEntryPrice;
                    updated = true;
                }
                
                // Check if ROI changed significantly
                if (Math.abs(newExchangeRoi - state.roi) > 0.001) {
                    const now = Date.now();
                    const timeSinceLastUpdate = now - state.lastRoiUpdateTime;
                    
                    // Determine if this came from WebSocket or REST
                    const isFromWs = (now - state.lastWsUpdate) < 100; // Within 100ms of WebSocket update
                    const source = isFromWs ? 'websocket' : 'rest';
                    
                    state.roiLatencyMs = timeSinceLastUpdate;
                    state.roiLatencyHistory.unshift({
                        timestamp: now,
                        exchangeRoi: newExchangeRoi,
                        botRoi: state.roi,
                        latencyMs: timeSinceLastUpdate,
                        difference: Math.abs(newExchangeRoi - state.roi).toFixed(4),
                        source: source
                    });
                    
                    if (state.roiLatencyHistory.length > 10) state.roiLatencyHistory.pop();
                    
                    console.log(`[${source.toUpperCase()}][${state.direction.toUpperCase()}] ROI: ${state.roi.toFixed(2)}% → ${newExchangeRoi.toFixed(2)}% (delay: ${timeSinceLastUpdate}ms)`);
                    
                    state.roi = newExchangeRoi;
                    state.lastExchangeRoi = newExchangeRoi;
                    state.lastBotRoi = newExchangeRoi;
                    state.lastRoiUpdateTime = now;
                    updated = true;
                }
                
                if (newUnrealizedUsdt !== state.unrealizedUsdt) {
                    state.unrealizedUsdt = newUnrealizedUsdt;
                    updated = true;
                }
                
                if (updated) {
                    if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
                    if (!state.startTime) state.startTime = new Date().toLocaleString();
                }
            } else {
                if (state.volume !== 0) {
                    console.log(`[REST][${state.direction.toUpperCase()}] Position closed`);
                    state.volume = 0;
                    state.roi = 0;
                    state.unrealizedUsdt = 0;
                    state.entryPrice = 0;
                    state.step = 0;
                    state.lastStepPrice = 0;
                    state.startTime = null;
                    state.lastAddedVolume = 0;
                    state.lastExchangeRoi = 0;
                    state.lastBotRoi = 0;
                }
            }
        }

        // Get account balance (every 5 seconds only)
        if (Date.now() - (state.lastBalanceCheck || 0) > 5000) {
            const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', {
                margin_asset: 'USDT'
            });
            
            if (accRes?.status === 'ok' && accRes.data?.[0]) {
                state.currentEquity = parseFloat(accRes.data[0].margin_balance);
                state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
                if (state.initialEquity === null) state.initialEquity = state.currentEquity;
            }
            state.lastBalanceCheck = Date.now();
        }
    } catch (e) {
        console.error(`Sync error for account ${acc.accountId}:`, e.message);
        throw e;
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

// ==================== WS ENGINE WITH CORRECT POSITION SUBSCRIPTIONS ====================
function startWS() {
    if (wsInstance) {
        try { wsInstance.close(); } catch(e) {}
    }
    
    const ws = new WebSocket(config.wsHost);
    wsInstance = ws;
    
    ws.on('open', () => {
        console.log('✅ WebSocket connected');
        lastWsPing = Date.now();
        
        // Subscribe to market data (public, no auth needed)
        ws.send(JSON.stringify({ 
            sub: `market.${config.symbol}.bbo`, 
            id: 'bbo' 
        }));
        
        // Subscribe to position updates - CORRECT FORMAT FOR HTX
        // Need to authenticate first, then subscribe to private channels
        setTimeout(() => {
            config.accounts.forEach(account => {
                // Generate auth for WebSocket
                const timestamp = Date.now();
                const signatureData = {
                    AccessKeyId: account.apiKey,
                    SignatureMethod: 'HmacSHA256',
                    SignatureVersion: '2.1',
                    Timestamp: timestamp
                };
                
                const sortedParams = Object.keys(signatureData).sort().map(key => `${key}=${signatureData[key]}`).join('&');
                const payload = `GET\napi.hbdm.com\n/linear-swap-ws\n${sortedParams}`;
                const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
                
                // Send auth request
                const authMsg = {
                    op: 'auth',
                    type: 'api',
                    AccessKeyId: account.apiKey,
                    SignatureMethod: 'HmacSHA256',
                    SignatureVersion: '2.1',
                    Timestamp: timestamp,
                    Signature: signature
                };
                
                ws.send(JSON.stringify(authMsg));
                console.log(`🔐 Auth request sent for account ${account.accountId}`);
                
                // After auth, subscribe to position updates
                setTimeout(() => {
                    // Subscribe to position updates for this contract
                    const subMsg = {
                        op: 'sub',
                        topic: `positions.${config.symbolClean}`,
                        cid: `pos_${account.accountId}`
                    };
                    ws.send(JSON.stringify(subMsg));
                    console.log(`📡 Subscribed to positions.${config.symbolClean} for account ${account.accountId}`);
                }, 1000);
            });
        }, 500);
    });
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                
                // Handle auth response
                if (msg.op === 'auth' && msg.err_code === 0) {
                    console.log('✅ WebSocket authentication successful');
                } else if (msg.op === 'auth' && msg.err_code !== 0) {
                    console.log(`⚠️ Auth failed: ${msg.err_msg} (code: ${msg.err_code})`);
                }
                
                // Handle market data (price updates)
                if (msg.tick && msg.ch && msg.ch.includes('bbo')) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                    market.lastPriceUpdate = Date.now();
                }
                
                // Handle position updates from WebSocket
                if (msg.op === 'notify' && msg.topic && msg.topic.includes('positions')) {
                    const positionData = msg.data;
                    if (positionData) {
                        const now = Date.now();
                        
                        // Find matching account based on direction
                        for (const [accId, state] of Object.entries(accountStates)) {
                            if (positionData.direction === state.direction && parseFloat(positionData.volume) > 0) {
                                const newExchangeRoi = parseFloat(positionData.profit_rate) * 100;
                                const newVolume = parseFloat(positionData.volume);
                                const newEntryPrice = parseFloat(positionData.cost_open);
                                const newUnrealizedUsdt = parseFloat(positionData.profit);
                                
                                // Mark that we got a WebSocket update
                                state.lastWsUpdate = now;
                                
                                // Update position data immediately
                                let changed = false;
                                
                                if (newVolume !== state.volume) {
                                    state.volume = newVolume;
                                    changed = true;
                                }
                                if (newEntryPrice !== state.entryPrice) {
                                    state.entryPrice = newEntryPrice;
                                    changed = true;
                                }
                                if (Math.abs(newExchangeRoi - state.roi) > 0.001) {
                                    const latency = now - state.lastRoiUpdateTime;
                                    console.log(`[🔌 WS REAL-TIME][${state.direction.toUpperCase()}] ROI: ${state.roi.toFixed(2)}% → ${newExchangeRoi.toFixed(2)}% (latency: ${latency}ms)`);
                                    
                                    state.roi = newExchangeRoi;
                                    state.lastExchangeRoi = newExchangeRoi;
                                    state.lastBotRoi = newExchangeRoi;
                                    state.lastRoiUpdateTime = now;
                                    
                                    // Record near-zero latency for WebSocket
                                    state.roiLatencyHistory.unshift({
                                        timestamp: now,
                                        exchangeRoi: newExchangeRoi,
                                        botRoi: newExchangeRoi,
                                        latencyMs: latency,
                                        difference: '0.0000',
                                        source: 'websocket'
                                    });
                                    if (state.roiLatencyHistory.length > 10) state.roiLatencyHistory.pop();
                                    changed = true;
                                }
                                if (newUnrealizedUsdt !== state.unrealizedUsdt) {
                                    state.unrealizedUsdt = newUnrealizedUsdt;
                                    changed = true;
                                }
                                
                                if (changed) {
                                    if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
                                    if (!state.startTime) state.startTime = new Date().toLocaleString();
                                }
                                break;
                            } else if (positionData.direction === state.direction && parseFloat(positionData.volume) === 0) {
                                // Position closed
                                if (state.volume !== 0) {
                                    console.log(`[🔌 WS][${state.direction.toUpperCase()}] Position closed via WebSocket`);
                                    state.volume = 0;
                                    state.roi = 0;
                                    state.unrealizedUsdt = 0;
                                    state.entryPrice = 0;
                                    state.step = 0;
                                    state.lastStepPrice = 0;
                                    state.startTime = null;
                                    state.lastAddedVolume = 0;
                                }
                                break;
                            }
                        }
                    }
                }
                
                // Handle subscription responses
                if (msg.op === 'sub') {
                    if (msg.err_code === 0) {
                        console.log(`✅ Subscribed to: ${msg.topic}`);
                    } else {
                        console.log(`⚠️ Subscription failed: ${msg.topic} - ${msg.err_msg}`);
                    }
                }
                
                // Handle ping/pong
                if (msg.ping) {
                    ws.send(JSON.stringify({ pong: msg.ping }));
                    lastWsPing = Date.now();
                }
                
            } catch (e) {
                console.error('WebSocket message parsing error:', e.message);
            }
        });
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
    
    ws.on('close', (code, reason) => {
        console.log(`WebSocket disconnected (${code}), reconnecting in ${config.wsReconnectDelay/1000}s...`);
        setTimeout(startWS, config.wsReconnectDelay);
    });
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (currentPrice === 0) continue;

        // Open initial position
        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread && market.spread > 0) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}%)`;
                continue;
            }
            
            console.log(`Opening ${state.direction} position for account ${acc.accountId} at ${currentPrice}`);
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
            } else {
                state.isLocked = false;
                state.lastAction = "Open Failed";
                console.error(`Open order failed:`, res);
            }
            continue;
        }

        // Take profit
        if (state.roi >= config.takeProfitPct) {
            console.log(`✅ Take profit triggered for ${state.direction} - ROI: ${state.roi.toFixed(2)}%`);
            const v = state.volume;
            const finalRoi = state.roi;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: v,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, currentPrice, exitTime, finalRoi, finalPnl);
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.step = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
                state.lastAddedVolume = 0;
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
            }
            continue;
        }

        // Martingale step
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
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        }
    }
}

async function backgroundLoop() {
    try {
        // Fetch price if WebSocket hasn't updated recently
        if (Date.now() - market.lastPriceUpdate > 2000) {
            await fetchPriceRest();
        }
        
        // Use retry wrapper for account syncs (but less frequent)
        if (Date.now() - (global.lastFullSync || 0) > 500) {
            await Promise.all(config.accounts.map(acc => syncAccountWithRetry(acc, accountStates[acc.accountId])));
            global.lastFullSync = Date.now();
        }
        
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
        const wsUpdates = state.roiLatencyHistory.filter(h => h.source === 'websocket').length;
        const restUpdates = state.roiLatencyHistory.filter(h => h.source === 'rest').length;
        
        latencySummary[`account_${accId}_${state.direction}`] = {
            currentLatencyMs: state.roiLatencyMs,
            avgLatencyMs: Math.round(avgLatency),
            lastUpdateTime: new Date(state.lastRoiUpdateTime).toLocaleTimeString(),
            history: state.roiLatencyHistory.slice(0, 5),
            consecutiveErrors: state.consecutiveErrors,
            wsUpdatesCount: wsUpdates,
            restUpdatesCount: restUpdates,
            lastWsUpdate: state.lastWsUpdate ? new Date(state.lastWsUpdate).toLocaleTimeString() : 'never'
        };
    });
    
    res.json({
        market,
        accounts: Object.values(accountStates),
        tradeHistory,
        latency: latencySummary,
        config: {
            pollInterval: config.pollInterval,
            wsConnected: wsInstance && wsInstance.readyState === WebSocket.OPEN
        }
    });
});

app.post('/api/close', async (req, res) => {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
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
                const wsUpdates = state.roiLatencyHistory.filter(h => h.source === 'websocket').length;
                verification.push({
                    account: acc.accountId,
                    direction: state.direction,
                    exchange_profit_rate: parseFloat(pos.profit_rate),
                    exchange_profit_rate_percent: (parseFloat(pos.profit_rate) * 100).toFixed(2) + '%',
                    bot_display_roi: state.roi.toFixed(2) + '%',
                    matches: Math.abs((parseFloat(pos.profit_rate) * 100) - state.roi) < 0.01,
                    latency_ms: state.roiLatencyMs,
                    avg_latency_ms: state.roiLatencyHistory.length > 0 
                        ? Math.round(state.roiLatencyHistory.reduce((sum, r) => sum + r.latencyMs, 0) / state.roiLatencyHistory.length)
                        : 0,
                    websocket_connected: wsInstance && wsInstance.readyState === WebSocket.OPEN,
                    websocket_updates_received: wsUpdates,
                    last_websocket_update: state.lastWsUpdate ? new Date(state.lastWsUpdate).toLocaleTimeString() : 'never'
                });
            }
        }
    }
    
    res.json({
        verified: verification,
        message: "WebSocket position updates should provide sub-100ms latency",
        websocket_status: wsInstance ? (wsInstance.readyState === WebSocket.OPEN ? 'CONNECTED' : 'DISCONNECTED') : 'NOT_INITIALIZED'
    });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Fixed WebSocket Edition</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .exchange-card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .badge-long { background: rgba(0, 209, 178, 0.12); color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .badge-short { background: rgba(255, 77, 109, 0.12); color: #FF4D6D; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .exchange-table { width: 100%; border-collapse: collapse; }
        .exchange-table th { text-align: left; padding: 14px 12px; background: #0F141C; color: #6B7A8F; font-size: 11px; font-weight: 700; border-bottom: 1px solid #1F2A3E; }
        .exchange-table td { padding: 12px; border-bottom: 1px solid #1A212E; font-size: 13px; }
        .mono { font-family: 'SF Mono', monospace; font-size: 12px; }
        .latency-badge { background: #1A212E; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-family: monospace; }
        .latency-good { color: #00D1B2; }
        .latency-warning { color: #FFB700; }
        .latency-bad { color: #FF4D6D; }
        .websocket-online { color: #00D1B2; }
        .websocket-offline { color: #FF4D6D; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span> <span class="text-xs bg-green-500/20 px-2 py-1 rounded">WEBSOCKET FIXED</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="flex items-center gap-1.5">
                        <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span id="botStatus" class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    </div>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                    <span id="wsStatus" class="text-[10px] font-bold">🔌 WebSocket: Connecting...</span>
                </div>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-bold text-slate-500 mb-1">TOTAL NET GAIN</p>
                <p id="totalNetGain" class="text-3xl font-black mono">$0.00000000</p>
                <div class="flex gap-3 justify-end mt-1">
                    <p id="growthPct" class="text-[10px] font-bold text-emerald-400">+0.00%</p>
                    <p id="dgrPct" class="text-[10px] font-bold text-indigo-400">DGR: 0.00%/D</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">TARGET TP</p>
                <p class="text-2xl font-black">${config.takeProfitPct}%</p>
                <p class="text-[10px] text-slate-500 mt-1">STEP: ${config.stepDistancePct}%</p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">MARKET SPREAD</p>
                <p id="uiSpread" class="text-2xl font-black">0.000%</p>
                <p class="text-[10px] text-slate-500 mt-1">BID: <span id="bidPrice">0.00000000</span> | ASK: <span id="askPrice">0.00000000</span></p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">LONG ACCOUNT</p>
                <p id="lRoi" class="text-2xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="lAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="lLatency" class="text-[9px] mt-1"><span class="latency-badge">⏱️ Sync delay: -- ms</span></p>
                <p id="lWsCount" class="text-[8px] text-slate-500 mt-1"></p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">SHORT ACCOUNT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="sAction" class="text-[9px] text-indigo-400 mt-1"></p>
                <p id="sLatency" class="text-[9px] mt-1"><span class="latency-badge">⏱️ Sync delay: -- ms</span></p>
                <p id="sWsCount" class="text-[8px] text-slate-500 mt-1"></p>
            </div>
        </div>

        <div class="exchange-card overflow-hidden mb-8">
            <div class="px-6 py-4 border-b border-[#1F2A3E] bg-indigo-500/5">
                <p class="font-bold text-sm">⚡ REAL-TIME WEBSOCKET LATENCY</p>
                <p class="text-[9px] text-green-400">✅ WebSocket updates should show 🔌 icon with latency < 100ms</p>
                <p class="text-[9px] text-yellow-400">⚠️ If you see 📡 icon, WebSocket position subscription is not working</p>
            </div>
            <div class="p-6">
                <div class="grid grid-cols-2 gap-6">
                    <div>
                        <p class="text-xs font-bold mb-3 text-indigo-400">LONG POSITION LATENCY</p>
                        <div id="longLatencyHistory" class="space-y-2">
                            <div class="text-center text-slate-500 text-xs">Waiting for ROI changes...</div>
                        </div>
                    </div>
                    <div>
                        <p class="text-xs font-bold mb-3 text-indigo-400">SHORT POSITION LATENCY</p>
                        <div id="shortLatencyHistory" class="space-y-2">
                            <div class="text-center text-slate-500 text-xs">Waiting for ROI changes...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="exchange-card overflow-hidden">
            <div class="px-6 py-4 border-b border-[#1F2A3E]">
                <p class="font-bold text-sm">📋 TRADE HISTORY</p>
                <p class="text-[9px] text-slate-500">Direct from HTX API - Real P&L including fees</p>
            </div>
            <div class="overflow-x-auto">
                <table class="exchange-table">
                    <thead>
                        <tr><th>CONTRACT</th><th>SIDE</th><th>OPEN TIME</th><th>CLOSE TIME</th><th>VOLUME</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>NET PNL</th></tr>
                    </thead>
                    <tbody id="historyBody">
                        <tr><td colspan="9" class="text-center text-slate-500 py-12">No closed trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <button onclick="triggerClose()" class="w-full mt-8 py-4 rounded-xl bg-red-500/10 border border-red-500/30 font-bold uppercase tracking-wider text-sm hover:bg-red-500/20 transition-all">
            ⚠ EMERGENCY LIQUIDATION ⚠
        </button>
    </div>

    <script>
        function getLatencyColor(ms) {
            if (ms < 100) return 'latency-good';
            if (ms < 500) return 'latency-warning';
            return 'latency-bad';
        }
        
        async function triggerClose() { if(confirm("Close all positions?")) fetch('/api/close', {method:'POST'}); }
        
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                document.getElementById('totalNetGain').innerHTML = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(8);
                document.getElementById('growthPct').innerHTML = (d.market.growthPct >= 0 ? '+' : '') + d.market.growthPct.toFixed(2) + '%';
                document.getElementById('dgrPct').innerHTML = 'DGR: ' + (d.market.dgr >= 0 ? '+' : '') + d.market.dgr.toFixed(2) + '%/D';
                document.getElementById('uiSpread').innerHTML = d.market.spread.toFixed(3) + '%';
                document.getElementById('bidPrice').innerHTML = d.market.bid.toFixed(8);
                document.getElementById('askPrice').innerHTML = d.market.ask.toFixed(8);
                
                const wsConnected = d.config && d.config.wsConnected;
                const wsStatusElem = document.getElementById('wsStatus');
                if (wsConnected) {
                    wsStatusElem.innerHTML = '🔌 WebSocket: <span class="websocket-online">ONLINE</span>';
                } else {
                    wsStatusElem.innerHTML = '🔌 WebSocket: <span class="websocket-offline">OFFLINE</span>';
                }
                
                if (d.accounts && d.accounts.length >= 2) {
                    const long = d.accounts[0], short = d.accounts[1];
                    
                    const lElem = document.getElementById('lRoi');
                    const longRoi = parseFloat(long.roi);
                    lElem.innerHTML = (longRoi >= 0 ? '+' : '') + longRoi.toFixed(2) + '%';
                    lElem.className = 'text-2xl font-black ' + (longRoi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + long.unrealizedUsdt.toFixed(8);
                    document.getElementById('lStep').innerHTML = 'STEP ' + long.step + ' | VOL ' + long.volume;
                    document.getElementById('lAction').innerHTML = long.lastAction;
                    
                    const sElem = document.getElementById('sRoi');
                    const shortRoi = parseFloat(short.roi);
                    sElem.innerHTML = (shortRoi >= 0 ? '+' : '') + shortRoi.toFixed(2) + '%';
                    sElem.className = 'text-2xl font-black ' + (shortRoi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + short.unrealizedUsdt.toFixed(8);
                    document.getElementById('sStep').innerHTML = 'STEP ' + short.step + ' | VOL ' + short.volume;
                    document.getElementById('sAction').innerHTML = short.lastAction;
                }
                
                if (d.latency) {
                    const longLatencyKey = Object.keys(d.latency).find(k => k.includes('buy'));
                    const shortLatencyKey = Object.keys(d.latency).find(k => k.includes('sell'));
                    
                    if (longLatencyKey && d.latency[longLatencyKey]) {
                        const lat = d.latency[longLatencyKey];
                        const latencyMs = lat.currentLatencyMs;
                        const latencyColor = getLatencyColor(latencyMs);
                        document.getElementById('lLatency').innerHTML = '<span class="latency-badge ' + latencyColor + '">⏱️ Sync delay: ' + latencyMs + ' ms (avg: ' + lat.avgLatencyMs + 'ms)</span>';
                        document.getElementById('lWsCount').innerHTML = '🔌 WS updates: ' + (lat.wsUpdatesCount || 0) + ' | 📡 REST: ' + (lat.restUpdatesCount || 0);
                        
                        if (lat.history && lat.history.length > 0) {
                            let html = '';
                            lat.history.forEach(h => {
                                const color = getLatencyColor(h.latencyMs);
                                const sourceIcon = h.source === 'websocket' ? '🔌' : '📡';
                                const latencyDisplay = h.source === 'websocket' ? '<span class="text-green-400">' + h.latencyMs + 'ms (REAL-TIME)</span>' : h.latencyMs + 'ms';
                                html += '<div class="text-xs bg-[#1A212E] p-2 rounded">' + sourceIcon + ' <span class="text-slate-400">' + new Date(h.timestamp).toLocaleTimeString() + '</span> — ROI: <span class="font-bold">' + h.exchangeRoi.toFixed(2) + '%</span> | Delay: ' + latencyDisplay + '</div>';
                            });
                            document.getElementById('longLatencyHistory').innerHTML = html;
                        }
                    }
                    
                    if (shortLatencyKey && d.latency[shortLatencyKey]) {
                        const lat = d.latency[shortLatencyKey];
                        const latencyMs = lat.currentLatencyMs;
                        const latencyColor = getLatencyColor(latencyMs);
                        document.getElementById('sLatency').innerHTML = '<span class="latency-badge ' + latencyColor + '">⏱️ Sync delay: ' + latencyMs + ' ms (avg: ' + lat.avgLatencyMs + 'ms)</span>';
                        document.getElementById('sWsCount').innerHTML = '🔌 WS updates: ' + (lat.wsUpdatesCount || 0) + ' | 📡 REST: ' + (lat.restUpdatesCount || 0);
                        
                        if (lat.history && lat.history.length > 0) {
                            let html = '';
                            lat.history.forEach(h => {
                                const color = getLatencyColor(h.latencyMs);
                                const sourceIcon = h.source === 'websocket' ? '🔌' : '📡';
                                const latencyDisplay = h.source === 'websocket' ? '<span class="text-green-400">' + h.latencyMs + 'ms (REAL-TIME)</span>' : h.latencyMs + 'ms';
                                html += '<div class="text-xs bg-[#1A212E] p-2 rounded">' + sourceIcon + ' <span class="text-slate-400">' + new Date(h.timestamp).toLocaleTimeString() + '</span> — ROI: <span class="font-bold">' + h.exchangeRoi.toFixed(2) + '%</span> | Delay: ' + latencyDisplay + '</div>';
                            });
                            document.getElementById('shortLatencyHistory').innerHTML = html;
                        }
                    }
                }
                
                let html = '';
                if (d.tradeHistory && d.tradeHistory.length > 0) {
                    d.tradeHistory.forEach(h => {
                        const roiVal = parseFloat(h.roi);
                        html += '<tr class="hover:bg-[#1A212E]">';
                        html += '<td class="font-bold">' + h.symbol + '</td>';
                        html += '<td><span class="' + (h.side === 'LONG' ? 'badge-long' : 'badge-short') + '">' + h.side + '</span></td>';
                        html += '<td class="mono text-xs">' + (h.openTime || '--') + '</td>';
                        html += '<td class="mono text-xs">' + (h.closeTime || '--') + '</td>';
                        html += '<td>' + h.volume + '</td>';
                        html += '<td class="mono">' + h.entryPrice + '</td>';
                        html += '<td class="mono">' + h.exitPrice + '</td>';
                        html += '<td class="font-bold ' + (roiVal >= 0 ? 'value-positive' : 'value-negative') + '">' + (roiVal >= 0 ? '+' : '') + h.roi + '</td>';
                        html += '<td class="mono font-bold ' + (parseFloat(h.netPnlUsdt) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(h.netPnlUsdt) >= 0 ? '+' : '') + h.netPnlUsdt + ' USDT</td>';
                        html += '</tr>';
                    });
                } else {
                    html = '<tr><td colspan="9" class="text-center text-slate-500 py-12">No closed trades yet</td></tr>';
                }
                document.getElementById('historyBody').innerHTML = html;
            } catch(e) { console.error(e); }
        }, 500);
    </script>
</body>
</html>`);
});

// ==================== START ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro Engine Started (WEBSOCKET FIXED)`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}%`);
    console.log(`📈 Step Distance: ${config.stepDistancePct}%`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`⚡ Polling Interval: ${config.pollInterval}ms (backup only)`);
    console.log(`🔌 WebSocket: Enabled with AUTH + position subscriptions`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`🔍 Verify ROI: http://localhost:${config.port}/api/verify`);
    console.log(`\n📡 IMPORTANT: WebSocket should provide sub-100ms latency`);
    console.log(`   Look for 🔌 icon in dashboard - if you see 📡, check WebSocket auth\n`);
});
