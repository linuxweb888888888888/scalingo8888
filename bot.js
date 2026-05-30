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
    baseVolume: parseInt(process.env.BASE_VOLUME) || 5, 
    microStep: parseInt(process.env.MICRO_STEP) || 2,   
    targetRatio: 1.5, // 100% on the progress bar
    autoClosePct: 150, // Progress threshold
    roiThreshold: 1.5, // ROI threshold
    cooldownMs: 2500,
    pollInterval: 3000
};

// ==================== SESSION TRACKING ====================
let market = { 
    status: 'Initializing...', 
    balancePct: 0, 
    totalNetGain: 0,    // Real Profit (Inc. Fees)
    realizedSessPnl: 0, 
    growthPct: 0,       
    initialTotalEquity: 0 
};

let accountStates = {};
config.accounts.forEach((account) => {
    accountStates[account.accountId] = {
        direction: account.accountId === 1 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
        currentEquity: 0, initialEquity: null,
        lastAction: 'Waiting...', isLocked: false
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 4000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
    // Position Sync
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
    }
    // Equity Sync (Fees tracking)
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const data = accRes.data[0];
        const equity = parseFloat(data.margin_balance);
        if (state.initialEquity === null) state.initialEquity = equity;
        state.currentEquity = equity;
    }
}

async function closeAll() {
    if (market.status === "LIQUIDATING") return;
    market.status = "LIQUIDATING";
    console.log("🎯 ALL CONDITIONS MET: LIQUIDATING AT PROFIT");
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, 
                direction: closeDir, offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    market.status = "CLEARED";
    setTimeout(() => { market.status = "Active"; }, 5000);
}

// ==================== MAIN LOGIC LOOP ====================
async function runLogic() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    const s1 = accountStates[1];
    const s2 = accountStates[2];

    const totalCurrentEquity = s1.currentEquity + s2.currentEquity;
    const totalStartEquity = (s1.initialEquity || 0) + (s2.initialEquity || 0);
    if (market.initialTotalEquity === 0) market.initialTotalEquity = totalStartEquity;

    market.totalNetGain = totalCurrentEquity - totalStartEquity;
    market.growthPct = totalStartEquity > 0 ? (market.totalNetGain / totalStartEquity) * 100 : 0;
    market.realizedSessPnl = market.totalNetGain - (s1.unrealizedUsdt + s2.unrealizedUsdt);

    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? 1 : 2));

    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    const effectiveLoseVal = Math.max(loseVal, 0.00000001); 
    
    market.balancePct = ((winVal / effectiveLoseVal) / config.targetRatio) * 100;

    // ==================== TRIPLE-CHECK AUTO-CLOSE ====================
    // 1. Progress Bar >= 150%
    // 2. Winner ROI > 1.5%
    // 3. Winner $ Gain > Loser $ Loss
    if (market.balancePct >= config.autoClosePct && 
        winner.roi > config.roiThreshold && 
        winVal > loseVal && 
        (s1.volume > 0 || s2.volume > 0)) {
        await closeAll();
        return;
    }

    if (market.status !== "Active" && market.status !== "LIQUIDATING") market.status = "Active";

    // Parity Nudge Logic (Stops nudging once winVal >= loseVal)
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && market.status === "Active") {
        if (winVal < loseVal) {
            winner.isLocked = true;
            winner.lastAction = `Catching Up`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        } else {
            winner.lastAction = "Winner Leading";
        }
    }

    // Re-entry Logic
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

// ==================== DASHBOARD UI ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Ultra-Hedge Monitor</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #f8fafc; color: #0f172a; font-family: 'Roboto', sans-serif; }
        .card { background: white; border-radius: 32px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); position: relative; overflow: hidden; }
        .target-line { position: absolute; top: 0; bottom: 0; width: 2px; background: #ef4444; z-index: 10; }
        .target-label { position: absolute; top: -20px; transform: translateX(-50%); font-size: 9px; font-weight: 900; color: #ef4444; text-transform: uppercase; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-end mb-10">
            <div>
                <p id="botStatus" class="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">SYSTEM ONLINE</p>
                <h1 class="text-4xl font-black text-slate-900 tracking-tighter uppercase leading-none">Ultra-Hedge</h1>
            </div>
            <div class="text-right">
                <div class="flex items-center justify-end gap-2 mb-1">
                    <p id="growthPct" class="text-[10px] font-black px-2 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">0.00%</p>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Growth</p>
                </div>
                <p id="totalNetGain" class="text-4xl font-black leading-none text-slate-900">$0.0000</p>
                <p id="realizedPnl" class="text-[10px] font-black text-slate-400 mt-2 uppercase tracking-widest">Realized Sess: $0.0000</p>
            </div>
        </div>

        <div class="card p-10 pt-14 mb-8">
            <div class="flex justify-between items-end mb-4">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Target: 150% + Winner ROI > 1.5% + Net Profit</p>
                <p id="balPct" class="text-3xl font-black text-slate-900">0.0%</p>
            </div>
            <div class="relative w-full bg-slate-100 h-4 rounded-full mb-12">
                <div id="balBar" class="bg-indigo-600 h-full w-0 rounded-full transition-all duration-700 ease-out relative z-0"></div>
                <div id="targetMarker" class="target-line" style="left: 75%;">
                    <span class="target-label">EXIT TARGET</span>
                </div>
                <div style="left: 50%;" class="absolute top-0 bottom-0 border-l border-slate-300 border-dashed"></div>
            </div>

            <div class="grid grid-cols-2 gap-10">
                <div class="border-r border-slate-50">
                    <p class="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2">Long Position</p>
                    <p id="lRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="lVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase"></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2">Short Position</p>
                    <p id="sRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="sVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase"></p>
                </div>
            </div>
        </div>

        <button onclick="triggerClose()" class="w-full py-6 rounded-3xl bg-slate-900 text-white font-black uppercase tracking-[0.3em] hover:bg-rose-600 transition-all shadow-xl active:scale-[0.98]">
            Manual Liquidation
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate all?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('botStatus').innerText = d.market.status;
                const growth = document.getElementById('growthPct');
                growth.innerText = (d.market.growthPct >= 0 ? '+' : '') + d.market.growthPct.toFixed(2) + '%';
                growth.className = 'text-[10px] font-black px-2 py-0.5 rounded uppercase ' + (d.market.growthPct >= 0 ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600');
                document.getElementById('realizedPnl').innerText = 'Realized Sess (Inc. Fees): $' + d.market.realizedSessPnl.toFixed(5);
                const mainGain = document.getElementById('totalNetGain');
                mainGain.innerText = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(5);
                mainGain.className = 'text-4xl font-black leading-none ' + (d.market.totalNetGain >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                const currentPct = d.market.balancePct;
                document.getElementById('balPct').innerText = currentPct.toFixed(1) + '%';
                const barWidth = Math.min(100, (currentPct / 200) * 100);
                const bar = document.getElementById('balBar');
                bar.style.width = barWidth + '%';
                
                document.getElementById('targetMarker').style.left = (d.config.autoClosePct / 200) * 100 + '%';

                if(currentPct >= d.config.autoClosePct) bar.className = "bg-rose-500 h-full rounded-full transition-all duration-700";
                else if(currentPct >= 100) bar.className = "bg-orange-500 h-full rounded-full transition-all duration-700";
                else bar.className = "bg-indigo-600 h-full rounded-full transition-all duration-700";

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(6);
                    document.getElementById(p+'Vol').innerText = a.volume + ' CT | ' + a.lastAction;
                });
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

setInterval(runLogic, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Monitor running at http://localhost:${config.port}`));
