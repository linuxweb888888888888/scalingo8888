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
    orderSize: 1,                
    addSize: 1,                  
    contractSize: 0,
    roiThreshold: 0.05, // Tightened from 0.1 to 0.05 for better sync
    maxVolGap: 500,
    maxSpreadPct: 0.05, 
    profitRoiTarget: parseFloat(process.env.PROFIT_ROI_TARGET) || 0.25               
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'initializing' };
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

    const totalWallet = s1.wallet + s2.wallet;
    const currentCombinedRoi = totalWallet > 0 ? ((s1.unrealizedUsdt + s2.unrealizedUsdt) / totalWallet) * 100 : 0;

    if (currentCombinedRoi >= config.profitRoiTarget) {
        closeAll();
    }
}

function tradeLoop() {
    if (isProcessing || triggeredExit || market.last === 0) return;
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];

    // 1. ATOMIC ENTRY (If both or one is empty)
    if (s1.volume < 1 || s2.volume < 1) {
        if (market.spreadPct > config.maxSpreadPct) {
            market.status = `Waiting Spread...`;
            return;
        }
        market.status = "Opening Sync...";
        isProcessing = true;
        const orders = [];
        if(s1.volume < 1) orders.push(htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }));
        if(s2.volume < 1) orders.push(htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', { contract_code: config.symbol, volume: config.orderSize, direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' }));
        Promise.all(orders).finally(() => { setTimeout(() => { isProcessing = false; }, 3000); });
        return;
    }

    // 2. VOLUME SYNCHRONIZATION (High Priority)
    // If one side has more volume than the other, add to the smaller side immediately
    if (Math.abs(s1.volume - s2.volume) >= config.addSize) {
        market.status = "Balancing Volume...";
        const target = (s1.volume < s2.volume) ? config.accounts[0] : config.accounts[1];
        isProcessing = true;
        htxRequest(target, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.addSize, direction: accountStates[target.accountId].direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        }).finally(() => { setTimeout(() => { isProcessing = false; }, 3000); });
        return;
    }

    // 3. ROI MIRROR LOGIC
    const roi1Mag = Math.abs(s1.roi);
    const roi2Mag = Math.abs(s2.roi);
    const isMirrored = (s1.roi * s2.roi < 0);
    const syncProgress = isMirrored ? (Math.min(roi1Mag, roi2Mag) / Math.max(roi1Mag, roi2Mag)) * 100 : 0;

    let targetAcc = null;
    if (!isMirrored) {
        market.status = "Sign Recovery...";
        targetAcc = (roi1Mag < roi2Mag) ? config.accounts[0] : config.accounts[1];
    } else if (Math.abs(roi1Mag - roi2Mag) > config.roiThreshold) {
        market.status = "Syncing ROI...";
        targetAcc = (roi1Mag > roi2Mag) ? config.accounts[0] : config.accounts[1];
    } else if (syncProgress > 90 && (s1.unrealizedUsdt + s2.unrealizedUsdt) <= 0) {
        market.status = "Pushing Profit...";
        targetAcc = (s1.roi > s2.roi) ? config.accounts[0] : config.accounts[1];
    } else {
        market.status = "Mirror Stable";
    }

    if (targetAcc) {
        isProcessing = true;
        htxRequest(targetAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.addSize, direction: accountStates[targetAcc.accountId].direction, 
            offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5' 
        }).finally(() => { setTimeout(() => { isProcessing = false; }, 4000); });
    }
}

async function closeAll() {
    if (triggeredExit) return;
    const s1 = { ...accountStates[config.accounts[0].accountId] };
    const s2 = { ...accountStates[config.accounts[1].accountId] };

    if (s1.volume > 0 || s2.volume > 0) {
        tradeHistory.unshift({
            time: new Date().toLocaleTimeString(),
            longEntry: s1.avgPrice,
            shortEntry: s2.avgPrice,
            longRoi: s1.roi,
            shortRoi: s2.roi,
            netPnl: s1.unrealizedUsdt + s2.unrealizedUsdt
        });
        if (tradeHistory.length > 10) tradeHistory.pop();
    }

    triggeredExit = true;
    market.status = "CLOSING ALL...";
    
    const closeRequests = config.accounts.map(acc => {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            return htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5' 
            });
        }
        return Promise.resolve();
    });

    await Promise.all(closeRequests);
    setTimeout(() => { triggeredExit = false; isProcessing = false; }, 15000);
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
    <meta charset="UTF-8"><title>AtomicSync Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #060606; color: #fafafa; }
        .glass { background: rgba(15, 15, 15, 0.8); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.05); }
        .roi-bar { transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1); }
    </style>
</head>
<body class="p-4 md:p-10">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div><h1 class="text-2xl font-extrabold tracking-tighter text-white">ATOMIC<span class="text-indigo-500">SYNC</span></h1><p id="botStatus" class="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">Initialising...</p></div>
            <div class="flex gap-8 text-right font-mono">
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Spread</p><p id="marketSpread" class="text-lg font-bold">0.000%</p></div>
                <div><p class="text-[10px] text-zinc-500 font-bold uppercase">Price</p><p id="markPrice" class="text-lg font-bold text-white">0.00000000</p></div>
            </div>
        </div>

        <div class="glass rounded-[2.5rem] p-8 mb-8 relative border-indigo-500/20 text-center">
            <button onclick="triggerClose()" class="absolute top-6 right-6 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-black px-5 py-2.5 rounded-full transition-all active:scale-90">CLOSE ALL</button>
            <p class="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Live Mirror PnL</p>
            <h2 id="netProfit" class="text-6xl font-black mb-1 font-mono text-zinc-500">+$0.00000000</h2>
            <p id="netRoi" class="text-sm font-bold text-indigo-400 mb-4 font-mono tracking-widest">ROI: 0.0000%</p>
            <div class="inline-flex items-center gap-2 bg-black/40 px-4 py-2 rounded-full border border-white/5">
                <span class="text-[10px] font-bold text-zinc-500 uppercase">Mirror Sync:</span><span id="syncPct" class="text-xs font-mono font-bold text-indigo-400">0%</span>
            </div>
        </div>

        <div class="grid md:grid-cols-2 gap-6 mb-8 font-mono">
            <div class="glass rounded-[2rem] p-6 border-l-4 border-emerald-500">
                <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-emerald-500 uppercase">Long Side</span><span id="longRoi" class="text-xl font-black text-emerald-400">0.00%</span></div>
                <div class="mb-4"><p class="text-[10px] text-zinc-500 font-bold">ENTRY</p><p id="longEntry" class="text-sm font-bold text-white">0.00000000</p></div>
                <div class="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mb-4"><div id="longBar" class="roi-bar bg-emerald-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-[10px] text-zinc-500 font-bold">VOL / PNL</span><span id="longUsdt" class="text-xs font-bold text-white">0 / $0.00</span></div>
            </div>
            <div class="glass rounded-[2rem] p-6 border-l-4 border-rose-500">
                <div class="flex justify-between items-center mb-2"><span class="text-[10px] font-bold text-rose-500 uppercase">Short Side</span><span id="shortRoi" class="text-xl font-black text-rose-400">0.00%</span></div>
                <div class="mb-4"><p class="text-[10px] text-zinc-500 font-bold">ENTRY</p><p id="shortEntry" class="text-sm font-bold text-white">0.00000000</p></div>
                <div class="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mb-4"><div id="shortBar" class="roi-bar bg-rose-500 h-full" style="width: 0%"></div></div>
                <div class="flex justify-between items-center"><span class="text-[10px] text-zinc-500 font-bold">VOL / PNL</span><span id="shortUsdt" class="text-xs font-bold text-white">0 / $0.00</span></div>
            </div>
        </div>

        <div class="glass rounded-[2rem] p-8">
            <div class="flex justify-between items-center mb-6">
                <h3 class="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Trade History</h3>
                <div class="text-[10px] text-zinc-500 font-bold uppercase">Realized: <span id="totalRealized" class="text-emerald-500 ml-1">+$0.00</span></div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left text-[11px] font-mono border-separate border-spacing-y-2">
                    <thead class="text-zinc-600">
                        <tr><th>TIME</th><th>L-ENTRY</th><th>S-ENTRY</th><th>L-ROI</th><th>S-ROI</th><th class="text-right">NET PNL</th></tr>
                    </thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function triggerClose() { if(confirm("Kill all active positions?")) await fetch('/api/close', { method: 'POST' }); }

        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('markPrice').innerText = d.market.last.toFixed(8);
                document.getElementById('marketSpread').innerText = d.market.spreadPct.toFixed(4) + '%';
                document.getElementById('marketSpread').className = d.market.spreadPct > 0.05 ? 'text-lg font-bold text-rose-500' : 'text-lg font-bold text-emerald-500';
                document.getElementById('botStatus').innerText = d.market.status;
                
                let tP = 0, tR = 0, tW = 0, rois = [];
                d.accounts.forEach(a => {
                    const prefix = a.direction === 'buy' ? 'long' : 'short';
                    rois.push(a.roi); tP += a.unrealizedUsdt; tR += a.realizedProfit; tW += a.wallet;
                    document.getElementById(prefix + 'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2) + '%';
                    document.getElementById(prefix + 'Entry').innerText = a.avgPrice.toFixed(8);
                    document.getElementById(prefix + 'Usdt').innerText = a.volume + ' / $' + a.unrealizedUsdt.toFixed(4);
                    document.getElementById(prefix + 'Bar').style.width = Math.min(100, Math.abs(a.roi) * 10) + '%';
                });

                const netRoi = tW > 0 ? (tP / tW) * 100 : 0;
                const sScore = (rois[0] * rois[1] < 0) ? (Math.min(Math.abs(rois[0]), Math.abs(rois[1])) / Math.max(Math.abs(rois[0]), Math.abs(rois[1]))) * 100 : 0;
                document.getElementById('syncPct').innerText = (isNaN(sScore) ? 0 : sScore.toFixed(1)) + '%';
                document.getElementById('totalRealized').innerText = (tR >= 0 ? '+' : '') + '$' + tR.toFixed(4);
                document.getElementById('netProfit').innerText = (tP >= 0 ? '+' : '') + tP.toFixed(8);
                document.getElementById('netRoi').innerText = 'ROI: ' + (netRoi >= 0 ? '+' : '') + netRoi.toFixed(4) + '%';
                document.getElementById('netProfit').className = 'text-6xl font-black mb-1 font-mono ' + (tP > 0 ? 'text-emerald-400' : (tP < 0 ? 'text-rose-500' : 'text-zinc-600'));

                document.getElementById('historyBody').innerHTML = d.history.map(h => \`
                    <tr class="bg-white/5 overflow-hidden">
                        <td class="p-3 rounded-l-xl text-zinc-500">\${h.time}</td>
                        <td class="p-3 text-white">\${h.longEntry.toFixed(8)}</td>
                        <td class="p-3 text-white">\${h.shortEntry.toFixed(8)}</td>
                        <td class="p-3 \${h.longRoi >= 0 ? 'text-emerald-500' : 'text-rose-500'}">\${h.longRoi.toFixed(2)}%</td>
                        <td class="p-3 \${h.shortRoi >= 0 ? 'text-emerald-500' : 'text-rose-500'}">\${h.shortRoi.toFixed(2)}%</td>
                        <td class="p-3 rounded-r-xl text-right font-bold \${h.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${h.netPnl.toFixed(4)}</td>
                    </tr>
                \`).join('');
            } catch(e) {}
        }, 500);
    </script>
</body>
</html>`);
});

startWS(); 
setInterval(restSync, 2000); 
setInterval(tradeLoop, 3000); 
app.listen(config.port, '0.0.0.0');
