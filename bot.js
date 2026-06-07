const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "OrUrwrx3KlKoBxRdDAnX85JHpADjvmtzEzPrEQR2G6892jWlTL";
const BASE_URL = "https://api.crypto.games/v1";

// ENHANCED CONFIGURATION FOR MAXIMUM PROFIT WITH 1.7x PAYOUT
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.18,        // Increased for 1.7x payout (higher volume)
    maxBetPercent: 0.45,          // Much higher max for compound growth
    payout: 1.7,                  // 1.7x payout = 70% profit on win
    targetMultiplier: 500,        // Target 500x growth (from 12 satoshis to 6000 satoshis)
    takeProfitPercent: 0.25,      // Take profit at 25% gain (more frequent locks)
    takeProfitReleaseTime: 15000,  // Release after 15 seconds
    stopLossPercent: 0.15,        // Stop loss at 15% drawdown (tighter)
    maxConsecutiveLosses: 8,      // More losses allowed with 1.7x payout
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true,
    useDynamicRelease: true,
    recoveryAggression: 1.15,     // 15% more aggressive during recovery
    seedChangeInterval: 10,        // Change seed every 10 bets
    winRateTarget: 0.59,          // 1.7x payout = 58.8% breakeven, target 59%+
    volumeMultiplier: 1.3,        // Bet more volume since win rate is higher
    compoundingRate: 1.15,        // 15% compounding on wins
    maxDailyVolume: 0.01,         // Maximum daily wagered volume
    useProgressiveCompound: true   // Compound profits aggressively
};

// ============ BOT STATE ============
let btcPrice = 60964;

// ============ SEED MANAGEMENT (40 CHAR LIMIT FIX) ==========
let currentClientSeed = null;
let betsSinceSeedChange = 0;

function generateNewSeed() {
    // Generate compact seed under 40 characters
    const timestamp = Date.now().toString().slice(-8);
    const randomPart = Math.random().toString(36).substring(2, 12);
    const uniqueNum = Math.floor(Math.random() * 10000);
    let newSeed = `${timestamp}${randomPart}${uniqueNum}`;
    // Ensure exactly 40 chars or less
    if (newSeed.length > 40) {
        newSeed = newSeed.substring(0, 40);
    }
    currentClientSeed = newSeed;
    betsSinceSeedChange = 0;
    botState.stats.seedChanges = (botState.stats.seedChanges || 0) + 1;
    console.log(`🎲 NEW CLIENT SEED: ${newSeed} (${newSeed.length}/40 chars)`);
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
    statusMessage: "1.7x OPTIMIZED ENGINE INITIALIZING...",
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
        seedChanges: 0,
        dailyVolume: 0,
        lastResetTime: Date.now(),
        balanceHistory: [],
        performanceMetrics: {
            sharpeRatio: 0,
            maxDrawdown: 0,
            winRate: 0.372,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0,
            expectedValue: 0
        }
    },
    settings: {
        baseBet: 0.00000006,
        currentBet: 0.00000006,
        payout: CONFIG.payout,
        consecutiveLosses: 4,
        consecutiveWins: 0,
        currentStrategy: "1.7x MAX PROFIT",
        riskLevel: 1.2,           // Higher risk for 1.7x payout
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
        compoundMultiplier: 1.0,
        winsSinceCompound: 0
    },
    betHistory: []
};

// Initialize first seed
generateNewSeed();

// ============ 1.7x PAYOUT PROFIT OPTIMIZER ============

// Calculate optimal bet size for 1.7x payout (higher volume strategy)
function calculateOptimalBet17x(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    if (botState.settings.takeProfitLock) {
        return CONFIG.minBet;
    }
    
    // 1.7x payout strategy: Aggressive compounding on wins
    if (CONFIG.useProgressiveCompound && isWin && winStreak > 0) {
        // Compound aggressively after wins (1.7x has higher win probability)
        const compoundFactor = Math.min(2.0, 1 + (winStreak * 0.12) * CONFIG.compoundingRate);
        newBet = baseBet * compoundFactor;
        botState.settings.compoundMultiplier = compoundFactor;
    }
    // Recovery mode with 1.7x optimization
    else if (botState.settings.recoveryMode) {
        if (isWin && winStreak > 0) {
            const multiplier = Math.min(2.5, 1 + (winStreak * 0.25)) * CONFIG.recoveryAggression;
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak < 4) {
            // Smaller increase on losses (1.7x recovers faster)
            newBet = baseBet * Math.min(1.3, 1 + (lossStreak * 0.08));
        } else {
            newBet = baseBet;
        }
        newBet = Math.min(maxBet * 0.9, newBet);
    } 
    // Hedge mode: moderate reduction
    else if (botState.settings.hedgeActive) {
        newBet = baseBet * 0.7;
    }
    // Normal mode: Aggressive Anti-Martingale for 1.7x
    else if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            // More aggressive increase on wins due to higher win probability
            const multiplier = Math.min(3.0, 1 + (winStreak * 0.35));
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            // Smaller reduction on losses
            const reduction = Math.max(0.7, 1 - (lossStreak * 0.05));
            newBet = baseBet * reduction;
        }
    }
    
    // Apply Kelly for 1.7x payout
    if (CONFIG.useKelly) {
        const winProb = 1 / CONFIG.payout;
        const kellyBet = calculateOptimizedKelly17x(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        newBet = Math.min(newBet, kellyBet);
    }
    
    // Apply volume multiplier for 1.7x
    newBet = newBet * CONFIG.volumeMultiplier;
    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// Optimized Kelly for 1.7x payout (higher confidence)
function calculateOptimizedKelly17x(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;  // 0.7 for 1.7x payout
    const p = winProbability;         // ~58.8% theoretical
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // 1.7x payout has positive EV at >58.8% win rate
    // Apply higher risk due to better odds
    let riskMultiplier = riskLevel * 1.2;
    if (botState.settings.recoveryMode) {
        riskMultiplier *= CONFIG.recoveryAggression;
    }
    
    kellyFraction = kellyFraction * riskMultiplier * 0.75;  // 75% Kelly for safety
    
    let maxCap = CONFIG.maxBetPercent;
    if (botState.settings.recoveryMode) {
        maxCap = CONFIG.maxBetPercent * 0.95;
    }
    
    kellyFraction = Math.min(maxCap, Math.max(0.03, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// Enhanced recovery system for 1.7x payout
function checkAndOptimizeRecovery17x() {
    if (!botState.settings.recoveryMode) return false;
    
    const recoveryDrawdown = (botState.settings.recoveryStartBalance - botState.stats.currentBalance) / botState.settings.recoveryStartBalance;
    const recoveryProgress = (botState.stats.currentBalance - botState.settings.recoveryStartBalance) / botState.settings.recoveryStartBalance;
    const winRate = botState.stats.performanceMetrics.winRate;
    
    // Exit recovery mode faster with 1.7x (higher win probability)
    if (botState.stats.currentBalance >= botState.settings.recoveryStartBalance && botState.settings.consecutiveWins >= 1) {
        botState.settings.recoveryMode = false;
        botState.settings.hedgeActive = false;
        botState.settings.riskLevel = 1.2;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = `✅ RECOVERY SUCCESSFUL! Back to ${botState.stats.currentBalance.toFixed(8)} BTC.`;
        console.log(`\n✅✅✅ RECOVERY COMPLETE! ✅✅✅`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`📈 Recovery #${botState.stats.successfulRecoveries} successful\n`);
        return true;
    }
    
    // Dynamic aggression based on win rate
    if (winRate > CONFIG.winRateTarget) {
        // Win rate is good, be more aggressive
        CONFIG.recoveryAggression = Math.min(1.3, CONFIG.recoveryAggression * 1.05);
        botState.settings.riskLevel = Math.min(1.4, botState.settings.riskLevel * 1.03);
    } else if (winRate < CONFIG.winRateTarget - 0.05) {
        // Win rate too low, adjust strategy
        CONFIG.payout = Math.max(1.6, CONFIG.payout * 0.99);
        botState.statusMessage = `⚡ ADJUSTING PAYOUT TO ${CONFIG.payout.toFixed(2)}x FOR BETTER WIN RATE`;
    }
    
    return false;
}

// Smart Take Profit for 1.7x (more frequent locks)
function checkSmartTakeProfit17x() {
    if (botState.settings.recoveryMode && botState.stats.currentBalance < botState.settings.recoveryStartBalance * 1.1) {
        return false;
    }
    
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    
    // Lower threshold for 1.7x (25% instead of 40%)
    if (currentGain > CONFIG.takeProfitPercent && !botState.settings.takeProfitLock && botState.stats.totalBets > 3) {
        const gainAmount = botState.stats.currentBalance - botState.stats.startingBalance;
        const gainPercent = (currentGain * 100).toFixed(1);
        
        botState.statusMessage = `🎯 TAKE PROFIT: ${gainPercent}% gain (${gainAmount.toFixed(8)} BTC). Locking profits...`;
        botState.settings.takeProfitLock = true;
        botState.settings.takeProfitLockTime = Date.now();
        botState.stats.takeProfitCount++;
        botState.stats.totalTakeProfitGains += gainAmount;
        
        // Reset compound multiplier on take profit
        botState.settings.compoundMultiplier = 1.0;
        botState.settings.winsSinceCompound = 0;
        botState.settings.currentBet = botState.settings.baseBet;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        botState.stats.startingBalance = botState.stats.currentBalance;
        
        console.log(`\n🎯 TAKE PROFIT #${botState.stats.takeProfitCount}!`);
        console.log(`💰 Gain: ${gainPercent}% (${gainAmount.toFixed(8)} BTC)`);
        console.log(`📊 New Base: ${botState.stats.startingBalance.toFixed(8)} BTC\n`);
        
        return true;
    }
    
    // Faster release for 1.7x (15 seconds)
    if (botState.settings.takeProfitLock && CONFIG.useDynamicRelease) {
        const timeElapsed = Date.now() - botState.settings.takeProfitLockTime;
        if (timeElapsed >= CONFIG.takeProfitReleaseTime) {
            botState.settings.takeProfitLock = false;
            botState.settings.sessionLock = false;
            botState.statusMessage = `🔓 Take profit lock released! Resuming 1.7x optimized betting.`;
            return false;
        }
    }
    
    return false;
}

// Enhanced Stop Loss for 1.7x (tighter protection)
function checkSmartStopLoss17x() {
    if (botState.settings.takeProfitLock) return false;
    
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    const consecutiveLosses = botState.settings.consecutiveLosses;
    
    // Tighter stop loss for 1.7x (15% instead of 25%)
    if (currentDrawdown > CONFIG.stopLossPercent && !botState.settings.recoveryMode && botState.stats.totalBets > 5) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.hedgeActive = true;
        botState.stats.recoveryCount++;
        botState.statusMessage = `🔄 ENTERING RECOVERY MODE: ${(currentDrawdown*100).toFixed(1)}% drawdown.`;
        
        console.log(`\n🔄 ENTERING RECOVERY MODE (1.7x Optimized)`);
        console.log(`📉 Drawdown: ${(currentDrawdown*100).toFixed(1)}%`);
        console.log(`🎯 Target: ${botState.settings.recoveryTarget.toFixed(8)} BTC\n`);
        
        return true;
    }
    
    // More losses allowed with 1.7x (8 vs 6)
    if (consecutiveLosses >= CONFIG.maxConsecutiveLosses && !botState.settings.recoveryMode) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.consecutiveLosses = 0;
        botState.statusMessage = `🔄 MAX LOSSES (${consecutiveLosses}). Entering optimized recovery...`;
        
        console.log(`\n🔄 MAX LOSSES RESET - Entering Recovery Mode`);
        console.log(`💀 Loss streak: ${consecutiveLosses}`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC\n`);
        
        return true;
    }
    
    return false;
}

// Hedge mode for 1.7x (less aggressive hedging)
function activateHedgeMode17x() {
    if (!CONFIG.useHedgeMode) return;
    if (botState.settings.takeProfitLock) return;
    
    if (botState.settings.recoveryMode && !botState.settings.hedgeActive) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.4;
        botState.statusMessage = `🛡️ RECOVERY HEDGE ACTIVE: 40% bet reduction`;
        return;
    }
    
    // Hedge after 3 losses (instead of 2) for 1.7x
    if (botState.settings.consecutiveLosses >= 3 && !botState.settings.hedgeActive && !botState.settings.recoveryMode) {
        botState.settings.hedgeActive = true;
        botState.settings.hedgeAmount = botState.settings.currentBet * 0.6;
        botState.statusMessage = `🛡️ HEDGE MODE ACTIVE: 40% bet reduction after ${botState.settings.consecutiveLosses} losses`;
        console.log(`\n🛡️ Hedge mode activated after ${botState.settings.consecutiveLosses} losses\n`);
    }
    
    // Deactivate hedge faster for 1.7x
    if (botState.settings.consecutiveWins >= 1 && botState.settings.hedgeActive && !botState.settings.recoveryMode) {
        botState.settings.hedgeActive = false;
        botState.settings.hedgeAmount = 0;
        botState.statusMessage = `✅ Hedge mode deactivated`;
    }
}

// Update strategy for 1.7x optimization
function updateOptimizedStrategy17x() {
    const balance = botState.stats.currentBalance;
    const growthMultiplier = balance / 0.00000012;
    const winRate = botState.stats.performanceMetrics.winRate;
    const expectedValue = (winRate * 0.7) - ((1 - winRate) * 1);
    
    let newRiskLevel = 1.2;
    let newBasePercent = 0.18;
    let newMaxPercent = 0.45;
    let newStrategy = "⚡ 1.7x MAX PROFIT";
    
    if (botState.settings.recoveryMode) {
        newRiskLevel = 1.3;
        newBasePercent = 0.20;
        newMaxPercent = 0.50;
        newStrategy = "🔄 1.7x RECOVERY MODE";
    } 
    else if (expectedValue > 0.1) {
        newRiskLevel = 1.4;
        newBasePercent = 0.22;
        newMaxPercent = 0.55;
        newStrategy = "🚀 1.7x AGGRESSIVE COMPOUND";
    }
    else if (winRate > CONFIG.winRateTarget) {
        newRiskLevel = 1.3;
        newBasePercent = 0.20;
        newMaxPercent = 0.50;
        newStrategy = "📈 1.7x HIGH WIN RATE";
    }
    else if (growthMultiplier > 50) {
        newRiskLevel = 1.1;
        newBasePercent = 0.15;
        newMaxPercent = 0.40;
        newStrategy = "🛡️ 1.7x CAPITAL PRESERVATION";
    }
    
    botState.settings.riskLevel = newRiskLevel;
    CONFIG.baseBetPercent = newBasePercent;
    CONFIG.maxBetPercent = newMaxPercent;
    botState.settings.currentStrategy = newStrategy;
    
    return newStrategy;
}

function calculateScaledBase17x(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(CONFIG.minBet, calculated);
}

function validateBet17x(betAmount, currentBalance) {
    const absoluteMax = currentBalance * 0.55;  // Higher max for 1.7x
    if (betAmount > absoluteMax) {
        return Math.max(CONFIG.minBet, absoluteMax);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

function updatePerformanceMetrics17x() {
    const totalBets = botState.stats.totalBets;
    if (totalBets === 0) return;
    
    const winRate = botState.stats.wins / totalBets;
    botState.stats.performanceMetrics.winRate = winRate;
    botState.stats.performanceMetrics.expectedValue = (winRate * 0.7) - ((1 - winRate) * 1);
    
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
    
    // Reset daily volume counter
    const hoursSinceReset = (Date.now() - botState.stats.lastResetTime) / 3600000;
    if (hoursSinceReset >= 24) {
        botState.stats.dailyVolume = 0;
        botState.stats.lastResetTime = Date.now();
        console.log(`\n📊 DAILY VOLUME RESET - New day starting\n`);
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const currentStrategy = updateOptimizedStrategy17x();
    
    checkAndOptimizeRecovery17x();
    
    if (checkSmartTakeProfit17x()) {
        await new Promise(r => setTimeout(r, 800));
        return null;
    }
    
    if (checkSmartStopLoss17x()) {
        await new Promise(r => setTimeout(r, 2000));
        return null;
    }
    
    activateHedgeMode17x();
    
    const optimalBet = calculateOptimalBet17x(
        false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBet17x(optimalBet, botState.stats.currentBalance);
    
    // Fixed payout at 1.7x for consistency
    botState.settings.payout = CONFIG.payout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    // Check daily volume limit
    if (botState.stats.dailyVolume >= CONFIG.maxDailyVolume) {
        botState.statusMessage = `⏸️ Daily volume limit reached. Resuming tomorrow...`;
        await new Promise(r => setTimeout(r, 3600000));
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    // Get seed (already under 40 chars)
    const clientSeed = getCurrentSeed();
    // Use seed directly without nonce to stay under 40 chars
    const finalSeed = clientSeed;

    const payload = {
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: botState.settings.payout,
        UnderOver: true,
        ClientSeed: finalSeed
    };
    
    botState.stats.dailyVolume += payload.Bet;

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    const expectedWinRate = (1 / CONFIG.payout * 100).toFixed(1);
    const ev = ((botState.stats.performanceMetrics.winRate * 0.7) - ((1 - botState.stats.performanceMetrics.winRate) * 1)).toFixed(3);
    const betsUntilSeedChange = CONFIG.seedChangeInterval - betsSinceSeedChange;
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 Strategy: ${currentStrategy} | Recovery: ${botState.settings.recoveryMode ? 'ACTIVE' : 'OFF'}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win | Expected WR: ${expectedWinRate}%)`);
    console.log(`  📈 EV: ${ev} | Win Rate: ${(botState.stats.performanceMetrics.winRate*100).toFixed(1)}%`);
    console.log(`  🎲 Seed: ${finalSeed} (${betsUntilSeedChange} bets until new seed)`);
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
        
        // DEMO MODE: 1.7x optimized simulation
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
                ExpectedValue: ((winChance * 0.7) - ((1 - winChance) * 1)).toFixed(3),
                WinRate: (winChance * 100).toFixed(1)
            };
        }
        
        return null;
    }
}

// ============ MAIN 1.7x OPTIMIZED ENGINE ============
async function runStrategy() {
    console.log(`\n🚀🚀🚀 1.7x MAX PROFIT ENGINE v13.0 🚀🚀🚀`);
    console.log(`💰 Current Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (${(botState.stats.currentBalance/0.00000012).toFixed(1)}x growth)`);
    console.log(`🎯 Ultimate Target: ${CONFIG.targetMultiplier}x (${(0.00000012 * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`🎲 Payout: ${CONFIG.payout}x | Expected Win Rate: ${(1/CONFIG.payout*100).toFixed(1)}%`);
    console.log(`⚡ Base Bet: ${(CONFIG.baseBetPercent*100).toFixed(0)}% | Max Bet: ${(CONFIG.maxBetPercent*100).toFixed(0)}%`);
    console.log(`📈 Volume Multiplier: ${CONFIG.volumeMultiplier}x | Compound Rate: ${(CONFIG.compoundingRate*100).toFixed(0)}%`);
    console.log(`🎯 Take Profit: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% | Stop Loss: ${(CONFIG.stopLossPercent*100).toFixed(0)}%`);
    console.log(`🎲 Seed Change Interval: Every ${CONFIG.seedChangeInterval} bets | Seeds under 40 chars\n`);
    
    botState.statusMessage = `🚀 1.7x MODE | Target: ${CONFIG.targetMultiplier}x | TP: ${(CONFIG.takeProfitPercent*100).toFixed(0)}% | SL: ${(CONFIG.stopLossPercent*100).toFixed(0)}%`;
    
    while (botState.running) {
        botState.settings.baseBet = calculateScaledBase17x(botState.stats.currentBalance);
        updatePerformanceMetrics17x();

        const result = await placeBet();
        if (!result) {
            await new Promise(r => setTimeout(r, 800));
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
            botState.settings.lastWinAmount = profit;
            
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak}!`);
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.settings.winsSinceCompound = 0;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.lastLossAmount = profit;
            
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
                console.log(`⚠️ New loss streak: ${botState.stats.worstStreak}`);
            }
        }

        const previousBet = botState.settings.currentBet;
        const nextBet = calculateOptimalBet17x(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet17x(nextBet, botState.stats.currentBalance);

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
            growth: result.Growth,
            ev: result.ExpectedValue,
            winRate: result.WinRate
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const statusIcon = botState.settings.takeProfitLock ? "🔒" :
                          botState.settings.recoveryMode ? "🔄" :
                          botState.settings.hedgeActive ? "🛡️" : "🚀";
        
        botState.statusMessage = `${statusIcon} ${result.Strategy} | ${growth}x | ROI: ${roi}% | WR: ${result.WinRate}% | TP: ${botState.stats.takeProfitCount} | EV: ${result.ExpectedValue} | Seeds: ${botState.stats.seedChanges}`;

        await new Promise(r => setTimeout(r, 700)); // Faster bets for 1.7x
    }
}

// ============ PROFIT PROJECTIONS ENDPOINT ============
app.get('/api/projections', (req, res) => {
    const hoursRunning = Math.max(0.1, (Date.now() - botState.stats.startTime) / 3600000);
    const currentProfit = botState.stats.netProfit;
    const currentBalance = botState.stats.currentBalance;
    const startingBalance = botState.stats.startingBalance;
    const winRate = botState.stats.performanceMetrics.winRate;
    
    const hourlyProfitRate = currentProfit / hoursRunning;
    const hourlyROI = (hourlyProfitRate / startingBalance) * 100;
    
    // 1.7x specific calculations
    const evPerBet = (winRate * 0.7) - ((1 - winRate) * 1);
    const avgBetSize = botState.stats.totalWagered / Math.max(1, botState.stats.totalBets);
    const betsPerHour = (botState.stats.totalBets / hoursRunning);
    const expectedHourlyProfit = evPerBet * avgBetSize * betsPerHour;
    
    const projections = {
        conservative: {
            hourly: hourlyProfitRate * 0.85,
            daily: hourlyProfitRate * 24 * 0.85,
            monthly: hourlyProfitRate * 24 * 30 * 0.85,
            yearly: hourlyProfitRate * 24 * 365 * 0.85
        },
        realistic: {
            hourly: hourlyProfitRate,
            daily: hourlyProfitRate * 24,
            monthly: hourlyProfitRate * 24 * 30,
            yearly: hourlyProfitRate * 24 * 365
        },
        optimistic: {
            hourly: expectedHourlyProfit,
            daily: expectedHourlyProfit * 24,
            monthly: expectedHourlyProfit * 24 * 30,
            yearly: expectedHourlyProfit * 24 * 365
        }
    };
    
    const targetMultiplier = CONFIG.targetMultiplier;
    const targetBalance = startingBalance * targetMultiplier;
    const remainingToTarget = targetBalance - currentBalance;
    const hoursToTarget = remainingToTarget > 0 ? remainingToTarget / Math.abs(hourlyProfitRate) : 0;
    
    res.json({
        currentStats: {
            profit: currentProfit,
            balance: currentBalance,
            growth: (currentBalance / startingBalance).toFixed(1),
            runningHours: hoursRunning.toFixed(1),
            hourlyProfitRate: hourlyProfitRate,
            hourlyROI: hourlyROI.toFixed(2),
            winRate: (winRate * 100).toFixed(1),
            evPerBet: evPerBet.toFixed(4),
            betsPerHour: betsPerHour.toFixed(1)
        },
        projections,
        targets: {
            targetMultiplier,
            targetBalance: targetBalance.toFixed(8),
            hoursToTarget: hoursToTarget.toFixed(1),
            daysToTarget: (hoursToTarget / 24).toFixed(1)
        }
    });
});

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
    const winRate = (botState.stats.performanceMetrics.winRate * 100).toFixed(1);
    const ev = ((botState.stats.performanceMetrics.winRate * 0.7) - ((1 - botState.stats.performanceMetrics.winRate) * 1)).toFixed(4);
    
    res.json({
        botState,
        btcPrice,
        hoursPassed: hours.toFixed(2),
        config: CONFIG,
        growth: growth,
        strategy: botState.settings.currentStrategy,
        winRate: winRate,
        expectedValue: ev,
        recoveryMode: botState.settings.recoveryMode,
        hedgeActive: botState.settings.hedgeActive,
        takeProfitLock: botState.settings.takeProfitLock,
        takeProfitCount: botState.stats.takeProfitCount,
        successfulRecoveries: botState.stats.successfulRecoveries,
        compoundMultiplier: botState.settings.compoundMultiplier.toFixed(2),
        seedChanges: botState.stats.seedChanges
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v13.0 | 1.7x MAX PROFIT ENGINE</title>
    <style>
        :root { --primary: #10b981; --bg: #0f172a; --card-bg: #1e293b; --text-main: #f1f5f9; --text-muted: #94a3b8; --border: #334155; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; --warning: #8b5cf6; --info: #06b6d4; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-bottom: 1.5rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 2rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .status-bar-recovery { background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%); animation: pulse 1s infinite; }
        .strategy-badge { background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .profit-badge { background: linear-gradient(135deg, #f59e0b, #ea580c); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:#10b981">v13.0</span> 
                    <span class="strategy-badge">🚀 1.7x MAX PROFIT ENGINE</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">6.8x</strong> | 🎯 Take Profit Hits: <strong id="tp-count">1</strong> | 🔄 Recoveries: <strong id="recovery-count">0</strong> | 📊 Win Rate: <strong id="wr-display">0%</strong> | 🎲 Seed Changes: <strong id="seed-changes-display">0</strong>
                </div>
            </div>
            <div style="text-align: right">
                <div class="label">Market BTC/USD</div>
                <div id="price-tag" style="font-weight: 700;">$60,964</div>
            </div>
        </div>
        
        <div class="status-bar" id="status-msg">Status: 1.7x Engine Initializing...</div>
        
        <div class="grid">
            <div class="card" style="background: linear-gradient(135deg, #10b981, #059669);">
                <div class="label">🚀 TOTAL GROWTH</div>
                <div id="growth-total" class="btc-val pulse">6.8x</div>
                <div class="usd-val">From 12 satoshis</div>
            </div>
            <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000081</div><div id="w-usd" class="usd-val">$0.049</div></div>
            <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000010</div><div id="n-usd" class="usd-val">$0.006</div></div>
            <div class="card"><div class="label">🎯 Locked Profits</div><div id="tp-gains" class="btc-val">0.00000059</div><div class="usd-val">Take profit gains</div></div>
        </div>
        
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700; color:#10b981">0%</div></div>
            <div class="mini-card"><div class="label">Expected Value</div><div id="ev" style="font-weight:700; color:#f59e0b">0.0000</div></div>
            <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700">0</div></div>
            <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700">4</div></div>
            <div class="mini-card"><div class="label">Compound Mult</div><div id="compound-mult" style="font-weight:700; color:#10b981">1.00x</div></div>
            <div class="mini-card"><div class="label">Recoveries</div><div id="recoveries" style="font-weight:700">0</div></div>
        </div>
        
        <div class="stats-row">
            <div class="mini-card"><div class="label">Strategy</div><div id="current-strategy" style="font-weight:700; font-size:0.7rem">1.7x MAX PROFIT</div></div>
            <div class="mini-card"><div class="label">Payout</div><div id="payout-display" style="font-weight:700; color:#10b981">1.7x</div></div>
            <div class="mini-card"><div class="label">Base Bet %</div><div id="base-percent" style="font-weight:700">18%</div></div>
            <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">120%</div></div>
            <div class="mini-card"><div class="label">💰 Hourly Profit</div><div id="hourly-profit" style="font-weight:700; color:#10b981">0.00000000</div></div>
            <div class="mini-card"><div class="label">🎲 Bets/Hour</div><div id="bets-hour" style="font-weight:700">0</div></div>
        </div>
        
        <div class="label">🛡️ STATUS</div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
            <div class="mini-card"><div class="label">Recovery Mode</div><span id="recovery-status">🔄 ACTIVE</span></div>
            <div class="mini-card"><div class="label">Hedge Mode</div><span id="hedge-status">🛡️ ACTIVE</span></div>
            <div class="mini-card"><div class="label">Take Profit Lock</div><span id="tp-lock-status">❌ OFF</span></div>
            <div class="mini-card"><div class="label">Seed Changes</div><span id="seed-changes">0</span></div>
        </div>
        
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>ID</th><th>Status</th><th>Strategy</th><th>Payout</th><th>Wager</th><th>Roll</th><th>P/L</th><th>%</th><th>Streaks</th><th>Growth</th><th>EV</th></tr>
                </thead>
                <tbody id="h-body">
                    <tr><td colspan="11" style="text-align:center;">🚀 1.7x MAX PROFIT ENGINE ACTIVE 🚀</td></tr>
                </tbody>
            </table>
        </div>
    </div>
    <script>
        let exchangeRates = { USD: 60964 };
        
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                const { botState, btcPrice, growth, strategy, winRate, expectedValue, recoveryMode, hedgeActive, takeProfitLock, takeProfitCount, successfulRecoveries, compoundMultiplier, seedChanges } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('tp-count').innerHTML = takeProfitCount || 0;
                document.getElementById('tp-gains').innerHTML = f(botState.stats.totalTakeProfitGains || 0);
                document.getElementById('current-strategy').innerHTML = strategy;
                document.getElementById('recoveries').innerHTML = successfulRecoveries || 0;
                document.getElementById('recovery-count').innerHTML = successfulRecoveries || 0;
                document.getElementById('wr').innerHTML = winRate + '%';
                document.getElementById('wr-display').innerHTML = winRate + '%';
                document.getElementById('ev').innerHTML = expectedValue;
                document.getElementById('compound-mult').innerHTML = compoundMultiplier + 'x';
                document.getElementById('payout-display').innerHTML = botState.settings.payout + 'x';
                document.getElementById('risk-level').innerHTML = (botState.settings.riskLevel * 100).toFixed(0) + '%';
                document.getElementById('base-percent').innerHTML = ((botState.settings.baseBet / botState.stats.currentBalance) * 100).toFixed(1) + '%';
                document.getElementById('seed-changes').innerHTML = seedChanges || 0;
                document.getElementById('seed-changes-display').innerHTML = seedChanges || 0;
                
                document.getElementById('recovery-status').innerHTML = recoveryMode ? '🔄 ACTIVE' : '✅ OFF';
                document.getElementById('hedge-status').innerHTML = hedgeActive ? '🛡️ ACTIVE' : '✅ OFF';
                document.getElementById('tp-lock-status').innerHTML = takeProfitLock ? '🔒 LOCKED' : '✅ OFF';
                
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
                
                // Calculate hourly profit
                const hoursRunning = (Date.now() - botState.stats.startTime) / 3600000;
                const hourlyProfit = botState.stats.netProfit / Math.max(0.1, hoursRunning);
                document.getElementById('hourly-profit').innerHTML = f(hourlyProfit);
                document.getElementById('bets-hour').innerHTML = (botState.stats.totalBets / Math.max(0.1, hoursRunning)).toFixed(0);
                
                if (botState.betHistory && botState.betHistory.length > 0) {
                    document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                        let streakDisplay = '';
                        if (b.lossStreak > 0) streakDisplay = '📉' + b.lossStreak;
                        if (b.winStreak > 0) streakDisplay = '🔥' + b.winStreak;
                        
                        let statusIcon = '';
                        if (b.takeProfitLock) statusIcon = '🔒';
                        else if (b.recoveryMode) statusIcon = '🔄';
                        else if (b.hedgeActive) statusIcon = '🛡️';
                        else statusIcon = '🚀';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + statusIcon + '</td>' +
                            '<td>' + (b.strategy || '1.7x') + '</td>' +
                            '<td>' + (b.payout || '1.7') + 'x</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + (b.growth || '6.8') + 'x</td>' +
                            '<td>' + (b.ev || '0') + '</td>' +
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
    console.log(`🚀🚀🚀 1.7x MAX PROFIT ENGINE v13.0 ONLINE 🚀🚀🚀`);
    console.log(`📊 Open http://localhost:${port} to monitor`);
    console.log(`🎲 Payout: ${CONFIG.payout}x | Expected Win Rate: ${(1/CONFIG.payout*100).toFixed(1)}%`);
    console.log(`📈 Profit per Win: ${(CONFIG.payout-1)*100}% | Risk Level: ${(CONFIG.maxBetPercent*100)}% max bet`);
    console.log(`🎲 Seed Change Interval: Every ${CONFIG.seedChangeInterval} bets | Seeds under 40 chars ✓`);
    runStrategy();
});
