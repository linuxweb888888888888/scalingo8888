const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
// REPLACE THE KEY BELOW WITH YOUR ACTUAL KEY FROM CRYPTO.GAMES SETTINGS
const API_KEY = "OrUrwrx3KlKoBxRdDAnX85JHpADjvmtzEzPrEQR2G6892jWlTL";
const BASE_URL = "https://api.crypto.games/v1";

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.02,      
    maxBetPercent: 0.15,       
    payout: 2.0,               
    safetyFloor: 0.00000003,   // Protection reserve
    useDAlenbert: true         
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing REAL-BET SAFE ENGINE...",
    coin: CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0.00000012,
        startingBalance: 0.00000012,
        startTime: Date.now(),
        bestStreak: 0,
        totalWagered: 0,
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
        growthStage: 1
    },
    betHistory: [] // Properly initialized to prevent 'unshift' error
};

// ============ STRATEGY OPTIMIZER ============
function updateStrategyByBalance() {
    const balance = botState.stats.currentBalance;
    let newStrategy = "🛡️ SAFE GROWTH";
    
    if (balance <= CONFIG.safetyFloor + (CONFIG.minBet * 2)) {
        newStrategy = "⚠️ RESERVE PROTECTION";
        CONFIG.baseBetPercent = 0.01;
    } else if (balance < 0.00000100) {
        newStrategy = "🚀 MICRO STARTUP";
    } else {
        newStrategy = "📈 STEADY COMPOUNDING";
    }
    botState.settings.currentStrategy = newStrategy;
    return newStrategy;
}

// ============ SAFE BET CALCULATOR ============
function calculateAdaptiveBet(isWin, currentBet, baseBet, lossStreak, currentBalance) {
    const playableBalance = Math.max(0, currentBalance - CONFIG.safetyFloor);
    const absoluteMax = playableBalance * CONFIG.maxBetPercent;
    let nextBet;

    if (isWin) {
        nextBet = baseBet; // Return to base on win for safety
    } else {
        // D'Alembert: Arithmetic increase (+1 unit) is safer than Martingale (x2)
        nextBet = currentBet + (baseBet * 0.5);
    }

    nextBet = Math.min(nextBet, absoluteMax);
    return Math.max(CONFIG.minBet, Number(nextBet.toFixed(8)));
}

// ============ REAL API BETTING LOGIC ============
async function placeBet() {
    const currentStrategy = updateStrategyByBalance();
    
    const nextBet = calculateAdaptiveBet(
        botState.settings.consecutiveWins > 0,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = nextBet;

    // GENERATE ALPHANUMERIC SEED ONLY (No underscores/special characters)
    const alphanumericSeed = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: alphanumericSeed 
    };

    try {
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
            Strategy: currentStrategy
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
    console.log(`✅ ENGINE ONLINE - REAL BETS ACTIVE`);
    
    while (botState.running) {
        botState.settings.baseBet = Math.max(CONFIG.minBet, botState.stats.currentBalance * CONFIG.baseBetPercent);

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

            botState.betHistory.unshift({ 
                ...result, 
                id: botState.stats.totalBets, 
                time: new Date().toLocaleTimeString(),
                growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2) + "x"
            });
            
            if (botState.betHistory.length > 30) botState.betHistory.pop();
            botState.statusMessage = `${botState.settings.currentStrategy} | Bal: ${botState.stats.currentBalance.toFixed(8)}`;
        }

        await new Promise(r => setTimeout(r, 1200)); // 1.2s delay to respect rate limits
    }
}

// ============ WEB INTERFACE ============
app.get('/api/stats', (req, res) => {
    res.json({ botState, btcPrice });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dice Pro v8.2</title>
    <style>
        body { font-family: sans-serif; background: #0f172a; color: #f1f5f9; padding: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 10px; margin-bottom: 20px; border: 1px solid #334155; }
        .win { color: #10b981; } .loss { color: #ef4444; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #334155; }
    </style>
</head>
<body>
    <div class="card">
        <h2 id="status">Loading...</h2>
        <div style="font-size: 2em;" id="balance">0.00000000 BTC</div>
        <p id="profit">Profit: 0.00000000 BTC</p>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Result</th><th>Bet</th><th>Payout</th><th>Growth</th></tr></thead>
        <tbody id="history"></tbody>
    </table>
    <script>
        async function update() {
            const r = await fetch('/api/stats');
            const d = await r.json();
            document.getElementById('status').innerText = d.botState.statusMessage;
            document.getElementById('balance').innerText = d.botState.stats.currentBalance.toFixed(8) + " BTC";
            document.getElementById('profit').innerText = "Profit: " + d.botState.stats.netProfit.toFixed(8) + " BTC";
            document.getElementById('history').innerHTML = d.botState.betHistory.map(b => \`
                <tr>
                    <td>#\${b.id}</td>
                    <td class="\${b.Profit > 0 ? 'win' : 'loss'}">\${b.Profit.toFixed(8)}</td>
                    <td>\${b.Bet.toFixed(8)}</td>
                    <td>\${b.Payout}x</td>
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
