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
    // --- Your Specific Balanced Exit ---
    targetWinnerPnL: 0.00075, // Target PnL to trigger close
    targetWinnerRoi: 0.75,    // Target ROI to trigger close
    baseVolume: 100,          // Initial entry
    microStep: 10,            // Smallest balancing nudge
    cooldownMs: 4000          // Delay between nudges
};

let market = { last: 0, status: 'Active', targetStatus: 'Waiting for Target...', netPnL: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
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

async function closeAll() {
    console.log("🎯 TARGET REACHED: LIQUIDATING BOTH SIDES");
    market.status = "EXITING POSITIONS...";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: closeDir, 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_10' 
            });
        }
    }
}

// ==================== MAIN LOOP ====================
async function runLogic() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));
    
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // 1. CHECK THE BALANCED TAKE PROFIT CONDITION
    const hasPnLTarget = Math.abs(winner.unrealizedUsdt) >= config.targetWinnerPnL;
    const hasRoiTarget = Math.abs(winner.roi) >= config.targetWinnerRoi;

    if (hasPnLTarget && hasRoiTarget && winner.volume > 0) {
        market.targetStatus = "TARGET MET! CLOSING...";
        await closeAll();
        return;
    } else {
        market.targetStatus = `Waiting (Need Winner PnL: ${config.targetWinnerPnL} & ROI: ${config.targetWinnerRoi}%)`;
    }

    // 2. MICRO-ADJUSTMENT (Slow balancing toward winner)
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked) {
        // Slow nudge if winner isn't reaching target yet
        if (Math.abs(winner.unrealizedUsdt) < config.targetWinnerPnL) {
            winner.isLocked = true;
            winner.lastAction = `Nudge Winner (+${config.microStep})`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, 
                direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        }
    }

    // 3. INITIAL ENTRY
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

// ==================== DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Balanced Exit Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#030304;color:#f0f0f0;font-family:monospace;}.glass{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-3xl mx-auto">
    <div class="flex justify-between items-end mb-10 border-b border-white/10 pb-4">
        <div><h1 class="text-lg font-bold">BALANCED EXIT TERMINAL</h1><p id="targetStatus" class="text-[9px] text-indigo-400 font-bold uppercase"></p></div>
        <div class="text-right"><p class="text-[10px] text-zinc-600 font-bold uppercase">Combined PnL</p><p id="netPnL" class="text-2xl font-bold">$0.0000</p></div>
    </div>

    <div class="glass rounded-2xl p-8 mb-6">
        <div class="grid grid-cols-2 gap-10">
            <div>
                <p class="text-[10px] text-emerald-500 font-bold mb-2 uppercase tracking-widest">Long Account</p>
                <p id="lRoi" class="text-4xl font-bold mb-1">0.00%</p>
                <p id="lPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="lVol" class="text-[9px] text-zinc-600 mt-6"></p>
            </div>
            <div class="text-right">
                <p class="text-[10px] text-rose-500 font-bold mb-2 uppercase tracking-widest">Short Account</p>
                <p id="sRoi" class="text-4xl font-bold mb-1">0.00%</p>
                <p id="sPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="sVol" class="text-[9px] text-zinc-600 mt-6"></p>
            </div>
        </div>
    </div>

    <button onclick="if(confirm('Manual Close?')) fetch('/api/close',{method:'POST'})" class="w-full py-4 bg-white/5 hover:bg-rose-900/20 text-zinc-600 hover:text-rose-500 border border-white/5 rounded-xl text-[10px] font-bold uppercase tracking-[0.3em] transition-all">
        Force Emergency Close
    </button>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('targetStatus').innerText = d.market.targetStatus;
        document.getElementById('netPnL').innerText = (d.market.netPnL >= 0 ? '+' : '') + '$' + d.market.netPnL.toFixed(5);
        document.getElementById('netPnL').className = 'text-2xl font-bold ' + (d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500');
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'l' : 's';
            document.getElementById(pre+'Roi').innerText = a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(5);
            document.getElementById(pre+'Vol').innerText = 'VOL: '+a.volume + ' | ' + a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-4xl font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
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
setInterval(runLogic, 4000);
app.listen(config.port, '0.0.0.0');
