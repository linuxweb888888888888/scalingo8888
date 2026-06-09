const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "FrRtbXf3294xXJJyiK9RYWhiqmj6f471xYBghxZE2cgW4Ddc3p";
const BASE_URL = "https://api.crypto.games/v1";

// ULTRA-SAFE CONFIG - 1 SATOSHI MINIMUM
const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",          // Low risk = more winning positions
    rows: 8,              // 8 rows gives best probability
    
    // MINIMUM BET SETTINGS
    baseBet: 0.00000001,  // 1 SATOSHI - ABSOLUTE MINIMUM
    minBet: 0.00000001,   // Never go below 1 satoshi
    maxBet: 0.00000050,   // Cap at 50 satoshi (safe for small balances)
    
    // Recovery settings
    lossIncrease: 1.2,    // Only 20% increase on loss (gentle recovery)
    maxConsecutiveLosses: 15, // Allow many losses (1 satoshi is cheap)
    
    // Balance protection
    maxBetPercent: 0.05   // Never bet more than 5% of balance
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    continuousMode: true,
    statusMessage: "ULTRA-SAFE 1 Satoshi Mode",
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

function formatSats(btcAmount) {
    return Math.floor(btcAmount * 100000000);
}

// ============ API LOGIC ============
async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32);
    
    const currentBet = Number(botState.settings.currentBet.toFixed(8));
    
    const payload = { 
        Bet: currentBet,
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
        if (errorMsg.includes("Minimum")) {
            console.log("⚠️ Minimum bet error - using 1 satoshi");
            botState.settings.currentBet = PLINKO_CONFIG.minBet;
        }
        return null; 
    }
}

// ============ SAFE BET CALCULATION ============
function calculateNextBet(isWin, multiplier) {
    if (isWin) {
        // WIN: Reset to 1 satoshi
        botState.stats.consecutiveLosses = 0;
        return PLINKO_CONFIG.minBet;
    } else {
        // LOSS: Gentle increase
        botState.stats.consecutiveLosses++;
        
        // After many losses, reset to min (safety)
        if (botState.stats.consecutiveLosses >= PLINKO_CONFIG.maxConsecutiveLosses) {
            console.log(`⚠️ ${botState.stats.consecutiveLosses} losses - resetting to 1 satoshi`);
            botState.stats.consecutiveLosses = 0;
            return PLINKO_CONFIG.minBet;
        }
        
        // Gentle 20% increase
        let newBet = botState.settings.currentBet * PLINKO_CONFIG.lossIncrease;
        
        // Cap at max bet
        if (newBet > PLINKO_CONFIG.maxBet) {
            newBet = PLINKO_CONFIG.maxBet;
        }
        
        // NEVER bet more than 5% of current balance
        const maxSafeBet = botState.stats.currentBalance * PLINKO_CONFIG.maxBetPercent;
        if (newBet > maxSafeBet && maxSafeBet >= PLINKO_CONFIG.minBet) {
            newBet = maxSafeBet;
        }
        
        // Ensure minimum
        if (newBet < PLINKO_CONFIG.minBet) {
            newBet = PLINKO_CONFIG.minBet;
        }
        
        return newBet;
    }
}

// ============ MAIN CONTINUOUS BOT LOOP ============
async function runContinuousPlinko() {
    // Wait a moment for balance to be available
    await new Promise(r => setTimeout(r, 1000));
    
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     🛡️ ULTRA-SAFE 1 SATOSHI PLINKO BOT 🛡️        ║
    ╠══════════════════════════════════════════════════╣
    ║  Base Bet: 0.00000001 BTC (1 SATOSHI!)           ║
    ║  Max Bet: ${formatBTC(PLINKO_CONFIG.maxBet)} BTC (${formatSats(PLINKO_CONFIG.maxBet)} sats)
    ║  Recovery: ${PLINKO_CONFIG.lossIncrease}x (gentle 20%)
    ║  Max Loss Streak: ${PLINKO_CONFIG.maxConsecutiveLosses} before reset
    ║  Risk: LOW - 75% expected win rate
    ║  Strategy: Grind forever, never risk big
    ╚══════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 1 SATOSHI MODE - Betting forever";
    let lastLogTime = Date.now();
    let errorCount = 0;
    
    while (botState.running) {
        // Place bet
        const result = await placePlinkoBet();
        
        if (!result) {
            errorCount++;
            if (errorCount > 10) {
                console.log("❌ Too many API errors - waiting 10 seconds...");
                await new Promise(r => setTimeout(r, 10000));
                errorCount = 0;
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
            continue;
        }
        
        errorCount = 0;
        
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
            
            console.log(`\n📊 Starting Balance: ${formatBTC(startingBalance)} BTC (${formatSats(startingBalance)} satoshi)\n`);
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
            balance: botState.stats.currentBalance,
            betSats: formatSats(result.Bet)
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log periodically
        const now = Date.now();
        const winRate = (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1);
        const betSats = formatSats(result.Bet);
        
        if (now - lastLogTime > 5000 || botState.stats.totalBets % 100 === 0) {
            const profitSats = formatSats(botState.stats.netProfit);
            console.log(`#${botState.stats.totalBets} | ${betSats}sats | ${multiplier}x | ${isWin ? '✅' : '❌'} | ${profit > 0 ? '+' : ''}${formatSats(profit)}sats | Profit: ${profitSats > 0 ? '+' : ''}${profitSats}sats | WR: ${winRate}% | Streak: ${botState.stats.consecutiveLosses}`);
            lastLogTime = now;
        }
        
        // Small delay for safety
        await new Promise(r => setTimeout(r, 400));
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
    <title>1 Satoshi Plinko Bot</title>
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
        .satoshi-badge {
            background: #ff4444;
            color: white;
            padding: 2px 10px;
            border-radius: 20px;
            font-size: 12px;
            margin-left: 10px;
        }
        .badge {
            background: #00ff88;
            color: #0a0e27;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: bold;
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
        .note {
            text-align: center;
            color: #888;
            font-size: 11px;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🪙 1 SATOSHI PLINKO BOT <span class="badge">LIVE</span><span class="satoshi-badge">MINIMUM BET</span></h1>
        
        <div class="stats">
            <div class="card">
                <h3>💰 BALANCE</h3>
                <div class="value" id="balance">0.00000000</div>
                <small id="balanceSats">0 satoshi</small>
            </div>
            <div class="card">
                <h3>📈 TOTAL PROFIT</h3>
                <div class="value" id="profit">0.00000000</div>
                <small id="profitSats">0 satoshi</small>
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
                <h3>⚡ LOSS STREAK</h3>
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
                    <tr>
                        <th>#</th>
                        <th>Time</th>
                        <th>Wager</th>
                        <th>Multiplier</th>
                        <th>Profit</th>
                        <th>Result</th>
                        <th>Balance</th>
                    </tr>
                </thead>
                <tbody id="history">
                    <tr><td colspan="7" style="text-align:center">Waiting for bets...</td></tr>
                </tbody>
            </table>
        </div>
        <div class="note">
            ⚡ Betting 1 SATOSHI minimum | Gentle 20% recovery | Never bets more than 5% of balance
        </div>
    </div>
    
    <script>
        function formatSats(btc) {
            return Math.floor(btc * 100000000).toLocaleString();
        }
        
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
                    document.getElementById('balanceSats').innerHTML = formatSats(b.stats.currentBalance) + ' satoshi';
                    
                    const profitElem = document.getElementById('profit');
                    profitElem.innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + b.stats.netProfit.toFixed(8);
                    profitElem.className = 'value ' + (b.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative');
                    document.getElementById('profitSats').innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + formatSats(Math.abs(b.stats.netProfit)) + ' satoshi';
                    
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
                        row.insertCell(2).innerHTML = bet.betSats + ' sats';
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + formatSats(bet.profit) + ' sats</span>' : 
                            '<span class="loss">' + formatSats(bet.profit) + ' sats</span>';
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

// ============ START ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 1 SATOSHI BOT DASHBOARD: http://localhost:${port}\n`);
    runContinuousPlinko();
});
