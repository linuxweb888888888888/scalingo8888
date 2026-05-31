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
while (process.env[`HTX_API_KEY_${accountIndex}`] && accountIndex <= 2) {
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
    maxStartSpread: 0.12,      
    autoClosePct: 115,        // Increased to 115% to ensure fee coverage
    pollInterval: 2000,       
    resetCooldownMs: 4000,
    resetDiffThreshold: 2.5,
    takerFeeRate: 0.0005      // HTX Standard Taker Fee (0.05%)
};

let market = { 
    status: 'Active', bid: 0, ask: 0, spread: 0,
    currentRatio: 0, resetPenalty: 0, diffSum: 0,
    balancePct: 0, totalNetGain: 0, growthPct: 0, 
    initialTotalEquity: 0, resetUsed: false,
    sessionResetLoss: 0,
    estExitFees: 0,           // NEW: Track estimated fees to close
    netSessionUsdt: 0         // NEW: True PnL (Unrealized - Reset Loss - Fees)
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2500 });
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
    if (market.status !== 'Active' || market.resetUsed) return;
    const acc = config.accounts[accIdxToReset];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    market.resetUsed = true; 
    market.sessionResetLoss += Math.abs(state.unrealizedUsdt);
    
    // Add the fee for closing the loser and re-opening it
    const resetFee = (state.volume * (market.bid || state.entryPrice) * config.takerFeeRate * 2); 
    market.sessionResetLoss += resetFee;

    logTrade(state.direction, state.roi, state.unrealizedUsdt, 'RESET');

    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, 
        offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { state.isLocked = false; }, config.resetCooldownMs);
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
                market.resetPenalty = -(market.spread * config.leverage);

                const s1 = accountStates[1]; 
                const s2 = accountStates[2];
                if (!s1 || !s2) return;
                
                const lRoi = s1.entryPrice > 0 ? ((market.bid - s1.entryPrice) / s1.entryPrice) * config.leverage * 100 : 0;
                const sRoi = s2.entryPrice > 0 ? ((s2.entryPrice - market.ask) / s2.entryPrice) * config.leverage * 100 : 0;
                
                market.diffSum = Math.max(lRoi, sRoi) + market.resetPenalty;

                // FEE CALCULATION: How much will it cost to close what's open right now?
                // Volume * Price * 0.0005
                const fee1 = s1.volume > 0 ? (s1.volume * market.bid * config.takerFeeRate) : 0;
                const fee2 = s2.volume > 0 ? (s2.volume * market.ask * config.takerFeeRate) : 0;
                market.estExitFees = fee1 + fee2;

                const winPnl = Math.max(s1.unrealizedUsdt, s2.unrealizedUsdt);
                const totalDebt = Math.abs(Math.min(s1.unrealizedUsdt, s2.unrealizedUsdt)) + market.sessionResetLoss + market.estExitFees;
                
                market.currentRatio = totalDebt > 0 ? (winPnl / totalDebt) : 0;
                market.netSessionUsdt = (s1.unrealizedUsdt + s2.unrealizedUsdt) - market.sessionResetLoss - market.estExitFees;

                const roiDifference = Math.abs(lRoi - sRoi);
                if (market.status === 'Active' && !market.resetUsed && market.spread <= config.maxStartSpread) {
                    if (roiDifference >= config.resetDiffThreshold) {
                        lRoi < sRoi ? flashReset(0) : flashReset(1);
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
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    const s1 = accountStates[1]; const s2 = accountStates[2];
    if (!s1 || !s2) return;

    const totalCurrentEquity = s1.currentEquity + s2.currentEquity;
    if (market.initialTotalEquity === 0 && totalCurrentEquity > 0) market.initialTotalEquity = totalCurrentEquity;
    market.totalNetGain = totalCurrentEquity - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;
    market.balancePct = market.currentRatio > 0 ? (market.currentRatio / config.winLossRatio) * 100 : 0;

    if (market.status === 'Active') {
        // STRICT EXIT: Only close if the Ratio is met AND the USDT PnL after all fees/resets is positive
        if (market.balancePct >= config.autoClosePct && market.netSessionUsdt > 0) {
            await manualClose('TARGET EXIT');
            return;
        }

        for (const acc of config.accounts) {
            const state = accountStates[acc.accountId];
            if (state.volume === 0 && !state.isLocked && s1.volume === 0 && s2.volume === 0) {
                if (market.spread > 0 && market.spread <= config.maxStartSpread) {
                    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                    });
                }
            }
        }
    }
}

async function manualClose(type = 'MANUAL') {
    if (market.status === "LIQUIDATING") return; 
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        state.isLocked = true;
        if (state.volume > 0) {
            logTrade(state.direction, state.roi, state.unrealizedUsdt, type);
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    market.resetUsed = false;
    market.sessionResetLoss = 0;
    setTimeout(() => { 
        config.accounts.forEach(acc => { accountStates[acc.accountId].isLocked = false; });
        market.status = "Active"; 
    }, 8000);
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
    <style>
        body { background: #0f172a; color: white; font-family: sans-serif; }
        .card { background: #1e293b; border-radius: 15px; border: 1px solid #334155; }
        .stat-label { font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; }
    </style>
</head>
<body class="p-5">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <h1 class="text-2xl font-black italic text-indigo-400">FEE-AWARE HEDGE</h1>
            <div class="text-right">
                <p id="netSession" class="text-2xl font-black text-emerald-400">$0.00</p>
                <p class="stat-label">Net Session (After Fees)</p>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-4 mb-6">
            <div class="card p-4">
                <p class="stat-label">Debt Ratio</p>
                <p id="uiRatio" class="text-xl font-bold">0.00x</p>
            </div>
            <div class="card p-4">
                <p class="stat-label">Est. Exit Fees</p>
                <p id="uiFees" class="text-xl font-bold text-rose-400">-$0.00</p>
            </div>
            <div class="card p-4">
                <p class="stat-label">Session Reset Loss</p>
                <p id="uiResetLoss" class="text-xl font-bold text-rose-500">-$0.00</p>
            </div>
        </div>

        <div class="card p-6 mb-6">
            <div class="flex justify-between mb-2">
                <span class="stat-label">Recovery Progress</span>
                <span id="balPct" class="font-bold">0%</span>
            </div>
            <div class="w-full bg-slate-800 h-3 rounded-full overflow-hidden">
                <div id="balBar" class="bg-indigo-500 h-full w-0 transition-all"></div>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6 text-center">
            <div class="card p-4">
                <p class="stat-label">Long ROI</p>
                <p id="lRoi" class="text-3xl font-black">0%</p>
            </div>
            <div class="card p-4">
                <p class="stat-label">Short ROI</p>
                <p id="sRoi" class="text-3xl font-black">0%</p>
            </div>
        </div>

        <div class="card overflow-hidden mb-6">
            <table class="w-full text-left text-[10px]">
                <thead class="bg-slate-800">
                    <tr><th class="p-3">Time</th><th>Type</th><th>Side</th><th>ROI</th><th>PnL</th><th>Session Total</th></tr>
                </thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>

        <button onclick="triggerClose()" class="w-full py-4 rounded-xl bg-rose-600 font-bold uppercase hover:bg-rose-700">Liquidate All</button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Close all?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('netSession').innerText = '$' + d.market.netSessionUsdt.toFixed(5);
            document.getElementById('uiRatio').innerText = d.market.currentRatio.toFixed(2) + 'x';
            document.getElementById('uiFees').innerText = '-$' + d.market.estExitFees.toFixed(5);
            document.getElementById('uiResetLoss').innerText = '-$' + d.market.sessionResetLoss.toFixed(5);
            document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
            document.getElementById('balBar').style.width = Math.min(100, d.market.balancePct) + '%';
            
            d.accounts.forEach((a, i) => {
                const el = document.getElementById(i === 0 ? 'lRoi' : 'sRoi');
                el.innerText = a.roi.toFixed(2) + '%';
                el.style.color = a.roi >= 0 ? '#34d399' : '#f87171';
            });

            let html = '';
            d.tradeHistory.forEach(h => {
                html += '<tr class="border-t border-slate-700"><td class="p-3">'+h.time+'</td><td class="text-indigo-400">'+h.type+'</td><td>'+h.side+'</td><td class="font-bold">'+h.roi+'</td><td>$'+h.pnl+'</td><td class="font-bold">$'+h.total+'</td></tr>';
            });
            document.getElementById('historyBody').innerHTML = html;
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Fee-Aware Engine Online`));
