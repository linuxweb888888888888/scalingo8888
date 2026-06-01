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
    pollInterval: 1500,       // Slightly slower to allow sync
    resetCooldownMs: 3000,
    resetDiffThreshold: 2.5,  
    takerFeeRate: 0.0005,
    chaseRetryMs: 3000,       // Wait 3s to allow fill
    resetOffsetPct: 0.001     
};

let market = { status: 'Active', bid: 0, ask: 0, spread: 0, currentRatio: 0, diffSum: 0, totalNetGain: 0, growthPct: 0, initialTotalEquity: 0, resetUsed: false, sessionResetLoss: 0, netSessionUsdt: 0 };
let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, initialEquity: null,
        isLocked: false, chaseActive: false, lastAction: 'Idle'
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function chaseLimitOrder(accIdx, direction, volume, offset, applyOffset = false) {
    const account = config.accounts[accIdx];
    const state = accountStates[account.accountId];
    if (state.chaseActive) return; // Prevent concurrent chases

    state.chaseActive = true;
    let filled = false;
    let attempts = 0;
    let currentVolume = volume;

    while (!filled && attempts < 5 && state.chaseActive) {
        let price = (direction === 'buy') ? market.bid : market.ask;
        if (applyOffset && price > 0) {
            price = (direction === 'buy') ? price * (1 - config.resetOffsetPct) : price * (1 + config.resetOffsetPct);
        }

        if (!price || price <= 0) break;

        // SHIB requires high precision (8-10 decimals)
        const formattedPrice = price.toFixed(10).replace(/\.?0+$/, ""); 

        const order = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: Math.floor(currentVolume), direction, offset, 
            lever_rate: config.leverage, order_price_type: 'limit', price: formattedPrice 
        });

        if (order?.status === 'ok') {
            const orderId = order.data.order_id;
            state.lastAction = `Limit ${offset} @ ${formattedPrice}`;
            
            await new Promise(r => setTimeout(r, config.chaseRetryMs));

            const info = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order_info', { 
                contract_code: config.symbol, order_id: orderId 
            });

            if (info?.status === 'ok' && info.data && info.data[0].status === 6) {
                filled = true;
                state.lastAction = "Filled";
            } else {
                // Cancel unfilled portion
                await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_cancel', { 
                    contract_code: config.symbol, order_id: orderId 
                });
                const tradeVol = (info?.data && info.data[0]) ? parseFloat(info.data[0].trade_volume) : 0;
                currentVolume -= tradeVol;
                if (currentVolume <= 1) filled = true; // Handle dust
            }
        }
        attempts++;
    }
    state.chaseActive = false;
}

// ==================== SYNC & LOOP ====================

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
        // Only trigger initial open if no chase is currently running
        if (s1.volume === 0 && s2.volume === 0 && !s1.chaseActive && !s2.chaseActive) {
            if (market.spread > 0 && market.spread <= config.maxStartSpread) {
                chaseLimitOrder(0, 'buy', config.baseVolume, 'open', false);
                chaseLimitOrder(1, 'sell', config.baseVolume, 'open', false);
            }
        }
    }
}

// (The rest of the WS, UI, and Reset functions remain identical to your original design)
// Ensure that inside flashReset, you also call chaseLimitOrder(accIdx, ...) 

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Engine Online - Chase Protection Active`));
