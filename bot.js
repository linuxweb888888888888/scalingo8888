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
    baseVolume: parseFloat(process.env.BASE_VOLUME) || 1,
    takeProfitPct: 2.0, 
    profitToLossRatio: 1.5, // Target: 50% more profit than loss
    pollInterval: 1000 // Fast sync with API values
};

let market = {
    status: 'Active', bid: 0, ask: 0,
    totalNetGain: 0, growthPct: 0,
    initialTotalEquity: 0,
    sessionRealizedProfit: 0, 
    netSessionUsdt: 0
};

let tradeHistory = [];
let accountStates = {};

config.accounts.forEach((account) => {
    accountStates[account.accountId] = {
        id: account.accountId,
        direction: account.direction,
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 1500 });
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
            // DIRECT EXCHANGE VALUES
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

function logTrade(side, roi, pnl, type, accId) {
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        side: `ACC${accId}-${side.toUpperCase()}`,
        roi: roi.toFixed(4) + '%', 
        pnl: pnl.toFixed(8),       
        total: market.totalNetGain.toFixed(8),
        type: type
    });
    if (tradeHistory.length > 25) tradeHistory.pop();
}

async function executeAction(accIdx, type) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    const finalRoi = state.roi;
    const finalPnl = state.unrealizedUsdt;

    // Use optimal_20 to ensure it closes immediately even in high volatility
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
    });

    market.sessionRealizedProfit += finalPnl;
    logTrade(state.direction, finalRoi, finalPnl, type, acc.accountId);

    setTimeout(async () => {
        await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
        state.isLocked = false;
        state.lastAction = "Idle";
    }, 2500);
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

                let totalUnrealized = 0;
                config.accounts.forEach((acc, idx) => {
                    const state = accountStates[acc.accountId];
                    totalUnrealized += state.unrealizedUsdt;

                    if (state.volume > 0 && !state.isLocked && market.status === 'Active') {
                        // TAKE PROFIT
                        if (state.roi >= config.takeProfitPct) {
                            executeAction(idx, 'TAKE_PROFIT');
                        }
                        // STOP LOSS (Logic Fix: Trigger if loss is >= allowed portion of profit)
                        else if (state.roi < 0) {
                            const currentLossAbs = Math.abs(state.unrealizedUsdt);
                            const maxAllowedLoss = market.sessionRealizedProfit / config.profitToLossRatio;
                            
                            // Trigger Stop Loss if loss reaches or exceeds the allowed threshold
                            if (market.sessionRealizedProfit > 0 && currentLossAbs >= maxAllowedLoss) {
                                executeAction(idx, 'STOP_LOSS');
                            }
                        }
                    }
                });
                market.netSessionUsdt = totalUnrealized + market.sessionRealizedProfit;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MAIN LOOP ====================
async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    let currentTotalEquity = 0;
    config.accounts.forEach(acc => {
        const state = accountStates[acc.accountId];
        currentTotalEquity += state.currentEquity;
        if (market.status === 'Active' && state.volume === 0 && !state.isLocked) {
             htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
        }
    });
    if (market.initialTotalEquity === 0 && currentTotalEquity > 0) market.initialTotalEquity = currentTotalEquity;
    market.totalNetGain = currentTotalEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;
}

async function manualClose() {
    if (market.status === "LIQUIDATING") return;
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        state.isLocked = true;
        if (state.volume > 0) {
            logTrade(state.direction, state.roi, state.unrealizedUsdt, 'MANUAL_CLOSE', acc.accountId);
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
    <meta charset="UTF-8"><title>Cluster Precision Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0f172a; color: white; font-family: 'JetBrains Mono', monospace; }
        .card { background: #1e293b; border-radius: 12px; padding: 15px; border: 1px solid #334155; }
        .stat-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; font-weight: bold; }
    </style>
</head>
<body class="p-4 md:p-8">
    <div class="max-w-6xl mx-auto">
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
            <div>
                <h1 class="text-xl font-black tracking-tighter uppercase italic">Precision <span class="text-indigo-400">Cluster</span></h1>
                <p id="mStatus" class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest italic">Engine Active</p>
            </div>
            <div class="bg-slate-800 p-4 rounded-xl border border-slate-700 min-w-[320px]">
                <p class="stat-label">Total Portfolio Net Gain</p>
                <p id="totalNetGain" class="text-xl font-black text-white tracking-tighter">$0.00000000</p>
                <p id="growthPct" class="text-[10px] text-emerald-400 font-bold uppercase tracking-widest mt-1">Growth: 0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div class="card border-l-4 border-emerald-500">
                <p class="stat-label text-emerald-500">Session Realized Profit</p>
                <p id="realizedProfit" class="text-2xl font-black text-emerald-400 tracking-tighter">$0.00000000</p>
                <p class="text-[9px] text-slate-500 mt-1 uppercase font-bold italic">Shielding next 66% loss</p>
            </div>
            <div class="card border-l-4 border-indigo-500">
                <p class="stat-label text-indigo-400">Net Session PnL</p>
                <p id="netSession" class="text-2xl font-black text-white tracking-tighter">$0.00000000</p>
            </div>
        </div>

        <div id="accountGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8"></div>

        <div class="card overflow-hidden mb-6">
            <p class="stat-label mb-3 px-2">History (Matches Exchange Exactly)</p>
            <table class="w-full text-left text-[10px]">
                <thead class="bg-slate-900/50 uppercase text-slate-500"><tr class="border-b border-slate-700"><th class="p-3">Time</th><th>Source</th><th>Type</th><th>ROI</th><th>PnL (8 Dec)</th></tr></thead>
                <tbody id="historyBody" class="font-bold"></tbody>
            </table>
        </div>

        <button onclick="triggerClose()" class="w-full py-5 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-xl transition-all shadow-2xl uppercase tracking-widest text-xs">
            Emergency Liquidate Cluster
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate all accounts?")) fetch('/api/close', { method: 'POST' }); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(8);
                document.getElementById('growthPct').innerText = 'Growth: ' + d.market.growthPct.toFixed(2) + '%';
                document.getElementById('realizedProfit').innerText = '$' + d.market.sessionRealizedProfit.toFixed(8);
                document.getElementById('netSession').innerText = '$' + d.market.netSessionUsdt.toFixed(8);

                let accHtml = '';
                d.accounts.forEach(a => {
                    const sideColor = a.direction === 'buy' ? 'text-emerald-400' : 'text-rose-400';
                    accHtml += \`
                        <div class="card border-t-2 border-slate-700">
                            <div class="flex justify-between items-center mb-2">
                                <span class="stat-label">Account #\${a.id}</span>
                                <span class="text-[9px] font-black px-2 py-0.5 rounded bg-slate-700 \${sideColor}">\${a.direction.toUpperCase()}</span>
                            </div>
                            <p class="text-2xl font-black \${a.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${a.roi.toFixed(4)}%</p>
                            <div class="flex justify-between mt-1">
                                <span class="text-[10px] text-slate-400 tracking-tighter">$\${a.unrealizedUsdt.toFixed(8)}</span>
                                <span class="text-[9px] text-indigo-400 font-bold uppercase italic">\${a.lastAction}</span>
                            </div>
                        </div>\`;
                });
                document.getElementById('accountGrid').innerHTML = accHtml;
                let histHtml = '';
                d.tradeHistory.forEach(h => {
                    histHtml += '<tr class="border-b border-slate-800/50"><td class="p-3">' + h.time + '</td><td>' + h.side + '</td><td class="text-indigo-400 italic">' + h.type + '</td><td class="' + (parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + h.roi + '</td><td>$' + h.pnl + '</td></tr>';
                });
                document.getElementById('historyBody').innerHTML = histHtml;
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Precision Cluster Engine Online.`));
