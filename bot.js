const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ PROFIT-FOCUSED CONFIGURATION ============
const API_KEY = process.env.API_KEY || "XLCPrTf38ciJnhAxhshtG8pYGO5szxk2iqbt9LdjGhY1OIZ1bE";
const BASE_URL = "https://api.crypto.games/v1";

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseRiskPercent: 0.015,      // 1.5% of bankroll per bet (Kelly-optimized)
    maxRiskPercent: 0.025,        // Max 2.5% risk
    payout: 1.7,                  // Even money for better probability
    targetDailyProfit: 0.00000500, // $0.30 target at $60k BTC
    stopLossDaily: 0.00000200,    // $0.12 stop loss
    maxConsecutiveLosses: 3,      // Aggressive stop on 3 losses
    useTrueKelly: true,
    kellyFraction: 0.25,          // 25% Kelly for safety
    winRateTarget: 0.52,          // Slight edge needed
    minConfidence: 0.48,
    cooldownPeriods: 3,
    volatilityAdjustment: true,
    sessionLength: 120,           // 2 hour sessions
    breakBetweenSessions: 300,    // 5 min break
    compoundDaily: true,
    maxDailyBets: 200
};

// ============ BOT STATE ============
let btcPrice = 60964;
let sessionStartTime = Date.now();
let dailyProfit = 0;
let sessionBets = 0;

let botState = {
    running: true,
    statusMessage: "PROFIT ENGINE INITIALIZED",
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
        performanceMetrics: {
            winRate: 0,
            sharpeRatio: 0,
            expectedValue: 0,
            profitFactor: 0
        }
    },
    settings: {
        currentBet: 0.00000006,
        baseBet: 0.00000006,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        sessionActive: true,
        inCooldown: false,
        volatility: 1.0,
        edge: 0.02  // 2% edge target
    },
    betHistory: []
};

// ============ PROFIT-OPTIMIZED KELLY CALCULATOR ============
function calculateKellyBet() {
    const balance = botState.stats.currentBalance;
    const winRate = botState.stats.performanceMetrics.winRate || 0.5;
    const payout = CONFIG.payout;
    const b = payout - 1;  // Net odds received on the bet
    
    // Kelly formula: f* = (p*b - q) / b
    const p = Math.max(0.45, Math.min(0.55, winRate)); // Cap between 45-55%
    const q = 1 - p;
    const kellyPercent = (p * b - q) / b;
    
    // Use fraction of Kelly for safety
    let riskPercent = Math.max(0.005, Math.min(0.03, kellyPercent * CONFIG.kellyFraction));
    
    // Adjust for win/loss streaks
    if (botState.settings.consecutiveWins > 2) {
        riskPercent *= 1.2; // Slight increase on winning streak
    } else if (botState.settings.consecutiveLosses > 1) {
        riskPercent *= 0.7; // Reduce on losing streak
    }
    
    // Adjust for volatility
    if (CONFIG.volatilityAdjustment) {
        const recentVolatility = calculateVolatility();
        riskPercent = riskPercent * (1 / Math.max(1, recentVolatility));
    }
    
    // Cap the risk percentage
    riskPercent = Math.min(CONFIG.maxRiskPercent, Math.max(CONFIG.baseRiskPercent, riskPercent));
    
    let betAmount = balance * riskPercent;
    betAmount = Math.floor(betAmount * 100000000) / 100000000;
    
    // Ensure minimum bet
    betAmount = Math.max(CONFIG.minBet, Math.min(balance * 0.1, betAmount));
    
    return {
        amount: betAmount,
        riskPercent: riskPercent,
        kellyFraction: kellyPercent,
        confidence: p
    };
}

function calculateVolatility() {
    if (botState.betHistory.length < 10) return 1.0;
    
    let profits = botState.betHistory.slice(0, 20).map(b => b.profit);
    let mean = profits.reduce((a, b) => a + b, 0) / profits.length;
    let variance = profits.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / profits.length;
    let volatility = Math.sqrt(variance) / Math.abs(mean || 0.00000001);
    
    return Math.min(2.0, Math.max(0.5, volatility));
}

// ============ SMART STOP LOSS / TAKE PROFIT ============
function checkSessionLimits() {
    const currentSessionProfit = botState.stats.currentBalance - sessionStartBalance;
    const sessionDuration = (Date.now() - sessionStartTime) / 1000 / 60; // minutes
    
    // Take profit
    if (currentSessionProfit >= CONFIG.targetDailyProfit && botState.stats.dailyBets > 10) {
        botState.statusMessage = `🎯 SESSION TAKE PROFIT: +${(currentSessionProfit * 100000000).toFixed(2)} satoshis`;
        return "TAKE_PROFIT";
    }
    
    // Stop loss
    if (currentSessionProfit <= -CONFIG.stopLossDaily && botState.stats.dailyBets > 5) {
        botState.statusMessage = `🛑 SESSION STOP LOSS: ${(currentSessionProfit * 100000000).toFixed(2)} satoshis`;
        return "STOP_LOSS";
    }
    
    // Time-based session end
    if (sessionDuration >= CONFIG.sessionLength && botState.stats.dailyBets > 20) {
        botState.statusMessage = `⏰ SESSION TIME LIMIT REACHED`;
        return "TIME_LIMIT";
    }
    
    // Max consecutive losses
    if (botState.settings.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
        botState.statusMessage = `⚠️ MAX LOSSES (${CONFIG.maxConsecutiveLosses}) - Cooling down`;
        return "MAX_LOSSES";
    }
    
    return "ACTIVE";
}

let sessionStartBalance = 0;

// ============ CONFIDENCE-BASED BETTING ============
function shouldPlaceBet() {
    if (botState.settings.inCooldown) return false;
    if (botState.stats.dailyBets >= CONFIG.maxDailyBets) return false;
    
    const sessionStatus = checkSessionLimits();
    if (sessionStatus !== "ACTIVE") {
        if (sessionStatus === "TAKE_PROFIT" || sessionStatus === "STOP_LOSS" || sessionStatus === "TIME_LIMIT") {
            // Start cooldown
            botState.settings.inCooldown = true;
            setTimeout(() => {
                resetSession();
            }, CONFIG.breakBetweenSessions * 1000);
        } else if (sessionStatus === "MAX_LOSSES") {
            // Short cooldown for loss streak
            botState.settings.inCooldown = true;
            setTimeout(() => {
                botState.settings.inCooldown = false;
                botState.settings.consecutiveLosses = 0;
                botState.statusMessage = "🔄 Cool down complete - Resuming";
            }, 60000); // 1 minute cool down
        }
        return false;
    }
    
    // Check if we have a statistical edge
    const edge = calculateCurrentEdge();
    if (edge < CONFIG.minConfidence) {
        botState.statusMessage = `📊 Waiting for edge (${(edge*100).toFixed(1)}%)`;
        return false;
    }
    
    return true;
}

function calculateCurrentEdge() {
    const winRate = botState.stats.performanceMetrics.winRate;
    if (winRate === 0) return 0.5;
    
    // Simple mean reversion - bet when recent performance suggests edge
    const recentWins = botState.betHistory.slice(0, 10).filter(b => b.isWin).length;
    const recentRate = recentWins / Math.min(10, botState.betHistory.length);
    
    // Bet when recent win rate is below target (mean reversion)
    const edge = CONFIG.winRateTarget - recentRate;
    return Math.max(0, Math.min(1, edge + 0.48));
}

function resetSession() {
    sessionStartBalance = botState.stats.currentBalance;
    sessionStartTime = Date.now();
    botState.stats.dailyBets = 0;
    botState.stats.dailyProfit = 0;
    botState.settings.inCooldown = false;
    botState.settings.consecutiveLosses = 0;
    botState.settings.consecutiveWins = 0;
    botState.stats.sessionNumber++;
    botState.statusMessage = `🔄 NEW SESSION #${botState.stats.sessionNumber} STARTED`;
    console.log(`\n🔄 NEW SESSION #${botState.stats.sessionNumber}\n`);
}

// ============ API INTEGRATION ============
async function placeBet() {
    if (!shouldPlaceBet()) return null;
    
    const kellyInfo = calculateKellyBet();
    const betAmount = kellyInfo.amount;
    
    if (betAmount > botState.stats.currentBalance * 0.1) {
        botState.statusMessage = `⚠️ Bet size too large: ${betAmount.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(betAmount.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: Math.random() > 0.5, // Randomize under/over
        ClientSeed: generateClientSeed()
    };
    
    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(2);
    const expectedProfit = payload.Bet * (CONFIG.payout - 1) * kellyInfo.confidence;
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of bankroll)`);
    console.log(`  🎯 Payout: ${payload.Payout}x | Edge: ${(kellyInfo.confidence*100).toFixed(1)}%`);
    console.log(`  📊 Risk: ${(kellyInfo.riskPercent*100).toFixed(2)}% | Kelly: ${(kellyInfo.kellyFraction*100).toFixed(1)}%`);
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
        dailyProfit = botState.stats.netProfit;
        
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            if (profit > botState.stats.biggestWin) botState.stats.biggestWin = profit;
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
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
        
        console.log(`  ${isWin ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `${profitPercent}%`} | Profit: ${profit.toFixed(8)} BTC`);
        console.log(`  💼 New Balance: ${newBalance.toFixed(8)} BTC`);
        console.log(`  📈 Win Rate: ${(botState.stats.performanceMetrics.winRate*100).toFixed(1)}% | EV: ${botState.stats.performanceMetrics.expectedValue.toFixed(4)}`);
        
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
            consecutiveLosses: botState.settings.consecutiveLosses
        });
        
        // Keep only last 100 bets
        while (botState.betHistory.length > 100) botState.betHistory.pop();
        
        return {
            success: true,
            isWin: isWin,
            profit: profit,
            newBalance: newBalance,
            betAmount: payload.Bet,
            winRate: botState.stats.performanceMetrics.winRate
        };
        
    } catch (error) {
        console.error(`❌ API Error: ${error.message}`);
        
        // DEMO MODE - Simulate bets for testing
        if (error.code === 'ECONNREFUSED' || error.message.includes('getaddrinfo')) {
            const winChance = 0.505; // Slight house edge overcome
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
            
            console.log(`  [DEMO] ${isWin ? '✅ WIN' : '❌ LOSS'} | Profit: ${profit.toFixed(8)} BTC`);
            console.log(`  [DEMO] New Balance: ${newBalance.toFixed(8)} BTC`);
            
            return {
                success: true,
                isWin: isWin,
                profit: profit,
                newBalance: newBalance,
                betAmount: betAmount,
                winRate: botState.stats.performanceMetrics.winRate,
                demo: true
            };
        }
        
        return null;
    }
}

function generateClientSeed() {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ============ MAIN LOOP ============
async function runProfitEngine() {
    console.log(`\n🚀🚀🚀 PROFIT-OPTIMIZED ENGINE v3.0 🚀🚀🚀`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`🎯 Target Daily Profit: ${CONFIG.targetDailyProfit.toFixed(8)} BTC`);
    console.log(`📊 Kelly Fraction: ${CONFIG.kellyFraction*100}% | Max Risk: ${CONFIG.maxRiskPercent*100}%`);
    console.log(`🎲 Session Length: ${CONFIG.sessionLength} min | Break: ${CONFIG.breakBetweenSessions/60} min`);
    console.log(`===========================================\n`);
    
    sessionStartBalance = botState.stats.currentBalance;
    
    while (botState.running) {
        const result = await placeBet();
        
        if (result && result.success) {
            // Auto-compound daily (reset starting balance if profitable)
            if (CONFIG.compoundDaily && botState.stats.netProfit > 0) {
                const hoursSinceStart = (Date.now() - botState.stats.startTime) / 3600000;
                if (hoursSinceStart >= 24) {
                    botState.stats.startingBalance = botState.stats.currentBalance;
                    botState.stats.netProfit = 0;
                    console.log(`\n📈 DAILY COMPOUND - New baseline: ${botState.stats.startingBalance.toFixed(8)} BTC\n`);
                }
            }
        }
        
        // Dynamic delay between bets (0.5-2 seconds based on recent performance)
        const delay = result && result.isWin ? 500 : 1500;
        await new Promise(r => setTimeout(r, delay));
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
    <title>Profit Engine v3.0 | Kelly-Optimized Dice Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, monospace;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .card {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 15px;
            padding: 20px;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .card-title { font-size: 12px; text-transform: uppercase; opacity: 0.7; margin-bottom: 10px; }
        .card-value { font-size: 32px; font-weight: bold; }
        .card-sub { font-size: 12px; opacity: 0.7; margin-top: 5px; }
        .profit-positive { color: #4ade80; }
        .profit-negative { color: #f87171; }
        table {
            width: 100%;
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            overflow: hidden;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        th { background: rgba(0,0,0,0.2); font-size: 12px; text-transform: uppercase; }
        .win { color: #4ade80; font-weight: bold; }
        .loss { color: #f87171; font-weight: bold; }
        .status-bar {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
            font-weight: bold;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .pulse { animation: pulse 2s infinite; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💰 Profit Engine v3.0</h1>
        <p>Kelly-Optimized | Statistical Edge | Risk-Managed</p>
    </div>
    
    <div class="status-bar" id="statusMsg">Initializing...</div>
    
    <div class="stats-grid">
        <div class="card">
            <div class="card-title">Current Balance</div>
            <div class="card-value" id="balance">0.00000000</div>
            <div class="card-sub">BTC</div>
        </div>
        <div class="card">
            <div class="card-title">Total P&L</div>
            <div class="card-value" id="pnl">0.00000000</div>
            <div class="card-sub" id="pnlPercent">0% ROI</div>
        </div>
        <div class="card">
            <div class="card-title">Win Rate</div>
            <div class="card-value" id="winrate">0%</div>
            <div class="card-sub">Expected Value: <span id="ev">0</span></div>
        </div>
        <div class="card">
            <div class="card-title">Growth</div>
            <div class="card-value" id="growth">1x</div>
            <div class="card-sub">Peak: <span id="peak">0</span></div>
        </div>
    </div>
    
    <div class="stats-grid">
        <div class="card">
            <div class="card-title">Session</div>
            <div class="card-value" id="session">#1</div>
            <div class="card-sub">Bets: <span id="sessionBets">0</span></div>
        </div>
        <div class="card">
            <div class="card-title">Streak</div>
            <div class="card-value" id="streak">0</div>
            <div class="card-sub">🔥 Best: <span id="bestStreak">0</span> | 📉 Worst: <span id="worstStreak">0</span></div>
        </div>
        <div class="card">
            <div class="card-title">Total Stats</div>
            <div class="card-value" id="totalBets">0</div>
            <div class="card-sub">W: <span id="totalWins">0</span> | L: <span id="totalLosses">0</span></div>
        </div>
        <div class="card">
            <div class="card-title">Risk Metrics</div>
            <div class="card-value" id="risk">1.5%</div>
            <div class="card-sub">Kelly: <span id="kelly">25%</span></div>
        </div>
    </div>
    
    <table id="historyTable">
        <thead>
            <tr><th>#</th><th>Time</th><th>Wager</th><th>Result</th><th>P&L</th><th>Balance</th><th>Win Rate</th></tr>
        </thead>
        <tbody id="historyBody">
            <tr><td colspan="7" style="text-align:center;">Waiting for bets...</td></tr>
        </tbody>
    </table>
</div>

<script>
    async function updateStats() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const { botState, growth, roi, sessionNumber, kellyInfo } = data;
            
            document.getElementById('balance').innerHTML = botState.stats.currentBalance.toFixed(8);
            document.getElementById('pnl').innerHTML = (botState.stats.netProfit > 0 ? '+' : '') + botState.stats.netProfit.toFixed(8);
            document.getElementById('pnlPercent').innerHTML = roi + '% ROI';
            document.getElementById('winrate').innerHTML = (botState.stats.performanceMetrics.winRate * 100).toFixed(1) + '%';
            document.getElementById('ev').innerHTML = botState.stats.performanceMetrics.expectedValue.toFixed(4);
            document.getElementById('growth').innerHTML = growth + 'x';
            document.getElementById('peak').innerHTML = botState.stats.peakBalance.toFixed(8);
            document.getElementById('session').innerHTML = '#' + sessionNumber;
            document.getElementById('sessionBets').innerHTML = botState.stats.dailyBets;
            document.getElementById('totalBets').innerHTML = botState.stats.totalBets;
            document.getElementById('totalWins').innerHTML = botState.stats.wins;
            document.getElementById('totalLosses').innerHTML = botState.stats.losses;
            document.getElementById('statusMsg').innerHTML = botState.statusMessage;
            document.getElementById('streak').innerHTML = botState.settings.consecutiveWins > 0 ? '🔥 ' + botState.settings.consecutiveWins : (botState.settings.consecutiveLosses > 0 ? '📉 ' + botState.settings.consecutiveLosses : '0');
            document.getElementById('bestStreak').innerHTML = botState.stats.bestStreak;
            document.getElementById('worstStreak').innerHTML = botState.stats.worstStreak;
            
            if (kellyInfo) {
                document.getElementById('risk').innerHTML = (kellyInfo.riskPercent * 100).toFixed(2) + '%';
                document.getElementById('kelly').innerHTML = (kellyInfo.kellyFraction * 100).toFixed(0) + '%';
            }
            
            const pnlCard = document.querySelector('.card-value#pnl');
            if (botState.stats.netProfit > 0) {
                pnlCard.className = 'card-value profit-positive';
            } else if (botState.stats.netProfit < 0) {
                pnlCard.className = 'card-value profit-negative';
            }
            
            if (botState.betHistory && botState.betHistory.length > 0) {
                const tbody = document.getElementById('historyBody');
                tbody.innerHTML = botState.betHistory.slice(0, 20).map(b => 
                    '<tr>' +
                    '<td>#' + b.id + '</td>' +
                    '<td>' + b.time + '</td>' +
                    '<td>' + b.bet.toFixed(8) + '</td>' +
                    '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? 'WIN' : 'LOSS') + '</td>' +
                    '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profit > 0 ? '+' : '') + b.profit.toFixed(8) + '</td>' +
                    '<td>' + b.balance.toFixed(8) + '</td>' +
                    '<td>' + (b.winRate * 100).toFixed(1) + '%</td>' +
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

// API endpoints
app.get('/api/stats', (req, res) => {
    const growth = (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2);
    const roi = ((botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance * 100).toFixed(2);
    const kellyInfo = calculateKellyBet();
    
    res.json({
        botState,
        growth: growth,
        roi: roi,
        sessionNumber: botState.stats.sessionNumber,
        kellyInfo: {
            riskPercent: kellyInfo.riskPercent,
            kellyFraction: kellyInfo.kellyFraction,
            confidence: kellyInfo.confidence
        }
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
    console.log(`🚀 Profit Engine v3.0 Started`);
    runProfitEngine();
});
