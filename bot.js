const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "5jlqTCMf66b6kYwuXatwNh54Fym7tm1UkYM8Cn6hCkwfLLpOP1";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    pullbackTriggerPercent: 16.67, // (0.00000002 / 0.00000012)
    recoveryBuffer: 0.00000002     // The "room" you requested
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    isPaused: false,
    nextResumeTime: 0,
    statusMessage: "Initializing...",
    recoveryPot: 0, // Sum of absolute losses
    bufferRatio: 0, // % of buffer vs recovery pot
    coin: DEFAULTS.coin,
    profitProtection: { safeBalance: 0 }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0, 
        pullbackPercent: 0,  
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout
    },
    betHistory: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (res.data.bitcoin) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    return Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
}

function resetSession() {
    botState.statusMessage = "REBOOTING: Floor Hit.";
    botState.profitProtection.safeBalance = 0;
    botState.recoveryPot = 0;
    botState.stats = {
        totalBets: 0, wins: 0, losses: 0, netProfit: 0,
        maxSessionProfit: 0, pullbackPercent: 0,
        currentBalance: botState.stats.currentBalance,
        startTime: Date.now()
    };
    botState.betHistory = [];
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "seed" + Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 12); 

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        botState.statusMessage = error.response?.data?.Message || "API Error";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.statusMessage = "Active";
    
    while (true) {
        // Floor Reboot
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            resetSession();
            await new Promise(r => setTimeout(r, 2000));
            continue; 
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

        // --- PULLBACK GUARD ---
        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }
        if (botState.stats.maxSessionProfit > 0) {
            const drop = botState.stats.maxSessionProfit - botState.stats.netProfit;
            botState.stats.pullbackPercent = (drop / botState.stats.maxSessionProfit) * 100;

            if (botState.stats.pullbackPercent >= DEFAULTS.pullbackTriggerPercent) {
                botState.isPaused = true;
                botState.nextResumeTime = Date.now() + 60000;
                botState.statusMessage = "Resuming Activity...";
                botState.stats.maxSessionProfit = botState.stats.netProfit; 
                await new Promise(r => setTimeout(r, 60000));
                botState.isPaused = false;
            }
        }

        // --- RECOVERY & BET LOGIC ---
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.recoveryPot = 0; // Clear recovery pot on win
            botState.bufferRatio = 0;
            botState.profitProtection.safeBalance += (profit * 0.50); 
            botState.settings.currentBet = botState.settings.baseBet;
        } else {
            botState.stats.losses++;
            // Take absolute value of the loss and add to sum
            botState.recoveryPot += Math.abs(profit);
            
            // Calculate % ratio of the 0.00000002 buffer vs the current recovery pot
            botState.bufferRatio = (DEFAULTS.recoveryBuffer / botState.recoveryPot) * 100;
            
            // Next bet = Sum of losses + 0.00000002
            botState.settings.currentBet = botState.recoveryPot + DEFAULTS.recoveryBuffer;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), 
            bet: result.Bet, roll: result.Roll, profit: profit, isWin: profit > 0, 
            pb: botState.stats.pullbackPercent.toFixed(2), pot: botState.recoveryPot.toFixed(8)
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const pauseTimer = botState.isPaused ? Math.max(0, Math.round((botState.nextResumeTime - Date.now()) / 1000)) : 0;
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2), pauseTimer });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v2.8</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { display: flex; justify-content: space-between; padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v2.8</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div class="status-bar">
            <div id="status-msg">Status: Initializing...</div>
            <div id="p-cont" style="display:none">Cooldown: <span id="p-timer">0s</span></div>
        </div>
        <div class="grid">
            <div class="card"><div class="label">📈 Peak Profit</div><div id="peak-profit" class="btc-val">0.00</div><div class="usd-val">Trigger: 16.67%</div></div>
            <div class="card"><div class="label">💳 Trading Balance</div><div id="t-bal" class="btc-val" style="color:var(--danger)">0.00</div><div id="t-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Buffer/Pot Ratio</div><div id="ratio" style="font-weight:700; color:var(--accent)">0%</div></div>
            <div class="mini-card"><div class="label">Recovery Pot</div><div id="pot" style="font-weight:700; color:var(--primary)">0.00</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        <div class="label">Revenue Projections</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span><br><span id="p-hr-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span><br><span id="p-dy-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-mo-b" class="win">0.00</span><br><span id="p-mo-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-yr-b" class="win">0.00</span><br><span id="p-yr-u" class="usd-val">0.00</span></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Pot Sum</th><th>PB</th></tr></thead>
            <tbody id="h-body"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const { botState, btcPrice, hoursPassed, pauseTimer } = await res.json();
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3});
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('peak-profit').innerText = f(botState.stats.maxSessionProfit);
                document.getElementById('t-bal').innerText = f(botState.stats.currentBalance - botState.profitProtection.safeBalance);
                document.getElementById('t-usd').innerText = u(botState.stats.currentBalance - botState.profitProtection.safeBalance);
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('wr').innerText = ((botState.stats.wins/botState.stats.totalBets)*100 || 0).toFixed(1) + "%";
                document.getElementById('ratio').innerText = botState.bufferRatio.toFixed(2) + "%";
                document.getElementById('pot').innerText = f(botState.recoveryPot);
                document.getElementById('uptime').innerText = hoursPassed + "h";
                const ph = botState.stats.netProfit / hoursPassed;
                document.getElementById('p-hr-b').innerText = f(ph); document.getElementById('p-hr-u').innerText = u(ph);
                document.getElementById('p-dy-b').innerText = f(ph*24); document.getElementById('p-dy-u').innerText = u(ph*24);
                document.getElementById('p-mo-b').innerText = f(ph*24*30); document.getElementById('p-mo-u').innerText = u(ph*24*30);
                document.getElementById('p-yr-b').innerText = f(ph*24*365); document.getElementById('p-yr-u').innerText = u(ph*24*365);
                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td>\${f(b.bet)}</td><td>\${b.roll}</td><td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td><td>\${b.pot}</td><td>\${b.pb}%</td></tr>
                \`).join('');
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => runStrategy());
