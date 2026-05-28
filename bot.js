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
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 1.5,
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1,
    // 🎯 PRICE SYNC TOLERANCE
    // 0.02 means the Bid and Ask must be within 0.02% of each other to open.
    // If your entry prices aren't "the same" enough, decrease this number.
    priceTolerance: 0.03, 
    hedgeThreshold: 3.0, 
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, bid: 0, ask: 0, spread: 0, syncStatus: 'waiting' };
let accountStates = {};
let isProcessing = false;
let startTime = Date.now();

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

// ==================== SYNC DATA ====================
async function sync() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.data) {
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
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const bal = parseFloat(accRes.data[0].margin_balance);
            if (state.initialBalance === 0) state.initialBalance = bal;
            state.wallet = bal;
            state.realizedProfit = bal - state.initialBalance;
        }
    }
}

// ==================== TRADE LOOP WITH PRICE CHECK ====================
async function tradeLoop() {
    if (isProcessing || market.last === 0) return;
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    // If we have no positions, check if entry prices are "The Same"
    if (long.volume === 0 && short.volume === 0) {
        
        // 🛡️ THE GATEKEEPER: Check if Bid/Ask spread is within tolerance
        if (market.spread > config.priceTolerance) {
            market.syncStatus = `Unsynced (${market.spread.toFixed(3)}%)`;
            return; 
        }

        market.syncStatus = 'Synced - Opening';
        isProcessing = true;
        
        // ATOMIC OPEN (Simultaneous)
        await Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            })
        ]);
        setTimeout(() => { isProcessing = false; }, 2000);

    } else if (long.volume > 0 && short.volume > 0) {
        market.syncStatus = 'Hedged';
        if (long.roi >= config.takeProfitPercent || short.roi >= config.takeProfitPercent) await closeAll();
        if (Math.abs(long.roi + short.roi) > config.hedgeThreshold) await closeAll();
    } else {
        await closeAll();
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
    setTimeout(() => { isProcessing = false; }, 2000);
}

// ==================== WS (BBO DATA) ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo1' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                market.last = (market.bid + market.ask) / 2;
                // Calculate real-time price difference (spread)
                market.spread = ((market.ask - market.bid) / market.last) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Atomic Sync</title><script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #0c0c0e; color: #e4e4e7; font-family: sans-serif; }</style></head>
    <body class="p-8"><div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-end mb-8 bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800">
            <div><h1 class="text-xl font-black tracking-tighter text-indigo-500 uppercase">Atomic Sync Bot</h1>
            <p class="text-[10px] font-bold text-zinc-500 uppercase">Status: <span id="status" class="text-indigo-400">--</span></p></div>
            <div class="text-right"><p id="price" class="text-2xl font-mono font-bold">0.00000000</p></div>
        </div>
        <div class="bg-zinc-900/50 rounded-3xl p-8 border border-zinc-800 mb-6 text-center">
            <p class="text-[10px] text-zinc-500 font-bold uppercase mb-2">Price Sync (Spread)</p>
            <h2 id="spreadDisplay" class="text-4xl font-black font-mono">0.000%</h2>
            <p class="text-[10px] text-zinc-600 mt-2">Opening Tolerance: < ${config.priceTolerance}%</p>
        </div>
        <div id="accs" class="grid grid-cols-2 gap-4"></div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('price').innerText = d.market.last.toFixed(8);
            document.getElementById('status').innerText = d.market.syncStatus;
            
            const sp = d.market.spread;
            const spEl = document.getElementById('spreadDisplay');
            spEl.innerText = sp.toFixed(3) + '%';
            spEl.className = 'text-4xl font-black font-mono ' + (sp <= ${config.priceTolerance} ? 'text-emerald-500' : 'text-zinc-600');

            document.getElementById('accs').innerHTML = d.accounts.map(a => \`
                <div class="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800">
                    <div class="flex justify-between text-[10px] font-bold uppercase mb-2">
                        <span class="\${a.direction==='buy'?'text-emerald-500':'text-rose-500'}">\${a.direction}</span>
                        <span class="\${a.roi>=0?'text-emerald-400':'text-rose-400'}">\${a.roi.toFixed(2)}%</span>
                    </div>
                    <div class="text-xs font-mono text-zinc-500">Entry: \${(a.avgPrice||0).toFixed(8)}</div>
                </div>
            \`).join('');
        }, 1000);
    </script></body></html>`);
});

startWS();
setInterval(sync, 2000);
setInterval(tradeLoop, 3000);
app.listen(config.port, '0.0.0.0', () => console.log('Hedge Sync Active'));
