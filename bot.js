const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "sbxy6YyFFLwfl2TaNPVPO422P849giqmA5sGclMJ3yKBR5M1tY";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 5.0,          
    payout: 1.4,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: false,
    coin: DEFAULTS.coin,
    activeSeed: "",
    currentWinStreak: 0,
    lastDecision: "Waiting...", // To show on the dashboard
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
    const calculatedBase = Math.max(1, units) * DEFAULTS.betIncrement;
    return Number(calculatedBase.toFixed(8));
}

// ============ API LOGIC ============
async function placeBet() {
    if (botState.stats.totalBets % 10 === 0 || !botState.activeSeed) {
        const randomSuffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
        botState.activeSeed = "node20" + randomSuffix;
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
        const errorMsg = error.response?.data?.Message || error.message;
        console.error(`[!] API Error: ${errorMsg}`);
        const isBalanceError = errorMsg.toLowerCase().includes("balance");
        return { success: false, isBalanceError: isBalanceError };
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.running = true;
    while (botState.running) {
        const result = await placeBet();
        
        if (!result.success) { 
            if (result.isBalanceError) {
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            }
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        const data = result.data;
        botState.stats.totalBets++;
        const actualWager = data.Bet || botState.settings.currentBet; 
        const profit = data.Profit || 0;
        
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = data.Balance || 0;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit >= 0) {
            botState.stats.wins++;
            botState.currentWinStreak++;

            // Check if we just hit a 2-win streak
            if (botState.currentWinStreak === 2) {
                const randomChoice = Math.random() > 0.5; // 50/50 Chance

                if (randomChoice) {
                    // CHOICE 1: Reset to Base
                    botState.lastDecision = "Random: Reset to Base";
                    botState.settings.currentBet = botState.settings.baseBet;
                    botState.currentWinStreak = 0;
                } else {
                    // CHOICE 2: Continue as usual (Multiply)
                    botState.lastDecision = "Random: Pushing for 3rd Win";
                    let nextBet = botState.settings.currentBet * botState.settings.multiplier;
                    botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
                }
            } 
            else if (botState.currentWinStreak >= 3) {
                // Safety: Always reset after 3 wins to prevent massive loss
                botState.lastDecision = "Cap reached: Resetting";
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            }
            else {
                // Streak is only 1: Multiply as usual
                botState.lastDecision = "Streak 1: Multiplying...";
                let nextBet = botState.settings.currentBet * botState.settings.multiplier;
                botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
            }
        } else {
            // Reset on Loss
            botState.stats.losses++;
            botState.currentWinStreak = 0;
            botState.lastDecision = "Loss: Resetting";
            botState.settings.currentBet = botState.settings.baseBet;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            time: new Date(), 
            bet: actualWager, 
            roll: data.Roll, 
            profit: profit, 
            isWin: profit >= 0
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
    <title>Dice Pro | Anti-Crash Edition</title>
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
        .decision { font-size: 0.8rem; color: #64748b; margin-top: 5px; display: block; }
    </style>
</head>
<body>
    <div class="grid">
        <div class="card">Balance: <strong>${fmt(botState.stats.currentBalance)}</strong></div>
        <div class="card">Profit: <span class="${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</span></div>
        <div class="card">
            Streak: <strong>${botState.currentWinStreak}</strong>
            <span class="decision">${botState.lastDecision}</span>
        </div>
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
    console.log(`🚀 Anti-Crash Bot Online on port ${port}`);
    runStrategy();
});
