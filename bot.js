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
        id: accountIndex 
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
    takeProfitPct: 2.0,
    pollInterval: 2000
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

config.accounts.forEach((account, idx) => {
    accountStates[account.id] = {
        id: account.id,
        direction: idx % 2 === 0 ? 'buy' : 'sell',
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 3000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc) {
    const state = accountStates[acc.id];
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const equity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = equity;
        state.currentEquity = equity;
    }
}

async function executeAction(accId, type) {
    const state = accountStates[accId];
    const acc = config.accounts.find(a => a.id === accId);
    if (!state || !acc || state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = type;
    
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    market.sessionRealizedProfit += state.unrealizedUsdt;
    logToHistory(accId, state.direction, state.roi, state.unrealizedUsdt, type);

    setTimeout(async () => {
        if (market.status !== 'Active') { state.isLocked = false; return; }
        await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
        state.isLocked = false;
        state.lastAction = "Idle";
    }, 3000);
}

function logToHistory(accId, direction, roi, pnl, type) {
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        side: `ACC ${accId} ${direction.toUpperCase()}`,
        roi: roi.toFixed(4) + '%',
        pnl: pnl.toFixed(8), // 8 Decimals in history
        type: type
    });
    if (tradeHistory.length > 25) tradeHistory.pop();
}

async function closeAllPositions() {
    market.status = 'LIQUIDATING';
    for (const acc of config.accounts) {
        const state = accountStates[acc.id];
        state.isLocked = true;
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
            logToHistory(acc.id, state.direction, state.roi, state.unrealizedUsdt, "MANUAL CLOSE");
        }
    }
    setTimeout(() => {
        config.accounts.forEach(acc => { accountStates[acc.id].isLocked = false; });
        market.status = 'Active';
    }, 10000);
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick && market.status === 'Active') {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                let totalUnrealized = 0;
                Object.values(accountStates).forEach((state) => {
                    totalUnrealized += state.unrealizedUsdt;
                    if (state.volume > 0 && !state.isLocked) {
                        if (state.roi >= config.takeProfitPct) executeAction(state.id, 'TAKE_PROFIT');
                        else if (state.roi < -5.0 && market.sessionRealizedProfit > (Math.abs(state.unrealizedUsdt) * 1.2)) executeAction(state.id, 'STOP_LOSS');
                    }
                });
                market.netSessionUsdt = totalUnrealized + market.sessionRealizedProfit;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc)));
    const states = Object.values(accountStates);
    const totalCurrentEquity = states.reduce((sum, s) => sum + s.currentEquity, 0);
    if (market.initialTotalEquity === 0 && totalCurrentEquity > 0) market.initialTotalEquity = totalCurrentEquity;
    market.totalNetGain = totalCurrentEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;

    if (market.status === 'Active') {
        for (const state of states) {
            if (state.volume === 0 && !state.isLocked) {
                const acc = config.accounts.find(a => a.id === state.id);
                await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
            }
        }
    }
}

// ==================== UI ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close-all', async (req, res) => { await closeAllPositions(); res.json({ status: 'ok' }); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Hedge Control 8D</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #0f172a; color: white; font-family: 'Courier New', monospace; }</style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-start mb-6">
            <div>
                <h1 class="text-2xl font-bold text-indigo-400">Hedge Engine <span class="text-white text-xs opacity-50">8-DECIMAL PRECISION</span></h1>
                <p id="statusBadge" class="text-[10px] mt-1 font-bold bg-emerald-500/20 text-emerald-400 px-2 py-1 rounded inline-block tracking-widest">SYSTEM ACTIVE</p>
            </div>
            <div class="flex gap-6 items-center">
                <button onclick="closeAll()" class="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded font-bold text-xs">EMERGENCY CLOSE ALL</button>
                <div class="text-right">
                    <p id="totalNetGain" class="text-2xl font-bold text-white">0.00000000</p>
                    <p id="growthPct" class="text-emerald-400 text-xs">0.0000%</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-slate-800 p-4 rounded border border-slate-700">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Session Realized Profit</p>
                <p id="realizedProfit" class="text-xl font-bold text-emerald-400">0.00000000</p>
            </div>
            <div class="bg-slate-800 p-4 rounded border border-slate-700">
                <p class="text-[10px] text-slate-400 uppercase mb-1">Live Session Net PnL</p>
                <p id="netSession" class="text-xl font-bold text-white">0.00000000</p>
            </div>
        </div>

        <div id="accountGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-6"></div>

        <div class="bg-slate-800 rounded p-4 border border-slate-700">
            <h2 class="text-[10px] font-bold mb-3 text-slate-400 uppercase tracking-widest">Activity Log (Last 25)</h2>
            <table class="w-full text-left text-[11px]">
                <thead><tr class="text-slate-500 border-b border-slate-700"><th class="pb-2">Time</th><th class="pb-2">Type</th><th class="pb-2">Target</th><th class="pb-2">ROI</th><th class="pb-2 text-right">PnL (USDT)</th></tr></thead>
                <tbody id="historyBody" class="font-mono"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function closeAll() { if(confirm('Confirm Emergency Liquidation?')) await fetch('/api/close-all', { method: 'POST' }); }

        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = d.market.totalNetGain.toFixed(8);
            document.getElementById('growthPct').innerText = d.market.growthPct.toFixed(4) + '%';
            document.getElementById('realizedProfit').innerText = d.market.sessionRealizedProfit.toFixed(8);
            document.getElementById('netSession').innerText = d.market.netSessionUsdt.toFixed(8);
            document.getElementById('statusBadge').innerText = 'SYSTEM ' + d.market.status;
            
            let accHtml = '';
            d.accounts.forEach(a => {
                accHtml += \`
                <div class="bg-slate-900 p-3 rounded border border-slate-800">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[9px] bg-slate-700 px-1.5 rounded text-white font-bold">ACC \${a.id}</span>
                        <span class="text-[9px] font-bold \${a.direction === 'buy' ? 'text-emerald-500' : 'text-rose-500'}">\${a.direction.toUpperCase()}</span>
                    </div>
                    <p class="text-lg font-bold \${a.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${a.roi.toFixed(4)}%</p>
                    <p class="text-[11px] text-slate-400 font-mono">\${a.unrealizedUsdt.toFixed(8)}</p>
                    <div class="mt-2 text-[9px] text-slate-600 uppercase font-bold">\${a.lastAction}</div>
                </div>\`;
            });
            document.getElementById('accountGrid').innerHTML = accHtml;

            let hHtml = '';
            d.tradeHistory.forEach(h => {
                hHtml += '<tr class="border-b border-slate-800/50"><td class="py-1 opacity-60">' + h.time + '</td><td class="font-bold text-indigo-400">' + h.type + '</td><td>' + h.side + '</td><td class="font-bold">' + h.roi + '</td><td class="text-right font-bold ' + (parseFloat(h.pnl) >= 0 ? 'text-emerald-500' : 'text-rose-500') + '">' + h.pnl + '</td></tr>';
            });
            document.getElementById('historyBody').innerHTML = hHtml;
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Engine Online: 8-Decimal Mode.`));
