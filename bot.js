const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "ivA6fvYz8UfTRkpj1lCutsuqZ9ChoJAj6j9dZd2foZyfLVlE6U";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 5.0,          
    payout: 1.4,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    winStreakCap: 5           // Increased to 5 - bot resets after 5 wins in a row
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: false,
    coin: DEFAULTS.coin,
    activeSeed: "",
    currentWinStreak: 0,      
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
        return response.data;
    } catch (error) { 
        console.error(`[!] API Error: ${error.response?.data?.Message || error.message}`);
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.running = true;
    while (botState.running) {
        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        // Use the actual wager from the API result for history
        const actualWager = result.Bet || botState.settings.currentBet; 
        const profit = result.Profit || 0;
        
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        // Treat as win if profit is 0 or more (handles low-satoshi rounding)
        if (profit >= 0) {
            botState.stats.wins++;
            botState.currentWinStreak++;
            botState.profitProtection.safeBalance += (profit * 0.50); 

            if (botState.currentWinStreak >= DEFAULTS.winStreakCap) {
                // Streak reached! Bank the profit and reset.
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            } else {
                // Multiply the bet for the next round
                let nextBet = botState.settings.currentBet * botState.settings.multiplier;
                botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
            }
        } else {
            // Loss Case: Reset immediately
            botState.stats.losses++;
            botState.currentWinStreak = 0;
            botState.settings.currentBet = botState.settings.baseBet;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            time: new Date(), 
            bet: actualWager, 
            roll: result.Roll, 
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
    const winRate = botState.stats.totalBets > 0 ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1) : 0;

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro | Fixed Logs</title>
    <meta http-equiv="refresh" content="5">
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --success: #10b981; --danger: #ef4444; }
        body { font-family: 'Inter', sans-serif; background-color: var(--bg); color: var(--text-main); padding: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid #e2e8f0; }
        table { width: 100%; border-collapse: collapse; background: white; }
        th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; font-family: monospace; }
        .win { color: var(--success); font-weight: bold; }
        .loss { color: var(--danger); font-weight: bold; }
    </style>
</head>
<body>
    <div class="grid">
        <div class="card">Balance: <strong>${fmt(botState.stats.currentBalance)}</strong></div>
        <div class="card">Profit: <span class="${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</span></div>
        <div class="card">Streak: <strong>${botState.currentWinStreak} / ${DEFAULTS.winStreakCap}</strong></div>
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
    console.log(`🚀 Bot Active on port ${port}`);
    runStrategy();
});
