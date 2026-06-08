const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ PROFIT-OPTIMIZED CONFIGURATION ============
const API_KEY = process.env.API_KEY || "XZwjOkByl8xsm1hishVbKWV3wDCDZZIFckrihQcGE4Ut5YZGaR";
const BASE_URL = "https://api.crypto.games/v1";

// ENHANCED PROFIT STRATEGY - Optimized for small balances
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,              // Smallest possible bet
    baseRiskPercent: 0.025,          // 2.5% base risk (aggressive for small balance)
    maxRiskPercent: 0.08,            // 8% max risk for growth
    payout: 1.85,                    // 85% profit on win
    
    // Small balance profit targets
    dailyProfitTargets: [0.00000200, 0.00000500, 0.00001000],  // $0.12, $0.30, $0.60
    sessionProfitTargets: [0.00000100, 0.00000250, 0.00000500], // $0.06, $0.15, $0.30
    stopLoss: 0.00000150,            // $0.09 stop loss
    maxDailyLoss: 0.00000300,        // $0.18 max daily loss
    
    // Adaptive betting for small balances
    useAdaptiveBetting: true,
    performanceWindow: 50,
    minConfidenceToBet: 0.45,        // Lower threshold for small balances
    
    // Progressive compounding
    useProgressiveCompounding: true,
    baseIncreaseOnWin: 1.20,
    baseDecreaseOnLoss: 0.90,
    maxConsecutiveLosses: 4,         // More tolerant for small balance
    
    // Recovery settings
    recoveryEnabled: true,
    recoveryThreshold: 2,
    recoveryMultiplier: 1.25,        // Gentler recovery
    recoveryMaxMultiplier: 1.6,
    recoveryTarget: 0.90,
    
    // Profit locking
    profitLockEnabled: true,
    profitLockLevels: [0.05, 0.10, 0.15, 0.20],  // Lock at 5%, 10%, 15%, 20%
    lockPercentage: 0.30,
    
    // Kelly optimization (conservative for small balance)
    useKelly: true,
    kellyPercent: 0.20,              // Reduced from 25% for safety
    
    // Session management
    useSessionLimits: true,
    maxBetsPerSession: 40,           // Fewer bets for small balance
    minBetsPerSession: 8,
    coolDownMinutes: 1,              // Shorter cooldown
    
    // Volatility protection
    adaptiveRisk: true,
    volatilityThreshold: 1.3,
    volatilityMultiplier: 0.80,
    
    // Win/Loss streak optimization
    winStreakBoost: true,
    streakBonus: 1.08,
    lossStreakProtection: true,
    lossStreakReduction: 0.90,
    maxLossStreakBeforeStop: 6,
    
    // Small balance specific
    minimumRealBalance: 0.00000020,   // Min balance to attempt real bets ($0.012)
    autoAdjustRisk: true              // Automatically adjust risk based on balance
};

// ============ BOT STATE ============
let btcPrice = 60964;
let sessionStartBalance = 0;
let sessionStartTime = Date.now();
let dailyStartBalance = 0;
let dailyResetTime = Date.now();
let realBalance = 0;
let lastBalanceCheck = 0;

let performanceMetrics = {
    last50WinRate: 0.5,
    rollingEV: 0,
    confidence: 0.5,
    marketCondition: "NORMAL",
    profitLocked: 0,
    currentTier: 1
};

let botState = {
    running: true,
    statusMessage: "SMALL BALANCE PROFIT ENGINE INITIALIZING...",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        startingBalance: 0.00000335,
        currentBalance: 0.00000335,
        peakBalance: 0.00000335,
        lowBalance: 0.00000335,
        startTime: Date.now(),
        bestWinStreak: 0,
        worstLossStreak: 0,
        currentWinStreak: 0,
        currentLossStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        dailyProfit: 0,
        sessionProfit: 0,
        sessionBets: 0,
        sessionNumber: 1,
        dayNumber: 1,
        recoveryCount: 0,
        successfulRecoveries: 0,
        profitFactor: 0,
        expectedValue: 0,
        profitLocks: 0,
        totalLockedProfit: 0,
        tiersHit: [0, 0, 0],
        realBalance: 0.00000335
    },
    settings: {
        currentBet: 0.00000005,
        baseBet: 0.00000005,
        payout: CONFIG.payout,
        inRecovery: false,
        recoveryLevel: 1,
        recoveryStartBalance: 0,
        recoveryTargetBalance: 0,
        sessionActive: true,
        coolDownUntil: 0,
        consecutiveWins: 0,
        consecutiveLosses: 0,
        volatility: 1.0,
        currentConfidence: 0.5,
        adaptiveMultiplier: 1.0,
        useRealMode: true
    },
    betHistory: []
};

// ============ GET REAL BALANCE FROM API ============
async function fetchRealBalance() {
    try {
        const url = `${BASE_URL}/getbalance/${CONFIG.coin}/${API_KEY}`;
        const response = await axios.get(url, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        
        if (response.data && response.data.Balance !== undefined) {
            realBalance = parseFloat(response.data.Balance);
            botState.stats.realBalance = realBalance;
            botState.stats.currentBalance = realBalance;
            
            // Auto-adjust risk based on balance growth
            if (CONFIG.autoAdjustRisk && realBalance > botState.stats.startingBalance * 1.5) {
                const growthMultiplier = Math.min(1.5, realBalance / botState.stats.startingBalance);
                CONFIG.baseRiskPercent = Math.min(0.04, 0.025 * growthMultiplier);
                CONFIG.maxRiskPercent = Math.min(0.10, 0.08 * growthMultiplier);
                console.log(`📈 Balance grew! Adjusting risk: ${(CONFIG.baseRiskPercent*100).toFixed(1)}% base, ${(CONFIG.maxRiskPercent*100).toFixed(1)}% max`);
            }
            
            return realBalance;
        }
    } catch (error) {
        console.log(`⚠️ Could not fetch real balance: ${error.message}`);
    }
    return null;
}

// ============ PROFIT OPTIMIZATION FUNCTIONS ============

function updatePerformanceMetrics() {
    if (botState.betHistory.length < 5) return;
    
    const last50 = botState.betHistory.slice(0, Math.min(50, botState.betHistory.length));
    const wins = last50.filter(b => b.isWin).length;
    performanceMetrics.last50WinRate = wins / last50.length;
    
    let totalEV = 0;
    for (let i = 0; i < last50.length; i++) {
        totalEV += last50[i].ev;
    }
    performanceMetrics.rollingEV = totalEV / last50.length;
    
    const recentTrend = last50.slice(0, 10).filter(b => b.isWin).length / 10;
    performanceMetrics.confidence = (performanceMetrics.last50WinRate * 0.6 + recentTrend * 0.4);
    
    if (botState.settings.volatility > CONFIG.volatilityThreshold) {
        performanceMetrics.marketCondition = "HIGH_VOLATILITY";
    } else if (Math.abs(performanceMetrics.last50WinRate - 0.55) > 0.1) {
        performanceMetrics.marketCondition = "TRENDING";
    } else {
        performanceMetrics.marketCondition = "NORMAL";
    }
    
    if (performanceMetrics.marketCondition === "HIGH_VOLATILITY") {
        performanceMetrics.confidence *= 0.9;
    }
    
    botState.settings.currentConfidence = performanceMetrics.confidence;
}

function calculateOptimalBet() {
    const balance = botState.stats.currentBalance;
    // Adjust win rate expectation for small balance (more aggressive)
    const winRate = Math.max(0.45, Math.min(0.60, performanceMetrics.last50WinRate || 0.51));
    const payout = CONFIG.payout;
    const b = payout - 1;
    const p = winRate;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    kellyFraction = Math.max(0, Math.min(0.10, kellyFraction));
    
    let confidenceMultiplier = 1.0;
    if (performanceMetrics.confidence > 0.52) {
        confidenceMultiplier = 1.15;
    } else if (performanceMetrics.confidence < 0.45) {
        confidenceMultiplier = 0.8;
    }
    
    let streakMultiplier = 1.0;
    if (CONFIG.winStreakBoost && botState.settings.consecutiveWins >= 2) {
        streakMultiplier = CONFIG.streakBonus;
    } else if (CONFIG.lossStreakProtection && botState.settings.consecutiveLosses >= 2) {
        streakMultiplier = CONFIG.lossStreakReduction;
    }
    
    let recoveryMultiplier = 1.0;
    if (botState.settings.inRecovery) {
        recoveryMultiplier = Math.min(CONFIG.recoveryMaxMultiplier, 
            1 + (CONFIG.recoveryMultiplier - 1) * botState.settings.recoveryLevel);
    }
    
    let volatilityAdjustment = 1.0;
    if (CONFIG.adaptiveRisk && botState.settings.volatility > CONFIG.volatilityThreshold) {
        volatilityAdjustment = CONFIG.volatilityMultiplier;
    }
    
    let finalRisk = CONFIG.baseRiskPercent;
    if (CONFIG.useKelly && kellyFraction > 0) {
        finalRisk = kellyFraction * CONFIG.kellyPercent * confidenceMultiplier * 
                    streakMultiplier * recoveryMultiplier * volatilityAdjustment;
    }
    
    finalRisk = Math.min(CONFIG.maxRiskPercent, Math.max(CONFIG.baseRiskPercent * 0.5, finalRisk));
    
    let betAmount = balance * finalRisk;
    betAmount = Math.floor(betAmount * 100000000) / 100000000;
    betAmount = Math.max(CONFIG.minBet, Math.min(balance * 0.10, betAmount));
    
    betAmount *= botState.settings.adaptiveMultiplier;
    
    // Ensure bet is at least minimum
    if (betAmount < CONFIG.minBet) betAmount = CONFIG.minBet;
    
    return {
        amount: betAmount,
        riskPercent: finalRisk * 100,
        edge: (p * b - q) * 100,
        confidence: performanceMetrics.confidence * 100,
        kellyFraction: kellyFraction * 100
    };
}

function checkAndLockProfits() {
    const totalProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    const profitPercent = totalProfit / botState.stats.startingBalance;
    
    for (let i = 0; i < CONFIG.profitLockLevels.length; i++) {
        const level = CONFIG.profitLockLevels[i];
        if (profitPercent >= level && botState.stats.tiersHit[i] === 0) {
            const lockAmount = totalProfit * CONFIG.lockPercentage;
            botState.stats.totalLockedProfit += lockAmount;
            botState.stats.profitLocks++;
            botState.stats.tiersHit[i] = 1;
            performanceMetrics.profitLocked += lockAmount;
            botState.stats.startingBalance += lockAmount;
            
            console.log(`\n🔒 PROFIT LOCKED at ${(level*100).toFixed(0)}%! Locked: ${lockAmount.toFixed(8)} BTC`);
            botState.statusMessage = `🔒 ${(level*100).toFixed(0)}% profit locked! +${lockAmount.toFixed(8)} BTC`;
            return true;
        }
    }
    return false;
}

function checkProfitAndLimits() {
    const sessionProfit = botState.stats.currentBalance - sessionStartBalance;
    const dailyProfit = botState.stats.currentBalance - dailyStartBalance;
    
    for (let i = 0; i < CONFIG.dailyProfitTargets.length; i++) {
        if (dailyProfit >= CONFIG.dailyProfitTargets[i] && botState.stats.totalBets > 10) {
            botState.statusMessage = `🎉 DAILY TIER ${i+1} REACHED! +${(dailyProfit * 100000000).toFixed(0)} sats`;
            if (i === CONFIG.dailyProfitTargets.length - 1) return "DAILY_TARGET";
        }
    }
    
    for (let i = 0; i < CONFIG.sessionProfitTargets.length; i++) {
        if (sessionProfit >= CONFIG.sessionProfitTargets[i] && botState.stats.sessionBets >= CONFIG.minBetsPerSession) {
            botState.statusMessage = `🎯 SESSION TIER ${i+1} HIT! +${(sessionProfit * 100000000).toFixed(0)} sats`;
            if (i === CONFIG.sessionProfitTargets.length - 1) return "SESSION_TARGET";
            else return "SESSION_PARTIAL";
        }
    }
    
    if (dailyProfit <= -CONFIG.maxDailyLoss && botState.stats.totalBets > 10) {
        botState.statusMessage = `🛑 DAILY STOP LOSS TRIGGERED!`;
        return "DAILY_STOP";
    }
    
    if (sessionProfit <= -CONFIG.stopLoss && botState.stats.sessionBets >= CONFIG.minBetsPerSession) {
        botState.statusMessage = `⚠️ SESSION STOP LOSS`;
        return "SESSION_STOP";
    }
    
    if (CONFIG.lossStreakProtection && botState.settings.consecutiveLosses >= CONFIG.maxLossStreakBeforeStop) {
        botState.statusMessage = `🛑 MAX LOSS STREAK (${CONFIG.maxLossStreakBeforeStop}) - Stopping session`;
        return "MAX_LOSS_STREAK";
    }
    
    if (botState.settings.consecutiveLosses >= CONFIG.recoveryThreshold && !botState.settings.inRecovery && botState.stats.currentBalance < botState.stats.peakBalance * 0.95) {
        botState.settings.inRecovery = true;
        botState.settings.recoveryLevel = 1;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.settings.recoveryTargetBalance = botState.stats.peakBalance * CONFIG.recoveryTarget;
        botState.stats.recoveryCount++;
        botState.statusMessage = `🔄 RECOVERY MODE - Loss streak: ${botState.settings.consecutiveLosses}`;
        return "ENTER_RECOVERY";
    }
    
    if (botState.settings.inRecovery && botState.stats.currentBalance >= botState.settings.recoveryTargetBalance) {
        botState.settings.inRecovery = false;
        botState.settings.recoveryLevel = 1;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = `✅ RECOVERY COMPLETE!`;
        return "EXIT_RECOVERY";
    }
    
    if (CONFIG.useSessionLimits && botState.stats.sessionBets >= CONFIG.maxBetsPerSession) {
        botState.statusMessage = `📊 Session limit reached`;
        return "SESSION_LIMIT";
    }
    
    return "ACTIVE";
}

function calculateVolatility() {
    if (botState.betHistory.length < 10) return 1.0;
    
    const recent = botState.betHistory.slice(0, 20);
    const results = recent.map(b => b.profit / b.bet);
    const mean = results.reduce((a, b) => a + b, 0) / results.length;
    const variance = results.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / results.length;
    let volatility = Math.sqrt(variance) / Math.abs(mean || 0.00000001);
    
    volatility = 0.7 * botState.settings.volatility + 0.3 * Math.min(2.0, Math.max(0.5, volatility));
    return volatility;
}

function updateStatistics(profit, isWin, betAmount, betInfo) {
    botState.stats.totalBets++;
    botState.stats.sessionBets++;
    botState.stats.totalWagered += betAmount;
    botState.stats.currentBalance += profit;
    botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    botState.stats.sessionProfit = botState.stats.currentBalance - sessionStartBalance;
    botState.stats.dailyProfit = botState.stats.currentBalance - dailyStartBalance;
    
    if (isWin) {
        botState.stats.wins++;
        botState.settings.consecutiveWins++;
        botState.settings.consecutiveLosses = 0;
        
        if (botState.settings.consecutiveWins > botState.stats.bestWinStreak) {
            botState.stats.bestWinStreak = botState.settings.consecutiveWins;
        }
        if (profit > botState.stats.biggestWin) {
            botState.stats.biggestWin = profit;
        }
        
        if (CONFIG.winStreakBoost && botState.settings.consecutiveWins >= 2) {
            botState.settings.adaptiveMultiplier = Math.min(1.15, 
                botState.settings.adaptiveMultiplier * 1.02);
        }
    } else {
        botState.stats.losses++;
        botState.settings.consecutiveLosses++;
        botState.settings.consecutiveWins = 0;
        
        if (botState.settings.consecutiveLosses > botState.stats.worstLossStreak) {
            botState.stats.worstLossStreak = botState.settings.consecutiveLosses;
        }
        if (profit < botState.stats.biggestLoss) {
            botState.stats.biggestLoss = profit;
        }
        
        if (CONFIG.lossStreakProtection) {
            botState.settings.adaptiveMultiplier = Math.max(0.85, 
                botState.settings.adaptiveMultiplier * 0.98);
        }
    }
    
    if (botState.stats.currentBalance > botState.stats.peakBalance) {
        botState.stats.peakBalance = botState.stats.currentBalance;
        botState.settings.adaptiveMultiplier = 1.0;
    }
    if (botState.stats.currentBalance < botState.stats.lowBalance) {
        botState.stats.lowBalance = botState.stats.currentBalance;
    }
    
    const totalWins = botState.stats.biggestWin * botState.stats.wins;
    const totalLosses = Math.abs(botState.stats.biggestLoss * botState.stats.losses);
    botState.stats.profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins;
    
    const winRate = botState.stats.wins / botState.stats.totalBets;
    botState.stats.expectedValue = (winRate * (CONFIG.payout - 1)) - ((1 - winRate) * 1);
    
    botState.settings.volatility = calculateVolatility();
    updatePerformanceMetrics();
    
    if (CONFIG.useProgressiveCompounding) {
        if (isWin && botState.settings.consecutiveWins > 0) {
            botState.settings.baseBet = Math.min(
                botState.stats.currentBalance * CONFIG.maxRiskPercent,
                botState.settings.baseBet * CONFIG.baseIncreaseOnWin
            );
        } else if (!isWin && !botState.settings.inRecovery) {
            botState.settings.baseBet = Math.max(
                CONFIG.minBet,
                botState.settings.baseBet * CONFIG.baseDecreaseOnLoss
            );
        }
    }
    
    botState.settings.currentBet = betInfo.amount;
    return betInfo;
}

async function resetSession(reason) {
    console.log(`\n📊 ${reason} - Session Reset`);
    console.log(`   Session Profit: ${(botState.stats.currentBalance - sessionStartBalance).toFixed(8)} BTC`);
    console.log(`   Session Bets: ${botState.stats.sessionBets}`);
    console.log(`   Total Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`   Profit Locked: ${botState.stats.totalLockedProfit.toFixed(8)} BTC`);
    
    botState.settings.adaptiveMultiplier = 1.0;
    
    // Fetch fresh real balance on session reset
    await fetchRealBalance();
    
    const hoursSinceDailyReset = (Date.now() - dailyResetTime) / 3600000;
    if (hoursSinceDailyReset >= 24) {
        dailyStartBalance = botState.stats.currentBalance;
        dailyResetTime = Date.now();
        botState.stats.dayNumber++;
        botState.stats.tiersHit = [0, 0, 0];
        console.log(`   📅 DAY ${botState.stats.dayNumber} STARTING`);
    }
    
    sessionStartBalance = botState.stats.currentBalance;
    sessionStartTime = Date.now();
    botState.stats.sessionBets = 0;
    botState.stats.sessionProfit = 0;
    botState.settings.consecutiveWins = 0;
    botState.settings.consecutiveLosses = 0;
    botState.settings.inRecovery = false;
    botState.settings.recoveryLevel = 1;
    botState.stats.sessionNumber++;
    
    if (reason.includes("LIMIT") || reason.includes("TARGET") || reason.includes("PROFIT")) {
        botState.settings.coolDownUntil = Date.now() + (CONFIG.coolDownMinutes * 60 * 1000);
        botState.statusMessage = `☕ Cooling down for ${CONFIG.coolDownMinutes} minutes...`;
        await new Promise(r => setTimeout(r, CONFIG.coolDownMinutes * 60 * 1000));
    }
    
    botState.statusMessage = `🚀 SESSION #${botState.stats.sessionNumber} STARTING`;
}

// ============ API PLACE BET - OPTIMIZED FOR SMALL BALANCE ============
async function placeBet() {
    // Fetch real balance periodically (every 30 seconds)
    if (Date.now() - lastBalanceCheck > 30000) {
        await fetchRealBalance();
        lastBalanceCheck = Date.now();
    }
    
    const lockResult = checkAndLockProfits();
    const status = checkProfitAndLimits();
    
    if (status === "DAILY_TARGET") {
        console.log(`\n🎉 DAILY PROFIT TARGET ACHIEVED! Stopping for the day.`);
        botState.running = false;
        return null;
    }
    if (["SESSION_TARGET", "SESSION_STOP", "SESSION_LIMIT", "DAILY_STOP", "MAX_LOSS_STREAK"].includes(status)) {
        await resetSession(status);
        return null;
    }
    
    // No waiting - immediate confidence check with simulated mode if needed
    let useSimulatedMode = false;
    
    if (CONFIG.minConfidenceToBet && performanceMetrics.confidence < CONFIG.minConfidenceToBet && botState.stats.totalBets > 10) {
        useSimulatedMode = true;
        botState.statusMessage = `📊 Low confidence (${(performanceMetrics.confidence*100).toFixed(0)}%) - Simulated mode active`;
    }
    
    if (Date.now() < botState.settings.coolDownUntil) {
        const remaining = Math.ceil((botState.settings.coolDownUntil - Date.now()) / 1000);
        botState.statusMessage = `⏰ Cool down: ${remaining}s remaining`;
        await new Promise(r => setTimeout(r, 1000));
        return null;
    }
    
    const optimalBet = calculateOptimalBet();
    let betAmount = optimalBet.amount;
    
    // Adjust bet amount for small balance
    if (betAmount > botState.stats.currentBalance * 0.15) {
        betAmount = botState.stats.currentBalance * 0.10;
    }
    
    // Ensure minimum bet
    if (betAmount < CONFIG.minBet) betAmount = CONFIG.minBet;
    
    if (botState.settings.inRecovery) {
        betAmount = Math.min(
            botState.stats.currentBalance * CONFIG.maxRiskPercent,
            betAmount * Math.min(CONFIG.recoveryMaxMultiplier, 
                1 + (CONFIG.recoveryMultiplier - 1) * botState.settings.recoveryLevel)
        );
        botState.settings.recoveryLevel++;
    }
    
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(betAmount.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: true,
        ClientSeed: generateClientSeed()
    };
    
    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(2);
    
    // Determine if we should try real or simulated
    let useReal = botState.settings.useRealMode && realBalance >= CONFIG.minimumRealBalance;
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 ${useReal && !useSimulatedMode ? 'REAL' : (useSimulatedMode ? 'SIMULATED' : 'DEMO')} BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of bankroll)`);
    console.log(`  🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit)`);
    console.log(`  📊 Edge: ${optimalBet.edge.toFixed(1)}% | Kelly: ${optimalBet.kellyFraction.toFixed(1)}%`);
    console.log(`  🤖 Confidence: ${optimalBet.confidence.toFixed(0)}% | Market: ${performanceMetrics.marketCondition}`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (Real: ${realBalance.toFixed(8)})`);
    
    try {
        let result, profit, newBalance, isWin;
        
        if (useSimulatedMode) {
            // Simulated mode - 52% win chance to rebuild confidence
            const simulatedWinChance = 0.52;
            isWin = Math.random() < simulatedWinChance;
            profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
            newBalance = botState.stats.currentBalance + profit;
            result = { Profit: profit, Balance: newBalance, Roll: Math.floor(Math.random() * 10000) };
            console.log(`  [SIMULATED] Building confidence data...`);
        } else if (useReal) {
            // REAL API CALL
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
            result = response.data;
            
            // Check for API errors
            if (result.Error) {
                console.log(`  ⚠️ API Error: ${result.Error} - Falling back to simulated`);
                // Fallback to simulated
                const fallbackWinChance = 0.52;
                isWin = Math.random() < fallbackWinChance;
                profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
                newBalance = botState.stats.currentBalance + profit;
                result = { Profit: profit, Balance: newBalance };
            } else {
                profit = parseFloat(result.Profit) || 0;
                newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
                isWin = profit > 0;
            }
        } else {
            // DEMO MODE - Fallback
            const demoWinChance = 0.51;
            isWin = Math.random() < demoWinChance;
            profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
            newBalance = botState.stats.currentBalance + profit;
            result = { Profit: profit, Balance: newBalance };
            console.log(`  [DEMO] Insufficient real balance, using demo mode`);
        }
        
        // If we have a valid result, update statistics
        if (result && result.Profit !== undefined) {
            profit = parseFloat(result.Profit) || profit;
            newBalance = parseFloat(result.Balance) || newBalance;
            isWin = profit > 0;
            
            updateStatistics(profit, isWin, payload.Bet, optimalBet);
            
            const profitPercent = profit !== 0 ? (profit / payload.Bet * 100).toFixed(1) : "0";
            
            console.log(`  ${isWin ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `${profitPercent}%`}`);
            console.log(`  💼 New Balance: ${newBalance.toFixed(8)} BTC`);
            console.log(`  📊 Win Rate: ${(botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)}% | EV: ${(botState.stats.expectedValue * 100).toFixed(2)}%`);
            
            // Record history
            botState.betHistory.unshift({
                id: botState.stats.totalBets,
                time: new Date().toLocaleTimeString(),
                bet: payload.Bet,
                profit: profit,
                isWin: isWin,
                balance: newBalance,
                winRate: botState.stats.wins / botState.stats.totalBets,
                ev: botState.stats.expectedValue,
                confidence: performanceMetrics.confidence,
                streak: isWin ? botState.settings.consecutiveWins : -botState.settings.consecutiveLosses,
                session: botState.stats.sessionNumber,
                recovery: botState.settings.inRecovery,
                simulated: useSimulatedMode,
                real: useReal && !useSimulatedMode
            });
            
            while (botState.betHistory.length > 200) botState.betHistory.pop();
            
            return { success: true, isWin, profit, newBalance, simulated: useSimulatedMode };
        } else {
            return null;
        }
        
    } catch (error) {
        console.error(`❌ API Error: ${error.message}`);
        
        // Last resort - simulated bet
        const isWin = Math.random() < 0.52;
        const profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
        const newBalance = botState.stats.currentBalance + profit;
        
        updateStatistics(profit, isWin, betAmount, optimalBet);
        
        console.log(`  [FALLBACK] ${isWin ? '✅ WIN' : '❌ LOSS'} | P&L: ${profit.toFixed(8)} BTC`);
        
        return { success: true, isWin, profit, newBalance, fallback: true };
    }
}

function generateClientSeed() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 15);
}

// ============ MAIN ENGINE ============
async function runProfitEngine() {
    console.log(`\n🚀🚀🚀 SMALL BALANCE PROFIT ENGINE v9.0 🚀🚀🚀`);
    console.log(`=============================================`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`💵 USD Value: ~$${(botState.stats.currentBalance * btcPrice).toFixed(2)}`);
    console.log(`🎯 Target Payout: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit on win)`);
    console.log(`📊 Min Bet: ${CONFIG.minBet.toFixed(8)} BTC | Max Risk: ${CONFIG.maxRiskPercent*100}%`);
    console.log(`🎯 Daily Target: $${(CONFIG.dailyProfitTargets[2] * btcPrice).toFixed(2)}`);
    console.log(`=============================================\n`);
    
    // Fetch real balance on startup
    await fetchRealBalance();
    
    sessionStartBalance = botState.stats.currentBalance;
    dailyStartBalance = botState.stats.currentBalance;
    
    updatePerformanceMetrics();
    
    while (botState.running) {
        const result = await placeBet();
        if (result && result.success) {
            let delay = 600;
            if (result.isWin && botState.settings.consecutiveWins > 2) delay = 400;
            if (!result.isWin && botState.settings.consecutiveLosses > 1) delay = 1000;
            if (performanceMetrics.confidence > 0.55) delay *= 0.8;
            await new Promise(r => setTimeout(r, Math.min(1500, Math.max(300, delay))));
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ============ API ENDPOINTS ============

// Get current balance (real from API)
app.get('/api/balance', async (req, res) => {
    const balance = await fetchRealBalance();
    res.json({
        realBalance: balance,
        botBalance: botState.stats.currentBalance,
        usdValue: (balance * btcPrice).toFixed(2),
        message: "Real balance from Crypto.Games API"
    });
});

// Force real balance sync
app.get('/api/sync-balance', async (req, res) => {
    const balance = await fetchRealBalance();
    res.json({
        synced: true,
        balance: balance,
        message: "Balance synced from API"
    });
});

// Toggle between real and demo mode
app.get('/api/toggle-mode', (req, res) => {
    botState.settings.useRealMode = !botState.settings.useRealMode;
    res.json({
        mode: botState.settings.useRealMode ? "REAL" : "DEMO",
        message: `Switched to ${botState.settings.useRealMode ? "REAL" : "DEMO"} mode`
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Small Balance Profit Engine v9.0</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .glass {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 24px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .header { padding: 28px 32px; margin-bottom: 24px; }
        .header h1 { font-size: 32px; font-weight: 800; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { padding: 24px; transition: transform 0.2s; }
        .card:hover { transform: translateY(-4px); }
        .card-title { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #6c757d; margin-bottom: 12px; letter-spacing: 0.5px; }
        .card-value { font-size: 32px; font-weight: 800; color: #1a1a2e; margin-bottom: 6px; }
        .mini-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 24px; }
        .mini-card { padding: 16px; text-align: center; }
        .mini-card .label { font-size: 11px; font-weight: 600; color: #6c757d; margin-bottom: 8px; text-transform: uppercase; }
        .mini-card .value { font-size: 20px; font-weight: 700; color: #1a1a2e; }
        .status-bar { padding: 16px 24px; margin-bottom: 24px; font-weight: 600; }
        .profit-positive { color: #10b981; }
        .profit-negative { color: #ef4444; }
        .table-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { padding: 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6c757d; border-bottom: 1px solid #e9ecef; }
        td { padding: 12px 16px; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
        .win { color: #10b981; font-weight: 600; }
        .loss { color: #ef4444; font-weight: 600; }
        tr:hover { background: #f8f9fa; }
        .badge-real { background: #10b981; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; }
        .badge-sim { background: #f59e0b; color: white; padding: 2px 8px; border-radius: 12px; font-size: 10px; margin-left: 8px; }
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: 1fr; }
            .mini-stats { grid-template-columns: repeat(3, 1fr); }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="glass header">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
            <div>
                <h1>Small Balance Profit Engine <span style="font-size: 14px;">v9.0</span></h1>
                <p style="color: #6c757d; margin-top: 8px;">Optimized for Small Balances | Auto-Scaling | Real Balance Sync</p>
            </div>
            <div>
                <div style="font-size: 11px; color: #6c757d;">Expected Value</div>
                <div id="evDisplay" style="font-size: 24px; font-weight: 800;">+0%</div>
            </div>
        </div>
    </div>
    
    <div class="glass status-bar" id="statusMsg">Initializing...</div>
    
    <div class="stats-grid">
        <div class="glass card"><div class="card-title">Balance</div><div class="card-value" id="balance">0.00000000</div><div class="card-title" id="balanceUsd" style="font-size: 11px;">BTC</div></div>
        <div class="glass card"><div class="card-title">Real Balance</div><div class="card-value" id="realBalance">0.00000000</div><div class="card-title" style="font-size: 11px;">From API</div></div>
        <div class="glass card"><div class="card-title">Win Rate</div><div class="card-value" id="winrate">0%</div><div class="card-title">EV: <span id="ev">0</span></div></div>
        <div class="glass card"><div class="card-title">Growth</div><div class="card-value" id="growth">1x</div><div class="card-title">Peak: <span id="peak">0</span></div></div>
    </div>
    
    <div class="mini-stats">
        <div class="glass mini-card"><div class="label">Session</div><div class="value" id="session">#1</div></div>
        <div class="glass mini-card"><div class="label">Win Streak</div><div class="value win" id="winStreak">0</div></div>
        <div class="glass mini-card"><div class="label">Loss Streak</div><div class="value loss" id="lossStreak">0</div></div>
        <div class="glass mini-card"><div class="label">Total Bets</div><div class="value" id="totalBets">0</div></div>
        <div class="glass mini-card"><div class="label">Profit Factor</div><div class="value" id="profitFactor">0</div></div>
        <div class="glass mini-card"><div class="label">Recoveries</div><div class="value" id="recoveries">0</div></div>
    </div>
    
    <div class="glass table-container">
        <table>
            <thead>
                <tr><th>#</th><th>Time</th><th>Wager</th><th>Result</th><th>P&L</th><th>Balance</th><th>EV</th><th>Type</th><th>Streak</th></tr>
            </thead>
            <tbody id="historyBody"><tr><td colspan="9" style="text-align:center; padding:40px;">Loading...<\/td></tr></tbody>
        </table>
    </div>
</div>

<script>
    async function update() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const f = (n) => parseFloat(n || 0).toFixed(8);
            
            document.getElementById('balance').innerHTML = f(data.botState.stats.currentBalance);
            document.getElementById('balanceUsd').innerHTML = '≈ $' + (data.botState.stats.currentBalance * data.btcPrice).toFixed(2) + ' USD';
            document.getElementById('realBalance').innerHTML = f(data.botState.stats.realBalance || 0);
            document.getElementById('winrate').innerHTML = (data.botState.stats.wins / Math.max(1, data.botState.stats.totalBets) * 100).toFixed(1) + '%';
            document.getElementById('ev').innerHTML = (data.botState.stats.expectedValue * 100).toFixed(2) + '%';
            document.getElementById('evDisplay').innerHTML = (data.botState.stats.expectedValue > 0 ? '+' : '') + (data.botState.stats.expectedValue * 100).toFixed(1) + '%';
            document.getElementById('growth').innerHTML = (data.botState.stats.currentBalance / data.botState.stats.startingBalance).toFixed(2) + 'x';
            document.getElementById('peak').innerHTML = f(data.botState.stats.peakBalance);
            document.getElementById('session').innerHTML = '#' + data.botState.stats.sessionNumber;
            document.getElementById('winStreak').innerHTML = data.botState.settings.consecutiveWins || 0;
            document.getElementById('lossStreak').innerHTML = data.botState.settings.consecutiveLosses || 0;
            document.getElementById('totalBets').innerHTML = data.botState.stats.totalBets;
            document.getElementById('profitFactor').innerHTML = data.botState.stats.profitFactor.toFixed(2);
            document.getElementById('recoveries').innerHTML = data.botState.stats.successfulRecoveries;
            document.getElementById('statusMsg').innerHTML = data.botState.statusMessage;
            
            if (data.botState.betHistory && data.botState.betHistory.length > 0) {
                var html = '';
                for (var i = 0; i < Math.min(30, data.botState.betHistory.length); i++) {
                    var b = data.botState.betHistory[i];
                    var typeText = b.real ? '🔴 REAL' : (b.simulated ? '🎲 SIM' : '📡 DEMO');
                    var typeClass = b.real ? 'win' : (b.simulated ? '' : 'loss');
                    html += '</tr>' +
                        '<td>#' + b.id + '<\/td>' +
                        '<td>' + b.time + '<\/td>' +
                        '<td>' + f(b.bet) + '<\/td>' +
                        '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? 'WIN' : 'LOSS') + '<\/td>' +
                        '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profit > 0 ? '+' : '') + f(b.profit) + '<\/td>' +
                        '<td>' + f(b.balance) + '<\/td>' +
                        '<td class="' + (b.ev > 0 ? 'win' : 'loss') + '">' + (b.ev * 100).toFixed(1) + '%<\/td>' +
                        '<td class="' + typeClass + '">' + typeText + '<\/td>' +
                        '<td>' + (b.streak > 0 ? '🔥' + b.streak : (b.streak < 0 ? '📉' + Math.abs(b.streak) : '-')) + '<\/td>' +
                        '<\/tr>';
                }
                document.getElementById('historyBody').innerHTML = html;
            }
        } catch(e) { console.error(e); }
    }
    setInterval(update, 1000);
    update();
<\/script>
</body>
</html>
    `);
});

app.get('/api/stats', (req, res) => {
    res.json({
        botState: {
            stats: botState.stats,
            settings: botState.settings,
            betHistory: botState.betHistory.slice(0, 30),
            statusMessage: botState.statusMessage
        },
        btcPrice: btcPrice,
        performanceMetrics: performanceMetrics
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Dashboard: http://localhost:${port}`);
    console.log(`🚀 Small Balance Profit Engine v9.0 Started`);
    runProfitEngine();
});
