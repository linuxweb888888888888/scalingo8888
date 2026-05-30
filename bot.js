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
    microStep: 1,        
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

async function closeAll() {
    if (market.status.includes("LIQUIDATING")) return;
    market.status = "LIQUIDATING (95%)...";
    
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
    market.status = "COMPLETED";
    setTimeout(() => { market.status = "Active"; }, 5000);
}

async function runSlowLogic() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const winVal = Math.max(Math.abs(s1.unrealizedUsdt), Math.abs(s2.unrealizedUsdt));
    const loseVal = Math.min(Math.abs(s1.unrealizedUsdt), Math.abs(s2.unrealizedUsdt));
    
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;
    if (loseVal < 0.01) market.balancePct = 0;
    else market.balancePct = Math.min(100, ((winVal / loseVal) / config.targetRatio) * 100);

    // AUTO-CLOSE AT 95%
    if (market.balancePct >= 95 && (s1.volume > 0 || s2.volume > 0)) {
        await closeAll();
        return;
    }

    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));

    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && market.balancePct < 95) {
        if (winVal < (loseVal * config.targetRatio)) {
            winner.isLocked = true;
            winner.lastAction = `Nudge (+${config.microStep})`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, 
                direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        }
    }

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked && !market.status.includes("LIQUIDATING")) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
    }
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

// ==================== UI DESIGN (WHITE/ROBOTO) ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Hedge Monitor</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background-color: #f8fafc; color: #1e293b; font-family: 'Roboto', sans-serif; }
        .card { background: white; border: 1px solid #e2e8f0; border-radius: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
        .progress-container { background: #f1f5f9; border-radius: 999px; height: 12px; overflow: hidden; }
        .btn-liquidate { background: #ef4444; transition: all 0.2s; }
        .btn-liquidate:hover { background: #dc2626; transform: translateY(-1px); }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-2xl mx-auto">
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black tracking-tighter text-slate-900 uppercase">Hedge-Bot</h1>
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <p id="botStatus" class="text-xs font-bold text-slate-400 uppercase tracking-widest">Active</p>
                </div>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Net PnL</p>
                <p id="netPnL" class="text-4xl font-black text-slate-900 leading-none">$0.0000</p>
            </div>
        </div>

        <!-- Main Card -->
        <div class="card p-8 mb-6">
            <div class="flex justify-between items-end mb-4">
                <h2 class="text-xs font-black text-slate-400 uppercase tracking-widest">Target Progress (Close @ 95%)</h2>
                <span id="balPct" class="text-2xl font-black text-indigo-600">0.0%</span>
            </div>
            
            <div class="progress-container mb-10">
                <div id="balBar" class="bg-indigo-600 h-full w-0 transition-all duration-700 ease-out"></div>
            </div>

            <div class="grid grid-cols-2 gap-8">
                <div class="border-r border-slate-100 pr-4">
                    <p class="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">Long Position</p>
                    <p id="lRoi" class="text-4xl font-black text-slate-900 mb-1">0.00%</p>
                    <p id="lPnl" class="text-lg font-medium text-slate-400">$0.00</p>
                    <div class="mt-4 pt-4 border-t border-slate-50">
                        <p id="lVol" class="text-[10px] font-bold text-slate-400 uppercase italic"></p>
                    </div>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-black text-rose-600 uppercase tracking-widest mb-2">Short Position</p>
                    <p id="sRoi" class="text-4xl font-black text-slate-900 mb-1">0.00%</p>
                    <p id="sPnl" class="text-lg font-medium text-slate-400">$0.00</p>
                    <div class="mt-4 pt-4 border-t border-slate-50">
                        <p id="sVol" class="text-[10px] font-bold text-slate-400 uppercase italic"></p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Action Button -->
        <button onclick="triggerClose()" class="w-full py-5 rounded-2xl btn-liquidate text-white font-black uppercase tracking-[0.2em] shadow-lg shadow-rose-200">
            Emergency Liquidation
        </button>

        <p class="text-center mt-6 text-[10px] text-slate-300 font-bold uppercase tracking-widest">System Online • ${config.symbol} • ${config.leverage}x</p>
    </div>

<script>
    async function triggerClose() {
        if(!confirm("Are you sure you want to exit all positions?")) return;
        await fetch('/api/close', { method: 'POST' });
    }

    setInterval(async () => {
        try {
            const r = await fetch('/api/status'); 
            const d = await r.json();
            
            document.getElementById('botStatus').innerText = d.market.status;
            document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
            
            const bar = document.getElementById('balBar');
            bar.style.width = d.market.balancePct + '%';
            if(d.market.balancePct >= 90) bar.style.backgroundColor = '#f97316';
            else bar.style.backgroundColor = '#4f46e5';

            const net = document.getElementById('netPnL');
            net.innerText = (d.market.netPnL >= 0 ? '+' : '') + d.market.netPnL.toFixed(4);
            net.className = 'text-4xl font-black leading-none ' + (d.market.netPnL >= 0 ? 'text-emerald-500' : 'text-rose-500');

            d.accounts.forEach((a, i) => {
                const pre = i === 0 ? 'l' : 's';
                const roiEl = document.getElementById(pre+'Roi');
                roiEl.innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
                roiEl.className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                document.getElementById(pre+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(4);
                document.getElementById(pre+'Vol').innerText = 'VOL: ' + a.volume + ' | ' + a.lastAction;
            });
        } catch(e) {}
    }, 1000);
</script>
</body>
</html>`);
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
app.listen(config.port, '0.0.0.0', () => console.log(`Monitor running at http://localhost:${config.port}`));
