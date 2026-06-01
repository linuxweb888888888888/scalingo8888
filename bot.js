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
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    takeProfitPct: 2.0, // Set to 2%
    pollInterval: 1500,
    takerFeeRate: 0.0005
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0,
    initialTotalEquity: 0,
    sessionRealizedProfit: 0, // Track profit made from TPs
    netSessionUsdt: 0
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

async function executeAction(accIdx, type) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    // Close Position
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    if (type === 'TAKE_PROFIT') {
        market.sessionRealizedProfit += state.unrealizedUsdt;
    } else if (type === 'STOP_LOSS') {
        market.sessionRealizedProfit += state.unrealizedUsdt;
    }

    logTrade(state.direction, state.roi, state.unrealizedUsdt, type);

    // Re-open fresh position
    setTimeout(async () => {
        await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
        state.isLocked = false;
        state.lastAction = "Idle";
    }, 2000);
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

                const s1 = accountStates[1]; 
                const s2 = accountStates[2];
                if (!s1 || !s2) return;
                
                market.netSessionUsdt = (s1.unrealizedUsdt + s2.unrealizedUsdt) + market.sessionRealizedProfit;

                // Individual side logic
                [s1, s2].forEach((state, idx) => {
                    if (state.volume > 0 && !state.isLocked) {
                        // 1. Take Profit at 2%
                        if (state.roi >= config.takeProfitPct) {
                            executeAction(idx, 'TAKE_PROFIT');
                        }
                        // 2. Stop Loss only if current loss < total realized profit
                        else if (state.roi < 0) {
                            const currentLossAbs = Math.abs(state.unrealizedUsdt);
                            if (currentLossAbs < market.sessionRealizedProfit && market.sessionRealizedProfit > 0) {
                                executeAction(idx, 'STOP_LOSS');
                            }
                        }
                    }
                });
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

    // Auto-initiate positions if empty
    if (market.status === 'Active') {
        if (s1.volume === 0 && s2.volume === 0 && !s1.isLocked && !s2.isLocked) {
            for (const acc of config.accounts) {
                await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: config.baseVolume, direction: accountStates[acc.accountId].direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
            }
        }
    }
}

async function manualClose() {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        state.isLocked = true;
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
        }
    }
    market.sessionRealizedProfit = 0;
    setTimeout(() => {
        config.accounts.forEach(acc => { accountStates[acc.accountId].isLocked = false; });
        market.status = "Active";
    }, 5000);
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>TP/SL Hedge Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0f172a; color: white; font-family: sans-serif; }
        .card { background: #1e293b; border-radius: 15px; padding: 20px; border: 1px solid #334155; }
        .stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: bold; }
    </style>
</head>
<body class="p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-bold">Hedge <span class="text-indigo-400">TP/SL</span></h1>
            <div class="text-right">
                <p id="totalNetGain" class="text-2xl font-bold">$0.00</p>
                <p id="growthPct" class="text-xs text-emerald-400">0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-6 mb-6">
            <div class="card">
                <p class="stat-label">Realized Session Profit</p>
                <p id="realizedProfit" class="text-3xl font-bold text-emerald-400">$0.00</p>
            </div>
            <div class="card">
                <p class="stat-label">Net Session PnL</p>
                <p id="netSession" class="text-3xl font-bold text-white">$0.00</p>
            </div>
        </div>

        <div class="card mb-6">
            <div class="grid grid-cols-2 gap-10">
                <div>
                    <p class="stat-label text-emerald-500">Long Side</p>
                    <p id="lRoi" class="text-4xl font-bold">0.00%</p>
                    <p id="lPnl" class="text-slate-400">$0.00</p>
                </div>
                <div class="text-right">
                    <p class="stat-label text-rose-500">Short Side</p>
                    <p id="sRoi" class="text-4xl font-bold">0.00%</p>
                    <p id="sPnl" class="text-slate-400">$0.00</p>
                </div>
            </div>
        </div>

        <div class="card overflow-hidden">
            <table class="w-full text-left text-xs">
                <thead><tr class="text-slate-500 border-b border-slate-700"><th class="pb-2">Time</th><th class="pb-2">Type</th><th class="pb-2">Side</th><th class="pb-2">ROI</th><th class="pb-2">PnL</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>

    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(4);
            document.getElementById('growthPct').innerText = d.market.growthPct.toFixed(2) + '%';
            document.getElementById('realizedProfit').innerText = '$' + d.market.sessionRealizedProfit.toFixed(4);
            document.getElementById('netSession').innerText = '$' + d.market.netSessionUsdt.toFixed(4);
            
            d.accounts.forEach((a, i) => {
                const p = i === 0 ? 'l' : 's';
                document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                document.getElementById(p+'Roi').className = 'text-4xl font-bold ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(4);
            });

            let html = '';
            d.tradeHistory.forEach(h => {
                html += '<tr class="border-b border-slate-800/50"><td class="py-2">' + h.time + '</td><td class="font-bold text-indigo-400">' + h.type + '</td><td>' + h.side + '</td><td class="font-bold">' + h.roi + '</td><td>$' + h.pnl + '</td></tr>';
            });
            document.getElementById('historyBody').innerHTML = html;
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`TP/SL Engine Online (TP: 2%)`));
