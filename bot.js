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
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1, 
    resetTriggerRoi: 1.0, // TRIGGER: 1% ROI
    targetRatio: 1.5,
    autoClosePct: 150,
    roiThreshold: 1.5,
    maxSpreadPct: 0.1, 
    pollInterval: 4000,
    resetCooldownMs: 3000,
    historySize: 30
};

// ==================== DATA TRACKING ====================
let market = { 
    status: 'Active', 
    bid: 0, ask: 0, spread: 0, lastPrice: 0,
    atr: 0, volatility: 0,
    balancePct: 0, totalNetGain: 0, realizedSessPnl: 0, 
    growthPct: 0, initialTotalEquity: 0 
};

let priceHistory = [];
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2500 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.last_price || pos.cost_open);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else { state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        const equity = parseFloat(accRes.data[0].margin_balance);
        if (state.initialEquity === null) state.initialEquity = equity;
        state.currentEquity = equity;
    }
}

async function flashReset(accIdx) {
    const acc = config.accounts[accIdx];
    const state = accountStates[acc.accountId];
    if (state.isLocked || state.volume === 0) return;

    state.isLocked = true;
    state.lastAction = "⚡ FLASH RESET";
    
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: state.volume, 
        direction: state.direction === 'buy' ? 'sell' : 'buy', 
        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });
    await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
        contract_code: config.symbol, volume: config.baseVolume, 
        direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
    });

    setTimeout(() => { state.isLocked = false; state.lastAction = "Idle"; }, config.resetCooldownMs);
}

// ==================== WS ENGINE ====================
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
                
                priceHistory.push(market.lastPrice);
                if (priceHistory.length > config.historySize) priceHistory.shift();
                
                // Tech Metrics
                const avg = priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length;
                market.volatility = Math.sqrt(priceHistory.map(p => Math.pow(p - avg, 2)).reduce((a, b) => a + b, 0) / priceHistory.length);
                market.atr = Math.max(...priceHistory) - Math.min(...priceHistory);

                // --- 1% FLASH TRIGGER ---
                const l = accountStates[1]; const s = accountStates[2];
                if (market.spread < config.maxSpreadPct) {
                    // Check if Long ROI >= 1% -> Reset Short
                    const liveLongRoi = l.entryPrice > 0 ? ((market.bid - l.entryPrice) / l.entryPrice) * config.leverage * 100 : 0;
                    if (liveLongRoi >= config.resetTriggerRoi && !s.isLocked) flashReset(1);

                    // Check if Short ROI >= 1% -> Reset Long
                    const liveShortRoi = s.entryPrice > 0 ? ((s.entryPrice - market.ask) / s.entryPrice) * config.leverage * 100 : 0;
                    if (liveShortRoi >= config.resetTriggerRoi && !l.isLocked) flashReset(0);
                }
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== SYNC LOOP ====================
async function backgroundLoop() {
    for (const acc of config.accounts) { await syncAccount(acc, accountStates[acc.accountId]); }
    
    const s1 = accountStates[1]; const s2 = accountStates[2];
    const totalCurrentEquity = s1.currentEquity + s2.currentEquity;
    const totalStartEquity = (s1.initialEquity || 0) + (s2.initialEquity || 0);
    if (market.initialTotalEquity === 0 && totalStartEquity > 0) market.initialTotalEquity = totalStartEquity;

    market.totalNetGain = totalCurrentEquity - totalStartEquity;
    market.growthPct = totalStartEquity > 0 ? (market.totalNetGain / totalStartEquity) * 100 : 0;
    market.realizedSessPnl = market.totalNetGain - (s1.unrealizedUsdt + s2.unrealizedUsdt);

    const winVal = Math.max(Math.abs(s1.unrealizedUsdt), Math.abs(s2.unrealizedUsdt));
    const loseVal = Math.abs(s1.unrealizedUsdt + s2.unrealizedUsdt - winVal);
    market.balancePct = ((winVal / Math.max(loseVal, 0.00000001)) / config.targetRatio) * 100;

    // Auto Liquidation
    if (market.balancePct >= config.autoClosePct && (s1.roi > config.roiThreshold || s2.roi > config.roiThreshold) && winVal > loseVal) {
        market.status = "LIQUIDATING";
        for (const acc of config.accounts) {
            const st = accountStates[acc.accountId];
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: st.volume, direction: st.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
        setTimeout(() => { market.status = "Active"; }, 5000);
    }

    // Refill Safety
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

async function manualClose() {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' 
            });
        }
    }
    setTimeout(() => { market.status = "Active"; }, 5000);
}

// ==================== DASHBOARD UI ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), config }));
app.post('/api/close', async (req, res) => { await manualClose(); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Ultra-Hedge Flash Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        body { background: #f8fafc; color: #0f172a; font-family: 'Roboto', sans-serif; }
        .card { background: white; border-radius: 32px; border: 1px solid #e2e8f0; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.05); position: relative; overflow: hidden; }
        .target-line { position: absolute; top: 0; bottom: 0; width: 2px; background: #ef4444; z-index: 10; }
        .target-label { position: absolute; top: -20px; transform: translateX(-50%); font-size: 9px; font-weight: 900; color: #ef4444; text-transform: uppercase; }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-2xl mx-auto">
        <div class="flex justify-between items-start mb-10">
            <div>
                <p id="botStatus" class="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">FLASH RESET ACTIVE (> 1%)</p>
                <h1 class="text-4xl font-black text-slate-900 tracking-tighter uppercase leading-none">Ultra-Hedge</h1>
                <div class="flex gap-4 mt-4 font-black uppercase text-[9px] text-slate-400">
                    <p>Spread: <span id="mSpread">0.00%</span></p>
                    <p>Volat: <span id="mVolat">0.00</span></p>
                    <p>ATR: <span id="mATR">0.00</span></p>
                </div>
            </div>
            <div class="text-right">
                <div class="flex items-center justify-end gap-2 mb-1">
                    <p id="growthPct" class="text-[10px] font-black px-2 py-0.5 rounded bg-slate-100 text-slate-600 uppercase">0.00%</p>
                    <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Growth</p>
                </div>
                <p id="totalNetGain" class="text-4xl font-black leading-none text-slate-900">$0.0000</p>
                <p id="realizedPnl" class="text-[10px] font-black text-slate-400 mt-2 uppercase tracking-widest italic">Realized Sess: $0.0000</p>
            </div>
        </div>

        <div class="card p-10 pt-14 mb-8">
            <div class="flex justify-between items-end mb-4">
                <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Target: ${config.autoClosePct}% Progress (Winner Covers Loser)</p>
                <p id="balPct" class="text-3xl font-black text-slate-900">0.0%</p>
            </div>
            <div class="relative w-full bg-slate-100 h-3 rounded-full mb-12">
                <div id="balBar" class="bg-indigo-600 h-full w-0 rounded-full transition-all duration-700 ease-out relative z-0"></div>
                <div id="targetMarker" class="target-line" style="left: 75%;"><span class="target-label">EXIT</span></div>
                <div style="left: 50%;" class="absolute top-0 bottom-0 border-l border-slate-300 border-dashed"></div>
            </div>

            <div class="grid grid-cols-2 gap-10">
                <div class="border-r border-slate-50">
                    <p class="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2">Long Position</p>
                    <p id="lRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="lPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="lVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase tracking-tighter"></p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2">Short Position</p>
                    <p id="sRoi" class="text-4xl font-black mb-1">0.00%</p>
                    <p id="sPnl" class="text-sm font-bold text-slate-400 mb-6">$0.00</p>
                    <p id="sVol" class="text-[9px] px-3 py-1 bg-slate-100 rounded-full font-black text-slate-500 uppercase tracking-tighter"></p>
                </div>
            </div>
        </div>

        <button onclick="triggerClose()" class="w-full py-6 rounded-3xl bg-slate-900 text-white font-black uppercase tracking-[0.3em] hover:bg-rose-600 transition-all shadow-xl active:scale-[0.98]">
            Manual Close & Liquidate
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate all?")) fetch('/api/close', {method:'POST'}); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('botStatus').innerText = d.market.status;
                document.getElementById('mSpread').innerText = d.market.spread.toFixed(3) + '%';
                document.getElementById('mVolat').innerText = d.market.volatility.toFixed(10);
                document.getElementById('mATR').innerText = d.market.atr.toFixed(10);
                document.getElementById('growthPct').innerText = (d.market.growthPct >= 0 ? '+' : '') + d.market.growthPct.toFixed(2) + '%';
                document.getElementById('realizedPnl').innerText = 'Realized Sess (Inc. Fees): $' + d.market.realizedSessPnl.toFixed(5);
                const gain = document.getElementById('totalNetGain');
                gain.innerText = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(5);
                gain.className = 'text-4xl font-black leading-none ' + (d.market.totalNetGain >= 0 ? 'text-emerald-500' : 'text-rose-500');
                
                const cur = d.market.balancePct;
                document.getElementById('balPct').innerText = cur.toFixed(1) + '%';
                document.getElementById('balBar').style.width = Math.min(100, (cur / 200) * 100) + '%';
                document.getElementById('targetMarker').style.left = (d.config.autoClosePct / 200) * 100 + '%';

                d.accounts.forEach((a, i) => {
                    const p = i === 0 ? 'l' : 's';
                    document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                    document.getElementById(p+'Roi').className = 'text-4xl font-black mb-1 ' + (a.roi >= 0 ? 'text-emerald-500' : 'text-rose-500');
                    document.getElementById(p+'Pnl').innerText = '$'+a.unrealizedUsdt.toFixed(6);
                    document.getElementById(p+'Vol').innerText = a.volume + ' CT | ' + a.lastAction;
                });
            } catch(e) {}
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Ultra-Hedge Pro Active on ${config.port}`));
