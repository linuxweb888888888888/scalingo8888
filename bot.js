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
    spreadThreshold: 0.05,
    autoFundingChase: true,       // ENABLED: Auto-harvest funding
    chaseLeadTimeSeconds: 30      // Seconds before funding to execute
};

// ==================== GLOBAL STATE ====================
let market = { 
    last: 0, 
    spreadPct: 0, 
    status: 'connecting...', 
    totalEquity: 0, 
    initialTotalEquity: 0,
    fundingRate: 0,
    fundingTimestamp: 0,
    nextFundingTime: '',
    hasChasedFunding: false // Reset every cycle
};
let accountStates = {};
let isProcessing = false;

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, wallet: 0
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

// ==================== CORE LOGIC ====================

async function restSync() {
    let totalPnl = 0;
    let currentTotalWallet = 0;

    // Fetch Funding Rate
    const fundRes = await axios.get(`https://${config.restHost}/linear-swap-api/v1/swap_funding_rate?contract_code=${config.symbol}`);
    if (fundRes.data?.status === 'ok') {
        market.fundingRate = parseFloat(fundRes.data.data.funding_rate) * 100;
        market.fundingTimestamp = parseInt(fundRes.data.data.funding_time);
        market.nextFundingTime = new Date(market.fundingTimestamp).toLocaleTimeString();
        
        // RESET CHASE FLAG IF NEW CYCLE
        if (Date.now() < market.fundingTimestamp - 60000) {
            market.hasChasedFunding = false;
        }
    }

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.status === 'ok' && res.data) {
            const pos = res.data.find(p => p.direction === state.direction);
            if (pos) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = Math.floor(parseFloat(pos.volume));
                state.roi = parseFloat(pos.profit_rate) * 100;
                state.unrealizedUsdt = parseFloat(pos.profit);
            } else { state.avgPrice = 0; state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; }
        }
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data) {
            state.wallet = parseFloat(accRes.data[0].margin_balance);
        }
        totalPnl += state.unrealizedUsdt;
        currentTotalWallet += state.wallet;
    }
    
    if (market.initialTotalEquity === 0 && currentTotalWallet > 0) market.initialTotalEquity = currentTotalWallet;
    market.totalEquity = currentTotalWallet;

    // AUTO-OPEN INITIAL HEDGE
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    if (s1.volume === 0 && s2.volume === 0 && !isProcessing && market.spreadPct <= config.spreadThreshold && market.spreadPct > 0) {
        autoOpen();
    }

    // AUTO-FUNDING CHASE LOGIC
    if (config.autoFundingChase && !market.hasChasedFunding && s1.volume > 1 && s2.volume > 1) {
        const timeToFunding = market.fundingTimestamp - Date.now();
        if (timeToFunding > 0 && timeToFunding <= (config.chaseLeadTimeSeconds * 1000)) {
            executeFundingChase();
        }
    }
}

async function autoOpen() {
    isProcessing = true;
    market.status = "Opening Hedge...";
    await Promise.all([
        htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: 5, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }),
        htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: 5, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' })
    ]);
    setTimeout(() => { isProcessing = false; }, 2000);
}

async function executeFundingChase() {
    market.hasChasedFunding = true;
    market.status = "AUTO-CHASING FUNDING...";
    
    // If Funding (+): Shorts get paid. Reduce LONG.
    // If Funding (-): Longs get paid. Reduce SHORT.
    const targetToReduceIdx = (market.fundingRate > 0) ? 0 : 1; 
    const targetAcc = config.accounts[targetToReduceIdx];
    const currentVol = accountStates[targetAcc.accountId].volume;

    if (currentVol > 1) {
        await htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
            contract_code: config.symbol, 
            volume: currentVol - 1, 
            direction: accountStates[targetAcc.accountId].direction === 'buy' ? 'sell' : 'buy', 
            offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        });
    }
}

async function manualChase() {
    isProcessing = true;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    const loserIdx = (s1.roi < s2.roi) ? 0 : 1;
    const loserAcc = config.accounts[loserIdx];
    const currentVol = accountStates[loserAcc.accountId].volume;
    if (currentVol > 1) {
        await htxRequest(loserAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: currentVol - 1, direction: accountStates[loserAcc.accountId].direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' });
    }
    setTimeout(() => { isProcessing = false; }, 2000);
}

async function closeAll() {
    isProcessing = true;
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' });
        }
    }
    setTimeout(() => { isProcessing = false; }, 5000);
}

// ==================== WS & DASHBOARD ====================
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
app.post('/api/chase', async (req, res) => { await manualChase(); res.json({status: 'ok'}); });
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>FundingSync AUTO</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-3xl mx-auto">
    <div class="flex justify-between items-end mb-10">
        <div><h1 class="text-xl font-bold text-white uppercase italic">FundingSync <span class="text-indigo-500">AUTO</span></h1><p id="botStatus" class="text-[10px] text-zinc-500 font-bold uppercase"></p></div>
        <div class="text-right">
            <p class="text-[10px] text-zinc-600 uppercase font-bold">Funding Rate</p>
            <p id="fundingRate" class="font-mono text-xl font-bold text-indigo-400">0.0000%</p>
            <p id="fundingTime" class="text-[10px] text-zinc-500 font-mono italic">Next: 00:00:00</p>
        </div>
    </div>

    <div class="glass rounded-3xl p-8 mb-6 text-center border-t border-indigo-500/20">
        <p class="text-[10px] text-zinc-500 font-bold uppercase mb-2">Net Mirror PnL</p>
        <h2 id="netPnl" class="text-6xl font-mono font-bold mb-4">$0.00000000</h2>
        <div class="flex justify-center gap-4">
            <button onclick="fetch('/api/chase',{method:'POST'})" class="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-full text-xs font-black tracking-widest transition-all">MANUAL CHASE</button>
            <button onclick="fetch('/api/close',{method:'POST'})" class="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-full text-xs font-black tracking-widest transition-all">CLOSE ALL</button>
        </div>
    </div>

    <div class="grid grid-cols-2 gap-4 mb-6 font-mono text-center">
        <div class="glass rounded-2xl p-6 border-l-4 border-emerald-500">
            <p class="text-[10px] text-emerald-500 font-bold uppercase mb-2">Long Account</p>
            <p id="longRoi" class="text-2xl font-bold mb-1">0.00%</p>
            <p id="longStats" class="text-[10px] text-zinc-500">Vol: 0</p>
        </div>
        <div class="glass rounded-2xl p-6 border-l-4 border-rose-500">
            <p class="text-[10px] text-rose-500 font-bold uppercase mb-2">Short Account</p>
            <p id="shortRoi" class="text-2xl font-bold mb-1">0.00%</p>
            <p id="shortStats" class="text-[10px] text-zinc-500">Vol: 0</p>
        </div>
    </div>

    <div class="flex justify-between items-center px-4 py-2 glass rounded-xl text-xs font-mono">
        <span class="text-zinc-500 uppercase">Equity Profit: <span id="equityProfit" class="text-emerald-400 ml-2">$0.00000000</span></span>
        <span class="text-zinc-500 uppercase">Spread: <span id="spread" class="text-amber-500 ml-2">0.000%</span></span>
    </div>
</div>
<script>
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('fundingRate').innerText = d.market.fundingRate.toFixed(4) + '%';
        document.getElementById('fundingTime').innerText = 'Next Payment: ' + d.market.nextFundingTime;
        document.getElementById('spread').innerText = d.market.spreadPct.toFixed(3) + '%';
        document.getElementById('botStatus').innerText = d.market.status;
        const profit = d.market.totalEquity - d.market.initialTotalEquity;
        document.getElementById('equityProfit').innerText = (profit>=0?'+':'') + '$'+profit.toFixed(8);
        let tP=0;
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'long' : 'short';
            tP += a.unrealizedUsdt;
            document.getElementById(pre+'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Stats').innerText = 'Vol: '+a.volume+' | PnL: $'+a.unrealizedUsdt.toFixed(4);
            document.getElementById(pre+'Roi').className = 'text-2xl font-bold ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
        document.getElementById('netPnl').innerText = (tP>=0?'+':'') + '$' + tP.toFixed(8);
        document.getElementById('netPnl').className = 'text-6xl font-mono font-bold ' + (tP>=0?'text-emerald-400':'text-rose-500');
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

startWS(); setInterval(restSync, 2000); app.listen(config.port, '0.0.0.0');
