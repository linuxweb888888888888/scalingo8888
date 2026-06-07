const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "l7Y9CyxXHMtvfbxsnNo1P20Ob6ZPUW30RWLByjrSUVcDciBHhF";
const BASE_URL = "https://api.crypto.games/v1";

// DYNAMIC CONFIGURATION (Safety Optimized)
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.02,      // 2% base for sustainability
    maxBetPercent: 0.15,       // Max 15% to prevent total loss
    payout: 1.7,               
    targetMultiplier: 10.0,    
    stopLossPercent: 0.50,     
    safetyFloor: 0.00000003,   // Bot will NEVER bet below this reserve
    useKelly: true,
    useParoli: true,
    useAntiMartingale: true,
    useDAlenbert: true         // Arithmetic recovery (Safer than Martingale)
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing REAL-BET SAFE ENGINE...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0.00000012,
        startingBalance: 0.00000012,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        balanceHistory: [],
        strategyHistory: []
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        currentStrategy: "STABLE",
        riskLevel: 0.5,
        growthStage: 1
    },
    betHistory: [] // FIXED: Properly initialized
};

// ============ STRATEGY OPTIMIZER ============
function updateStrategyByBalance() {
    const balance = botState.stats.currentBalance;
    const growth = balance / botState.stats.startingBalance;
    
    let newStage = 1;
    let newStrategy = "🛡️ SAFE GROWTH";
    let newPayout = 2.0;

    if (balance <= CONFIG.safetyFloor + (CONFIG.minBet * 2)) {
        newStrategy = "⚠️ RESERVE PROTECTION";
        CONFIG.baseBetPercent = 0.01;
        botState.settings.riskLevel = 0.1;
    } else if (balance < 0.00000100) {
        newStage = 1;
        newStrategy = "🚀 MICRO STARTUP";
        newPayout = 2.5;
    } else {
        newStage = 2;
        newStrategy = "📈 COMPOUNDING";
        newPayout = 2.0;
    }

    botState.settings.growthStage = newStage;
    botState.settings.currentStrategy = newStrategy;
    botState.settings.payout = newPayout;
    return newStrategy;
}

// ============ SAFE BET CALCULATOR ============
function calculateAdaptiveBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const playableBalance = Math.max(0, currentBalance - CONFIG.safetyFloor);
    const absoluteMax = playableBalance * CONFIG.maxBetPercent;
    let nextBet;

    if (isWin) {
        // Anti-Martingale: Increase slightly on wins to use "House Money"
        nextBet = (winStreak > 0 && winStreak < 3) ? currentBet * 1.5 : baseBet;
    } else {
        // D'Alembert: Arithmetic increase (Safe) instead of Martingale (Dangerous)
        nextBet = lossStreak > 0 ? currentBet + (baseBet * 0.5) : baseBet;
    }

    nextBet = Math.min(nextBet, absoluteMax);
    return Math.max(CONFIG.minBet, Number(nextBet.toFixed(8)));
}

// ============ REAL API BETTING LOGIC ============
async function placeBet() {
    const currentStrategy = updateStrategyByBalance();
    
    // Calculate next bet
    const nextBet = calculateAdaptiveBet(
        botState.settings.consecutiveWins > 0,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = nextBet;

    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: "safe_" + Math.random().toString(36).substring(7) 
    };

    try {
        // REAL API CALL
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit);
        const newBalance = parseFloat(result.Balance);
        
        return {
            Bet: payload.Bet,
            Balance: newBalance,
            Profit: profit,
            Roll: result.Roll,
            Payout: payload.Payout,
            ProfitPercent: (profit / payload.Bet * 100).toFixed(0),
            Strategy: currentStrategy,
            Stage: botState.settings.growthStage
        };
    } catch (error) {
        const errorMsg = error.response?.data?.Message || error.message;
        console.error(`❌ API ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        return null;
    }
}

// ============ MAIN ENGINE ============
async function runStrategy() {
    console.log(`🧠 REAL-BET SAFE ENGINE v8.1 ONLINE`);
    
    while (botState.running) {
        botState.settings.baseBet = Math.max(CONFIG.minBet, botState.stats.currentBalance * CONFIG.baseBetPercent);
        
        // Track history
        botState.stats.balanceHistory.push({ time: Date.now(), balance: botState.stats.currentBalance });
        if (botState.stats.balanceHistory.length > 50) botState.stats.balanceHistory.shift();

        const result = await placeBet();
        
        if (result) {
            botState.stats.totalBets++;
            botState.stats.currentBalance = result.Balance;
            botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
            botState.stats.totalWagered += result.Bet;

            if (result.Profit > 0) {
                botState.stats.wins++;
                botState.settings.consecutiveWins++;
                botState.settings.consecutiveLosses = 0;
            } else {
                botState.stats.losses++;
                botState.settings.consecutiveLosses++;
                botState.settings.consecutiveWins = 0;
            }

            // Update Best Streaks
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) botState.stats.bestStreak = botState.settings.consecutiveWins;

            botState.betHistory.unshift({ 
                ...result, 
                id: botState.stats.totalBets, 
                time: new Date().toLocaleTimeString(),
                winStreak: botState.settings.consecutiveWins,
                lossStreak: botState.settings.consecutiveLosses,
                growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2) + "x"
            });
            
            if (botState.betHistory.length > 30) botState.betHistory.pop();
            
            botState.statusMessage = `${botState.settings.currentStrategy} | Profit: ${botState.stats.netProfit.toFixed(8)} BTC`;
        }

        await new Promise(r => setTimeout(r, 1000)); 
    }
}

// ============ WEB API & DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const hours = (Date.now() - botState.stats.startTime) / 3600000;
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

// Reuse your original HTML Dashboard exactly
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v8.1 | SAFE ENGINE</title>
    <style>
        :root { --primary: #10b981; --bg: #0f172a; --card-bg: #1e293b; --text-main: #f1f5f9; --text-muted: #94a3b8; --border: #334155; --success: #10b981; --danger: #ef4444; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; }
        .val { font-size: 1.5rem; font-weight: 700; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
        th { text-align: left; color: var(--text-muted); padding: 10px; border-bottom: 1px solid var(--border); }
        td { padding: 10px; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 15px; background: var(--primary); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="status-bar" id="status">Initializing...</div>
    <div class="grid">
        <div class="card"><div class="label">Balance</div><div class="val" id="bal">0.00000000</div></div>
        <div class="card"><div class="label">Net Profit</div><div class="val" id="profit">0.00000000</div></div>
        <div class="card"><div class="label">Win Rate</div><div class="val" id="wr">0%</div></div>
        <div class="card"><div class="label">Growth</div><div class="val" id="growth">1.0x</div></div>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Strategy</th><th>Wager</th><th>Payout</th><th>Result</th><th>Growth</th></tr></thead>
        <tbody id="history"></tbody>
    </table>
    <script>
        async function update() {
            const res = await fetch('/api/stats');
            const { botState } = await res.json();
            document.getElementById('status').innerText = botState.statusMessage;
            document.getElementById('bal').innerText = botState.stats.currentBalance.toFixed(8) + " BTC";
            document.getElementById('profit').innerText = botState.stats.netProfit.toFixed(8) + " BTC";
            const wr = (botState.stats.wins / (botState.stats.totalBets || 1) * 100).toFixed(1);
            document.getElementById('wr').innerText = wr + "%";
            document.getElementById('growth').innerText = (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2) + "x";
            
            document.getElementById('history').innerHTML = botState.betHistory.map(b => \`
                <tr>
                    <td>#\${b.id}</td>
                    <td>\${b.Strategy}</td>
                    <td>\${b.Bet.toFixed(8)}</td>
                    <td>\${b.Payout}x</td>
                    <td class="\${b.Profit > 0 ? 'win' : 'loss'}">\${b.Profit.toFixed(8)}</td>
                    <td>\${b.growth}</td>
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
    runStrategy();
});
