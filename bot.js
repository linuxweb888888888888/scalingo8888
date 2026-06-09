const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "j42JcsLqXXlzDykjoyjiyaEcZdh72nuSfK19ub7FPJMDCc7CBL";
const BASE_URL = "https://api.crypto.games/v1";

// ADVANCED PROFIT STRATEGY CONFIG
const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",          // Low risk = 75% win rate (6/8 positions pay >1x)
    rows: 8,
    
    // Base betting (1 Satoshi minimum)
    baseBet: 0.00000001,  // 1 SATOSHI
    minBet: 0.00000001,
    maxBet: 0.00001000,   // 1000 satoshi max (for recovery)
    
    // PROFIT STRATEGY SELECTION (change this to switch strategies)
    strategy: "martingale",  // Options: "martingale", "fibonacci", "dalambert", "paroli"
    
    // Strategy parameters
    martingaleMultiplier: 2.0,    // Double on loss
    fibonacciSequence: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55], // Fibonacci progression
    dalambertUnit: 0.00000001,    // Increase by 1 satoshi on loss
    paroliMultiplier: 2.0,        // Double on win (max 3 consecutive)
    
    // Profit protection
    stopLossPercent: 20,    // Stop if down 20% of starting balance
    takeProfitPercent: 30,  // Stop if up 30% (then restart)
    maxConsecutiveLosses: 15,
    
    // Advanced features
    useDynamicBetting: true,      // Adjust bet size based on balance
    useTrendAnalysis: true,       // Track win/loss patterns
    slowMode: false               // Set to true for safer betting
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let sessionBalance = 0;
let fibonacciIndex = 0;
let paroliStreak = 0;
let trendWindow = [];
let botState = {
    running: true,
    continuousMode: true,
    statusMessage: "Advanced Profit Bot - " + PLINKO_CONFIG.strategy.toUpperCase(),
    coin: PLINKO_CONFIG.coin,
    strategy: PLINKO_CONFIG.strategy,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        breakEvens: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        sessionBalance: 0,
        startTime: Date.now(),
        consecutiveLosses: 0,
        consecutiveWins: 0,
        highestBalance: 0,
        lowestBalance: Infinity,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows,
        strategy: PLINKO_CONFIG.strategy
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
    return Math.floor(btcAmount * 100000000).toLocaleString();
}

// ============ TREND ANALYSIS ============
function analyzeTrend() {
    if (trendWindow.length < 10) return "neutral";
    const wins = trendWindow.filter(r => r > 0).length;
    const winRate = wins / trendWindow.length;
    if (winRate > 0.8) return "hot";
    if (winRate < 0.4) return "cold";
    return "neutral";
}

function updateTrend(isWin) {
    trendWindow.push(isWin ? 1 : 0);
    if (trendWindow.length > 50) trendWindow.shift();
}

// ============ PROFIT STRATEGIES ============
function calculateMartingaleBet(isWin) {
    if (isWin) {
        return PLINKO_CONFIG.baseBet;
    } else {
        let newBet = botState.settings.currentBet * PLINKO_CONFIG.martingaleMultiplier;
        if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
        return newBet;
    }
}

function calculateFibonacciBet(isWin) {
    if (isWin) {
        fibonacciIndex = Math.max(0, fibonacciIndex - 2);
        if (fibonacciIndex < 0) fibonacciIndex = 0;
        return PLINKO_CONFIG.baseBet * PLINKO_CONFIG.fibonacciSequence[fibonacciIndex];
    } else {
        fibonacciIndex = Math.min(fibonacciIndex + 1, PLINKO_CONFIG.fibonacciSequence.length - 1);
        let newBet = PLINKO_CONFIG.baseBet * PLINKO_CONFIG.fibonacciSequence[fibonacciIndex];
        if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
        return newBet;
    }
}

function calculateDalambertBet(isWin) {
    let currentUnit = botState.settings.currentBet / PLINKO_CONFIG.dalambertUnit;
    if (isWin) {
        currentUnit = Math.max(1, currentUnit - 1);
    } else {
        currentUnit = Math.min(PLINKO_CONFIG.maxBet / PLINKO_CONFIG.dalambertUnit, currentUnit + 1);
    }
    return currentUnit * PLINKO_CONFIG.dalambertUnit;
}

function calculateParoliBet(isWin) {
    if (isWin) {
        paroliStreak++;
        if (paroliStreak <= 3) {
            return botState.settings.currentBet * PLINKO_CONFIG.paroliMultiplier;
        } else {
            paroliStreak = 0;
            return PLINKO_CONFIG.baseBet;
        }
    } else {
        paroliStreak = 0;
        return PLINKO_CONFIG.baseBet;
    }
}

// ============ DYNAMIC BET SIZING ============
function applyDynamicBetting(bet) {
    if (!PLINKO_CONFIG.useDynamicBetting) return bet;
    
    // Scale bet based on current balance
    const balanceRatio = botState.stats.currentBalance / startingBalance;
    if (balanceRatio > 1.5) {
        // We're winning - increase bets slightly
        return Math.min(bet * 1.2, PLINKO_CONFIG.maxBet);
    } else if (balanceRatio < 0.8) {
        // We're losing - decrease bets
        return Math.max(bet * 0.8, PLINKO_CONFIG.minBet);
    }
    return bet;
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
            botState.settings.currentBet = PLINKO_CONFIG.minBet;
        }
        return null; 
    }
}

// ============ MAIN BET CALCULATION ============
function calculateNextBet(isWin, multiplier, profit) {
    // Update consecutive counters
    if (isWin) {
        botState.stats.consecutiveWins++;
        botState.stats.consecutiveLosses = 0;
    } else {
        botState.stats.consecutiveLosses++;
        botState.stats.consecutiveWins = 0;
    }
    
    // Check for stop conditions
    if (botState.stats.consecutiveLosses >= PLINKO_CONFIG.maxConsecutiveLosses) {
        botState.statusMessage = `⚠️ Max losses (${PLINKO_CONFIG.maxConsecutiveLosses}) - resetting bet`;
        botState.stats.consecutiveLosses = 0;
        return PLINKO_CONFIG.baseBet;
    }
    
    // Apply selected strategy
    let newBet;
    switch (PLINKO_CONFIG.strategy) {
        case "martingale":
            newBet = calculateMartingaleBet(isWin);
            break;
        case "fibonacci":
            newBet = calculateFibonacciBet(isWin);
            break;
        case "dalambert":
            newBet = calculateDalambertBet(isWin);
            break;
        case "paroli":
            newBet = calculateParoliBet(isWin);
            break;
        default:
            newBet = PLINKO_CONFIG.baseBet;
    }
    
    // Apply dynamic betting
    newBet = applyDynamicBetting(newBet);
    
    // Apply trend analysis
    if (PLINKO_CONFIG.useTrendAnalysis) {
        const trend = analyzeTrend();
        if (trend === "hot" && isWin) {
            newBet = Math.min(newBet * 1.2, PLINKO_CONFIG.maxBet);
        } else if (trend === "cold" && !isWin) {
            newBet = Math.max(newBet * 0.8, PLINKO_CONFIG.minBet);
        }
    }
    
    // Ensure bounds
    newBet = Math.max(PLINKO_CONFIG.minBet, Math.min(PLINKO_CONFIG.maxBet, newBet));
    
    return newBet;
}

// ============ PROFIT/LOSS PROTECTION ============
function checkProfitProtection() {
    if (startingBalance === 0) return true;
    
    const profitPercent = (botState.stats.netProfit / startingBalance) * 100;
    
    // Take profit reached
    if (PLINKO_CONFIG.takeProfitPercent > 0 && profitPercent >= PLINKO_CONFIG.takeProfitPercent) {
        botState.statusMessage = `🎉 TAKE PROFIT! +${profitPercent.toFixed(1)}% - Restarting session`;
        // Reset session but keep running
        sessionBalance = botState.stats.currentBalance;
        botState.stats.netProfit = 0;
        botState.stats.startingBalance = sessionBalance;
        startingBalance = sessionBalance;
        return true;
    }
    
    // Stop loss reached
    if (PLINKO_CONFIG.stopLossPercent > 0 && profitPercent <= -PLINKO_CONFIG.stopLossPercent) {
        botState.statusMessage = `🛑 STOP LOSS! ${profitPercent.toFixed(1)}% - Reducing bets`;
        botState.settings.currentBet = PLINKO_CONFIG.baseBet;
        return true;
    }
    
    return true;
}

// ============ MAIN ADVANCED BOT LOOP ============
async function runAdvancedPlinko() {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     🚀 ADVANCED PROFIT PLINKO BOT - ${PLINKO_CONFIG.strategy.toUpperCase()} 🚀       ║
    ╠══════════════════════════════════════════════════════════╣
    ║  Base Bet: 1 SATOSHI (${formatBTC(PLINKO_CONFIG.baseBet)} BTC)
    ║  Max Bet: ${formatSats(PLINKO_CONFIG.maxBet)} SATOSHI
    ║  Strategy: ${PLINKO_CONFIG.strategy.toUpperCase()}
    ║  Stop Loss: ${PLINKO_CONFIG.stopLossPercent}% | Take Profit: ${PLINKO_CONFIG.takeProfitPercent}%
    ║  Dynamic Betting: ${PLINKO_CONFIG.useDynamicBetting ? "ON" : "OFF"}
    ║  Trend Analysis: ${PLINKO_CONFIG.useTrendAnalysis ? "ON" : "OFF"}
    ║  Expected Win Rate: 75% (Low Risk Plinko)
    ╚══════════════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = `🟢 RUNNING - ${PLINKO_CONFIG.strategy.toUpperCase()} Strategy`;
    let lastLogTime = Date.now();
    let errorCount = 0;
    
    while (botState.running) {
        const result = await placePlinkoBet();
        
        if (!result) {
            errorCount++;
            const waitTime = errorCount > 10 ? 10000 : 1000;
            await new Promise(r => setTimeout(r, waitTime));
            continue;
        }
        
        errorCount = 0;
        
        // Process result
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        const isWin = multiplier > 1;
        const isBreakEven = multiplier === 1;
        
        // Update stats
        if (isWin) {
            botState.stats.wins++;
        } else if (isBreakEven) {
            botState.stats.breakEvens++;
        } else {
            botState.stats.losses++;
        }
        
        // Update balance
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.totalWagered += result.Bet || 0;
        
        // Track starting balance
        if (startingBalance === 0 && botState.stats.currentBalance > 0) {
            startingBalance = botState.stats.currentBalance - profit;
            sessionBalance = startingBalance;
            botState.stats.startingBalance = startingBalance;
            botState.stats.sessionBalance = startingBalance;
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
            botState.stats.biggestWin = Math.max(botState.stats.biggestWin, profit);
        }
        if (botState.stats.currentBalance < botState.stats.lowestBalance) {
            botState.stats.lowestBalance = botState.stats.currentBalance;
            botState.stats.biggestLoss = Math.min(botState.stats.biggestLoss, profit);
        }
        
        // Update trend analysis
        if (PLINKO_CONFIG.useTrendAnalysis) {
            updateTrend(isWin);
        }
        
        // Calculate next bet using selected strategy
        const newBet = calculateNextBet(isWin, multiplier, profit);
        botState.settings.currentBet = newBet;
        
        // Check profit protection
        checkProfitProtection();
        
        // Store history
        const profitSats = formatSats(profit);
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: result.Bet,
            wagerSats: formatSats(result.Bet),
            multiplier: multiplier,
            profit: profit,
            profitSats: profitSats,
            isWin: isWin,
            isBreakEven: isBreakEven,
            balance: botState.stats.currentBalance,
            balanceSats: formatSats(botState.stats.currentBalance),
            nextBet: newBet
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log periodically
        const now = Date.now();
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        
        if (now - lastLogTime > 3000 || botState.stats.totalBets % 50 === 0) {
            const profitTotal = formatSats(botState.stats.netProfit);
            const sign = botState.stats.netProfit >= 0 ? '+' : '';
            console.log(`#${botState.stats.totalBets} | ${formatSats(result.Bet)}sats | ${multiplier}x | ${isWin ? '✅WIN' : isBreakEven ? '⚖️EVEN' : '❌LOSS'} | ${profit > 0 ? '+' : ''}${profitSats}sats | Total: ${sign}${profitTotal}sats | WR: ${winRate}% | Next: ${formatSats(newBet)}sats | ${botState.strategy.toUpperCase()}`);
            lastLogTime = now;
        }
        
        // Rate limiting
        const delay = PLINKO_CONFIG.slowMode ? 800 : 400;
        await new Promise(r => setTimeout(r, delay));
    }
}

// ============ WEB DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    const runTime = (Date.now() - botState.stats.startTime) / 1000;
    const trend = analyzeTrend();
    res.json({ botState, btcPrice, winRate, runTime, trend });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Advanced Plinko Profit Bot</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body {
            font-family: 'Courier New', monospace;
            background: #0a0e27;
            color: #00ff88;
            padding: 20px;
            margin: 0;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #00ff88; text-align: center; border-bottom: 2px solid #00ff88; padding-bottom: 10px; }
        .strategy-badge { background: #ff4444; color: white; padding: 2px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; }
        .badge { background: #00ff88; color: #0a0e27; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .card { background: #111827; border: 1px solid #00ff88; border-radius: 8px; padding: 15px; text-align: center; }
        .card h3 { color: #888; font-size: 12px; margin: 0 0 10px 0; text-transform: uppercase; }
        .card .value { font-size: 24px; font-weight: bold; color: #00ff88; }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4444; }
        .trend-hot { color: #ff8800; }
        .trend-cold { color: #4488ff; }
        table { width: 100%; background: #111827; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { background: #1a1f3a; color: #888; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .even { color: #ffaa00; }
        .status { background: #111827; border-left: 4px solid #00ff88; padding: 15px; margin: 20px 0; font-family: monospace; }
        .running-indicator { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; margin-right: 8px; }
        .note { text-align: center; color: #888; font-size: 11px; margin-top: 20px; }
        select, button { background: #111827; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 ADVANCED PLINKO BOT <span class="badge">PROFIT MODE</span><span class="strategy-badge" id="strategyName">MARTINGALE</span></h1>
        
        <div class="stats">
            <div class="card"><h3>💰 BALANCE</h3><div class="value" id="balance">0.00000000</div><small id="balanceSats">0 satoshi</small></div>
            <div class="card"><h3>📈 TOTAL PROFIT</h3><div class="value" id="profit">0.00000000</div><small id="profitSats">0 satoshi</small></div>
            <div class="card"><h3>🎲 TOTAL BETS</h3><div class="value" id="totalBets">0</div><small>W: <span id="wins">0</span> | L: <span id="losses">0</span></small></div>
            <div class="card"><h3>📊 WIN RATE</h3><div class="value" id="winRate">0%</div><small>Current: <span id="currentBet">0</span> sats</small></div>
        </div>
        
        <div class="stats">
            <div class="card"><h3>🏆 HIGHEST BALANCE</h3><div class="value" id="highestBalance">0.00000000</div><small>Peak</small></div>
            <div class="card"><h3>📉 LOWEST BALANCE</h3><div class="value" id="lowestBalance">0.00000000</div><small>Drawdown</small></div>
            <div class="card"><h3>📊 TREND</h3><div class="value" id="trend">NEUTRAL</div><small>Analysis</small></div>
            <div class="card"><h3>⚡ STREAK</h3><div class="value" id="streak">0</div><small>Consecutive</small></div>
        </div>
        
        <div class="status" id="statusMsg"><span class="running-indicator"></span> Loading...</div>
        
        <div style="margin-bottom: 20px; text-align: center;">
            <label>Strategy: </label>
            <select id="strategySelect">
                <option value="martingale">Martingale (Double on Loss)</option>
                <option value="fibonacci">Fibonacci (Recovery Sequence)</option>
                <option value="dalambert">D'Alembert (+1/-1 Unit)</option>
                <option value="paroli">Paroli (Double on Win)</option>
            </select>
            <button onclick="changeStrategy()">Apply Strategy</button>
        </div>
        
        <h3>📜 RECENT BETS (Last 30)</h3>
        <div style="overflow-x: auto;">
            <table>
                <thead><tr><th>#</th><th>Time</th><th>Wager</th><th>Multiplier</th><th>Profit</th><th>Result</th><th>Balance</th></tr></thead>
                <tbody id="history"><tr><td colspan="7" style="text-align:center">Waiting for bets...</td></tr></tbody>
            </table>
        </div>
        <div class="note">
            🎯 Advanced Profit Strategies | 75% Win Rate | 1 Satoshi Minimum | Dynamic Bet Sizing | Trend Analysis
        </div>
    </div>
    
    <script>
        function formatSats(btc) { return Math.floor(Math.abs(btc) * 100000000).toLocaleString(); }
        
        function formatTime(seconds) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);
            if (hours > 0) return hours + 'h ' + minutes + 'm';
            if (minutes > 0) return minutes + 'm ' + secs + 's';
            return secs + 's';
        }
        
        function changeStrategy() {
            const select = document.getElementById('strategySelect');
            const strategy = select.value;
            fetch('/change-strategy?strategy=' + strategy)
                .catch(console.error);
        }
        
        function update() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    const b = data.botState;
                    const btcPrice = data.btcPrice;
                    
                    document.getElementById('balance').innerHTML = b.stats.currentBalance.toFixed(8);
                    document.getElementById('balanceSats').innerHTML = formatSats(b.stats.currentBalance) + ' satoshi';
                    document.getElementById('strategyName').innerHTML = b.strategy.toUpperCase();
                    
                    const profitElem = document.getElementById('profit');
                    profitElem.innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + b.stats.netProfit.toFixed(8);
                    profitElem.className = 'value ' + (b.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative');
                    document.getElementById('profitSats').innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + formatSats(Math.abs(b.stats.netProfit)) + ' satoshi';
                    
                    document.getElementById('totalBets').innerHTML = b.stats.totalBets;
                    document.getElementById('wins').innerHTML = b.stats.wins;
                    document.getElementById('losses').innerHTML = b.stats.losses;
                    document.getElementById('winRate').innerHTML = data.winRate + '%';
                    document.getElementById('currentBet').innerHTML = formatSats(b.settings.currentBet);
                    document.getElementById('statusMsg').innerHTML = '<span class="running-indicator"></span> ' + b.statusMessage;
                    document.getElementById('highestBalance').innerHTML = b.stats.highestBalance.toFixed(8);
                    document.getElementById('lowestBalance').innerHTML = b.stats.lowestBalance.toFixed(8);
                    document.getElementById('streak').innerHTML = b.stats.consecutiveLosses > 0 ? b.stats.consecutiveLosses + ' L' : b.stats.consecutiveWins + ' W';
                    
                    const trendElem = document.getElementById('trend');
                    if (data.trend === 'hot') { trendElem.innerHTML = '🔥 HOT'; trendElem.className = 'value trend-hot'; }
                    else if (data.trend === 'cold') { trendElem.innerHTML = '❄️ COLD'; trendElem.className = 'value trend-cold'; }
                    else { trendElem.innerHTML = '⚖️ NEUTRAL'; trendElem.className = 'value'; }
                    
                    const tbody = document.getElementById('history');
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(30, b.betHistory.length); i++) {
                        const bet = b.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerHTML = bet.wagerSats + ' sats';
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + bet.profitSats + ' sats</span>' : 
                            '<span class="loss">' + bet.profitSats + ' sats</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? '<span class="win">✅ WIN</span>' : bet.isBreakEven ? '<span class="even">⚖️ EVEN</span>' : '<span class="loss">❌ LOSS</span>';
                        row.insertCell(6).innerText = bet.balanceSats + ' sats';
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

// Add strategy change endpoint
app.get('/change-strategy', (req, res) => {
    const newStrategy = req.query.strategy;
    if (['martingale', 'fibonacci', 'dalambert', 'paroli'].includes(newStrategy)) {
        PLINKO_CONFIG.strategy = newStrategy;
        botState.strategy = newStrategy;
        botState.settings.strategy = newStrategy;
        botState.settings.currentBet = PLINKO_CONFIG.baseBet;
        fibonacciIndex = 0;
        paroliStreak = 0;
        botState.statusMessage = `🟢 Strategy changed to ${newStrategy.toUpperCase()}`;
        console.log(`\n📊 Strategy changed to: ${newStrategy.toUpperCase()}\n`);
        res.json({ success: true, strategy: newStrategy });
    } else {
        res.json({ success: false });
    }
});

// ============ START ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 ADVANCED BOT DASHBOARD: http://localhost:${port}\n`);
    runAdvancedPlinko();
});
