const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "ivA6fvYz8UfTRkpj1lCutsuqZ9ChoJAj6j9dZd2foZyfLVlE6U";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 1.8,          // Adjusted for better balance
    payout: 2.0,              // 2.0x gives you a 1:1 risk/reward
    balanceStep: 0.00000050,  
    betIncrement: 0.00000002,
    maxBalanceRisk: 0.10      // NEW: Never bet more than 10% of total balance
};

// ============ BOT STATE ============
let botState = {
    running: false,
    coin: DEFAULTS.coin,
    activeSeed: "",
    currentWinStreak: 0,
    lastDecision: "Init...",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
    },
    settings: {
        baseBet: 0.00000002,
        currentBet: 0.00000002,
        multiplier: DEFAULTS.multiplier,
        payout: DEFAULTS.payout
    },
    betHistory: []
};

// ============ UTILITIES ============

// FIX: Ensure profit is never zero
function validateBetSize(bet) {
    const minProfit = 0.00000001;
    const potentialProfit = bet * (botState.settings.payout - 1);
    
    let safeBet = bet;
    if (potentialProfit < minProfit) {
        // Increase bet so profit is at least 1 satoshi
        safeBet = Math.ceil(minProfit / (botState.settings.payout - 1) * 100000000) / 100000000;
    }

    // RISK GUARD: Never bet more than X% of total balance
    const maxAllowed = botState.stats.currentBalance * DEFAULTS.maxBalanceRisk;
    if (botState.stats.currentBalance > 0 && safeBet > maxAllowed) {
        console.log("⚠️ Risk Guard Triggered: Lowering bet to protect balance.");
        return botState.settings.baseBet;
    }

    return Number(safeBet.toFixed(8));
}

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    const calculatedBase = Math.max(1, units) * DEFAULTS.betIncrement;
    return validateBetSize(calculatedBase);
}

// ============ API LOGIC ============
async function placeBet() {
    if (botState.stats.totalBets % 10 === 0 || !botState.activeSeed) {
        botState.activeSeed = "node" + Math.random().toString(36).substring(2, 10);
    }

    // Ensure the current bet is safe before sending to API
    botState.settings.currentBet = validateBetSize(botState.settings.currentBet);

    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: botState.activeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        return { success: true, data: response.data };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message;
        return { success: false, isBalanceError: errorMsg.toLowerCase().includes("balance") };
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.running = true;
    while (botState.running) {
        const result = await placeBet();
        
        if (!result.success) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        const data = result.data;
        botState.stats.totalBets++;
        const profit = data.Profit || 0;
        
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = data.Balance || 0;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.currentWinStreak++;

            if (botState.currentWinStreak === 2) {
                // YOUR RANDOM LOGIC: Reset or Continue
                if (Math.random() > 0.5) {
                    botState.lastDecision = "Random: Reset to Base";
                    botState.settings.currentBet = botState.settings.baseBet;
                    botState.currentWinStreak = 0;
                } else {
                    botState.lastDecision = "Random: Pushing to 3";
                    botState.settings.currentBet *= botState.settings.multiplier;
                }
            } 
            else if (botState.currentWinStreak >= 3) {
                botState.lastDecision = "Streak 3: Resetting";
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            }
            else {
                botState.lastDecision = "Win: Multiplying";
                botState.settings.currentBet *= botState.settings.multiplier;
            }
            
            await new Promise(r => setTimeout(r, 1100)); // Normal speed on wins
        } else {
            botState.stats.losses++;
            botState.currentWinStreak = 0;
            botState.lastDecision = "Loss: Cooling Down";
            botState.settings.currentBet = botState.settings.baseBet;
            
            await new Promise(r => setTimeout(r, 3000)); // NEW: Extra delay on loss to break patterns
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            bet: data.Bet, 
            roll: data.Roll, 
            profit: profit, 
            isWin: profit > 0
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
    }
}

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    const fmt = (num) => (num || 0).toFixed(8);
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro | Anti-Loss Edition</title>
    <meta http-equiv="refresh" content="5">
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --success: #10b981; --danger: #ef4444; }
        body { font-family: sans-serif; background-color: var(--bg); color: var(--text-main); padding: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid #e2e8f0; }
        table { width: 100%; border-collapse: collapse; background: white; }
        th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; font-family: monospace; }
        .win { color: var(--success); font-weight: bold; }
        .loss { color: var(--danger); font-weight: bold; }
        .decision { font-size: 0.8rem; color: #64748b; display: block; margin-top: 5px; }
    </style>
</head>
<body>
    <div class="grid">
        <div class="card">Balance: <strong>${fmt(botState.stats.currentBalance)}</strong></div>
        <div class="card">Profit: <span class="${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</span></div>
        <div class="card">Streak: <strong>${botState.currentWinStreak}</strong><span class="decision">${botState.lastDecision}</span></div>
        <div class="card">Next Bet: <strong>${fmt(botState.settings.currentBet)}</strong></div>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Wagered</th><th>Roll</th><th>Profit</th><th>Result</th></tr></thead>
        <tbody>
            ${botState.betHistory.map(b => `<tr>
                <td>#${b.id}</td>
                <td>${fmt(b.bet)}</td>
                <td>${b.roll.toFixed(2)}</td>
                <td class="${b.isWin ? 'win' : 'loss'}">${fmt(b.profit)}</td>
                <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
            </tr>`).join('')}
        </tbody>
    </table>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Anti-Loss Bot Online on port ${port}`);
    runStrategy();
});
