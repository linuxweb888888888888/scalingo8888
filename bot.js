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
    multiplier: 1.2,         
    stepDistancePct: 0.1,    
    takeProfitPct: 1.0,      
    pollInterval: 2000,
    takerFeeRate: 0.0005 // 0.05% HTX Taker Fee
};

let market = { status: 'Active', bid: 0, ask: 0, totalNetGain: 0, growthPct: 0, initialTotalEquity: 0 };
let tradeHistory = []; 
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false, lastAction: 'Idle',
        step: 0, lastStepPrice: 0, lastAddedVolume: 0,
        startTime: null
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 2000 });
        return res.data;
    } catch (e) { return { status: 'error' }; }
}

async function syncAccount(acc, state) {
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            state.volume = Math.floor(parseFloat(pos.volume));
            state.entryPrice = parseFloat(pos.cost_open || pos.last_price);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
            if (!state.startTime) state.startTime = new Date().toLocaleString();
        } else { 
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; state.entryPrice = 0; 
            state.step = 0; state.lastStepPrice = 0; state.lastAddedVolume = 0; state.startTime = null;
        }
    }
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

function logTradeExchangeStyle(state, exitPrice) {
    const now = new Date();
    // 1. Calculate Gross PnL from the exchange's perspective
    const grossPnl = state.unrealizedUsdt;
    
    // 2. Calculate Fees (Entry Fee + Exit Fee)
    // Approx Cost = Price * Vol * FaceValue (for SHIB face value is usually 10 contracts per USDT or similar)
    // We use the account's unrealizedUsdt and work backwards for precision
    const totalFee = (state.volume * state.entryPrice * 0.001 * config.takerFeeRate) + 
                     (state.volume * exitPrice * 0.001 * config.takerFeeRate);
    
    const netPnl = grossPnl - totalFee;

    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        type: (state.direction === 'buy' ? 'BuyCross' : 'SellCross'),
        openTime: state.startTime || now.toLocaleString(),
        closeTime: now.toLocaleString(),
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: state.roi.toFixed(4) + '%', // ROI usually reflects price move x leverage
        netPnlUsdt: netPnl.toFixed(8),    // The precise USDT value
        grossPnl: grossPnl.toFixed(8),
        status: 'All Closed'
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) { market.bid = msg.tick.bid[0]; market.ask = msg.tick.ask[0]; }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;

        if (state.volume === 0) {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            state.lastStepPrice = currentPrice;
            state.lastAddedVolume = config.baseVolume;
            state.isLocked = false;
            continue;
        }

        if (state.roi >= config.takeProfitPct) {
            state.isLocked = true;
            logTradeExchangeStyle(state, currentPrice);
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
            state.isLocked = false;
            continue;
        }

        let priceMovement = state.direction === 'buy' ? 
            ((state.lastStepPrice - currentPrice) / state.lastStepPrice) * 100 : 
            ((currentPrice - state.lastStepPrice) / state.lastStepPrice) * 100;

        if (priceMovement >= config.stepDistancePct) {
            const nextVolumeToAdd = Math.max(1, Math.ceil(state.lastAddedVolume * config.multiplier));
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: nextVolumeToAdd, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            if(res?.status === 'ok') {
                state.step++;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVolumeToAdd;
            }
            state.isLocked = false;
        }
    }
}

async function backgroundLoop() {
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    const s1 = accountStates[1]; const s2 = accountStates[2];
    if (!s1 || !s2) return;
    market.totalNetGain = (s1.currentEquity + s2.currentEquity) - market.initialTotalEquity;
    market.growthPct = market.initialTotalEquity > 0 ? (market.totalNetGain / market.initialTotalEquity) * 100 : 0;
    if (market.status === 'Active') await processMartingale();
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory }));
app.post('/api/close', async (req, res) => { market.status = "LIQUIDATING"; for (const acc of config.accounts) { const state = accountStates[acc.accountId]; if (state.volume > 0) await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: state.volume, direction: state.direction === 'buy' ? 'sell' : 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20' }); } setTimeout(() => { market.status = "Active"; }, 5000); res.json({status: 'ok'}); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Exchange Precision Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;900&display=swap" rel="stylesheet">
    <style>
        body { background: #0b0e11; color: white; font-family: 'Inter', sans-serif; }
        .card { background: #1e2329; border-radius: 8px; border: 1px solid #334155; }
        .stat-label { font-size: 11px; color: #848e9c; text-transform: uppercase; }
        .exchange-row { border-bottom: 1px solid #2b3139; padding: 16px; font-size: 12px; }
        .exchange-row:hover { background: #2b3139; }
    </style>
</head>
<body class="p-4">
    <div class="max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-6">
            <h1 class="text-xl font-bold text-yellow-500">HTX Precision Martingale</h1>
            <div class="text-right">
                <p class="stat-label">Total Net Gain</p>
                <p id="totalNetGain" class="text-xl font-black text-white">$0.00000000</p>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="card p-4 border-l-4 border-emerald-500">
                <div class="flex justify-between"><span class="stat-label">Long ROI</span><span id="lStep" class="text-[10px] text-emerald-400 font-bold">STEP 0</span></div>
                <p id="lRoi" class="text-3xl font-black text-emerald-500">0.00%</p>
                <p id="lPnl" class="text-xs text-slate-400">$0.00000000</p>
            </div>
            <div class="card p-4 border-l-4 border-rose-500">
                <div class="flex justify-between"><span class="stat-label">Short ROI</span><span id="sStep" class="text-[10px] text-rose-400 font-bold">STEP 0</span></div>
                <p id="sRoi" class="text-3xl font-black text-rose-500">0.00%</p>
                <p id="sPnl" class="text-xs text-slate-400">$0.00000000</p>
            </div>
        </div>

        <div class="card overflow-hidden">
            <div class="bg-[#2b3139] p-3 text-[11px] font-bold text-[#848e9c]">CLOSED POSITIONS</div>
            <div id="historyContainer"></div>
        </div>
    </div>

    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = '$' + d.market.totalNetGain.toFixed(8);
            d.accounts.forEach((a, i) => {
                const p = i === 0 ? 'l' : 's';
                document.getElementById(p+'Roi').innerText = a.roi.toFixed(2)+'%';
                document.getElementById(p+'Pnl').innerText = '$' + a.unrealizedUsdt.toFixed(8);
                document.getElementById(p+'Step').innerText = 'STEP ' + a.step;
            });
            let html = '';
            d.tradeHistory.forEach(h => {
                html += \`
                <div class="exchange-row">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <p class="font-bold text-sm text-white">\${h.symbol}</p>
                            <p class="text-[10px] \${h.type.includes('Buy') ? 'text-emerald-400' : 'text-rose-400'}">\${h.type}</p>
                        </div>
                        <div class="text-right text-[#848e9c] text-[10px]">
                            <div>Open: \${h.openTime}</div>
                            <div>Close: \${h.closeTime}</div>
                        </div>
                    </div>
                    <div class="grid grid-cols-4 gap-4 text-[11px]">
                        <div><p class="text-[#848e9c]">Qty</p><p class="text-white">\${h.volume}</p></div>
                        <div><p class="text-[#848e9c]">Entry/Exit</p><p class="text-white">\${h.entryPrice} / \${h.exitPrice}</p></div>
                        <div>
                            <p class="text-[#848e9c]">ROI / Net PnL</p>
                            <p class="font-black \${parseFloat(h.roi) >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${h.roi}</p>
                            <p class="text-white font-bold">\${h.netPnlUsdt} USDT</p>
                            <p class="text-[9px] text-[#848e9c]">Gross: \${h.grossPnl}</p>
                        </div>
                        <div class="text-right"><p class="text-[#848e9c]">Status</p><p class="text-emerald-400 font-bold">\${h.status}</p></div>
                    </div>
                </div>\`;
            });
            document.getElementById('historyContainer').innerHTML = html;
        }, 1000);
    </script>
</body></html>`);
});

startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => console.log(`Precision Engine Online`));
