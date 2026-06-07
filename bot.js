const axios = require('axios');
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "UVExTjmfxuBlLifKBhXuUGaWRXDFKJ74N5Qsp3N6xDHtPnQv3L";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    // MODERATOR SETTINGS
    maxBetPercentOfBalance: 0.05, // Never bet more than 5% of trading balance
    emergencyResetMult: 50        // If bet > 50x Base, reset bet to base (but keep pot)
};

// ============ BOT STATE ============
let btcPrice = 60000; 
let botState = {
    running: true,
    statusMessage: "Moderator Active...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0,
        lockPercent: 0.80 
    }, 
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
    const safeSeed = "mod" + Math.random().toString(36).substring(2, 12); 

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

// ============ MODERATOR LOGIC ============
function moderateBet() {
    const tradingBalance = botState.stats.currentBalance - botState.profitProtection.safeBalance;
    const maxAllowed = tradingBalance * DEFAULTS.maxBetPercentOfBalance;
    const isTooHigh = botState.settings.currentBet > (botState.settings.baseBet * DEFAULTS.emergencyResetMult);

    // If bet exceeds 5% of trading balance OR hits the multiplier cap
    if (botState.settings.currentBet > maxAllowed || isTooHigh) {
        botState.statusMessage = "MODERATOR: Soft Reset (Bet too high)";
        botState.settings.currentBet = botState.settings.baseBet; // Drop back to safety
        // Notice: We do NOT reset recoveryPot. We just take longer to recover.
        return true;
    }
    return false;
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    while (true) {
        // Floor Protection
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            botState.statusMessage = "SAFE FLOOR HIT: Locking Profits...";
            botState.recoveryPot = 0;
            botState.settings.currentBet = calculateScaledBase(botState.stats.currentBalance);
            await new Promise(r => setTimeout(r, 5000));
            continue; 
        }

        // Apply Moderator
        moderateBet();

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.currentBalance = result.Balance || 0;
        botState.stats.netProfit += profit;

        // Initialize Safe Balance on first run
        if(botState.stats.totalBets === 1) botState.profitProtection.safeBalance = botState.stats.currentBalance * 0.95;

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.recoveryPot = Math.max(0, botState.recoveryPot - profit);

            if (botState.recoveryPot === 0) {
                botState.settings.currentBet = botState.settings.baseBet;
                botState.profitProtection.safeBalance += (profit * botState.profitProtection.lockPercent);
                botState.statusMessage = "Stable - Profit Locked";
            } else {
                botState.statusMessage = "Recovering Loss...";
            }
        } else {
            botState.stats.losses++;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.currentBet += DEFAULTS.betIncrement;
            botState.statusMessage = "Losing Streak: Moderating...";
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), 
            bet: result.Bet, roll: result.Roll, profit: profit, isWin: profit > 0, 
            pot: botState.recoveryPot.toFixed(8)
        });
        if (botState.betHistory.length > 25) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ WEB DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dice Pro v3.4 | Moderated</title>
    <style>
        :root { --primary: #3b82f6; --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --success: #10b981; --danger: #ef4444; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .card { background: var(--card); padding: 20px; border-radius: 10px; border-left: 4px solid var(--primary); }
        .status-bar { background: #334155; padding: 15px; border-radius: 8px; margin-bottom: 20px; font-weight: bold; border-left: 4px solid gold; }
        table { width: 100%; margin-top: 20px; border-collapse: collapse; }
        th { text-align: left; color: #94a3b8; font-size: 12px; padding: 10px; }
        td { padding: 10px; border-bottom: 1px solid #334155; font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .label { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
        .val { font-size: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Dice Pro <span style="color:var(--primary)">v3.4 Moderated</span></h1>
    <div class="status-bar" id="status">Status: Loading...</div>
    
    <div class="grid">
        <div class="card"><div class="label">Net Profit</div><div id="profit" class="val">0.00</div></div>
        <div class="card"><div class="label">Recovery Pot</div><div id="pot" class="val" style="color:var(--primary)">0.00</div></div>
        <div class="card"><div class="label">Safe Wallet</div><div id="safe" class="val" style="color:var(--success)">0.00</div></div>
        <div class="card"><div class="label">Next Bet</div><div id="bet" class="val" style="color:orange">0.00</div></div>
    </div>

    <table>
        <thead><tr><th>ID</th><th>Wager</th><th>Result</th><th>Profit</th><th>Pot Remaining</th></tr></thead>
        <tbody id="history"></tbody>
    </table>

    <script>
        async function refresh() {
            const r = await fetch('/api/stats');
            const { botState, btcPrice } = await r.json();
            document.getElementById('status').innerText = "SYSTEM: " + botState.statusMessage;
            document.getElementById('profit').innerText = botState.stats.netProfit.toFixed(8) + " BTC";
            document.getElementById('pot').innerText = botState.recoveryPot.toFixed(8) + " BTC";
            document.getElementById('safe').innerText = botState.profitProtection.safeBalance.toFixed(8) + " BTC";
            document.getElementById('bet').innerText = botState.settings.currentBet.toFixed(8);
            
            document.getElementById('history').innerHTML = botState.betHistory.map(b => \`
                <tr>
                    <td>#\${b.id}</td>
                    <td>\${b.bet.toFixed(8)}</td>
                    <td>\${b.roll}</td>
                    <td class="\${b.isWin?'win':'loss'}">\${b.profit.toFixed(8)}</td>
                    <td>\${b.pot}</td>
                </tr>
            \`).join('');
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => runStrategy());
