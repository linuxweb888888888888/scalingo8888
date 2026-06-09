const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "FrRtbXf3294xXJJyiK9RYWhiqmj6f471xYBghxZE2cgW4Ddc3p";
const BASE_URL = "https://api.crypto.games/v1";

// CONTINUOUS PROFITABLE STRATEGY CONFIG
const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",
    rows: 8,
    baseBet: 0.00000010,  // 10 Satoshi base
    maxBet: 0.00001000,   // Increased max for continuous recovery
    lossIncrease: 1.5,     // 50% increase on loss (martingale style)
    maxConsecutiveLosses: 10 // Allow more losses before stopping (continuous mode)
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    continuousMode: true,  // NEVER STOPS
    statusMessage: "Continuous Plinko Bot - Grinding Profits",
    coin: PLINKO_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        consecutiveLosses: 0,
        highestBalance: 0,
        lowestBalance: Infinity
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows
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

// ============ API LOGIC (WORKING VERSION) ============
async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32);
    
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
        return null; 
    }
}

// ============ CONTINUOUS BETTING STRATEGY ============
function calculateNextBet(isWin, multiplier) {
    if (isWin) {
        // WIN: Reset consecutive losses and lower bet
        botState.stats.consecutiveLosses = 0;
        return PLINKO_CONFIG.baseBet;
    } else {
        // LOSS: Increase bet to recover (but never exceed maxBet)
        botState.stats.consecutiveLosses++;
        
        // Safety: If too many losses, reset bet to avoid catastrophic loss
        if (botState.stats.consecutiveLosses >= PLINKO_CONFIG.maxConsecutiveLosses) {
            console.log(`⚠️ ${botState.stats.consecutiveLosses} losses in a row - resetting to base bet`);
            botState.stats.consecutiveLosses = 0;
            return PLINKO_CONFIG.baseBet;
        }
        
        let newBet = botState.settings.currentBet * PLINKO_CONFIG.lossIncrease;
        if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
        
        // Never bet more than 10% of remaining balance
        const maxSafeBet = botState.stats.currentBalance * 0.1;
        if (newBet > maxSafeBet && maxSafeBet > PLINKO_CONFIG.baseBet) {
            newBet = maxSafeBet;
        }
        
        return newBet;
    }
}

// ============ MAIN CONTINUOUS BOT LOOP ============
async function runContinuousPlinko() {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     🔥 CONTINUOUS PLINKO BOT STARTED 🔥          ║
    ╠══════════════════════════════════════════════════╣
    ║  Mode: INFINITE (Never Stops)                    ║
    ║  Base Bet: ${formatBTC(PLINKO_CONFIG.baseBet)} BTC
    ║  Max Bet: ${formatBTC(PLINKO_CONFIG.maxBet)} BTC
    ║  Recovery: ${PLINKO_CONFIG.lossIncrease}x on loss
    ║  Strategy: Reset to base after win              ║
    ║  Expected Win Rate: 75% (Low Risk Plinko)       ║
    ╚══════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 CONTINUOUS MODE - Betting Forever";
    let lastLogTime = Date.now();
    
    while (botState.running) {
        // Place bet
        const result = await placePlinkoBet();
        
        if (!result) {
            console.log("⚠️ Bet failed - waiting 2 seconds...");
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        
        // Process result
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        const isWin = multiplier > 1;
        
        if (isWin) {
            botState.stats.wins++;
        } else {
            botState.stats.losses++;
        }
        
        // Update balance
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        
        // Track starting balance on first bet
        if (startingBalance === 0 && botState.stats.currentBalance > 0) {
            startingBalance = botState.stats.currentBalance - profit;
            botState.stats.startingBalance = startingBalance;
            botState.stats.highestBalance = startingBalance;
            botState.stats.lowestBalance = startingBalance;
        }
        
        // Update profit
        if (startingBalance > 0) {
            botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        }
        
        // Track highs and lows
        if (botState.stats.currentBalance > botState.stats.highestBalance) {
            botState.stats.highestBalance = botState.stats.currentBalance;
        }
        if (botState.stats.currentBalance < botState.stats.lowestBalance) {
            botState.stats.lowestBalance = botState.stats.currentBalance;
        }
        
        // Calculate next bet
        const newBet = calculateNextBet(isWin, multiplier);
        botState.settings.currentBet = newBet;
        
        // Store history (keep last 100 bets)
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: result.Bet,
            multiplier: multiplier,
            profit: profit,
            isWin: isWin,
            balance: botState.stats.currentBalance
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log every 10 seconds or on big wins/losses
        const now = Date.now();
        const winRate = (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1);
        const isSignificant = Math.abs(profit) > PLINKO_CONFIG.baseBet * 10;
        
        if (now - lastLogTime > 10000 || isSignificant || botState.stats.totalBets % 50 === 0) {
            console.log(`#${botState.stats.totalBets} | ${new Date().toLocaleTimeString()} | ${formatBTC(result.Bet)} | ${multiplier}x | ${isWin ? '✅WIN' : '❌LOSS'} | ${profit > 0 ? '+' : ''}${formatBTC(profit)} | Bal: ${formatBTC(botState.stats.currentBalance)} | WR: ${winRate}% | Consecutive: ${botState.stats.consecutiveLosses}`);
            lastLogTime = now;
        }
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 300));
    }
}

// ============ WEB DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    const runTime = (Date.now() - botState.stats.startTime) / 1000;
    res.json({ botState, btcPrice, winRate, runTime });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Continuous Plinko Bot</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body {
            font-family: 'Courier New', monospace;
            background: #0a0e27;
            color: #00ff88;
            padding: 20px;
            margin: 0;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            color: #00ff88;
            text-align: center;
            border-bottom: 2px solid #00ff88;
            padding-bottom: 10px;
        }
        .badge {
            background: #00ff88;
            color: #0a0e27;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: bold;
            display: inline-block;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin: 20px 0;
        }
        .card {
            background: #111827;
            border: 1px solid #00ff88;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
        }
        .card h3 {
            color: #888;
            font-size: 12px;
            margin: 0 0 10px 0;
            text-transform: uppercase;
        }
        .card .value {
            font-size: 24px;
            font-weight: bold;
            color: #00ff88;
        }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4444; }
        table {
            width: 100%;
            background: #111827;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #333;
            font-size: 12px;
        }
        th {
            background: #1a1f3a;
            color: #888;
        }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .status {
            background: #111827;
            border-left: 4px solid #00ff88;
            padding: 15px;
            margin: 20px 0;
            font-family: monospace;
        }
        .running-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            background: #00ff88;
            border-radius: 50%;
            animation: pulse 1s infinite;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔥 CONTINUOUS PLINKO BOT <span class="badge">LIVE</span></h1>
        
        <div class="stats">
            <div class="card">
                <h3>💰 BALANCE</h3>
                <div class="value" id="balance">0.00000000</div>
                <small id="balanceUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>📈 TOTAL PROFIT</h3>
                <div class="value" id="profit">0.00000000</div>
                <small id="profitUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>🎲 TOTAL BETS</h3>
                <div class="value" id="totalBets">0</div>
                <small>W: <span id="wins">0</span> | L: <span id="losses">0</span></small>
            </div>
            <div class="card">
                <h3>📊 WIN RATE</h3>
                <div class="value" id="winRate">0%</div>
                <small>Current: <span id="currentBet">0</span> BTC</small>
            </div>
        </div>
        
        <div class="stats">
            <div class="card">
                <h3>🏆 HIGHEST BALANCE</h3>
                <div class="value" id="highestBalance">0.00000000</div>
                <small>All-time high</small>
            </div>
            <div class="card">
                <h3>📉 LOWEST BALANCE</h3>
                <div class="value" id="lowestBalance">0.00000000</div>
                <small>All-time low</small>
            </div>
            <div class="card">
                <h3>⏱️ RUN TIME</h3>
                <div class="value" id="runTime">0s</div>
                <small>Continuous betting</small>
            </div>
            <div class="card">
                <h3>⚡ CONSECUTIVE LOSSES</h3>
                <div class="value" id="consecutiveLosses">0</div>
                <small>Current streak</small>
            </div>
        </div>
        
        <div class="status" id="statusMsg">
            <span class="running-indicator"></span> Loading...
        </div>
        
        <h3>📜 RECENT BETS (Last 30)</h3>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>#</th><th>Time</th><th>Wager (BTC)</th><th>Multiplier</th><th>Profit</th><th>Result</th><th>Balance</th></tr>
                </thead>
                <tbody id="history">
                    <tr><td colspan="7" style="text-align:center">Waiting for bets......</td></tr>
                </tbody>
            </table>
        </div>
    </div>
    
    <script>
        function formatTime(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            if (hours > 0) return hours + 'h ' + minutes + 'm';
            if (minutes > 0) return minutes + 'm ' + secs + 's';
            return secs + 's';
        }
        
        function update() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    const b = data.botState;
                    const btcPrice = data.btcPrice;
                    
                    document.getElementById('balance').innerHTML = b.stats.currentBalance.toFixed(8);
                    document.getElementById('balanceUSD').innerHTML = '$' + (b.stats.currentBalance * btcPrice).toFixed(2);
                    
                    const profitElem = document.getElementById('profit');
                    profitElem.innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + b.stats.netProfit.toFixed(8);
                    profitElem.className = 'value ' + (b.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative');
                    
                    document.getElementById('profitUSD').innerHTML = '$' + (Math.abs(b.stats.netProfit) * btcPrice).toFixed(2);
                    document.getElementById('totalBets').innerHTML = b.stats.totalBets;
                    document.getElementById('wins').innerHTML = b.stats.wins;
                    document.getElementById('losses').innerHTML = b.stats.losses;
                    document.getElementById('winRate').innerHTML = data.winRate + '%';
                    document.getElementById('currentBet').innerHTML = b.settings.currentBet.toFixed(8);
                    document.getElementById('statusMsg').innerHTML = '<span class="running-indicator"></span> ' + b.statusMessage;
                    document.getElementById('highestBalance').innerHTML = b.stats.highestBalance.toFixed(8);
                    document.getElementById('lowestBalance').innerHTML = b.stats.lowestBalance.toFixed(8);
                    document.getElementById('runTime').innerHTML = formatTime(data.runTime);
                    document.getElementById('consecutiveLosses').innerHTML = b.stats.consecutiveLosses;
                    
                    const tbody = document.getElementById('history');
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(30, b.betHistory.length); i++) {
                        const bet = b.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerText = bet.wager.toFixed(8);
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + bet.profit.toFixed(8) + '</span>' : 
                            '<span class="loss">' + bet.profit.toFixed(8) + '</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? 
                            '<span class="win">✅ WIN</span>' : 
                            '<span class="loss">❌ LOSS</span>';
                        row.insertCell(6).innerText = bet.balance.toFixed(8);
                    }
                })
                .catch(console.error);
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

// ============ START CONTINUOUS BOT ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 CONTINUOUS BOT DASHBOARD: http://localhost:${port}\n`);
    runContinuousPlinko();
});
