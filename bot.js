require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    symbol: 'DOGE-USDT',
    leverage: 20, // DOGE moves fast, higher leverage common for hedging
    port: process.env.PORT || 3000,
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    numAccounts: 50, // Total 50 accounts (25 Long / 25 Short)
    initialPaperBalance: 1000, // $1,000 per paper account
    baseVolume: 500, // 500 DOGE contracts per trade
    winLossRatio: 1.5,
    resetDiffThreshold: 1.2, // Trigger reset at 1.2% difference
    takerFeeRate: 0.0005,
    pollInterval: 1000
};

let market = { 
    bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, initialTotalEquity: config.numAccounts * config.initialPaperBalance,
    status: 'Active'
};

let accountStates = {};
let tradeHistory = [];

// Initialize 50 Paper Accounts
for (let i = 1; i <= config.numAccounts; i++) {
    accountStates[i] = {
        id: i,
        direction: i <= config.numAccounts / 2 ? 'buy' : 'sell', // Half Long, Half Short
        volume: 0,
        entryPrice: 0,
        roi: 0,
        unrealizedUsdt: 0,
        balance: config.initialPaperBalance,
        initialEquity: config.initialPaperBalance,
        lastAction: 'Idle',
        resetUsed: false,
        sessionLoss: 0
    };
}

// ==================== VIRTUAL BROKER (PAPER TRADING) ====================
function executeVirtualOrder(accId, side, type) {
    const state = accountStates[accId];
    const price = side === 'buy' ? market.ask : market.bid;
    const fee = (config.baseVolume * price * config.takerFeeRate);

    if (type === 'open') {
        state.volume = config.baseVolume;
        state.entryPrice = price;
        state.balance -= fee;
        state.lastAction = 'OPENED ' + side.toUpperCase();
    } else {
        // Calculate realized PnL
        const pnl = state.direction === 'buy' 
            ? (price - state.entryPrice) * state.volume 
            : (state.entryPrice - price) * state.volume;
        
        state.balance += (pnl - fee);
        state.volume = 0;
        state.entryPrice = 0;
        state.lastAction = 'CLOSED ' + side.toUpperCase();
        
        logTrade(state.direction, state.roi, pnl, 'PAPER_EXIT');
    }
}

function logTrade(side, roi, pnl, type) {
    tradeHistory.unshift({ 
        time: new Date().toLocaleTimeString(), 
        side: side.toUpperCase(), 
        roi: roi.toFixed(2) + '%', 
        pnl: pnl.toFixed(4), 
        type: type 
    });
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'paper_doge' })));
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                market.spread = ((market.ask - market.bid) / market.bid) * 100;

                // Update All 50 Accounts
                let currentTotalEquity = 0;
                Object.keys(accountStates).forEach(id => {
                    const s = accountStates[id];
                    if (s.volume > 0) {
                        const price = s.direction === 'buy' ? market.bid : market.ask;
                        s.roi = s.direction === 'buy' 
                            ? ((price - s.entryPrice) / s.entryPrice) * config.leverage * 100
                            : ((s.entryPrice - price) / s.entryPrice) * config.leverage * 100;
                        s.unrealizedUsdt = s.direction === 'buy'
                            ? (price - s.entryPrice) * s.volume
                            : (s.entryPrice - price) * s.volume;
                    }
                    currentTotalEquity += (s.balance + s.unrealizedUsdt);
                });
                
                market.totalNetGain = currentTotalEquity - market.initialTotalEquity;

                // Simple Logic: Logic for Pair 1 (Account 1 and 26)
                // In a production environment, you'd loop through pairs
                checkLogic(1, 26); 
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

function checkLogic(longId, shortId) {
    const s1 = accountStates[longId];
    const s2 = accountStates[shortId];

    if (s1.volume === 0 && s2.volume === 0) {
        executeVirtualOrder(longId, 'buy', 'open');
        executeVirtualOrder(shortId, 'sell', 'open');
    }

    // Reset Logic Example for Pair
    const diffSum = Math.max(s1.roi, s2.roi) - (market.spread * config.leverage);
    if (diffSum >= config.resetDiffThreshold && !s1.resetUsed) {
        const loserId = s1.roi < s2.roi ? longId : shortId;
        executeVirtualOrder(loserId, accountStates[loserId].direction === 'buy' ? 'sell' : 'buy', 'close');
        executeVirtualOrder(loserId, accountStates[loserId].direction, 'open');
        accountStates[loserId].resetUsed = true;
    }
}

// ==================== UI DASHBOARD ====================
app.get('/api/status', (req, res) => res.json({ market, accounts: Object.values(accountStates), tradeHistory, config }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head>
    <title>50 Account DOGE Paper Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #020617; color: white; font-family: sans-serif; }
        .acc-card { background: #0f172a; border: 1px solid #1e293b; padding: 10px; border-radius: 8px; font-size: 11px; }
    </style>
</head>
<body class="p-8">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-2xl font-black text-indigo-400">DOGE PAPER-HEDGE CLUSTER</h1>
                <p class="text-slate-400">Simulating 50 Accounts (25 Pairs) on Real-Time Market Data</p>
            </div>
            <div class="text-right">
                <p class="text-sm text-slate-400 font-bold uppercase">Total Net Cluster PnL</p>
                <p id="totalNet" class="text-4xl font-black">$0.00</p>
            </div>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-10 gap-3 mb-8" id="accountGrid">
            <!-- 50 accounts will be injected here -->
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="bg-slate-900 p-6 rounded-xl border border-slate-800">
                <h2 class="font-bold mb-4 uppercase text-slate-500">Live Trade Feed</h2>
                <div id="feed" class="space-y-2 h-64 overflow-y-auto pr-2"></div>
            </div>
            <div class="bg-slate-900 p-6 rounded-xl border border-slate-800">
                <h2 class="font-bold mb-4 uppercase text-slate-500">Market Metrics</h2>
                <div class="space-y-4">
                    <div class="flex justify-between"><span>DOGE Price:</span><span id="price" class="font-mono">0.0000</span></div>
                    <div class="flex justify-between"><span>Market Spread:</span><span id="spread" class="text-rose-400">0.00%</span></div>
                    <div class="flex justify-between"><span>Active Accounts:</span><span>50/50</span></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Create 50 account slots
        const grid = document.getElementById('accountGrid');
        for(let i=1; i<=50; i++) {
            grid.innerHTML += \`<div id="acc-\${i}" class="acc-card">
                <div class="flex justify-between border-b border-slate-800 pb-1 mb-1">
                    <span class="font-bold text-indigo-400">#\${i}</span>
                    <span id="dir-\${i}" class="uppercase"></span>
                </div>
                <div id="roi-\${i}" class="font-black text-lg">0%</div>
                <div id="bal-\${i}" class="text-slate-500">$\${i}</div>
            </div>\`;
        }

        setInterval(async () => {
            const r = await fetch('/api/status');
            const d = await r.json();

            document.getElementById('totalNet').innerText = '$' + d.market.totalNetGain.toFixed(2);
            document.getElementById('totalNet').className = 'text-4xl font-black ' + (d.market.totalNetGain >= 0 ? 'text-emerald-400' : 'text-rose-500');
            document.getElementById('price').innerText = d.market.bid;
            document.getElementById('spread').innerText = d.market.spread.toFixed(4) + '%';

            d.accounts.forEach(a => {
                const card = document.getElementById('acc-' + a.id);
                document.getElementById('roi-' + a.id).innerText = a.roi.toFixed(1) + '%';
                document.getElementById('roi-' + a.id).className = 'font-black text-lg ' + (a.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                document.getElementById('dir-' + a.id).innerText = a.direction;
                document.getElementById('bal-' + a.id).innerText = '$' + (a.balance + a.unrealizedUsdt).toFixed(2);
                
                if(a.roi > 5) card.style.borderColor = '#10b981';
                else if(a.roi < -5) card.style.borderColor = '#f43f5e';
                else card.style.borderColor = '#1e293b';
            });

            const feed = document.getElementById('feed');
            feed.innerHTML = d.tradeHistory.map(h => \`
                <div class="flex justify-between text-[10px] border-b border-slate-800 pb-1">
                    <span class="text-slate-500">\${h.time}</span>
                    <span class="font-bold text-indigo-400">\${h.type}</span>
                    <span class="\${parseFloat(h.roi) > 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold">\${h.roi}</span>
                </div>
            \`).join('');
        }, 1000);
    </script>
</body></html>`);
});

startWS();
app.listen(config.port, '0.0.0.0', () => console.log(`DOGE 50-Account Paper Engine Running on port ${config.port}`));
