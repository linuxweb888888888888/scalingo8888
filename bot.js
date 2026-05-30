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
    // --- Winner Advantage Settings ---
    takeProfitPct: 1.5,
    stopLossPct: -5.0,
    baseVolume: 100,      
    adjustStep: 20,       // Volume added to the "Winner" to boost profit
    advantageRatio: 1.25  // We want Winner PnL to be 1.25x the Loser PnL
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'Active', advantagePct: 0, netPnL: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0, unrealizedUsdt: 0, wallet: 0,
        lastAction: 'Syncing', isProcessing: false
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

// ==================== WINNER ADVANTAGE LOGIC ====================
async function runAdvantageLogic() {
    for (const acc of config.accounts) {
        await syncAccount(acc, accountStates[acc.accountId]);
    }

    const s1 = accountStates[config.accounts[0].accountId]; // Long
    const s2 = accountStates[config.accounts[1].accountId]; // Short

    // 1. Identify Winner & Loser
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));

    // 2. Calculate "Advantage Progress" 
    // Target: Winner PnL > Abs(Loser PnL) * ratio
    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    if (loseVal === 0) market.advantagePct = 100;
    else {
        // Progress towards having the desired advantage ratio
        const currentRatio = winVal / loseVal;
        market.advantagePct = Math.min(100, (currentRatio / config.advantageRatio) * 100);
    }

    // 3. Dynamic Weighting (Add volume to winner)
    if (winner.volume > 0 && loser.volume > 0) {
        const targetWinPnL = loseVal * config.advantageRatio;
        
        // If winner isn't profitable enough to cover the loser + buffer
        if (winVal < targetWinPnL && !winner.isProcessing) {
            winner.isProcessing = true;
            winner.lastAction = `Boosting Winner (+${config.adjustStep})`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.adjustStep, 
                direction: winner.direction, offset: 'open', 
                lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            winner.isProcessing = false;
        }
    }

    // 4. Initial Entry / Maintenance
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isProcessing) {
            state.isProcessing = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, 
                direction: state.direction, offset: 'open', 
                lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            state.isProcessing = false;
        }

        if (state.roi >= config.takeProfitPct) {
            market.status = "Profit Target Reached! Closing...";
            await closeAll();
        }
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

// ==================== PRICE FEED & UI ====================
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
<html lang="en"><head><meta charset="UTF-8"><title>Advantage Balancer</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-center mb-10">
        <h1 class="text-xl font-bold tracking-tighter uppercase">Advantage <span class="text-indigo-500">Hedge</span></h1>
        <p id="price" class="font-mono text-xl">0.00000000</p>
    </div>

    <div class="glass rounded-3xl p-8 mb-6">
        <div class="flex justify-between text-[10px] font-bold uppercase mb-2">
            <span class="text-zinc-500">Winner Skew Progress</span>
            <span id="advPct" class="text-indigo-400">0%</span>
        </div>
        <div class="w-full bg-white/5 h-2 rounded-full mb-8">
            <div id="advBar" class="bg-indigo-500 h-2 rounded-full transition-all duration-1000" style="width: 0%"></div>
        </div>
        <div class="text-center">
            <p class="text-[10px] text-zinc-500 font-bold uppercase mb-1">Net Advantage PnL</p>
            <h2 id="netPnL" class="text-6xl font-mono font-bold">$0.0000</h2>
        </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
        <div id="card0" class="glass rounded-2xl p-6 transition-all duration-500">
            <p class="text-[10px] font-bold text-emerald-500 uppercase mb-4">Long Side</p>
            <p id="lRoi" class="text-4xl font-mono font-bold">0.00%</p>
            <p id="lPnl" class="text-sm font-mono text-zinc-400 mb-4">$0.0000</p>
            <div class="flex justify-between text-[10px] font-mono text-zinc-500">
                <span id="lVol">VOL: 0</span>
                <span id="lAct">IDLE</span>
            </div>
        </div>
        <div id="card1" class="glass rounded-2xl p-6 transition-all duration-500">
            <p class="text-[10px] font-bold text-rose-500 uppercase mb-4">Short Side</p>
            <p id="sRoi" class="text-4xl font-mono font-bold">0.00%</p>
            <p id="sPnl" class="text-sm font-mono text-zinc-400 mb-4">$0.0000</p>
            <div class="flex justify-between text-[10px] font-mono text-zinc-500">
                <span id="sVol">VOL: 0</span>
                <span id="sAct">IDLE</span>
            </div>
        </div>
    </div>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('advPct').innerText = d.market.advantagePct.toFixed(1) + '%';
        document.getElementById('advBar').style.width = d.market.advantagePct + '%';
        document.getElementById('netPnL').innerText = (d.market.netPnL >= 0 ? '+' : '') + '$' + d.market.netPnL.toFixed(5);
        document.getElementById('netPnL').className = 'text-6xl font-mono font-bold ' + (d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500');

        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'l' : 's';
            document.getElementById(pre+'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(5);
            document.getElementById(pre+'Vol').innerText = 'VOL: '+a.volume;
            document.getElementById(pre+'Act').innerText = a.lastAction;
            
            // Highlight the current winner
            const isWinner = (i === 0 && d.accounts[0].roi > d.accounts[1].roi) || (i === 1 && d.accounts[1].roi > d.accounts[0].roi);
            document.getElementById('card'+i).style.borderColor = isWinner ? 'rgba(99, 102, 241, 0.5)' : 'transparent';
            document.getElementById('card'+i).style.borderWidth = isWinner ? '2px' : '1px';
        });
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

startWS();
setInterval(runAdvantageLogic, 3000);
app.listen(config.port, '0.0.0.0');
