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
    takeProfitPct: 1.5,
    baseVolume: 100,
    microStep: 10,        
    targetRatio: 1.5,     
    cooldownMs: 5000      
};

let market = { last: 0, status: 'Active', balancePct: 0, netPnL: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
        lastAction: 'Idle', isLocked: false
    };
});

async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
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

// IMPROVED CLOSE ALL LOGIC
async function closeAll() {
    console.log("⚠️ EMERGENCY LIQUIDATION TRIGGERED");
    market.status = "LIQUIDATING...";
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        
        // We sync one last time to be sure we have the volume
        await syncAccount(acc, state);
        
        if (state.volume > 0) {
            console.log(`Closing Acc ${acc.accountId}: ${state.volume} units`);
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, 
                volume: state.volume, 
                direction: closeDir, 
                offset: 'close', 
                lever_rate: config.leverage, 
                order_price_type: 'optimal_10' 
            });
            console.log(`Acc ${acc.accountId} Close Result:`, res.status);
        } else {
            console.log(`Acc ${acc.accountId} has no volume to close.`);
        }
    }
    market.status = "Liquidation Complete";
    setTimeout(() => { market.status = "Active"; }, 3000);
}

async function runSlowLogic() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));
    
    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    if (loseVal === 0) market.balancePct = 100;
    else market.balancePct = Math.min(100, ((winVal / loseVal) / config.targetRatio) * 100);

    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && winVal < (loseVal * config.targetRatio)) {
        winner.isLocked = true;
        winner.lastAction = `Nudge (+${config.microStep})`;
        await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.microStep, 
            direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
        });
        setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
    }

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
        if (state.roi >= config.takeProfitPct) {
            console.log("Target ROI hit, auto-closing...");
            await closeAll();
        }
    }
}

// API ENDPOINTS
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { 
    console.log("API: Close request received");
    await closeAll(); 
    res.json({status: 'ok'}); 
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Micro Balancer</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#030304;color:#f0f0f0;font-family:monospace;}.glass{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-3xl mx-auto">
    <div class="flex justify-between items-end mb-10 border-b border-white/10 pb-4">
        <div><h1 class="text-lg font-bold uppercase">Micro-Hedge</h1><p id="botStatus" class="text-[9px] text-indigo-500 font-bold uppercase"></p></div>
        <div class="text-right"><p class="text-[10px] text-zinc-600 font-bold uppercase">Net Gain</p><p id="netPnL" class="text-2xl font-bold">$0.0000</p></div>
    </div>

    <div class="glass rounded-2xl p-8 mb-6">
        <div class="flex justify-between text-[10px] mb-2 uppercase font-bold text-zinc-500"><span>Advantage</span><span id="balPct">0%</span></div>
        <div class="w-full bg-white/5 h-1 rounded-full mb-8"><div id="balBar" class="bg-indigo-500 h-1 rounded-full" style="width:0%"></div></div>
        <div class="grid grid-cols-2 gap-10">
            <div><p class="text-[10px] text-emerald-500 font-bold mb-2 uppercase">Long</p><p id="lRoi" class="text-3xl font-bold mb-1">0.00%</p><p id="lPnl" class="text-sm text-zinc-500">$0.00</p><p id="lVol" class="text-[9px] text-zinc-600 mt-2"></p></div>
            <div class="text-right"><p class="text-[10px] text-rose-500 font-bold mb-2 uppercase">Short</p><p id="sRoi" class="text-3xl font-bold mb-1">0.00%</p><p id="sPnl" class="text-sm text-zinc-500">$0.00</p><p id="sVol" class="text-[9px] text-zinc-600 mt-2"></p></div>
        </div>
    </div>

    <!-- UPDATED BUTTON LOGIC -->
    <button id="closeBtn" onclick="triggerClose()" class="w-full py-4 bg-rose-900/10 hover:bg-rose-600 text-rose-500 hover:text-white border border-rose-900/30 rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] transition-all">
        CLOSE ALL & LIQUIDATE
    </button>
</div>
<script>
async function triggerClose() {
    if(!confirm("Liquidate all positions?")) return;
    const btn = document.getElementById('closeBtn');
    btn.innerText = "SENDING COMMAND...";
    btn.disabled = true;
    try {
        const res = await fetch('/api/close', { method: 'POST' });
        const data = await res.json();
        console.log("Server responded:", data);
    } catch(e) {
        console.error("Fetch error:", e);
    }
    setTimeout(() => {
        btn.innerText = "CLOSE ALL & LIQUIDATE";
        btn.disabled = false;
    }, 5000);
}

setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('botStatus').innerText = d.market.status;
        document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
        document.getElementById('balBar').style.width = d.market.balancePct + '%';
        document.getElementById('netPnL').innerText = d.market.netPnL.toFixed(5);
        document.getElementById('netPnL').className = 'text-2xl font-bold ' + (d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500');
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'l' : 's';
            document.getElementById(pre+'Roi').innerText = a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(5);
            document.getElementById(pre+'Vol').innerText = 'VOL: '+a.volume + ' | ' + a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-3xl font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

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

startWS();
setInterval(runSlowLogic, 4000);
app.listen(config.port, '0.0.0.0', () => console.log(`Bot running on port ${config.port}`));
