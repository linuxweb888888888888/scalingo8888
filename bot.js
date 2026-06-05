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
    multiplier: 1.2,
    payout: 2.0,
    balanceStep: 0.00000050,
    betIncrement: 0.00000001,
    predictionWait: 3 // "Prediction": Wait for 3 Virtual Losses before betting real money
};

// ============ BOT STATE ============
let btcPrice = 65000;
let botState = {
    running: false,
    isGhosting: true, // Start in Ghost Mode (Virtual Betting)
    virtualLossStreak: 0,
    statusMessage: "Sensing trends...",
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
    return Math.max(1, units) * DEFAULTS.betIncrement;
}

// ============ API LOGIC ============
async function placeBet(isReal) {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const randomSuffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
    
    // If Ghosting, we bet 0 to "sense" the roll without losing money
    const betAmount = isReal ? botState.settings.currentBet : 0;

    const payload = { 
        Bet: betAmount, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: "node20" + randomSuffix 
    };

    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        botState.statusMessage = "API Error: " + (error.response?.data?.Message || "Offline");
        return null; 
    }
}

// ============ STRATEGY ============
async function runStrategy() {
    botState.running = true;

    while (botState.running) {
        // Protection Floor
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            botState.running = false;
            botState.statusMessage = "STOPPED: Floor Hit";
            break;
        }

        // Place Bet (Ghost or Real)
        const result = await placeBet(!botState.isGhosting);
        if (!result) { await new Promise(r => setTimeout(r, 5000)); continue; }

        const profit = result.Profit || 0;
        botState.stats.currentBalance = result.Balance || 0;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0 || (botState.isGhosting && result.Roll < 49.5)) {
            // WIN CASE
            if (!botState.isGhosting) {
                botState.stats.wins++;
                botState.stats.netProfit += profit;
                botState.profitProtection.safeBalance += (profit * 0.50);
            }
            
            botState.isGhosting = true; // Switch back to Ghost Mode after a win
            botState.virtualLossStreak = 0;
            botState.settings.currentBet = botState.settings.baseBet;
            botState.statusMessage = "Win! Sensing next trend...";
        } else {
            // LOSS CASE
            if (!botState.isGhosting) {
                botState.stats.losses++;
                botState.stats.netProfit += profit;
                let nextBet = botState.settings.currentBet * botState.settings.multiplier;
                botState.settings.currentBet = Math.ceil(nextBet * 1e8) / 1e8;
            } else {
                botState.virtualLossStreak++;
                botState.statusMessage = `Virtual Loss Streak: ${botState.virtualLossStreak}`;
                
                // PREDICTION TRIGGER: If we hit X losses, start betting REAL money
                if (botState.virtualLossStreak >= DEFAULTS.predictionWait) {
                    botState.isGhosting = false;
                    botState.statusMessage = "Prediction active! Betting Real BTC...";
                }
            }
        }

        botState.stats.totalBets++;
        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date(), bet: result.Bet, roll: result.Roll, 
            profit: profit, isWin: (profit > 0 || (botState.isGhosting && result.Roll < 49.5)),
            mode: botState.isGhosting ? "GHOST" : "REAL"
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX ENDPOINTS ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><title>Dice Pro | Prediction Ghost</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        body { font-family: sans-serif; background: var(--bg); padding: 2rem; color: var(--text-main); }
        .container { max-width: 1200px; margin: 0 auto; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 10px; text-transform: uppercase; color: #64748b; }
        .btc { font-size: 1.5rem; font-weight: bold; display: block; }
        .usd { font-size: 12px; color: var(--accent); }
        .status { padding: 10px; background: #1e293b; color: white; border-radius: 6px; margin-bottom: 20px; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        th { text-align: left; background: #f1f5f9; padding: 10px; font-size: 11px; }
        td { padding: 10px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 13px; }
        .ghost-row { background: #fffbeb; }
        .win { color: var(--success); } .loss { color: var(--danger); }
    </style>
</head>
<body>
    <div class="container">
        <div style="display:flex; justify-content:space-between">
            <h1>Dice Pro <span style="color:var(--primary)">Ghost Prediction</span></h1>
            <div id="price">...</div>
        </div>
        <div id="status" class="status">Initial Sensing...</div>
        <div class="grid">
            <div class="card"><div class="label">🔒 Safe Floor</div><span id="safe" class="btc">0.00</span><span id="safe-usd" class="usd"></span></div>
            <div class="card"><div class="label">💰 Balance</div><span id="bal" class="btc">0.00</span><span id="bal-usd" class="usd"></span></div>
            <div class="card"><div class="label">📈 Profit</div><span id="prof" class="btc">0.00</span><span id="prof-usd" class="usd"></span></div>
            <div class="card"><div class="label">🎯 Next Bet</div><span id="next" class="btc">0.00</span><span id="next-usd" class="usd"></span></div>
        </div>
        <table id="logs">
            <thead><tr><th>ID</th><th>MODE</th><th>WAGER</th><th>ROLL</th><th>PROFIT</th></tr></thead>
            <tbody id="tbody"></tbody>
        </table>
    </div>
    <script>
        async function up() {
            const r = await fetch('/api/stats'); const d = await r.json();
            const b = d.botState; const p = d.btcPrice;
            const fmt = (n) => parseFloat(n).toFixed(8);
            const usd = (n) => "$" + (n * p).toFixed(2);
            document.getElementById('status').innerText = "STATUS: " + b.statusMessage;
            document.getElementById('price').innerText = "BTC: $" + p.toLocaleString();
            document.getElementById('safe').innerText = fmt(b.profitProtection.safeBalance);
            document.getElementById('bal').innerText = fmt(b.stats.currentBalance);
            document.getElementById('prof').innerText = fmt(b.stats.netProfit);
            document.getElementById('next').innerText = b.isGhosting ? "WAITING..." : fmt(b.settings.currentBet);
            
            document.getElementById('tbody').innerHTML = b.betHistory.map(h => \`
                <tr class="\${h.mode === 'GHOST' ? 'ghost-row' : ''}">
                    <td>#\${h.id}</td>
                    <td><b style="color:\${h.mode==='REAL'?'#2563eb':'#f59e0b'}">\${h.mode}</b></td>
                    <td>\${fmt(h.bet)}</td>
                    <td>\${h.roll.toFixed(2)}</td>
                    <td class="\${h.isWin?'win':'loss'}">\${h.isWin?'+':''}\${fmt(h.profit)}</td>
                </tr>\`).join('');
        }
        setInterval(up, 2000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => runStrategy());
