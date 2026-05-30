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
    // --- Dynamic Micro-Hedge Strategy ---
    winnerRatio: 1.25,        // Goal: Winner PnL is 25% higher (1.25x) than Loser
    minExitPnL: 0.00075,      // Minimum PnL to trigger Balanced Exit
    minExitRoi: 0.75,         // Minimum ROI to trigger Balanced Exit
    baseVolume: 1,            // START WITH 1 CONTRACT
    microStep: 1,             // INCREMENT BY ONLY 1
    cooldownMs: 4000          // Delay between 1-contract nudges
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'Active', advantagePct: 0, netPnL: 0, totalEquity: 0, sessionProfit: 0 };
let initialTotalEquity = 0;
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, wallet: 0,
        lastAction: 'Syncing', isLocked: false
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

// ==================== CORE DYNAMIC LOGIC ====================
async function runLogic() {
    let currentTotalWallet = 0;
    for (const acc of config.accounts) { 
        await syncAccount(acc, accountStates[acc.accountId]); 
        currentTotalWallet += accountStates[acc.accountId].wallet;
    }

    // Session Metrics
    if (initialTotalEquity === 0 && currentTotalWallet > 0) initialTotalEquity = currentTotalWallet;
    market.totalEquity = currentTotalWallet;
    market.sessionProfit = currentTotalWallet - initialTotalEquity;

    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === winner.accountId);
    
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;

    // 1. Calculate Dynamic Advantage Progress
    const winAbs = Math.abs(winner.unrealizedUsdt);
    const loseAbs = Math.abs(loser.unrealizedUsdt);
    if (loseAbs === 0) market.advantagePct = 0;
    else {
        const currentRatio = winAbs / loseAbs;
        market.advantagePct = Math.min(100, (currentRatio / config.winnerRatio) * 100);
    }

    // 2. CHECK FOR BALANCED EXIT
    const targetPnLMet = winAbs >= config.minExitPnL;
    const targetRoiMet = Math.abs(winner.roi) >= config.minExitRoi;
    const isAdvantaged = winAbs >= (loseAbs * config.winnerRatio);

    if (targetPnLMet && targetRoiMet && isAdvantaged && winner.volume > 0) {
        market.status = "TARGET REACHED: BALANCED EXIT";
        await closeAll();
        return;
    }

    // 3. SLOW MICRO-ADJUSTMENT (1 contract increments)
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked) {
        if (!isAdvantaged) {
            winner.isLocked = true;
            winner.lastAction = `Micro-Nudge (+${config.microStep})`;
            await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.microStep, 
                direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
        } else {
            winner.lastAction = "Balanced Advantage";
        }
    }

    // 4. INITIAL ENTRY (Start with 1)
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked) {
            state.isLocked = true;
            state.lastAction = "Initial Entry (1)";
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
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
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data) {
        state.wallet = parseFloat(accRes.data[0].margin_balance);
    }
}

async function closeAll() {
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

// ==================== DASHBOARD & WS ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.last = (msg.tick.bid[0] + msg.tick.ask[0]) / 2;
                market.spreadPct = ((msg.tick.ask[0] - msg.tick.bid[0]) / msg.tick.bid[0]) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Micro-Balance Terminal</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-end mb-10 border-b border-white/5 pb-6">
        <div><h1 class="text-xl font-bold tracking-tighter uppercase">Advantage <span class="text-indigo-500">Skew</span></h1><p id="botStatus" class="text-[10px] text-zinc-500 font-bold uppercase"></p></div>
        <div class="flex gap-10 text-right">
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Session</p><p id="sessionProfit" class="font-mono text-emerald-400 font-bold">$0.00</p></div>
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Spread</p><p id="spread" class="font-mono text-amber-500">0.00%</p></div>
            <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Price</p><p id="price" class="font-mono text-white">0.00</p></div>
        </div>
    </div>

    <div class="glass rounded-3xl p-8 mb-6 text-center">
        <div class="flex justify-between text-[10px] font-bold uppercase mb-2">
            <span class="text-zinc-500">25% Advantage Progress</span>
            <span id="advPct" class="text-indigo-400">0%</span>
        </div>
        <div class="w-full bg-white/5 h-1.5 rounded-full mb-8">
            <div id="advBar" class="bg-indigo-500 h-1.5 rounded-full transition-all duration-1000" style="width:0%"></div>
        </div>
        <p class="text-[10px] text-zinc-500 font-bold uppercase mb-1">Net Unrealized PnL</p>
        <h2 id="netPnL" class="text-6xl font-mono font-bold">$0.0000</h2>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-emerald-500 uppercase mb-4">Long Account</p>
            <p id="lRoi" class="text-3xl font-mono font-bold mb-1">0.00%</p>
            <p id="lPnl" class="text-sm font-mono text-zinc-400">$0.00000</p>
            <div class="flex justify-between mt-6 pt-4 border-t border-white/5 text-[10px] font-mono text-zinc-500">
                <span id="lVol">VOL: 0</span>
                <span id="lWallet">BAL: $0.00</span>
            </div>
            <p id="lAct" class="text-[9px] text-indigo-400 font-bold mt-2 uppercase tracking-widest"></p>
        </div>
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-rose-500 uppercase mb-4">Short Account</p>
            <p id="sRoi" class="text-3xl font-mono font-bold mb-1">0.00%</p>
            <p id="sPnl" class="text-sm font-mono text-zinc-400">$0.00000</p>
            <div class="flex justify-between mt-6 pt-4 border-t border-white/5 text-[10px] font-mono text-zinc-500">
                <span id="sVol">VOL: 0</span>
                <span id="sWallet">BAL: $0.00</span>
            </div>
            <p id="sAct" class="text-[9px] text-indigo-400 font-bold mt-2 uppercase tracking-widest"></p>
        </div>
    </div>
    <button onclick="if(confirm('Liquidate everything?')) fetch('/api/close',{method:'POST'})" class="w-full py-4 bg-rose-600/10 hover:bg-rose-600 text-rose-500 hover:text-white font-bold rounded-xl text-xs uppercase tracking-widest border border-rose-500/20 transition-all">Emergency Close All</button>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('spread').innerText = d.market.spreadPct.toFixed(3) + '%';
        document.getElementById('botStatus').innerText = d.market.status;
        document.getElementById('sessionProfit').innerText = (d.market.sessionProfit >= 0 ? '+' : '') + '$' + d.market.sessionProfit.toFixed(4);
        document.getElementById('advPct').innerText = d.market.advantagePct.toFixed(1) + '%';
        document.getElementById('advBar').style.width = d.market.advantagePct + '%';
        document.getElementById('netPnL').innerText = (d.market.netPnL >= 0 ? '+' : '') + '$' + d.market.netPnL.toFixed(5);
        document.getElementById('netPnL').className = 'text-6xl font-mono font-bold ' + (d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500');
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'l' : 's';
            document.getElementById(pre+'Roi').innerText = a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(5);
            document.getElementById(pre+'Vol').innerText = 'VOL: '+a.volume;
            document.getElementById(pre+'Wallet').innerText = 'BAL: $'+a.wallet.toFixed(2);
            document.getElementById(pre+'Act').innerText = a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-3xl font-mono font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

startWS();
setInterval(runLogic, 4000);
app.listen(config.port, '0.0.0.0');
