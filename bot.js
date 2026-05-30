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
    targetRatio: 1.5,     // The mathematical goal for the Progress Bar
    cooldownMs: 2500,     // Frequency of nudges
    pollInterval: 3000    // Logic loop frequency
};

let market = { status: 'Active', balancePct: 0, netPnL: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
        lastAction: 'Idle', isLocked: false
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
    const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (res?.status === 'ok' && res.data) {
        const pos = res.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
    }
}

async function closeAll() {
    if (market.status === "LIQUIDATING") return;
    market.status = "LIQUIDATING";
    console.log("🎯 TARGET REACHED: LIQUIDATING ALL POSITIONS");
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        await syncAccount(acc, state);
        if (state.volume > 0) {
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, 
                direction: closeDir, offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    market.status = "COMPLETED - RESTARTING";
    setTimeout(() => { market.status = "Active"; }, 5000);
}

// ==================== MAIN LOGIC LOOP ====================
async function runLogic() {
    // 1. Sync data from exchange
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    // Determine current winner/loser by ROI
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));

    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // Calculate Progress towards the 1.5x ratio goal
    const effectiveLoseVal = Math.max(loseVal, 0.00000001); 
    market.balancePct = Math.min(100, ((winVal / effectiveLoseVal) / config.targetRatio) * 100);

    // 2. CHECK FOR 95% AUTO-EXIT
    if (market.balancePct >= 95 && (s1.volume > 0 || s2.volume > 0)) {
        await closeAll();
        return;
    }

    // 3. PARITY NUDGE LOGIC
    // Only nudge if Winner PnL < Loser PnL (Winner hasn't covered the loser yet)
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && market.status === "Active") {
        if (winVal < loseVal) {
            winner.isLocked = true;
            winner.lastAction = `Catching Up (+${config.microStep})`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, 
                direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        } else {
            winner.lastAction = "Winner Leading (Nudging Paused)";
        }
    }

    // 4. RE-ENTRY SAFETY (If a side is empty)
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked && market.status === "Active") {
            state.isLocked = true;
            state.lastAction = "Re-entry";
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
    }
}

// ==================== DASHBOARD UI ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Hedge Ultra Monitor</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #f8fafc; color: #0f172a; font-family: 'Roboto', sans-serif; }
        .card { background: white; border-radius: 32px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-end mb-10">
            <div>
                <p id="botStatus" class="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">SYSTEM ONLINE</p>
                <h1 class="text-4xl font-black text-slate-900 tracking-tighter uppercase">Ultra-Hedge</h1>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Net Gain</p>
                <p id="netPnL" class="text-4xl font-black leading-none">$0.0000</p>
            </div>
        </div>

        <div class="card p-10 mb-8">
            <div class="flex justify-between items-end mb-4">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Progress to 95% Liquidate</p>
                <p id="balPct" class="text-3xl font-black text-slate-900">0.0%</p>
            </div>
            <div class="w-full bg-slate-100 h-3 rounded-full overflow-hidden mb-12">
                <div id="balBar" class="bg-indigo-600 h-full w-0 transition-all duration-700 ease-out"></div>
            </div>

            <div class="grid grid-cols-2 gap-10">
                <div class="border-r border-slate-50">
                    <p class="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2">Long ROI</p>
                    <p id="lRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="lVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase"></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2">Short ROI</p>
                    <p id="sRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="sVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase"></p>
                </div>
            </div>
        </div>

        <button onclick="triggerClose()" class="w-full py-6 rounded-3xl bg-slate-900 text-white font-black uppercase tracking-[0.3em] hover:bg-rose-600 transition-all shadow-xl active:scale-[0.98]">
            Manual Liquidation
        </button>
        
        <p class="text-center mt-8 text-[10px] font-black text-slate-300 uppercase tracking-widest italic">
            Strategy: Catch-up Nudge • Target Ratio: ${config.targetRatio} • Pair: ${config.symbol}
        </p>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate all positions?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('botStatus').innerText = d.market.status;
                const net = document.getElementById('netPnL');
                net.innerText = (d.market.netPnL >= 0 ? '+' : '') + d.market.netPnL.toFixed(5);
                net.className = 'text-4xl font-black leading-none ' + (d.market.netPnL >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
                const bar = document.getElementById('balBar');
                bar.style.width = d.market.balancePct + '%';
                if(d.market.balancePct > 80) bar.className = "bg-orange-500 h-full w-0 transition-all duration-700";
                else bar.className = "bg-indigo-600 h-full w-0 transition-all duration-700";

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    const roiEl = document.getElementById(p+'Roi');
                    roiEl.innerText = a.roi.toFixed(2)+'%';
                    roiEl.className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(6);
                    document.getElementById(p+'Vol').innerText = a.volume + ' CT | ' + a.lastAction;
                });
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

// Initialization
setInterval(runLogic, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Monitor running at http://localhost:${config.port}`));
