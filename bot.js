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
    orderSize: 100,               // Turbo Start
    contractSize: 0,
    pnlTolerance: 0.00005,        
    roiTolerance: 0.02,           
    maxSpreadPct: 0.25,           
    profitRoiTarget: parseFloat(process.env.PROFIT_ROI_TARGET) || 0.50               
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'initializing', lastNetPnL: 0, improvement: 0, efficiency: 0 };
let accountStates = {};
let tradeHistory = []; 
let isProcessing = false;
let triggeredExit = false; 

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, initialBalance: 0, realizedProfit: 0, wallet: 0
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
    if (triggeredExit) return; 
    if (config.contractSize === 0) {
        const info = await htxRequest(config.accounts[0], 'GET', '/linear-swap-api/v1/swap_contract_info');
        if (info?.status === 'ok') {
            const contract = info.data.find(c => c.contract_code === config.symbol);
            if (contract) config.contractSize = parseFloat(contract.contract_size);
        }
    }

    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        if (res?.status === 'ok') {
            const pos = (res.data || []).find(p => p.direction === state.direction);
            if (pos && parseFloat(pos.volume) > 0) {
                state.avgPrice = parseFloat(pos.cost_hold);
                state.volume = Math.floor(parseFloat(pos.volume));
                state.roi = parseFloat(pos.profit_rate) * 100;
                state.unrealizedUsdt = parseFloat(pos.profit);
            } else { 
                state.avgPrice = 0; state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0; 
            }
        }
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.status === 'ok' && accRes.data) {
            const equity = parseFloat(accRes.data[0].margin_balance);
            if (state.initialBalance === 0) state.initialBalance = equity;
            state.wallet = equity;
            state.realizedProfit = equity - state.initialBalance;
        }
    }
}

function instantCheck() {
    if (triggeredExit || market.last === 0 || config.contractSize === 0) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    if (s1.volume < 1 || s2.volume < 1) return;

    const netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;
    const totalWallet = s1.wallet + s2.wallet;
    const currentCombinedRoi = totalWallet > 0 ? (netPnL / totalWallet) * 100 : 0;

    const totalAbsPnL = Math.abs(s1.unrealizedUsdt) + Math.abs(s2.unrealizedUsdt);
    market.efficiency = totalAbsPnL > 0 ? (1 - (Math.abs(netPnL) / totalAbsPnL)) * 100 : 0;

    if (market.lastNetPnL !== 0) {
        const prevGap = Math.abs(market.lastNetPnL);
        const currGap = Math.abs(netPnL);
        market.improvement = prevGap !== 0 ? ((prevGap - currGap) / prevGap) * 100 : 0;
    }
    market.lastNetPnL = netPnL;

    if (currentCombinedRoi >= config.profitRoiTarget) closeAll();
}

function tradeLoop() {
    if (isProcessing || triggeredExit || market.last === 0) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    // 1. ATOMIC OPEN (High Volume)
    if (s1.volume < 1 || s2.volume < 1) {
        if (market.spreadPct > config.maxSpreadPct) { market.status = "Spread Lock"; return; }
        market.status = "Atomic Opening (Turbo)...";
        isProcessing = true;
        Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' })
        ]).finally(() => { setTimeout(() => { isProcessing = false; }, 3000); });
        return;
    }

    const netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;
    const volGap = s1.volume - s2.volume;
    
    // DYNAMIC ADD SIZE: Calculate 15% of current stack to ensure price moves
    const currentMaxVol = Math.max(s1.volume, s2.volume);
    const turboAdd = Math.max(25, Math.floor(currentMaxVol * 0.15));

    let targetAcc = null;

    // PRIORITY 1: Repair Negative PnL Immediately (Turbo Repair)
    if (netPnL < -config.pnlTolerance) {
        market.status = "TURBO REPAIRING PNL...";
        targetAcc = (s1.unrealizedUsdt < s2.unrealizedUsdt) ? config.accounts[0] : config.accounts[1];
    } 
    // PRIORITY 2: Sync Volume
    else if (Math.abs(volGap) >= 50) {
        market.status = "Syncing Volume Weights...";
        targetAcc = (volGap < 0) ? config.accounts[0] : config.accounts[1];
    }
    // PRIORITY 3: Profit Pushing (Increase the winner)
    else if (netPnL >= 0) {
        market.status = "PUSHING PROFIT...";
        targetAcc = (s1.roi > s2.roi) ? config.accounts[0] : config.accounts[1];
    }

    if (targetAcc) {
        isProcessing = true;
        htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: turboAdd, direction: accountStates[targetAcc.accountId].direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        }).finally(() => { setTimeout(() => { isProcessing = false; }, 2500); });
    }
}

async function closeAll() {
    if (triggeredExit) return;
    const s1 = { ...accountStates[config.accounts[0].accountId] };
    const s2 = { ...accountStates[config.accounts[1].accountId] };
    if (s1.volume > 0 || s2.volume > 0) {
        tradeHistory.unshift({
            time: new Date().toLocaleTimeString(),
            longEntry: s1.avgPrice, shortEntry: s2.avgPrice,
            longRoi: s1.roi, shortRoi: s2.roi, netPnl: s1.unrealizedUsdt + s2.unrealizedUsdt
        });
    }
    triggeredExit = true;
    market.status = "TAKING PROFIT...";
    config.accounts.forEach(acc => {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
        }
    });
    setTimeout(() => { triggeredExit = false; isProcessing = false; }, 10000);
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
                const bid = msg.tick.bid[0]; const ask = msg.tick.ask[0];
                market.last = (bid + ask) / 2;
                market.spreadPct = ((ask - bid) / bid) * 100;
                instantCheck(); 
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), history: tradeHistory, config }));
app.post('/api/close', async (req, res) => { await closeAll(); res.json({ status: 'ok' }); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>AtomicSync Turbo</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #040405; color: #fafafa; }
        .glass { background: rgba(10, 10, 12, 0.95); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.05); }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-10">
            <div><h1 class="text-2xl font-black text-white uppercase italic">AtomicSync<span class="text-indigo-500">Turbo</span></h1><p id="botStatus" class="text-[10px] font-bold text-indigo-400 uppercase tracking-[0.4em]">SYNCING...</p></div>
            <div class="flex gap-10 text-right font-mono">
                <div><p class="text-[10px] text-zinc-600 font-bold uppercase">ROI Sum</p><p id="roiSum" class="text-lg font-bold text-white">0.00%</p></div>
                <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Efficiency</p><p id="mirrorEfficiency" class="text-lg font-bold text-indigo-400">0.00%</p></div>
                <div><p class="text-[10px] text-zinc-600 font-bold uppercase">Price</p><p id="markPrice" class="text-lg font-bold text-white">0.00000000</p></div>
            </div>
        </div>

        <div class="glass rounded-[3rem] p-10 mb-8 relative text-center border-t border-indigo-500/20">
            <button onclick="triggerClose()" class="absolute top-8 right-8 bg-rose-600 text-white text-[10px] font-black px-6 py-3 rounded-full">EXIT</button>
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Net Mirror PnL (Unified)</p>
            <h2 id="netProfit" class="text-7xl font-black mb-1 font-mono text-zinc-800">+$0.00000000</h2>
            <p id="netRoi" class="text-md font-bold text-indigo-500/60 mb-6 font-mono tracking-widest uppercase">Mirror ROI: 0.0000%</p>
            <div id="healthBadge" class="inline-flex items-center gap-3 bg-black/50 px-6 py-3 rounded-full border border-white/5">
                <span id="syncPct" class="text-xs font-mono font-bold text-indigo-400">WAITING</span>
            </div>
        </div>

        <div class="grid md:grid-cols-2 gap-8 mb-10 font-mono">
            <div class="glass rounded-[2.5rem] p-8 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-emerald-500 italic">Long Account</span><span id="longRoi" class="text-2xl font-black text-emerald-400">0.00%</span></div>
                <div class="mb-6"><p class="text-[10px] text-zinc-600 font-bold">ENTRY</p><p id="longEntry" class="text-md font-bold text-zinc-200">0.00000000</p></div>
                <div class="flex justify-between items-center"><span class="text-[10px] text-zinc-600 font-bold">Volume / PnL</span><span id="longUsdt" class="text-sm font-bold text-white">0 / $0.0000</span></div>
            </div>
            <div class="glass rounded-[2.5rem] p-8 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-rose-500 italic">Short Account</span><span id="shortRoi" class="text-2xl font-black text-rose-400">0.00%</span></div>
                <div class="mb-6"><p class="text-[10px] text-zinc-600 font-bold">ENTRY</p><p id="shortEntry" class="text-md font-bold text-zinc-200">0.00000000</p></div>
                <div class="flex justify-between items-center"><span class="text-[10px] text-zinc-600 font-bold">Volume / PnL</span><span id="shortUsdt" class="text-sm font-bold text-white">0 / $0.0000</span></div>
            </div>
        </div>

        <div class="glass rounded-[2.5rem] p-8">
            <div class="overflow-x-auto"><table class="w-full text-left text-[11px] font-mono border-separate border-spacing-y-4"><tbody id="historyBody"></tbody></table></div>
        </div>
    </div>

    <script>
        async function triggerClose() { if(confirm("Liquidate?")) await fetch('/api/close', { method: 'POST' }); }
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
                document.getElementById('mirrorEfficiency').innerText = d.market.efficiency.toFixed(2) + '%';
                document.getElementById('botStatus').innerText = d.market.status;
                let tP = 0, tW = 0, sumRoi = 0;
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    tP += a.unrealizedUsdt; tW += a.wallet; sumRoi += a.roi;
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Entry').innerText = a.avgPrice.toFixed(8);
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(4);
                });
                document.getElementById('roiSum').innerText = (sumRoi >= 0 ? '+' : '') + sumRoi.toFixed(2) + '%';
                const netRoi = tW > 0 ? (tP / tW) * 100 : 0;
                document.getElementById('syncPct').innerText = d.market.efficiency > 95 ? 'PERFECT MIRROR' : 'REPAIRING...';
                document.getElementById('netProfit').innerText = (tP >= 0 ? '+' : '') + tP.toFixed(8);
                document.getElementById('netRoi').innerText = 'MIRROR ROI: ' + (netRoi >= 0 ? '+' : '') + netRoi.toFixed(4) + '%';
                document.getElementById('netProfit').className = 'text-7xl font-black mb-1 font-mono ' + (tP > 0 ? 'text-emerald-400' : (tP < 0 ? 'text-rose-500' : 'text-zinc-900'));
                document.getElementById('historyBody').innerHTML = d.history.map(h => `
                    <tr class="bg-white/5"><td class="p-4 rounded-l-2xl text-zinc-500 font-bold">${h.time}</td><td class="p-4 text-zinc-300">${h.longEntry.toFixed(8)}</td><td class="p-4 text-zinc-300">${h.shortEntry.toFixed(8)}</td><td class="p-4 rounded-r-2xl text-right font-black ${h.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${h.netPnl.toFixed(4)}</td></tr>
                `).join('');
            } catch(e) {}
        }, 500);
    </script>
</body>
</html>`);
});

startWS(); 
setInterval(restSync, 2000); 
setInterval(tradeLoop, 2500); 
app.listen(config.port, '0.0.0.0');
