require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== DYNAMIC CLUSTER CONFIG ====================
const apiAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex,
        direction: (accountIndex % 2 !== 0) ? 'buy' : 'sell' 
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
    minVolume: 1,
    maxVolume: 5,
    scaleTriggerROI: 0.5, // Add contract at 0.5% ROI
    takeProfitPct: 2.0, 
    stopLossPct: -1.0, 
    pollInterval: 1500
};

let market = {
    status: 'Active', bid: 0, ask: 0,
    totalNetGain: 0, initialTotalEquity: 0,
    sessionRealized: 0
};

let tradeHistory = [];
let accountStates = {};

config.accounts.forEach((acc) => {
    accountStates[acc.accountId] = {
        id: acc.accountId, direction: acc.direction,
        roi: 0, volume: 0, unrealizedUsdt: 0,
        currentEquity: 0, isLocked: false, 
        lastAction: 'Idle', lastScaleTime: 0
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
            state.volume = parseFloat(pos.volume);
            state.roi = parseFloat(pos.profit_rate) * 100; 
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        if (market.initialTotalEquity === 0) market.initialTotalEquity += state.currentEquity;
    }
}

async function scaleUp(accIdx) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    const now = Date.now();

    if (state.isLocked || state.volume >= config.maxVolume || (now - state.lastScaleTime < 10000)) return;

    state.isLocked = true;
    state.lastAction = "SCALING +1";
    
    const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbol, volume: 1, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
    });

    if (res.status === 'ok') {
        state.lastScaleTime = now;
    }
    state.isLocked = false;
}

async function closeAndReset(accIdx, type) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
    });

    market.sessionRealized += state.unrealizedUsdt;
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        acc: `ACC${acc.accountId}`,
        side: state.direction.toUpperCase(),
        type: type,
        roi: state.roi.toFixed(4) + '%',
        pnl: state.unrealizedUsdt.toFixed(8)
    });

    // Auto-Adjust: Re-open at minVolume to restart the cycle
    setTimeout(async () => {
        await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: config.minVolume, direction: state.direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
        state.isLocked = false;
        state.lastAction = "Idle";
        state.lastScaleTime = 0;
    }, 3000);
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
                market.bid = msg.tick.bid[0]; market.ask = msg.tick.ask[0];

                config.accounts.forEach((acc, idx) => {
                    const state = accountStates[acc.accountId];
                    if (state.volume > 0 && !state.isLocked) {
                        // 1. SMART SCALING: If winning, add to profit
                        if (state.roi >= config.scaleTriggerROI && state.volume < config.maxVolume) {
                            scaleUp(idx);
                        }
                        // 2. PROFIT EXIT
                        if (state.roi >= config.takeProfitPct) {
                            closeAndReset(idx, 'TAKE_PROFIT');
                        } 
                        // 3. RISK CUT
                        else if (state.roi <= config.stopLossPct) {
                            closeAndReset(idx, 'STOP_LOSS');
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
    let currentTotal = 0;
    config.accounts.forEach(acc => {
        const state = accountStates[acc.accountId];
        currentTotal += state.currentEquity;
        if (market.status === 'Active' && state.volume === 0 && !state.isLocked) {
             htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.minVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
        }
    });
    market.totalNetGain = currentTotal - market.initialTotalEquity;
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Dynamic Scaling Cluster</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #020617; color: white; font-family: 'JetBrains Mono', monospace; }</style>
</head>
<body class="p-6">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8 bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-2xl">
            <div>
                <h1 class="text-2xl font-black italic text-indigo-500">AUTO-SCALING CLUSTER</h1>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Dynamic Volume: 1-5 Contracts | Auto-Adjusting Weight</p>
            </div>
            <div class="text-right">
                <p class="text-[10px] text-slate-500 font-bold">NET PORTFOLIO GAIN</p>
                <p id="totalNetGain" class="text-3xl font-black text-emerald-400 tracking-tighter">$0.00000000</p>
            </div>
        </div>

        <div id="accountGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"></div>

        <div class="bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 shadow-xl">
            <div class="p-4 border-b border-slate-800 flex justify-between items-center">
                <span class="text-[10px] font-bold text-slate-400 uppercase">Live Scaled History</span>
                <span class="text-[10px] text-indigo-400 font-bold px-2 py-1 bg-indigo-500/10 rounded">Smart-Ratio: 2:1</span>
            </div>
            <table class="w-full text-left text-[10px]">
                <thead class="bg-slate-950 text-slate-600 uppercase"><tr class="border-b border-slate-800"><th class="p-4">Time</th><th>Source</th><th>Side</th><th>Action</th><th>ROI</th><th>PnL</th></tr></thead>
                <tbody id="historyBody" class="font-bold"></tbody>
            </table>
        </div>
    </div>
    <script>
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(8);
                let accHtml = '';
                d.accounts.forEach(a => {
                    const sideColor = a.direction === 'buy' ? 'text-emerald-400' : 'text-rose-400';
                    const volColor = a.volume > 1 ? 'text-indigo-400' : 'text-slate-500';
                    accHtml += \`
                        <div class="bg-slate-900 p-5 rounded-xl border border-slate-800 shadow-lg">
                            <div class="flex justify-between mb-3">
                                <span class="text-[10px] font-bold text-slate-500">ACC #\${a.id}</span>
                                <span class="text-[10px] font-black \${sideColor}">\${a.direction.toUpperCase()}</span>
                            </div>
                            <p class="text-3xl font-black \${a.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${a.roi.toFixed(4)}%</p>
                            <div class="mt-3 pt-3 border-t border-slate-800 flex justify-between items-center">
                                <span class="text-[10px] font-bold \${volColor}">VOL: \${a.volume}</span>
                                <span class="text-[9px] text-slate-600 italic font-bold uppercase">\${a.lastAction}</span>
                            </div>
                        </div>\`;
                });
                document.getElementById('accountGrid').innerHTML = accHtml;
                let histHtml = '';
                d.tradeHistory.forEach(h => {
                    histHtml += '<tr class="border-b border-slate-800/50"><td class="p-4 text-slate-500">' + h.time + '</td><td>' + h.acc + '</td><td>' + h.side + '</td><td class="text-indigo-400">' + h.type + '</td><td class="' + (parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + '</td><td class="text-white">$' + h.pnl + '</td></tr>';
                });
                document.getElementById('historyBody').innerHTML = histHtml;
            } catch(e) {}
        }, 1200);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Scaling Cluster Engine Active.`));
