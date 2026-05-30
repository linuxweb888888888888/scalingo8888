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
    baseVolume: 1,      // Start with exactly 1 contract
    microStep: 1,       // Add exactly 1 contract when metrics allow
    targetRatio: 1.5,
    autoClosePct: 150,
    roiThreshold: 1.5,
    maxSpreadPct: 0.1,
    cooldownMs: 5000,   // Slower cooldown to allow indicators to update
    pollInterval: 3000,
    historySize: 20     // Number of price ticks to keep for ATR/Volatility
};

// ==================== SESSION & TA DATA ====================
let market = { 
    status: 'Initializing...', 
    bid: 0, ask: 0, spread: 0, lastPrice: 0,
    atr: 0, volatility: 0, // Technical Metrics
    balancePct: 0, totalNetGain: 0, realizedSessPnl: 0, 
    growthPct: 0, initialTotalEquity: 0 
};

let priceHistory = []; // Stores last N price points

let accountStates = {};
config.accounts.forEach((account) => {
    accountStates[account.accountId] = {
        direction: account.accountId === 1 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0,
        currentEquity: 0, initialEquity: null,
        lastAction: 'Waiting...', isLocked: false
    };
});

// ==================== MATH UTILS ====================
function calculateMetrics() {
    if (priceHistory.length < config.historySize) return;

    // 1. Calculate Standard Deviation (Volatility)
    const avg = priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length;
    const squareDiffs = priceHistory.map(p => Math.pow(p - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
    market.volatility = Math.sqrt(avgSquareDiff);

    // 2. Simple ATR Proxy (High - Low of the buffer)
    const high = Math.max(...priceHistory);
    const low = Math.min(...priceHistory);
    market.atr = high - low;
}

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
        const data = accRes.data[0];
        const equity = parseFloat(data.margin_balance);
        if (state.initialEquity === null) state.initialEquity = equity;
        state.currentEquity = equity;
    }
}

async function closeAll() {
    if (market.status === "LIQUIDATING") return;
    market.status = "LIQUIDATING";
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

// ==================== SMART LOGIC LOOP ====================
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
    market.balancePct = ((winVal / Math.max(loseVal, 0.00000001)) / config.targetRatio) * 100;

    // TRIPLE-CHECK AUTO-CLOSE
    if (market.balancePct >= config.autoClosePct && winner.roi > config.roiThreshold && winVal > loseVal) {
        await closeAll(); return;
    }

    if (market.status !== "Active" && market.status !== "LIQUIDATING") market.status = "Active";

    // METRICS QUALIFIER FOR ADDING CONTRACTS
    // ATR must be > 0 (market moving) and Volatility must be expanding
    const isMarketTrending = market.atr > (market.lastPrice * 0.0001); // Price range > 0.01%
    const isSpreadOk = market.spread < config.maxSpreadPct;

    // Parity Nudge with SMART INDICATORS
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && market.status === "Active") {
        if (winVal < loseVal) {
            // ONLY ADD CONTRACT IF MARKET IS TRENDING & SPREAD IS LOW
            if (isMarketTrending && isSpreadOk) {
                winner.isLocked = true;
                winner.lastAction = `Smart Nudge +1`;
                await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: config.microStep, 
                    direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
                setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
            } else {
                winner.lastAction = !isMarketTrending ? "Wait Volatility" : "Spread High";
            }
        } else { winner.lastAction = "Winner Leading"; }
    }

    // Base Entry (Start with 1 contract)
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

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Ultra-Hedge Smart</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #f8fafc; color: #0f172a; font-family: 'Roboto', sans-serif; }
        .card { background: white; border-radius: 32px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); position: relative; overflow: hidden; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-start mb-10">
            <div>
                <p id="botStatus" class="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">SMART ANALYSIS ACTIVE</p>
                <h1 class="text-4xl font-black text-slate-900 tracking-tighter uppercase leading-none">Ultra-Hedge</h1>
                <div class="flex gap-4 mt-4 font-black uppercase text-[9px] text-slate-400">
                    <p>Spread: <span id="mSpread">0.00%</span></p>
                    <p>Volatility: <span id="mVolat" class="text-indigo-600">0.00</span></p>
                    <p>ATR: <span id="mATR" class="text-indigo-600">0.00</span></p>
                </div>
            </div>
            <div class="text-right">
                <div class="flex items-center justify-end gap-2 mb-1">
                    <p id="growthPct" class="text-[10px] font-black px-2 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">0.00%</p>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Growth</p>
                </div>
                <p id="totalNetGain" class="text-4xl font-black leading-none text-slate-900">$0.0000</p>
                <p id="realizedPnl" class="text-[10px] font-black text-slate-400 mt-2 uppercase tracking-widest">Realized: $0.0000</p>
            </div>
        </div>

        <div class="card p-10 pt-14 mb-8">
            <div class="flex justify-between items-end mb-4">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ratio Progress</p>
                <p id="balPct" class="text-3xl font-black text-slate-900">0.0%</p>
            </div>
            <div class="w-full bg-slate-100 h-3 rounded-full overflow-hidden mb-12">
                <div id="balBar" class="bg-indigo-600 h-full w-0 transition-all duration-700 ease-out"></div>
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
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('botStatus').innerText = d.market.status;
                document.getElementById('mSpread').innerText = d.market.spread.toFixed(3) + '%';
                document.getElementById('mVolat').innerText = d.market.volatility.toFixed(8);
                document.getElementById('mATR').innerText = d.market.atr.toFixed(8);

                const growth = document.getElementById('growthPct');
                growth.innerText = (d.market.growthPct >= 0 ? '+' : '') + d.market.growthPct.toFixed(2) + '%';
                growth.className = 'text-[10px] font-black px-2 py-0.5 rounded uppercase ' + (d.market.growthPct >= 0 ? 'bg-emerald-100 text-emerald-600' : 'bg-rose-100 text-rose-600');
                
                document.getElementById('realizedPnl').innerText = 'Realized Sess: $' + d.market.realizedSessPnl.toFixed(5);
                const mainGain = document.getElementById('totalNetGain');
                mainGain.innerText = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(5);
                mainGain.className = 'text-4xl font-black leading-none ' + (d.market.totalNetGain >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                document.getElementById('balPct').innerText = d.market.balancePct.toFixed(1) + '%';
                document.getElementById('balBar').style.width = Math.min(100, (d.market.balancePct / 200) * 100) + '%';

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(6);
                    document.getElementById(p+'Vol').innerText = a.volume + ' CT | ' + a.lastAction;
                });
            } catch(e) {}
        }, 1000);
        async function triggerClose() { if(confirm("Liquidate?")) fetch('/api/close', {method:'POST'}); }
    </script>
</body></html>`);
});

// ==================== WEBSOCKET ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                market.lastPrice = (market.bid + market.ask) / 2;
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                
                // Buffer price history for TA
                priceHistory.push(market.lastPrice);
                if (priceHistory.length > config.historySize) priceHistory.shift();
                calculateMetrics();
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

startWS();
setInterval(runLogic, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Monitor running at http://localhost:${config.port}`));
