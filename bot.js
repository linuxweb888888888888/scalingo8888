const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION (SMALL BALANCE OPTIMIZED) ============
const API_KEY = process.env.API_KEY || "FrRtbXf3294xXJJyiK9RYWhiqmj6f471xYBghxZE2cgW4Ddc3p";
const BASE_URL = "https://api.crypto.games/v1";

const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",
    rows: 8,
    baseBet: 0.00000001,
    maxBet: 0.00000050,
    recoveryMultiplier: 1.2,
    targetProfit: 0.00001000,
    stopLoss: 0.00000500,
    maxDrawdownPercent: 0.30,
};

// Plinko payout multipliers
const PLINKO_PAYOUTS = {
    low: {
        8: [5.6, 2.1, 1.1, 1.0, 1.0, 1.1, 2.1, 5.6],
    },
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    statusMessage: "Initializing Micro Plinko Bot...",
    coin: PLINKO_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        maxDrawdown: 0,
        peakBalance: 0,
        sessionHigh: 0,
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows,
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

function formatBTC(amount) {
    return (amount || 0).toFixed(8);
}

// ============ API LOGIC ============
async function getBalance() {
    const url = `${BASE_URL}/balance/${botState.coin}/${API_KEY}`;
    try {
        const response = await axios.get(url);
        return response.data.Balance || 0;
    } catch (error) {
        console.error("Balance check error:", error.message);
        return null;
    }
}

async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const clientSeed = `plinko_micro_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: 2.0,
        UnderOver: true,
        ClientSeed: clientSeed,
        Game: "plinko",
        Rows: botState.settings.rows,
        Risk: botState.settings.risk
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response.data;
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message;
        console.error("API Error:", errorMsg);
        botState.statusMessage = `API Error: ${errorMsg}`;
        return null; 
    }
}

// ============ SAFETY CHECK ============
function checkSafetyConditions() {
    if (botState.stats.netProfit <= -PLINKO_CONFIG.stopLoss) {
        botState.statusMessage = `STOP LOSS TRIGGERED! Loss: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    if (botState.stats.netProfit >= PLINKO_CONFIG.targetProfit) {
        botState.statusMessage = `TARGET REACHED! Profit: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    if (startingBalance > 0) {
        const currentDrawdown = (startingBalance - botState.stats.currentBalance) / startingBalance;
        if (currentDrawdown >= PLINKO_CONFIG.maxDrawdownPercent) {
            botState.statusMessage = `MAX DRAWDOWN REACHED! Down ${(currentDrawdown * 100).toFixed(1)}%`;
            botState.running = false;
            return false;
        }
    }
    
    const maxSafeBet = botState.stats.currentBalance * 0.10;
    if (botState.settings.currentBet > maxSafeBet && maxSafeBet > 0) {
        botState.settings.currentBet = Math.max(PLINKO_CONFIG.baseBet, maxSafeBet);
    }
    
    return true;
}

// ============ MAIN STRATEGY ============
async function runPlinkoStrategy() {
    const initialBalance = await getBalance();
    if (initialBalance === null) {
        console.error("Failed to get balance. Check your API key.");
        botState.statusMessage = "FAILED: Cannot connect to API";
        return;
    }
    
    startingBalance = initialBalance;
    botState.stats.startingBalance = startingBalance;
    botState.stats.currentBalance = startingBalance;
    botState.stats.peakBalance = startingBalance;
    botState.stats.sessionHigh = startingBalance;
    
    console.log(`
    Starting Balance: ${formatBTC(startingBalance)} BTC
    Base Bet: ${formatBTC(PLINKO_CONFIG.baseBet)} BTC (1 SATOSHI!)
    `);
    
    botState.statusMessage = "Bot Running - Low Risk / 1 Satoshi Base Bet";
    
    while (botState.running) {
        const freshBalance = await getBalance();
        if (freshBalance !== null) {
            botState.stats.currentBalance = freshBalance;
            botState.stats.netProfit = freshBalance - startingBalance;
        }
        
        if (botState.stats.currentBalance > botState.stats.peakBalance) {
            botState.stats.peakBalance = botState.stats.currentBalance;
        }
        
        const drawdown = botState.stats.peakBalance - botState.stats.currentBalance;
        if (drawdown > botState.stats.maxDrawdown) {
            botState.stats.maxDrawdown = drawdown;
        }
        
        if (!checkSafetyConditions()) {
            console.log("\nBot stopped:", botState.statusMessage);
            break;
        }
        
        const result = await placePlinkoBet();
        
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }
        
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        
        if (botState.stats.currentBalance > botState.stats.sessionHigh) {
            botState.stats.sessionHigh = botState.stats.currentBalance;
        }
        
        if (multiplier > 1) {
            botState.stats.wins++;
            botState.settings.currentBet = PLINKO_CONFIG.baseBet;
        } else {
            botState.stats.losses++;
            let newBet = botState.settings.currentBet * PLINKO_CONFIG.recoveryMultiplier;
            if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
            botState.settings.currentBet = newBet;
        }
        
        botState.betHistory.unshift({ 
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: result.Bet,
            multiplier: multiplier,
            profit: profit,
            isWin: multiplier > 1,
            currentBet: botState.settings.currentBet
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        console.log(`Bet #${botState.stats.totalBets}: ${formatBTC(result.Bet)} | ${multiplier}x | ${profit > 0 ? '+' : ''}${formatBTC(profit)} | Balance: ${formatBTC(botState.stats.currentBalance)}`);
        
        await new Promise(r => setTimeout(r, 800));
    }
}

// ============ EXPRESS DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2),
        winRate
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Plinko Bot</title>
    <style>
        body { font-family: Arial; margin: 20px; background: #1a1a2e; color: white; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: #16213e; padding: 20px; border-radius: 10px; margin: 10px 0; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
        .stat { background: #0f3460; padding: 15px; border-radius: 8px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #e94560; }
        .win { color: #4CAF50; }
        .loss { color: #f44336; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
        .status { padding: 10px; border-radius: 5px; margin-bottom: 20px; background: #e94560; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Plinko Bot - Micro Balance</h1>
        <div class="status" id="statusMsg">Loading...</div>
        
        <div class="stats">
            <div class="stat"><div>Balance</div><div class="stat-value" id="balance">0</div></div>
            <div class="stat"><div>Profit</div><div class="stat-value" id="profit">0</div></div>
            <div class="stat"><div>Total Bets</div><div class="stat-value" id="totalBets">0</div></div>
            <div class="stat"><div>Win Rate</div><div class="stat-value" id="winRate">0%</div></div>
        </div>
        
        <div class="card">
            <h3>Current Bet: <span id="currentBet">0</span> BTC</h3>
            <h3>Wins: <span id="wins">0</span> | Losses: <span id="losses">0</span></h3>
        </div>
        
        <table id="historyTable">
            <thead><tr><th>#</th><th>Time</th><th>Wager</th><th>Multiplier</th><th>Profit</th></tr></thead>
            <tbody id="historyBody"></tbody>
        </table>
    </div>
    
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                const b = data.botState;
                
                document.getElementById('statusMsg').innerHTML = b.statusMessage;
                document.getElementById('balance').innerHTML = b.stats.currentBalance.toFixed(8) + ' BTC';
                document.getElementById('profit').innerHTML = (b.stats.netProfit > 0 ? '+' : '') + b.stats.netProfit.toFixed(8) + ' BTC';
                document.getElementById('totalBets').innerHTML = b.stats.totalBets;
                document.getElementById('winRate').innerHTML = data.winRate + '%';
                document.getElementById('currentBet').innerHTML = b.settings.currentBet.toFixed(8);
                document.getElementById('wins').innerHTML = b.stats.wins;
                document.getElementById('losses').innerHTML = b.stats.losses;
                
                const tbody = document.getElementById('historyBody');
                tbody.innerHTML = '';
                for (let i = 0; i < b.betHistory.length; i++) {
                    const bet = b.betHistory[i];
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = '#' + bet.id;
                    row.insertCell(1).innerText = bet.time;
                    row.insertCell(2).innerText = bet.bet.toFixed(8);
                    row.insertCell(3).innerText = bet.multiplier + 'x';
                    row.insertCell(4).innerHTML = bet.profit > 0 ? '<span class="win">+' + bet.profit.toFixed(8) + '</span>' : '<span class="loss">' + bet.profit.toFixed(8) + '</span>';
                }
            } catch(e) { console.error(e); }
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

// ============ START SERVER ============
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    runPlinkoStrategy();
});
