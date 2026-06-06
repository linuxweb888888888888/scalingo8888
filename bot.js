const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION (1.2x HIGH WIN-RATE) ============
const API_KEY = process.env.API_KEY || "QmmX28yULnLF784oJjDMiatV8MPhNAxK2aoKba0sjbwyCJ3PLP";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 1.2,               // 82.5% Win Rate
    balanceStep: 0.00000500,   // Conservative scaling for low payout
    betIncrement: 0.00000001,
    recoveryDivisor: 40,       // IMPORTANT: Debt spread over 40 wins to stay safe
    maxTotalBetPercent: 0.01,  // SAFETY: Max bet 1% of balance
    potSafetyLimit: 0.05       // SAFETY: Reset if debt exceeds 5% of balance
};

// ============ BOT STATE ============
let btcPrice = 60826; 
let botState = {
    running: true,
    statusMessage: "Initializing...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    currentSeed: "pro" + Math.random().toString(36).substring(2, 12),
    betsSinceSeedChange: 0,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
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

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    // Switch sides every bet to increase randomness coverage
    const side = botState.stats.totalBets % 2 === 0;

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: side, 
        ClientSeed: botState.currentSeed 
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
    botState.statusMessage = "Ultra-High Win Rate Mode Active (82%)";
    
    while (true) {
        // --- SEED ROTATION (Every 10 Bets) ---
        if (botState.betsSinceSeedChange >= 10) {
            botState.currentSeed = "pro" + Math.random().toString(36).substring(2, 12);
            botState.betsSinceSeedChange = 0;
        }

        // SAFETY: If pot hits 5% of balance, it's too dangerous. Reset.
        if (botState.recoveryPot > (botState.stats.currentBalance * DEFAULTS.potSafetyLimit)) {
            botState.statusMessage = "CRITICAL SAFETY: Debt Pot Reset to Save Balance.";
            botState.recoveryPot = 0;
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        botState.betsSinceSeedChange++;
        
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
        } else {
            botState.stats.losses++;
            // 1.2x Math: We add 98% of loss to pot for recovery
            botState.recoveryPot += (Math.abs(profit) * 0.98);
        }

        // --- 1.2x RECOVERY CALCULATION ---
        // At 1.2x payout, we profit only 0.2 units per 1 unit wagered.
        // Therefore, to clear 1 unit of debt, we must wager 5 units.
        let recoveryTargetPerWin = botState.recoveryPot / DEFAULTS.recoveryDivisor;
        let additionalWager = recoveryTargetPerWin / 0.2; 
        
        let targetBet = botState.settings.baseBet + additionalWager;

        // Hard safety cap (1% of balance) to prevent account liquidation
        let absoluteMax = botState.stats.currentBalance * DEFAULTS.maxTotalBetPercent;
        botState.settings.currentBet = Math.min(targetBet, absoluteMax);

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), 
            bet: result.Bet, roll: result.Roll, profit: profit, isWin: profit > 0, 
            pot: botState.recoveryPot.toFixed(8), dBase: botState.settings.baseBet
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        // Optimized speed for 1.2x volume
        await new Promise(r => setTimeout(r, 850)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v3.8 | Ultra-High Win Rate</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
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
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v3.8</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div class="status-bar" id="status-msg">Status: Initializing...</div>
        <div class="grid">
            <div class="card"><div class="label">💳 Safe Tradable</div><div id="t-bal" class="btc-val" style="color:var(--primary)">0.00</div><div id="t-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--danger)">0.00</div><div class="usd-val">Capped at 1% Bal</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00</div></div>
            <div class="mini-card"><div class="label">Next Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        <div class="label">Revenue Projections</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span><br><span id="p-hr-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span><br><span id="p-dy-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00</span><br><span id="p-month-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00</span><br><span id="p-year-u" class="usd-val">0.00</span></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Pot Left</th></tr></thead>
            <tbody id="h-body"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const { botState, btcPrice, hoursPassed } = await res.json();
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('t-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('t-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                document.getElementById('wr').innerText = ((botState.stats.wins/botState.stats.totalBets)*100 || 0).toFixed(1) + "%";
                document.getElementById('s-base').innerText = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('uptime').innerText = hoursPassed + "h";

                const ph = botState.stats.netProfit / hoursPassed;
                document.getElementById('p-hr-b').innerText = f(ph); document.getElementById('p-hr-u').innerText = u(ph);
                document.getElementById('p-dy-b').innerText = f(ph*24); document.getElementById('p-dy-u').innerText = u(ph*24);
                document.getElementById('p-month-b').innerText = f(ph*24*30); document.getElementById('p-month-u').innerText = u(ph*24*30);
                document.getElementById('p-year-b').innerText = f(ph*24*365); document.getElementById('p-year-u').innerText = u(ph*24*365);

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td>\${f(b.dBase)}</td><td>\${f(b.bet)}</td><td>\${b.roll}</td><td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td><td>\${b.pot} BTC</td></tr>
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
