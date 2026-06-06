const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "uVGG7F3K9Lib69b8H7g216G932YUwCp4M1A7fJfWhNJ9VcMGwg";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    maxBetPercent: 0.01,       // SAFETY: Single bet will NEVER exceed 1% of balance
    streakReset: 5             // Reset to base after 5 losses to stop the "high bet" spiral
};

// ============ BOT STATE ============
let btcPrice = 60000; 
let botState = {
    running: true,
    statusMessage: "Active: Compound Growth Mode",
    lossStreak: 0,
    coin: DEFAULTS.coin,
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

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    let base = Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
    return base;
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "pro" + Math.random().toString(36).substring(2, 10); 

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
        botState.statusMessage = error.response?.data?.Message || "API Error - Waiting...";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    while (true) {
        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        // 1. Calculate the standard base for the current balance
        const dynamicBase = calculateScaledBase(botState.stats.currentBalance);
        botState.settings.baseBet = dynamicBase;

        if (profit > 0) {
            // --- ON WIN ---
            botState.stats.wins++;
            botState.lossStreak = 0;
            botState.statusMessage = "Profit detected. Compounding...";
            
            // On a win, we stay at base bet but add a tiny "streak bonus" (10% of base)
            botState.settings.currentBet = dynamicBase + (dynamicBase * 0.1);
        } else {
            // --- ON LOSS ---
            botState.stats.losses++;
            botState.lossStreak++;
            botState.statusMessage = `Loss Streak: ${botState.lossStreak}`;

            if (botState.lossStreak >= DEFAULTS.streakReset) {
                // If we lose 5 times, go back to MINIMUM to save the balance
                botState.statusMessage = "Safety Reset: Loss streak too high.";
                botState.settings.currentBet = dynamicBase;
                botState.lossStreak = 0;
            } else {
                // Martingale limited: Double only if it's safe
                let nextBet = botState.settings.currentBet * 2;
                
                // SAFETY CHECK: Never bet more than 1% of balance
                const maxAllowed = botState.stats.currentBalance * DEFAULTS.maxBetPercent;
                if (nextBet > maxAllowed) {
                    botState.settings.currentBet = dynamicBase;
                    botState.statusMessage = "Cap Reached: Resetting bet size.";
                } else {
                    botState.settings.currentBet = nextBet;
                }
            }
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            bet: result.Bet, 
            roll: result.Roll, 
            profit: profit, 
            isWin: profit > 0, 
            currentBetSize: botState.settings.currentBet.toFixed(8)
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
    <title>Dice Pro v3.7 | Profit Scaler</title>
    <style>
        :root { --primary: #2563eb; --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --success: #22c55e; --danger: #ef4444; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
        .card { background: var(--card); padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #334155; }
        .val { font-size: 1.5rem; font-weight: bold; margin: 5px 0; }
        .status { background: #334155; padding: 10px; border-radius: 5px; margin-bottom: 20px; font-family: monospace; color: #38bdf8; }
        table { width: 100%; margin-top: 20px; border-collapse: collapse; }
        th { text-align: left; color: #94a3b8; font-size: 0.8rem; padding: 10px; }
        td { padding: 10px; border-bottom: 1px solid #334155; font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
    </style>
</head>
<body>
    <h1>Dice Pro <span style="color:var(--primary)">v3.7</span></h1>
    <div class="status" id="status">Initializing...</div>
    
    <div class="grid">
        <div class="card"><div>Balance (BTC)</div><div class="val" id="bal">0.00</div></div>
        <div class="card"><div>Net Profit</div><div class="val" id="profit" style="color:var(--success)">0.00</div></div>
        <div class="card"><div>Next Bet</div><div class="val" id="next" style="color: #f59e0b">0.00</div></div>
        <div class="card"><div>Win Rate</div><div class="val" id="wr">0%</div></div>
    </div>

    <table>
        <thead><tr><th>ID</th><th>Wager</th><th>Roll</th><th>Profit</th><th>Result</th></tr></thead>
        <tbody id="history"></tbody>
    </table>

    <script>
        async function update() {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const { botState, btcPrice } = data;

            document.getElementById('status').innerText = "SYSTEM STATUS: " + botState.statusMessage;
            document.getElementById('bal').innerText = botState.stats.currentBalance.toFixed(8);
            document.getElementById('profit').innerText = botState.stats.netProfit.toFixed(8);
            document.getElementById('next').innerText = botState.settings.currentBet.toFixed(8);
            document.getElementById('wr').innerText = ((botState.stats.wins/botState.stats.totalBets)*100 || 0).toFixed(1) + "%";

            document.getElementById('history').innerHTML = botState.betHistory.map(b => \`
                <tr>
                    <td>#\${b.id}</td>
                    <td>\${parseFloat(b.bet).toFixed(8)}</td>
                    <td>\${b.roll}</td>
                    <td class="\${b.isWin?'win':'loss'}">\${parseFloat(b.profit).toFixed(8)}</td>
                    <td class="\${b.isWin?'win':'loss'}">\${b.isWin?'WIN':'LOSS'}</td>
                </tr>
            \`).join('');
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    runStrategy();
});
