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
    balanceStep: 0.00000010,  
    betIncrement: 0.00000001,
    maxTotalBetPercent: 0.06,  // Increased to 6% for aggressive small-balance recovery
    potSafetyLimit: 0.25,      // 25% Safety Cap
    baseCooldown: 1050         
};

// ============ BOT STATE ============
let btcPrice = 60826; 
let botState = {
    running: true,
    statusMessage: "Dual-Side Engine: Analyzing Trends",
    recoveryPot: 0, 
    winStreak: 0,
    betUnder: true, // true = UNDER, false = OVER
    seedShifts: 0,
    coin: DEFAULTS.coin,
    rollValueHistory: [], 
    streakHistory: [],
    stats: {
        totalBets: 0, wins: 0, losses: 0, netProfit: 0,
        currentBalance: 0, startTime: Date.now(),
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
    // Aggressive Growth: 6% of session profit added to base
    if (botState.stats.netProfit > 0) {
        base += (botState.stats.netProfit * 0.06);
    }
    return Math.max(0.00000001, Number(base.toFixed(8)));
}

// Logic to decide whether to switch UNDER or OVER
function updateBettingSide() {
    if (botState.rollValueHistory.length < 3) return;
    
    const last3Rolls = botState.rollValueHistory.slice(-3);
    const avg = last3Rolls.reduce((a, b) => a + b, 0) / 3;

    // Trend Following: 
    // If average is high, switch to OVER (false). If low, switch to UNDER (true).
    if (avg > 55 && botState.betUnder === true) {
        botState.betUnder = false;
        botState.statusMessage = "🔄 TREND SHIFT: Switching to OVER";
    } else if (avg < 45 && botState.betUnder === false) {
        botState.betUnder = true;
        botState.statusMessage = "🔄 TREND SHIFT: Switching to UNDER";
    }
}

function detectDangerZone() {
    if (botState.streakHistory.length < 4) return false;
    // Trigger seed shift if 4 losses in a row
    return botState.streakHistory.slice(-4).every(val => val === false);
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: botState.betUnder, 
        ClientSeed: botState.settings.clientSeed
    };
    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { return null; }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    while (true) {
        updateBettingSide();

        if (detectDangerZone()) {
            botState.settings.clientSeed = "pro" + Math.random().toString(36).substring(2, 12);
            botState.seedShifts++;
            botState.streakHistory = [];
            botState.statusMessage = "⚠️ STREAK ALERT: Shifting Seed...";
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 1000)); 
            continue; 
        }

        const currentRoll = parseFloat(result.Roll);
        const profit = result.Profit || 0;
        const isWin = profit > 0;

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
            if (!botState.statusMessage.includes('🔄')) {
                botState.statusMessage = "Profit Extracting...";
            }
        } else {
            botState.stats.losses++;
            botState.winStreak = 0;
            // RECOVERY BOOST: 135% Recovery Surge
            botState.recoveryPot += (Math.abs(profit) * 1.35);
            botState.statusMessage = "Hyper-Recovery Active";
        }

        // TIERED AGGRESSIVE DIVISORS
        let divisor = 3.5; 
        if (botState.recoveryPot > botState.stats.currentBalance * 0.05) divisor = 7.0;
        if (botState.recoveryPot > botState.stats.currentBalance * 0.12) divisor = 12.0; 

        let recoveryPart = botState.recoveryPot / divisor;
        let targetBet = botState.settings.baseBet + recoveryPart;

        // WIN COMPOUNDING (Profit Booster)
        if (botState.winStreak >= 2) targetBet *= 1.30; 

        let absoluteMax = botState.stats.currentBalance * DEFAULTS.maxTotalBetPercent;
        botState.settings.currentBet = Math.min(targetBet, absoluteMax);

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, bet: result.Bet, roll: currentRoll, 
            profit: profit, isWin: isWin, pot: botState.recoveryPot.toFixed(8),
            side: botState.betUnder ? "UNDER" : "OVER"
        });
        if (botState.betHistory.length > 25) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, DEFAULTS.baseCooldown)); 
    }
}

// ============ WEB DASHBOARD ============
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
    <title>Dice Pro v8.0 | Dual-Side Apex</title>
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
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; border-left: 5px solid var(--primary); }
        .roll-circles { display: flex; gap: 8px; }
        .roll-circle { width: 35px; height: 35px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: bold; background: white; border: 2px solid var(--border); }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .side-badge { padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; background: #e2e8f0; color: #1e293b; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v8.0 Dual-Side</span></h1>
            <div id="roll-circles" class="roll-circles"></div>
        </div>
        <div class="status-bar" id="status-msg">Analyzing Market Patterns...</div>
        <div class="grid">
            <div class="card"><div class="label">Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--danger)">0.00</div><div id="current-side" class="usd-val" style="color:var(--primary); font-weight:bold;">SIDE: UNDER</div></div>
            <div class="card"><div class="label">Next Wager</div><div id="n-bet" class="btc-val" style="color:var(--primary)">0.00</div><div id="uptime" class="usd-val">Uptime: 0h</div></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Side</th><th>Wager</th><th>Roll</th><th>Profit</th><th>Pot</th></tr></thead>
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
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-prof').className = botState.stats.netProfit >= 0 ? 'btc-val win' : 'btc-val loss';
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                document.getElementById('current-side').innerText = "SIDE: " + (botState.betUnder ? "UNDER" : "OVER");
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('uptime').innerText = "Uptime: " + hoursPassed + "h | Shifts: " + botState.seedShifts;

                const rolls = botState.rollValueHistory.slice(-6).reverse();
                document.getElementById('roll-circles').innerHTML = rolls.map(r => \`
                    <div class="roll-circle" style="border-color: \${r < 50 ? '#10b981' : '#ef4444'}">\${Math.floor(r)}</div>
                \`).join('');

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr>
                        <td>#\${b.id}</td>
                        <td><span class="side-badge">\${b.side}</span></td>
                        <td>\${f(b.bet)}</td>
                        <td>\${b.roll}</td>
                        <td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td>
                        <td>\${b.pot}</td>
                    </tr>
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
