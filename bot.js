const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "YOUR_API_KEY_HERE";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              // 2.0x payout means 1 Win covers 1 Loss
    multiplier: 2.0,          // Double bet on win
    baseBet: 0.00000001       // Starting with 1 satoshi for safety
};

// ============ BOT STATE ============
let botState = {
    running: false,
    currentWinStreak: 0,
    lastDecision: "Standing by...",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
    },
    settings: {
        baseBet: DEFAULTS.baseBet,
        currentBet: DEFAULTS.baseBet,
    },
    betHistory: []
};

// ============ LOGIC ============

function format8(num) {
    return (num || 0).toFixed(8);
}

async function placeBet() {
    // Safety: Never bet more than we have
    if (botState.settings.currentBet > botState.stats.currentBalance && botState.stats.currentBalance > 0) {
        botState.settings.currentBet = botState.settings.baseBet;
    }

    const url = `${BASE_URL}/placebet/${DEFAULTS.coin}/${API_KEY}`;
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: DEFAULTS.payout, 
        UnderOver: true, 
        ClientSeed: "seed_" + Math.random().toString(36).substring(2, 8) 
    };

    try {
        const response = await axios.post(url, payload);
        return { success: true, data: response.data };
    } catch (e) {
        return { success: false, error: e.response?.data?.Message || e.message };
    }
}

async function runLoop() {
    botState.running = true;
    while (botState.running) {
        const result = await placeBet();
        
        if (!result.success) {
            botState.lastDecision = "API Error: " + result.error;
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        const data = result.data;
        const profit = data.Profit || 0;
        
        botState.stats.totalBets++;
        botState.stats.currentBalance = data.Balance;
        botState.stats.netProfit += profit;

        if (profit > 0) {
            botState.stats.wins++;
            botState.currentWinStreak++;

            // --- YOUR RANDOM LOGIC ---
            if (botState.currentWinStreak === 2) {
                if (Math.random() > 0.5) {
                    botState.lastDecision = "Randomly Resetting at 2 Wins";
                    botState.settings.currentBet = botState.settings.baseBet;
                    botState.currentWinStreak = 0;
                } else {
                    botState.lastDecision = "Randomly Pushing to Win 3";
                    botState.settings.currentBet *= DEFAULTS.multiplier;
                }
            } else if (botState.currentWinStreak >= 3) {
                botState.lastDecision = "Hit 3 Win Streak: Resetting";
                botState.settings.currentBet = botState.settings.baseBet;
                botState.currentWinStreak = 0;
            } else {
                botState.lastDecision = "Win 1: Multiplying";
                botState.settings.currentBet *= DEFAULTS.multiplier;
            }
        } else {
            botState.stats.losses++;
            botState.currentWinStreak = 0;
            botState.lastDecision = "Loss: Back to Base";
            botState.settings.currentBet = botState.settings.baseBet;
        }

        // Update history
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            bet: data.Bet,
            profit: profit,
            roll: data.Roll,
            isWin: profit > 0
        });
        if (botState.betHistory.length > 20) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1200));
    }
}

// ============ WEB UI ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Crypto Dice Pro</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body { background: #0f172a; color: #f8fafc; font-family: -apple-system, sans-serif; padding: 40px; }
        .container { max-width: 900px; margin: auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
        .stat-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; margin-bottom: 8px; }
        .stat-value { font-size: 1.2rem; font-weight: bold; font-family: monospace; }
        .decision { color: #38bdf8; font-size: 14px; margin-top: 10px; font-style: italic; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
        th { background: #334155; padding: 15px; text-align: left; font-size: 13px; }
        td { padding: 15px; border-bottom: 1px solid #334155; font-family: monospace; }
        .win { color: #4ade80; }
        .loss { color: #f87171; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .badge-win { background: rgba(74, 222, 128, 0.2); color: #4ade80; }
        .badge-loss { background: rgba(248, 113, 113, 0.2); color: #f87171; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Strategy Dashboard</h1>
            <div style="text-align: right">
                <div style="font-size: 12px; color: #94a3b8">Status</div>
                <div style="color: #4ade80">● Live Bot Running</div>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Balance</div>
                <div class="stat-value">${format8(botState.stats.currentBalance)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Net Profit</div>
                <div class="stat-value ${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">
                    ${botState.stats.netProfit >= 0 ? '+' : ''}${format8(botState.stats.netProfit)}
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Current Streak</div>
                <div class="stat-value">${botState.currentWinStreak} Wins</div>
                <div class="decision">${botState.lastDecision}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Next Bet</div>
                <div class="stat-value">${format8(botState.settings.currentBet)}</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>WAGERED</th>
                    <th>ROLL</th>
                    <th>PROFIT</th>
                    <th>RESULT</th>
                </tr>
            </thead>
            <tbody>
                ${botState.betHistory.map(b => `
                    <tr>
                        <td>#${b.id}</td>
                        <td>${format8(b.bet)}</td>
                        <td>${b.roll.toFixed(2)}</td>
                        <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? '+' : ''}${format8(b.profit)}</td>
                        <td>
                            <span class="badge ${b.isWin ? 'badge-win' : 'badge-loss'}">
                                ${b.isWin ? 'WIN' : 'LOSS'}
                            </span>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log(`Example Dashboard at http://localhost:${port}`);
    runLoop();
});
