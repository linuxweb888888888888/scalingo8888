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
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1, 
    pollInterval: 3000, // Check every 3 seconds
    resetCooldownMs: 5000 // Prevent spamming resets
};

// ==================== SESSION TRACKING ====================
let market = { 
    status: 'Active', 
    totalNetGain: 0, 
    growthPct: 0,       
    initialTotalEquity: 0 
};

let accountStates = {};
config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 4000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
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

async function resetSide(sideToResetIdx) {
    const acc = config.accounts[sideToResetIdx];
    const state = accountStates[acc.accountId];

    if (state.isLocked) return;
    state.isLocked = true;
    state.lastAction = "RESETTING...";

    console.log(`ROI Trigger: Resetting ${state.direction} position.`);

    // 1. Close current position
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, 
        direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    // 2. Re-open immediately at new price
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: config.baseVolume, 
        direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { 
        state.isLocked = false; 
        state.lastAction = "Idle";
    }, config.resetCooldownMs);
}

// ==================== MAIN LOGIC ====================
async function runLogic() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    
    const longSide = accountStates[1];
    const shortSide = accountStates[2];

    // Track Realized Gain (Inc. Fees)
    const totalCurrentEquity = longSide.currentEquity + shortSide.currentEquity;
    const totalStartEquity = (longSide.initialEquity || 0) + (shortSide.initialEquity || 0);
    if (market.initialTotalEquity === 0 && totalStartEquity > 0) market.initialTotalEquity = totalStartEquity;

    market.totalNetGain = totalCurrentEquity - totalStartEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;

    // --- THE HEDGE RESET LOGIC ---
    // If Long is winning, reset the Short side
    if (longSide.roi > 0 && longSide.volume > 0 && shortSide.volume > 0 && !shortSide.isLocked) {
        await resetSide(1); // Index 1 is the second account (Short)
    } 
    // If Short is winning, reset the Long side
    else if (shortSide.roi > 0 && shortSide.volume > 0 && longSide.volume > 0 && !longSide.isLocked) {
        await resetSide(0); // Index 0 is the first account (Long)
    }

    // Initial Entry / Safety Check
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
    }
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Hedge Reset Monitor</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;900&display=swap" rel="stylesheet">
    <style>
        body { background: #ffffff; color: #0f172a; font-family: 'Roboto', sans-serif; }
        .card { background: white; border-radius: 32px; border: 1px solid #f1f5f9; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.02); }
    </style>
</head>
<body class="p-6 md:p-12">
    <div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-end mb-12">
            <div>
                <p class="text-[10px] font-black text-indigo-500 uppercase tracking-[0.2em] mb-1">Strategy: Hedge Reset</p>
                <h1 class="text-5xl font-black text-slate-900 tracking-tighter uppercase leading-none">Ultra-Flip</h1>
            </div>
            <div class="text-right">
                <p id="growthPct" class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Growth: 0.00%</p>
                <p id="totalNetGain" class="text-4xl font-black leading-none text-slate-900">$0.0000</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="card p-8">
                <p class="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2">Long Position</p>
                <p id="lRoi" class="text-4xl font-black text-slate-900 mb-1">0.00%</p>
                <p id="lPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                <div id="lStatus" class="text-[9px] font-bold text-slate-300 uppercase italic">Idle</div>
            </div>
            <div class="card p-8 text-right">
                <p class="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2">Short Position</p>
                <p id="sRoi" class="text-4xl font-black text-slate-900 mb-1">0.00%</p>
                <p id="sPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                <div id="sStatus" class="text-[9px] font-bold text-slate-300 uppercase italic">Idle</div>
            </div>
        </div>
        
        <p class="text-center text-[10px] font-black text-slate-200 uppercase tracking-[0.3em]">
            Tracking: ${config.symbol} • Leverage: ${config.leverage}x • Vol: ${config.baseVolume}
        </p>
    </div>

    <script>
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                
                const gain = document.getElementById('totalNetGain');
                gain.innerText = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(5);
                gain.className = 'text-4xl font-black leading-none ' + (d.market.totalNetGain >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                document.getElementById('growthPct').innerText = 'Growth: ' + d.market.growthPct.toFixed(2) + '%';

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    const roiEl = document.getElementById(p+'Roi');
                    roiEl.innerText = a.roi.toFixed(2)+'%';
                    roiEl.className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(6);
                    document.getElementById(p+'Status').innerText = a.lastAction;
                    if(a.lastAction.includes("RESET")) document.getElementById(p+'Status').className = "text-[9px] font-bold text-indigo-500 animate-pulse uppercase";
                });
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

setInterval(runLogic, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Monitor running at http://localhost:${config.port}`));
