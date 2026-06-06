const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "XcKUm9uhtn6bYByGog66d6r9wyF7lrcrhf8pULwK8jD098lMWr";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 4.0,          // Double bet on win to maximize the streak profit
    payout: 1.4,              // 2.0x makes 1 Win = 1 Loss. Much easier to profit.
    balanceStep: 0.00000050,  
    betIncrement: 0.00000005, // Slightly higher base to ensure profit growth
    maxBalanceRisk: 0.15      
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
        baseBet: 0.00000005,
        currentBet: 0.00000005,
        multiplier: DEFAULTS.multiplier,
        payout: DEFAULTS.payout
    },
    betHistory: []
};

// ============ UTILITIES ============
function validateBetSize(bet) {
    const minBet = 0.00000001;
    let safeBet = Math.max(bet, minBet);

    // RISK GUARD
    const maxAllowed = botState.stats.currentBalance * DEFAULTS.maxBalanceRisk;
    if (botState.stats.currentBalance > 0 && safeBet > maxAllowed) {
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
        return { success: false };
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
                // Random Decision Logic
                if (Math.random() > 0.5) {
                    botState.lastDecision = "Random: Reset (Banked Profit)";
                    botState.settings.currentBet = botState.settings.baseBet;
                    botState.currentWinStreak = 0;
                } else {
                    botState.lastDecision = "Random: Pushing to Win 3";
                    botState.settings.currentBet = validateBetSize(botState.settings.currentBet * botState.settings.multiplier);
                }
            } 
            else if (botState.currentWinStreak >= 3) {
                botState.lastDecision = "Streak 3! Resetting";
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            }
            else {
                botState.lastDecision = "Win 1: Doubling";
                botState.settings.currentBet = validateBetSize(botState.settings.currentBet * botState.settings.multiplier);
            }
        } else {
            botState.stats.losses++;
            botState.currentWinStreak = 0;
            botState.lastDecision = "Loss: Reset to Base";
            botState.settings.currentBet = botState.settings.baseBet;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            bet: data.Bet, 
            roll: data.Roll, 
            profit: profit, 
            isWin: profit > 0
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        await new Promise(r => setTimeout(r, 1100)); 
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
    <title>Dice Pro | Profit Growth</title>
    <meta http-equiv="refresh" content="5">
    <style>
        :root { --primary: #2563eb; --bg: #0f172a; --card-bg: #1e293b; --text: #f8fafc; }
        body { font-family: 'Courier New', monospace; background-color: var(--bg); color: var(--text); padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid #334155; }
        table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        th { text-align: left; border-bottom: 2px solid #334155; padding: 8px; }
        td { padding: 8px; border-bottom: 1px solid #334155; }
        .win { color: #10b981; }
        .loss { color: #ef4444; }
        .decision { font-size: 0.75rem; color: #94a3b8; }
    </style>
</head>
<body>
    <div class="grid">
        <div class="card">Balance<br><strong>${fmt(botState.stats.currentBalance)}</strong></div>
        <div class="card">Net Profit<br><strong class="${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</strong></div>
        <div class="card">Streak: ${botState.currentWinStreak}<br><span class="decision">${botState.lastDecision}</span></div>
        <div class="card">Next Bet<br><strong>${fmt(botState.settings.currentBet)}</strong></div>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Wagered</th><th>Roll</th><th>Profit</th></tr></thead>
        <tbody>
            ${botState.betHistory.map(b => `<tr>
                <td>#${b.id}</td>
                <td>${fmt(b.bet)}</td>
                <td>${b.roll.toFixed(2)}</td>
                <td class="${b.isWin ? 'win' : 'loss'}">${fmt(b.profit)}</td>
            </tr>`).join('')}
        </tbody>
    </table>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Profit Bot Online on port ${port}`);
    runStrategy();
});
