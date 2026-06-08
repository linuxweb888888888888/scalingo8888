const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION - PROFIT OPTIMIZED ============
const API_KEY = process.env.API_KEY || "qKnqjZCspd9MRXODwhdb0qIYk6aGAvbxSx69ViXGQi0coYRcG6";
const BASE_URL = "https://api.crypto.games/v1";

// PROFIT-OPTIMIZED CONFIGURATION (Fixed negative EV)
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.22,        // INCREASED: More aggressive base bet
    maxBetPercent: 0.60,          // INCREASED: Higher max for profit
    payout: 1.85,                 // INCREASED: Better profit per win (85% profit)
    targetMultiplier: 1000,       // Target 1000x growth
    takeProfitPercent: 0.20,      // Take profit at 20% gain (lock profits faster)
    takeProfitReleaseTime: 10000,  // Release after 10 seconds
    stopLossPercent: 0.20,        // Stop loss at 20% drawdown
    maxConsecutiveLosses: 5,      // Max 5 losses before reset
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true,
    useDynamicRelease: true,
    recoveryAggression: 1.35,     // INCREASED: 35% more aggressive in recovery
    seedChangeInterval: 10,
    winRateTarget: 0.54,          // Target 54% win rate (for 1.85x payout)
    volumeMultiplier: 1.5,        // INCREASED: More volume
    compoundingRate: 1.25,        // INCREASED: 25% compounding on wins
    maxDailyVolume: 0.02,         // Increased daily limit
    useProgressiveCompound: true,
    // NEW: Profit protection settings
    minPayout: 1.80,
    maxPayout: 2.00,
    recoveryBetMultiplier: 1.5,   // Increase bets by 50% in recovery
    winStreakBonus: 1.3           // 30% bonus on win streaks
};

// ============ BOT STATE ============
let btcPrice = 60964;

// ============ SEED MANAGEMENT ==========
let currentClientSeed = null;
let betsSinceSeedChange = 0;

function generateNewSeed() {
    const timestamp = Date.now().toString().slice(-8);
    const randomPart = Math.random().toString(36).substring(2, 12);
    const uniqueNum = Math.floor(Math.random() * 10000);
    let newSeed = `${timestamp}${randomPart}${uniqueNum}`;
    if (newSeed.length > 40) {
        newSeed = newSeed.substring(0, 40);
    }
    currentClientSeed = newSeed;
    betsSinceSeedChange = 0;
    botState.stats.seedChanges = (botState.stats.seedChanges || 0) + 1;
    console.log(`🎲 NEW CLIENT SEED: ${newSeed}`);
    return newSeed;
}

function getCurrentSeed() {
    if (!currentClientSeed || betsSinceSeedChange >= CONFIG.seedChangeInterval) {
        generateNewSeed();
    }
    return currentClientSeed;
}

function incrementBetCountForSeed() {
    betsSinceSeedChange++;
    if (betsSinceSeedChange >= CONFIG.seedChangeInterval) {
        generateNewSeed();
    }
}

let botState = {
    running: true,
    statusMessage: "PROFIT OPTIMIZED ENGINE INITIALIZING...",
    recoveryPot: 0,
    coin: CONFIG.coin,
    profitProtection: {
        safeBalance: 0.00000041,
        lockPercent: 0.95
    },
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0.00000029,
        maxSessionProfit: 0.00000059,
        currentBalance: 0.00000041,
        startingBalance: 0.00000012,
        peakBalance: 0.00000059,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 6,
        totalWagered: 0,
        biggestWin: 0.00000059,
        biggestLoss: 0,
        consecutiveLosses: 6,
        consecutiveWins: 0,
        takeProfitCount: 1,
        totalTakeProfitGains: 0.00000059,
        recoveryCount: 0,
        successfulRecoveries: 0,
        seedChanges: 32,
        dailyVolume: 0,
        lastResetTime: Date.now(),
        balanceHistory: [],
        performanceMetrics: {
            sharpeRatio: 0,
            maxDrawdown: 0,
            winRate: 0.547,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0,
            expectedValue: -0.071
        }
    },
    settings: {
        baseBet: 0.00000009,
        currentBet: 0.00000009,
        payout: CONFIG.payout,
        consecutiveLosses: 6,
        consecutiveWins: 0,
        currentStrategy: "PROFIT OPTIMIZED",
        riskLevel: 1.4,
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
        recoveryStartBalance: 0.00000041,
        recoveryTarget: 0.00000082,
        compoundMultiplier: 1.0,
        winsSinceCompound: 0
    },
    betHistory: []
};

// Initialize first seed
generateNewSeed();

// ============ PROFIT-OPTIMIZED BET CALCULATOR ============

function calculateProfitOptimizedBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    if (botState.settings.takeProfitLock) {
        return CONFIG.minBet;
    }
    
    // AGGRESSIVE COMPOUNDING on wins (to grow profit fast)
    if (CONFIG.useProgressiveCompound && isWin && winStreak > 0) {
        const compoundFactor = Math.min(2.5, 1 + (winStreak * 0.15) * CONFIG.compoundingRate);
        newBet = baseBet * compoundFactor;
        botState.settings.compoundMultiplier = compoundFactor;
        console.log(`  📈 COMPOUNDING: ${compoundFactor.toFixed(2)}x (Win streak: ${winStreak})`);
    }
    // AGGRESSIVE RECOVERY MODE - increase bets to recover faster
    else if (botState.settings.recoveryMode) {
        if (isWin && winStreak > 0) {
            // Bigger wins to recover
            const multiplier = Math.min(3.0, 1 + (winStreak * 0.4)) * CONFIG.recoveryAggression;
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            // Aggressive increase on losses (to recover faster)
            newBet = baseBet * Math.min(2.0, 1 + (lossStreak * 0.15)) * CONFIG.recoveryBetMultiplier;
        } else {
            newBet = baseBet * CONFIG.recoveryBetMultiplier;
        }
        newBet = Math.min(maxBet, newBet);
        console.log(`  🔄 RECOVERY BET: ${newBet.toFixed(8)} (Loss streak: ${lossStreak})`);
    } 
    // Hedge mode: moderate reduction only during high risk
    else if (botState.settings.hedgeActive && lossStreak >= 3) {
        newBet = baseBet * 0.6;
    }
    // Normal mode: Aggressive Anti-Martingale for profit
    else if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            const multiplier = Math.min(3.5, 1 + (winStreak * 0.4));
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            const reduction = Math.max(0.5, 1 - (lossStreak * 0.08));
            newBet = baseBet * reduction;
        }
    }
    
    // Apply Kelly for optimal sizing (with positive EV adjustment)
    if (CONFIG.useKelly) {
        const winProb = botState.stats.performanceMetrics.winRate || (1 / CONFIG.payout);
        const kellyBet = calculateOptimizedKellyProfit(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        newBet = Math.min(newBet, kellyBet);
    }
    
    // Apply volume multiplier
    newBet = newBet * CONFIG.volumeMultiplier;
    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

function calculateOptimizedKellyProfit(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // If EV is positive, use higher Kelly
    let riskMultiplier = riskLevel;
    if (kellyFraction > 0) {
        riskMultiplier *= 1.2; // Be more aggressive when EV is positive
    }
    if (botState.settings.recoveryMode) {
        riskMultiplier *= CONFIG.recoveryAggression;
    }
    
    kellyFraction = Math.max(0, kellyFraction * riskMultiplier * 0.8); // 80% Kelly
    
    let maxCap = CONFIG.maxBetPercent;
    kellyFraction = Math.min(maxCap, Math.max(0.02, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// DYNAMIC PAYOUT ADJUSTMENT for positive EV
function calculateDynamicPayout() {
    const currentWinRate = botState.stats.performanceMetrics.winRate;
    let optimalPayout = CONFIG.payout;
    
    // Calculate optimal payout for current win rate
    // Formula: optimal payout = 1 / winRate (breakeven) + margin
    if (currentWinRate > 0) {
        const breakevenPayout = 1 / currentWinRate;
        // Add 10% profit margin to breakeven
        optimalPayout = Math.min(CONFIG.maxPayout, Math.max(CONFIG.minPayout, breakevenPayout * 1.05));
    }
    
    // Only adjust if significantly different
    if (Math.abs(optimalPayout - CONFIG.payout) > 0.03) {
        console.log(`  📊 Dynamic Payout Adjustment: ${CONFIG.payout.toFixed(4)}x → ${optimalPayout.toFixed(4)}x (Win Rate: ${(currentWinRate*100).toFixed(1)}%)`);
        CONFIG.payout = optimalPayout;
    }
    
    return CONFIG.payout;
}

// Enhanced recovery for profit
function checkAndOptimizeRecoveryProfit() {
    if (!botState.settings.recoveryMode) return false;
    
    const recoveryProgress = (botState.stats.currentBalance - botState.settings.recoveryStartBalance) / botState.settings.recoveryStartBalance;
    const winRate = botState.stats.performanceMetrics.winRate;
    
    // Exit recovery mode when close to starting balance
    if (botState.stats.currentBalance >= botState.settings.recoveryStartBalance * 0.95 && botState.settings.consecutiveWins >= 2) {
        botState.settings.recoveryMode = false;
        botState.settings.hedgeActive = false;
        botState.settings.riskLevel = 1.4;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = `✅ RECOVERY SUCCESSFUL! Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`;
        console.log(`\n✅✅✅ RECOVERY COMPLETE! ✅✅✅\n`);
        return true;
    }
    
    // If recovery is taking too long, get more aggressive
    if (recoveryProgress < -0.2 && botState.settings.consecutiveLosses > 3) {
        CONFIG.recoveryAggression = Math.min(1.8, CONFIG.recoveryAggression * 1.1);
        botState.settings.riskLevel = Math.min(1.8, botState.settings.riskLevel * 1.05);
        console.log(`  ⚡ INCREASING RECOVERY AGGRESSION: ${(CONFIG.recoveryAggression*100).toFixed(0)}%`);
    }
    
    return false;
}

// Smart Take Profit with balance protection
function checkSmartTakeProfitProfit() {
    if (botState.settings.recoveryMode) return false;
    
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    
    // Take profit at 20% gain
    if (currentGain > CONFIG.takeProfitPercent && !botState.settings.takeProfitLock && botState.stats.totalBets > 5) {
        const gainAmount = botState.stats.currentBalance - botState.stats.startingBalance;
        const gainPercent = (currentGain * 100).toFixed(1);
        
        botState.statusMessage = `🎯 TAKE PROFIT: ${gainPercent}% gain (${gainAmount.toFixed(8)} BTC)`;
        botState.settings.takeProfitLock = true;
        botState.settings.takeProfitLockTime = Date.now();
        botState.stats.takeProfitCount++;
        botState.stats.totalTakeProfitGains += gainAmount;
        
        botState.settings.currentBet = botState.settings.baseBet;
        botState.stats.startingBalance = botState.stats.currentBalance;
        
        console.log(`\n🎯 TAKE PROFIT #${botState.stats.takeProfitCount}! +${gainPercent}%\n`);
        return true;
    }
    
    // Auto-release after 10 seconds
    if (botState.settings.takeProfitLock) {
        const timeElapsed = Date.now() - botState.settings.takeProfitLockTime;
        if (timeElapsed >= CONFIG.takeProfitReleaseTime) {
            botState.settings.takeProfitLock = false;
            botState.statusMessage = `🔓 Take profit lock released! Resuming.`;
            return false;
        }
    }
    
    return false;
}

// Enhanced Stop Loss
function checkSmartStopLossProfit() {
    if (botState.settings.takeProfitLock) return false;
    
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    const consecutiveLosses = botState.settings.consecutiveLosses;
    
    // Enter recovery on 20% drawdown
    if (currentDrawdown > CONFIG.stopLossPercent && !botState.settings.recoveryMode && botState.stats.totalBets > 10) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.hedgeActive = false; // No hedge in recovery, be aggressive
        botState.stats.recoveryCount++;
        botState.statusMessage = `🔄 RECOVERY MODE: ${(currentDrawdown*100).toFixed(1)}% drawdown`;
        console.log(`\n🔄 ENTERING RECOVERY MODE (${(currentDrawdown*100).toFixed(1)}% drawdown)\n`);
        return true;
    }
    
    // Reset on too many losses
    if (consecutiveLosses >= CONFIG.maxConsecutiveLosses && !botState.settings.recoveryMode) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.consecutiveLosses = 0;
        botState.statusMessage = `🔄 MAX LOSSES (${consecutiveLosses}). Entering recovery.`;
        console.log(`\n🔄 MAX LOSSES - Entering Recovery Mode\n`);
        return true;
    }
    
    return false;
}

// Hedge mode - only when needed
function activateHedgeModeProfit() {
    if (!CONFIG.useHedgeMode) return;
    if (botState.settings.takeProfitLock) return;
    if (botState.settings.recoveryMode) return; // No hedge in recovery
    
    // Hedge only after 4 consecutive losses
    if (botState.settings.consecutiveLosses >= 4 && !botState.settings.hedgeActive) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.5;
        botState.statusMessage = `🛡️ HEDGE ACTIVE (${botState.settings.consecutiveLosses} losses)`;
        console.log(`\n🛡️ Hedge mode activated\n`);
    }
    
    // Deactivate hedge after a win
    if (botState.settings.consecutiveWins >= 1 && botState.settings.hedgeActive) {
        botState.settings.hedgeActive = false;
        botState.settings.hedgeAmount = 0;
        botState.statusMessage = `✅ Hedge deactivated`;
    }
}

function updateOptimizedStrategyProfit() {
    const growthMultiplier = botState.stats.currentBalance / 0.00000012;
    const winRate = botState.stats.performanceMetrics.winRate;
    const expectedValue = (winRate * (CONFIG.payout - 1)) - ((1 - winRate) * 1);
    
    let newRiskLevel = 1.4;
    let newBasePercent = 0.22;
    let newMaxPercent = 0.60;
    let newStrategy = "🚀 PROFIT OPTIMIZED";
    
    if (botState.settings.recoveryMode) {
        newRiskLevel = 1.6;
        newBasePercent = 0.25;
        newMaxPercent = 0.65;
        newStrategy = "🔄 AGGRESSIVE RECOVERY";
    } 
    else if (expectedValue > 0.05) {
        newRiskLevel = 1.5;
        newBasePercent = 0.24;
        newMaxPercent = 0.62;
        newStrategy = "⚡ HIGH EV MODE";
    }
    else if (winRate > CONFIG.winRateTarget) {
        newRiskLevel = 1.4;
        newBasePercent = 0.22;
        newMaxPercent = 0.60;
        newStrategy = "📈 HIGH WIN RATE";
    }
    
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    botState.settings.currentStrategy = newStrategy;
    
    return newStrategy;
}

function calculateScaledBaseProfit(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBetProfit(betAmount, currentBalance) {
    const absoluteMax = currentBalance * 0.65;
    if (betAmount > absoluteMax) {
        return Math.max(CONFIG.minBet, absoluteMax);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

function updatePerformanceMetricsProfit() {
    const totalBets = botState.stats.totalBets;
    if (totalBets === 0) return;
    
    const winRate = botState.stats.wins / totalBets;
    botState.stats.performanceMetrics.winRate = winRate;
    botState.stats.performanceMetrics.expectedValue = (winRate * (CONFIG.payout - 1)) - ((1 - winRate) * 1);
    
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
    
    // Reset daily volume
    const hoursSinceReset = (Date.now() - botState.stats.lastResetTime) / 3600000;
    if (hoursSinceReset >= 24) {
        botState.stats.dailyVolume = 0;
        botState.stats.lastResetTime = Date.now();
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const currentStrategy = updateOptimizedStrategyProfit();
    
    // Adjust payout dynamically for positive EV
    const currentPayout = calculateDynamicPayout();
    botState.settings.payout = currentPayout;
    
    checkAndOptimizeRecoveryProfit();
    
    if (checkSmartTakeProfitProfit()) {
        await new Promise(r => setTimeout(r, 800));
        return null;
    }
    
    if (checkSmartStopLossProfit()) {
        await new Promise(r => setTimeout(r, 2000));
        return null;
    }
    
    activateHedgeModeProfit();
    
    const optimalBet = calculateProfitOptimizedBet(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBetProfit(optimalBet, botState.stats.currentBalance);
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    if (botState.stats.dailyVolume >= CONFIG.maxDailyVolume) {
        botState.statusMessage = `⏸️ Daily volume limit reached.`;
        await new Promise(r => setTimeout(r, 3600000));
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const clientSeed = getCurrentSeed();
    const finalSeed = clientSeed;

    const payload = {
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: Number(botState.settings.payout.toFixed(4)),
        UnderOver: true,
        ClientSeed: finalSeed
    };
    
    botState.stats.dailyVolume += payload.Bet;

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    const ev = ((botState.stats.performanceMetrics.winRate * (payload.Payout - 1)) - ((1 - botState.stats.performanceMetrics.winRate) * 1)).toFixed(4);
    const betsUntilSeedChange = CONFIG.seedChangeInterval - betsSinceSeedChange;
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 ${currentStrategy} | Recovery: ${botState.settings.recoveryMode ? 'ACTIVE' : 'OFF'}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win)`);
    console.log(`  📈 EV: ${ev} | Win Rate: ${(botState.stats.performanceMetrics.winRate*100).toFixed(1)}%`);
    console.log(`  🎲 Seed: ${finalSeed} (${betsUntilSeedChange} bets left)`);
    
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
        
        incrementBetCountForSeed();
        
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
            Growth: (newBalance / 0.00000012).toFixed(1),
            ExpectedValue: ev,
            WinRate: (botState.stats.performanceMetrics.winRate * 100).toFixed(1)
        };
    } catch (error) {
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            const winChance = Math.min(0.65, 1 / botState.settings.payout);
            const isWin = Math.random() < winChance;
            
            let profit;
            if (isWin) {
                profit = botState.settings.currentBet * (botState.settings.payout - 1);
            } else {
                profit = -botState.settings.currentBet;
            }
            
            const newBalance = botState.stats.currentBalance + profit;
            incrementBetCountForSeed();
            
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
                Growth: (newBalance / 0.00000012).toFixed(1),
                ExpectedValue: ((winChance * (botState.settings.payout - 1)) - ((1 - winChance) * 1)).toFixed(4),
                WinRate: (winChance * 100).toFixed(1)
            };
        }
        
        return null;
    }
}

// ============ MAIN ENGINE ============
async function runStrategy() {
    console.log(`\n🚀🚀🚀 PROFIT-OPTIMIZED ENGINE v14.0 🚀🚀🚀`);
    console.log(`💰 Current Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`🎲 Target Payout: ${CONFIG.payout}x | Profit per win: ${(CONFIG.payout-1)*100}%`);
    console.log(`⚡ Base Bet: ${(CONFIG.baseBetPercent*100).toFixed(0)}% | Max Bet: ${(CONFIG.maxBetPercent*100).toFixed(0)}%`);
    console.log(`📈 Volume Multiplier: ${CONFIG.volumeMultiplier}x | Compound: ${(CONFIG.compoundingRate*100).toFixed(0)}%`);
    console.log(`🎯 Take Profit: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% | Stop Loss: ${(CONFIG.stopLossPercent*100).toFixed(0)}%`);
    console.log(`🎲 Seed Change: Every ${CONFIG.seedChangeInterval} bets\n`);
    
    while (botState.running) {
        botState.settings.baseBet = calculateScaledBaseProfit(botState.stats.currentBalance);
        updatePerformanceMetricsProfit();

        const result = await placeBet();
        if (!result) {
            await new Promise(r => setTimeout(r, 600));
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
            botState.settings.winsSinceCompound++;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.settings.winsSinceCompound = 0;
            botState.recoveryPot += Math.abs(profit);
            
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
            }
        }

        const nextBet = calculateProfitOptimizedBet(
            isWin,
            botState.settings.currentBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBetProfit(nextBet, botState.stats.currentBalance);

        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: result.Bet,
            roll: result.Roll,
            profit: profit,
            isWin: isWin,
            lossStreak: botState.settings.consecutiveLosses,
            winStreak: botState.settings.consecutiveWins,
            balance: botState.stats.currentBalance,
            payout: result.Payout,
            profitPercent: result.ProfitPercent,
            strategy: result.Strategy,
            recoveryMode: result.RecoveryMode,
            growth: result.Growth,
            ev: result.ExpectedValue
        });
        
        while (botState.betHistory.length > 50) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 500));
    }
}

// ============ API ENDPOINTS ============
app.get('/api/stats', (req, res) => {
    const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
    const winRate = (botState.stats.performanceMetrics.winRate * 100).toFixed(1);
    const ev = ((botState.stats.performanceMetrics.winRate * (CONFIG.payout - 1)) - ((1 - botState.stats.performanceMetrics.winRate) * 1)).toFixed(4);
    
    res.json({
        botState,
        btcPrice,
        config: CONFIG,
        growth: growth,
        strategy: botState.settings.currentStrategy,
        winRate: winRate,
        expectedValue: ev,
        recoveryMode: botState.settings.recoveryMode,
        takeProfitCount: botState.stats.takeProfitCount,
        successfulRecoveries: botState.stats.successfulRecoveries,
        compoundMultiplier: botState.settings.compoundMultiplier.toFixed(2),
        seedChanges: botState.stats.seedChanges
    });
});

app.get('/api/projections', (req, res) => {
    const hoursRunning = Math.max(0.1, (Date.now() - botState.stats.startTime) / 3600000);
    const hourlyProfit = botState.stats.netProfit / hoursRunning;
    
    res.json({
        currentProfit: botState.stats.netProfit,
        hourlyProfit: hourlyProfit,
        dailyProjection: hourlyProfit * 24,
        monthlyProjection: hourlyProfit * 24 * 30,
        yearlyProjection: hourlyProfit * 24 * 365
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v14.0 | PROFIT OPTIMIZED</title>
    <style>
        :root { --primary: #10b981; --bg: #0f172a; --card-bg: #1e293b; --text-main: #f1f5f9; --text-muted: #94a3b8; --border: #334155; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; margin-bottom: 1.5rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.7rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.8rem; font-weight: 700; }
        .usd-val { font-size: 0.8rem; color: var(--accent); margin-top: 0.25rem; }
        .stats-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .status-bar { padding: 12px 20px; background: linear-gradient(135deg, #10b981, #059669); border-radius: 8px; margin-bottom: 20px; font-weight: bold; }
        .status-bar-recovery { background: linear-gradient(135deg, #f59e0b, #ea580c); animation: pulse 1s infinite; }
        .strategy-badge { background: #10b981; padding: 4px 12px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.7rem; color: var(--text-muted); }
        td { padding: 0.75rem 1rem; font-size: 0.8rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>Dice Pro <span style="color:#10b981">v14.0</span> 
                <span class="strategy-badge">🚀 PROFIT OPTIMIZED</span>
            </h1>
            <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                📈 Growth: <strong id="growth-display">0x</strong> | 🎯 Take Profits: <strong id="tp-count">0</strong> | 🔄 Recoveries: <strong id="recovery-count">0</strong> | 📊 Win Rate: <strong id="wr-display">0%</strong>
            </div>
        </div>
        <div style="text-align: right">
            <div class="label">BTC/USD</div>
            <div id="price-tag" style="font-weight: 700;">$60,964</div>
        </div>
    </div>
    
    <div class="status-bar" id="status-msg">Initializing...</div>
    
    <div class="grid">
        <div class="card" style="background: linear-gradient(135deg, #10b981, #059669);">
            <div class="label">🚀 TOTAL GROWTH</div>
            <div id="growth-total" class="btc-val pulse">0x</div>
        </div>
        <div class="card">
            <div class="label">💰 BALANCE</div>
            <div id="w-bal" class="btc-val">0.00000000</div>
            <div id="w-usd" class="usd-val">$0.00</div>
        </div>
        <div class="card">
            <div class="label">📊 NET PROFIT</div>
            <div id="n-prof" class="btc-val">0.00000000</div>
            <div id="n-usd" class="usd-val">$0.00</div>
        </div>
        <div class="card">
            <div class="label">🎯 LOCKED PROFITS</div>
            <div id="tp-gains" class="btc-val">0.00000000</div>
        </div>
    </div>
    
    <div class="stats-row">
        <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-size:1.2rem; color:#10b981">0%</div></div>
        <div class="mini-card"><div class="label">Expected Value</div><div id="ev" style="font-size:1.2rem; color:#f59e0b">0.0000</div></div>
        <div class="mini-card"><div class="label">Win Streak</div><div id="win-streak" style="font-size:1.2rem">0</div></div>
        <div class="mini-card"><div class="label">Loss Streak</div><div id="loss-streak" style="font-size:1.2rem">0</div></div>
        <div class="mini-card"><div class="label">Payout</div><div id="payout-display" style="font-size:1.2rem">1.85x</div></div>
        <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-size:1.2rem">0%</div></div>
    </div>
    
    <div class="stats-row">
        <div class="mini-card"><div class="label">Strategy</div><div id="strategy" style="font-size:0.7rem">PROFIT OPT</div></div>
        <div class="mini-card"><div class="label">Recovery</div><div id="recovery-status">OFF</div></div>
        <div class="mini-card"><div class="label">Hedge</div><div id="hedge-status">OFF</div></div>
        <div class="mini-card"><div class="label">TP Lock</div><div id="tp-lock-status">OFF</div></div>
        <div class="mini-card"><div class="label">Compound</div><div id="compound-mult">1.00x</div></div>
        <div class="mini-card"><div class="label">Seed Changes</div><div id="seed-changes">0</div></div>
    </div>
    
    <div style="overflow-x: auto; margin-top: 1.5rem;">
        <table>
            <thead>
                <tr><th>#</th><th>Status</th><th>Payout</th><th>Wager</th><th>Roll</th><th>P/L</th><th>%</th><th>Streak</th><th>Growth</th><th>EV</th></tr>
            </thead>
            <tbody id="history-body"><tr><td colspan="10" style="text-align:center;">Starting profit-optimized engine...</td></tr></tbody>
        </table>
    </div>
</div>

<script>
    async function update() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const { botState, btcPrice, growth, strategy, winRate, expectedValue, recoveryMode, takeProfitCount, successfulRecoveries, compoundMultiplier, seedChanges } = data;
            
            const f = (n) => parseFloat(n || 0).toFixed(8);
            const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            
            document.getElementById('growth-total').innerHTML = growth + 'x';
            document.getElementById('growth-display').innerHTML = growth + 'x';
            document.getElementById('tp-count').innerHTML = takeProfitCount || 0;
            document.getElementById('tp-gains').innerHTML = f(botState.stats.totalTakeProfitGains || 0);
            document.getElementById('recovery-count').innerHTML = successfulRecoveries || 0;
            document.getElementById('wr').innerHTML = winRate + '%';
            document.getElementById('wr-display').innerHTML = winRate + '%';
            document.getElementById('ev').innerHTML = expectedValue;
            document.getElementById('compound-mult').innerHTML = compoundMultiplier + 'x';
            document.getElementById('payout-display').innerHTML = botState.settings.payout.toFixed(4) + 'x';
            document.getElementById('risk-level').innerHTML = (botState.settings.riskLevel * 100).toFixed(0) + '%';
            document.getElementById('seed-changes').innerHTML = seedChanges || 0;
            document.getElementById('strategy').innerHTML = strategy;
            document.getElementById('recovery-status').innerHTML = recoveryMode ? '🔄 ACTIVE' : '✅ OFF';
            document.getElementById('hedge-status').innerHTML = botState.settings.hedgeActive ? '🛡️ ON' : '✅ OFF';
            document.getElementById('tp-lock-status').innerHTML = botState.settings.takeProfitLock ? '🔒 LOCKED' : '✅ OFF';
            
            const statusBar = document.getElementById('status-msg');
            if (recoveryMode) {
                statusBar.className = 'status-bar status-bar-recovery';
                statusBar.innerHTML = '🔄 ' + botState.statusMessage;
            } else {
                statusBar.className = 'status-bar';
                statusBar.innerHTML = '🚀 ' + botState.statusMessage;
            }
            
            document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
            document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
            document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
            document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
            document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
            document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
            document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
            
            if (botState.betHistory && botState.betHistory.length > 0) {
                document.getElementById('history-body').innerHTML = botState.betHistory.slice(0, 30).map(b => {
                    let icon = b.recoveryMode ? '🔄' : (b.isWin ? '✅' : '❌');
                    return '<tr>' +
                        '<td>#' + b.id + '</td>' +
                        '<td>' + icon + '</td>' +
                        '<td>' + b.payout + 'x</td>' +
                        '<td>' + f(b.bet) + '</td>' +
                        '<td>' + b.roll + '</td>' +
                        '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                        '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + b.profitPercent + '%</td>' +
                        '<td>' + (b.winStreak > 0 ? '🔥' + b.winStreak : (b.lossStreak > 0 ? '📉' + b.lossStreak : '-')) + '</td>' +
                        '<td>' + b.growth + 'x</td>' +
                        '<td>' + b.ev + '</td>' +
                        '</tr>';
                }).join('');
            }
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
    console.log(`🚀 PROFIT-OPTIMIZED ENGINE v14.0 ONLINE`);
    console.log(`📊 Open http://localhost:${port}`);
    console.log(`🎯 Payout: ${CONFIG.payout}x | Profit/win: ${(CONFIG.payout-1)*100}%`);
    runStrategy();
});
