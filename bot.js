const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "l7Y9CyxXHMtvfbxsnNo1P20Ob6ZPUW30RWLByjrSUVcDciBHhF";
const BASE_URL = "https://api.crypto.games/v1";

// DYNAMIC CONFIGURATION THAT EVOLVES WITH BALANCE
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.10,      // Starts at 10% of balance
    maxBetPercent: 0.30,       // Max 30% of balance
    payout: 1.7,               // Base payout
    targetMultiplier: 16.67,   // Target 1667% return
    stopLossPercent: 0.50,     // Stop loss at 50% drawdown
    useKelly: true,
    useParoli: true,
    useAntiMartingale: true,
    useDAlenbert: false
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing ADAPTIVE ENGINE...",
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
        currentStrategy: "AGGRESSIVE",
        volatility: "HIGH",
        riskLevel: 1.0,        // Starts at maximum risk
        adaptiveMode: true,
        growthStage: 1          // Stage 1: Micro (12-100 sat), Stage 2: Small (100-1000), Stage 3: Growing (1000+)
    },
    betHistory: []
};

// ============ BALANCE-BASED STRATEGY OPTIMIZER ============
function updateStrategyByBalance() {
    const balance = botState.stats.currentBalance;
    const startingBalance = botState.stats.startingBalance;
    const growthMultiplier = balance / startingBalance;
    
    // Determine growth stage
    let newStage = 1;
    let newRiskLevel = 1.0;
    let newBasePercent = 0.10;
    let newMaxPercent = 0.30;
    let newPayout = 3.0;
    let newStrategy = "ULTRA AGGRESSIVE";
    
    if (balance < 0.00000100) { // Less than 100 satoshis
        newStage = 1;
        newRiskLevel = 1.0;      // Maximum risk
        newBasePercent = 0.15;    // 15% of balance (was 10%)
        newMaxPercent = 0.35;     // 35% max bet
        newPayout = 3.5;          // Higher payout for faster growth
        newStrategy = "🚀 MICRO GROWTH - MAX RISK";
        CONFIG.useParoli = true;
        CONFIG.useAntiMartingale = true;
    } 
    else if (balance < 0.00001000) { // 100 - 1000 satoshis
        newStage = 2;
        newRiskLevel = 0.8;       // Reduce risk slightly
        newBasePercent = 0.08;     // 8% of balance
        newMaxPercent = 0.25;      // 25% max bet
        newPayout = 2.8;           // Moderate payout
        newStrategy = "💪 SMALL BALANCE - BALANCED";
        CONFIG.useParoli = true;
        CONFIG.useAntiMartingale = true;
    } 
    else if (balance < 0.00010000) { // 1000 - 10000 satoshis
        newStage = 3;
        newRiskLevel = 0.6;       // Lower risk for larger balance
        newBasePercent = 0.05;     // 5% of balance
        newMaxPercent = 0.20;      // 20% max bet
        newPayout = 2.5;           // Standard payout
        newStrategy = "📈 GROWING BALANCE - CONSERVATIVE";
        CONFIG.useParoli = false;
        CONFIG.useAntiMartingale = true;
    } 
    else { // Over 10000 satoshis
        newStage = 4;
        newRiskLevel = 0.4;       // Low risk for wealth preservation
        newBasePercent = 0.03;     // 3% of balance
        newMaxPercent = 0.15;      // 15% max bet
        newPayout = 2.2;           // Lower payout for consistency
        newStrategy = "🛡️ WEALTH MODE - PRESERVATION";
        CONFIG.useParoli = false;
        CONFIG.useAntiMartingale = false;
    }
    
    // Adjust based on win rate performance
    if (botState.stats.totalBets > 20) {
        const winRate = botState.stats.wins / botState.stats.totalBets;
        if (winRate > 0.55 && newStage < 3) {
            // Performing well, increase aggression
            newBasePercent = Math.min(0.20, newBasePercent * 1.2);
            newPayout = Math.min(4.0, newPayout * 1.1);
            newStrategy += " 🔥 (HOT STREAK BONUS)";
        } else if (winRate < 0.45 && newStage === 1) {
            // Losing streak in micro stage, go all-in
            newBasePercent = 0.20;
            newPayout = 4.0;
            newStrategy += " ⚡ (DESPERATION MODE)";
        }
    }
    
    // Apply new settings if changed
    if (newStage !== botState.settings.growthStage) {
        console.log(`\n📊 STAGE UPGRADE: Stage ${botState.settings.growthStage} → Stage ${newStage}`);
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
    
    // Update target profit based on growth stage
    CONFIG.targetMultiplier = 16.67 * (1 + (newStage - 1) * 0.5);
    
    return newStrategy;
}

// ============ KELLY CRITERION WITH DYNAMIC RISK ============
function calculateAdaptiveKelly(balance, winProbability, payoutMultiplier, riskLevel) {
    const b = payoutMultiplier - 1;
    const p = winProbability;
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Apply risk level (higher risk = higher fraction)
    kellyFraction = kellyFraction * riskLevel;
    
    // Cap based on growth stage
    const maxFraction = CONFIG.maxBetPercent;
    kellyFraction = Math.max(0, Math.min(maxFraction, kellyFraction));
    
    let kellyBet = balance * kellyFraction;
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(CONFIG.minBet, kellyBet);
}

// ============ ANTI-MARTINGALE (Increase on wins) ============
function calculateAntiMartingale(currentBet, winStreak, baseBet, maxBet) {
    // Progressive increase on wins: 1x, 2x, 3x, 5x, 8x
    if (winStreak === 0) return baseBet;
    if (winStreak === 1) return baseBet * 2;
    if (winStreak === 2) return baseBet * 3;
    if (winStreak === 3) return baseBet * 5;
    if (winStreak >= 4) return baseBet * 8;
    return baseBet;
}

// ============ D'ALEMBERT SYSTEM (For balance optimization) ============
function calculateDAlenbert(currentBet, isWin, baseBet, maxBet) {
    if (isWin) {
        // Decrease by 1 unit on win
        return Math.max(baseBet, currentBet - CONFIG.minBet);
    } else {
        // Increase by 1 unit on loss
        return Math.min(maxBet, currentBet + CONFIG.minBet);
    }
}

// ============ SMART BET CALCULATOR (Adapts to balance) ============
function calculateAdaptiveBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    let newBet;
    const growthStage = botState.settings.growthStage;
    
    // Stage 1: Maximum aggression for micro balance
    if (growthStage === 1) {
        if (CONFIG.useAntiMartingale && winStreak > 0) {
            newBet = calculateAntiMartingale(currentBet, winStreak, baseBet, currentBalance * CONFIG.maxBetPercent);
        } else if (CONFIG.useKelly) {
            const winProb = 1 / CONFIG.payout;
            newBet = calculateAdaptiveKelly(currentBalance, winProb, CONFIG.payout, botState.settings.riskLevel);
        } else {
            // Aggressive Martingale for micro stage
            const multiplier = Math.min(8, Math.pow(2, lossStreak));
            newBet = baseBet * multiplier;
        }
    }
    // Stage 2: Balanced approach
    else if (growthStage === 2) {
        if (winStreak > 0 && winStreak % 2 === 0) {
            // Increase on even win streaks
            newBet = currentBet * 1.5;
        } else if (lossStreak > 2) {
            // Moderate increase on losses
            newBet = baseBet * Math.min(4, Math.pow(1.5, lossStreak));
        } else {
            newBet = baseBet;
        }
    }
    // Stage 3+: Conservative growth
    else {
        if (CONFIG.useDAlenbert) {
            newBet = calculateDAlenbert(currentBet, isWin, baseBet, currentBalance * CONFIG.maxBetPercent);
        } else {
            newBet = baseBet;
        }
    }
    
    // Apply absolute limits
    const minBet = CONFIG.minBet;
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    newBet = Math.max(minBet, Math.min(maxBet, newBet));
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ SMART PAYOUT CALCULATOR ============
function calculateSmartPayout(winStreak, lossStreak, currentBalance, growthStage) {
    let payout = CONFIG.payout;
    
    // Stage 1: Maximize payout for growth
    if (growthStage === 1) {
        if (winStreak === 0 && lossStreak === 0) payout = 4.0;
        else if (winStreak === 1) payout = 4.5;
        else if (winStreak === 2) payout = 5.0;
        else if (winStreak >= 3) payout = 6.0;
        else if (lossStreak >= 2) payout = 3.5;
    }
    // Stage 2: Balanced payout
    else if (growthStage === 2) {
        if (winStreak >= 2) payout = 3.5;
        else if (lossStreak >= 3) payout = 2.8;
        else payout = 3.0;
    }
    // Stage 3+: Conservative payout
    else {
        payout = Math.min(2.5, CONFIG.payout);
    }
    
    // Cap based on risk level
    payout = Math.min(6.0, Math.max(2.0, payout * botState.settings.riskLevel));
    
    return payout;
}

// ============ BALANCE TRACKING ============
function trackBalanceHistory() {
    botState.stats.balanceHistory.push({
        time: Date.now(),
        balance: botState.stats.currentBalance,
        profit: botState.stats.netProfit
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
        return Math.max(CONFIG.minBet, currentBalance * CONFIG.maxBetPercent);
    }
    if (betAmount < CONFIG.minBet) {
        return CONFIG.minBet;
    }
    return betAmount;
}

// ============ PROFIT TARGET MANAGEMENT ============
function checkProfitTarget() {
    const targetAmount = botState.stats.startingBalance * CONFIG.targetMultiplier;
    
    if (botState.stats.netProfit >= targetAmount - botState.stats.startingBalance) {
        const growth = (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(1);
        botState.statusMessage = `🏆 TARGET REACHED! ${growth}x growth! Increasing target...`;
        
        // Set new target
        botState.stats.startingBalance = botState.stats.currentBalance;
        CONFIG.targetMultiplier = CONFIG.targetMultiplier * 1.5;
        
        console.log(`\n🎉🎉🎉 MILESTONE ACHIEVED! 🎉🎉🎉`);
        console.log(`💰 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
        console.log(`📈 Growth: ${growth}x from start`);
        console.log(`🎯 New Target: ${(botState.stats.startingBalance * CONFIG.targetMultiplier).toFixed(8)} BTC\n`);
        
        return true;
    }
    return false;
}

function checkStopLoss() {
    const maxDrawdown = botState.stats.startingBalance * CONFIG.stopLossPercent;
    
    if (botState.stats.netProfit <= -maxDrawdown && botState.stats.totalBets > 10) {
        botState.statusMessage = `🔄 STOP LOSS: Adjusting strategy...`;
        
        // Reduce risk on stop loss
        botState.settings.riskLevel = Math.max(0.3, botState.settings.riskLevel * 0.8);
        CONFIG.baseBetPercent = Math.max(0.03, CONFIG.baseBetPercent * 0.9);
        
        console.log(`\n⚠️ STOP LOSS TRIGGERED`);
        console.log(`📉 Drawdown: ${(botState.stats.netProfit).toFixed(8)} BTC`);
        console.log(`🔄 Risk reduced to ${(botState.settings.riskLevel*100).toFixed(0)}%`);
        
        return false; // Don't stop, just adapt
    }
    return false;
}

// ============ API LOGIC ============
async function placeBet() {
    // Update strategy based on current balance
    const currentStrategy = updateStrategyByBalance();
    
    // Calculate optimal bet
    const optimalBet = calculateAdaptiveBet(
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
    const safeSeed = "adaptive" + Math.random().toString(36).substring(2, 15) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const betPercent = (payload.Bet / botState.stats.currentBalance * 100).toFixed(1);
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  📊 Stage ${botState.settings.growthStage}: ${currentStrategy}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${betPercent}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win)`);
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
            Stage: botState.settings.growthStage
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Adaptive simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Adaptive simulation active");
            
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

// ============ MAIN ADAPTIVE ENGINE ============
async function runStrategy() {
    console.log(`\n🧠🧠🧠 ADAPTIVE PROFIT ENGINE v8.0 - SELF-OPTIMIZING 🧠🧠🧠`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Target: ${(CONFIG.targetMultiplier*100).toFixed(0)}% return (${(botState.stats.startingBalance * CONFIG.targetMultiplier).toFixed(8)} BTC)`);
    console.log(`📈 Strategy: ADAPTIVE - Auto-scales as balance grows`);
    console.log(`🔄 Stages: Micro (12-100) → Small (100-1000) → Growing (1000+) → Wealth (10000+)\n`);
    
    botState.statusMessage = `🧠 ADAPTIVE MODE | Stage 1: Micro Growth | Target: ${(CONFIG.targetMultiplier*100).toFixed(0)}% return`;
    
    while (botState.running) {
        // Check targets and adapt
        if (checkProfitTarget()) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
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
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;

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
            }
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
        }

        // Calculate next bet using adaptive strategy
        const previousBet = botState.settings.currentBet;
        const nextBet = calculateAdaptiveBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);

        // Add to history with stage info
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
            growth: (botState.stats.currentBalance / 0.00000012).toFixed(1)
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Dynamic status message
        const growth = (botState.stats.currentBalance / 0.00000012).toFixed(1);
        const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const stageName = botState.settings.growthStage === 1 ? "🚀 MICRO" : 
                          botState.settings.growthStage === 2 ? "💪 SMALL" :
                          botState.settings.growthStage === 3 ? "📈 GROWING" : "🛡️ WEALTH";
        
        botState.statusMessage = `${stageName} | ${result.Strategy} | ${growth}x growth | ROI: ${roi}% | Next: ${botState.settings.currentBet.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1000)); 
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
        riskLevel: botState.settings.riskLevel
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v8.0 | ADAPTIVE PROFIT ENGINE</title>
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
        .stage-1 { background: linear-gradient(135deg, #ef4444, #dc2626); }
        .stage-2 { background: linear-gradient(135deg, #f59e0b, #ea580c); }
        .stage-3 { background: linear-gradient(135deg, #10b981, #059669); }
        .stage-4 { background: linear-gradient(135deg, #3b82f6, #2563eb); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v8.0</span> 
                    <span class="strategy-badge" id="stage-badge">🧠 ADAPTIVE</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    📈 Growth: <strong id="growth-display">1.0x</strong> | 🎯 Auto-scales as balance grows
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
                    <div class="label">📈 TOTAL GROWTH</div>
                    <div id="growth-total" class="btc-val pulse">1.0x</div>
                    <div class="usd-val">From 12 satoshis</div>
                </div>
                <div class="card"><div class="label">💰 Current Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📊 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">🎯 ROI</div><div id="roi-display" class="btc-val">0%</div><div class="usd-val">Return on Investment</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Stage</div><div id="stage-display" style="font-weight:700; color:var(--accent)">1</div></div>
                <div class="mini-card"><div class="label">Base Bet %</div><div id="base-percent" style="font-weight:700; color:var(--primary)">10%</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Risk Level</div><div id="risk-level" style="font-weight:700">100%</div></div>
            </div>
            <div class="label">🚀 Growth Projections</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Next Stage At</div><span id="next-stage">100 sat</span><br><span class="usd-val">Stage 2</span></div>
                <div class="proj-card"><div class="label">Target Balance</div><span id="target-bal">0.00000200</span><br><span class="usd-val">1667% return</span></div>
                <div class="proj-card"><div class="label">Est. Bets to Target</div><span id="est-bets">~50</span><br><span class="usd-val">With 50% win rate</span></div>
                <div class="proj-card"><div class="label">Current Strategy</div><span id="current-strategy">ULTRA AGGRESSIVE</span><br><span class="usd-val">Auto-optimizing</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Stage</th>
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
                        <tr><td colspan="9" style="text-align:center;">🧠 Adaptive engine initializing... 🧠</td></tr>
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
                const { botState, btcPrice, hoursPassed, growth, stage, strategy, riskLevel } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
                document.getElementById('growth-total').innerHTML = growth + 'x';
                document.getElementById('growth-display').innerHTML = growth + 'x';
                document.getElementById('roi-display').innerHTML = roi + '%';
                document.getElementById('stage-display').innerHTML = stage;
                document.getElementById('risk-level').innerHTML = (riskLevel * 100).toFixed(0) + '%';
                document.getElementById('current-strategy').innerHTML = strategy;
                document.getElementById('target-bal').innerHTML = f(botState.stats.startingBalance * 16.67);
                
                const stageNames = ['', '🚀 MICRO', '💪 SMALL', '📈 GROWING', '🛡️ WEALTH'];
                document.getElementById('stage-badge').innerHTML = stageNames[stage] || 'ADAPTIVE';
                document.getElementById('stage-badge').className = 'strategy-badge stage-' + stage;
                
                if (stage === 1) document.getElementById('next-stage').innerHTML = '100 sat';
                else if (stage === 2) document.getElementById('next-stage').innerHTML = '1000 sat';
                else if (stage === 3) document.getElementById('next-stage').innerHTML = '10000 sat';
                else document.getElementById('next-stage').innerHTML = '∞';
                
                document.getElementById('status-msg').innerHTML = "🧠 " + botState.statusMessage;
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
                        
                        const stageIcon = b.stage === 1 ? '🚀' : b.stage === 2 ? '💪' : b.stage === 3 ? '📈' : '🛡️';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + stageIcon + ' ' + b.stage + '</td>' +
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
    console.log(`🧠🧠🧠 ADAPTIVE PROFIT ENGINE v8.0 ONLINE 🧠🧠🧠`);
    console.log(`📊 Open http://localhost:${port} to watch your balance grow`);
    runStrategy();
});
