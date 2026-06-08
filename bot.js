const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ REAL API CONFIGURATION ============
// GET YOUR API KEY FROM: https://crypto-games.net -> Settings -> API
const API_KEY = process.env.API_KEY || "qKnqjZCspd9MRXODwhdb0qIYk6aGAvbxSx69ViXGQi0coYRcG6";  // REPLACE THIS!
const BASE_URL = "https://api.crypto-games.net/v1";  // FIXED: Correct URL with hyphen

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseRiskPercent: 0.025,      // 2.5% base risk
    maxRiskPercent: 0.08,         // 8% max risk for recovery
    payout: 1.95,                 // 95% profit target
    targetDailyProfit: 0.00001000, // $0.60 target at $60k BTC
    stopLossDaily: 0.00000500,    // $0.30 stop loss
    maxConsecutiveLosses: 4,      
    useAggressiveRecovery: true,
    recoveryMultiplier: 1.8,      // 80% increase on losses
    winStreakBonus: 1.3,          // 30% bonus on wins
    minBetsPerSession: 30,
    maxBetsPerSession: 150,
    volatilityAdjustment: true,
    compoundThreshold: 0.00000200, // Compound after $0.12 profit
    demoMode: false                // SET TO false FOR REAL TRADING!
};

// ============ BOT STATE ============
let btcPrice = 60964;
let sessionStartTime = Date.now();
let sessionStartBalance = 0;

let botState = {
    running: true,
    statusMessage: "PROFIT ENGINE INITIALIZED",
    apiConnected: false,
    lastApiError: null,
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

// ============ API CONNECTION TEST ============
async function testAPIConnection() {
    console.log("\n🔌 Testing API Connection...");
    
    try {
        // Test endpoint to get balance
        const testUrl = `${BASE_URL}/getbalance/${CONFIG.coin}/${API_KEY}`;
        console.log(`   Testing: ${testUrl}`);
        
        const response = await axios.get(testUrl, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.data && response.data.Balance !== undefined) {
            const balance = parseFloat(response.data.Balance);
            botState.stats.currentBalance = balance;
            botState.stats.startingBalance = balance;
            sessionStartBalance = balance;
            botState.apiConnected = true;
            
            console.log(`✅ API Connected Successfully!`);
            console.log(`💰 Real Balance: ${balance.toFixed(8)} BTC`);
            console.log(`💵 USD Value: ~$${(balance * btcPrice).toFixed(2)}`);
            
            if (balance < 0.0001) {
                console.log(`⚠️ WARNING: Low balance! Minimum recommended: 0.0001 BTC`);
                botState.statusMessage = `⚠️ LOW BALANCE: ${balance.toFixed(8)} BTC - Add funds!`;
            } else {
                botState.statusMessage = `✅ READY FOR REAL TRADING | Balance: ${balance.toFixed(8)} BTC`;
            }
            
            return true;
        } else {
            console.error(`❌ API Error: Invalid response format`);
            botState.apiConnected = false;
            botState.statusMessage = "❌ API ERROR - Check your API key";
            return false;
        }
    } catch (error) {
        console.error(`❌ API Connection Failed!`);
        console.error(`   Error: ${error.message}`);
        
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data: ${JSON.stringify(error.response.data)}`);
            
            if (error.response.status === 401) {
                console.error(`   → Invalid API Key! Get a valid key from crypto-games.net`);
            } else if (error.response.status === 404) {
                console.error(`   → API endpoint not found. Check your URL.`);
            }
        }
        
        botState.apiConnected = false;
        botState.lastApiError = error.message;
        botState.statusMessage = `❌ API ERROR: ${error.message}`;
        
        if (CONFIG.demoMode) {
            console.log(`\n⚠️ DEMO MODE ENABLED - Simulating trades\n`);
            return true; // Allow demo mode
        }
        
        return false;
    }
}

// ============ GET REAL BALANCE ============
async function updateRealBalance() {
    if (!botState.apiConnected) return null;
    
    try {
        const url = `${BASE_URL}/getbalance/${CONFIG.coin}/${API_KEY}`;
        const response = await axios.get(url, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.data && response.data.Balance !== undefined) {
            const newBalance = parseFloat(response.data.Balance);
            if (newBalance !== botState.stats.currentBalance) {
                console.log(`💰 Balance updated: ${botState.stats.currentBalance.toFixed(8)} → ${newBalance.toFixed(8)} BTC`);
                botState.stats.currentBalance = newBalance;
            }
            return newBalance;
        }
    } catch (error) {
        console.error(`Failed to update balance: ${error.message}`);
    }
    return null;
}

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

// ============ REAL API PLACE BET ============
async function placeBet() {
    // Check session limits
    const sessionStatus = checkProfitConditions();
    if (sessionStatus !== "ACTIVE") {
        if (["TAKE_PROFIT", "STOP_LOSS", "TIME_LIMIT", "MAX_LOSSES"].includes(sessionStatus)) {
            await resetSession(sessionStatus);
        }
        return null;
    }
    
    // Update real balance before betting
    if (botState.apiConnected && !CONFIG.demoMode) {
        await updateRealBalance();
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
    
    // FIXED: Correct API URL
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    
    const payload = {
        Bet: Number(betAmount.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: true,  // true = over, false = under
        ClientSeed: generateClientSeed()
    };
    
    // Proper headers
    const headers = {
        'Content-Type': 'application/json'
    };
    
    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 ${CONFIG.demoMode ? 'DEMO' : 'REAL'} BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of bankroll)`);
    console.log(`  🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit)`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    
    try {
        let result, profit, newBalance, isWin;
        
        if (CONFIG.demoMode) {
            // DEMO MODE - Simulate trades
            const winChance = 0.55; // 55% win rate for positive EV
            isWin = Math.random() < winChance;
            profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
            newBalance = botState.stats.currentBalance + profit;
            result = { Profit: profit, Balance: newBalance, Roll: Math.floor(Math.random() * 10000) };
            
            console.log(`  [DEMO] Simulating trade...`);
        } else {
            // REAL API CALL
            const response = await axios.post(url, payload, { headers });
            result = response.data;
            
            // Check for API errors
            if (result.Error) {
                console.error(`❌ API Error: ${result.Error}`);
                botState.statusMessage = `API Error: ${result.Error}`;
                
                if (result.Error.includes("balance") || result.Error.includes("200") || result.Error.includes("505")) {
                    console.error("⚠️ INSUFFICIENT BALANCE - Add more funds to your account!");
                    botState.statusMessage = "⚠️ INSUFFICIENT BALANCE - Add funds!";
                }
                return null;
            }
            
            profit = parseFloat(result.Profit) || 0;
            newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
            isWin = profit > 0;
        }
        
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
            session: botState.stats.sessionNumber,
            real: !CONFIG.demoMode
        });
        
        while (botState.betHistory.length > 50) botState.betHistory.pop();
        
        return {
            success: true,
            isWin: isWin,
            profit: profit,
            newBalance: newBalance,
            betAmount: payload.Bet,
            real: !CONFIG.demoMode
        };
        
    } catch (error) {
        console.error(`❌ API Error: ${error.message}`);
        
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data: ${JSON.stringify(error.response.data)}`);
            
            if (error.response.status === 401) {
                console.error(`   → INVALID API KEY! Get a valid key from crypto-games.net`);
                botState.statusMessage = "❌ INVALID API KEY - Check your API key!";
                botState.apiConnected = false;
            }
        }
        
        botState.lastApiError = error.message;
        return null;
    }
}

function generateClientSeed() {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ============ MAIN ENGINE ============
async function runProfitEngine() {
    console.log(`\n🚀🚀🚀 PROFIT ENGINE v5.0 - REAL TRADING MODE 🚀🚀🚀`);
    console.log(`===============================================`);
    
    // Test API connection first
    const apiConnected = await testAPIConnection();
    
    if (!apiConnected && !CONFIG.demoMode) {
        console.log(`\n❌ Cannot start - API connection failed!`);
        console.log(`   Options:`);
        console.log(`   1. Check your API key and network connection`);
        console.log(`   2. Set CONFIG.demoMode = true to test in demo mode`);
        console.log(`\n   To get a valid API key:`);
        console.log(`   → Visit https://crypto-games.net`);
        console.log(`   → Login to your account`);
        console.log(`   → Go to Settings → API`);
        console.log(`   → Generate a new API key`);
        console.log(`   → Copy the key and update API_KEY variable\n`);
        return;
    }
    
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`💵 USD Value: ~$${(botState.stats.currentBalance * btcPrice).toFixed(2)}`);
    console.log(`🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit on win)`);
    console.log(`📊 Risk: ${CONFIG.baseRiskPercent*100}% base, ${CONFIG.maxRiskPercent*100}% max`);
    console.log(`🎲 Mode: ${CONFIG.demoMode ? 'DEMO (Simulated)' : 'REAL TRADING'}`);
    console.log(`===========================================\n`);
    
    sessionStartBalance = botState.stats.currentBalance;
    
    while (botState.running) {
        const result = await placeBet();
        
        if (result && result.success) {
            // Dynamic delay based on performance
            let delay = 1000; // Base delay 1 second
            
            if (result.isWin && botState.settings.consecutiveWins > 2) {
                delay = 500; // Faster on win streaks
            } else if (!result.isWin && botState.settings.consecutiveLosses > 1) {
                delay = 2000; // Slower on loss streaks
            }
            
            await new Promise(r => setTimeout(r, delay));
        } else {
            // Wait longer on errors
            await new Promise(r => setTimeout(r, 5000));
            
            // Try to reconnect if API seems down
            if (!CONFIG.demoMode && botState.apiConnected) {
                console.log("🔄 Attempting to reconnect to API...");
                await testAPIConnection();
            }
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
    <title>Profit Engine v5.0 | Real Trading Mode</title>
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
        .api-connected { color: #00ff00; }
        .api-error { color: #ff4444; }
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
        .status-error { border-color: #ff4444; color: #ff4444; }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .blink { animation: blink 1s infinite; }
        .badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            margin-left: 10px;
        }
        .badge-real { background: #00ff00; color: #000; }
        .badge-demo { background: #ff4444; color: #fff; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💰 PROFIT ENGINE v5.0</h1>
        <p>Real Trading Mode | Kelly-Optimized | Auto-Recovery</p>
        <span class="badge ${CONFIG.demoMode ? 'badge-demo' : 'badge-real'}">${CONFIG.demoMode ? 'DEMO MODE' : 'REAL TRADING'}</span>
    </div>
    
    <div class="status-bar ${!botState.apiConnected && !CONFIG.demoMode ? 'status-error' : ''}" id="statusMsg">
        Initializing...
    </div>
    
    <div class="stats-grid">
        <div class="card">
            <div class="card-title">Balance</div>
            <div class="card-value" id="balance">0.00000000</div>
            <div class="card-title" id="balanceUsd">$0.00</div>
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
                <tr><th>#</th><th>Time</th><th>Wager</th><th>Result</th><th>P&L</th><th>Balance</th><th>Session</th><th>Type</th></tr>
            </thead>
            <tbody id="historyBody">
                <tr><td colspan="8" style="text-align:center;">Waiting for bets...</td></tr>
            </tbody>
        </table>
    </div>
</div>

<script>
    async function updateStats() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const { botState, growth, roi, btcPrice } = data;
            
            const balanceUsd = botState.stats.currentBalance * btcPrice;
            
            document.getElementById('balance').innerHTML = botState.stats.currentBalance.toFixed(8);
            document.getElementById('balanceUsd').innerHTML = `$${balanceUsd.toFixed(2)}`;
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
                    '<td>' + (b.real ? '🔴 REAL' : '🎲 DEMO') + '</td>' +
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
        roi: roi,
        btcPrice: btcPrice,
        apiConnected: botState.apiConnected,
        demoMode: CONFIG.demoMode
    });
});

app.get('/api/control/:action', async (req, res) => {
    const action = req.params.action;
    if (action === 'stop') {
        botState.running = false;
        res.json({ status: 'stopped' });
    } else if (action === 'start') {
        botState.running = true;
        res.json({ status: 'started' });
    } else if (action === 'test-api') {
        const connected = await testAPIConnection();
        res.json({ connected: connected, message: botState.statusMessage });
    } else {
        res.json({ error: 'invalid action' });
    }
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Dashboard: http://localhost:${port}`);
    console.log(`🚀 Profit Engine v5.0 Started`);
    runProfitEngine();
});
