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
    targetProfit: parseFloat(process.env.TARGET_PROFIT) || 0.00075,  // Target net profit in USDT
    baseVolume: 1,
    microStep: 1,        
    targetRatio: 1.5,     
    cooldownMs: 5000      
};

let market = { last: 0, status: 'Active', netPnL: 0 };
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

// SIMPLIFIED CLOSE ALL - NO EXTRA LOGS OR CONDITIONS
async function closeAll(reason = 'Take Profit') {
    console.log(`🎯 ${reason} - Closing all positions`);
    market.status = "CLOSING...";
    
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        await syncAccount(acc, state);
        
        if (state.volume > 0) {
            const closeDir = state.direction === 'buy' ? 'sell' : 'buy';
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, 
                volume: state.volume, 
                direction: closeDir, 
                offset: 'close', 
                lever_rate: config.leverage, 
                order_price_type: 'optimal_10' 
            });
            console.log(`✓ Closed Acc ${acc.accountId} (${state.direction})`);
        }
    }
    
    market.status = `Closed: ${reason}`;
    
    // Reset after 5 seconds
    setTimeout(() => { 
        market.status = "Active";
        console.log("🟢 Ready for new cycle");
    }, 5000);
}

async function runSlowLogic() {
    // Sync all accounts
    for (const acc of config.accounts) { 
        await syncAccount(acc, accountStates[acc.accountId]); 
    }
    
    const s1 = accountStates[config.accounts[0].accountId];
    const s2 = accountStates[config.accounts[1].accountId];
    
    // Calculate net P&L (e.g., 0.00075 + -0.0005 = 0.00025)
    market.netPnL = s1.unrealizedUsdt + s2.unrealizedUsdt;
    
    // ========== ONLY TAKE PROFIT CONDITION ==========
    // Close when net profit reaches target (no stop loss)
    if (market.netPnL >= config.targetProfit) {
        console.log(`✅ Take profit triggered! Net PnL: ${market.netPnL.toFixed(6)} USDT (Target: ${config.targetProfit})`);
        console.log(`   Long ROI: ${s1.roi.toFixed(2)}% | Short ROI: ${s2.roi.toFixed(2)}%`);
        await closeAll(`Take Profit (${market.netPnL.toFixed(6)} USDT)`);
        return; // Exit early - no further actions after closing
    }
    
    // ========== HEDGING LOGIC (only if not closed) ==========
    const winner = s1.roi > s2.roi ? s1 : s2;
    const loser = s1.roi > s2.roi ? s2 : s1;
    const winnerAcc = config.accounts.find(a => a.accountId === (s1.roi > s2.roi ? config.accounts[0].accountId : config.accounts[1].accountId));
    
    const winVal = Math.abs(winner.unrealizedUsdt);
    const loseVal = Math.abs(loser.unrealizedUsdt);
    
    // Balance ratio logic
    if (winner.volume > 0 && loser.volume > 0 && !winner.isLocked && winVal < (loseVal * config.targetRatio)) {
        winner.isLocked = true;
        winner.lastAction = `Nudge (+${config.microStep})`;
        await htxRequest(winnerAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
            contract_code: config.symbol, volume: config.microStep, 
            direction: winner.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
        });
        setTimeout(() => { winner.isLocked = false; }, config.cooldownMs);
    }
    
    // Reopen zero positions
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.volume === 0 && !state.isLocked && market.status === 'Active') {
            state.isLocked = true;
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.baseVolume, direction: state.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            });
            setTimeout(() => { state.isLocked = false; }, 3000);
        }
    }
}

// API ENDPOINTS
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates) }));
app.post('/api/close', async (req, res) => { 
    console.log("🔴 Manual close requested");
    await closeAll('Manual Close'); 
    res.json({status: 'ok', message: 'All positions closed'}); 
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Micro Balancer - Take Profit Only</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
    body{background:#030304;color:#f0f0f0;font-family:monospace;}
    .glass{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);}
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
    }
    .animate-pulse-custom {
        animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
</style>
</head>
<body class="p-10"><div class="max-w-3xl mx-auto">
    <div class="flex justify-between items-end mb-10 border-b border-white/10 pb-4">
        <div>
            <h1 class="text-lg font-bold uppercase">Micro-Hedge</h1>
            <p id="botStatus" class="text-[9px] text-indigo-500 font-bold uppercase mt-1"></p>
        </div>
        <div class="text-right">
            <p class="text-[10px] text-zinc-600 font-bold uppercase">Net PnL (USDT)</p>
            <p id="netPnL" class="text-2xl font-bold">$0.00000</p>
            <p id="targetInfo" class="text-[9px] text-zinc-600 mt-1">Target: ${config.targetProfit.toFixed(6)} USDT</p>
        </div>
    </div>

    <!-- PROGRESS BAR SECTION -->
    <div class="glass rounded-2xl p-6 mb-6">
        <div class="flex justify-between text-[10px] mb-2 uppercase font-bold">
            <span class="text-zinc-500">PROGRESS TO TARGET</span>
            <span id="progressPercent" class="text-indigo-500">0%</span>
        </div>
        <div class="w-full bg-white/5 h-3 rounded-full mb-2 overflow-hidden">
            <div id="progressBar" class="bg-gradient-to-r from-indigo-500 to-emerald-500 h-3 rounded-full transition-all duration-500" style="width:0%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-zinc-600">
            <span>$0</span>
            <span id="currentTarget">$${config.targetProfit.toFixed(6)}</span>
        </div>
        <div id="targetAlert" class="mt-3 hidden">
            <div class="bg-emerald-500/20 border border-emerald-500/50 rounded-lg p-2 text-center animate-pulse-custom">
                <p class="text-emerald-400 text-[10px] font-bold uppercase tracking-wider">🎯 TARGET REACHED! CLOSING POSITIONS...</p>
            </div>
        </div>
    </div>

    <div class="glass rounded-2xl p-8 mb-6">
        <div class="grid grid-cols-2 gap-10">
            <div>
                <p class="text-[10px] text-emerald-500 font-bold mb-2 uppercase">Long</p>
                <p id="lRoi" class="text-3xl font-bold mb-1">0.00%</p>
                <p id="lPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="lVol" class="text-[9px] text-zinc-600 mt-2"></p>
            </div>
            <div class="text-right">
                <p class="text-[10px] text-rose-500 font-bold mb-2 uppercase">Short</p>
                <p id="sRoi" class="text-3xl font-bold mb-1">0.00%</p>
                <p id="sPnl" class="text-sm text-zinc-500">$0.00000</p>
                <p id="sVol" class="text-[9px] text-zinc-600 mt-2"></p>
            </div>
        </div>
        <div class="mt-6 pt-6 border-t border-white/10">
            <div class="flex justify-between text-[10px] mb-2 font-bold">
                <span class="text-emerald-500">Long: $<span id="lUsdt">0</span></span>
                <span class="text-rose-500">Short: $<span id="sUsdt">0</span></span>
                <span class="text-indigo-500">Net: $<span id="netUsdt">0</span></span>
            </div>
        </div>
    </div>

    <button id="closeBtn" onclick="triggerClose()" class="w-full py-4 bg-rose-900/10 hover:bg-rose-600 text-rose-500 hover:text-white border border-rose-900/30 rounded-xl text-[10px] font-bold uppercase tracking-[0.2em] transition-all">
        CLOSE ALL POSITIONS
    </button>
</div>
<script>
async function triggerClose() {
    if(!confirm("Close all positions?")) return;
    const btn = document.getElementById('closeBtn');
    btn.innerText = "CLOSING...";
    btn.disabled = true;
    try {
        const res = await fetch('/api/close', { method: 'POST' });
        const data = await res.json();
        console.log("Close result:", data);
    } catch(e) {
        console.error("Error:", e);
    }
    setTimeout(() => {
        btn.innerText = "CLOSE ALL POSITIONS";
        btn.disabled = false;
    }, 3000);
}

setInterval(async () => {
    try {
        const r = await fetch('/api/status'); 
        const d = await r.json();
        
        document.getElementById('botStatus').innerText = d.market.status;
        document.getElementById('netPnL').innerHTML = '$' + d.market.netPnL.toFixed(6);
        
        // Calculate progress percentage towards target
        const target = ${config.targetProfit};
        const currentPnL = d.market.netPnL;
        let progressPercent = 0;
        
        if (currentPnL > 0) {
            progressPercent = Math.min(100, (currentPnL / target) * 100);
        }
        
        // Update progress bar
        document.getElementById('progressBar').style.width = progressPercent + '%';
        document.getElementById('progressPercent').innerText = progressPercent.toFixed(1) + '%';
        
        // Change progress bar color based on progress
        const progressBar = document.getElementById('progressBar');
        if (progressPercent >= 100) {
            progressBar.classList.remove('bg-gradient-to-r', 'from-indigo-500', 'to-emerald-500');
            progressBar.classList.add('bg-gradient-to-r', 'from-emerald-500', 'to-green-500');
            document.getElementById('targetAlert').classList.remove('hidden');
        } else if (progressPercent >= 75) {
            progressBar.classList.remove('bg-gradient-to-r', 'from-indigo-500', 'to-emerald-500');
            progressBar.classList.add('bg-gradient-to-r', 'from-yellow-500', 'to-orange-500');
        } else {
            if (!progressBar.classList.contains('bg-gradient-to-r')) {
                progressBar.classList.add('bg-gradient-to-r', 'from-indigo-500', 'to-emerald-500');
            }
            if (progressPercent < 75) {
                progressBar.classList.remove('bg-gradient-to-r', 'from-yellow-500', 'to-orange-500');
                progressBar.classList.add('bg-gradient-to-r', 'from-indigo-500', 'to-emerald-500');
            }
            document.getElementById('targetAlert').classList.add('hidden');
        }
        
        // Color based on profit
        const netColor = d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500';
        document.getElementById('netPnL').className = 'text-2xl font-bold ' + netColor;
        
        d.accounts.forEach((a, i) => {
            const pre = i === 0 ? 'l' : 's';
            document.getElementById(pre+'Roi').innerText = a.roi.toFixed(2)+'%';
            document.getElementById(pre+'Pnl').innerHTML = '$'+a.unrealizedUsdt.toFixed(6);
            document.getElementById(pre+'Vol').innerHTML = 'VOL: '+a.volume + ' | ' + a.lastAction;
            document.getElementById(pre+'Roi').className = 'text-3xl font-bold mb-1 ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
            document.getElementById(pre+'Usdt').innerText = a.unrealizedUsdt.toFixed(6);
        });
        
        document.getElementById('netUsdt').innerText = d.market.netPnL.toFixed(6);
        document.getElementById('netUsdt').className = d.market.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-500';
        
        // Update current target display
        document.getElementById('currentTarget').innerHTML = 'Target: $' + target.toFixed(6);
        
    } catch(e) {
        console.error("Status fetch error:", e);
    }
}, 1000);
</script>
</body></html>`);
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
app.listen(config.port, '0.0.0.0', () => console.log(`🎯 Bot running - Take profit at ${config.targetProfit} USDT`));
