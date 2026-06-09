const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "jmA88PYVscHLMvMmatjxHa6rJzHo62pzVFVMcdxth6RQvmV0Jz";
const BASE_URL = "https://api.crypto.games/v1";

// OPTIMIZED FOR 1.4x PAYOUT
const GAME_CONFIG = {
    coin: "BTC",
    
    // 1.4x payout configuration
    targetPayout: 1.4,     // 1.4x payout
    winChance: 71.4,       // 71.4% win chance (high!)
    
    // Betting (1 Satoshi minimum)
    baseBet: 0.00000001,    // 1 SATOSHI
    minBet: 0.00000001,
    maxBet: 0.00000100,     // 100 satoshi max
    
    // WIN STREAK STRATEGY (NOT Martingale!)
    // Increase bet on WIN, reset on LOSS
    winStreakMultiplier: 1.5,  // Increase 50% after win
    maxWinStreak: 5,           // Max 5 wins in a row
    
    // Loss recovery
    lossReset: true,           // Reset to base bet on loss
    
    // Profit protection
    stopLossPercent: 20,       // Stop if down 20%
    takeProfitPercent: 15,     // Stop if up 15%
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let winStreak = 0;
let botState = {
    running: true,
    statusMessage: "1.4x WIN STREAK Strategy",
    coin: GAME_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        consecutiveWins: 0,
        consecutiveLosses: 0,
        highestBalance: 0,
        lowestBalance: Infinity,
        totalWagered: 0,
        biggestWinStreak: 0
    },
    settings: {
        currentBet: GAME_CONFIG.baseBet,
        payout: GAME_CONFIG.targetPayout
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

function formatSats(btcAmount) {
    return Math.floor(Math.abs(btcAmount) * 100000000).toLocaleString();
}

// ============ API LOGIC ============
async function placeDiceBet() {
    const url = `${BASE_URL}/placebet/${GAME_CONFIG.coin}/${API_KEY}`;
    
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32);
    
    const currentBet = Number(botState.settings.currentBet.toFixed(8));
    
    const payload = { 
        Bet: currentBet,
        Payout: GAME_CONFIG.targetPayout,
        UnderOver: true,
        ClientSeed: clientSeed
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response.data;
    } catch (error) { 
        return null; 
    }
}

// ============ WIN STREAK STRATEGY (Optimized for 1.4x) ============
function calculateNextBet(isWin) {
    if (isWin) {
        // WIN: Increase bet to ride the streak!
        winStreak++;
        botState.stats.consecutiveWins = winStreak;
        botState.stats.consecutiveLosses = 0;
        
        if (winStreak > botState.stats.biggestWinStreak) {
            botState.stats.biggestWinStreak = winStreak;
        }
        
        // Stop increasing after max streak
        if (winStreak >= GAME_CONFIG.maxWinStreak) {
            console.log(`🏆 Max win streak (${winStreak}) reached! Resetting to base.`);
            winStreak = 0;
            return GAME_CONFIG.baseBet;
        }
        
        // Increase bet by multiplier (1.5x)
        let newBet = botState.settings.currentBet * GAME_CONFIG.winStreakMultiplier;
        
        // Cap at max bet
        if (newBet > GAME_CONFIG.maxBet) {
            newBet = GAME_CONFIG.maxBet;
        }
        
        console.log(`📈 WIN #${winStreak}! Increasing bet: ${formatSats(botState.settings.currentBet)} → ${formatSats(newBet)} sats`);
        return newBet;
        
    } else {
        // LOSS: Reset everything
        winStreak = 0;
        botState.stats.consecutiveWins = 0;
        botState.stats.consecutiveLosses++;
        
        console.log(`❌ LOSS! Resetting to base bet: 1 satoshi`);
        return GAME_CONFIG.baseBet;
    }
}

// ============ PROFIT PROTECTION ============
function checkProfitTargets(currentBalance, startingBalance) {
    if (startingBalance === 0) return true;
    
    const profitPercent = ((currentBalance - startingBalance) / startingBalance) * 100;
    
    // Take profit
    if (profitPercent >= GAME_CONFIG.takeProfitPercent) {
        botState.statusMessage = `🎉 Take profit! +${profitPercent.toFixed(1)}% - Resetting session`;
        return false; // Stop bot (will restart)
    }
    
    // Stop loss
    if (profitPercent <= -GAME_CONFIG.stopLossPercent) {
        botState.statusMessage = `🛑 Stop loss! ${profitPercent.toFixed(1)}% - Resetting session`;
        return false;
    }
    
    return true;
}

// ============ MAIN BOT LOOP ============
async function runProfitBot() {
    console.log(`
    ╔══════════════════════════════════════════════════════════════════╗
    ║     🚀 OPTIMIZED 1.4x STRATEGY - WIN STREAK METHOD 🚀            ║
    ╠══════════════════════════════════════════════════════════════════╣
    ║                                                                  ║
    ║  WHY MARTINGALE FAILS FOR 1.4x:                                  ║
    ║    Win only gives +0.4x profit                                   ║
    ║    Need 2.5 wins to recover 1 loss                               ║
    ║                                                                  ║
    ║  WIN STREAK STRATEGY (PROFITABLE):                               ║
    ║    Win #1: Bet 1 → Win 0.4 (Total: +0.4)                        ║
    ║    Win #2: Bet 1.5 → Win 0.6 (Total: +1.0)                      ║
    ║    Win #3: Bet 2.25 → Win 0.9 (Total: +1.9)                     ║
    ║    Win #4: Bet 3.4 → Win 1.36 (Total: +3.26)                    ║
    ║    Loss at any time: Reset to 1 satoshi                          ║
    ║                                                                  ║
    ║  Expected Win Rate: 71.4% (High!)                               ║
    ║  Strategy: Ride winning streaks, reset on loss                  ║
    ║                                                                  ║
    ╚══════════════════════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 1.4x WIN STREAK - Ride the wins!";
    let lastLogTime = Date.now();
    let sessionRestart = false;
    
    while (botState.running) {
        const result = await placeDiceBet();
        
        if (!result) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        
        const betAmount = result.Bet || botState.settings.currentBet;
        const profit = result.Profit || 0;
        const isWin = profit > 0;
        const multiplier = result.Payout || GAME_CONFIG.targetPayout;
        
        // Update stats
        botState.stats.totalBets++;
        if (isWin) {
            botState.stats.wins++;
        } else {
            botState.stats.losses++;
        }
        
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.totalWagered += betAmount;
        
        // Track starting balance
        if (startingBalance === 0 && botState.stats.currentBalance > 0) {
            startingBalance = botState.stats.currentBalance - profit;
            botState.stats.startingBalance = startingBalance;
            botState.stats.highestBalance = startingBalance;
            botState.stats.lowestBalance = startingBalance;
            console.log(`\n📊 Starting Balance: ${formatSats(startingBalance)} SATOSHI\n`);
            console.log(`🎯 Target: +${GAME_CONFIG.takeProfitPercent}% | Stop: -${GAME_CONFIG.stopLossPercent}%\n`);
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
        
        // Check profit targets
        if (!checkProfitTargets(botState.stats.currentBalance, startingBalance)) {
            console.log(`\n📊 Session complete! Resetting for next session...\n`);
            // Reset session but keep bot running
            startingBalance = botState.stats.currentBalance;
            botState.stats.startingBalance = startingBalance;
            botState.stats.netProfit = 0;
            botState.stats.wins = 0;
            botState.stats.losses = 0;
            botState.stats.totalBets = 0;
            winStreak = 0;
            botState.settings.currentBet = GAME_CONFIG.baseBet;
            botState.statusMessage = "🟢 New session - " + botState.statusMessage;
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        
        // Calculate next bet using WIN STREAK strategy
        const newBet = calculateNextBet(isWin);
        botState.settings.currentBet = newBet;
        
        // Calculate profit metrics
        const profitThisRound = profit;
        const profitPercent = startingBalance > 0 ? 
            ((botState.stats.currentBalance - startingBalance) / startingBalance * 100).toFixed(1) : 0;
        
        // Store history
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: betAmount,
            wagerSats: formatSats(betAmount),
            multiplier: multiplier.toFixed(2),
            profit: profit,
            profitSats: formatSats(profit),
            isWin: isWin,
            balance: botState.stats.currentBalance,
            balanceSats: formatSats(botState.stats.currentBalance),
            winStreak: winStreak,
            profitPercent: profitPercent,
            nextBet: formatSats(newBet)
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Log every bet
        const now = Date.now();
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        const profitTotal = formatSats(botState.stats.netProfit);
        const sign = botState.stats.netProfit >= 0 ? '+' : '';
        
        if (now - lastLogTime > 1000 || botState.stats.totalBets % 5 === 0) {
            console.log(`#${botState.stats.totalBets} | ${formatSats(betAmount)}sats | ${isWin ? '✅WIN' : '❌LOSS'} | ${profit > 0 ? '+' : ''}${formatSats(profit)}sats | Total: ${sign}${profitTotal}sats | WR: ${winRate}% | Streak: ${winStreak} | Next: ${formatSats(newBet)}sats | ${profitPercent > 0 ? '+' : ''}${profitPercent}%`);
            lastLogTime = now;
        }
        
        await new Promise(r => setTimeout(r, 400));
    }
}

// ============ EXPRESS SERVER ============
app.get('/api/stats', (req, res) => {
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    const runTime = (Date.now() - botState.stats.startTime) / 1000;
    const hours = runTime / 3600;
    
    const currentProfit = botState.stats.netProfit;
    const profitPerHour = hours > 0 ? currentProfit / hours : 0;
    
    const projections = {
        hourly: profitPerHour,
        daily: profitPerHour * 24,
        monthly: profitPerHour * 24 * 30,
        yearly: profitPerHour * 24 * 365
    };
    
    res.json({ botState, btcPrice, winRate, runTime, projections });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>1.4x Win Streak Bot | Optimized Strategy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 24px;
        }
        
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            text-align: center;
            margin-bottom: 32px;
        }
        
        .header h1 {
            font-size: 28px;
            font-weight: 700;
            color: white;
            margin-bottom: 8px;
        }
        
        .badge {
            background: #10b981;
            color: white;
            font-size: 11px;
            padding: 2px 12px;
            border-radius: 20px;
            margin-left: 8px;
        }
        
        .strategy-box {
            background: rgba(255,255,255,0.95);
            border-radius: 16px;
            padding: 16px 20px;
            margin-bottom: 24px;
            text-align: center;
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
        }
        
        .strategy-box .title {
            font-weight: 700;
            color: #667eea;
            margin-bottom: 8px;
        }
        
        .strategy-box .math {
            font-family: monospace;
            font-size: 13px;
            color: #333;
        }
        
        .status-card {
            background: white;
            border-radius: 16px;
            padding: 16px 24px;
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            flex-wrap: wrap;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        .status-dot {
            width: 10px;
            height: 10px;
            background: #10b981;
            border-radius: 50%;
            display: inline-block;
            animation: pulse 1.5s infinite;
            margin-right: 8px;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; transform: scale(1.2); }
        }
        
        .stats-grid, .projections-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 24px;
        }
        
        .stat-card {
            background: white;
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }
        
        .stat-card:hover { transform: translateY(-2px); }
        
        .projection-card {
            background: linear-gradient(135deg, #1a2a3a 0%, #2d3a4a 100%);
            border-radius: 16px;
            padding: 20px;
            color: white;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        .stat-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: #8b9ab0;
            margin-bottom: 8px;
        }
        
        .projection-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            opacity: 0.8;
            margin-bottom: 8px;
        }
        
        .stat-value {
            font-size: 28px;
            font-weight: 700;
            color: #1a2a3a;
        }
        
        .projection-value {
            font-size: 24px;
            font-weight: 700;
        }
        
        .profit-positive { color: #10b981; }
        .profit-negative { color: #ef4444; }
        
        .table-container {
            background: white;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        .table-header {
            padding: 16px 20px;
            border-bottom: 1px solid #e4e7eb;
            background: #fafbfc;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th {
            text-align: left;
            padding: 12px 16px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: #8b9ab0;
            background: #fafbfc;
            border-bottom: 1px solid #e4e7eb;
        }
        
        td {
            padding: 10px 16px;
            font-size: 13px;
            border-bottom: 1px solid #f0f2f5;
        }
        
        .win-text { color: #10b981; font-weight: 600; }
        .loss-text { color: #ef4444; font-weight: 600; }
        
        .footer {
            text-align: center;
            margin-top: 24px;
            font-size: 12px;
            color: rgba(255,255,255,0.7);
        }
        
        @media (max-width: 768px) {
            .stats-grid, .projections-grid { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎲 1.4x WIN STREAK BOT <span class="badge">OPTIMIZED</span></h1>
        </div>
        
        <div class="strategy-box">
            <div class="title">🚀 WIN STREAK STRATEGY (Not Martingale!)</div>
            <div class="math">
                Increase bet 50% after WIN | Reset to 1 on LOSS | 71.4% win chance | Ride the streaks to profit!
            </div>
        </div>
        
        <div class="status-card">
            <div><span class="status-dot"></span> <span id="statusMessage">Loading...</span></div>
            <div>Payout: 1.4x | Win Chance: 71.4% | Win Streak Multiplier: 1.5x</div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">💰 Balance</div><div class="stat-value" id="balance">0</div><div id="balanceSats" style="font-size:12px;color:#8b9ab0;">0 satoshi</div></div>
            <div class="stat-card"><div class="stat-label">📈 Profit</div><div class="stat-value" id="profit">0</div><div id="profitSats" style="font-size:12px;">0 satoshi</div></div>
            <div class="stat-card"><div class="stat-label">🎲 Bets</div><div class="stat-value" id="totalBets">0</div><div>W: <span id="wins">0</span> | L: <span id="losses">0</span></div></div>
            <div class="stat-card"><div class="stat-label">📊 Win Rate</div><div class="stat-value" id="winRate">0%</div><div>Next: <span id="nextBet">0</span> sats</div></div>
        </div>
        
        <div class="projections-grid">
            <div class="projection-card"><div class="projection-label">⏱️ Per Hour</div><div class="projection-value" id="profitHourly">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">📅 Per Day</div><div class="projection-value" id="profitDaily">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">📆 Per Month</div><div class="projection-value" id="profitMonthly">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">🎯 Per Year</div><div class="projection-value" id="profitYearly">0</div><div>satoshi</div></div>
        </div>
        
        <div class="table-container">
            <div class="table-header"><h3>📜 Recent Bets (Increasing on Win Streaks!)</h3></div>
            <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
                <table>
                    <thead><tr><th>#</th><th>Time</th><th>Wager</th><th>Mult</th><th>Profit</th><th>Result</th><th>Win Streak</th><th>Balance</th></tr></thead>
                    <tbody id="historyBody"><tr><td colspan="8" style="text-align:center; padding:40px;">Loading...</td></tr></tbody>
                </table>
            </div>
        </div>
        
        <div class="footer">
            ✅ WIN STREAK STRATEGY: Bet increases after wins (1 → 1.5 → 2.25 → 3.4) | Resets to 1 on loss | Optimized for 1.4x payout
        </div>
    </div>
    
    <script>
        function formatSats(btc) {
            return Math.floor(Math.abs(btc || 0) * 100000000).toLocaleString();
        }
        
        function update() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    const b = data.botState;
                    const p = data.projections;
                    
                    document.getElementById('statusMessage').innerHTML = b.statusMessage;
                    document.getElementById('balance').innerHTML = formatSats(b.stats.currentBalance);
                    document.getElementById('balanceSats').innerHTML = formatSats(b.stats.currentBalance) + ' satoshi';
                    
                    const profitVal = b.stats.netProfit;
                    document.getElementById('profit').innerHTML = (profitVal >= 0 ? '+' : '') + formatSats(profitVal);
                    document.getElementById('profit').className = 'stat-value ' + (profitVal >= 0 ? 'profit-positive' : 'profit-negative');
                    document.getElementById('profitSats').innerHTML = (profitVal >= 0 ? '+' : '') + formatSats(profitVal) + ' satoshi';
                    
                    document.getElementById('totalBets').innerHTML = b.stats.totalBets.toLocaleString();
                    document.getElementById('wins').innerHTML = b.stats.wins.toLocaleString();
                    document.getElementById('losses').innerHTML = b.stats.losses.toLocaleString();
                    document.getElementById('winRate').innerHTML = data.winRate + '%';
                    document.getElementById('nextBet').innerHTML = formatSats(b.settings.currentBet);
                    
                    document.getElementById('profitHourly').innerHTML = formatSats(p.hourly);
                    document.getElementById('profitDaily').innerHTML = formatSats(p.daily);
                    document.getElementById('profitMonthly').innerHTML = formatSats(p.monthly);
                    document.getElementById('profitYearly').innerHTML = formatSats(p.yearly);
                    
                    const tbody = document.getElementById('historyBody');
                    if (!b.betHistory || b.betHistory.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px;">No bets yet...</td></tr>';
                        return;
                    }
                    
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(30, b.betHistory.length); i++) {
                        const bet = b.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerHTML = '<strong>' + bet.wagerSats + '</strong> sats';
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win-text">+' + bet.profitSats + '</span>' : 
                            '<span class="loss-text">' + bet.profitSats + '</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? '<span class="win-text">✅ WIN</span>' : '<span class="loss-text">❌ LOSS</span>';
                        row.insertCell(6).innerHTML = bet.winStreak > 0 ? '<span class="win-text">🔥 ' + bet.winStreak + '</span>' : '-';
                        row.insertCell(7).innerText = bet.balanceSats + ' sats';
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
    console.log(`\n🚀 1.4x OPTIMIZED BOT: http://localhost:${port}\n`);
    runProfitBot();
});
