const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "t5QJoXcM1J4mZovfiP8G4GcEgZjdyhnZgK8UhpLf4x3GEK0iXH";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 1.2,          
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001  
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: false,
    statusMessage: "Initializing...",
    coin: DEFAULTS.coin,
    profitProtection: { safeBalance: 0 }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        multiplier: DEFAULTS.multiplier,
        payout: DEFAULTS.payout
    },
    betHistory: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (res.data.bitcoin && res.data.bitcoin.usd) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    const calculatedBase = Math.max(1, units) * DEFAULTS.betIncrement;
    return Number(calculatedBase.toFixed(8));
}

const STATE_PATH = process.env.HOME ? `${process.env.HOME}/bot-state.json` : './bot-state.json';

function saveState() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(botState, null, 2)); } catch (e) {}
}

function loadState() {
    if (fs.existsSync(STATE_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATE_PATH));
            botState.profitProtection = data.profitProtection || { safeBalance: 0 };
        } catch(e) {}
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    // alphanumeric only seed
    const randomSuffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
    const safeSeed = "node20" + randomSuffix; 

    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        botState.statusMessage = error.response?.data?.Message || "API Connection Error";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.running = true;
    botState.statusMessage = "Running";

    while (botState.running) {
        // --- HARD PROTECTION CHECK ---
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            botState.running = false;
            botState.statusMessage = "STOPPED: Protected Profit Floor Hit!";
            break;
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.profitProtection.safeBalance += (profit * 0.50); 
            botState.settings.currentBet = botState.settings.baseBet;
        } else {
            botState.stats.losses++;
            // Math.ceil fix for low-amount martingale scaling
            let nextBet = botState.settings.currentBet * botState.settings.multiplier;
            botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date(), bet: result.Bet, roll: result.Roll, 
            profit: profit, isWin: profit > 0, dynamicBase: botState.settings.baseBet
        });
        if (botState.betHistory.length > 50) botState.betHistory.pop();

        saveState();
        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const msPassed = Date.now() - botState.stats.startTime;
    const hoursPassed = Math.max(0.0001, msPassed / (1000 * 60 * 60));
    res.json({
        botState,
        btcPrice,
        tradingBalance: Math.max(0, botState.stats.currentBalance - botState.profitProtection.safeBalance).toFixed(8),
        hoursPassed: hoursPassed.toFixed(2),
        winRate: botState.stats.totalBets > 0 ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1) : "0.0"
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro | Neat Dashboard</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, sans-serif; background-color: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card.accent { border-top: 4px solid var(--accent); }
        .card.danger { border-top: 4px solid var(--danger); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); font-weight: 500; }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); border-bottom: 1px solid var(--border); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 10px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-size: 0.8rem; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v2.0</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div id="status-msg" class="status-bar">Status: Initializing...</div>
        <div class="grid">
            <div class="card accent"><div class="label">🔒 Protected Floor</div><div id="safe-balance" class="btc-val">0.00000000</div><div id="safe-usd" class="usd-val">$0.00</div></div>
            <div class="card danger"><div class="label">💳 Trading Balance</div><div id="trading-balance" class="btc-val" style="color:var(--danger)">0.00000000</div><div id="trading-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="balance" class="btc-val">0.00000000</div><div id="balance-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Session Profit</div><div id="profit" class="btc-val">0.00000000</div><div id="profit-usd" class="usd-val">$0.00</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="win-rate" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Next Bet</div><div id="next-bet" style="font-weight:700; color:var(--accent)">0.00000000</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div id="scaling-base" style="font-weight:700; color:var(--primary)">0.00000000</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        <div class="label">Revenue Projections (Run Rate)</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-btc" class="win" style="font-weight:700">0.00</span><br><span id="p-hr-usd" class="usd-val">$0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-day-btc" class="win" style="font-weight:700">0.00</span><br><span id="p-day-usd" class="usd-val">$0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-month-btc" class="win" style="font-weight:700">0.00</span><br><span id="p-month-usd" class="usd-val">$0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-year-btc" class="win" style="font-weight:700">0.00</span><br><span id="p-year-usd" class="usd-val">$0.00</span></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Status</th></tr></thead>
            <tbody id="history-body"></tbody>
        </table>
    </div>
    <script>
        async function updateStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                const { botState, btcPrice, tradingBalance, hoursPassed, winRate } = data;
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('safe-balance').innerText = f(botState.profitProtection.safeBalance);
                document.getElementById('safe-usd').innerText = u(botState.profitProtection.safeBalance);
                document.getElementById('trading-balance').innerText = tradingBalance;
                document.getElementById('trading-usd').innerText = u(tradingBalance);
                document.getElementById('balance').innerText = f(botState.stats.currentBalance);
                document.getElementById('balance-usd').innerText = u(botState.stats.currentBalance);
                const pr = document.getElementById('profit'); pr.innerText = f(botState.stats.netProfit);
                pr.className = 'btc-val ' + (botState.stats.netProfit >= 0 ? 'win' : 'loss');
                document.getElementById('profit-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('next-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('win-rate').innerText = winRate + "%";
                document.getElementById('scaling-base').innerText = f(botState.settings.baseBet);
                document.getElementById('uptime').innerText = hoursPassed + "h";
                const ph = botState.stats.netProfit / hoursPassed;
                document.getElementById('p-hr-btc').innerText = f(ph); document.getElementById('p-hr-usd').innerText = u(ph);
                document.getElementById('p-day-btc').innerText = f(ph*24); document.getElementById('p-day-usd').innerText = u(ph*24);
                document.getElementById('p-month-btc').innerText = f(ph*24*30); document.getElementById('p-month-usd').innerText = u(ph*24*30);
                document.getElementById('p-year-btc').innerText = f(ph*24*365); document.getElementById('p-year-usd').innerText = u(ph*24*365);
                document.getElementById('history-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td style="color:var(--primary)">\${f(b.dynamicBase)}</td><td>\${f(b.bet)}</td><td>\${b.roll.toFixed(2)}</td><td class="\${b.isWin ? 'win' : 'loss'}">\${b.isWin ? '+' : ''}\${f(b.profit)}</td><td class="\${b.isWin ? 'win' : 'loss'}"><strong>\${b.isWin ? 'WIN' : 'LOSS'}</strong></td></tr>
                \`).join('');
            } catch (e) {}
        }
        setInterval(updateStats, 2000);
    </script>
</body>
</html>
    `);
});

loadState();
app.listen(port, '0.0.0.0', () => runStrategy());
