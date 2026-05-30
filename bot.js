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
    // --- Slow Balance Settings ---
    takeProfitPct: 1.5,
    baseVolume: 100,      // Starting contracts
    microStep: 10,        // <--- LOWEST INCREMENT (Set to 1 for BTC/ETH, 10 for SHIB)
    targetRatio: 1.5,     // Goal: Winner PnL is 1.5x Loser PnL (e.g. 0.00075 vs 0.00050)
    cooldownMs: 5000      // Wait 5 seconds between micro-adjustments
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'Slow Sync...', balancePct: 0, netPnL: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, wallet: 0,
        lastAction: 'Idle', isLocked: false
    };
});

// ==================== API HANDLER ====================
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

// ==================== SLOW BALANCE LOGIC ====================
async function runSlowLogic() {
    for (const acc of config.accounts) {
        await syncAccount(acc, accountStates[acc.accountId]);
    }

    const s1 = accountStates[config.accounts[0].accountId]; // Long
    const s2 = accountStates[config.accounts[1].accountId]; // Short

    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));

    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // Calculate Progress towards 1.5x Advantage
    if (loseVal === 0) market.balancePct = 100;
    else {
        const currentRatio = winVal / loseVal;
        market.balancePct = Math.min(100, (currentRatio / config.targetRatio) * 100);
    }

    // MICRO-ADJUSTMENT LOGIC
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked) {
        // Only adjust if winner's lead is smaller than the target ratio
        if (winVal < (loseVal * config.targetRatio)) {
            winner.isLocked = true; // Set lock to prevent spam
            winner.lastAction = `Micro-Nudge (+${config.microStep})`;
            
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, 
                direction: winner.direction, offset: 'open', 
                lever_rate: config.leverage, order_price_type: 'optimal_5'
            });

            // Cooldown: Wait before allowing another micro-step
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        } else {
            winner.lastAction = "Ratio Balanced";
        }
    }

    // Maintenance: Auto-Entry
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, 
                direction: state.direction, offset: 'open', 
                lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 2000);
        }
        if (state.roi >= config.takeProfitPct) await closeAll();
    }
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
    market.status = "Closing Cycle...";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
        }
    }
}

// ==================== DASHBOARD & WS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Micro Balancer</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#030304;color:#f0f0f0;font-family:monospace;}.glass{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-3xl mx-auto">
    <div class="flex justify-between items-end mb-10 border-b border-white/10 pb-4">
        <div><h1 class="text-lg font-bold">MICRO-BALANCE <span class="text-indigo-500">v2</span></h1><p id="price" class="text-zinc-500">0.00000000</p></div>
        <div class="text-right"><p class="text-[10px] text-zinc-600 font-bold uppercase">Net PnL</p><p id="netPnL" class="text-2xl font-bold">$0.0000</p></div>
    </div>

    <div class="glass rounded-2xl p-8 mb-6">
        <div class="flex justify-between text-[10px] mb-2 uppercase tracking-widest font-bold">
            <span class="text-zinc-500">Advantage Skew (Target ${config.targetRatio}x)</span>
            <span id="balPct" class="text-indigo-400">0%</span>
        </div>
        <div class="w-full bg-white/5 h-1 rounded-full mb-6">
            <div id="balBar" class="bg-indigo-500 h-1 rounded-full transition-all duration-1000"></div>
        </div>
        <div class="grid grid-cols-2 gap-10">
            <div>
                <p class="text-[10px] text-emerald-500 font-bold mb-4 uppercase tracking-tighter">Long Account</p>
                <p id="lRoi" class="text-3xl font-bold mb-1">0.00%</p>
                <p id="lPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="lVol" class="text-[10px] text-zinc-600 mt-4">VOL: 0</p>
                <p id="lAct" class="text-[9px] text-indigo-400 font-bold">IDLE</p>
            </div>
            <div class="text-right">
                <p class="text-[10px] text-rose-500 font-bold mb-4 uppercase tracking-tighter">Short Account</p>
                <p id="sRoi" class="text-3xl font-bold mb-1">0.00%</p>
                <p id="sPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="sVol" class="text-[10px] text-zinc-600 mt-4">VOL: 0</p>
                <p id="sAct" class="text-[9px] text-indigo-400 font-bold">IDLE</p>
            </div>
        </div>
    </div>
    <button onclick="fetch('/api/close',{method:'POST'})" class="w-full py-3 bg-white/5 hover:bg-rose-900/20 text-zinc-500 text-[10px] uppercase font-bold tracking-widest rounded-lg transition-all">Manual Liquidation</button>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
        document.getElementById('balBar').style.width = d.market.balancePct + '%';
        document.getElementById('netPnL').innerText = d.market.netPnL.toFixed(5);
        document.getElementById('netPnL').className = 'text-2xl font-bold ' + (d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500');

        const l = d.accounts[0]; const s = d.accounts[1];
        document.getElementById('lRoi').innerText = l.roi.toFixed(2)+'%';
        document.getElementById('lPnl').innerText = '$'+l.unrealizedUsdt.toFixed(5);
        document.getElementById('lVol').innerText = 'VOL: '+l.volume;
        document.getElementById('lAct').innerText = l.lastAction;
        document.getElementById('lRoi').className = 'text-3xl font-bold mb-1 ' + (l.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');

        document.getElementById('sRoi').innerText = s.roi.toFixed(2)+'%';
        document.getElementById('sPnl').innerText = '$'+s.unrealizedUsdt.toFixed(5);
        document.getElementById('sVol').innerText = 'VOL: '+s.volume;
        document.getElementById('sAct').innerText = s.lastAction;
        document.getElementById('sRoi').className = 'text-3xl font-bold mb-1 ' + (s.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

startWS();
setInterval(runSlowLogic, 4000);
app.listen(config.port, '0.0.0.0');
