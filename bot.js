require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION & ENV DETECTION ====================
const detectedAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    detectedAccounts.push({
        id: accountIndex,
        // Using first 4 chars of key just to visually confirm which "real" account is being simulated
        label: `REAL_SLOT_${accountIndex}_(${process.env[`HTX_API_KEY_${accountIndex}`].substring(0, 4)}...)`
    });
    accountIndex++;
}

if (detectedAccounts.length === 0) {
    console.error("❌ NO REAL ACCOUNTS DETECTED IN .ENV! Please add HTX_API_KEY_1, etc.");
    process.exit(1);
}

const config = {
    symbol: (process.env.SYMBOL || 'DOGE-USDT').toUpperCase(),
    leverage: 75,
    port: process.env.PORT || 3000,
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    baseVolume: 10, // Virtual DOGE contracts
    takeProfitPct: 2.5,
    contractValue: 10, // 1 Contract = 10 DOGE
    virtualInitialMargin: 500.0, // Starting fake balance per real account slot
    takerFee: 0.0005 // 0.05% fee simulation
};

let market = {
    status: 'VIRTUAL_MODE', 
    bid: 0, ask: 0, 
    totalNetGain: 0,
    initialTotalEquity: detectedAccounts.length * config.virtualInitialMargin,
    sessionRealizedProfit: 0,
    netSessionUsdt: 0
};

let tradeHistory = [];
let accountStates = {};

// Initialize Paper State for each Real Account detected
detectedAccounts.forEach((acc, idx) => {
    accountStates[acc.id] = {
        id: acc.id,
        label: acc.label,
        direction: idx % 2 === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: config.virtualInitialMargin,
        availableBalance: config.virtualInitialMargin,
        lastAction: 'Paper Engine Waiting...',
        isLocked: false
    };
});

// ==================== MOCKED EXECUTION ENGINE ====================

function virtualOpen(accId) {
    const state = accountStates[accId];
    if (market.bid === 0 || state.volume > 0) return;

    const fillPrice = state.direction === 'buy' ? market.ask : market.bid;
    
    // Safety check: Don't open if someone else just opened at this price
    const existingPrices = Object.values(accountStates).map(s => s.entryPrice);
    if (existingPrices.includes(fillPrice)) return;

    const notional = config.baseVolume * config.contractValue * fillPrice;
    const marginRequired = notional / config.leverage;
    const fee = notional * config.takerFee;

    if (state.availableBalance < (marginRequired + fee)) {
        state.lastAction = "VIRTUAL_MARGIN_CALL";
        return;
    }

    state.entryPrice = fillPrice;
    state.volume = config.baseVolume;
    state.availableBalance -= (marginRequired + fee);
    state.lastAction = `VIRTUAL OPEN @ ${fillPrice}`;
}

function virtualClose(accId, type) {
    const state = accountStates[accId];
    if (state.volume === 0) return;

    const exitPrice = state.direction === 'buy' ? market.bid : market.ask;
    const directionMult = state.direction === 'buy' ? 1 : -1;
    
    const grossPnl = (exitPrice - state.entryPrice) * directionMult * (state.volume * config.contractValue);
    const notionalAtExit = state.volume * config.contractValue * exitPrice;
    const fee = notionalAtExit * config.takerFee;
    const finalPnl = grossPnl - fee;

    const initialMarginReturned = (state.volume * config.contractValue * state.entryPrice) / config.leverage;
    
    state.availableBalance += (initialMarginReturned + finalPnl);
    state.currentEquity = state.availableBalance;
    market.sessionRealizedProfit += finalPnl;

    logToHistory(accId, state.direction, state.roi, finalPnl, type);

    // Reset account state
    state.volume = 0;
    state.entryPrice = 0;
    state.roi = 0;
    state.unrealizedUsdt = 0;
    state.lastAction = `CLOSED ${type} @ ${exitPrice}`;
}

function updateAccounting() {
    let currentTotalEquity = 0;
    let totalUnrealized = 0;

    Object.values(accountStates).forEach(state => {
        if (state.volume > 0) {
            const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
            const directionMult = state.direction === 'buy' ? 1 : -1;
            
            state.unrealizedUsdt = (currentPrice - state.entryPrice) * directionMult * (state.volume * config.contractValue);
            
            const marginUsed = (state.volume * config.contractValue * state.entryPrice) / config.leverage;
            state.roi = (state.unrealizedUsdt / marginUsed) * 100;

            // Logic check
            if (state.roi >= config.takeProfitPct) virtualClose(state.id, 'TAKE_PROFIT');
            if (state.roi <= -85.0) virtualClose(state.id, 'LIQUIDATED'); 
        }
        
        state.currentEquity = state.availableBalance + (state.unrealizedUsdt || 0);
        totalUnrealized += state.unrealizedUsdt;
        currentTotalEquity += state.currentEquity;
    });

    market.netSessionUsdt = totalUnrealized + market.sessionRealizedProfit;
    market.totalNetGain = currentTotalEquity - market.initialTotalEquity;
}

function logToHistory(accId, direction, roi, pnl, type) {
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        side: `ACC ${accId} ${direction.toUpperCase()}`,
        roi: roi.toFixed(2) + '%',
        pnl: pnl.toFixed(4), 
        type: type
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
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                updateAccounting();
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// Auto-run loop for entries
setInterval(() => {
    if (market.bid === 0) return;
    Object.values(accountStates).forEach(s => { if (s.volume === 0) virtualOpen(s.id); });
}, 2000);

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>DOGE 75x Mock Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #020617; color: #f8fafc; font-family: monospace; }</style></head>
    <body class="p-6"><div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-end mb-6">
            <div>
                <h1 class="text-xl font-bold text-indigo-400 uppercase tracking-widest">DOGE-USDT <span class="text-white">MOCK HEDGE</span></h1>
                <p class="text-[10px] mt-1 font-bold bg-indigo-500/10 text-indigo-500 px-2 py-0.5 rounded border border-indigo-500/20 uppercase">MODE: VIRTUAL (SIMULATING ${detectedAccounts.length} REAL ACCOUNTS)</p>
            </div>
            <div class="text-right">
                <p id="totalNetGain" class="text-2xl font-bold text-white">0.0000 USDT</p>
                <p id="growth" class="text-emerald-500 text-[10px] font-bold">MONITORING LIVE FEED</p>
            </div>
        </div>
        <div id="accountGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-6"></div>
        <div class="bg-slate-900 rounded border border-slate-800 p-4">
            <table class="w-full text-left text-[11px]">
                <thead><tr class="text-slate-600 border-b border-slate-800"><th class="pb-2">Time</th><th class="pb-2">Type</th><th class="pb-2">Target Slot</th><th class="pb-2">ROI</th><th class="pb-2 text-right">Virtual PnL</th></tr></thead>
                <tbody id="historyBody"></tbody>
            </table>
        </div>
    </div>
    <script>
        setInterval(async () => {
            const r = await fetch('/api/status'); const d = await r.json();
            document.getElementById('totalNetGain').innerText = d.market.totalNetGain.toFixed(4) + ' USDT';
            let accHtml = '';
            d.accounts.forEach(a => {
                accHtml += '<div class="bg-slate-950 p-3 border border-slate-800"><div class="flex justify-between items-center mb-1"><span class="text-[9px] bg-slate-800 px-1.5 rounded text-slate-400 font-bold">'+a.label+'</span><span class="text-[9px] font-bold '+(a.direction === "buy" ? "text-emerald-500" : "text-rose-500")+'">'+a.direction.toUpperCase()+'</span></div><p class="text-lg font-bold '+(a.roi >= 0 ? "text-emerald-400" : "text-rose-400")+'">'+a.roi.toFixed(2)+'%</p><p class="text-[10px] text-slate-500 font-bold">ENTRY: '+a.entryPrice.toFixed(5)+'</p><p class="text-[11px] text-slate-200 font-bold">'+a.unrealizedUsdt.toFixed(4)+'</p><div class="mt-2 text-[8px] text-slate-600 font-bold uppercase truncate">'+a.lastAction+'</div></div>';
            });
            document.getElementById('accountGrid').innerHTML = accHtml;
            let hHtml = '';
            d.tradeHistory.forEach(h => {
                const isNeg = h.pnl.startsWith('-');
                hHtml += '<tr class="border-b border-slate-800/50"><td class="py-1 text-slate-600">'+h.time+'</td><td class="font-bold text-indigo-400">'+h.type+'</td><td class="text-slate-400 font-bold">'+h.side+'</td><td class="font-bold text-slate-200">'+h.roi+'</td><td class="text-right font-bold '+(isNeg ? "text-rose-500" : "text-emerald-500")+'">'+h.pnl+'</td></tr>';
            });
            document.getElementById('historyBody').innerHTML = hHtml;
        }, 1000);
    </script></body></html>`);
});

startWS();
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🚀 MOCK ENGINE ONLINE`);
    console.log(`📍 Detected Slots: ${detectedAccounts.length}`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
