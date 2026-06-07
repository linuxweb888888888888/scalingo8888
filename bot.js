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
    multiplier: 1.1,          
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001  
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: true,
    isPaused: false,
    nextResumeTime: 0,
    statusMessage: "Initializing...",
    coin: DEFAULTS.coin,
    profitProtection: { safeBalance: 0 }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0, // Highest profit reached
        pullbackPercent: 0,  // Drop from maxSessionProfit
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

const STATE_PATH = './bot-state.json';
function saveState() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(botState, null, 2)); } catch (e) {}
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "node20" + Math.random().toString(36).substring(0, 10); 

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
    botState.statusMessage = "Running Strategy...";
    
    while (true) {
        // 1. HARD FLOOR PROTECTION
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

        // --- PULLBACK CALCULATION ---
        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        if (botState.stats.maxSessionProfit > 0 && botState.stats.netProfit < botState.stats.maxSessionProfit) {
            const drop = botState.stats.maxSessionProfit - botState.stats.netProfit;
            botState.stats.pullbackPercent = (drop / botState.stats.maxSessionProfit) * 100;

            // Trigger 60s pause if drop is 20% or more
            if (botState.stats.pullbackPercent >= 20) {
                botState.isPaused = true;
                botState.nextResumeTime = Date.now() + 60000;
                botState.statusMessage = `PULLBACK GUARD: Pausing 60s (${botState.stats.pullbackPercent.toFixed(1)}% Drop)`;
                
                // Reset max profit so we track the "new" climb after pause
                botState.stats.maxSessionProfit = botState.stats.netProfit;
                
                await new Promise(r => setTimeout(r, 60000));
                
                botState.isPaused = false;
                botState.statusMessage = "Resuming after Pullback...";
            }
        } else {
            botState.stats.pullbackPercent = 0;
        }

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.profitProtection.safeBalance += (profit * 0.50); 
            botState.settings.currentBet = botState.settings.baseBet;
        } else {
            botState.stats.losses++;
            let nextBet = botState.settings.currentBet * botState.settings.multiplier;
            botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), bet: result.Bet, roll: result.Roll, 
            profit: profit, isWin: profit > 0, pb: botState.stats.pullbackPercent.toFixed(1)
        });
        if (botState.betHistory.length > 50) botState.betHistory.pop();

        saveState();
        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hoursPassed = Math.max(0.0001, (Date.now() - botState.stats.startTime) / (1000 * 60 * 60));
    const pauseTimer = botState.isPaused ? Math.max(0, Math.round((botState.nextResumeTime - Date.now()) / 1000)) : 0;

    res.json({
        botState,
        btcPrice,
        tradingBalance: Math.max(0, botState.stats.currentBalance - botState.profitProtection.safeBalance).toFixed(8),
        hoursPassed: hoursPassed.toFixed(2),
        winRate: botState.stats.totalBets > 0 ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1) : "0.0",
        pauseTimer
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro | Pullback Logic</title>
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
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); border-bottom: 1px solid var(--border); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { display: flex; justify-content: space-between; padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-size: 0.85rem; font-weight: bold; }
        .timer-badge { background: var(--danger); padding: 2px 8px; border-radius: 4px; display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v2.3</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div class="status-bar">
            <div id="status-msg">Status: Initializing...</div>
            <div id="pause-container">Pause Timer: <span id="pause-timer" class="timer-badge">0s</span></div>
        </div>
        <div class="grid">
            <div class="card accent"><div class="label">📈 Peak Profit (Session)</div><div id="peak-profit" class="btc-val">0.00000000</div><div id="pullback-info" class="usd-val" style="color:var(--danger)">Pullback: 0%</div></div>
            <div class="card danger"><div class="label">💳 Trading Balance</div><div id="trading-balance" class="btc-val" style="color:var(--danger)">0.00000000</div><div id="trading-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="balance" class="btc-val">0.00000000</div><div id="balance-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Net Profit</div><div id="profit" class="btc-val">0.00000000</div><div id="profit-usd" class="usd-val">$0.00</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="win-rate" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Next Bet</div><div id="next-bet" style="font-weight:700; color:var(--accent)">0.00000000</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div id="scaling-base" style="font-weight:700; color:var(--primary)">0.00000000</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Pullback</th></tr></thead>
            <tbody id="history-body"></tbody>
        </table>
    </div>
    <script>
        async function updateStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                const { botState, btcPrice, tradingBalance, hoursPassed, winRate, pauseTimer } = data;
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('status-msg').innerText = botState.statusMessage;
                
                const timerEl = document.getElementById('pause-timer');
                if(pauseTimer > 0) {
                    timerEl.style.display = 'inline';
                    timerEl.innerText = pauseTimer + "s";
                } else {
                    timerEl.style.display = 'none';
                }

                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('peak-profit').innerText = f(botState.stats.maxSessionProfit);
                document.getElementById('pullback-info').innerText = "Current Pullback: " + botState.stats.pullbackPercent.toFixed(2) + "%";
                document.getElementById('trading-balance').innerText = tradingBalance;
                document.getElementById('trading-usd').innerText = u(tradingBalance);
                document.getElementById('balance').innerText = f(botState.stats.currentBalance);
                document.getElementById('balance-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('profit').innerText = f(botState.stats.netProfit);
                document.getElementById('profit-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('next-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('win-rate').innerText = winRate + "%";
                document.getElementById('scaling-base').innerText = f(botState.settings.baseBet);
                document.getElementById('uptime').innerText = hoursPassed + "h";
                document.getElementById('history-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td>\${f(b.bet)}</td><td>\${f(b.bet)}</td><td>\${b.roll.toFixed(2)}</td><td class="\${b.isWin ? 'win' : 'loss'}">\${f(b.profit)}</td><td>\${b.pb}%</td></tr>
                \`).join('');
            } catch (e) {}
        }
        setInterval(updateStats, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    runStrategy();
});
