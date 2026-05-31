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
    baseVolume: parseInt(process.env.BASE_VOLUME) || 100, 
    winLossRatio: 1.5,        
    maxStartSpread: 0.1,      // TRIGGER: Open if spread is below 0.1%
    roiThreshold: 2.0,        
    autoClosePct: 150,
    pollInterval: 2000,
    resetCooldownMs: 3000,
    historySize: 30,
    resetDiffThreshold: 1.0   // Reset loser if 1% difference
};

// ==================== DATA TRACKING ====================
let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    currentRatio: 0, resetPenalty: 0, diffSum: 0,
    balancePct: 0, totalNetGain: 0, realizedSessPnl: 0, 
    growthPct: 0, initialTotalEquity: 0, resetUsed: false 
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
    state.lastAction = "⚡ RESET (ONE-TIME)";
    
    logTrade(state.direction, state.roi, state.unrealizedUsdt, 'RESET');

    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { 
        state.isLocked = false; 
        state.lastAction = "Idle";
    }, config.resetCooldownMs);
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
                const loseRoi = Math.min(liveLongRoi, liveShortRoi);
                market.currentRatio = Math.abs(loseRoi) > 0 ? (winRoi / Math.abs(loseRoi)) : 0;
                market.diffSum = winRoi - market.resetPenalty;

                const roiDifference = Math.abs(liveLongRoi - liveShortRoi);

                // RESET Condition using the 0.1% Spread threshold
                if (!market.resetUsed && market.spread <= config.maxStartSpread) {
                    if (roiDifference >= config.resetDiffThreshold) {
                        liveLongRoi < liveShortRoi ? flashReset(0) : flashReset(1);
                    }
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
    market.growthPct = totalStartEquity > 0 ? (market.totalNetGain / totalStartEquity) * 100 : 0;
    market.realizedSessPnl = market.totalNetGain - (s1.unrealizedUsdt + s2.unrealizedUsdt);

    const winVal = Math.max(Math.abs(s1.unrealizedUsdt), Math.abs(s2.unrealizedUsdt));
    const loseVal = Math.abs(s1.unrealizedUsdt + s2.unrealizedUsdt - winVal);
    market.balancePct = ((winVal / Math.max(loseVal, 0.00000001)) / 1.5) * 100;

    if (market.balancePct >= config.autoClosePct && (s1.roi > config.roiThreshold || s2.roi > config.roiThreshold) && winVal > loseVal) {
        await manualClose('TARGET EXIT');
    }

    // INITIAL OPEN Condition using the 0.1% Spread threshold
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked && market.status === "Active") {
            if (market.spread > 0 && market.spread <= config.maxStartSpread) {
                state.isLocked = true;
                await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
                setTimeout(() => { state.isLocked = false; }, 3000);
            }
        }
    }
}

async function manualClose(type = 'MANUAL') {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            logTrade(state.direction, state.roi, state.unrealizedUsdt, type);
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    market.resetUsed = false;
    setTimeout(() => { market.status = "Active"; }, 5000);
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Ratio Hedge Engine</title>
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
                <h1 class="text-3xl font-black tracking-tighter uppercase italic">Ratio-Hedge <span class="text-indigo-500">Pro</span></h1>
                <p id="botStatus" class="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mt-1">Engine Online</p>
            </div>
            <div class="text-right">
                <p id="totalNetGain" class="text-3xl font-black text-white">$0.0000</p>
                <p id="growthPct" class="stat-label text-emerald-400">Total Profit: 0.00%</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="card p-6 border-l-4 border-indigo-500">
                <p class="stat-label mb-1">Win/Loss Ratio</p>
                <p id="uiRatio" class="text-3xl font-black text-white">0.00x</p>
                <p class="text-[9px] text-slate-500 mt-1">Target: ${config.winLossRatio}x (75/50)</p>
            </div>
            <div class="card p-6 border-l-4 border-rose-500">
                <p class="stat-label mb-1">ROI If Reset Now</p>
                <p id="uiPenalty" class="text-3xl font-black text-rose-400">-0.00%</p>
                <div class="mt-2 pt-2 border-t border-slate-700">
                   <p class="stat-label text-[9px]">Difference Sum (Win + Reset ROI)</p>
                   <p id="uiDiffSum" class="text-lg font-black text-emerald-400">+0.00%</p>
                </div>
            </div>
            <div class="card p-6 border-l-4 border-slate-500">
                <p class="stat-label mb-1">Market Spread</p>
                <p id="uiSpread" class="text-3xl font-black text-white">0.000%</p>
                <p class="text-[9px] text-slate-500 mt-1">Direct Exchange Gap</p>
            </div>
        </div>

        <div class="card p-8 mb-8">
            <div class="flex justify-between items-end mb-4">
                <p class="stat-label">System Symmetry (Exit @ 150%)</p>
                <p id="balPct" class="text-2xl font-black text-white">0.0%</p>
            </div>
            <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div id="balBar" class="bg-indigo-500 h-full w-0 transition-all duration-500"></div>
            </div>
            <div class="grid grid-cols-2 gap-10 mt-8">
                <div>
                    <p class="stat-label text-emerald-500">Long Position</p>
                    <p id="lRoi" class="text-4xl font-black">0.00%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-500">$0.0000</p>
                </div>
                <div class="text-right">
                    <p class="stat-label text-rose-500">Short Position</p>
                    <p id="sRoi" class="text-4xl font-black">0.00%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-500">$0.0000</p>
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
                        <th class="p-4 stat-label">Session Total</th>
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
                const r = await fetch('/api/status'); const d = await r.json();
                
                document.getElementById('uiRatio').innerText = d.market.currentRatio.toFixed(2) + 'x';
                document.getElementById('uiRatio').className = 'text-3xl font-black ' + (d.market.currentRatio >= 1.5 ? 'text-emerald-400' : 'text-white');
                
                document.getElementById('uiPenalty').innerText = '-' + d.market.resetPenalty.toFixed(2) + '%';
                document.getElementById('uiDiffSum').innerText = (d.market.diffSum >= 0 ? '+' : '') + d.market.diffSum.toFixed(2) + '%';
                
                document.getElementById('uiSpread').innerText = d.market.spread.toFixed(3) + '%';
                document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(5);
                document.getElementById('growthPct').innerText = 'Total Profit: ' + d.market.growthPct.toFixed(2) + '%';
                
                document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
                document.getElementById('balBar').style.width = Math.min(100, (d.market.balancePct / 150) * 100) + '%';

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(5);
                });

                document.getElementById('historyBody').innerHTML = d.tradeHistory.map(h => \`
                    <tr>
                        <td class="p-4 text-slate-400 font-bold">\${h.time}</td>
                        <td class="p-4 text-indigo-400 font-black italic">\${h.type}</td>
                        <td class="p-4 font-bold">\${h.side}</td>
                        <td class="p-4 \${parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-black">\${h.roi}</td>
                        <td class="p-4 font-bold">\$\${h.pnl}</td>
                        <td class="p-4 font-black text-white">\$\${h.total}</td>
                    </tr>\`).join('');
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Engine Online`));
