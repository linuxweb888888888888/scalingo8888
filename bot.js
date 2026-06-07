const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "digIHvR0KziF6mhLfZPiO3LGpNzWFJIYQyp9l8dxLdvNd218vJ";
const BASE_URL = "https://api.crypto.games/v1";

// ENHANCED CONFIGURATION
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.12,
    maxBetPercent: 0.30,
    payout: 1.7,
    targetMultiplier: 100,
    takeProfitPercent: 0.40,
    takeProfitReleaseTime: 20000,
    stopLossPercent: 0.25,
    maxConsecutiveLosses: 6,
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true,
    useDynamicRelease: true,
    recoveryAggression: 1.2
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "RECOVERY OPTIMIZED ENGINE INITIALIZING...",
    recoveryPot: 0, 
    coin: CONFIG.coin,
    profitProtection: { 
        safeBalance: 0.00000081,
        lockPercent: 0.95
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0.00000010,
        maxSessionProfit: 0.00000059,
        currentBalance: 0.00000081,
        startingBalance: 0.00000012,
        peakBalance: 0.00000081,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 4,
        totalWagered: 0,
        biggestWin: 0.00000059,
        biggestLoss: 0,
        consecutiveLosses: 4,
        consecutiveWins: 0,
        takeProfitCount: 1,
        totalTakeProfitGains: 0.00000059,
        recoveryCount: 0,
        successfulRecoveries: 0,
        balanceHistory: [],
        // Profit tracking for projections
        hourlyProfit: [],
        dailyProfit: [],
        monthlyProfit: [],
        hourlyAverage: 0,
        dailyAverage: 0,
        monthlyAverage: 0
    },
    settings: {
        baseBet: 0.00000006,
        currentBet: 0.00000006,
        payout: CONFIG.payout,
        consecutiveLosses: 4,
        consecutiveWins: 0,
        currentStrategy: "RECOVERY OPTIMIZED",
        riskLevel: 0.8,
        adaptiveMode: true,
        growthStage: 2,
        hedgeActive: true,
        hedgeAmount: 0.00000003,
        sessionLock: false,
        takeProfitLock: false,
        takeProfitLockTime: 0,
        lastWinAmount: 0,
        lastLossAmount: 0,
        recoveryMode: true,
        recoveryStartBalance: 0.00000081,
        recoveryTarget: 0.00000120,
        lastProfitUpdate: Date.now(),
        profitUpdateInterval: 60000 // Update every minute
    },
    betHistory: []
};

// ============ PROFIT PROJECTION CALCULATIONS ============

// Calculate profit rate per hour based on actual performance
function calculateProfitProjections() {
    const now = Date.now();
    const runtimeHours = (now - botState.stats.startTime) / 3600000;
    
    if (runtimeHours < 0.01) return;
    
    // Current profit rate
    const totalProfit = botState.stats.netProfit;
    const profitPerHour = totalProfit / runtimeHours;
    
    // Calculate based on recent performance (last hour)
    let recentProfitPerHour = profitPerHour;
    if (botState.stats.balanceHistory.length > 0) {
        const lastHour = now - 3600000;
        const recentHistory = botState.stats.balanceHistory.filter(h => h.time > lastHour);
        if (recentHistory.length > 0) {
            const recentProfit = recentHistory[recentHistory.length - 1].profit - recentHistory[0].profit;
            recentProfitPerHour = recentProfit;
        }
    }
    
    // Use weighted average (70% recent, 30% overall for better accuracy)
    const weightedProfitPerHour = (recentProfitPerHour * 0.7) + (profitPerHour * 0.3);
    
    // Calculate projections
    const projections = {
        hourly: weightedProfitPerHour,
        daily: weightedProfitPerHour * 24,
        weekly: weightedProfitPerHour * 24 * 7,
        monthly: weightedProfitPerHour * 24 * 30,
        yearly: weightedProfitPerHour * 24 * 365,
        
        // Conservative projections (80% of current rate)
        conservativeHourly: weightedProfitPerHour * 0.8,
        conservativeDaily: weightedProfitPerHour * 24 * 0.8,
        conservativeMonthly: weightedProfitPerHour * 24 * 30 * 0.8,
        
        // Optimistic projections (120% of current rate)
        optimisticHourly: weightedProfitPerHour * 1.2,
        optimisticDaily: weightedProfitPerHour * 24 * 1.2,
        optimisticMonthly: weightedProfitPerHour * 24 * 30 * 1.2,
        
        // Based on win rate and average bet
        expectedValuePerBet: calculateExpectedValuePerBet(),
        expectedBetsPerHour: 60, // ~1 bet per minute
        expectedHourlyReturn: calculateExpectedValuePerBet() * 60,
        
        // Growth projections
        timeToDouble: calculateTimeToDouble(weightedProfitPerHour),
        timeTo10x: calculateTimeToTarget(weightedProfitPerHour, 10),
        timeTo100x: calculateTimeToTarget(weightedProfitPerHour, 100)
    };
    
    return projections;
}

function calculateExpectedValuePerBet() {
    if (botState.stats.totalBets === 0) return 0;
    const winRate = botState.stats.wins / botState.stats.totalBets;
    const avgWin = botState.stats.biggestWin > 0 ? botState.stats.biggestWin / botState.stats.wins : 0;
    const avgLoss = botState.stats.biggestLoss < 0 ? Math.abs(botState.stats.biggestLoss) / botState.stats.losses : 0;
    
    const ev = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    return ev;
}

function calculateTimeToDouble(profitPerHour, currentBalance = botState.stats.currentBalance) {
    if (profitPerHour <= 0) return Infinity;
    const targetBalance = currentBalance * 2;
    const profitNeeded = targetBalance - currentBalance;
    const hoursNeeded = profitNeeded / profitPerHour;
    return hoursNeeded;
}

function calculateTimeToTarget(profitPerHour, targetMultiplier) {
    if (profitPerHour <= 0) return Infinity;
    const targetBalance = botState.stats.startingBalance * targetMultiplier;
    const profitNeeded = targetBalance - botState.stats.currentBalance;
    const hoursNeeded = profitNeeded / profitPerHour;
    return hoursNeeded;
}

// Format time for display
function formatTime(hours) {
    if (hours === Infinity) return "∞";
    if (hours < 24) return `${hours.toFixed(1)} hours`;
    if (hours < 168) return `${(hours / 24).toFixed(1)} days`;
    if (hours < 720) return `${(hours / 24 / 7).toFixed(1)} weeks`;
    return `${(hours / 24 / 30).toFixed(1)} months`;
}

// Update profit history
function updateProfitHistory() {
    const now = Date.now();
    const lastUpdate = botState.settings.lastProfitUpdate;
    
    if (now - lastUpdate >= botState.settings.profitUpdateInterval) {
        botState.settings.lastProfitUpdate = now;
        
        // Record hourly profit
        botState.stats.hourlyProfit.push({
            time: now,
            profit: botState.stats.netProfit,
            balance: botState.stats.currentBalance
        });
        
        // Keep last 24 hours
        while (botState.stats.hourlyProfit.length > 24) {
            botState.stats.hourlyProfit.shift();
        }
        
        // Calculate averages
        if (botState.stats.hourlyProfit.length > 0) {
            const totalHourlyProfit = botState.stats.hourlyProfit[botState.stats.hourlyProfit.length - 1].profit - 
                                     botState.stats.hourlyProfit[0].profit;
            botState.stats.hourlyAverage = totalHourlyProfit / botState.stats.hourlyProfit.length;
            botState.stats.dailyAverage = botState.stats.hourlyAverage * 24;
            botState.stats.monthlyAverage = botState.stats.dailyAverage * 30;
        }
    }
}

// ============ RECOVERY OPTIMIZED FUNCTIONS ============

function checkAndOptimizeRecovery() {
    if (!botState.settings.recoveryMode) return false;
    
    const recoveryDrawdown = (botState.settings.recoveryStartBalance - botState.stats.currentBalance) / botState.settings.recoveryStartBalance;
    
    if (botState.stats.currentBalance >= botState.settings.recoveryStartBalance && botState.settings.consecutiveWins >= 2) {
        botState.settings.recoveryMode = false;
        botState.settings.hedgeActive = false;
        botState.settings.riskLevel = 1.0;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = `✅ RECOVERY SUCCESSFUL! Back to ${botState.stats.currentBalance.toFixed(8)} BTC.`;
        return true;
    }
    
    return false;
}

function checkSmartTakeProfit() {
    if (botState.settings.recoveryMode && botState.stats.currentBalance < botState.settings.recoveryStartBalance * 1.2) {
        return false;
    }
    
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    
    if (currentGain > CONFIG.takeProfitPercent && !botState.settings.takeProfitLock && botState.stats.totalBets > 3) {
        const gainAmount = botState.stats.currentBalance - botState.stats.startingBalance;
        botState.settings.takeProfitLock = true;
        botState.settings.takeProfitLockTime = Date.now();
        botState.stats.takeProfitCount++;
        botState.stats.totalTakeProfitGains += gainAmount;
        botState.settings.currentBet = botState.settings.baseBet;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        botState.stats.startingBalance = botState.stats.currentBalance;
        return true;
    }
    
    if (botState.settings.takeProfitLock && CONFIG.useDynamicRelease) {
        const timeElapsed = Date.now() - botState.settings.takeProfitLockTime;
        if (timeElapsed >= CONFIG.takeProfitReleaseTime) {
            botState.settings.takeProfitLock = false;
            botState.settings.sessionLock = false;
            return false;
        }
    }
    
    return false;
}

function checkSmartStopLoss() {
    if (botState.settings.takeProfitLock) return false;
    
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    const consecutiveLosses = botState.settings.consecutiveLosses;
    
    if (currentDrawdown > CONFIG.stopLossPercent && !botState.settings.recoveryMode && botState.stats.totalBets > 10) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.hedgeActive = true;
        botState.stats.recoveryCount++;
        return true;
    }
    
    if (consecutiveLosses >= CONFIG.maxConsecutiveLosses && !botState.settings.recoveryMode) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.consecutiveLosses = 0;
        return true;
    }
    
    return false;
}

function activateHedgeMode() {
    if (!CONFIG.useHedgeMode) return;
    if (botState.settings.takeProfitLock) return;
    
    if (botState.settings.recoveryMode && !botState.settings.hedgeActive) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.3;
        return;
    }
    
    if (botState.settings.consecutiveLosses >= 2 && !botState.settings.hedgeActive && !botState.settings.recoveryMode) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.5;
    }
    
    if (botState.settings.consecutiveWins >= 1 && botState.settings.hedgeActive && !botState.settings.recoveryMode) {
        botState.settings.hedgeActive = false;
        botState.settings.hedgeAmount = 0;
    }
    
    if (botState.settings.recoveryMode && botState.settings.consecutiveWins >= 2 && botState.settings.hedgeActive) {
        botState.settings.hedgeActive = false;
    }
}

function calculateRecoveryBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    if (botState.settings.takeProfitLock) {
        return CONFIG.minBet;
    }
    
    if (botState.settings.recoveryMode) {
        if (isWin && winStreak > 0) {
            const multiplier = Math.min(3, 1 + (winStreak * 0.3)) * CONFIG.recoveryAggression;
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak < 3) {
            newBet = baseBet * Math.min(1.5, 1 + (lossStreak * 0.15));
        } else {
            newBet = baseBet;
        }
        newBet = Math.min(maxBet * 0.8, newBet);
    } else if (botState.settings.hedgeActive) {
        newBet = baseBet * 0.5;
    } else if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            const multiplier = Math.min(2.5, 1 + (winStreak * 0.25));
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            const reduction = Math.max(0.5, 1 - (lossStreak * 0.1));
            newBet = baseBet * reduction;
        }
    }
    
    if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        const kellyBet = calculateOptimizedKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        newBet = Math.min(newBet, kellyBet);
    }
    
    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

function calculateOptimizedKelly(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    let riskMultiplier = riskLevel;
    if (botState.settings.recoveryMode) {
        riskMultiplier *= CONFIG.recoveryAggression;
    }
    
    kellyFraction = kellyFraction * riskMultiplier * 0.65;
    
    let maxCap = CONFIG.maxBetPercent;
    if (botState.settings.recoveryMode) {
        maxCap = CONFIG.maxBetPercent * 0.9;
    }
    
    kellyFraction = Math.min(maxCap, Math.max(0.02, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

function calculateRecoveryPayout(winStreak, lossStreak, currentBalance, inRecovery) {
    let payout = CONFIG.payout;
    
    if (inRecovery) {
        if (winStreak >= 2) {
            payout = 4.0;
        } else {
            payout = 3.8;
        }
    } else if (winStreak >= 2 && botState.stats.netProfit > 0) {
        payout = Math.min(4.0, payout * 1.1);
    } else if (lossStreak >= 2) {
        payout = Math.max(2.8, payout * 0.9);
    }
    
    return Math.min(4.5, Math.max(2.5, payout));
}

function updateOptimizedStrategy() {
    const balance = botState.stats.currentBalance;
    const growthMultiplier = balance / 0.00000012;
    const winRate = botState.stats.totalBets > 0 ? botState.stats.wins / botState.stats.totalBets : 0.372;
    
    let newRiskLevel = 0.8;
    let newBasePercent = 0.12;
    let newMaxPercent = 0.30;
    let newStrategy = "🔄 RECOVERY OPTIMIZED";
    
    if (botState.settings.recoveryMode) {
        newRiskLevel = 1.0;
        newBasePercent = 0.14;
        newMaxPercent = 0.32;
        newStrategy = "⚡ RECOVERY BOOST MODE";
    } else if (growthMultiplier > 10) {
        newRiskLevel = 0.9;
        newBasePercent = 0.10;
        newMaxPercent = 0.25;
        newStrategy = "📈 SUSTAINED GROWTH";
    } else if (winRate > 0.45) {
        newRiskLevel = 1.0;
        newBasePercent = 0.12;
        newMaxPercent = 0.30;
        newStrategy = "⚡ OPTIMIZED GROWTH";
    }
    
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    botState.settings.currentStrategy = newStrategy;
    
    return newStrategy;
}

function calculateScaledBase(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBet(betAmount, currentBalance) {
    const absoluteMax = currentBalance * 0.35;
    if (betAmount > absoluteMax) {
        return Math.max(CONFIG.minBet, absoluteMax);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

function updatePerformanceMetrics() {
    const totalBets = botState.stats.totalBets;
    if (totalBets === 0) return;
    
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
    
    // Update balance history for projections
    botState.stats.balanceHistory.push({
        time: Date.now(),
        balance: botState.stats.currentBalance,
        profit: botState.stats.netProfit
    });
    
    while (botState.stats.balanceHistory.length > 100) {
        botState.stats.balanceHistory.shift();
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const currentStrategy = updateOptimizedStrategy();
    
    checkAndOptimizeRecovery();
    updateProfitHistory();
    
    if (checkSmartTakeProfit()) {
        await new Promise(r => setTimeout(r, 1000));
        return null;
    }
    
    if (checkSmartStopLoss()) {
        await new Promise(r => setTimeout(r, 3000));
        return null;
    }
    
    activateHedgeMode();
    
    const optimalBet = calculateRecoveryBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    const recoveryPayout = calculateRecoveryPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.recoveryMode
    );
    botState.settings.payout = recoveryPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "recoveryopt" + Math.random().toString(36).substring(2, 15) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 Strategy: ${currentStrategy} | Recovery: ${botState.settings.recoveryMode ? 'ACTIVE' : 'OFF'}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win)`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (${(botState.stats.currentBalance/0.00000012).toFixed(1)}x growth)`);
    
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
            RecoveryMode: botState.settings.recoveryMode,
            HedgeActive: botState.settings.hedgeActive,
            TakeProfitLock: botState.settings.takeProfitLock,
            Growth: (newBalance / 0.00000012).toFixed(1)
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Recovery-optimized simulation
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
                RecoveryMode: botState.settings.recoveryMode,
                HedgeActive: botState.settings.hedgeActive,
                TakeProfitLock: botState.settings.takeProfitLock,
                Growth: (newBalance / 0.00000012).toFixed(1)
            };
        }
        
        return null; 
    }
}

// ============ MAIN ENGINE ============
async function runStrategy() {
    console.log(`\n🔄🔄🔄 RECOVERY-OPTIMIZED PROFIT ENGINE v12.0 🔄🔄🔄`);
    console.log(`💰 Current Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (${(botState.stats.currentBalance/0.00000012).toFixed(1)}x growth)`);
    console.log(`🎯 Ultimate Target: ${CONFIG.targetMultiplier}x (${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`📊 Win Rate: ${botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets*100).toFixed(1) : 0}% | Take Profits: ${botState.stats.takeProfitCount}\n`);
    
    botState.statusMessage = `🔄 RECOVERY MODE | Target: ${CONFIG.targetMultiplier}x | TP Hits: ${botState.stats.takeProfitCount}`;
    
    while (botState.running) {
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        updatePerformanceMetrics();

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 1500)); 
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
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.lastLossAmount = profit;
            
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
            }
        }

        const previousBet = botState.settings.currentBet;
        const nextBet = calculateRecoveryBet(
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
            recoveryMode: result.RecoveryMode,
            hedgeActive: result.HedgeActive,
            takeProfitLock: result.TakeProfitLock,
            growth: result.Growth
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const statusIcon = botState.settings.takeProfitLock ? "🔒" : 
                          botState.settings.recoveryMode ? "🔄" : 
                          botState.settings.hedgeActive ? "🛡️" : "⚡";
        
        botState.statusMessage = `${statusIcon} ${result.Strategy} | ${growth}x | ROI: ${roi}% | TP: ${botState.stats.takeProfitCount}`;

        await new Promise(r => setTimeout(r, 900)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
    const projections = calculateProfitProjections();
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2),
        growth: growth,
        projections: projections,
        strategy: botState.settings.currentStrategy,
        recoveryMode: botState.settings.recoveryMode,
        hedgeActive: botState.settings.hedgeActive,
        takeProfitLock: botState.settings.takeProfitLock,
        takeProfitCount: botState.stats.takeProfitCount,
        totalTakeProfitGains: botState.stats.totalTakeProfitGains,
        successfulRecoveries: botState.stats.successfulRecoveries
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v12.0 | RECOVERY OPTIMIZED + PROFIT PROJECTIONS</title>
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
        .projections-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .projection-card { background: linear-gradient(135deg, #1e293b, #0f172a); padding: 1rem; border-radius: 8px; text-align: center; border: 1px solid var(--border); }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .status-bar-recovery { background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); animation: pulse 1s infinite; }
        .projection-positive { color: #10b981; font-weight: bold; }
        .projection-negative { color: #ef4444; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; background: var(--card-bg); color: var(--text-main); }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .strategy-badge { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:#8b5cf6">v12.0</span> 
                    <span class="strategy-badge" id="stage-badge">📊 PROFIT PROJECTIONS</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">6.8x</strong> | 🎯 TP Hits: <strong id="tp-count-display">1</strong> | 🕐 Runtime: <strong id="runtime">0h</strong>
                </div>
            </div>
            <div style="text-align: right">
                <div class="label">Market BTC/USD</div>
                <div id="price-tag" style="font-weight: 700;">$60,964</div>
            </div>
        </div>
        
        <div class="menu-tab">
            <div class="menu-item active" onclick="showPage('dashboard')">📊 Dashboard</div>
            <div class="menu-item" onclick="showPage('wallet')">💰 Wallet Balance</div>
        </div>
        
        <div id="dashboard-page" class="page active-page">
            <div class="status-bar status-bar-recovery" id="status-msg">Status: Initializing...</div>
            
            <!-- Profit Projections Section -->
            <div class="label">📈 PROFIT PROJECTIONS (Based on Current Performance)</div>
            <div class="projections-grid">
                <div class="projection-card">
                    <div class="label">🕐 PER HOUR</div>
                    <div id="hourly-profit" class="btc-val projection-positive">0.00000000</div>
                    <div id="hourly-usd" class="usd-val">$0.000</div>
                    <div style="font-size: 0.7rem; margin-top: 5px;">Conservative: <span id="hourly-conservative">0.00000000</span> | Optimistic: <span id="hourly-optimistic">0.00000000</span></div>
                </div>
                <div class="projection-card">
                    <div class="label">📅 PER DAY</div>
                    <div id="daily-profit" class="btc-val projection-positive">0.00000000</div>
                    <div id="daily-usd" class="usd-val">$0.000</div>
                    <div style="font-size: 0.7rem; margin-top: 5px;">Conservative: <span id="daily-conservative">0.00000000</span> | Optimistic: <span id="daily-optimistic">0.00000000</span></div>
                </div>
                <div class="projection-card">
                    <div class="label">📆 PER MONTH</div>
                    <div id="monthly-profit" class="btc-val projection-positive">0.00000000</div>
                    <div id="monthly-usd" class="usd-val">$0.000</div>
                    <div style="font-size: 0.7rem; margin-top: 5px;">Conservative: <span id="monthly-conservative">0.00000000</span> | Optimistic: <span id="monthly-optimistic">0.00000000</span></div>
                </div>
            </div>
            
            <!-- Growth Projections -->
            <div class="grid">
                <div class="card" style="background: linear-gradient(135deg, #10b981, #059669);">
                    <div class="label">🎯 TOTAL GROWTH</div>
                    <div id="growth-total" class="btc-val pulse">6.8x</div>
                    <div class="usd-val">From 12 satoshis</div>
                </div>
                <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000081</div><div id="w-usd" class="usd-val">$0.049</div></div>
                <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000010</div><div id="n-usd" class="usd-val">$0.006</div></div>
                <div class="card"><div class="label">🎯 Time to Double</div><div id="time-to-double" class="btc-val">∞</div><div class="usd-val">At current rate</div></div>
            </div>
            
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">37.2%</div></div>
                <div class="mini-card"><div class="label">Strategy</div><div id="current-strategy" style="font-weight:700; font-size:0.7rem">RECOVERY</div></div>
                <div class="mini-card"><div class="label">EV per Bet</div><div id="ev-per-bet" style="font-weight:700">0.0000</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">4</div></div>
                <div class="mini-card"><div class="label">TP Hits</div><div id="tp-hits" style="font-weight:700; color:#f59e0b">1</div></div>
                <div class="mini-card"><div class="label">Bets/Hour</div><div id="bets-per-hour" style="font-weight:700">~60</div></div>
            </div>
            
            <div class="label">🛡️ PROTECTION STATUS</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Recovery Mode</div><span id="recovery-status">🔄 ACTIVE</span><br><span class="usd-label">+20% aggression</span></div>
                <div class="proj-card"><div class="label">Hedge Mode</div><span id="hedge-status">🛡️ ACTIVE</span><br><span class="usd-label">70% bet reduction</span></div>
                <div class="proj-card"><div class="label">Take Profit Lock</div><span id="tp-lock-status">❌ OFF</span><br><span class="usd-label">Auto-releases after 20s</span></div>
                <div class="proj-card"><div class="label">Time to 100x</div><span id="time-to-100x">∞</span><br><span class="usd-label">Target: 1200 satoshis</span></div>
            </div>
            
            <div style="overflow-x: auto;">
                <table>
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
                        <tr><td colspan="10" style="text-align:center;">🔄 Recovery Optimized Engine active - Recovering from losses... 🔄</td></tr>
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
                <div class="wallet-display" id="wallet-display-main">0.00000081 BTC</div>
                <div style="font-size: 1.2rem; opacity: 0.9;" id="wallet-conversion-note">≈ $0.049 USD</div>
            </div>
            <div class="grid" style="margin-top: 2rem;">
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00000010</div></div>
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
                const { botState, btcPrice, growth, projections, recoveryMode, hedgeActive, takeProfitLock, takeProfitCount, totalTakeProfitGains, hoursPassed } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                // Update profit projections
                if (projections) {
                    document.getElementById('hourly-profit').innerHTML = f(projections.hourly);
                    document.getElementById('hourly-usd').innerHTML = u(projections.hourly);
                    document.getElementById('hourly-conservative').innerHTML = f(projections.conservativeHourly);
                    document.getElementById('hourly-optimistic').innerHTML = f(projections.optimisticHourly);
                    
                    document.getElementById('daily-profit').innerHTML = f(projections.daily);
                    document.getElementById('daily-usd').innerHTML = u(projections.daily);
                    document.getElementById('daily-conservative').innerHTML = f(projections.conservativeDaily);
                    document.getElementById('daily-optimistic').innerHTML = f(projections.optimisticDaily);
                    
                    document.getElementById('monthly-profit').innerHTML = f(projections.monthly);
                    document.getElementById('monthly-usd').innerHTML = u(projections.monthly);
                    document.getElementById('monthly-conservative').innerHTML = f(projections.conservativeMonthly);
                    document.getElementById('monthly-optimistic').innerHTML = f(projections.optimisticMonthly);
                    
                    document.getElementById('ev-per-bet').innerHTML = projections.expectedValuePerBet.toFixed(8);
                    document.getElementById('time-to-double').innerHTML = projections.timeToDouble === Infinity ? '∞' : projections.timeToDouble.toFixed(1) + 'h';
                    document.getElementById('time-to-100x').innerHTML = projections.timeTo100x === Infinity ? '∞' : projections.timeTo100x.toFixed(1) + 'h';
                }
                
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('tp-count-display').innerHTML = takeProfitCount || 0;
                document.getElementById('tp-hits').innerHTML = takeProfitCount || 0;
                document.getElementById('runtime').innerHTML = hoursPassed + 'h';
                document.getElementById('current-strategy').innerHTML = botState.settings.currentStrategy;
                
                // Status indicators
                document.getElementById('recovery-status').innerHTML = recoveryMode ? '🔄 ACTIVE' : '❌ OFF';
                document.getElementById('hedge-status').innerHTML = hedgeActive ? '🛡️ ACTIVE' : '❌ OFF';
                document.getElementById('tp-lock-status').innerHTML = takeProfitLock ? '🔒 LOCKED' : '❌ OFF';
                
                // Status bar styling
                const statusBar = document.getElementById('status-msg');
                if (recoveryMode) {
                    statusBar.className = 'status-bar status-bar-recovery';
                } else {
                    statusBar.className = 'status-bar';
                }
                
                document.getElementById('status-msg').innerHTML = (recoveryMode ? '🔄 ' : hedgeActive ? '🛡️ ' : '⚡ ') + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "%";
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('total-wagered').innerHTML = f(botState.stats.totalWagered);
                document.getElementById('best-streak').innerHTML = botState.stats.bestStreak || 0;
                document.getElementById('bets-per-hour').innerHTML = '~' + Math.round(botState.stats.totalBets / Math.max(0.01, hoursPassed));

                if (botState.betHistory && botState.betHistory.length > 0) {
                    document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                        let streakDisplay = '';
                        if (b.lossStreak > 0) streakDisplay = '📉' + b.lossStreak;
                        if (b.winStreak > 0) streakDisplay = '🔥' + b.winStreak;
                        
                        let statusIcon = '';
                        if (b.takeProfitLock) statusIcon = '🔒';
                        else if (b.recoveryMode) statusIcon = '🔄';
                        else if (b.hedgeActive) statusIcon = '🛡️';
                        else statusIcon = '⚡';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + statusIcon + '</td>' +
                            '<td>' + (b.strategy || 'RECOVERY') + '</td>' +
                            '<td>' + (b.payout || '3.5') + 'x</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + (b.growth || '6.8') + 'x</td>' +
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
    console.log(`📊 PROFIT PROJECTIONS ENABLED - Real-time calculations`);
    console.log(`🔄 Open http://localhost:${port} to see hourly/daily/monthly projections`);
    runStrategy();
});
