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
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 100, 
    winLossRatio: 1.5,        
    maxStartSpread: 0.1,      
    autoClosePct: 110,        
    pollInterval: 1000,       
    resetCooldownMs: 3000,
    resetDiffThreshold: 2.5,  
    takerFeeRate: 0.0005,
    chaseRetryMs: 2500 // Time to wait before re-pricing the limit order
};

let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    currentRatio: 0, resetPenalty: 0, diffSum: 0,
    balancePct: 0, totalNetGain: 0, growthPct: 0, 
    initialTotalEquity: 0, resetUsed: false,
    sessionResetLoss: 0,
    netSessionUsdt: 0,         
    estExitFees: 0
};

let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, initialEquity: null,
        isLocked: false, lastAction: 'Idle'
    };
});

// ==================== HTX API CORE ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

/**
 * NEW: LIMIT CHASE FUNCTION
 * Replaces market orders with limit orders that move with the price.
 */
async function chaseLimitOrder(account, direction, volume, offset) {
    let filled = false;
    let attempts = 0;
    let currentVolume = volume;

    while (!filled && attempts < 10) {
        // Set price at Best Bid if buying, Best Ask if selling (Maker behavior)
        const price = (direction === 'buy') ? market.bid : market.ask;
        if (!price) break;

        const order = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: currentVolume, direction, offset, 
            lever_rate: config.leverage, order_price_type: 'limit', price: price 
        });

        if (order?.status === 'ok') {
            const orderId = order.data.order_id;
            await new Promise(r => setTimeout(r, config.chaseRetryMs));

            // Check if filled
            const info = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order_info', { 
                contract_code: config.symbol, order_id: orderId 
            });

            if (info?.status === 'ok' && info.data[0].status === 6) {
                filled = true;
            } else {
                // Cancel and try again with new price
                await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_cancel', { 
                    contract_code: config.symbol, order_id: orderId 
                });
                const tradeVol = info?.data ? parseFloat(info.data[0].trade_volume) : 0;
                currentVolume -= tradeVol;
                if (currentVolume <= 0) filled = true;
            }
        }
        attempts++;
    }
}

async function syncAccount(acc, state) {
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open || pos.last_price);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const equity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = equity;
        state.currentEquity = equity;
    }
}

function logTrade(side, roi, pnl, type) {
    tradeHistory.unshift({ 
        time: new Date().toLocaleTimeString(), 
        side: side.toUpperCase(), 
        roi: roi.toFixed(2) + '%', 
        pnl: pnl.toFixed(5), 
        total: market.totalNetGain.toFixed(5), 
        type: type 
    });
    if (tradeHistory.length > 15) tradeHistory.pop();
}

async function flashReset(accIdxToReset) {
    if (market.status !== 'Active' || market.resetUsed) return;
    const acc = config.accounts[accIdxToReset];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    market.resetUsed = true; 
    
    const feeCost = (state.volume * market.bid * config.takerFeeRate * 2);
    market.sessionResetLoss += (Math.abs(state.unrealizedUsdt) + feeCost);
    
    state.lastAction = "⚡ RESET CHASE";
    logTrade(state.direction, state.roi, state.unrealizedUsdt, 'RESET');

    // Chase Limit Close
    await chaseLimitOrder(acc, state.direction === 'buy' ? 'sell' : 'buy', state.volume, 'close');
    // Chase Limit Open
    await chaseLimitOrder(acc, state.direction, config.baseVolume, 'open');

    setTimeout(() => { state.isLocked = false; state.lastAction = "Idle"; }, config.resetCooldownMs);
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                market.resetPenalty = -(market.spread * config.leverage);

                const s1 = accountStates[1]; 
                const s2 = accountStates[2];
                if (!s1 || !s2) return;
                
                const lRoi = s1.entryPrice > 0 ? ((market.bid - s1.entryPrice) / s1.entryPrice) * config.leverage * 100 : s1.roi;
                const sRoi = s2.entryPrice > 0 ? ((s2.entryPrice - market.ask) / s2.entryPrice) * config.leverage * 100 : s2.roi;
                
                const winRoi = Math.max(lRoi, sRoi);
                market.diffSum = winRoi + market.resetPenalty;

                const fee1 = s1.volume > 0 ? (s1.volume * market.bid * config.takerFeeRate) : 0;
                const fee2 = s2.volume > 0 ? (s2.volume * market.ask * config.takerFeeRate) : 0;
                market.estExitFees = fee1 + fee2;

                const winPnl = Math.max(s1.unrealizedUsdt, s2.unrealizedUsdt);
                const totalDebt = Math.abs(Math.min(s1.unrealizedUsdt, s2.unrealizedUsdt)) + market.sessionResetLoss + market.estExitFees;
                
                market.currentRatio = totalDebt > 0 ? (winPnl / totalDebt) : 0;
                market.netSessionUsdt = (s1.unrealizedUsdt + s2.unrealizedUsdt) - market.sessionResetLoss - market.estExitFees;

                if (market.status === 'Active' && !market.resetUsed) {
                    if (market.diffSum >= config.resetDiffThreshold) {
                        lRoi < sRoi ? flashReset(0) : flashReset(1);
                    }
                }
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MAIN LOOP ====================
async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    const s1 = accountStates[1]; const s2 = accountStates[2];
    if (!s1 || !s2) return;

    const totalCurrentEquity = s1.currentEquity + s2.currentEquity;
    if (market.initialTotalEquity === 0 && totalCurrentEquity > 0) market.initialTotalEquity = totalCurrentEquity;
    market.totalNetGain = totalCurrentEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;
    
    market.balancePct = market.currentRatio > 0 ? (market.currentRatio / config.winLossRatio) * 100 : 0;

    if (market.status === 'Active') {
        if (market.balancePct >= config.autoClosePct && market.netSessionUsdt > 0) {
            await manualClose('TARGET EXIT');
            return;
        }

        if (s1.volume === 0 && s2.volume === 0 && !s1.isLocked && !s2.isLocked) {
            if (market.spread > 0 && market.spread <= config.maxStartSpread) {
                for (const acc of config.accounts) {
                    // Start chase in background for initial open
                    chaseLimitOrder(acc, accountStates[acc.accountId].direction, config.baseVolume, 'open');
                }
            }
        }
    }
}

async function manualClose(type = 'MANUAL') {
    if (market.status === "LIQUIDATING") return; 
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        state.isLocked = true;
        if (state.volume > 0) {
            logTrade(state.direction, state.roi, state.unrealizedUsdt, type);
            await chaseLimitOrder(acc, state.direction === 'buy' ? 'sell' : 'buy', state.volume, 'close');
        }
    }
    market.resetUsed = false;
    market.sessionResetLoss = 0;
    setTimeout(() => { 
        config.accounts.forEach(acc => { accountStates[acc.accountId].isLocked = false; });
        market.status = "Active"; 
    }, 5000);
}

// ==================== UI DASHBOARD ====================
// (Keep the original UI code provided in your prompt here)
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });
app.get('/', (req, res) => { res.send(`... [Exact same HTML from your snippet] ...`); });

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Limit Chase Engine Online`));
