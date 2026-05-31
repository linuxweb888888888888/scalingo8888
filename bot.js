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
    leverage: parseInt(process.env.LEVERAGE) || 20,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 100, 
    
    // THE ONLY RULE:
    minDiffSum: 1.0,          // 1% Threshold
    
    pollInterval: 2000,
    resetCooldownMs: 3000,
    historySize: 20
};

// ==================== DATA TRACKING ====================
let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    resetPenalty: 0, diffSum: 0, winningSide: 'None',
    totalNetGain: 0, realizedSessPnl: 0, 
    initialTotalEquity: 0, resetUsed: false 
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

async function flashReset(accIdxToReset) {
    if (market.resetUsed) return;
    const acc = config.accounts[accIdxToReset];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    market.resetUsed = true;
    state.lastAction = "⚡ RESET";
    
    logTrade(state.direction, state.roi, state.unrealizedUsdt, 'BANK');

    // Close and Re-open winning side
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { state.isLocked = false; state.lastAction = "Idle"; market.resetUsed = false; }, config.resetCooldownMs);
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
                market.resetPenalty = (market.spread * config.leverage);

                const l = accountStates[1]; const s = accountStates[2];
                const liveLongRoi = l.entryPrice > 0 ? ((market.bid - l.entryPrice) / l.entryPrice) * config.leverage * 100 : 0;
                const liveShortRoi = s.entryPrice > 0 ? ((s.entryPrice - market.ask) / s.entryPrice) * config.leverage * 100 : 0;
                
                const winRoi = Math.max(liveLongRoi, liveShortRoi);
                market.winningSide = liveLongRoi > liveShortRoi ? 'Long' : 'Short';

                // THE CALCULATION: Win ROI + Reset ROI (Reset is negative penalty)
                market.diffSum = winRoi - market.resetPenalty;

                // THE TRIGGER: Difference Sum must be > 1.0%
                if (!market.resetUsed && market.diffSum >= config.minDiffSum) {
                    liveLongRoi > liveShortRoi ? flashReset(0) : flashReset(1);
                }
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MAIN LOOP ====================
async function backgroundLoop() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    const s1 = accountStates[1]; const s2 = accountStates[2];
    const totalCurrentEquity = s1.currentEquity + s2.currentEquity;
    const totalStartEquity = (s1.initialEquity || 0) + (s2.initialEquity || 0);
    if (market.initialTotalEquity === 0 && totalStartEquity > 0) market.initialTotalEquity = totalStartEquity;
    market.totalNetGain = totalCurrentEquity - totalStartEquity;
    market.realizedSessPnl = market.totalNetGain - (s1.unrealizedUsdt + s2.unrealizedUsdt);

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked && market.status === "Active") {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
    }
}

async function manualClose() {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    setTimeout(() => { market.status = "Active"; }, 5000);
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>1% Fixed Diff Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #020617; color: white; font-family: sans-serif; }
        .card { background: #0f172a; border-radius: 12px; border: 1px solid #1e293b; }
        .label { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-3xl mx-auto">
        <div class="flex justify-between items-end mb-8">
            <div>
                <h1 class="text-2xl font-black italic">DIFF-GAUGE <span class="text-indigo-500">1.0</span></h1>
                <p id="botStatus" class="text-xs font-bold text-emerald-400">ENGINE ACTIVE</p>
            </div>
            <div class="text-right">
                <p class="label">Total Realized</p>
                <p id="totalNetGain" class="text-2xl font-black text-white">$0.0000</p>
            </div>
        </div>

        <div class="card p-8 mb-6 border-t-4 border-indigo-500">
            <p class="label mb-2">Difference Sum (Profit - Penalty)</p>
            <div class="flex items-baseline gap-4">
                <p id="uiDiffSum" class="text-6xl font-black">+0.00%</p>
                <p class="text-slate-500 font-bold">/ 1.00%</p>
            </div>
            <div class="mt-6 flex gap-6">
                <div>
                    <p class="label">Winning Side</p>
                    <p id="uiWinningSide" class="font-bold text-indigo-400">---</p>
                </div>
                <div>
                    <p class="label">Reset Penalty (Loss)</p>
                    <p id="uiPenalty" class="font-bold text-rose-400">-0.00%</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="card p-6">
                <p class="label text-emerald-500">Long ROI</p>
                <p id="lRoi" class="text-3xl font-black">0.00%</p>
            </div>
            <div class="card p-6 text-right">
                <p class="label text-rose-500">Short ROI</p>
                <p id="sRoi" class="text-3xl font-black">0.00%</p>
            </div>
        </div>

        <div class="card overflow-hidden">
            <div class="p-4 bg-slate-900 label">Trade History</div>
            <table class="w-full text-left text-xs">
                <tbody id="historyBody" class="divide-y divide-slate-800"></tbody>
            </table>
        </div>

        <button onclick="fetch('/api/close', {method:'POST'})" class="w-full mt-6 py-4 bg-rose-600 rounded-xl font-bold uppercase tracking-widest">Liquidate All</button>
    </div>

    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            const diffElem = document.getElementById('uiDiffSum');
            diffElem.innerText = (d.market.diffSum >= 0 ? '+' : '') + d.market.diffSum.toFixed(2) + '%';
            diffElem.className = 'text-6xl font-black ' + (d.market.diffSum >= 1.0 ? 'text-emerald-400' : 'text-white');
            
            document.getElementById('uiPenalty').innerText = '-' + d.market.resetPenalty.toFixed(2) + '%';
            document.getElementById('uiWinningSide').innerText = d.market.winningSide;
            document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(4);
            
            d.accounts.forEach((a, i) => {
                const p = i === 0 ? 'l' : 's';
                document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                document.getElementById(p+'Roi').className = 'text-3xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
            });

            document.getElementById('historyBody').innerHTML = d.tradeHistory.map(h => \`
                <tr>
                    <td class="p-3 text-slate-500 font-bold">\${h.time}</td>
                    <td class="p-3 font-black text-indigo-400">\${h.type}</td>
                    <td class="p-3 font-bold">\${h.side}</td>
                    <td class="p-3 font-black">\${h.roi}</td>
                    <td class="p-3 text-right font-black text-white">\$\${h.total}</td>
                </tr>\`).join('');
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Engine Online: 1% Fixed Rule`));
