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
    pollInterval: 2000,       
    resetDiffThreshold: 2.5,
    chaseRetryMs: 2500, // How often to re-price the limit order
    makerFeeRate: 0.0002 // HTX Maker fees are lower than Taker
};

let market = { status: 'Active', bid: 0, ask: 0, spread: 0, diffSum: 0, resetUsed: false };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, entryPrice: 0, isLocked: false, lastAction: 'Idle'
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

/**
 * EXECUTE SMART LIMIT ORDER (CHASE MODE)
 * Places a limit order and re-prices it if it doesn't fill.
 */
async function executeSmartLimitOrder(accIdx, direction, volume, offset) {
    const account = config.accounts[accIdx];
    const state = accountStates[account.accountId];
    
    let filled = false;
    let attempts = 0;
    let activeOrderId = null;

    state.lastAction = `Chasing ${offset}...`;

    while (!filled && attempts < 15) { // Max 15 re-prices
        // 1. Determine best limit price (Maker Price)
        // If buying (open long/close short), place at Bid. If selling, place at Ask.
        const targetPrice = (direction === 'buy') ? market.bid : market.ask;
        
        if (!targetPrice) { await new Promise(r => setTimeout(r, 1000)); continue; }

        // 2. Place Order
        const orderRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol,
            volume: volume,
            direction: direction,
            offset: offset,
            lever_rate: config.leverage,
            order_price_type: 'limit',
            price: targetPrice
        });

        if (orderRes.status === 'ok') {
            activeOrderId = orderRes.data.order_id;
            
            // 3. Wait for fill
            await new Promise(r => setTimeout(r, config.chaseRetryMs));

            // 4. Check Status
            const checkRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                contract_code: config.symbol,
                order_id: activeOrderId
            });

            if (checkRes.status === 'ok' && checkRes.data[0]) {
                const orderData = checkRes.data[0];
                if (orderData.status === 6) { // Fully filled
                    filled = true;
                    state.lastAction = "Filled";
                } else {
                    // 5. Not filled, cancel and loop again to re-price
                    await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_cancel', {
                        contract_code: config.symbol,
                        order_id: activeOrderId
                    });
                    // If partially filled, update remaining volume
                    const remaining = volume - parseFloat(orderData.trade_volume);
                    if (remaining <= 0) filled = true;
                    volume = Math.floor(remaining); 
                }
            }
        }
        attempts++;
    }
}

// ==================== LOGIC UPDATES ====================

async function flashReset(accIdxToReset) {
    if (market.status !== 'Active' || market.resetUsed) return;
    const state = accountStates[config.accounts[accIdxToReset].accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    market.resetUsed = true; 
    
    // Chase Close
    await executeSmartLimitOrder(accIdxToReset, state.direction === 'buy' ? 'sell' : 'buy', state.volume, 'close');
    // Chase Re-open
    await executeSmartLimitOrder(accIdxToReset, state.direction, config.baseVolume, 'open');

    state.isLocked = false;
}

async function manualClose(type = 'MANUAL') {
    if (market.status === "LIQUIDATING") return; 
    market.status = "LIQUIDATING";
    
    const tasks = config.accounts.map((acc, idx) => {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            return executeSmartLimitOrder(idx, state.direction === 'buy' ? 'sell' : 'buy', state.volume, 'close');
        }
    });

    await Promise.all(tasks);
    market.resetUsed = false;
    market.status = "Active";
}

// ==================== ENGINE CORE ====================

async function backgroundLoop() {
    // Sync accounts
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (posRes?.status === 'ok' && posRes.data) {
            const pos = posRes.data.find(p => p.direction === state.direction);
            state.volume = pos ? Math.floor(parseFloat(pos.volume)) : 0;
            state.entryPrice = pos ? parseFloat(pos.cost_open) : 0;
            state.roi = pos ? parseFloat(pos.profit_rate) * 100 : 0;
        }
    }

    const s1 = accountStates[1]; const s2 = accountStates[2];
    
    if (market.status === 'Active') {
        // Initial Open (Both sides)
        if (s1.volume === 0 && s2.volume === 0 && !s1.isLocked && !s2.isLocked) {
            if (market.spread > 0 && market.spread <= config.maxStartSpread) {
                config.accounts.forEach((acc, idx) => {
                    executeSmartLimitOrder(idx, accountStates[acc.accountId].direction, config.baseVolume, 'open');
                });
            }
        }

        // Logic for Reset Trigger
        const lRoi = s1.entryPrice > 0 ? ((market.bid - s1.entryPrice) / s1.entryPrice) * config.leverage * 100 : 0;
        const sRoi = s2.entryPrice > 0 ? ((s2.entryPrice - market.ask) / s2.entryPrice) * config.leverage * 100 : 0;
        const winRoi = Math.max(lRoi, sRoi);
        market.diffSum = winRoi - (market.spread * config.leverage);

        if (!market.resetUsed && market.diffSum >= config.resetDiffThreshold) {
            lRoi < sRoi ? flashReset(0) : flashReset(1);
        }
    }
}

// Start WS (Bid/Ask source)
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
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Limit Chase Engine Online`));
