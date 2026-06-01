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
    baseVolume: 1,           
    multiplier: 1.2,         
    stepDistancePct: 0.1,    // 0.1% movement
    takeProfitPct: 1.0,      
    pollInterval: 2000
};

let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, initialTotalEquity: 0
};

let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false, lastAction: 'Idle',
        step: 0, lastStepPrice: 0
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
        } else { 
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; state.step = 0; state.lastStepPrice = 0;
        }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const info = accRes.data[0];
        state.currentEquity = parseFloat(info.margin_balance);
        state.availableMargin = parseFloat(info.withdraw_available); // Actual usable USDT
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTrade(side, roi, pnl, type) {
    tradeHistory.unshift({ 
        time: new Date().toLocaleTimeString(), 
        side: side.toUpperCase(), 
        roi: roi.toFixed(2) + '%', 
        pnl: pnl.toFixed(4), 
        total: market.totalNetGain.toFixed(4), 
        type: type 
    });
    if (tradeHistory.length > 15) tradeHistory.pop();
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
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;

        // 1. OPEN INITIAL POSITION
        if (state.volume === 0) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            state.lastStepPrice = state.direction === 'buy' ? market.bid : market.ask;
            state.lastAction = "Idle";
            state.isLocked = false;
            continue;
        }

        // 2. CHECK TAKE PROFIT
        if (state.roi >= config.takeProfitPct) {
            state.isLocked = true;
            logTrade(state.direction, state.roi, state.unrealizedUsdt, 'TAKE PROFIT');
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
            state.isLocked = false;
            continue;
        }

        // 3. CHECK SAFETY ORDER (MARTINGALE STEP)
        let priceDiff = 0;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (state.direction === 'buy') {
            priceDiff = ((state.entryPrice - currentPrice) / state.entryPrice) * 100;
        } else {
            priceDiff = ((currentPrice - state.entryPrice) / state.entryPrice) * 100;
        }

        if (priceDiff >= config.stepDistancePct) {
            const nextVolume = Math.max(1, Math.floor(state.volume * config.multiplier));
            
            // MARGIN CHECK: Estimate required USDT for next order
            // Formula: (Price * Volume * ContractSize) / Leverage. (Approximate as Volume is in contracts)
            const estimatedCost = (currentPrice * nextVolume * 0.001) / config.leverage; // 0.001 is a buffer for small contract sizes

            if (state.availableMargin < estimatedCost) {
                state.lastAction = "⚠️ INSUFFICIENT MARGIN";
                continue; 
            }

            state.isLocked = true;
            state.step++;
            state.lastAction = `Adding Step ${state.step}`;
            
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            
            state.isLocked = false;
        }
    }
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

    if (market.status === 'Active') {
        await processMartingale();
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
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Martingale Hedge Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #0f172a; color: white; font-family: 'Inter', sans-serif; }
        .card { background: #1e293b; border-radius: 20px; border: 1px solid #334155; }
        .stat-label { font-size: 10px; font-weight: 900; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div>
                <h1 class="text-3xl font-black tracking-tighter uppercase italic">Martingale-Hedge <span class="text-indigo-500">Pro</span></h1>
                <p id="botStatus" class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Engine Online</p>
            </div>
            <div class="text-right">
                <p id="totalNetGain" class="text-3xl font-black text-white">$0.0000</p>
                <p id="growthPct" class="stat-label text-emerald-400">Total Profit: 0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="card p-6 border-l-4 border-indigo-500">
                <p class="stat-label mb-1">Target Take Profit</p>
                <p class="text-3xl font-black text-white">${config.takeProfitPct}%</p>
                <p class="text-[9px] text-slate-500 mt-1">Distance: ${config.stepDistancePct}% | Mult: ${config.multiplier}x</p>
            </div>
            <div class="card p-6 border-l-4 border-slate-500">
                <p class="stat-label mb-1">Market Spread</p>
                <p id="uiSpread" class="text-3xl font-black text-white">0.000%</p>
                <p class="text-[9px] text-slate-500 mt-1">Status: <span id="marketStatus">Active</span></p>
            </div>
        </div>

        <div class="card p-8 mb-8">
            <div class="grid grid-cols-2 gap-10">
                <div>
                    <p class="stat-label text-emerald-500">Long Position</p>
                    <p id="lRoi" class="text-4xl font-black">0.00%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-500">$0.0000</p>
                    <div class="mt-4 space-y-1">
                        <p id="lMargin" class="text-[10px] font-bold text-slate-400">Margin: $0.00</p>
                        <div class="bg-emerald-500/10 inline-block px-2 py-1 rounded">
                            <p id="lStep" class="text-[10px] font-black text-emerald-400 uppercase">STEP: 0</p>
                        </div>
                        <p id="lAction" class="text-[9px] font-bold text-indigo-400 block h-4"></p>
                    </div>
                </div>
                <div class="text-right">
                    <p class="stat-label text-rose-500">Short Position</p>
                    <p id="sRoi" class="text-4xl font-black">0.00%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-500">$0.0000</p>
                    <div class="mt-4 space-y-1">
                        <p id="sMargin" class="text-[10px] font-bold text-slate-400">Margin: $0.00</p>
                        <div class="bg-rose-500/10 inline-block px-2 py-1 rounded">
                            <p id="sStep" class="text-[10px] font-black text-rose-400 uppercase">STEP: 0</p>
                        </div>
                        <p id="sAction" class="text-[9px] font-bold text-indigo-400 block h-4"></p>
                    </div>
                </div>
            </div>
        </div>

        <div class="card overflow-hidden mb-8">
            <table class="w-full text-left text-[11px]">
                <thead class="bg-slate-800/50">
                    <tr>
                        <th class="p-4 stat-label">Time</th>
                        <th class="p-4 stat-label">Type</th>
                        <th class="p-4 stat-label">Side</th>
                        <th class="p-4 stat-label">ROI</th>
                        <th class="p-4 stat-label">PnL</th>
                    </tr>
                </thead>
                <tbody id="historyBody" class="divide-y divide-slate-700"></tbody>
            </table>
        </div>

        <button onclick="triggerClose()" class="w-full py-5 rounded-2xl bg-white text-black font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all shadow-2xl active:scale-95">
            Emergency Liquidation
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate all?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('uiSpread').innerText = d.market.spread.toFixed(3) + '%';
                document.getElementById('totalNetGain').innerText = (d.market.totalNetGain >= 0 ? '$' : '-$') + Math.abs(d.market.totalNetGain).toFixed(4);
                document.getElementById('growthPct').innerText = 'Total Profit: ' + d.market.growthPct.toFixed(2) + '%';
                document.getElementById('marketStatus').innerText = d.market.status;

                d.accounts.forEach(function(a, i) {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = (a.unrealizedUsdt >= 0 ? '$' : '-$') + Math.abs(a.unrealizedUsdt).toFixed(4);
                    document.getElementById(p+'Step').innerText = 'STEP: ' + a.step;
                    document.getElementById(p+'Margin').innerText = 'Available: $' + a.availableMargin.toFixed(2);
                    document.getElementById(p+'Action').innerText = a.lastAction;
                    if(a.lastAction.includes("MARGIN")) document.getElementById(p+'Action').className = "text-[9px] font-bold text-rose-500 block h-4";
                    else document.getElementById(p+'Action').className = "text-[9px] font-bold text-indigo-400 block h-4";
                });

                let tableHtml = '';
                d.tradeHistory.forEach(function(h) {
                    tableHtml += '<tr>' +
                        '<td class="p-4 text-slate-400 font-bold">' + h.time + '</td>' +
                        '<td class="p-4 text-indigo-400 font-black italic">' + h.type + '</td>' +
                        '<td class="p-4 font-bold">' + h.side + '</td>' +
                        '<td class="p-4 ' + (parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400') + ' font-black">' + h.roi + '</td>' +
                        '<td class="p-4 font-bold">$' + h.pnl + '</td>' +
                        '</tr>';
                });
                document.getElementById('historyBody').innerHTML = tableHtml;

            } catch(e) { console.log(e); }
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Martingale Engine Online - Safety Margin Enabled`));
