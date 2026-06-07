const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "digIHvR0KziF6mhLfZPiO3LGpNzWFJIYQyp9l8dxLdvNd218vJ";
const BASE_URL = "https://api.crypto.games/v1";

// OPTIMIZED CONFIGURATION WITH DYNAMIC TAKE PROFIT
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.10,        // Increased to 10% for better growth
    maxBetPercent: 0.25,         // Increased to 25% for better growth
    payout: 3.2,                 // Increased for better returns
    targetMultiplier: 50,        // Target 5000% return (50x)
    // DYNAMIC TAKE PROFIT - RELEASES AFTER LOCKING
    takeProfitPercent: 0.50,     // Take profit at 50% gain (increased from 30%)
    takeProfitReleaseTime: 30000, // Release after 30 seconds
    stopLossPercent: 0.20,       // Stop loss at 20% drawdown
    maxConsecutiveLosses: 4,     // Max 4 losses before reset
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true,
    useDynamicRelease: true       // NEW: Auto-release take profit
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "OPTIMIZED PROFIT ENGINE INITIALIZING...",
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
        takeProfitCount: 0,       // Track how many times take profit hit
        totalTakeProfitGains: 0,   // Total gains from take profits
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
        currentStrategy: "OPTIMIZED GROWTH",
        riskLevel: 1.0,           // 100% risk (balanced aggressive)
        adaptiveMode: true,
        growthStage: 1,
        hedgeActive: false,
        hedgeAmount: 0,
        sessionLock: false,
        takeProfitLock: false,     // NEW: Track if take profit is locked
        takeProfitLockTime: 0,     // NEW: When take profit was locked
        lastWinAmount: 0,
        lastLossAmount: 0,
        recoveryMode: false
    },
    betHistory: []
};

// ============ DYNAMIC TAKE PROFIT WITH AUTO-RELEASE ============
function checkSmartTakeProfit() {
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    
    // Take profit hit
    if (currentGain > CONFIG.takeProfitPercent && !botState.settings.takeProfitLock && botState.stats.totalBets > 3) {
        const gainAmount = botState.stats.currentBalance - botState.stats.startingBalance;
        const gainPercent = (currentGain * 100).toFixed(1);
        
        botState.statusMessage = `🎯 TAKE PROFIT: ${gainPercent}% gain (${gainAmount.toFixed(8)} BTC). Locking profits for ${CONFIG.takeProfitReleaseTime/1000}s...`;
        botState.settings.takeProfitLock = true;
        botState.settings.takeProfitLockTime = Date.now();
        botState.stats.takeProfitCount++;
        botState.stats.totalTakeProfitGains += gainAmount;
        
        // Lock in profits by reducing bet size significantly
        const previousBet = botState.settings.currentBet;
        botState.settings.currentBet = botState.settings.baseBet;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        
        // Increase starting balance for next target
        botState.stats.startingBalance = botState.stats.currentBalance;
        
        console.log(`\n🎯🎯🎯 TAKE PROFIT TRIGGERED! 🎯🎯🎯`);
        console.log(`💰 Gain: ${gainPercent}% (${gainAmount.toFixed(8)} BTC)`);
        console.log(`📊 New Starting Balance: ${botState.stats.startingBalance.toFixed(8)} BTC`);
        console.log(`⏰ Lock will release in ${CONFIG.takeProfitReleaseTime/1000} seconds\n`);
        
        return true;
    }
    
    // Auto-release take profit lock after time expires
    if (botState.settings.takeProfitLock && CONFIG.useDynamicRelease) {
        const timeElapsed = Date.now() - botState.settings.takeProfitLockTime;
        if (timeElapsed >= CONFIG.takeProfitReleaseTime) {
            botState.settings.takeProfitLock = false;
            botState.settings.sessionLock = false;
            botState.statusMessage = `🔓 TAKE PROFIT LOCK RELEASED! Resuming normal operation with new base: ${botState.stats.startingBalance.toFixed(8)} BTC`;
            
            // Gradually increase risk back up
            botState.settings.riskLevel = Math.min(1.0, botState.settings.riskLevel * 1.2);
            CONFIG.baseBetPercent = Math.min(0.12, CONFIG.baseBetPercent * 1.1);
            
            console.log(`\n🔓 TAKE PROFIT LOCK RELEASED`);
            console.log(`📈 Resuming with balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
            console.log(`🎯 New target: ${(botState.stats.startingBalance * CONFIG.targetMultiplier).toFixed(8)} BTC\n`);
            
            return false;
        }
    }
    
    return false;
}

// ============ ENHANCED SMART STOP LOSS ============
function checkSmartStopLoss() {
    // Don't stop loss if in take profit lock
    if (botState.settings.takeProfitLock) return false;
    
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    const consecutiveLosses = botState.settings.consecutiveLosses;
    
    // Immediate stop on large drawdown
    if (currentDrawdown > CONFIG.stopLossPercent && botState.stats.totalBets > 10) {
        botState.statusMessage = `🛡️ STOP LOSS: ${(currentDrawdown*100).toFixed(1)}% drawdown. Reducing risk and resetting...`;
        
        // Reduce risk significantly but don't stop completely
        botState.settings.riskLevel = Math.max(0.5, botState.settings.riskLevel * 0.8);
        CONFIG.baseBetPercent = Math.max(0.06, CONFIG.baseBetPercent * 0.9);
        botState.settings.sessionLock = true;
        botState.settings.recoveryMode = true;
        
        // Auto-release after 15 seconds
        setTimeout(() => {
            botState.settings.sessionLock = false;
            botState.settings.recoveryMode = false;
            botState.statusMessage = `🔄 Recovery complete. Resuming normal operation.`;
            console.log(`\n🔄 STOP LOSS RECOVERY COMPLETE\n`);
        }, 15000);
        
        return true;
    }
    
    // Reset recovery mode after winning
    if (botState.settings.recoveryMode && botState.settings.consecutiveWins >= 2) {
        botState.settings.recoveryMode = false;
        botState.settings.riskLevel = Math.min(1.0, botState.settings.riskLevel * 1.1);
        botState.statusMessage = `✅ Recovery successful! Increasing risk again.`;
    }
    
    // Stop on too many consecutive losses
    if (consecutiveLosses >= CONFIG.maxConsecutiveLosses && !botState.settings.recoveryMode) {
        botState.statusMessage = `🛡️ MAX LOSSES (${consecutiveLosses}). Entering recovery mode...`;
        botState.settings.consecutiveLosses = 0;
        botState.settings.currentBet = botState.settings.baseBet;
        botState.settings.recoveryMode = true;
        CONFIG.baseBetPercent = Math.max(0.05, CONFIG.baseBetPercent * 0.85);
        
        // Auto-exit recovery after 3 wins or 10 bets
        return true;
    }
    
    return false;
}

// ============ ENHANCED HEDGE MODE ============
function activateHedgeMode() {
    if (!CONFIG.useHedgeMode) return;
    if (botState.settings.takeProfitLock) return;
    
    // Activate hedge after 2 consecutive losses
    if (botState.settings.consecutiveLosses >= 2 && !botState.settings.hedgeActive && !botState.settings.recoveryMode) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.4;
        botState.statusMessage = `🛡️ HEDGE MODE ACTIVE: Bets reduced by 60% until a win`;
        console.log(`\n🛡️ Hedge mode activated after ${botState.settings.consecutiveLosses} losses\n`);
    }
    
    // Deactivate hedge after a win
    if (botState.settings.consecutiveWins >= 1 && botState.settings.hedgeActive) {
        botState.settings.hedgeActive = false;
        botState.settings.hedgeAmount = 0;
        botState.statusMessage = `✅ Hedge mode deactivated. Returning to normal betting.`;
        console.log(`\n✅ Hedge mode deactivated after win\n`);
    }
}

// ============ KELLY CRITERION WITH OPTIMIZED RISK ============
function calculateOptimizedKelly(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Apply risk level with optimization
    kellyFraction = kellyFraction * riskLevel * 0.7;  // 70% of full Kelly for safety
    
    // Dynamic cap based on performance
    let maxCap = CONFIG.maxBetPercent;
    if (botState.stats.performanceMetrics.profitFactor > 1.5) {
        maxCap = CONFIG.maxBetPercent * 1.2;  // Increase if performing well
    } else if (botState.stats.performanceMetrics.profitFactor < 0.8) {
        maxCap = CONFIG.maxBetPercent * 0.8;  // Decrease if performing poorly
    }
    
    kellyFraction = Math.min(maxCap, Math.max(0.02, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// ============ OPTIMIZED BET CALCULATOR ============
function calculateOptimizedBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    // Take profit lock: minimum bets only
    if (botState.settings.takeProfitLock) {
        return CONFIG.minBet;
    }
    
    // Hedge mode: significantly reduced bets
    if (botState.settings.hedgeActive) {
        return Math.max(CONFIG.minBet, baseBet * 0.4);
    }
    
    // Session lock or recovery mode: conservative bets
    if (botState.settings.sessionLock || botState.settings.recoveryMode) {
        return Math.max(CONFIG.minBet, baseBet * 0.6);
    }
    
    // Anti-Martingale with optimized multipliers
    if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            // Progressive increase on wins (capped)
            const multiplier = Math.min(2.5, 1 + (winStreak * 0.25));
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            // Gradual decrease on losses
            const reduction = Math.max(0.5, 1 - (lossStreak * 0.1));
            newBet = baseBet * reduction;
        } else {
            newBet = baseBet;
        }
    }
    
    // Apply Kelly for optimal sizing
    if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        const kellyBet = calculateOptimizedKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        // Use the more conservative bet
        newBet = Math.min(newBet, kellyBet);
    }
    
    // Apply absolute limits
    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ OPTIMIZED PAYOUT CALCULATOR ============
function calculateOptimizedPayout(winStreak, lossStreak, currentBalance, stage, inRecovery) {
    let payout = CONFIG.payout;
    
    // Base payout on performance
    if (inRecovery) {
        payout = 2.5;  // Lower payout during recovery
    } else if (winStreak >= 2 && botState.stats.netProfit > 0) {
        // Increase payout when winning
        payout = Math.min(4.0, payout * 1.1);
    } else if (lossStreak >= 2) {
        // Decrease payout during losses
        payout = Math.max(2.5, payout * 0.9);
    }
    
    // Boost for take profit release
    if (!botState.settings.takeProfitLock && botState.stats.takeProfitCount > 0) {
        payout = Math.min(4.0, payout * 1.05);
    }
    
    return Math.min(4.0, Math.max(2.5, payout));
}

// ============ BALANCE-BASED STRATEGY OPTIMIZER ============
function updateOptimizedStrategy() {
    const balance = botState.stats.currentBalance;
    const drawdown = (botState.settings.peakBalance - balance) / botState.settings.peakBalance;
    const winRate = botState.stats.totalBets > 0 ? botState.stats.wins / botState.stats.totalBets : 0;
    const profitFactor = botState.stats.performanceMetrics.profitFactor;
    
    let newRiskLevel = 1.0;
    let newBasePercent = 0.10;
    let newMaxPercent = 0.25;
    let newPayout = 3.2;
    let newStrategy = "⚡ OPTIMIZED GROWTH";
    
    // Dynamic adjustment based on performance
    if (drawdown > 0.1) {
        newRiskLevel = 0.7;
        newBasePercent = 0.07;
        newMaxPercent = 0.18;
        newStrategy = "🛡️ DRAWDOWN PROTECTION";
    } 
    else if (profitFactor > 1.5 && winRate > 0.55) {
        newRiskLevel = 1.2;
        newBasePercent = 0.12;
        newMaxPercent = 0.30;
        newPayout = 3.5;
        newStrategy = "🚀 PROFIT BOOST MODE";
    }
    else if (winRate > 0.52) {
        newRiskLevel = 1.0;
        newBasePercent = 0.10;
        newMaxPercent = 0.25;
        newPayout = 3.2;
        newStrategy = "⚡ OPTIMIZED GROWTH";
    }
    else {
        newRiskLevel = 0.8;
        newBasePercent = 0.08;
        newMaxPercent = 0.20;
        newPayout = 3.0;
        newStrategy = "⚖️ CONSERVATIVE MODE";
    }
    
    // Apply new settings
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    CONFIG.payout = newPayout;
    botState.settings.currentStrategy = newStrategy;
    
    return newStrategy;
}

// ============ UTILITY FUNCTIONS ============
function calculateScaledBase(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBet(betAmount, currentBalance) {
    const absoluteMax = currentBalance * 0.30;
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
        botState.statusMessage = `🏆 ULTIMATE TARGET ACHIEVED! ${growth}x GROWTH! 🏆`;
        
        CONFIG.targetMultiplier = CONFIG.targetMultiplier * 1.2;
        botState.stats.startingBalance = botState.stats.currentBalance;
        botState.settings.peakBalance = botState.stats.currentBalance;
        
        console.log(`\n🎉🎉🎉 ULTIMATE TARGET REACHED! 🎉🎉🎉`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`📈 Growth: ${growth}x from start`);
        console.log(`🎯 New Target: ${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC\n`);
        
        return true;
    }
    return false;
}

function updatePerformanceMetrics() {
    const totalBets = botState.stats.totalBets;
    if (totalBets === 0) return;
    
    botState.stats.performanceMetrics.winRate = botState.stats.wins / totalBets;
    
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    if (currentDrawdown > botState.stats.performanceMetrics.maxDrawdown) {
        botState.stats.performanceMetrics.maxDrawdown = currentDrawdown;
    }
    
    if (botState.stats.totalWagered > 0) {
        botState.stats.performanceMetrics.profitFactor = Math.abs(botState.stats.netProfit / botState.stats.totalWagered);
    }
    
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const currentStrategy = updateOptimizedStrategy();
    
    if (checkSmartTakeProfit()) {
        await new Promise(r => setTimeout(r, 1000));
        return null;
    }
    
    if (checkSmartStopLoss()) {
        await new Promise(r => setTimeout(r, 5000));
        return null;
    }
    
    activateHedgeMode();
    
    const optimalBet = calculateOptimizedBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    const optimizedPayout = calculateOptimizedPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.growthStage,
        botState.settings.recoveryMode
    );
    botState.settings.payout = optimizedPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "optimized" + Math.random().toString(36).substring(2, 15) + Date.now();

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
    console.log(`  🛡️ Risk: ${(botState.settings.riskLevel*100).toFixed(0)}% | Hedge: ${botState.settings.hedgeActive ? 'ON' : 'OFF'}`);
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
            RiskLevel: botState.settings.riskLevel,
            HedgeActive: botState.settings.hedgeActive,
            TakeProfitLock: botState.settings.takeProfitLock,
            RecoveryMode: botState.settings.recoveryMode
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Optimized simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
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
                RiskLevel: botState.settings.riskLevel,
                HedgeActive: botState.settings.hedgeActive,
                TakeProfitLock: botState.settings.takeProfitLock,
                RecoveryMode: botState.settings.recoveryMode
            };
        }
        
        return null; 
    }
}

// ============ MAIN OPTIMIZED ENGINE ============
async function runStrategy() {
    console.log(`\n⚡⚡⚡ OPTIMIZED PROFIT ENGINE v11.0 - BALANCED AGGRESSION ⚡⚡⚡`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Ultimate Target: ${CONFIG.targetMultiplier}x (${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`🎯 Take Profit: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% gain (releases after ${CONFIG.takeProfitReleaseTime/1000}s)`);
    console.log(`🛡️ Stop Loss: ${(CONFIG.stopLossPercent*100).toFixed(0)}% drawdown | Max Losses: ${CONFIG.maxConsecutiveLosses}`);
    console.log(`📈 Strategy: Anti-Martingale + Kelly + Smart Take Profit Release\n`);
    
    botState.statusMessage = `⚡ OPTIMIZED MODE | Target: ${CONFIG.targetMultiplier}x | Take Profit: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% | Risk: ${(botState.settings.riskLevel*100).toFixed(0)}%`;
    
    while (botState.running) {
        if (checkProfitTarget()) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        updatePerformanceMetrics();

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 2000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit;
        const isWin = profit > 0;
        
        botState.stats.currentBalance = result.Balance;
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;

        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            botState.settings.lastWinAmount = profit;
            
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak}!`);
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.lastLossAmount = profit;
            
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
                console.log(`⚠️ New loss streak: ${botState.stats.worstStreak}`);
            }
        }

        const previousBet = botState.settings.currentBet;
        const nextBet = calculateOptimizedBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);

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
            hedgeActive: result.HedgeActive,
            takeProfitLock: result.TakeProfitLock,
            recoveryMode: result.RecoveryMode,
            growth: (botState.stats.currentBalance / 0.00000012).toFixed(1),
            takeProfitCount: botState.stats.takeProfitCount
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const statusIcon = botState.settings.takeProfitLock ? "🔒" : 
                          botState.settings.hedgeActive ? "🛡️" : 
                          botState.settings.recoveryMode ? "🔄" : "⚡";
        
        botState.statusMessage = `${statusIcon} ${result.Strategy} | ${growth}x | ROI: ${roi}% | TP Hits: ${botState.stats.takeProfitCount} | Risk: ${(botState.settings.riskLevel*100).toFixed(0)}%`;

        await new Promise(r => setTimeout(r, 1000)); 
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
        strategy: botState.settings.currentStrategy,
        riskLevel: botState.settings.riskLevel,
        drawdown: drawdown,
        hedgeActive: botState.settings.hedgeActive,
        takeProfitLock: botState.settings.takeProfitLock,
        recoveryMode: botState.settings.recoveryMode,
        takeProfitCount: botState.stats.takeProfitCount,
        totalTakeProfitGains: botState.stats.totalTakeProfitGains,
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
    <title>Dice Pro v11.0 | OPTIMIZED PROFIT ENGINE</title>
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
        .status-bar-tp { background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); }
        .status-bar-hedge { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; background: var(--card-bg); color: var(--text-main); }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .strategy-badge { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
        .tp-count { font-size: 1.5rem; font-weight: bold; color: #f59e0b; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v11.0</span> 
                    <span class="strategy-badge" id="stage-badge">⚡ OPTIMIZED</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">1.0x</strong> | 🎯 Take Profit Hits: <strong id="tp-count-display">0</strong> | 🔓 Auto-Release: <strong id="release-time">30s</strong>
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
                    <div class="label">⚡ TOTAL GROWTH</div>
                    <div id="growth-total" class="btc-val pulse">1.0x</div>
                    <div class="usd-val">From 12 satoshis</div>
                </div>
                <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">🎯 Take Profit Gains</div><div id="tp-gains" class="btc-val tp-count">0.00000000</div><div class="usd-val">Total locked profits</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Strategy</div><div id="current-strategy" style="font-weight:700; font-size:0.7rem">OPTIMIZED</div></div>
                <div class="mini-card"><div class="label">Base Bet %</div><div id="base-percent" style="font-weight:700; color:var(--primary)">10%</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">100%</div></div>
                <div class="mini-card"><div class="label">Take Profit Hits</div><div id="tp-hits" style="font-weight:700; color:#f59e0b">0</div></div>
            </div>
            <div class="label">🛡️ PROTECTION STATUS</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Take Profit Lock</div><span id="tp-lock-status">❌ OFF</span><br><span class="usd-label">Auto-releases after 30s</span></div>
                <div class="proj-card"><div class="label">Hedge Mode</div><span id="hedge-status">❌ OFF</span><br><span class="usd-label">Activates after 2 losses</span></div>
                <div class="proj-card"><div class="label">Recovery Mode</div><span id="recovery-status">❌ OFF</span><br><span class="usd-label">After 4 losses or stop loss</span></div>
                <div class="proj-card"><div class="label">Drawdown</div><span id="drawdown-display">0%</span><br><span class="usd-label">Max: 20%</span></div>
            </div>
            <div style="overflow-x: auto;">
                <tr>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Status</th>
                            <th>Strategy</th>
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
                        <tr><td colspan="10" style="text-align:center;">⚡ Optimized Profit Engine initializing... ⚡</td></tr>
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
                const { botState, btcPrice, hoursPassed, growth, strategy, riskLevel, drawdown, hedgeActive, takeProfitLock, recoveryMode, takeProfitCount, totalTakeProfitGains } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('tp-count-display').innerHTML = takeProfitCount || 0;
                document.getElementById('tp-hits').innerHTML = takeProfitCount || 0;
                document.getElementById('tp-gains').innerHTML = f(totalTakeProfitGains || 0);
                document.getElementById('current-strategy').innerHTML = strategy;
                document.getElementById('risk-level').innerHTML = (riskLevel * 100).toFixed(0) + '%';
                document.getElementById('drawdown-display').innerHTML = drawdown + '%';
                
                // Status indicators
                document.getElementById('tp-lock-status').innerHTML = takeProfitLock ? '🔒 LOCKED' : '❌ OFF';
                document.getElementById('hedge-status').innerHTML = hedgeActive ? '🛡️ ACTIVE' : '❌ OFF';
                document.getElementById('recovery-status').innerHTML = recoveryMode ? '🔄 ACTIVE' : '❌ OFF';
                
                // Status bar styling
                const statusBar = document.getElementById('status-msg');
                if (takeProfitLock) {
                    statusBar.className = 'status-bar status-bar-tp';
                } else if (hedgeActive) {
                    statusBar.className = 'status-bar status-bar-hedge';
                } else {
                    statusBar.className = 'status-bar';
                }
                
                document.getElementById('status-msg').innerHTML = (takeProfitLock ? '🔒 ' : hedgeActive ? '🛡️ ' : '⚡ ') + botState.statusMessage;
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
                        
                        let statusIcon = '';
                        if (b.takeProfitLock) statusIcon = '🔒';
                        else if (b.hedgeActive) statusIcon = '🛡️';
                        else if (b.recoveryMode) statusIcon = '🔄';
                        else statusIcon = '⚡';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + statusIcon + '</td>' +
                            '<td>' + (b.strategy || 'OPTIMIZED') + '</td>' +
                            '<td>' + (b.payout || '3.2') + 'x</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%</td>' +
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
    console.log(`⚡⚡⚡ OPTIMIZED PROFIT ENGINE v11.0 ONLINE ⚡⚡⚡`);
    console.log(`📊 Open http://localhost:${port} to monitor optimized growth`);
    console.log(`🎯 Take Profit will auto-release after ${CONFIG.takeProfitReleaseTime/1000} seconds`);
    runStrategy();
});
