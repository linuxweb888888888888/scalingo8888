const axios = require('axios');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "QmmX28yULnLF784oJjDMiatV8MPhNAxK2aoKba0sjbwyCJ3PLP";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    maxTotalBetPercent: 0.018, // Slightly increased for compounding
    potSafetyLimit: 0.12,      // 12% safety cap
    baseCooldown: 1050         // Speed optimized for Crypto.Games API
};

// ============ BOT STATE ============
let btcPrice = 60826; 
let botState = {
    running: true,
    statusMessage: "Initializing Advanced Engine...",
    recoveryPot: 0, 
    winStreak: 0,
    coin: DEFAULTS.coin,
    rollValueHistory: [], 
    streakHistory: [],
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
        payout: DEFAULTS.payout,
        clientSeed: "pro" + Math.random().toString(36).substring(2, 12)
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
    let base = Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
    // Profit Compounding: Add 1% of net profit to base if in surplus
    if (botState.stats.netProfit > 0) {
        base += (botState.stats.netProfit * 0.01);
    }
    return Number(base.toFixed(8));
}

function detectCluster() {
    if (botState.rollValueHistory.length < 3) return false;
    const last3 = botState.rollValueHistory.slice(-3);
    const isHighCluster = last3.every(val => val > 70); // Betting Under 50, so >70 is danger
    const isLossStreak = botState.streakHistory.slice(-4).every(val => val === false);
    return isHighCluster || isLossStreak;
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: botState.settings.clientSeed
    };
    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        botState.statusMessage = "API Lag: Retrying...";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    while (true) {
        // SAFETY: Numerical & Streak Detection
        if (detectCluster()) {
            botState.statusMessage = "⚠️ PATTERN ALERT: Shifting Seed & Cooling Down...";
            botState.settings.clientSeed = "pro" + Math.random().toString(36).substring(2, 12);
            botState.streakHistory = [];
            await new Promise(r => setTimeout(r, 6000));
            continue;
        }

        // SAFETY: Pot Cap
        if (botState.recoveryPot > (botState.stats.currentBalance * DEFAULTS.potSafetyLimit)) {
            botState.recoveryPot = 0;
            botState.statusMessage = "Pot Safety Reset Activated";
        }

        const result = await placeBet();
        if (!result) { await new Promise(r => setTimeout(r, 2000)); continue; }

        const currentRoll = parseFloat(result.Roll);
        const profit = result.Profit || 0;
        const isWin = profit > 0;

        // Update Histories
        botState.rollValueHistory.push(currentRoll);
        botState.streakHistory.push(isWin);
        if (botState.rollValueHistory.length > 10) botState.rollValueHistory.shift();
        if (botState.streakHistory.length > 10) botState.streakHistory.shift();

        botState.stats.totalBets++;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (isWin) {
            botState.stats.wins++;
            botState.winStreak++;
            botState.recoveryPot = Math.max(0, botState.recoveryPot - profit);
            botState.statusMessage = botState.winStreak > 2 ? `🔥 WIN STREAK: x${botState.winStreak}` : "Stable Gains";
        } else {
            botState.stats.losses++;
            botState.winStreak = 0;
            botState.recoveryPot += (Math.abs(profit) * 0.85);
            botState.statusMessage = "Recovery Mode Active";
        }

        // ADAPTIVE RECOVERY LOGIC
        // If pot is high, use a safer (larger) divisor. If pot is low, recover fast.
        let dynamicDivisor = botState.recoveryPot > (botState.stats.currentBalance * 0.03) ? 35 : 18;
        
        let recoveryPart = botState.recoveryPot / dynamicDivisor;
        let targetBet = botState.settings.baseBet + recoveryPart;

        // STREAK BOOSTER: If on a 3+ win streak, add 10% to the target bet to compound profit
        if (botState.winStreak >= 3) targetBet *= 1.10;

        let absoluteMax = botState.stats.currentBalance * DEFAULTS.maxTotalBetPercent;
        botState.settings.currentBet = Math.min(targetBet, absoluteMax);

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, bet: result.Bet, roll: currentRoll, 
            profit: profit, isWin: isWin, pot: botState.recoveryPot.toFixed(8)
        });
        if (botState.betHistory.length > 25) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, DEFAULTS.baseCooldown)); 
    }
}

// ============ WEB DASHBOARD (v3.8 Design) ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.01, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v5.0 | Adaptive Profit</title>
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
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; border-left: 5px solid var(--primary); transition: 0.3s; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        .roll-circles { display: flex; gap: 8px; }
        .roll-circle { width: 35px; height: 35px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: bold; background: white; border: 2px solid var(--border); }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v5.0</span></h1>
            <div id="roll-circles" class="roll-circles"></div>
        </div>
        <div class="status-bar" id="status-msg">Adaptive Engine Running...</div>
        <div class="grid">
            <div class="card"><div class="label">Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--danger)">0.00</div><div class="usd-val">Adaptive Divisor</div></div>
            <div class="card"><div class="label">Next Bet</div><div id="n-bet" class="btc-val" style="color:var(--primary)">0.00</div><div id="uptime" class="usd-val">0h</div></div>
        </div>
        <div class="label">Revenue Projections</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00</span></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Recovery Pot</th></tr></thead>
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
                
                const statusEl = document.getElementById('status-msg');
                statusEl.innerText = "Status: " + botState.statusMessage;
                statusEl.style.borderLeftColor = botState.winStreak >= 3 ? "#10b981" : "#2563eb";

                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-prof').className = botState.stats.netProfit >= 0 ? 'btc-val win' : 'btc-val loss';
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('uptime').innerText = "Uptime: " + hoursPassed + "h";

                const ph = botState.stats.netProfit / hoursPassed;
                document.getElementById('p-hr-b').innerText = f(ph);
                document.getElementById('p-dy-b').innerText = f(ph*24);
                document.getElementById('p-month-b').innerText = f(ph*24*30);
                document.getElementById('p-year-b').innerText = f(ph*24*365);

                const rolls = botState.rollValueHistory.slice(-6).reverse();
                document.getElementById('roll-circles').innerHTML = rolls.map(r => \`
                    <div class="roll-circle" style="border-color: \${r < 49.5 ? '#10b981' : '#ef4444'}">\${Math.floor(r)}</div>
                \`).join('');

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td>\${f(b.bet)}</td><td>\${b.roll}</td><td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td><td>\${b.pot} BTC</td></tr>
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
