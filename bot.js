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
// Detect Keys
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}
if (apiAccounts.length === 0 && process.env.HTX_API_KEY) {
    apiAccounts.push({ apiKey: process.env.HTX_API_KEY, secretKey: process.env.HTX_SECRET_KEY, accountId: 1 });
}

const config = {
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 1.5,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 5.0,
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1, // 1 contract = 1,000,000 SHIB usually
    hedgeThreshold: parseFloat(process.env.HEDGE_THRESHOLD) || 0.5,
    maxSpreadPct: 0.5 // Loosened significantly to ensure opening
};

// ==================== GLOBAL STATE ====================
let marketData = { bid: 0, ask: 0, mid: 0, spread: 0 };
let accountStates = {};
let totalResets = 0;
let isOpeningPositions = false;

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        accountId: account.accountId,
        direction: idx === 0 ? 'buy' : 'sell',
        walletBalance: 0,
        initialBalance: 0,
        avgPrice: 0,
        roi: 0,
        position: { volume: 0 },
        realizedProfit: 0
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
        if (res.data.status !== 'ok') console.log(`❌ API Error: ${res.data['err-msg'] || res.data['err_msg']}`);
        return res.data;
    } catch (e) { 
        console.log(`❌ Network Error: ${e.message}`);
        return { status: 'error' }; 
    }
}

// ==================== SYNC ====================
async function syncAccountData(account, state) {
    try {
        const posRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (posRes?.data) {
            const pos = posRes.data.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);
            if (pos) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.position.volume = parseFloat(pos.volume);
                state.roi = state.direction === 'buy' 
                    ? ((marketData.mid - state.avgPrice) / state.avgPrice) * 100 * config.leverage
                    : ((state.avgPrice - marketData.mid) / state.avgPrice) * 100 * config.leverage;
            } else {
                state.position.volume = 0;
                state.roi = 0;
            }
        }
        
        const accRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const bal = parseFloat(acc.margin_balance);
            if (state.initialBalance === 0) state.initialBalance = bal;
            state.walletBalance = bal;
            state.realizedProfit = bal - state.initialBalance;
        }
    } catch (e) { console.log("Sync failed"); }
}

// ==================== CORE LOGIC ====================

async function openBothPositionsTogether() {
    if (isOpeningPositions || marketData.mid === 0) return;

    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    // Only open if BOTH are empty
    if (long.position.volume === 0 && short.position.volume === 0) {
        
        console.log(`[CHECK] Mid: ${marketData.mid} | Spread: ${marketData.spread.toFixed(4)}% | Target: < ${config.maxSpreadPct}%`);

        if (marketData.spread > config.maxSpreadPct) return;

        isOpeningPositions = true;
        console.log(`🚀 SPREAD OK. ATTEMPTING TO OPEN ATOMICALY...`);

        const orders = [
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize,
                direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            })
        ];

        const results = await Promise.all(orders);
        
        if (results[0].status === 'ok' && results[1].status === 'ok') {
            console.log("✅ BOTH ORDERS PLACED SUCCESSFULLY");
        } else {
            console.log("⚠️ ONE OR BOTH ORDERS FAILED. Check balance or contract size.");
        }

        await new Promise(r => setTimeout(r, 2000));
        isOpeningPositions = false;
    }
}

async function handleLogic() {
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    if (long.position.volume > 0 && short.position.volume > 0) {
        const totalRoi = long.roi + short.roi;
        const drift = Math.abs(totalRoi);

        // TP Check
        if (long.roi >= config.takeProfitPercent || short.roi >= config.takeProfitPercent) {
            console.log("🎯 TARGET PROFIT REACHED. CLOSING BOTH.");
            await closeAll();
        } 
        // Safety Drift Reset
        else if (drift > config.hedgeThreshold) {
            console.log(`🔄 DRIFT TOO HIGH (${drift.toFixed(2)}%). RESETTING.`);
            await closeAll();
        }
    } 
    // Orphan Cleanup
    else if ((long.position.volume > 0) !== (short.position.volume > 0)) {
        console.log("⚠️ ORPHAN DETECTED. CLEANING...");
        await closeAll();
    }
}

async function closeAll() {
    const actions = config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        if (state.position.volume > 0) {
            return htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.position.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
        return Promise.resolve();
    });
    await Promise.all(actions);
    totalResets++;
}

// ==================== WS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                marketData.bid = msg.tick.bid[0];
                marketData.ask = msg.tick.ask[0];
                marketData.mid = (marketData.bid + marketData.ask) / 2;
                marketData.spread = ((marketData.ask - marketData.bid) / marketData.mid) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== WEB & INIT ====================
app.get('/api/status', (req, res) => {
    res.json({ mid: marketData.mid, spread: marketData.spread, totalResets, accounts: Object.values(accountStates) });
});

app.get('/', (req, res) => {
    res.send(`<html><body style="background:#111;color:#eee;font-family:sans-serif;padding:20px;">
        <h1>Perfect Hedge</h1>
        <div id="data">Loading...</div>
        <script>
            setInterval(async () => {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('data').innerHTML = 'Price: ' + d.mid.toFixed(8) + '<br>Spread: ' + d.spread.toFixed(4) + '%<br>Resets: ' + d.totalResets + 
                d.accounts.map(a => '<div style="margin:10px;padding:10px;border:1px solid #444;">' + a.direction + ' ROI: ' + a.roi.toFixed(2) + '%</div>').join('');
            }, 1000);
        </script></body></html>`);
});

async function main() {
    console.log("Checking API Connection...");
    const test = await htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (test.status !== 'ok') {
        console.log("FATAL: API Key invalid or insufficient permissions!");
        return;
    }
    console.log("Connection OK. Starting WebSocket...");
    startWS();
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`Web UI: http://localhost:${config.port}`);
        setInterval(async () => {
            for (const acc of config.accounts) await syncAccountData(acc, accountStates[acc.accountId]);
        }, 2000);
        setInterval(async () => {
            await openBothPositionsTogether();
            await handleLogic();
        }, 3000);
    });
}

main();
