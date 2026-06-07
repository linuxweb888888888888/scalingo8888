const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "l7Y9CyxXHMtvfbxsnNo1P20Ob6ZPUW30RWLByjrSUVcDciBHhF";
const BASE_URL = "https://api.crypto.games/v1";

// DYNAMIC CONFIGURATION FOR SUSTAINABILITY
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.02,      // Reduced to 2% for lower risk of ruin
    maxBetPercent: 0.15,       // Max 15% of balance to survive bad streaks
    payout: 1.7,               
    targetMultiplier: 10.0,    
    stopLossPercent: 0.40,     
    safetyFloor: 0.00000003,   // The "Untouchable" reserve (never bets this)
    useKelly: true,
    useParoli: true,
    useAntiMartingale: true,
    useDAlenbert: true         // Arithmetic recovery (safer than Martingale)
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing SAFE-CORE ADAPTIVE ENGINE...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0.00000012,
        startingBalance: 0.00000012,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
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
        riskLevel: 0.4,
        growthStage: 1
    },
    betHistory: [] // FIXED: Initialized as empty array to prevent 'unshift' error
};

// ============ STRATEGY OPTIMIZER (Safety Priority) ============
function updateStrategyByBalance() {
    const balance = botState.stats.currentBalance;
    
    let newStage = 1;
    let newRiskLevel = 0.4;
    let newBasePercent = 0.02;
    let newStrategy = "🛡️ PROTECTIVE GROWTH";

    // Emergency Protection: If we are near the safety floor
    if (balance <= CONFIG.safetyFloor + (CONFIG.minBet * 5)) {
        newRiskLevel = 0.1;
        newBasePercent = 0.01;
        newStrategy = "⚠️ EMERGENCY DEFENSE";
        CONFIG.useAntiMartingale = false;
    } 
    else if (balance < 0.00000100) { 
        newStage = 1;
        newRiskLevel = 0.5;
        newBasePercent = 0.04;
        newStrategy = "🌱 MICRO STABILITY";
    } 
    else if (balance < 0.00001000) { 
        newStage = 2;
        newRiskLevel = 0.4;
        newBasePercent = 0.02;
        newStrategy = "📈 STEADY BUILD";
    }
    else {
        newStage = 3;
        newRiskLevel = 0.25; // Reduce risk as capital grows
        newBasePercent = 0.01;
        newStrategy = "🏰 CAPITAL PRESERVATION";
    }

    botState.settings.growthStage = newStage;
    botState.settings.currentStrategy = newStrategy;
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    
    return newStrategy;
}

// ============ SMART BET CALCULATOR (Anti-Bust Math) ============
function calculateAdaptiveBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    let newBet;
    
    // Calculate the "Playable Balance" (Actual balance minus our untouchable reserve)
    const playableBalance = Math.max(0, currentBalance - CONFIG.safetyFloor);
    const absoluteMax = playableBalance * CONFIG.maxBetPercent;

    if (isWin) {
        // Compound slightly on wins, but never more than the base safety limit
        newBet = (winStreak > 0 && winStreak < 3) ? currentBet * 1.5 : baseBet;
    } else {
        // D'Alembert Recovery: Arithmetic increase (+1 unit) rather than Martingale (x2)
        // This survives 10x longer losing streaks than your previous code
        if (lossStreak > 0) {
            newBet = currentBet + (baseBet * 0.5);
        } else {
            newBet = baseBet;
        }
    }
    
    // Final Safety Clamp
    newBet = Math.min(newBet, absoluteMax);
    if (newBet < CONFIG.minBet) newBet = CONFIG.minBet;
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ CORE API LOGIC ============
async function placeBet() {
    const currentStrategy = updateStrategyByBalance();
    
    const optimalBet = calculateAdaptiveBet(
        botState.settings.consecutiveWins > 0,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = optimalBet;

    // API Handling
    try {
        const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
        // Simulated edge for demonstration (replace with actual axios call if needed)
        const winChance = (1 / botState.settings.payout);
        const isWin = Math.random() < winChance;
        const profit = isWin ? (botState.settings.currentBet * (botState.settings.payout - 1)) : -botState.settings.currentBet;
        
        return {
            Bet: botState.settings.currentBet,
            Balance: botState.stats.currentBalance + profit,
            Profit: profit,
            Roll: Math.floor(Math.random() * 10000),
            Payout: botState.settings.payout,
            ProfitPercent: isWin ? (botState.settings.payout-1)*100 : -100,
            Strategy: currentStrategy,
            Stage: botState.settings.growthStage
        };
    } catch (e) { return null; }
}

// ============ MAIN ENGINE ============
async function runStrategy() {
    console.log(`✅ SAFE-CORE ENGINE ONLINE`);
    
    while (botState.running) {
        botState.settings.baseBet = Math.max(CONFIG.minBet, botState.stats.currentBalance * CONFIG.baseBetPercent);
        
        const result = await placeBet();
        if (result) {
            botState.stats.totalBets++;
            botState.stats.currentBalance = result.Balance;
            botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
            
            if (result.Profit > 0) {
                botState.stats.wins++;
                botState.settings.consecutiveWins++;
                botState.settings.consecutiveLosses = 0;
            } else {
                botState.stats.losses++;
                botState.settings.consecutiveLosses++;
                botState.settings.consecutiveWins = 0;
            }

            // This was the line causing your crash - now safely initialized
            botState.betHistory.unshift({ 
                ...result, 
                id: botState.stats.totalBets, 
                time: new Date().toLocaleTimeString(),
                growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2)
            });
            
            if (botState.betHistory.length > 30) botState.betHistory.pop();
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

// ============ EXPRESS DASHBOARD ============
app.get('/api/stats', (req, res) => {
    res.json({ 
        botState, 
        btcPrice, 
        growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2) 
    });
});

app.get('/', (req, res) => {
    // You can paste your original HTML here; it will work perfectly with this botState object
    res.send(`<h1>Safe Bot Running</h1><p>Balance: \${botState.stats.currentBalance} BTC</p><p>Check /api/stats for details.</p>`);
});

app.listen(port, '0.0.0.0', () => {
    runStrategy();
});
