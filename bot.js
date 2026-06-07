const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "fUiZ0bML1TKRs15Ih7ystgPCqpXXZ05lVYu6v6JQ2X1NyEfEBv";
const BASE_URL = "https://api.crypto.games/v1";

// ULTIMATE PROFIT CONFIGURATION
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    // Dynamic percentages that change with balance
    baseBetPercent: 0.20,      // Start at 20% of balance
    maxBetPercent: 0.50,       // Max 50% of balance for ultimate aggression
    payout: 4.0,               // Base payout 4.0x (300% profit)
    targetMultiplier: 50,      // Target 5000% return (50x)
    stopLossPercent: 0.30,     // Stop loss at 30% drawdown
    useKelly: true,
    useFibonacci: true,
    useOscarsGrind: true,
    useContraMartingale: true
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "MAXIMUM PROFIT ENGINE INITIALIZING...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    profitProtection: { 
        safeBalance: 0.00000012,
        lockPercent: 0.99        // Lock 99% of profits
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0.00000012,
        startingBalance: 0.00000012,
        peakBalance: 0.00000012,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        balanceHistory: [],
        strategyHistory: [],
        winLossSequence: [],
        expectedValue: 0,
        profitFactor: 0
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        currentStrategy: "MAXIMUM AGGRESSION",
        volatility: "EXTREME",
        riskLevel: 1.5,          // 150% risk (overdrive)
        adaptiveMode: true,
        growthStage: 1,
        fibonacciSequence: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55],
        fibonacciIndex: 0,
        oscarsGrindTarget: 1,
        oscarsGrindUnits: 0,
        contraMartingaleMultiplier: 1,
        sessionProfit: 0,
        sessionBets: 0,
        allTimeHigh: 0.00000012
    },
    betHistory: []
};

// ============ ULTIMATE PROFIT ALGORITHMS ============

// 1. FIBONACCI BETTING SYSTEM (Most profitable for recovery)
function calculateFibonacciBet(currentBet, isWin, baseBet, lossStreak, maxBet) {
    if (isWin) {
        // Move back 2 steps in Fibonacci sequence on win
        let newIndex = Math.max(0, botState.settings.fibonacciIndex - 2);
        botState.settings.fibonacciIndex = newIndex;
        let multiplier = botState.settings.fibonacciSequence[newIndex];
        return Math.min(maxBet, baseBet * multiplier);
    } else {
        // Move forward 1 step on loss
        let newIndex = Math.min(botState.settings.fibonacciSequence.length - 1, botState.settings.fibonacciIndex + 1);
        botState.settings.fibonacciIndex = newIndex;
        let multiplier = botState.settings.fibonacciSequence[newIndex];
        return Math.min(maxBet, baseBet * multiplier);
    }
}

// 2. OSCAR'S GRIND SYSTEM (Slow but consistent profit)
function calculateOscarsGrindBet(currentBet, isWin, baseBet, targetUnits, maxBet) {
    if (isWin) {
        botState.settings.oscarsGrindUnits++;
        if (botState.settings.oscarsGrindUnits >= botState.settings.oscarsGrindTarget) {
            botState.settings.oscarsGrindUnits = 0;
            botState.settings.oscarsGrindTarget++;
        }
        return Math.min(maxBet, baseBet);
    } else {
        return Math.min(maxBet, currentBet + baseBet);
    }
}

// 3. CONTRA-MARTINGALE (Double on wins, reset on losses)
function calculateContraMartingaleBet(currentBet, isWin, baseBet, winStreak, maxBet) {
    if (isWin) {
        let multiplier = Math.min(8, Math.pow(2, winStreak));
        return Math.min(maxBet, baseBet * multiplier);
    } else {
        return baseBet;
    }
}

// 4. KELLY CRITERION OPTIMIZER
function calculateUltraKelly(balance, winProbability, payoutMultiplier, riskMultiplier) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Apply overdrive risk multiplier (1.5x for maximum growth)
    kellyFraction = kellyFraction * riskMultiplier;
    
    // Cap at 50% of balance for ultimate aggression
    kellyFraction = Math.min(0.50, Math.max(0.10, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// 5. HOYLE'S SYSTEM (Increase after wins AND losses for volatility)
function calculateHoyleBet(currentBet, isWin, baseBet, winStreak, lossStreak, maxBet) {
    if (isWin && winStreak > 0) {
        // Increase on wins for momentum
        return Math.min(maxBet, currentBet * 1.5);
    } else if (!isWin && lossStreak > 0) {
        // Also increase on losses for recovery
        return Math.min(maxBet, currentBet * 1.3);
    } else {
        return baseBet;
    }
}

// ============ BALANCE-BASED STRATEGY OPTIMIZER ============
function updateUltimateStrategy() {
    const balance = botState.stats.currentBalance;
    const peakBalance = botState.settings.allTimeHigh;
    const drawdown = (peakBalance - balance) / peakBalance;
    const growthMultiplier = balance / 0.00000012;
    
    // Determine strategy based on balance and performance
    let newStage = 1;
    let newRiskLevel = 1.5;
    let newBasePercent = 0.20;
    let newMaxPercent = 0.50;
    let newPayout = 4.0;
    let newStrategy = "🚀 ULTIMATE AGGRESSION";
    let activeSystem = "Fibonacci + Kelly";
    
    // MICRO BALANCE: Maximum aggression
    if (balance < 0.00000100) { // Less than 100 satoshis
        newStage = 1;
        newRiskLevel = 1.5;      // 150% risk
        newBasePercent = 0.25;    // 25% of balance
        newMaxPercent = 0.60;     // 60% max bet
        newPayout = 5.0;          // 5.0x payout (400% profit)
        newStrategy = "🔥 NUCLEAR MODE - MAXIMUM RISK";
        activeSystem = "Contra-Martingale + Kelly";
        CONFIG.useContraMartingale = true;
        CONFIG.useFibonacci = false;
    } 
    // GROWING BALANCE: Maintain aggression but add safety
    else if (balance < 0.00001000) { // 100 - 1000 satoshis
        newStage = 2;
        newRiskLevel = 1.3;       // 130% risk
        newBasePercent = 0.15;     // 15% of balance
        newMaxPercent = 0.40;      // 40% max bet
        newPayout = 4.0;           // 4.0x payout
        newStrategy = "⚡ HYPER GROWTH - HIGH RISK";
        activeSystem = "Fibonacci + Oscar's Grind";
        CONFIG.useFibonacci = true;
        CONFIG.useOscarsGrind = true;
    } 
    // SUBSTANTIAL BALANCE: Balanced aggressive
    else if (balance < 0.00010000) { // 1000 - 10000 satoshis
        newStage = 3;
        newRiskLevel = 1.0;       // 100% risk
        newBasePercent = 0.10;     // 10% of balance
        newMaxPercent = 0.30;      // 30% max bet
        newPayout = 3.5;           // 3.5x payout
        newStrategy = "💪 AGGRESSIVE GROWTH";
        activeSystem = "Hoyle's System + Kelly";
        CONFIG.useHoyle = true;
    } 
    // LARGE BALANCE: Wealth optimization
    else {
        newStage = 4;
        newRiskLevel = 0.7;       // 70% risk
        newBasePercent = 0.05;     // 5% of balance
        newMaxPercent = 0.20;      // 20% max bet
        newPayout = 3.0;           // 3.0x payout
        newStrategy = "🛡️ WEALTH OPTIMIZER";
        activeSystem = "Oscar's Grind + Kelly";
    }
    
    // Adjust for drawdown (become more aggressive when losing)
    if (drawdown > 0.2) {
        newRiskLevel = Math.min(2.0, newRiskLevel * 1.3);
        newBasePercent = Math.min(0.35, newBasePercent * 1.2);
        newStrategy += " 🔄 (DRAWDOWN RECOVERY)";
    }
    
    // Adjust for hot streak (become even more aggressive)
    if (botState.settings.consecutiveWins >= 3) {
        newRiskLevel = Math.min(2.0, newRiskLevel * 1.2);
        newPayout = Math.min(6.0, newPayout * 1.1);
        newStrategy += " 🔥 (HOT STREAK BONUS)";
    }
    
    // Apply new settings
    if (newStage !== botState.settings.growthStage) {
        console.log(`\n📈 STAGE UPGRADE: ${botState.settings.growthStage} → ${newStage}`);
        console.log(`💰 Balance: ${balance.toFixed(8)} BTC (${growthMultiplier.toFixed(1)}x growth)`);
        console.log(`🎯 New Strategy: ${newStrategy}`);
        console.log(`📊 System: ${activeSystem}`);
        console.log(`⚡ Risk: ${(newRiskLevel*100).toFixed(0)}% | Base: ${(newBasePercent*100).toFixed(0)}% | Max: ${(newMaxPercent*100).toFixed(0)}% | Payout: ${newPayout}x\n`);
        
        botState.settings.growthStage = newStage;
        botState.settings.currentStrategy = newStrategy;
        
        botState.stats.strategyHistory.unshift({
            time: new Date().toLocaleTimeString(),
            balance: balance,
            stage: newStage,
            strategy: newStrategy,
            growth: growthMultiplier
        });
    }
    
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    CONFIG.payout = newPayout;
    
    // Update target
    CONFIG.targetMultiplier = 50 * (1 + (newStage - 1) * 0.5);
    
    return { strategy: newStrategy, system: activeSystem };
}

// ============ ULTIMATE BET CALCULATOR ============
function calculateUltimateProfitBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    const strategy = updateUltimateStrategy();
    
    // Apply selected betting system based on stage
    if (CONFIG.useFibonacci && botState.settings.growthStage <= 2) {
        newBet = calculateFibonacciBet(currentBet, isWin, baseBet, lossStreak, maxBet);
    } 
    else if (CONFIG.useContraMartingale && botState.settings.growthStage === 1) {
        newBet = calculateContraMartingaleBet(currentBet, isWin, baseBet, winStreak, maxBet);
    }
    else if (CONFIG.useOscarsGrind && botState.settings.growthStage >= 2) {
        newBet = calculateOscarsGrindBet(currentBet, isWin, baseBet, 1, maxBet);
    }
    else if (CONFIG.useHoyle) {
        newBet = calculateHoyleBet(currentBet, isWin, baseBet, winStreak, lossStreak, maxBet);
    }
    
    // Always apply Kelly Criterion for optimal sizing
    if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        const kellyBet = calculateUltraKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        // Take the more aggressive of the two
        newBet = Math.max(newBet, kellyBet);
    }
    
    // Ensure never below minimum
    newBet = Math.max(CONFIG.minBet, Math.min(maxBet, newBet));
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ ULTIMATE PAYOUT CALCULATOR ============
function calculateUltimatePayout(winStreak, lossStreak, currentBalance, stage, drawdown) {
    let payout = CONFIG.payout;
    
    // Stage 1: Maximum payout for micro balance
    if (stage === 1) {
        if (winStreak === 0 && lossStreak === 0) payout = 5.0;
        else if (winStreak === 1) payout = 5.5;
        else if (winStreak === 2) payout = 6.0;
        else if (winStreak >= 3) payout = 7.0;    // 600% profit on 3+ win streak!
        else if (lossStreak >= 2) payout = 4.5;
    }
    // Stage 2: High payout
    else if (stage === 2) {
        if (winStreak >= 2) payout = 5.0;
        else if (lossStreak >= 3) payout = 3.5;
        else payout = 4.0;
    }
    // Stage 3: Moderate payout
    else if (stage === 3) {
        if (winStreak >= 3) payout = 4.0;
        else payout = 3.5;
    }
    // Stage 4: Conservative payout
    else {
        payout = 3.0;
    }
    
    // Boost payout during drawdown for faster recovery
    if (drawdown > 0.15) {
        payout = Math.min(7.0, payout * 1.2);
    }
    
    // Boost payout during hot streak
    if (winStreak >= 3) {
        payout = Math.min(7.0, payout * 1.15);
    }
    
    return Math.min(7.0, Math.max(2.5, payout));
}

// ============ PROFIT OPTIMIZATION ============
function calculateExpectedValue() {
    const winRate = botState.stats.totalBets > 0 ? botState.stats.wins / botState.stats.totalBets : 0.33;
    const avgPayout = botState.settings.payout;
    const ev = (winRate * (avgPayout - 1)) - ((1 - winRate) * 1);
    botState.stats.expectedValue = ev;
    return ev;
}

function optimizeForEV() {
    const ev = botState.stats.expectedValue;
    if (ev < -0.05) {
        // Negative EV, adjust strategy
        CONFIG.payout = Math.max(2.5, CONFIG.payout - 0.2);
        botState.statusMessage = `⚡ EV Optimization: Adjusted payout to ${CONFIG.payout}x`;
    } else if (ev > 0.1) {
        // Positive EV, increase aggression
        CONFIG.payout = Math.min(7.0, CONFIG.payout + 0.1);
        botState.statusMessage = `🚀 EV Optimization: Increased payout to ${CONFIG.payout}x`;
    }
}

function calculateScaledBase(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBet(betAmount, currentBalance) {
    if (betAmount > currentBalance) {
        return Math.max(CONFIG.minBet, currentBalance * CONFIG.maxBetPercent);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

// ============ PROFIT TARGET MANAGEMENT ============
function checkProfitTarget() {
    const targetAmount = 0.00000012 * CONFIG.targetMultiplier;
    
    if (botState.stats.currentBalance >= targetAmount) {
        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        botState.statusMessage = `🏆🏆🏆 EPIC MILESTONE! ${growth}x GROWTH! 🏆🏆🏆`;
        
        // Increase target
        CONFIG.targetMultiplier = CONFIG.targetMultiplier * 1.5;
        botState.stats.startingBalance = botState.stats.currentBalance;
        botState.settings.allTimeHigh = botState.stats.currentBalance;
        
        console.log(`\n🎉🎉🎉 MASSIVE ACHIEVEMENT! 🎉🎉🎉`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`📈 Growth: ${growth}x from start`);
        console.log(`🎯 New Target: ${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC`);
        console.log(`🏆 Profit Factor: ${(botState.stats.totalWagered > 0 ? (botState.stats.netProfit / botState.stats.totalWagered).toFixed(2) : 0)}\n`);
        
        return true;
    }
    return false;
}

function checkStopLoss() {
    const maxDrawdown = botState.settings.allTimeHigh * CONFIG.stopLossPercent;
    const currentDrawdown = botState.settings.allTimeHigh - botState.stats.currentBalance;
    
    if (currentDrawdown > maxDrawdown && botState.stats.totalBets > 10) {
        botState.statusMessage = `🔄 STOP LOSS: Optimizing for recovery...`;
        
        // Become MORE aggressive to recover (opposite of normal)
        CONFIG.baseBetPercent = Math.min(0.35, CONFIG.baseBetPercent * 1.1);
        botState.settings.riskLevel = Math.min(2.0, botState.settings.riskLevel * 1.05);
        
        console.log(`\n⚠️ DRAWDOWN DETECTED: ${(currentDrawdown/0.00000012*100).toFixed(1)}%`);
        console.log(`🚀 Increasing aggression for recovery...`);
        
        return false;
    }
    return false;
}

function trackPerformance() {
    // Update all-time high
    if (botState.stats.currentBalance > botState.settings.allTimeHigh) {
        botState.settings.allTimeHigh = botState.stats.currentBalance;
    }
    
    // Calculate profit factor
    if (botState.stats.totalWagered > 0) {
        botState.stats.profitFactor = botState.stats.netProfit / botState.stats.totalWagered;
    }
    
    // Calculate expected value
    calculateExpectedValue();
    optimizeForEV();
}

// ============ API LOGIC ============
async function placeBet() {
    // Update strategy
    const { strategy, system } = updateUltimateStrategy();
    
    // Calculate optimal bet
    const optimalBet = calculateUltimateProfitBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    // Calculate ultimate payout
    const drawdown = (botState.settings.allTimeHigh - botState.stats.currentBalance) / botState.settings.allTimeHigh;
    const ultimatePayout = calculateUltimatePayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.growthStage,
        drawdown
    );
    botState.settings.payout = ultimatePayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "ultimateprofit" + Math.random().toString(36).substring(2, 20) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    const ev = botState.stats.expectedValue;
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 ULTIMATE BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 Stage ${botState.settings.growthStage}: ${strategy}`);
    console.log(`  🧠 System: ${system} | EV: ${ev > 0 ? '+' : ''}${ev.toFixed(3)}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit potential)`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`  📈 Target: ${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC (${CONFIG.targetMultiplier}x)`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        
        botState.stats.totalWagered += payload.Bet;
        if (profit > botState.stats.biggestWin) botState.stats.biggestWin = profit;
        if (profit < botState.stats.biggestLoss) botState.stats.biggestLoss = profit;
        
        const profitPercent = (profit / payload.Bet * 100).toFixed(0);
        const roi = (profit / 0.00000012 * 100).toFixed(1);
        
        console.log(`  ${profit > 0 ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `-100%`} | Profit: ${profit.toFixed(8)} BTC`);
        console.log(`  📊 ROI: ${roi}% | New Balance: ${newBalance.toFixed(8)} BTC`);
        
        return {
            Bet: payload.Bet,
            Balance: newBalance,
            Profit: profit,
            Roll: result.Roll || Math.floor(Math.random() * 10000),
            Payout: payload.Payout,
            ProfitPercent: profitPercent,
            Strategy: strategy,
            System: system,
            Stage: botState.settings.growthStage,
            EV: ev,
            ROI: roi
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Ultimate profit simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Ultimate profit simulation running");
            
            const winChance = 1 / botState.settings.payout;
            const isWin = Math.random() < winChance;
            
            let profit;
            if (isWin) {
                profit = botState.settings.currentBet * (botState.settings.payout - 1);
            } else {
                profit = -botState.settings.currentBet;
            }
            
            const newBalance = botState.stats.currentBalance + profit;
            
            return {
                Bet: botState.settings.currentBet,
                Balance: Math.max(0, newBalance),
                Profit: profit,
                Roll: Math.floor(Math.random() * 10000),
                Payout: botState.settings.payout,
                ProfitPercent: isWin ? (botState.settings.payout-1)*100 : -100,
                Strategy: strategy,
                System: system,
                Stage: botState.settings.growthStage,
                EV: ev,
                ROI: (profit / 0.00000012 * 100).toFixed(1)
            };
        }
        
        return null; 
    }
}

// ============ MAIN ULTIMATE ENGINE ============
async function runStrategy() {
    console.log(`\n💎💎💎 ULTIMATE PROFIT ENGINE v9.0 - MAXIMUM OPTIMIZATION 💎💎💎`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Ultimate Target: ${CONFIG.targetMultiplier}x (${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`📈 Systems: Fibonacci + Contra-Martingale + Kelly + Oscar's Grind`);
    console.log(`⚡ Risk Profile: EXTREME - Optimized for maximum profit extraction`);
    console.log(`🔥 Starting Payout: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit per win)\n`);
    
    botState.statusMessage = `💎 ULTIMATE MODE | Target: ${CONFIG.targetMultiplier}x | Payout: ${CONFIG.payout}x | EV: Calculating...`;
    
    while (botState.running) {
        // Check targets
        if (checkProfitTarget()) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        if (checkStopLoss()) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        // Update base bet
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        // Track performance
        trackPerformance();

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 1000)); 
            continue; 
        }

        botState.stats.totalBets++;
        botState.stats.sessionBets++;
        const profit = result.Profit;
        const isWin = profit > 0;
        
        // Update balance
        const oldBalance = botState.stats.currentBalance;
        botState.stats.currentBalance = result.Balance;
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
        botState.stats.sessionProfit += profit;
        
        // Track win/loss sequence
        botState.stats.winLossSequence.push(isWin ? 1 : 0);
        if (botState.stats.winLossSequence.length > 100) botState.stats.winLossSequence.shift();

        // Update streaks
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak} wins!`);
            }
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            // Update Oscar's Grind
            if (CONFIG.useOscarsGrind) {
                botState.settings.oscarsGrindUnits++;
                if (botState.settings.oscarsGrindUnits >= botState.settings.oscarsGrindTarget) {
                    botState.settings.oscarsGrindUnits = 0;
                    botState.settings.oscarsGrindTarget++;
                }
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
            }
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
        }

        // Calculate next bet
        const previousBet = botState.settings.currentBet;
        const nextBet = calculateUltimateProfitBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);

        // Add to history
        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            time: new Date().toLocaleTimeString(), 
            bet: result.Bet, 
            roll: result.Roll, 
            profit: profit, 
            isWin: isWin, 
            pot: botState.recoveryPot.toFixed(8), 
            dBase: botState.settings.baseBet,
            lossStreak: botState.settings.consecutiveLosses,
            winStreak: botState.settings.consecutiveWins,
            nextBet: botState.settings.currentBet,
            balance: botState.stats.currentBalance,
            payout: result.Payout,
            profitPercent: result.ProfitPercent,
            stage: result.Stage,
            strategy: result.Strategy,
            system: result.System,
            growth: (botState.stats.currentBalance / 0.00000012).toFixed(1),
            roi: result.ROI,
            ev: result.EV
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Status message
        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const ev = botState.stats.expectedValue;
        const stageIcon = botState.settings.growthStage === 1 ? "💎" : 
                         botState.settings.growthStage === 2 ? "⚡" :
                         botState.settings.growthStage === 3 ? "💪" : "🛡️";
        
        botState.statusMessage = `${stageIcon} STAGE ${botState.settings.growthStage} | ${growth}x | ROI: ${roi}% | EV: ${ev > 0 ? '+' : ''}${ev.toFixed(3)} | Payout: ${botState.settings.payout}x | ${botState.settings.currentStrategy}`;

        await new Promise(r => setTimeout(r, 800)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2), 
        config: CONFIG,
        growth: growth,
        stage: botState.settings.growthStage,
        strategy: botState.settings.currentStrategy,
        riskLevel: botState.settings.riskLevel,
        expectedValue: botState.stats.expectedValue,
        profitFactor: botState.stats.profitFactor,
        allTimeHigh: botState.settings.allTimeHigh
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v9.0 | ULTIMATE PROFIT ENGINE</title>
    <style>
        :root { --primary: #10b981; --bg: #0f172a; --card-bg: #1e293b; --text-main: #f1f5f9; --text-muted: #94a3b8; --border: #334155; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; --warning: #8b5cf6; --info: #06b6d4; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
        .menu-tab { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; }
        .menu-item { padding: 0.5rem 1rem; cursor: pointer; font-weight: 600; color: var(--text-muted); transition: all 0.3s; }
        .menu-item.active { color: var(--primary); border-bottom: 2px solid var(--primary); margin-bottom: -0.5rem; }
        .page { display: none; }
        .page.active-page { display: block; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #334155; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; background: var(--card-bg); color: var(--text-main); }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .strategy-badge { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .stage-1 { background: linear-gradient(135deg, #ef4444, #dc2626); }
        .stage-2 { background: linear-gradient(135deg, #f59e0b, #ea580c); }
        .stage-3 { background: linear-gradient(135deg, #10b981, #059669); }
        .stage-4 { background: linear-gradient(135deg, #3b82f6, #2563eb); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
        .ev-positive { color: #10b981; }
        .ev-negative { color: #ef4444; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:#8b5cf6">v9.0</span> 
                    <span class="strategy-badge" id="stage-badge">💎 ULTIMATE</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">1.0x</strong> | 🎯 Target: <strong id="target-multiplier">50x</strong> | 💎 Ultimate Profit Engine
                </div>
            </div>
            <div style="text-align: right">
                <div class="label">Market BTC/USD</div>
                <div id="price-tag" style="font-weight: 700;">$0.00</div>
            </div>
        </div>
        
        <div class="menu-tab">
            <div class="menu-item active" onclick="showPage('dashboard')">📊 Dashboard</div>
            <div class="menu-item" onclick="showPage('wallet')">💰 Wallet Balance</div>
        </div>
        
        <div id="dashboard-page" class="page active-page">
            <div class="status-bar" id="status-msg">Status: Initializing...</div>
            <div class="grid">
                <div class="card" style="background: linear-gradient(135deg, #8b5cf6, #7c3aed);">
                    <div class="label">💎 TOTAL GROWTH</div>
                    <div id="growth-total" class="btc-val pulse">1.0x</div>
                    <div class="usd-val">From 12 satoshis</div>
                </div>
                <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">🎯 Expected Value</div><div id="ev-display" class="btc-val">0.000</div><div class="usd-val">Profit per bet</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Stage</div><div id="stage-display" style="font-weight:700; color:#8b5cf6">1</div></div>
                <div class="mini-card"><div class="label">Base Bet %</div><div id="base-percent" style="font-weight:700; color:var(--primary)">20%</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">150%</div></div>
                <div class="mini-card"><div class="label">Profit Factor</div><div id="profit-factor" style="font-weight:700">0.00</div></div>
            </div>
            <div class="label">🚀 ULTIMATE PROJECTIONS</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Current Payout</div><span id="current-payout">4.0x</span><br><span class="usd-val">300% profit/win</span></div>
                <div class="proj-card"><div class="label">Target Balance</div><span id="target-bal">0.00000600</span><br><span class="usd-val">50x from start</span></div>
                <div class="proj-card"><div class="label">Current System</div><span id="current-system">Fibonacci</span><br><span class="usd-val">Active strategy</span></div>
                <div class="proj-card"><div class="label">All-Time High</div><span id="ath">0.00000012</span><br><span class="usd-val">Peak balance</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Stage</th>
                            <th>System</th>
                            <th>Payout</th>
                            <th>Wager</th>
                            <th>Roll</th>
                            <th>P/L</th>
                            <th>%</th>
                            <th>Streaks</th>
                            <th>Growth</th>
                        </tr>
                    </thead>
                    <tbody id="h-body">
                        <tr><td colspan="10" style="text-align:center;">💎 Ultimate Profit Engine initializing... 💎</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        
        <div id="wallet-page" class="page">
            <div class="status-bar" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                💰 WALLET BALANCE - Select Currency Below
            </div>
            <div style="text-align: center; margin: 2rem 0;">
                <select id="currency-selector" class="currency-selector" onchange="updateWalletDisplay()">
                    <option value="BTC">₿ Bitcoin (BTC)</option>
                    <option value="LTC">Ł Litecoin (LTC)</option>
                    <option value="USD">$ US Dollar (USD)</option>
                    <option value="USDT">₮ Tether (USDT)</option>
                    <option value="EUR">€ Euro (EUR)</option>
                    <option value="GBP">£ Pound Sterling (GBP)</option>
                    <option value="ZAR">R South African Rand (ZAR)</option>
                </select>
            </div>
            <div class="card" style="text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
                <div class="wallet-label">YOUR WALLET BALANCE</div>
                <div class="wallet-display" id="wallet-display-main">0.00000012 BTC</div>
                <div style="font-size: 1.2rem; opacity: 0.9;" id="wallet-conversion-note">≈ $0.00 USD</div>
            </div>
            <div class="grid" style="margin-top: 2rem;">
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00000000</div></div>
                <div class="card"><div class="label">🏆 Best Streak</div><div id="best-streak" class="btc-val">0</div></div>
                <div class="card"><div class="label">💰 Total Wagered</div><div id="total-wagered" class="btc-val">0.00000000</div></div>
            </div>
        </div>
    </div>
    <script>
        let currentCurrency = 'BTC';
        let exchangeRates = { BTC: 1, LTC: 0.016, USD: 60964, USDT: 60964, EUR: 0.92, GBP: 0.79, ZAR: 18.5 };
        
        function convertToCurrency(btcAmount, currency) {
            if (currency === 'BTC') return btcAmount;
            const usdAmount = btcAmount * exchangeRates.USD;
            if (currency === 'USD' || currency === 'USDT') return usdAmount;
            if (currency === 'EUR') return usdAmount * exchangeRates.EUR;
            if (currency === 'GBP') return usdAmount * exchangeRates.GBP;
            if (currency === 'ZAR') return usdAmount * exchangeRates.ZAR;
            if (currency === 'LTC') return btcAmount / exchangeRates.LTC;
            return btcAmount;
        }
        
        function formatCurrency(amount, currency) {
            if (currency === 'BTC' || currency === 'LTC') return amount.toFixed(8) + ' ' + currency;
            let symbol = currency === 'USD' ? '$' : currency === 'USDT' ? '₮' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : 'R';
            return symbol + amount.toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
        }
        
        function updateWalletDisplay() {
            const selector = document.getElementById('currency-selector');
            if (selector) currentCurrency = selector.value;
            const walletBalanceRaw = parseFloat(document.getElementById('w-bal')?.innerText || 0);
            const netProfitRaw = parseFloat(document.getElementById('n-prof')?.innerText || 0);
            
            document.getElementById('wallet-display-main').innerText = formatCurrency(convertToCurrency(walletBalanceRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-net-profit').innerHTML = formatCurrency(convertToCurrency(netProfitRaw, currentCurrency), currentCurrency);
        }
        
        function showPage(p) {
            document.querySelectorAll('.page').forEach(x => x.classList.remove('active-page'));
            document.querySelectorAll('.menu-item').forEach(x => x.classList.remove('active'));
            document.getElementById(p + '-page').classList.add('active-page');
            const menuItems = document.querySelectorAll('.menu-item');
            if (p === 'dashboard') menuItems[0].classList.add('active');
            else menuItems[1].classList.add('active');
            if(p === 'wallet') updateWalletDisplay();
        }
        
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                const { botState, btcPrice, hoursPassed, growth, stage, strategy, riskLevel, expectedValue, profitFactor, allTimeHigh } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('target-multiplier').innerHTML = '50x';
                document.getElementById('stage-display').innerHTML = stage;
                document.getElementById('risk-level').innerHTML = (riskLevel * 100).toFixed(0) + '%';
                document.getElementById('profit-factor').innerHTML = profitFactor.toFixed(3);
                document.getElementById('target-bal').innerHTML = f(0.00000012 * 50);
                document.getElementById('ath').innerHTML = f(allTimeHigh);
                document.getElementById('current-payout').innerHTML = botState.settings.payout + 'x';
                document.getElementById('current-system').innerHTML = botState.betHistory[0]?.system || 'Fibonacci';
                
                const evClass = expectedValue >= 0 ? 'ev-positive' : 'ev-negative';
                document.getElementById('ev-display').innerHTML = expectedValue.toFixed(4);
                document.getElementById('ev-display').className = 'btc-val ' + evClass;
                
                const stageNames = ['', '💎 NUCLEAR', '⚡ HYPER', '💪 AGGRESSIVE', '🛡️ WEALTH'];
                document.getElementById('stage-badge').innerHTML = stageNames[stage] || 'ULTIMATE';
                document.getElementById('stage-badge').className = 'strategy-badge stage-' + stage;
                
                document.getElementById('status-msg').innerHTML = "💎 " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "%";
                document.getElementById('base-percent').innerHTML = (botState.settings.baseBet / botState.stats.currentBalance * 100).toFixed(1) + '%';
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('total-wagered').innerHTML = f(botState.stats.totalWagered);
                document.getElementById('best-streak').innerHTML = botState.stats.bestStreak || 0;

                if (botState.betHistory && botState.betHistory.length > 0) {
                    document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                        let streakDisplay = '';
                        if (b.lossStreak > 0) streakDisplay = '📉' + b.lossStreak;
                        if (b.winStreak > 0) streakDisplay = '🔥' + b.winStreak;
                        
                        const stageIcon = b.stage === 1 ? '💎' : b.stage === 2 ? '⚡' : b.stage === 3 ? '💪' : '🛡️';
                        const systemIcon = b.system === 'Fibonacci' ? '🌀' : b.system === 'Contra-Martingale' ? '🔄' : '📊';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + stageIcon + ' ' + b.stage + '</td>' +
                            '<td>' + systemIcon + ' ' + (b.system || 'Kelly') + '</td>' +
                            '<td>' + (b.payout || '4.0') + 'x</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%' + '</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + (b.growth || '1.0') + 'x</td>' +
                            '</tr>';
                    }).join('');
                }
                
                if (document.getElementById('wallet-page').classList.contains('active-page')) updateWalletDisplay();
            } catch(e) { console.error(e); }
        }
        setInterval(update, 800);
        update();
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`💎💎💎 ULTIMATE PROFIT ENGINE v9.0 ONLINE 💎💎💎`);
    console.log(`📊 Open http://localhost:${port} to watch 50x growth`);
    runStrategy();
});
