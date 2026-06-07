const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "3nNpAIQIAp9CvSKPnZ4wrLCgQks2Y6OCNNvcy5ScQ2uLJwYxJ9";
const BASE_URL = "https://api.crypto.games/v1";

// SMART CONFIGURATION WITH LOSS PROTECTION
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.08,       // Conservative 8% base (was 20%)
    maxBetPercent: 0.20,        // Max 20% of balance (was 60%)
    payout: 1.7,                // Conservative 3.0x (200% profit)
    targetMultiplier: 20,       // Target 2000% return
    stopLossPercent: 0.15,      // Stop loss at 15% drawdown (tight)
    takeProfitPercent: 0.30,    // Take profit at 30% gain
    maxConsecutiveLosses: 5,    // Max 5 losses before reset
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "BALANCED PROFIT ENGINE INITIALIZING...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    profitProtection: { 
        safeBalance: 0.00000012,
        lockPercent: 0.95
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
        consecutiveLosses: 0,
        consecutiveWins: 0,
        balanceHistory: [],
        performanceMetrics: {
            sharpeRatio: 0,
            maxDrawdown: 0,
            winRate: 0,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0
        }
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        currentStrategy: "BALANCED AGGRESSION",
        riskLevel: 0.8,          // 80% risk (balanced)
        adaptiveMode: true,
        growthStage: 1,
        hedgeActive: false,
        hedgeAmount: 0,
        sessionLock: false,
        lastWinAmount: 0,
        lastLossAmount: 0
    },
    betHistory: []
};

// ============ ENHANCED RISK MANAGEMENT ============

// Smart Stop Loss with recovery
function checkSmartStopLoss() {
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    const consecutiveLosses = botState.settings.consecutiveLosses;
    
    // Immediate stop on large drawdown
    if (currentDrawdown > CONFIG.stopLossPercent && botState.stats.totalBets > 10) {
        botState.statusMessage = `🛡️ STOP LOSS: ${(currentDrawdown*100).toFixed(1)}% drawdown. Reducing risk...`;
        // Reduce risk significantly
        botState.settings.riskLevel = Math.max(0.3, botState.settings.riskLevel * 0.7);
        CONFIG.baseBetPercent = Math.max(0.03, CONFIG.baseBetPercent * 0.8);
        botState.settings.sessionLock = true;
        
        // Wait for recovery
        setTimeout(() => {
            botState.settings.sessionLock = false;
            botState.statusMessage = `🔄 Recovery mode deactivated. Resuming normal operation.`;
        }, 30000);
        
        return true;
    }
    
    // Stop on too many consecutive losses
    if (consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
        botState.statusMessage = `🛡️ MAX LOSSES (${consecutiveLosses}). Resetting strategy...`;
        // Reset betting pattern
        botState.settings.consecutiveLosses = 0;
        botState.settings.currentBet = botState.settings.baseBet;
        CONFIG.baseBetPercent = Math.max(0.05, CONFIG.baseBetPercent * 0.9);
        
        return true;
    }
    
    return false;
}

// Smart Take Profit
function checkSmartTakeProfit() {
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    
    if (currentGain > CONFIG.takeProfitPercent && botState.stats.totalBets > 5) {
        botState.statusMessage = `🎯 TAKE PROFIT: ${(currentGain*100).toFixed(1)}% gain. Locking profits...`;
        // Lock in profits by reducing bet size
        botState.settings.currentBet = botState.settings.baseBet;
        botState.settings.riskLevel = Math.min(1.0, botState.settings.riskLevel * 0.8);
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        
        return true;
    }
    
    return false;
}

// Hedge Mode - Protect against losses
function activateHedgeMode() {
    if (!CONFIG.useHedgeMode) return;
    
    // Activate hedge after 2 consecutive losses
    if (botState.settings.consecutiveLosses >= 2 && !botState.settings.hedgeActive) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.5;
        botState.statusMessage = `🛡️ HEDGE MODE ACTIVE: Protecting against further losses`;
    }
    
    // Deactivate hedge after a win
    if (botState.settings.consecutiveWins >= 1 && botState.settings.hedgeActive) {
        botState.settings.hedgeActive = false;
        botState.settings.hedgeAmount = 0;
        botState.statusMessage = `✅ Hedge mode deactivated`;
    }
}

// ============ KELLY CRITERION WITH BALANCED RISK ============
function calculateBalancedKelly(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Apply reduced risk for loss protection
    kellyFraction = kellyFraction * riskLevel * 0.6;  // 60% of Kelly for safety
    
    // Cap at reasonable levels
    kellyFraction = Math.min(CONFIG.maxBetPercent, Math.max(0.02, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// ============ SMART BET CALCULATOR WITH LOSS MINIMIZATION ============
function calculateSmartBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    // Hedge mode: reduce bet size
    if (botState.settings.hedgeActive) {
        return Math.max(CONFIG.minBet, baseBet * 0.5);
    }
    
    // Session lock: minimum bets only
    if (botState.settings.sessionLock) {
        return CONFIG.minBet;
    }
    
    // Anti-Martingale (increase on wins, decrease on losses) - SAFER
    if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            // Conservative increase on wins
            const multiplier = Math.min(2, 1 + (winStreak * 0.2));
            newBet = baseBet * multiplier;
        } else if (!isWin) {
            // Decrease on losses to protect bankroll
            newBet = baseBet * Math.max(0.5, 1 - (lossStreak * 0.1));
        } else {
            newBet = baseBet;
        }
    }
    
    // Apply Kelly for optimal sizing
    if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        const kellyBet = calculateBalancedKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        // Use the smaller bet for safety (minimize losses)
        newBet = Math.min(newBet, kellyBet);
    }
    
    // Never bet more than 20% of balance
    newBet = Math.min(maxBet, newBet);
    newBet = Math.max(CONFIG.minBet, newBet);
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ SMART PAYOUT WITH RISK ADJUSTMENT ============
function calculateSmartPayout(winStreak, lossStreak, currentBalance, stage) {
    let payout = CONFIG.payout;
    
    // Base payout on risk level
    payout = 2.5 + (botState.settings.riskLevel * 0.5);
    
    // Adjust based on performance
    if (winStreak >= 2 && botState.stats.netProfit > 0) {
        // Slightly increase payout when winning
        payout = Math.min(4.0, payout * 1.1);
    } else if (lossStreak >= 2) {
        // Decrease payout during losses to protect bankroll
        payout = Math.max(2.0, payout * 0.9);
    }
    
    // Cap at safe levels
    return Math.min(4.0, Math.max(2.0, payout));
}

// ============ BALANCE-BASED STRATEGY OPTIMIZER ============
function updateBalancedStrategy() {
    const balance = botState.stats.currentBalance;
    const drawdown = (botState.settings.peakBalance - balance) / botState.settings.peakBalance;
    const winRate = botState.stats.totalBets > 0 ? botState.stats.wins / botState.stats.totalBets : 0;
    
    let newRiskLevel = 0.8;
    let newBasePercent = 0.08;
    let newMaxPercent = 0.20;
    let newPayout = 3.0;
    let newStrategy = "⚖️ BALANCED PROFIT";
    
    // Adjust based on drawdown
    if (drawdown > 0.1) {
        newRiskLevel = 0.5;       // Reduce risk during drawdown
        newBasePercent = 0.05;
        newMaxPercent = 0.15;
        newStrategy = "🛡️ DRAWDOWN PROTECTION";
    } 
    // Adjust based on win rate
    else if (winRate > 0.55 && drawdown < 0.05) {
        newRiskLevel = 1.0;       // Increase risk when winning
        newBasePercent = 0.10;
        newMaxPercent = 0.25;
        newPayout = 3.5;
        newStrategy = "🚀 PROFIT OPTIMIZATION";
    }
    // Normal mode
    else {
        newRiskLevel = 0.8;
        newBasePercent = 0.08;
        newMaxPercent = 0.20;
        newPayout = 3.0;
        newStrategy = "⚖️ BALANCED PROFIT";
    }
    
    // Apply new settings
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    CONFIG.payout = newPayout;
    botState.settings.currentStrategy = newStrategy;
    
    return newStrategy;
}

// ============ PROFIT MAXIMIZATION WITH LOSS MINIMIZATION ============
function calculateScaledBase(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBet(betAmount, currentBalance) {
    // Extra safety: never bet more than 25% of balance
    const absoluteMax = currentBalance * 0.25;
    if (betAmount > absoluteMax) {
        return Math.max(CONFIG.minBet, absoluteMax);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

function checkProfitTarget() {
    const targetAmount = 0.00000012 * CONFIG.targetMultiplier;
    
    if (botState.stats.currentBalance >= targetAmount) {
        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        botState.statusMessage = `🏆 TARGET ACHIEVED! ${growth}x GROWTH! 🏆`;
        
        // Increase target conservatively
        CONFIG.targetMultiplier = CONFIG.targetMultiplier * 1.2;
        botState.stats.startingBalance = botState.stats.currentBalance;
        botState.settings.peakBalance = botState.stats.currentBalance;
        
        console.log(`\n🎉 PROFIT TARGET REACHED! 🎉`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`📈 Growth: ${growth}x from start`);
        console.log(`🎯 New Target: ${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC\n`);
        
        return true;
    }
    return false;
}

// ============ PERFORMANCE TRACKING ============
function updatePerformanceMetrics() {
    const totalBets = botState.stats.totalBets;
    if (totalBets === 0) return;
    
    // Update win rate
    botState.stats.performanceMetrics.winRate = botState.stats.wins / totalBets;
    
    // Update max drawdown
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    if (currentDrawdown > botState.stats.performanceMetrics.maxDrawdown) {
        botState.stats.performanceMetrics.maxDrawdown = currentDrawdown;
    }
    
    // Update profit factor
    if (botState.stats.totalWagered > 0) {
        botState.stats.performanceMetrics.profitFactor = botState.stats.netProfit / botState.stats.totalWagered;
    }
    
    // Update peak balance
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
}

// ============ API LOGIC ============
async function placeBet() {
    // Update strategy
    const currentStrategy = updateBalancedStrategy();
    
    // Check smart stop loss
    if (checkSmartStopLoss()) {
        await new Promise(r => setTimeout(r, 5000));
        return null;
    }
    
    // Check smart take profit
    if (checkSmartTakeProfit()) {
        await new Promise(r => setTimeout(r, 5000));
        return null;
    }
    
    // Activate hedge mode if needed
    activateHedgeMode();
    
    // Calculate optimal bet
    const optimalBet = calculateSmartBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    // Calculate smart payout
    const smartPayout = calculateSmartPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.growthStage
    );
    botState.settings.payout = smartPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "balancedprofit" + Math.random().toString(36).substring(2, 15) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 Strategy: ${currentStrategy}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win)`);
    console.log(`  🛡️ Risk Level: ${(botState.settings.riskLevel*100).toFixed(0)}%`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    
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
            RiskLevel: botState.settings.riskLevel
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Balanced simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Balanced profit simulation");
            
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
                RiskLevel: botState.settings.riskLevel
            };
        }
        
        return null; 
    }
}

// ============ MAIN BALANCED ENGINE ============
async function runStrategy() {
    console.log(`\n⚖️⚖️⚖️ BALANCED PROFIT ENGINE v10.0 - OPTIMIZED FOR SAFETY & GROWTH ⚖️⚖️⚖️`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Target: ${CONFIG.targetMultiplier}x (${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`🛡️ Max Drawdown: ${(CONFIG.stopLossPercent*100).toFixed(0)}% | Max Losses: ${CONFIG.maxConsecutiveLosses}`);
    console.log(`📈 Strategy: Anti-Martingale + Kelly + Smart Stop Loss`);
    console.log(`⚖️ Risk Profile: BALANCED - Profit with Protection\n`);
    
    botState.statusMessage = `⚖️ BALANCED MODE | Target: ${CONFIG.targetMultiplier}x | Risk: ${(botState.settings.riskLevel*100).toFixed(0)}%`;
    
    while (botState.running) {
        // Check targets
        if (checkProfitTarget()) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        // Update base bet
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        // Update performance metrics
        updatePerformanceMetrics();

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
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;

        // Update streaks with loss minimization logic
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            // Record win amount for metrics
            botState.settings.lastWinAmount = profit;
            
            // Update best streak
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak}!`);
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            
            // Record loss amount for metrics
            botState.settings.lastLossAmount = profit;
            
            // Update worst streak
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
                console.log(`⚠️ New loss streak: ${botState.stats.worstStreak} (entering protection mode)`);
            }
            
            // Automatic risk reduction on losses
            if (botState.settings.consecutiveLosses >= 2) {
                botState.settings.riskLevel = Math.max(0.4, botState.settings.riskLevel * 0.9);
                console.log(`🛡️ Risk reduced to ${(botState.settings.riskLevel*100).toFixed(0)}% due to losses`);
            }
        }

        // Calculate next bet with loss minimization
        const previousBet = botState.settings.currentBet;
        const nextBet = calculateSmartBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);
        
        // Auto-adjust risk based on performance
        if (botState.stats.totalBets % 10 === 0 && botState.stats.totalBets > 0) {
            const recentWinRate = botState.stats.wins / botState.stats.totalBets;
            if (recentWinRate > 0.55) {
                botState.settings.riskLevel = Math.min(1.0, botState.settings.riskLevel * 1.05);
            } else if (recentWinRate < 0.45) {
                botState.settings.riskLevel = Math.max(0.5, botState.settings.riskLevel * 0.95);
            }
        }

        // Add to history with protection info
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
            strategy: result.Strategy,
            riskLevel: (result.RiskLevel * 100).toFixed(0) + '%',
            hedgeActive: botState.settings.hedgeActive,
            growth: (botState.stats.currentBalance / 0.00000012).toFixed(1)
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Status message with protection info
        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const protection = botState.settings.hedgeActive ? "🛡️ HEDGE" : 
                          botState.settings.sessionLock ? "🔒 LOCKED" : "✅ NORMAL";
        
        botState.statusMessage = `${protection} | ${result.Strategy} | ${growth}x | ROI: ${roi}% | Risk: ${(botState.settings.riskLevel*100).toFixed(0)}% | Next: ${botState.settings.currentBet.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1200)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
    const drawdown = ((botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance * 100).toFixed(1);
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2), 
        config: CONFIG,
        growth: growth,
        stage: botState.settings.growthStage,
        strategy: botState.settings.currentStrategy,
        riskLevel: botState.settings.riskLevel,
        drawdown: drawdown,
        hedgeActive: botState.settings.hedgeActive,
        sessionLock: botState.settings.sessionLock,
        performanceMetrics: botState.stats.performanceMetrics
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v10.0 | BALANCED PROFIT ENGINE</title>
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
        .status-bar { padding: 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .status-bar-protection { background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; background: var(--card-bg); color: var(--text-main); }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .strategy-badge { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .protection-badge { background: linear-gradient(135deg, #f59e0b, #ea580c); }
        .hedge-badge { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
        .drawdown-warning { color: #f59e0b; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v10.0</span> 
                    <span class="strategy-badge" id="stage-badge">⚖️ BALANCED</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">1.0x</strong> | 🛡️ Protection: <strong id="protection-status">ACTIVE</strong> | 🎯 Target: <strong id="target-multiplier">20x</strong>
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
                    <div class="label">⚖️ TOTAL GROWTH</div>
                    <div id="growth-total" class="btc-val pulse">1.0x</div>
                    <div class="usd-val">From 12 satoshis</div>
                </div>
                <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">🛡️ Max Drawdown</div><div id="drawdown-display" class="btc-val">0%</div><div class="usd-val">Protected at 15%</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Strategy</div><div id="current-strategy" style="font-weight:700; font-size:0.7rem">BALANCED</div></div>
                <div class="mini-card"><div class="label">Base Bet %</div><div id="base-percent" style="font-weight:700; color:var(--primary)">8%</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">80%</div></div>
                <div class="mini-card"><div class="label">Profit Factor</div><div id="profit-factor" style="font-weight:700">0.00</div></div>
            </div>
            <div class="label">🛡️ PROTECTION METRICS</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Hedge Mode</div><span id="hedge-status">❌ OFF</span><br><span class="usd-val">Activates after 2 losses</span></div>
                <div class="proj-card"><div class="label">Session Lock</div><span id="lock-status">❌ OFF</span><br><span class="usd-val">Activates on 15% drawdown</span></div>
                <div class="proj-card"><div class="label">Take Profit</div><span id="take-profit">30%</span><br><span class="usd-val">Locks in gains</span></div>
                <div class="proj-card"><div class="label">Stop Loss</div><span id="stop-loss">15%</span><br><span class="usd-val">Max drawdown protection</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Strategy</th>
                            <th>Risk</th>
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
                        <tr><td colspan="10" style="text-align:center;">⚖️ Balanced Profit Engine initializing... ⚖️</td></tr>
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
                const { botState, btcPrice, hoursPassed, growth, strategy, riskLevel, drawdown, hedgeActive, sessionLock, performanceMetrics } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('drawdown-display').innerHTML = drawdown + '%';
                document.getElementById('current-strategy').innerHTML = strategy;
                document.getElementById('risk-level').innerHTML = (riskLevel * 100).toFixed(0) + '%';
                document.getElementById('profit-factor').innerHTML = (performanceMetrics?.profitFactor || 0).toFixed(3);
                
                // Protection status
                document.getElementById('hedge-status').innerHTML = hedgeActive ? '✅ ACTIVE' : '❌ OFF';
                document.getElementById('lock-status').innerHTML = sessionLock ? '🔒 ACTIVE' : '❌ OFF';
                
                const statusBar = document.getElementById('status-msg');
                if (hedgeActive) {
                    statusBar.className = 'status-bar status-bar-protection';
                } else {
                    statusBar.className = 'status-bar';
                }
                
                document.getElementById('status-msg').innerHTML = (hedgeActive ? '🛡️ ' : '⚖️ ') + botState.statusMessage;
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
                        
                        const hedgeIcon = b.hedgeActive ? '🛡️' : '⚖️';
                        
                        return '<table>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + hedgeIcon + ' ' + (b.strategy || 'BALANCED') + '</td>' +
                            '<td>' + (b.riskLevel || '80%') + '</td>' +
                            '<td>' + (b.payout || '3.0') + 'x' + '</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%' + '</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + (b.growth || '1.0') + 'x' + '</td>' +
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
    console.log(`⚖️⚖️⚖️ BALANCED PROFIT ENGINE v10.0 ONLINE ⚖️⚖️⚖️`);
    console.log(`📊 Open http://localhost:${port} to monitor balanced growth`);
    runStrategy();
});
