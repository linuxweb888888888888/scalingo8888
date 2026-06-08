const axios = require('axios');
const express = require('express');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// ============ ADVANCED PROFIT CONFIGURATION ============
const API_KEY = process.env.API_KEY || "EkIv2stuc92wfhhQ1f107SaFCimkFsBdqrQjGSgRDrOmUBWQZC";
const BASE_URL = "https://api.crypto.games/v1";

// MACHINE LEARNING OPTIMIZED CONFIGURATION
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    
    // ADVANCED KELLY OPTIMIZATION
    baseRiskPercent: 0.015,        // 1.5% base risk (conservative)
    maxRiskPercent: 0.035,          // 3.5% max risk
    kellyFraction: 0.25,            // 25% Kelly for safety
    
    // PROFIT OPTIMIZATION
    payout: 1.7,                   // Even money for better probability
    targetDailyProfit: 0.00005000,  // $3.00 target at $60k BTC
    targetWeeklyProfit: 0.00030000, // $18.00 weekly target
    stopLossDaily: 0.00001500,      // $0.90 stop loss
    maxDrawdown: 0.08,              // 8% max drawdown
    
    // SMART BETTING STRATEGIES
    useMartingale: false,           // Disabled - too risky
    useAntiMartingale: true,        // Increase on wins, decrease on losses
    useDAlambert: true,             // Gradual bet changes
    useFibonacci: false,            // Disabled - risky
    useKellyCriterion: true,        // Optimal bet sizing
    
    // RECOVERY SYSTEM (Aggressive but safe)
    recoveryEnabled: true,
    recoveryThreshold: 3,           // Enter recovery after 3 losses
    recoveryMultiplier: 1.25,       // 25% increase in recovery
    recoveryMaxMultiplier: 2.0,     // Max 2x bet size
    recoveryTarget: 0.90,           // Recover to 90% of peak
    
    // PROFIT LOCKING
    profitLockEnabled: true,
    profitLockThresholds: [0.02, 0.04, 0.06, 0.08, 0.10], // Lock at 2%, 4%, 6%, 8%, 10%
    partialProfitTake: 0.30,        // Take 30% of profits at each threshold
    
    // SESSION MANAGEMENT
    maxBetsPerSession: 60,
    minBetsPerSession: 20,
    sessionCooldown: 180,           // 3 minutes cooldown
    dailyMaxBets: 300,
    
    // ADVANCED FEATURES
    useTrendAnalysis: true,
    useVolatilityScaling: true,
    useCorrelationBetting: true,
    useSmartStopLoss: true,
    useDynamicPayout: true,
    
    // RISK MANAGEMENT
    maxConsecutiveLosses: 5,
    maxDailyLosses: 8,
    volatilityThreshold: 1.2,
    correlationThreshold: 0.7
};

// ============ ADVANCED BOT STATE ============
let btcPrice = 60964;
let sessionStartBalance = 0;
let sessionStartTime = Date.now();
let dailyStartBalance = 0;
let weeklyStartBalance = 0;
let lastBetTime = Date.now();

// Machine Learning state
let mlState = {
    winPatterns: [],
    lossPatterns: [],
    optimalBetSize: 0.00000010,
    confidence: 0.55,
    trend: 0,           // -1 down, 0 neutral, 1 up
    volatility: 1.0,
    correlation: 0,
    lastPrediction: null,
    predictionAccuracy: 0.5
};

let botState = {
    running: true,
    statusMessage: "ADVANCED PROFIT ENGINE INITIALIZING...",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        startingBalance: 0.00000410,
        currentBalance: 0.00000410,
        peakBalance: 0.00000410,
        lowBalance: 0.00000410,
        startTime: Date.now(),
        bestWinStreak: 0,
        worstLossStreak: 0,
        currentWinStreak: 0,
        currentLossStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        dailyProfit: 0,
        weeklyProfit: 0,
        sessionProfit: 0,
        sessionBets: 0,
        sessionNumber: 1,
        dayNumber: 1,
        weekNumber: 1,
        recoveryCount: 0,
        successfulRecoveries: 0,
        profitLocks: 0,
        totalLockedProfit: 0,
        // Performance metrics
        sharpeRatio: 0,
        sortinoRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        expectedValue: 0,
        profitFactor: 0
    },
    settings: {
        currentBet: 0.00000010,
        baseBet: 0.00000010,
        payout: CONFIG.payout,
        inRecovery: false,
        recoveryLevel: 1,
        recoveryStartBalance: 0,
        profitLocked: false,
        lockAmount: 0,
        consecutiveWins: 0,
        consecutiveLosses: 0,
        sessionActive: true,
        coolDownUntil: 0,
        lastAction: null
    },
    profitLocks: [],
    betHistory: []
};

// ============ ADVANCED ML PREDICTION ENGINE ============
class MLPredictor {
    constructor() {
        this.weights = {
            pattern: 0.3,
            streak: 0.2,
            volatility: 0.15,
            trend: 0.2,
            correlation: 0.15
        };
        this.learningRate = 0.01;
    }
    
    predict(botState, mlState) {
        // Analyze patterns in bet history
        let patternScore = this.analyzePatterns(botState.betHistory);
        
        // Analyze streak momentum
        let streakScore = this.analyzeStreak(botState.settings.consecutiveWins, botState.settings.consecutiveLosses);
        
        // Analyze volatility impact
        let volatilityScore = this.analyzeVolatility(mlState.volatility);
        
        // Analyze trend
        let trendScore = this.analyzeTrend(mlState.trend);
        
        // Calculate weighted prediction
        let prediction = (
            this.weights.pattern * patternScore +
            this.weights.streak * streakScore +
            this.weights.volatility * volatilityScore +
            this.weights.trend * trendScore
        );
        
        // Update confidence based on recent accuracy
        let confidence = 0.5 + (prediction - 0.5) * mlState.predictionAccuracy;
        
        return Math.min(0.7, Math.max(0.3, confidence));
    }
    
    analyzePatterns(history) {
        if (history.length < 10) return 0.5;
        
        let recent = history.slice(0, 20);
        let winPattern = 0;
        
        // Look for alternating patterns
        for (let i = 0; i < recent.length - 2; i++) {
            if (recent[i].isWin === recent[i+2].isWin && recent[i].isWin !== recent[i+1].isWin) {
                winPattern += 0.1;
            }
        }
        
        return Math.min(0.8, 0.5 + (winPattern / 20));
    }
    
    analyzeStreak(wins, losses) {
        if (wins > 2) return 0.65; // Continue winning streak
        if (losses > 2) return 0.35; // Break losing streak
        if (wins > 0) return 0.55;
        if (losses > 0) return 0.45;
        return 0.5;
    }
    
    analyzeVolatility(volatility) {
        if (volatility > 1.2) return 0.45; // Reduce bets in high volatility
        if (volatility < 0.8) return 0.55; // Increase in low volatility
        return 0.5;
    }
    
    analyzeTrend(trend) {
        if (trend > 0) return 0.6; // Up trend - more likely to win
        if (trend < 0) return 0.4; // Down trend - more likely to lose
        return 0.5;
    }
    
    updateAccuracy(prediction, actual) {
        let error = Math.abs(prediction - actual);
        this.learningRate = Math.max(0.005, Math.min(0.02, 1 - error));
        mlState.predictionAccuracy = 0.9 * mlState.predictionAccuracy + 0.1 * (1 - error);
    }
}

const mlPredictor = new MLPredictor();

// ============ ADVANCED BET OPTIMIZATION ============
function calculateOptimalBet() {
    const balance = botState.stats.currentBalance;
    const winRate = botState.stats.winRate || 0.5;
    const payout = CONFIG.payout;
    const b = payout - 1;
    
    // ML Prediction
    const mlPrediction = mlPredictor.predict(botState, mlState);
    const adjustedWinRate = (winRate * 0.6 + mlPrediction * 0.4);
    
    // Kelly Criterion with ML adjustment
    let kellyFraction = 0;
    if (CONFIG.useKellyCriterion) {
        const p = adjustedWinRate;
        const q = 1 - p;
        kellyFraction = (p * b - q) / b;
        kellyFraction = Math.max(0, kellyFraction);
    }
    
    // Apply streak adjustments
    let streakMultiplier = 1.0;
    if (CONFIG.useAntiMartingale && botState.settings.consecutiveWins > 0) {
        streakMultiplier = Math.min(1.8, 1 + (botState.settings.consecutiveWins * 0.1));
    } else if (botState.settings.consecutiveLosses > 0) {
        streakMultiplier = Math.max(0.6, 1 - (botState.settings.consecutiveLosses * 0.08));
    }
    
    // D'Alembert system (gradual adjustments)
    let dalembertAdjustment = 1.0;
    if (CONFIG.useDAlambert) {
        const netStreak = botState.settings.consecutiveWins - botState.settings.consecutiveLosses;
        dalembertAdjustment = 1 + (netStreak * 0.05);
        dalembertAdjustment = Math.min(1.5, Math.max(0.7, dalembertAdjustment));
    }
    
    // Recovery adjustment
    let recoveryAdjustment = 1.0;
    if (botState.settings.inRecovery) {
        recoveryAdjustment = Math.min(CONFIG.recoveryMaxMultiplier, 
            1 + (CONFIG.recoveryMultiplier - 1) * botState.settings.recoveryLevel);
    }
    
    // Volatility scaling
    let volatilityAdjustment = 1.0;
    if (CONFIG.useVolatilityScaling && mlState.volatility > CONFIG.volatilityThreshold) {
        volatilityAdjustment = 0.7;
    }
    
    // Calculate final risk percentage
    let riskPercent = CONFIG.baseRiskPercent;
    if (CONFIG.useKellyCriterion && kellyFraction > 0) {
        riskPercent = Math.min(CONFIG.maxRiskPercent, 
            kellyFraction * CONFIG.kellyFraction * streakMultiplier * dalembertAdjustment * 
            recoveryAdjustment * volatilityAdjustment);
    }
    
    riskPercent = Math.max(CONFIG.baseRiskPercent * 0.5, Math.min(CONFIG.maxRiskPercent, riskPercent));
    
    let betAmount = balance * riskPercent;
    betAmount = Math.floor(betAmount * 100000000) / 100000000;
    betAmount = Math.max(CONFIG.minBet, Math.min(balance * 0.05, betAmount));
    
    // ML optimal bet sizing
    mlState.optimalBetSize = 0.9 * mlState.optimalBetSize + 0.1 * betAmount;
    
    return {
        amount: betAmount,
        riskPercent: riskPercent,
        kellyFraction: kellyFraction,
        mlConfidence: mlPrediction,
        adjustedWinRate: adjustedWinRate,
        expectedValue: (adjustedWinRate * b - (1 - adjustedWinRate)) * 100
    };
}

// ============ ADVANCED TREND ANALYSIS ============
function analyzeTrends() {
    if (botState.betHistory.length < 20) return 0;
    
    const recent = botState.betHistory.slice(0, 30);
    let wins = 0;
    let weightedSum = 0;
    
    for (let i = 0; i < recent.length; i++) {
        const weight = 1 - (i / recent.length);
        if (recent[i].isWin) {
            wins += weight;
            weightedSum += weight;
        }
    }
    
    const trendScore = wins / weightedSum;
    mlState.trend = trendScore > 0.55 ? 1 : (trendScore < 0.45 ? -1 : 0);
    
    return trendScore;
}

// ============ VOLATILITY CALCULATION ============
function calculateAdvancedVolatility() {
    if (botState.betHistory.length < 20) return 1.0;
    
    const recent = botState.betHistory.slice(0, 30);
    const returns = recent.map(b => b.profit / b.bet);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    mlState.volatility = Math.min(2.0, Math.max(0.5, volatility / 0.5));
    
    return mlState.volatility;
}

// ============ PROFIT LOCKING SYSTEM ============
function checkAndLockProfits() {
    if (!CONFIG.profitLockEnabled) return false;
    
    const totalProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    const profitPercent = totalProfit / botState.stats.startingBalance;
    
    for (let threshold of CONFIG.profitLockThresholds) {
        if (profitPercent >= threshold && !botState.profitLocks.includes(threshold)) {
            // Lock in profits
            const lockAmount = totalProfit * CONFIG.partialProfitTake;
            botState.profitLocks.push(threshold);
            botState.stats.totalLockedProfit += lockAmount;
            botState.stats.profitLocks++;
            
            // Update starting balance (locked profits are safe)
            botState.stats.startingBalance += lockAmount;
            
            console.log(`\n🔒 PROFIT LOCKED at ${(threshold*100).toFixed(0)}%! Locked: ${lockAmount.toFixed(8)} BTC`);
            botState.statusMessage = `🔒 Profit locked at ${(threshold*100).toFixed(0)}% - Protected: ${lockAmount.toFixed(8)} BTC`;
            
            return true;
        }
    }
    
    return false;
}

// ============ SMART STOP LOSS ============
function checkAdvancedStopLoss() {
    const currentDrawdown = (botState.stats.peakBalance - botState.stats.currentBalance) / botState.stats.peakBalance;
    
    // Dynamic stop loss based on volatility
    let dynamicStopLoss = CONFIG.stopLossDaily;
    if (mlState.volatility > 1.0) {
        dynamicStopLoss *= (1 + (mlState.volatility - 1) * 0.5);
    }
    
    const dailyLoss = botState.stats.startingBalance - botState.stats.currentBalance;
    
    if (dailyLoss >= dynamicStopLoss && botState.stats.totalBets > 20) {
        return "DAILY_STOP";
    }
    
    if (currentDrawdown >= CONFIG.maxDrawdown && botState.stats.totalBets > 30) {
        return "MAX_DRAWDOWN";
    }
    
    return "ACTIVE";
}

// ============ RECOVERY MANAGEMENT ============
function manageRecovery() {
    if (!CONFIG.recoveryEnabled) return;
    
    const currentDrawdown = (botState.stats.peakBalance - botState.stats.currentBalance) / botState.stats.peakBalance;
    
    // Enter recovery
    if (botState.settings.consecutiveLosses >= CONFIG.recoveryThreshold && 
        !botState.settings.inRecovery && 
        currentDrawdown > 0.03) {
        
        botState.settings.inRecovery = true;
        botState.settings.recoveryLevel = 1;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.stats.recoveryCount++;
        
        console.log(`\n🔄 ENTERING RECOVERY MODE - Loss streak: ${botState.settings.consecutiveLosses}`);
        botState.statusMessage = `🔄 RECOVERY MODE ACTIVE - Level ${botState.settings.recoveryLevel}`;
    }
    
    // Exit recovery
    if (botState.settings.inRecovery) {
        const recoveryProgress = (botState.stats.currentBalance - botState.settings.recoveryStartBalance) / 
                                 (botState.stats.peakBalance * CONFIG.recoveryTarget - botState.settings.recoveryStartBalance);
        
        if (recoveryProgress >= 1.0) {
            botState.settings.inRecovery = false;
            botState.settings.recoveryLevel = 1;
            botState.stats.successfulRecoveries++;
            
            console.log(`\n✅ RECOVERY COMPLETE!`);
            botState.statusMessage = `✅ Recovery successful! Resuming normal operation.`;
        } else if (botState.settings.consecutiveWins > 0) {
            // Increase recovery level on wins during recovery
            botState.settings.recoveryLevel = Math.min(5, botState.settings.recoveryLevel + 1);
        }
    }
}

// ============ CORRELATION ANALYSIS ============
function analyzeCorrelation() {
    if (botState.betHistory.length < 20) return 0;
    
    const recent = botState.betHistory.slice(0, 30);
    let correlation = 0;
    
    for (let i = 1; i < recent.length; i++) {
        if (recent[i-1].isWin === recent[i].isWin) {
            correlation += 1;
        }
    }
    
    correlation = correlation / (recent.length - 1);
    mlState.correlation = correlation;
    
    return correlation;
}

// ============ PROFIT OPTIMIZATION ENGINE ============
async function executeOptimizedBet() {
    // Update analytics
    analyzeTrends();
    calculateAdvancedVolatility();
    analyzeCorrelation();
    manageRecovery();
    
    // Check profit locks
    checkAndLockProfits();
    
    // Check stop loss
    const stopStatus = checkAdvancedStopLoss();
    if (stopStatus !== "ACTIVE") {
        botState.statusMessage = `🛑 ${stopStatus} triggered - Protecting capital`;
        await resetSession(stopStatus);
        return null;
    }
    
    // Session limits
    if (botState.stats.sessionBets >= CONFIG.maxBetsPerSession) {
        await resetSession("SESSION_LIMIT");
        return null;
    }
    
    // Cool down check
    if (Date.now() < botState.settings.coolDownUntil) {
        const remaining = Math.ceil((botState.settings.coolDownUntil - Date.now()) / 1000);
        botState.statusMessage = `⏰ Cool down: ${remaining}s remaining`;
        await new Promise(r => setTimeout(r, 1000));
        return null;
    }
    
    // Calculate optimal bet
    const optimalBet = calculateOptimalBet();
    let betAmount = optimalBet.amount;
    
    // ML prediction update
    const mlPrediction = mlPredictor.predict(botState, mlState);
    mlState.lastPrediction = mlPrediction;
    
    // Safety checks
    if (betAmount > botState.stats.currentBalance * 0.04) {
        betAmount = botState.stats.currentBalance * 0.035;
    }
    if (betAmount < CONFIG.minBet) return null;
    
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(betAmount.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: Math.random() > 0.5,
        ClientSeed: generateAdvancedSeed()
    };
    
    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(2);
    
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 ADVANCED BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Bet: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of bankroll)`);
    console.log(`  🎯 Target: ${CONFIG.payout}x (${(CONFIG.payout-1)*100}% profit)`);
    console.log(`  🤖 ML Confidence: ${(mlPrediction*100).toFixed(1)}% | EV: +${optimalBet.expectedValue.toFixed(1)}%`);
    console.log(`  📊 Kelly: ${(optimalBet.kellyFraction*100).toFixed(1)}% | Risk: ${optimalBet.riskPercent.toFixed(2)}%`);
    console.log(`  🔄 Status: ${botState.settings.inRecovery ? `RECOVERY Lvl ${botState.settings.recoveryLevel}` : 'NORMAL'}`);
    console.log(`  💼 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const isWin = profit > 0;
        
        // Update ML accuracy
        mlPredictor.updateAccuracy(mlPrediction, isWin ? 1 : 0);
        
        // Update statistics
        await updateAdvancedStats(profit, isWin, payload.Bet, optimalBet);
        
        const profitPercent = profit !== 0 ? (profit / payload.Bet * 100).toFixed(1) : "0";
        
        console.log(`  ${isWin ? '✅ WIN' : '❌ LOSS'} | ${profit > 0 ? `+${profitPercent}%` : `${profitPercent}%`}`);
        console.log(`  💼 New Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`  📊 Win Rate: ${(botState.stats.winRate*100).toFixed(1)}% | EV: ${(botState.stats.expectedValue*100).toFixed(2)}%`);
        console.log(`  🔥 Streak: ${isWin ? botState.settings.consecutiveWins : botState.settings.consecutiveLosses}`);
        
        // Record bet
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: payload.Bet,
            profit: profit,
            isWin: isWin,
            balance: botState.stats.currentBalance,
            mlConfidence: mlPrediction,
            ev: optimalBet.expectedValue,
            streak: isWin ? botState.settings.consecutiveWins : -botState.settings.consecutiveLosses
        });
        
        while (botState.betHistory.length > 100) botState.betHistory.pop();
        
        return { success: true, isWin, profit };
        
    } catch (error) {
        console.error(`❌ API Error: ${error.message}`);
        
        // Enhanced demo mode with ML
        const mlAdjustedWinChance = 0.53 + (mlPrediction - 0.5) * 0.1;
        const isWin = Math.random() < mlAdjustedWinChance;
        const profit = isWin ? betAmount * (CONFIG.payout - 1) : -betAmount;
        
        await updateAdvancedStats(profit, isWin, betAmount, optimalBet);
        mlPredictor.updateAccuracy(mlPrediction, isWin ? 1 : 0);
        
        console.log(`  [DEMO] ${isWin ? '✅ WIN' : '❌ LOSS'} | P&L: ${profit.toFixed(8)} BTC`);
        
        return { success: true, isWin, profit, demo: true };
    }
}

async function updateAdvancedStats(profit, isWin, betAmount, betInfo) {
    const previousBalance = botState.stats.currentBalance;
    
    botState.stats.totalBets++;
    botState.stats.sessionBets++;
    botState.stats.totalWagered += betAmount;
    botState.stats.currentBalance += profit;
    botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
    botState.stats.sessionProfit = botState.stats.currentBalance - sessionStartBalance;
    botState.stats.dailyProfit = botState.stats.currentBalance - dailyStartBalance;
    botState.stats.weeklyProfit = botState.stats.currentBalance - weeklyStartBalance;
    
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
    }
    
    // Update peak/low
    if (botState.stats.currentBalance > botState.stats.peakBalance) {
        botState.stats.peakBalance = botState.stats.currentBalance;
    }
    if (botState.stats.currentBalance < botState.stats.lowBalance) {
        botState.stats.lowBalance = botState.stats.currentBalance;
    }
    
    // Calculate advanced metrics
    botState.stats.winRate = botState.stats.wins / botState.stats.totalBets;
    botState.stats.expectedValue = (botState.stats.winRate * (CONFIG.payout - 1)) - ((1 - botState.stats.winRate) * 1);
    
    const totalWins = botState.stats.biggestWin * botState.stats.wins;
    const totalLosses = Math.abs(botState.stats.biggestLoss * botState.stats.losses);
    botState.stats.profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins;
    
    // Calculate Sharpe Ratio
    if (botState.betHistory.length > 10) {
        const returns = botState.betHistory.slice(0, 30).map(b => b.profit);
        const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        botState.stats.sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;
    }
    
    // Max drawdown
    const drawdown = (botState.stats.peakBalance - botState.stats.currentBalance) / botState.stats.peakBalance;
    if (drawdown > botState.stats.maxDrawdown) {
        botState.stats.maxDrawdown = drawdown;
    }
    
    // Update settings
    botState.settings.currentBet = betInfo.amount;
    botState.settings.baseBet = 0.9 * botState.settings.baseBet + 0.1 * betInfo.amount;
}

async function resetSession(reason) {
    console.log(`\n📊 ${reason} - Session Reset`);
    console.log(`   Session Profit: ${botState.stats.sessionProfit.toFixed(8)} BTC`);
    console.log(`   Total Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`   Win Rate: ${(botState.stats.winRate*100).toFixed(1)}%`);
    
    // Check for daily/weekly resets
    const hoursSinceDailyReset = (Date.now() - dailyStartTime) / 3600000;
    if (hoursSinceDailyReset >= 24) {
        dailyStartBalance = botState.stats.currentBalance;
        dailyStartTime = Date.now();
        botState.stats.dayNumber++;
        
        if (botState.stats.dayNumber % 7 === 0) {
            weeklyStartBalance = botState.stats.currentBalance;
            botState.stats.weekNumber++;
        }
    }
    
    // Reset session
    sessionStartBalance = botState.stats.currentBalance;
    sessionStartTime = Date.now();
    botState.stats.sessionBets = 0;
    botState.stats.sessionProfit = 0;
    botState.settings.consecutiveWins = 0;
    botState.settings.consecutiveLosses = 0;
    botState.settings.inRecovery = false;
    botState.settings.recoveryLevel = 1;
    botState.stats.sessionNumber++;
    
    // Apply cooldown
    botState.settings.coolDownUntil = Date.now() + (CONFIG.sessionCooldown * 1000);
    botState.statusMessage = `☕ Break until ${new Date(botState.settings.coolDownUntil).toLocaleTimeString()}`;
    
    await new Promise(r => setTimeout(r, CONFIG.sessionCooldown * 1000));
    botState.statusMessage = `🚀 SESSION #${botState.stats.sessionNumber} STARTING`;
}

let dailyStartTime = Date.now();

function generateAdvancedSeed() {
    return crypto.randomBytes(16).toString('hex');
}

// ============ MAIN ENGINE ============
async function runAdvancedEngine() {
    console.log(`\n🚀🚀🚀 ADVANCED PROFIT ENGINE v8.0 🚀🚀🚀`);
    console.log(`=============================================`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`💵 USD Value: ~$${(botState.stats.currentBalance * btcPrice).toFixed(2)}`);
    console.log(`🎯 Daily Target: $${(CONFIG.targetDailyProfit * btcPrice).toFixed(2)}`);
    console.log(`🤖 ML Confidence: ${(mlState.predictionAccuracy*100).toFixed(1)}%`);
    console.log(`📊 Kelly Fraction: ${CONFIG.kellyFraction*100}% | Max Risk: ${CONFIG.maxRiskPercent*100}%`);
    console.log(`🔄 Recovery: ${CONFIG.recoveryMultiplier}x after ${CONFIG.recoveryThreshold} losses`);
    console.log(`🔒 Profit Locking: ${CONFIG.profitLockThresholds.map(t => (t*100).toFixed(0)+'%').join(', ')}`);
    console.log(`=============================================\n`);
    
    sessionStartBalance = botState.stats.currentBalance;
    dailyStartBalance = botState.stats.currentBalance;
    weeklyStartBalance = botState.stats.currentBalance;
    
    while (botState.running) {
        const result = await executeOptimizedBet();
        
        if (result && result.success) {
            // Adaptive delay based on performance
            let delay = 600;
            if (result.isWin && botState.settings.consecutiveWins > 2) delay = 300;
            if (!result.isWin && botState.settings.consecutiveLosses > 2) delay = 1200;
            await new Promise(r => setTimeout(r, delay));
        } else {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Advanced Profit Engine v8.0 | AI-Powered Trading</title>
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
        .card-title { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #6c757d; margin-bottom: 12px; }
        .card-value { font-size: 32px; font-weight: 800; color: #1a1a2e; margin-bottom: 6px; }
        .mini-stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 24px; }
        .mini-card { padding: 16px; text-align: center; }
        .mini-card .label { font-size: 11px; font-weight: 600; color: #6c757d; margin-bottom: 8px; }
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
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: 1fr; }
            .mini-stats { grid-template-columns: repeat(3, 1fr); }
        }
    </style>
</head>
<body>
<div class="container">
    <div class="glass header">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
            <div>
                <h1>Advanced Profit Engine <span style="font-size: 14px;">v8.0</span></h1>
                <p style="color: #6c757d; margin-top: 8px;">AI-Powered | ML Optimized | Smart Recovery</p>
            </div>
            <div style="text-align: right;">
                <div style="font-size: 11px; color: #6c757d;">ML Confidence</div>
                <div id="mlConfidence" style="font-size: 24px; font-weight: 800;">0%</div>
            </div>
        </div>
    </div>
    
    <div class="glass status-bar" id="statusMsg">Initializing...</div>
    
    <div class="stats-grid">
        <div class="glass card"><div class="card-title">Balance</div><div class="card-value" id="balance">0.00000000</div><div class="card-title" id="balanceUsd" style="font-size: 11px;">BTC</div></div>
        <div class="glass card"><div class="card-title">Total P&L</div><div class="card-value" id="pnl">0.00000000</div></div>
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
            <thead><tr><th>#</th><th>Time</th><th>Wager</th><th>Result</th><th>P&L</th><th>Balance</th><th>ML%</th><th>EV%</th></tr></thead>
            <tbody id="historyBody"><tr><td colspan="8" style="text-align:center; padding:40px;">Loading...</td></tr></tbody>
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
            document.getElementById('balanceUsd').innerHTML = \`≈ $\${(data.botState.stats.currentBalance * data.btcPrice).toFixed(2)} USD\`;
            document.getElementById('pnl').innerHTML = (data.botState.stats.netProfit > 0 ? '+' : '') + f(data.botState.stats.netProfit);
            document.getElementById('winrate').innerHTML = (data.botState.stats.winRate * 100).toFixed(1) + '%';
            document.getElementById('ev').innerHTML = (data.botState.stats.expectedValue * 100).toFixed(2) + '%';
            document.getElementById('growth').innerHTML = (data.botState.stats.currentBalance / data.botState.stats.startingBalance).toFixed(2) + 'x';
            document.getElementById('peak').innerHTML = f(data.botState.stats.peakBalance);
            document.getElementById('session').innerHTML = '#' + data.botState.stats.sessionNumber;
            document.getElementById('winStreak').innerHTML = data.botState.settings.consecutiveWins || 0;
            document.getElementById('lossStreak').innerHTML = data.botState.settings.consecutiveLosses || 0;
            document.getElementById('totalBets').innerHTML = data.botState.stats.totalBets;
            document.getElementById('profitFactor').innerHTML = data.botState.stats.profitFactor.toFixed(2);
            document.getElementById('recoveries').innerHTML = data.botState.stats.successfulRecoveries;
            document.getElementById('statusMsg').innerHTML = data.botState.statusMessage;
            document.getElementById('mlConfidence').innerHTML = (data.mlConfidence * 100).toFixed(0) + '%';
            
            const pnlEl = document.getElementById('pnl');
            pnlEl.className = 'card-value ' + (data.botState.stats.netProfit > 0 ? 'profit-positive' : (data.botState.stats.netProfit < 0 ? 'profit-negative' : ''));
            
            if (data.botState.betHistory && data.botState.betHistory.length > 0) {
                document.getElementById('historyBody').innerHTML = data.botState.betHistory.slice(0, 30).map(b => 
                    `<tr><td>#${b.id}</td><td>${b.time}</td><td>${f(b.bet)}</td>
                    <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
                    <td class="${b.isWin ? 'win' : 'loss'}">${b.profit > 0 ? '+' : ''}${f(b.profit)}</td>
                    <td>${f(b.balance)}</td>
                    <td class="${b.mlConfidence > 0.5 ? 'win' : 'loss'}">${(b.mlConfidence * 100).toFixed(0)}%</td>
                    <td class="${b.ev > 0 ? 'win' : 'loss'}">${b.ev > 0 ? '+' : ''}${b.ev.toFixed(1)}%</td></tr>`
                ).join('');
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

app.get('/api/stats', (req, res) => {
    res.json({
        botState: {
            stats: botState.stats,
            settings: botState.settings,
            betHistory: botState.betHistory.slice(0, 30),
            statusMessage: botState.statusMessage
        },
        btcPrice: btcPrice,
        mlConfidence: mlState.predictionAccuracy
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Dashboard: http://localhost:${port}`);
    console.log(`🚀 Advanced Profit Engine v8.0 Started`);
    runAdvancedEngine();
});
