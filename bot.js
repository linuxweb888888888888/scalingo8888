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
    
    // --- STRATEGY PARAMETERS ---
    minNetProfitUsdt: 0.10,      // Minimum profit in USDT after fees to trigger a close
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1, 
    rebalanceStep: 0.2,          // Small volume to add when syncing (e.g., 0.2 contracts)
    syncThreshold: 0.15,         // If (Long ROI + Short ROI) differs by > 0.15%, trigger rebalance
    priceTolerance: 0.04,        
    feeRate: 0.0005              // 0.05% Taker fee
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, bid: 0, ask: 0, spread: 0, status: 'initializing' };
let accountStates = {};
let isProcessing = false;
let lastRebalanceTime = 0;

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0, wallet: 0,
        unrealizedUsdt: 0, initialBalance: 0, realizedProfit: 0
    };
});

// ==================== API HANDLER ====================
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

// ==================== LOGIC ====================

async function sync() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.status === 'ok' && res.data) {
            const pos = res.data.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);
            if (pos) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = parseFloat(pos.volume);
                state.unrealizedUsdt = parseFloat(pos.profit) || 0;
                const price = market.last;
                state.roi = state.direction === 'buy' 
                    ? ((price - state.avgPrice) / state.avgPrice) * 100 * config.leverage
                    : ((state.avgPrice - price) / state.avgPrice) * 100 * config.leverage;
            } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }
    }
}

async function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    // 1. OPEN INITIAL POSITIONS
    if (long.volume === 0 && short.volume === 0) {
        if (market.spread > config.priceTolerance) {
            market.status = `Waiting for Sync Spread (${market.spread.toFixed(3)}%)`;
            return;
        }
        market.status = 'Opening Initial Hedge';
        isProcessing = true;
        await Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            })
        ]);
        setTimeout(() => { isProcessing = false; }, 3000);
        return;
    }

    // 2. CALCULATE NET PROFIT (Profit - Fees)
    const totalNotional = (long.volume + short.volume) * market.last; 
    // Note: In real HTX SHIB, notional is volume * contract_size * price. 
    // Adjust logic if contract_size is not 1.
    const estimatedExitFees = totalNotional * config.feeRate;
    const netExitProfit = (long.unrealizedUsdt + short.unrealizedUsdt) - estimatedExitFees;

    // 3. EXIT STRATEGY
    if (netExitProfit >= config.minNetProfitUsdt) {
        market.status = `Profit Goal Met ($${netExitProfit.toFixed(4)})`;
        await closeAll();
        return;
    }

    // 4. ROI SYNCING (SLOW REBALANCE)
    const drift = long.roi + short.roi; // Ideally 0. 
    const now = Date.now();

    // If drift is negative (one side losing faster), add small size to the lagging side
    if (Math.abs(drift) > config.syncThreshold && (now - lastRebalanceTime > 15000)) {
        market.status = `Syncing ROI (Drift: ${drift.toFixed(2)}%)`;
        const accountToAdjust = drift < 0 
            ? (long.roi < short.roi ? config.accounts[0] : config.accounts[1]) 
            : null;

        if (accountToAdjust) {
            const side = accountStates[accountToAdjust.accountId].direction;
            await htxRequest(accountToAdjust, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.rebalanceStep, direction: side, offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            lastRebalanceTime = now;
        }
    } else {
        market.status = `Hedged (Net: $${netExitProfit.toFixed(4)})`;
    }
}

async function closeAll() {
    isProcessing = true;
    await Promise.all(config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        return state.volume > 0 ? htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
        }) : Promise.resolve();
    }));
    setTimeout(() => { isProcessing = false; }, 5000);
}

// ==================== WS & DASHBOARD ====================
// (Keep existing WS and Express code from your snippet, but update the UI script below)

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
                market.last = (market.bid + market.ask) / 2;
                market.spread = ((market.ask - market.bid) / market.last) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.get('/', (req, res) => {
    // ... Copy your existing HTML here, but update the script section:
    res.send(`... [Previous HTML Code] ...
    <script>
        async function update() {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
            document.getElementById('botStatus').innerText = d.market.status;
            
            let totalUnrealized = 0;
            let totalVol = 0;

            d.accounts.forEach(a => {
                const isLong = a.direction === 'buy';
                const prefix = isLong ? 'long' : 'short';
                document.getElementById(prefix + 'Roi').innerText = a.roi.toFixed(2) + '%';
                document.getElementById(prefix + 'Usdt').innerText = '$' + a.unrealizedUsdt.toFixed(4);
                totalUnrealized += a.unrealizedUsdt;
                totalVol += a.volume;
            });

            const fees = (totalVol * d.market.last) * d.config.feeRate;
            const net = totalUnrealized - fees;
            
            const pElem = document.getElementById('netProfit');
            pElem.innerText = (net >= 0 ? '+' : '') + '$' + net.toFixed(4);
            pElem.className = 'text-6xl font-black mb-4 font-mono ' + (net >= 0 ? 'text-emerald-400' : 'text-rose-500');
        }
        setInterval(update, 1000);
    </script>
    `);
});

startWS();
setInterval(sync, 2000);
setInterval(tradeLoop, 3000);
app.listen(config.port, '0.0.0.0');
