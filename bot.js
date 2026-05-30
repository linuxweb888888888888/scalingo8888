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
    // --- Trading Strategy ---
    takeProfitPct: 1.5,
    stopLossPct: -5.0,
    orderVolume: 100 // Set this according to symbol requirements
};

// ==================== GLOBAL STATE ====================
let market = { last: 0, spreadPct: 0, status: 'System Starting...', totalEquity: 0 };
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        avgPrice: 0, roi: 0, volume: 0,
        unrealizedUsdt: 0, wallet: 0,
        lastAction: 'Initializing...',
        isProcessing: false // Lock to prevent order spam
    };
});

// ==================== API HANDLER ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { 
        AccessKeyId: account.apiKey, 
        SignatureMethod: 'HmacSHA256', 
        SignatureVersion: '2', 
        Timestamp: timestamp 
    };
    
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    
    try {
        const res = await axios({ 
            method, url, 
            data: method === 'POST' ? data : null, 
            headers: { 'Content-Type': 'application/json' }, 
            timeout: 5000 
        });

        if (res.data.status !== 'ok') {
            console.error(`🔴 API REJECTION [Acc ${account.accountId}]:`, JSON.stringify(res.data));
        }
        return res.data;
    } catch (e) { 
        console.error(`🔴 NETWORK ERROR [Acc ${account.accountId}]:`, e.message);
        return { status: 'error', 'err-msg': e.message }; 
    }
}

// ==================== TRADING LOGIC ====================
async function runAutoLogic() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        
        // 1. Sync Data
        await syncPositionAndBalance(acc, state);

        // 2. Decide Action
        if (state.isProcessing) continue;

        if (state.volume === 0) {
            // OPEN POSITION
            state.isProcessing = true;
            console.log(`[Acc ${acc.accountId}] Auto-Opening ${state.direction} for ${config.symbol}`);
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: config.orderVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20' // Aggressive fill
            });

            if (res.status === 'ok') {
                state.lastAction = `Opened ${state.direction}`;
            } else {
                state.lastAction = `Order Failed: ${res['err-msg'] || 'Check Balance'}`;
                // Delay next attempt by 5 seconds on failure
                await new Promise(r => setTimeout(r, 5000));
            }
            state.isProcessing = false;

        } else {
            // MONITOR FOR EXIT (TP/SL)
            const shouldTP = state.roi >= config.takeProfitPct;
            const shouldSL = state.roi <= config.stopLossPct;

            if (shouldTP || shouldSL) {
                state.isProcessing = true;
                const reason = shouldTP ? 'Take Profit' : 'Stop Loss';
                state.lastAction = `Closing for ${reason}...`;
                
                const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
                const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol,
                    volume: state.volume,
                    direction: closeDir,
                    offset: 'close',
                    lever_rate: config.leverage,
                    order_price_type: 'optimal_20'
                });

                if (res.status === 'ok') {
                    state.lastAction = `Closed via ${reason}`;
                } else {
                    state.lastAction = `Close Failed: ${res['err-msg']}`;
                }
                state.isProcessing = false;
            } else {
                state.lastAction = `Holding (ROI: ${state.roi.toFixed(2)}%)`;
            }
        }
    }
    market.status = "Auto-Trading Active";
}

async function syncPositionAndBalance(acc, state) {
    // Sync Position Info
    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction && p.contract_code === config.symbol);
        if (pos) {
            state.avgPrice = parseFloat(pos.cost_hold);
            state.volume = Math.floor(parseFloat(pos.volume));
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.unrealizedUsdt = parseFloat(pos.profit);
        } else {
            state.volume = 0; state.roi = 0; state.unrealizedUsdt = 0;
        }
    }

    // Sync Wallet Info
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
    if (accRes?.status === 'ok' && accRes.data) {
        state.wallet = parseFloat(accRes.data[0].margin_balance);
    }
}

// ==================== PRICE FEED (WEBSOCKET) ====================
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

// ==================== WEB DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume > 0) {
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.volume, direction: closeDir, offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_20'
            });
        }
    }
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Hedge Bot PRO</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{background:#040405;color:#fafafa;font-family:sans-serif;}.glass{background:rgba(255,255,255,0.03);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.05);}</style></head>
<body class="p-10"><div class="max-w-4xl mx-auto">
    <div class="flex justify-between items-end mb-10">
        <div><h1 class="text-xl font-bold text-white uppercase tracking-tighter">Hedge Bot <span class="text-indigo-500">Auto</span></h1><p id="botStatus" class="text-xs text-zinc-500 font-bold uppercase"></p></div>
        <div class="text-right">
            <p class="text-[10px] text-zinc-600 font-bold uppercase">Price</p>
            <p id="price" class="font-mono text-white text-2xl font-bold">0.00</p>
        </div>
    </div>
    <div class="glass rounded-3xl p-8 mb-6 text-center border-t border-indigo-500/10">
        <p class="text-[10px] text-zinc-500 font-bold uppercase mb-2">Net Unrealized PnL</p>
        <h2 id="netPnl" class="text-6xl font-mono font-bold mb-2">$0.00</h2>
        <div class="flex justify-center gap-4 mt-4">
            <span class="bg-indigo-500/10 text-indigo-400 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest">TP: ${config.takeProfitPct}%</span>
            <span class="bg-rose-500/10 text-rose-400 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest">SL: ${config.stopLossPct}%</span>
        </div>
    </div>
    <div class="grid grid-cols-2 gap-4 mb-6">
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-emerald-500 uppercase mb-4">Account 1 (Long)</p>
            <p id="longRoi" class="text-3xl font-mono font-bold mb-1">0.00%</p>
            <p id="longStats" class="text-[11px] text-zinc-400 font-mono italic">Waiting for update...</p>
        </div>
        <div class="glass rounded-2xl p-6">
            <p class="text-[10px] font-bold text-rose-500 uppercase mb-4">Account 2 (Short)</p>
            <p id="shortRoi" class="text-3xl font-mono font-bold mb-1">0.00%</p>
            <p id="shortStats" class="text-[11px] text-zinc-400 font-mono italic">Waiting for update...</p>
        </div>
    </div>
    <button onclick="closeAll()" class="w-full py-4 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs uppercase tracking-widest transition-all">Emergency Close All</button>
</div>
<script>
async function closeAll(){ if(confirm("Liquidate all positions?")) await fetch('/api/close',{method:'POST'}); }
setInterval(async () => {
    try {
        const r = await fetch('/api/status'); const d = await r.json();
        document.getElementById('price').innerText = d.market.last.toFixed(8);
        document.getElementById('botStatus').innerText = d.market.status;
        let tP=0;
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'long' : 'short';
            tP += a.unrealizedUsdt;
            document.getElementById(pre+'Roi').innerText = (a.roi >= 0 ? '+' : '') + a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Stats').innerText = 'Vol: '+a.volume+' | ' + a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-3xl font-mono font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
        });
        document.getElementById('netPnl').innerText = (tP >= 0 ? '+' : '') + '$' + tP.toFixed(4);
        document.getElementById('netPnl').className = 'text-6xl font-mono font-bold mb-2 ' + (tP >= 0 ? 'text-emerald-400' : 'text-rose-500');
    } catch(e) {}
}, 1000);
</script></body></html>`);
});

// ==================== START ====================
startWS();
setInterval(runAutoLogic, 3000); // Main logic loop every 3 seconds
app.listen(config.port, '0.0.0.0', () => console.log(`🚀 Bot live on port ${config.port}`));
