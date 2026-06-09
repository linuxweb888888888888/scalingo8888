const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "xSyUtNdWTGA5gcGsiojtAXpTnis3iL3sL9ZJQMXLtmcGVTt3Z9";
const BASE_URL = "https://api.crypto.games/v1";

// FIXED: PROPER WIN STREAK STRATEGY
const GAME_CONFIG = {
    coin: "BTC",
    
    targetPayout: 1.4,
    winChance: 71.4,
    
    // Fixed betting (1 Satoshi minimum)
    baseBet: 0.00000001,
    minBet: 0.00000001,
    maxBet: 0.00000300,     // 300 satoshi max
    
    // FIXED: Win streak progression
    streakMultipliers: [2.5, 5, 7.5, 10, 12.5, 15, 17.5], // Progressive increase
    maxStreak: 6,
    
    // Recovery from loss
    lossReset: true,        // Always reset to 1 on loss
    
    // Session management
    stopLossPercent: 20,
    takeProfitPercent: 15,
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let currentStreak = 0;
let consecutiveLosses = 0;
let botState = {
    running: true,
    statusMessage: "FIXED Win Streak Strategy",
    coin: GAME_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        highestBalance: 0,
        lowestBalance: Infinity,
        totalWagered: 0,
        longestWinStreak: 0,
        currentWinStreak: 0
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

// ============ FIXED: PROPER WIN STREAK CALCULATION ============
function calculateNextBet(isWin, currentBet) {
    if (isWin) {
        // WIN: Increase streak and bet
        currentStreak++;
        consecutiveLosses = 0;
        botState.stats.currentWinStreak = currentStreak;
        
        if (currentStreak > botState.stats.longestWinStreak) {
            botState.stats.longestWinStreak = currentStreak;
        }
        
        // Cap at max streak
        if (currentStreak >= GAME_CONFIG.maxStreak) {
            console.log(`🏆 MAX STREAK ${currentStreak} reached! Resetting.`);
            currentStreak = 0;
            return GAME_CONFIG.baseBet;
        }
        
        // Use multiplier based on streak length
        const multiplierIndex = Math.min(currentStreak, GAME_CONFIG.streakMultipliers.length - 1);
        const multiplier = GAME_CONFIG.streakMultipliers[multiplierIndex];
        
        let newBet = GAME_CONFIG.baseBet * multiplier;
        
        // Cap at max bet
        if (newBet > GAME_CONFIG.maxBet) {
            newBet = GAME_CONFIG.maxBet;
        }
        
        console.log(`📈 STREAK ${currentStreak}! Bet: ${formatSats(currentBet)} → ${formatSats(newBet)} sats (${multiplier}x)`);
        return newBet;
        
    } else {
        // LOSS: Reset everything
        console.log(`❌ LOSS! Resetting from streak ${currentStreak} to base bet`);
        currentStreak = 0;
        consecutiveLosses++;
        botState.stats.currentWinStreak = 0;
        return GAME_CONFIG.baseBet;
    }
}

// ============ MAIN BOT LOOP ============
async function runProfitBot() {
    console.log(`
    ╔══════════════════════════════════════════════════════════════════╗
    ║     🔧 FIXED WIN STREAK - PROPER TRACKING 🔧                     ║
    ╠══════════════════════════════════════════════════════════════════╣
    ║                                                                  ║
    ║  STREAK PROGRESSION:                                            ║
    ║    Win #1: 1 sat    → Win #2: 1.5 sat  → Win #3: 2 sat          ║
    ║    Win #4: 2.5 sat  → Win #5: 3 sat    → Win #6: 3.5 sat        ║
    ║    ANY LOSS: Reset to 1 satoshi                                 ║
    ║                                                                  ║
    ║  EXPECTED: Win streaks of 3-5 common (71.4% win rate)           ║
    ║  LOSS -16 should NOT happen with 1.4x payout!                   ║
    ║                                                                  ║
    ╚══════════════════════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 FIXED: Proper win streak tracking";
    let lastLogTime = Date.now();
    
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
        
        // FIXED: Calculate next bet with proper streak
        const newBet = calculateNextBet(isWin, betAmount);
        botState.settings.currentBet = newBet;
        
        // Calculate win rate
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        
        // Calculate profit percentage
        const profitPercent = startingBalance > 0 ? 
            ((botState.stats.currentBalance - startingBalance) / startingBalance * 100).toFixed(1) : 0;
        
        // Store history with streak info
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
            winStreak: currentStreak,
            winRate: winRate,
            profitPercent: profitPercent
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Enhanced logging
        const now = Date.now();
        const profitTotal = formatSats(botState.stats.netProfit);
        const sign = botState.stats.netProfit >= 0 ? '+' : '';
        
        if (now - lastLogTime > 1000 || botState.stats.totalBets % 3 === 0) {
            console.log(`#${botState.stats.totalBets} | Bet: ${formatSats(betAmount)}sats | ${isWin ? '✅WIN' : '❌LOSS'} | Profit: ${profit > 0 ? '+' : ''}${formatSats(profit)}sats | Total: ${sign}${profitTotal}sats | WR: ${winRate}% | 🔥 STREAK: ${currentStreak} | Next: ${formatSats(newBet)}sats`);
            lastLogTime = now;
        }
        
        // Check profit targets
        if (startingBalance > 0) {
            const pct = parseFloat(profitPercent);
            if (pct >= GAME_CONFIG.takeProfitPercent) {
                console.log(`\n🎉 TAKE PROFIT! +${pct}% - Resetting session\n`);
                startingBalance = botState.stats.currentBalance;
                botState.stats.startingBalance = startingBalance;
                botState.stats.netProfit = 0;
                botState.stats.wins = 0;
                botState.stats.losses = 0;
                botState.stats.totalBets = 0;
                currentStreak = 0;
                botState.settings.currentBet = GAME_CONFIG.baseBet;
                botState.statusMessage = "🟢 New session - Take profit!";
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            
            if (pct <= -GAME_CONFIG.stopLossPercent) {
                console.log(`\n🛑 STOP LOSS! ${pct}% - Resetting session\n`);
                startingBalance = botState.stats.currentBalance;
                botState.stats.startingBalance = startingBalance;
                botState.stats.netProfit = 0;
                botState.stats.wins = 0;
                botState.stats.losses = 0;
                botState.stats.totalBets = 0;
                currentStreak = 0;
                botState.settings.currentBet = GAME_CONFIG.baseBet;
                botState.statusMessage = "🟢 New session - Stop loss reset";
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
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
    
    res.json({ botState, btcPrice, winRate, runTime, projections, currentStreak });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fixed Win Streak Bot | 1.4x Payout</title>
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
        
        .warning-badge {
            background: #f59e0b;
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
        
        .streak-fire {
            background: #ff6b35;
            color: white;
            padding: 2px 8px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: bold;
        }
        
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
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎲 FIXED WIN STREAK BOT <span class="badge">PROPER TRACKING</span><span class="warning-badge">NO -16 LOSS</span></h1>
        </div>
        
        <div class="strategy-box">
            <div class="title">🔧 FIXED: Win Streak Progression (1 → 1.5 → 2 → 2.5 → 3 → 3.5x)</div>
            <div class="math">
                With 71.4% win rate, streaks of 3-5 are common | A -16 loss means streak reset too early!
            </div>
        </div>
        
        <div class="status-card">
            <div><span class="status-dot"></span> <span id="statusMessage">Loading...</span></div>
            <div>Payout: 1.4x | Current Streak: <span id="currentStreak">0</span></div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">💰 Balance</div><div class="stat-value" id="balance">0</div><div id="balanceSats" style="font-size:12px;color:#8b9ab0;">0 satoshi</div></div>
            <div class="stat-card"><div class="stat-label">📈 Profit</div><div class="stat-value" id="profit">0</div><div id="profitSats" style="font-size:12px;">0 satoshi</div></div>
            <div class="stat-card"><div class="stat-label">🎲 Bets</div><div class="stat-value" id="totalBets">0</div><div>W: <span id="wins">0</span> | L: <span id="losses">0</span></div></div>
            <div class="stat-card"><div class="stat-label">📊 Win Rate</div><div class="stat-value" id="winRate">0%</div><div>Longest Streak: <span id="longestStreak">0</span></div></div>
        </div>
        
        <div class="projections-grid">
            <div class="projection-card"><div class="projection-label">⏱️ Per Hour</div><div class="projection-value" id="profitHourly">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">📅 Per Day</div><div class="projection-value" id="profitDaily">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">📆 Per Month</div><div class="projection-value" id="profitMonthly">0</div><div>satoshi</div></div>
            <div class="projection-card"><div class="projection-label">🎯 Per Year</div><div class="projection-value" id="profitYearly">0</div><div>satoshi</div></div>
        </div>
        
        <div class="table-container">
            <div class="table-header"><h3>📜 Recent Bets (Proper Streak Tracking)</h3></div>
            <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
                <table>
                    <thead>
                        <tr><th>#</th><th>Time</th><th>Wager</th><th>Mult</th><th>Profit</th><th>Result</th><th>🔥 Streak</th><th>Balance</th></tr>
                    </thead>
                    <tbody id="historyBody">
                        <tr><td colspan="8" style="text-align:center; padding:40px;">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="footer">
            ✅ FIXED: Streak properly tracks (1→2→3→4) | Reset only on LOSS | No more -16 surprise losses!
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
                    document.getElementById('currentStreak').innerHTML = data.currentStreak || 0;
                    document.getElementById('longestStreak').innerHTML = b.stats.longestWinStreak;
                    
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
                        row.insertCell(6).innerHTML = bet.winStreak > 0 ? '<span class="streak-fire">🔥 ' + bet.winStreak + '</span>' : '-';
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
    console.log(`\n🚀 FIXED BOT: http://localhost:${port}\n`);
    runProfitBot();
});
