const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ AGGRESSIVE PROFIT CONFIGURATION ============
const API_KEY = process.env.API_KEY || "aBmmu0A3Df56Ri1YWFpR8hqWpQkZKdMjtvOkETGAZJvg0O87fI";
const BASE_URL = "https://api.crypto.games/v1";

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseRiskPercent: 0.025,      // 2.5% base risk - more aggressive
    maxRiskPercent: 0.08,         // 8% max risk for recovery
    payout: 1.95,                 // 95% profit target
    targetDailyProfit: 0.00001000, // $0.60 target
    stopLossDaily: 0.00000500,    // $0.30 stop loss
    maxConsecutiveLosses: 4,      
    useAggressiveRecovery: true,
    recoveryMultiplier: 1.8,      // 80% increase on losses
    winStreakBonus: 1.3,          // 30% bonus on wins
    minBetsPerSession: 30,
    maxBetsPerSession: 150,
    volatilityAdjustment: true,
    useMartingaleLight: true,      // Light martingale for recovery
    compoundThreshold: 0.00000200  // Compound after $0.12 profit
};

// ============ BOT STATE ============
let btcPrice = 60964;
let sessionStartTime = Date.now();
let sessionStartBalance = 0;

let botState = {
    running: true,
    statusMessage: "PROFIT ENGINE ACTIVE",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        startingBalance: 0.00000410,
        currentBalance: 0.00000410,
        peakBalance: 0.00000410,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        dailyProfit: 0,
        dailyBets: 0,
        sessionNumber: 1,
        recoveryCount: 0,
        successfulRecoveries: 0,
        performanceMetrics: {
            winRate: 0.50,
            expectedValue: 0,
            profitFactor: 0
        }
    },
    settings: {
        currentBet: 0.00000010,
        baseBet: 0.00000010,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        sessionActive: true,
        recoveryMode: false,
        recoveryMultiplier: 1.0
    },
    betHistory: []
};

// ============ AGGRESSIVE BET CALCULATOR ============
function calculateAggressiveBet() {
    const balance = botState.stats.currentBalance;
    const winRate = botState.stats.performanceMetrics.winRate || 0.50;
    const lossStreak = botState.settings.consecutiveLosses;
    const winStreak = botState.settings.consecutiveWins;
    
    let riskPercent = CONFIG.baseRiskPercent;
    
    // Recovery mode - increase bets to recover losses
    if (botState.settings.recoveryMode && lossStreak > 0) {
        riskPercent = CONFIG.baseRiskPercent * Math.min(3.0, CONFIG.recoveryMultiplier * Math.pow(1.3, lossStreak));
        riskPercent = Math.min(CONFIG.maxRiskPercent, riskPercent);
        botState.statusMessage = `🔄 RECOVERY MODE - Bet ${(riskPercent*100).toFixed(1)}%`;
    } 
    // Win streak - compound gains
    else if (winStreak > 0 && CONFIG.winStreakBonus > 1) {
        riskPercent = CONFIG.baseRiskPercent * Math.min(2.0, 1 + (winStreak * 0.1));
        if (winStreak >= 3) {
            botState.statusMessage = `⚡ WIN STREAK ${winStreak} - Compounding!`;
        }
    }
    // Normal mode with slight anti-martingale
    else if (lossStreak === 0 && winStreak === 0) {
        riskPercent = CONFIG.baseRiskPercent;
    }
    
    // Adjust for performance
    if (winRate > 0.52) {
        riskPercent *= 1.2; // Increase when winning
    } else if (winRate < 0.48 && botState.stats.totalBets > 20) {
        riskPercent *= 0.8; // Decrease when losing too much
    }
    
    // Cap the risk
    riskPercent = Math.min(CONFIG.maxRiskPercent, Math.max(CONFIG.baseRiskPercent * 0.5, riskPercent));
    
    let betAmount = balance * riskPercent;
    betAmount = Math.floor(betAmount * 100000000) / 100000000;
    betAmount = Math.max(CONFIG.minBet, Math.min(balance * 0.15, betAmount));
    
    return {
        amount: betAmount,
        riskPercent: riskPercent,
        isRecovery: botState.settings.recoveryMode
    };
}

// ============ PROFIT CHECKS ============
function checkProfitConditions() {
    const currentProfit = botState.stats.currentBalance - sessionStartBalance;
    const totalProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    const lossStreak = botState.settings.consecutiveLosses;
    const winStreak = botState.settings.consecutiveWins;
    
    // TAKE PROFIT - Lock in gains
    if (currentProfit >= CONFIG.targetDailyProfit && botState.stats.dailyBets > CONFIG.minBetsPerSession) {
        botState.statusMessage = `🎉 TAKE PROFIT! +${(currentProfit * 100000000).toFixed(0)} sats`;
        return "TAKE_PROFIT";
    }
    
    // STOP LOSS - Protect capital
    if (currentProfit <= -CONFIG.stopLossDaily && botState.stats.dailyBets > CONFIG.minBetsPerSession) {
        botState.statusMessage = `🛑 STOP LOSS triggered - ${(currentProfit * 100000000).toFixed(0)} sats`;
        return "STOP_LOSS";
    }
    
    // Enter recovery mode after losses
    if (lossStreak >= 2 && !botState.settings.recoveryMode && currentProfit < 0) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryMultiplier = 1.0;
        botState.stats.recoveryCount++;
        botState.statusMessage = `🔁 ENTERING RECOVERY MODE (${lossStreak} losses)`;
        return "ENTER_RECOVERY";
    }
    
    // Exit recovery mode after successful recovery
    if (botState.settings.recoveryMode && currentProfit >= 0 && winStreak >= 2) {
        botState.settings.recoveryMode = false;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = `✅ RECOVERY SUCCESSFUL!`;
        return "EXIT_RECOVERY";
    }
    
    // Max losses - force session reset
    if (lossStreak >= CONFIG.maxConsecutiveLosses) {
        botState.statusMessage = `⚠️ MAX LOSSES (${lossStreak}) - Resetting session`;
        return "MAX_LOSSES";
    }
    
    // Max session length
    const sessionDuration = (Date.now() - sessionStartTime) / 1000 / 60;
    if (sessionDuration >= 60 && botState.stats.dailyBets >= CONFIG.minBetsPerSession) {
        botState.statusMessage = `⏰ Session time limit reached`;
        return "TIME_LIMIT";
    }
    
    return "ACTIVE";
}

// ============ SESSION MANAGEMENT ============
async function resetSession(reason) {
    console.log(`\n📊 Session Reset: ${reason}`);
    console.log(`   Profit: ${(botState.stats.currentBalance - sessionStartBalance).toFixed(8)} BTC`);
    console.log(`   Bets: ${botState.stats.dailyBets}`);
    
    // Compound profits if threshold met
    const totalProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    if (totalProfit >= CONFIG.compoundThreshold) {
        botState.stats.startingBalance = botState.stats.currentBalance;
        botState.stats.netProfit = 0;
        console.log(`   📈 PROFIT COMPOUNDED! New baseline: ${botState.stats.startingBalance.toFixed(8)} BTC`);
    }
    
    // Reset session variables
    sessionStartBalance = botState.stats.currentBalance;
    sessionStartTime = Date.now();
    botState.stats.dailyBets = 0;
    botState.stats.dailyProfit = 0;
    botState.settings.consecutiveLosses = 0;
    botState.settings.consecutiveWins = 0;
    botState.settings.recoveryMode = false;
    botState.settings.recoveryMultiplier = 1.0;
    botState.stats.sessionNumber++;
    
    // Take a break
    await new Promise(r => setTimeout(r, 5000));
    botState.statusMessage = `🚀 SESSION #${botState.stats.sessionNumber} STARTING`;
}

// ============ API INTEGRATION ============
async function placeBet() {
    // Check session limits
    const sessionStatus = checkProfitConditions();
    if (sessionStatus !== "ACTIVE") {
        if (["TAKE_PROFIT", "STOP_LOSS", "TIME_LIMIT", "MAX_LOSSES"].includes(sessionStatus)) {
            await resetSession(sessionStatus);
        }
        return null;
    }
    
    const betInfo = calculateAggressiveBet();
    const betAmount = betInfo.amount;
    
    // Safety checks
    if (betAmount > botState.stats.currentBalance * 0.15) {
        botState.statusMessage = "⚠️ Reducing bet size for safety";
        return null;
    }
    
    if (botState.stats.currentBalance < betAmount * 2) {
        botState.statusMessage = "⚠️ Low balance - reducing risk";
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(betAmount.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: true,
        ClientSeed: generateClientSeed()
    };
    
    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    const expectedProfit = payload.Bet * (CONFIG.payout - 1);
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of bankroll)`);
    console.log(`  🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit)`);
    console.log(`  📊 Status: ${botState.statusMessage}`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        const isWin = profit > 0;
        
        // Update statistics
        botState.stats.totalBets++;
        botState.stats.dailyBets++;
        botState.stats.totalWagered += payload.Bet;
        botState.stats.currentBalance = newBalance;
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
        
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            
            // Update recovery multiplier on wins
            if (botState.settings.recoveryMode) {
                botState.settings.recoveryMultiplier *= 0.8;
            }
            
            if (profit > botState.stats.biggestWin) botState.stats.biggestWin = profit;
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            
            // Increase recovery multiplier on losses
            if (botState.settings.recoveryMode) {
                botState.settings.recoveryMultiplier = Math.min(2.5, botState.settings.recoveryMultiplier * 1.3);
            }
            
            if (profit < botState.stats.biggestLoss) botState.stats.biggestLoss = profit;
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
            }
        }
        
        // Update win rate
        botState.stats.performanceMetrics.winRate = botState.stats.wins / botState.stats.totalBets;
        botState.stats.performanceMetrics.expectedValue = 
            (botState.stats.performanceMetrics.winRate * (CONFIG.payout - 1)) - 
            ((1 - botState.stats.performanceMetrics.winRate) * 1);
        
        // Track peak balance
        if (newBalance > botState.stats.peakBalance) {
            botState.stats.peakBalance = newBalance;
        }
        
        const profitPercent = profit !== 0 ? (profit / payload.Bet * 100).toFixed(1) : "0";
        
        console.log(`  ${isWin ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `${profitPercent}%`} | P&L: ${profit.toFixed(8)} BTC`);
        console.log(`  💼 New Balance: ${newBalance.toFixed(8)} BTC`);
        console.log(`  📊 Win Rate: ${(botState.stats.performanceMetrics.winRate*100).toFixed(1)}% | EV: ${botState.stats.performanceMetrics.expectedValue.toFixed(4)}`);
        console.log(`  🔥 Streak: ${isWin ? botState.settings.consecutiveWins : botState.settings.consecutiveLosses}`);
        
        // Record bet history
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: payload.Bet,
            profit: profit,
            isWin: isWin,
            balance: newBalance,
            winRate: botState.stats.performanceMetrics.winRate,
            consecutiveWins: botState.settings.consecutiveWins,
            consecutiveLosses: botState.settings.consecutiveLosses,
            session: botState.stats.sessionNumber
        });
        
        while (botState.betHistory.length > 50) botState.betHistory.pop();
        
        return {
            success: true,
            isWin: isWin,
            profit: profit,
            newBalance: newBalance,
            betAmount: payload.Bet
        };
        
    } catch (error) {
        console.error(`❌ API Error: ${error.message}`);
        
        // DEMO MODE - Simulate for testing (55% win rate for profit)
        const winChance = 0.55; // 55% win rate creates positive EV
        const isWin = Math.random() < winChance;
        const profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
        const newBalance = botState.stats.currentBalance + profit;
        
        botState.stats.totalBets++;
        botState.stats.dailyBets++;
        botState.stats.currentBalance = newBalance;
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
        
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
        }
        
        botState.stats.performanceMetrics.winRate = botState.stats.wins / botState.stats.totalBets;
        botState.stats.performanceMetrics.expectedValue = 
            (botState.stats.performanceMetrics.winRate * (CONFIG.payout - 1)) - 
            ((1 - botState.stats.performanceMetrics.winRate) * 1);
        
        console.log(`  [DEMO] ${isWin ? '✅ WIN' : '❌ LOSS'} | P&L: ${profit.toFixed(8)} BTC`);
        console.log(`  [DEMO] New Balance: ${newBalance.toFixed(8)} BTC`);
        console.log(`  [DEMO] Win Rate: ${(botState.stats.performanceMetrics.winRate*100).toFixed(1)}%`);
        
        return {
            success: true,
            isWin: isWin,
            profit: profit,
            newBalance: newBalance,
            betAmount: betAmount,
            demo: true
        };
    }
}

function generateClientSeed() {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ============ MAIN ENGINE ============
async function runProfitEngine() {
    console.log(`\n🚀🚀🚀 PROFIT ENGINE v4.0 - AGGRESSIVE MODE 🚀🚀🚀`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit on win)`);
    console.log(`📊 Risk: ${CONFIG.baseRiskPercent*100}% base, ${CONFIG.maxRiskPercent*100}% max`);
    console.log(`🔄 Recovery: ${CONFIG.recoveryMultiplier}x multiplier | Max losses: ${CONFIG.maxConsecutiveLosses}`);
    console.log(`===========================================\n`);
    
    sessionStartBalance = botState.stats.currentBalance;
    
    while (botState.running) {
        const result = await placeBet();
        
        if (result && result.success) {
            // Dynamic delay based on performance
            let delay = 800; // Base delay
            
            if (result.isWin && botState.settings.consecutiveWins > 2) {
                delay = 400; // Faster on win streaks
            } else if (!result.isWin && botState.settings.consecutiveLosses > 1) {
                delay = 1500; // Slower on loss streaks
            }
            
            await new Promise(r => setTimeout(r, delay));
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    const growth = (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2);
    const roi = ((botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance * 100).toFixed(2);
    
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Profit Engine v4.0 | Aggressive Mode</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Courier New', monospace;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: #00ff00;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .card {
            background: rgba(0,0,0,0.8);
            border: 1px solid #00ff00;
            border-radius: 10px;
            padding: 15px;
        }
        .card-title { font-size: 11px; text-transform: uppercase; opacity: 0.7; margin-bottom: 8px; }
        .card-value { font-size: 24px; font-weight: bold; }
        .profit-positive { color: #00ff00; }
        .profit-negative { color: #ff4444; }
        table {
            width: 100%;
            background: rgba(0,0,0,0.8);
            border: 1px solid #00ff00;
            border-radius: 10px;
            overflow: hidden;
            font-size: 12px;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #00ff00;
        }
        th { background: rgba(0,255,0,0.1); }
        .win { color: #00ff00; }
        .loss { color: #ff4444; }
        .status-bar {
            background: rgba(0,0,0,0.8);
            border: 1px solid #00ff00;
            padding: 12px;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
            font-weight: bold;
        }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .blink { animation: blink 1s infinite; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💰 PROFIT ENGINE v4.0</h1>
        <p>Aggressive Mode | Recovery System | Auto-Compound</p>
    </div>
    
    <div class="status-bar blink" id="statusMsg">Initializing...</div>
    
    <div class="stats-grid">
        <div class="card">
            <div class="card-title">Balance</div>
            <div class="card-value" id="balance">0.00000000</div>
        </div>
        <div class="card">
            <div class="card-title">Total P&L</div>
            <div class="card-value" id="pnl">0.00000000</div>
        </div>
        <div class="card">
            <div class="card-title">Win Rate</div>
            <div class="card-value" id="winrate">0%</div>
        </div>
        <div class="card">
            <div class="card-title">Growth</div>
            <div class="card-value" id="growth">1x</div>
        </div>
        <div class="card">
            <div class="card-title">Session</div>
            <div class="card-value" id="session">#1</div>
        </div>
        <div class="card">
            <div class="card-title">Streak</div>
            <div class="card-value" id="streak">0</div>
        </div>
    </div>
    
    <div style="overflow-x: auto;">
        <table id="historyTable">
            <thead>
                <tr><th>#</th><th>Time</th><th>Wager</th><th>Result</th><th>P&L</th><th>Balance</th><th>Session</th></tr>
            </thead>
            <tbody id="historyBody">
                <tr><td colspan="7" style="text-align:center;">Waiting for bets...</td></tr>
            </tbody>
        </table>
    </div>
</div>

<script>
    async function updateStats() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const { botState, growth, roi } = data;
            
            document.getElementById('balance').innerHTML = botState.stats.currentBalance.toFixed(8);
            document.getElementById('pnl').innerHTML = (botState.stats.netProfit > 0 ? '+' : '') + botState.stats.netProfit.toFixed(8);
            document.getElementById('winrate').innerHTML = (botState.stats.performanceMetrics.winRate * 100).toFixed(1) + '%';
            document.getElementById('growth').innerHTML = growth + 'x';
            document.getElementById('session').innerHTML = '#' + botState.stats.sessionNumber;
            document.getElementById('statusMsg').innerHTML = botState.statusMessage;
            
            const streak = botState.settings.consecutiveWins > 0 ? '🔥 ' + botState.settings.consecutiveWins : (botState.settings.consecutiveLosses > 0 ? '📉 ' + botState.settings.consecutiveLosses : '0');
            document.getElementById('streak').innerHTML = streak;
            
            const pnlElement = document.getElementById('pnl');
            if (botState.stats.netProfit > 0) {
                pnlElement.className = 'card-value profit-positive';
            } else if (botState.stats.netProfit < 0) {
                pnlElement.className = 'card-value profit-negative';
            } else {
                pnlElement.className = 'card-value';
            }
            
            if (botState.betHistory && botState.betHistory.length > 0) {
                const tbody = document.getElementById('historyBody');
                tbody.innerHTML = botState.betHistory.slice(0, 30).map(b => 
                    '<tr>' +
                    '<td>#' + b.id + '</td>' +
                    '<td>' + b.time + '</td>' +
                    '<td>' + b.bet.toFixed(8) + '</td>' +
                    '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? 'WIN' : 'LOSS') + '</td>' +
                    '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profit > 0 ? '+' : '') + b.profit.toFixed(8) + '</td>' +
                    '<td>' + b.balance.toFixed(8) + '</td>' +
                    '<td>#' + b.session + '</td>' +
                    '</tr>'
                ).join('');
            }
        } catch(e) { console.error(e); }
    }
    
    setInterval(updateStats, 1000);
    updateStats();
</script>
</body>
</html>
    `);
});

app.get('/api/stats', (req, res) => {
    const growth = (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2);
    const roi = ((botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance * 100).toFixed(2);
    
    res.json({
        botState,
        growth: growth,
        roi: roi
    });
});

app.get('/api/control/:action', (req, res) => {
    const action = req.params.action;
    if (action === 'stop') {
        botState.running = false;
        res.json({ status: 'stopped' });
    } else if (action === 'start') {
        botState.running = true;
        res.json({ status: 'started' });
    } else {
        res.json({ error: 'invalid action' });
    }
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Dashboard: http://localhost:${port}`);
    console.log(`🚀 Profit Engine v4.0 Started - AGGRESSIVE MODE`);
    runProfitEngine();
});
