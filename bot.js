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
    // --- STRATEGY ADAPTATION ---
    scaleTriggerROI: 1.5,  // Add +1 contract only when up 1.5%
    takeProfitPct: 5.0,    // Target Win
    stopLossPct: -3.5,     // Hard Stop (Widened to survive SHIB noise)
    pollInterval: 2000
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
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
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
            state.entryPrice = parseFloat(pos.cost_open);
            state.roi = parseFloat(pos.profit_rate) * 100; 
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; }
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

    // Only scale if not locked, volume < 5, and 15 seconds have passed since last scale
    if (state.isLocked || state.volume >= config.maxVolume || (now - state.lastScaleTime < 15000)) return;

    state.isLocked = true;
    state.lastAction = "SCALE +1";
    
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
        contract_code: config.symbol, volume: 1, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
    });

    state.lastScaleTime = now;
    state.isLocked = false;
}

async function executeClose(accIdx, type) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    // Using optimal_20 for maximum speed to fight slippage
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
    });

    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        acc: `ACC${acc.accountId}`,
        side: state.direction.toUpperCase(),
        type: type,
        roi: state.roi.toFixed(4) + '%',
        pnl: state.unrealizedUsdt.toFixed(8)
    });

    // Re-open fresh position after cooldown
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
                        
                        // 1. SCALING: Add size if trade is proving successful
                        if (state.roi >= config.scaleTriggerROI && state.volume < config.maxVolume) {
                            scaleUp(idx);
                        }

                        // 2. PROFIT EXIT: Hit 5% target
                        if (state.roi >= config.takeProfitPct) {
                            executeClose(idx, 'TAKE_PROFIT');
                        } 
                        
                        // 3. RISK CUT: Hit -3.5% target
                        else if (state.roi <= config.stopLossPct) {
                            executeClose(idx, 'STOP_LOSS');
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
        // Start up if empty
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
    <meta charset="UTF-8"><title>Pro-Scaling Cluster</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #020617; color: white; font-family: 'JetBrains Mono', monospace; }</style>
</head>
<body class="p-6">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8 bg-slate-900 p-6 rounded-2xl border border-slate-800">
            <div>
                <h1 class="text-2xl font-black italic text-indigo-400 tracking-tighter">VOLATILITY CLUSTER V2</h1>
                <p class="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Mode: Scaled Aggression (Max 5 Units)</p>
            </div>
            <div class="text-right">
                <p class="text-[10px] text-slate-500 font-bold uppercase">Net Portfolio Gain</p>
                <p id="totalNetGain" class="text-3xl font-black text-emerald-400 tracking-tighter">$0.00000000</p>
            </div>
        </div>

        <div id="accountGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"></div>

        <div class="bg-slate-900 rounded-2xl overflow-hidden border border-slate-800">
            <div class="p-4 border-b border-slate-800 bg-slate-950/50">
                <span class="text-[10px] font-bold text-slate-400 uppercase">Live Performance Log</span>
            </div>
            <table class="w-full text-left text-[10px]">
                <thead class="bg-slate-950 text-slate-600 uppercase"><tr class="border-b border-slate-800 font-black"><th class="p-4">Time</th><th>Source</th><th>Side</th><th>Action</th><th>ROI</th><th>PnL (8 Dec)</th></tr></thead>
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
                    const volColor = a.volume > 1 ? 'text-indigo-400' : 'text-slate-600';
                    accHtml += \`
                        <div class="bg-slate-900 p-5 rounded-xl border border-slate-800 shadow-xl">
                            <div class="flex justify-between mb-3 items-center">
                                <span class="text-[9px] font-black bg-slate-800 px-2 py-0.5 rounded text-slate-400">ACC #\${a.id}</span>
                                <span class="text-[10px] font-black \${sideColor}">\${a.direction.toUpperCase()}</span>
                            </div>
                            <p class="text-3xl font-black \${a.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${a.roi.toFixed(4)}%</p>
                            <div class="mt-4 pt-3 border-t border-slate-800/50 flex justify-between items-center">
                                <span class="text-[11px] font-black \${volColor}">VOL: \${a.volume}</span>
                                <span class="text-[9px] text-indigo-400 font-bold uppercase italic">\${a.lastAction}</span>
                            </div>
                        </div>\`;
                });
                document.getElementById('accountGrid').innerHTML = accHtml;
                let histHtml = '';
                d.tradeHistory.forEach(h => {
                    histHtml += '<tr class="border-b border-slate-800/50"><td class="p-4 text-slate-500">' + h.time + '</td><td>' + h.acc + '</td><td>' + h.side + '</td><td class="text-indigo-400 italic">' + h.type + '</td><td class="' + (parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + '</td><td class="text-white">$' + h.pnl + '</td></tr>';
                });
                document.getElementById('historyBody').innerHTML = histHtml;
            } catch(e) {}
        }, 1200);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Pro-Scaling Cluster Engine Online.`));
