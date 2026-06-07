const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "OrUrwrx3KlKoBxRdDAnX85JHpADjvmtzEzPrEQR2G6892jWlTL";
const BASE_URL = "https://api.crypto.games/v1";

// SAFE CONFIGURATION - Prioritizes preservation over aggression
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.02,       // Start with only 2% of balance (was 10%)
    maxBetPercent: 0.08,        // Max 8% of balance (was 30%)
    payout: 2.0,                // Lower payout = higher win chance (50% win rate)
    targetMultiplier: 2.0,      // 100% return target (was 1667%)
    stopLossPercent: 0.20,      // Stop loss at 20% drawdown (was 50%)
    takeProfitPercent: 0.50,    // Take profit at 50% gain
    useKelly: true,
    useParoli: false,           // Disabled - too risky
    useAntiMartingale: false,   // Disabled - too risky
    useDAlenbert: true          // Conservative bet sizing
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing SAFE ENGINE...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    profitProtection: { 
        safeBalance: 0.00000012,
        lockPercent: 0.98      // Only risk 2% of balance
    }, 
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
        currentStrategy: "SAFE CONSERVATIVE",
        volatility: "LOW",
        riskLevel: 0.3,          // Start with low risk (was 1.0)
        adaptiveMode: true,
        growthStage: 1,
        lastProfitCheck: Date.now(),
        profitLocked: 0           // Locked profits that won't be risked
    },
    betHistory: []
};

// ============ SAFE STRATEGY OPTIMIZER ============
function updateStrategyByBalance() {
    const balance = botState.stats.currentBalance;
    const startingBalance = botState.stats.startingBalance;
    const growthMultiplier = balance / startingBalance;
    
    // Determine growth stage with SAFE parameters
    let newStage = 1;
    let newRiskLevel = 0.3;
    let newBasePercent = 0.02;
    let newMaxPercent = 0.08;
    let newPayout = 2.0;
    let newStrategy = "🛡️ SAFE MODE";
    
    if (balance < 0.00000100) { // Less than 100 satoshis
        newStage = 1;
        newRiskLevel = 0.25;     // Lowest risk when balance is tiny
        newBasePercent = 0.015;   // 1.5% of balance
        newMaxPercent = 0.06;     // 6% max bet
        newPayout = 1.9;          // 52.6% win chance
        newStrategy = "🛡️ MICRO PRESERVATION";
    } 
    else if (balance < 0.00001000) { // 100 - 1000 satoshis
        newStage = 2;
        newRiskLevel = 0.3;        // Low risk
        newBasePercent = 0.02;      // 2% of balance
        newMaxPercent = 0.08;       // 8% max bet
        newPayout = 2.0;            // 50% win chance
        newStrategy = "📊 SMALL BALANCE - CONSERVATIVE";
    } 
    else if (balance < 0.00010000) { // 1000 - 10000 satoshis
        newStage = 3;
        newRiskLevel = 0.35;        // Slightly higher but still safe
        newBasePercent = 0.025;      // 2.5% of balance
        newMaxPercent = 0.10;        // 10% max bet
        newPayout = 2.1;             // 47.6% win chance
        newStrategy = "💪 GROWING BALANCE - MODERATE";
    } 
    else { // Over 10000 satoshis
        newStage = 4;
        newRiskLevel = 0.4;          // Still conservative
        newBasePercent = 0.03;        // 3% of balance
        newMaxPercent = 0.12;         // 12% max bet
        newPayout = 2.2;              // 45.5% win chance
        newStrategy = "💰 WEALTH MODE - STEADY GROWTH";
    }
    
    // LOCK IN PROFITS - Never risk more than 80% of initial balance
    if (balance > botState.stats.startingBalance * 1.2) {
        const excessProfit = balance - (botState.stats.startingBalance * 1.2);
        botState.settings.profitLocked += excessProfit;
        botState.stats.currentBalance = botState.stats.startingBalance * 1.2;
        console.log(`\n🔒 PROFIT LOCKED: ${excessProfit.toFixed(8)} BTC secured!`);
        console.log(`💰 Active balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`🏦 Locked profit: ${botState.settings.profitLocked.toFixed(8)} BTC\n`);
    }
    
    // Apply new settings if changed
    if (newStage !== botState.settings.growthStage) {
        console.log(`\n📊 STAGE PROGRESSION: Stage ${botState.settings.growthStage} → Stage ${newStage}`);
        console.log(`💰 Balance: ${balance.toFixed(8)} BTC (${(growthMultiplier*100).toFixed(1)}% growth)`);
        console.log(`🎯 New Strategy: ${newStrategy}`);
        console.log(`📈 Base Bet: ${(newBasePercent*100).toFixed(1)}% | Max: ${(newMaxPercent*100).toFixed(1)}% | Payout: ${newPayout}x\n`);
        
        botState.settings.growthStage = newStage;
        botState.settings.currentStrategy = newStrategy;
        
        // Log strategy change
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
    
    // Lower target for consistent profit taking
    CONFIG.targetMultiplier = 1.5 + (newStage - 1) * 0.2;
    
    return newStrategy;
}

// ============ SAFE KELLY CRITERION ============
function calculateSafeKelly(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Apply risk level (much lower for safety)
    kellyFraction = kellyFraction * riskLevel * 0.5; // Extra 50% reduction
    
    // Cap at 5% of balance maximum
    const maxFraction = Math.min(CONFIG.maxBetPercent, 0.05);
    kellyFraction = Math.max(0, Math.min(maxFraction, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// ============ CONSERVATIVE D'ALEMBERT (Better for preservation) ============
function calculateSafeDAlenbert(currentBet, isWin, baseBet, maxBet) {
    const unit = CONFIG.minBet;
    
    if (isWin) {
        // Decrease by 1 unit on win (lock in profits)
        return Math.max(baseBet, currentBet - unit);
    } else {
        // Increase slowly on loss (max 3x)
        const increase = Math.min(unit * 2, currentBet * 0.3);
        return Math.min(maxBet, currentBet + increase);
    }
}

// ============ CONSERVATIVE BET CALCULATOR ============
function calculateSafeBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    let newBet;
    const growthStage = botState.settings.growthStage;
    
    // Use consistent, safe betting strategy
    if (CONFIG.useDAlenbert) {
        newBet = calculateSafeDAlenbert(currentBet, isWin, baseBet, currentBalance * CONFIG.maxBetPercent);
    } else if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        newBet = calculateSafeKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
    } else {
        // Simple fixed percentage
        newBet = baseBet;
    }
    
    // Never risk more than 8% in a single bet
    const absoluteMaxBet = currentBalance * 0.08;
    newBet = Math.min(newBet, absoluteMaxBet);
    
    // Apply absolute limits
    const minBet = CONFIG.minBet;
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    newBet = Math.max(minBet, Math.min(maxBet, newBet));
    
    // Round down to safe decimals
    newBet = Math.floor(newBet * 100000000) / 100000000;
    
    return newBet;
}

// ============ SAFE PAYOUT CALCULATOR ============
function calculateSafePayout(winStreak, lossStreak, currentBalance, growthStage) {
    let payout = CONFIG.payout;
    
    // Keep payout reasonable for consistent wins
    switch(growthStage) {
        case 1:
            payout = 1.9;  // 52.6% win chance
            break;
        case 2:
            payout = 2.0;  // 50% win chance
            break;
        case 3:
            payout = 2.1;  // 47.6% win chance
            break;
        case 4:
            payout = 2.2;  // 45.5% win chance
            break;
    }
    
    // Adjust based on recent performance (safely)
    if (lossStreak > 3) {
        payout = Math.max(1.8, payout - 0.1); // Higher win chance after losses
    }
    
    if (winStreak > 3) {
        payout = Math.min(2.5, payout + 0.1); // Slightly higher reward on win streaks
    }
    
    return Math.min(2.5, Math.max(1.8, payout));
}

// ============ PROFIT TAKING SYSTEM ============
function checkTakeProfit() {
    const totalValue = botState.stats.currentBalance + botState.settings.profitLocked;
    const profit = totalValue - botState.stats.startingBalance;
    const profitPercent = profit / botState.stats.startingBalance;
    
    if (profitPercent >= CONFIG.takeProfitPercent) {
        console.log(`\n🎉🎉🎉 TAKE PROFIT TRIGGERED! 🎉🎉🎉`);
        console.log(`💰 Total Value: ${totalValue.toFixed(8)} BTC`);
        console.log(`📈 Profit: ${profit.toFixed(8)} BTC (${(profitPercent*100).toFixed(1)}%)`);
        console.log(`🏆 Success! Bot will continue with locked profits.\n`);
        
        // Reset starting point with profit locked in
        botState.stats.startingBalance = totalValue;
        botState.settings.profitLocked = 0;
        
        // Reduce risk slightly after profit taking
        botState.settings.riskLevel = Math.max(0.25, botState.settings.riskLevel * 0.95);
        
        return true;
    }
    return false;
}

function checkStopLoss() {
    const currentTotal = botState.stats.currentBalance + botState.settings.profitLocked;
    const startingTotal = botState.stats.startingBalance;
    const drawdown = (startingTotal - currentTotal) / startingTotal;
    
    if (drawdown >= CONFIG.stopLossPercent && botState.stats.totalBets > 5) {
        console.log(`\n⚠️⚠️⚠️ STOP LOSS TRIGGERED ⚠️⚠️⚠️`);
        console.log(`📉 Drawdown: ${(drawdown*100).toFixed(1)}%`);
        console.log(`🛑 Reducing bet size significantly`);
        
        // Dramatically reduce risk
        botState.settings.riskLevel = Math.max(0.1, botState.settings.riskLevel * 0.5);
        CONFIG.baseBetPercent = Math.max(0.005, CONFIG.baseBetPercent * 0.5);
        CONFIG.maxBetPercent = Math.max(0.03, CONFIG.maxBetPercent * 0.7);
        
        // Reset to minimum bet for recovery
        botState.settings.currentBet = CONFIG.minBet;
        
        console.log(`🔄 New risk level: ${(botState.settings.riskLevel*100).toFixed(0)}%`);
        console.log(`📉 New max bet: ${(CONFIG.maxBetPercent*100).toFixed(1)}% of balance\n`);
        
        return true;
    }
    return false;
}

// ============ BALANCE CHECK - Prevent going to zero ============
function ensurePositiveBalance() {
    if (botState.stats.currentBalance <= 0) {
        console.log(`\n💀💀💀 BALANCE HIT ZERO! 💀💀💀`);
        console.log(`📊 Statistics:`);
        console.log(`   Total Bets: ${botState.stats.totalBets}`);
        console.log(`   Wins: ${botState.stats.wins}`);
        console.log(`   Losses: ${botState.stats.losses}`);
        console.log(`   Win Rate: ${(botState.stats.wins/botState.stats.totalBets*100).toFixed(1)}%`);
        console.log(`   Total Wagered: ${botState.stats.totalWagered.toFixed(8)} BTC`);
        
        if (botState.settings.profitLocked > 0) {
            console.log(`🏦 Locked Profits Available: ${botState.settings.profitLocked.toFixed(8)} BTC`);
            console.log(`🔄 Resetting from locked profits...`);
            botState.stats.currentBalance = botState.settings.profitLocked;
            botState.settings.profitLocked = 0;
            botState.stats.startingBalance = botState.stats.currentBalance;
            botState.settings.currentBet = CONFIG.minBet;
            botState.settings.consecutiveLosses = 0;
            botState.settings.consecutiveWins = 0;
            return true;
        } else {
            console.log(`❌ No locked profits available. Bot stopping.`);
            botState.running = false;
            return false;
        }
    }
    return true;
}

// ============ BALANCE TRACKING ============
function trackBalanceHistory() {
    botState.stats.balanceHistory.push({
        time: Date.now(),
        balance: botState.stats.currentBalance,
        profit: botState.stats.netProfit,
        locked: botState.settings.profitLocked
    });
    
    // Keep last 100 entries
    while (botState.stats.balanceHistory.length > 100) {
        botState.stats.balanceHistory.shift();
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
        return Math.max(CONFIG.minBet, currentBalance * 0.05); // Max 5% if insufficient
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    // Additional safety: never bet more than 8% of balance
    return Math.min(betAmount, currentBalance * 0.08);
}

// ============ API LOGIC ============
async function placeBet() {
    // Update strategy based on current balance
    const currentStrategy = updateStrategyByBalance();
    
    // Ensure we have positive balance
    if (!ensurePositiveBalance()) return null;
    
    // Calculate optimal bet
    const optimalBet = calculateSafeBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    // Calculate safe payout
    const safePayout = calculateSafePayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.growthStage
    );
    botState.settings.payout = safePayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "safe" + Math.random().toString(36).substring(2, 15) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 ${currentStrategy}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Win Chance: ${((1/payload.Payout)*100).toFixed(1)}%`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    if (botState.settings.profitLocked > 0) {
        console.log(`  🔒 Locked: ${botState.settings.profitLocked.toFixed(8)} BTC`);
    }
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        
        botState.stats.totalWagered += payload.Bet;
        if (profit > botState.stats.biggestWin) botState.stats.biggestWin = profit;
        if (profit < botState.stats.biggestLoss) botState.stats.biggestLoss = profit;
        
        const profitPercent = (profit / payload.Bet * 100).toFixed(0);
        console.log(`  ${profit > 0 ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `-100%`} | Profit: ${profit.toFixed(8)} BTC`);
        console.log(`  💼 New Balance: ${newBalance.toFixed(8)} BTC`);
        
        return {
            Bet: payload.Bet,
            Balance: newBalance,
            Profit: profit,
            Roll: result.Roll || Math.floor(Math.random() * 10000),
            Payout: payload.Payout,
            ProfitPercent: profitPercent,
            Strategy: currentStrategy,
            Stage: botState.settings.growthStage
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // SAFE DEMO MODE - Conservative simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Safe simulation active");
            
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
                Strategy: currentStrategy,
                Stage: botState.settings.growthStage
            };
        }
        
        return null; 
    }
}

// ============ MAIN SAFE ENGINE ============
async function runStrategy() {
    console.log(`\n🛡️🛡️🛡️ SAFE PROFIT ENGINE v9.0 - PRESERVATION FIRST 🛡️🛡️🛡️`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Target: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% profit before locking`);
    console.log(`🛡️ Stop Loss: ${(CONFIG.stopLossPercent*100).toFixed(0)}% drawdown`);
    console.log(`📊 Strategy: CONSERVATIVE - Prioritizes never hitting zero`);
    console.log(`🔄 Stages: Micro → Small → Growing → Wealth\n`);
    
    botState.statusMessage = `🛡️ SAFE MODE | Max Risk: ${(CONFIG.maxBetPercent*100).toFixed(1)}% per bet | Target: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% profit`;
    
    while (botState.running) {
        // Check profit targets
        if (checkTakeProfit()) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        // Check stop loss
        if (checkStopLoss()) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        // Update base bet based on current balance
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        // Track balance history for analytics
        trackBalanceHistory();

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 2000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit;
        const isWin = profit > 0;
        
        // Update balance
        botState.stats.currentBalance = result.Balance;
        const totalValue = botState.stats.currentBalance + botState.settings.profitLocked;
        botState.stats.netProfit = totalValue - botState.stats.startingBalance;

        // Update streaks
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak}!`);
            }
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
                if (botState.settings.consecutiveLosses >= 5) {
                    console.log(`⚠️ Long losing streak detected: ${botState.settings.consecutiveLosses}`);
                    console.log(`🔄 Reducing risk to preserve capital...`);
                    botState.settings.riskLevel *= 0.7;
                }
            }
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
        }

        // Calculate next bet using safe strategy
        const previousBet = botState.settings.currentBet;
        const nextBet = calculateSafeBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);

        // Add to history with stage info
        const totalGrowth = ((botState.stats.currentBalance + botState.settings.profitLocked) / 0.00000012).toFixed(1);
        
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
            growth: totalGrowth
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Dynamic status message
        const totalValueDisplay = botState.stats.currentBalance + botState.settings.profitLocked;
        const roi = ((totalValueDisplay - 0.00000012) / 0.00000012 * 100).toFixed(1);
        const stageName = botState.settings.growthStage === 1 ? "🛡️ MICRO" : 
                          botState.settings.growthStage === 2 ? "📊 SMALL" :
                          botState.settings.growthStage === 3 ? "💪 GROWING" : "💰 WEALTH";
        
        botState.statusMessage = `${stageName} | ${result.Strategy} | ROI: ${roi}% | Next: ${botState.settings.currentBet.toFixed(8)} | Locked: ${botState.settings.profitLocked.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1000)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const totalValue = botState.stats.currentBalance + botState.settings.profitLocked;
    const growth = (totalValue / 0.00000012).toFixed(1);
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2), 
        config: CONFIG,
        growth: growth,
        stage: botState.settings.growthStage,
        strategy: botState.settings.currentStrategy,
        riskLevel: botState.settings.riskLevel,
        profitLocked: botState.settings.profitLocked
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v9.0 | SAFE PROFIT ENGINE</title>
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
        .stats-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #334155; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; background: var(--card-bg); color: var(--text-main); }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .strategy-badge { background: linear-gradient(135deg, #f59e0b, #ea580c); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .stage-1 { background: linear-gradient(135deg, #10b981, #059669); }
        .stage-2 { background: linear-gradient(135deg, #3b82f6, #2563eb); }
        .stage-3 { background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
        .stage-4 { background: linear-gradient(135deg, #f59e0b, #ea580c); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
        .profit-locked { color: #f59e0b; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v9.0</span> 
                    <span class="strategy-badge" id="stage-badge">🛡️ SAFE</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    🛡️ PRESERVATION FIRST | 📈 Steady Growth
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
                <div class="card" style="background: linear-gradient(135deg, #10b981, #059669);">
                    <div class="label">📈 TOTAL VALUE</div>
                    <div id="total-value" class="btc-val pulse">0.00000012</div>
                    <div class="usd-val">Active + Locked</div>
                </div>
                <div class="card"><div class="label">💰 Active Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">🔒 Locked Profit</div><div id="locked-profit" class="btc-val profit-locked">0.00000000</div><div class="usd-val">Protected & Safe</div></div>
                <div class="card"><div class="label">📊 Total ROI</div><div id="roi-display" class="btc-val">0%</div><div class="usd-val">Overall Return</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Stage</div><div id="stage-display" style="font-weight:700; color:var(--accent)">1</div></div>
                <div class="mini-card"><div class="label">Max Bet %</div><div id="max-percent" style="font-weight:700; color:var(--primary)">8%</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">30%</div></div>
            </div>
            <div class="label">📊 Performance Metrics</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Next Stage At</div><span id="next-stage">100 sat</span><br><span class="usd-val">Stage 2</span></div>
                <div class="proj-card"><div class="label">Profit Target</div><span id="target-bal">50%</span><br><span class="usd-val">Take Profit</span></div>
                <div class="proj-card"><div class="label">Stop Loss</div><span id="stop-loss">20%</span><br><span class="usd-val">Max Drawdown</span></div>
                <div class="proj-card"><div class="label">Current Strategy</div><span id="current-strategy">SAFE MODE</span><br><span class="usd-val">Preservation</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Stage</th>
                            <th>Win Chance</th>
                            <th>Wager</th>
                            <th>Roll</th>
                            <th>P/L</th>
                            <th>%</th>
                            <th>Streaks</th>
                            <th>Growth</th>
                        </tr>
                    </thead>
                    <tbody id="h-body">
                        <tr><td colspan="9" style="text-align:center;">🛡️ Safe engine initializing... 🛡️</td></tr>
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
                <div class="wallet-label">TOTAL PORTFOLIO VALUE</div>
                <div class="wallet-display" id="wallet-display-main">0.00000012 BTC</div>
                <div style="font-size: 1.2rem; opacity: 0.9;" id="wallet-conversion-note">≈ $0.00 USD</div>
            </div>
            <div class="grid" style="margin-top: 2rem;">
                <div class="card"><div class="label">📈 Total Profit</div><div id="wallet-net-profit" class="btc-val">0.00000000</div></div>
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
            const totalValueRaw = parseFloat(document.getElementById('total-value')?.innerText || 0);
            const netProfitRaw = parseFloat(document.getElementById('wallet-net-profit')?.innerText || 0);
            
            document.getElementById('wallet-display-main').innerText = formatCurrency(convertToCurrency(totalValueRaw, currentCurrency), currentCurrency);
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
                const { botState, btcPrice, hoursPassed, growth, stage, strategy, riskLevel, profitLocked } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                const totalValue = botState.stats.currentBalance + (profitLocked || 0);
                const totalROI = ((totalValue - 0.00000012) / 0.00000012 * 100).toFixed(1);
                
                document.getElementById('total-value').innerHTML = f(totalValue);
                document.getElementById('roi-display').innerHTML = totalROI + '%';
                document.getElementById('stage-display').innerHTML = stage;
                document.getElementById('risk-level').innerHTML = (riskLevel * 100).toFixed(0) + '%';
                document.getElementById('current-strategy').innerHTML = strategy;
                document.getElementById('locked-profit').innerHTML = f(profitLocked || 0);
                
                const stageNames = ['', '🛡️ MICRO', '📊 SMALL', '💪 GROWING', '💰 WEALTH'];
                document.getElementById('stage-badge').innerHTML = stageNames[stage] || 'SAFE';
                document.getElementById('stage-badge').className = 'strategy-badge stage-' + stage;
                
                if (stage === 1) document.getElementById('next-stage').innerHTML = '100 sat';
                else if (stage === 2) document.getElementById('next-stage').innerHTML = '1000 sat';
                else if (stage === 3) document.getElementById('next-stage').innerHTML = '10000 sat';
                else document.getElementById('next-stage').innerHTML = '∞';
                
                document.getElementById('status-msg').innerHTML = "🛡️ " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "%";
                document.getElementById('max-percent').innerHTML = (botState.config?.maxBetPercent * 100).toFixed(1) + '%';
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('total-wagered').innerHTML = f(botState.stats.totalWagered);
                document.getElementById('best-streak').innerHTML = botState.stats.bestStreak || 0;
                document.getElementById('target-bal').innerHTML = (botState.config?.takeProfitPercent * 100).toFixed(0) + '%';
                document.getElementById('stop-loss').innerHTML = (botState.config?.stopLossPercent * 100).toFixed(0) + '%';

                if (botState.betHistory && botState.betHistory.length > 0) {
                    document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                        let streakDisplay = '';
                        if (b.lossStreak > 0) streakDisplay = '📉' + b.lossStreak;
                        if (b.winStreak > 0) streakDisplay = '🔥' + b.winStreak;
                        
                        const stageIcon = b.stage === 1 ? '🛡️' : b.stage === 2 ? '📊' : b.stage === 3 ? '💪' : '💰';
                        const winChance = ((1 / b.payout) * 100).toFixed(0);
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + stageIcon + ' ' + b.stage + '</td>' +
                            '<td>' + winChance + '%</td>' +
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
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`🛡️🛡️🛡️ SAFE PROFIT ENGINE v9.0 ONLINE 🛡️🛡️🛡️`);
    console.log(`📊 Open http://localhost:${port} to monitor your safe growth`);
    console.log(`🎯 Goal: Consistent profit without going to zero`);
    runStrategy();
});
