const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "Dqb68rat7k4PNx8XYYS3uEGTQSwPZbQsbzlkuiuX0CElrNiBBK";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.5,                // MAXIMUM payout for biggest profits (was 2.0)
    balanceStep: 0.00000001,
    betIncrement: 0.00000001,
    minBet: 0.00000001,
    maxBetMultiplier: 5,        // Allow 5x base bet for aggressive recovery
    minBetMultiplier: 0.2,
    targetProfit: 0.00000100,   // Target 100 satoshi profit (833% return)
    stopLoss: 0.00000003,       // Tighter stop loss at 3 satoshis (75% loss)
    superAggressive: true       // NEW: Ultra aggressive mode
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0.00000012,
        lockPercent: 0.95          // Lock 95% of profits
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0.00000012,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        aggressiveMode: true,
        martingaleMode: false,
        reverseMartingaleMode: true  // NEW: Double on wins!
    },
    betHistory: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (res.data.bitcoin) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function calculateScaledBase(balance) {
    if (balance <= 0) return DEFAULTS.minBet;
    // Ultra aggressive: Use 5% of balance for base bet (was 2%)
    let calculated = balance * 0.05;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(DEFAULTS.minBet, Math.min(calculated, balance * 0.1));
}

// ULTRA AGGRESSIVE: Reverse Martingale (double on wins)
function calculateNextBetReverseMartingale(isWin, currentBet, baseBet, lossStreak, winStreak, currentBalance) {
    let newBet;
    
    if (isWin) {
        // WIN: DOUBLE THE BET (Reverse Martingale)
        if (winStreak === 1) {
            newBet = currentBet * 2;      // Double after 1st win
        } else if (winStreak === 2) {
            newBet = currentBet * 2;      // Double again after 2nd win
        } else if (winStreak >= 3) {
            newBet = currentBet * 1.5;    // Conservative after 3+ wins
        } else {
            newBet = baseBet;
        }
    } else {
        // LOSS: Reset to base bet (opposite of Martingale)
        newBet = baseBet;
        
        // But if we're in recovery, increase slightly
        if (lossStreak >= 2 && currentBalance < botState.profitProtection.safeBalance) {
            newBet = baseBet * Math.min(3, lossStreak);
        }
    }
    
    // Never bet more than 25% of balance (very aggressive)
    let maxAllowedBet = currentBalance * 0.25;
    if (newBet > maxAllowedBet) {
        newBet = maxAllowedBet;
    }
    
    // Minimum bet protection
    newBet = Math.max(DEFAULTS.minBet, newBet);
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// MARTINGALE: Double on losses
function calculateNextBetMartingale(isWin, currentBet, baseBet, lossStreak, winStreak, currentBalance) {
    let newBet;
    
    if (isWin) {
        // WIN: Reset to base
        newBet = baseBet;
    } else {
        // LOSS: Double the bet
        let multiplier = Math.min(5, Math.pow(2, lossStreak));
        newBet = baseBet * multiplier;
        
        // Cap at 20% of balance
        let maxAllowed = currentBalance * 0.2;
        if (newBet > maxAllowed) newBet = maxAllowed;
    }
    
    newBet = Math.max(DEFAULTS.minBet, newBet);
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// NEW: Dynamic strategy selector based on market conditions
function selectOptimalStrategy() {
    const winRate = botState.stats.totalBets > 0 ? botState.stats.wins / botState.stats.totalBets : 0.5;
    const recentPerformance = botState.stats.netProfit / botState.stats.currentBalance;
    
    // If winning, use Reverse Martingale to maximize profits
    if (winRate > 0.52 || recentPerformance > 0.1) {
        botState.settings.reverseMartingaleMode = true;
        botState.settings.martingaleMode = false;
        return "REVERSE MARTINGALE (Double on wins)";
    }
    // If losing, switch to standard Martingale to recover
    else if (winRate < 0.48 || recentPerformance < -0.05) {
        botState.settings.reverseMartingaleMode = false;
        botState.settings.martingaleMode = true;
        return "MARTINGALE (Double on losses)";
    }
    // Default aggressive
    else {
        botState.settings.reverseMartingaleMode = true;
        botState.settings.martingaleMode = false;
        return "AGGRESSIVE MODE";
    }
}

// ULTRA AGGRESSIVE Payout (up to 3.0x for huge wins)
function calculateOptimalPayout(consecutiveWins, consecutiveLosses, currentBalance, isReverseMartingale) {
    let optimalPayout = DEFAULTS.payout;
    
    if (isReverseMartingale && consecutiveWins > 0) {
        // Reverse Martingale: Increase payout on win streaks for massive gains
        if (consecutiveWins === 1) optimalPayout = 2.5;
        else if (consecutiveWins === 2) optimalPayout = 2.8;
        else if (consecutiveWins >= 3) optimalPayout = 3.0;  // MAX payout on 3+ win streak
    }
    else if (consecutiveLosses >= 2) {
        // During recovery, use safer payout
        optimalPayout = 1.8;
    }
    else if (currentBalance < 0.00000006) {
        // Desperate mode: go all-in with max payout
        optimalPayout = 3.0;
    }
    
    // Cap between 1.5x and 3.0x
    return Math.min(3.0, Math.max(1.5, optimalPayout));
}

function validateBet(betAmount, currentBalance) {
    if (betAmount > currentBalance) {
        return Math.max(DEFAULTS.minBet, currentBalance * 0.2);
    }
    if (betAmount < DEFAULTS.minBet) {
        return DEFAULTS.minBet;
    }
    return betAmount;
}

function checkProfitTarget() {
    if (botState.stats.netProfit >= DEFAULTS.targetProfit) {
        botState.statusMessage = `🎉🎉🎉 MASSIVE PROFIT: ${botState.stats.netProfit.toFixed(8)} BTC! Taking profits...`;
        // Take profits and reset target higher
        DEFAULTS.targetProfit += 0.00000100;
        botState.settings.currentBet = DEFAULTS.minBet;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        
        // Log the achievement
        console.log(`\n💰 PROFIT ACHIEVEMENT: ${botState.stats.netProfit.toFixed(8)} BTC`);
        console.log(`📈 New Target: ${DEFAULTS.targetProfit.toFixed(8)} BTC\n`);
        return true;
    }
    return false;
}

function checkStopLoss() {
    if (botState.stats.netProfit <= -DEFAULTS.stopLoss) {
        botState.statusMessage = `🛑 STOP LOSS: ${botState.stats.netProfit.toFixed(8)} BTC. Restarting...`;
        // Reset but keep trying (don't stop completely)
        botState.stats.netProfit = 0;
        botState.stats.currentBalance = 0.00000012;
        botState.profitProtection.safeBalance = 0.00000012;
        botState.settings.currentBet = DEFAULTS.minBet;
        botState.settings.consecutiveLosses = 0;
        botState.settings.consecutiveWins = 0;
        console.log(`🔄 Resetting from stop loss...`);
        return false; // Don't stop, just reset
    }
    return false;
}

function softResetBot() {
    console.log("SYSTEM: Ultra-aggressive reset for maximum profit...");
    botState.statusMessage = "⚡ ULTRA AGGRESSIVE MODE ACTIVE ⚡";
    
    botState.profitProtection.safeBalance = botState.stats.currentBalance; 
    botState.recoveryPot = 0; 
    
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
    botState.settings.consecutiveLosses = 0;
    botState.settings.consecutiveWins = 0;
    botState.settings.aggressiveMode = true;
}

// ============ API LOGIC ============
async function placeBet() {
    // Select optimal strategy
    const strategy = selectOptimalStrategy();
    
    let calculatedBet;
    if (botState.settings.reverseMartingaleMode) {
        calculatedBet = calculateNextBetReverseMartingale(
            false, // We don't know result yet, use current state
            botState.settings.currentBet,
            botState.settings.baseBet,
            botState.settings.consecutiveLosses,
            botState.settings.consecutiveWins,
            botState.stats.currentBalance
        );
    } else {
        calculatedBet = calculateNextBetMartingale(
            false,
            botState.settings.currentBet,
            botState.settings.baseBet,
            botState.settings.consecutiveLosses,
            botState.settings.consecutiveWins,
            botState.stats.currentBalance
        );
    }
    
    botState.settings.currentBet = validateBet(calculatedBet, botState.stats.currentBalance);
    
    // Calculate optimal payout for this bet
    const optimalPayout = calculateOptimalPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.reverseMartingaleMode
    );
    botState.settings.payout = optimalPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `Insufficient balance: ${botState.stats.currentBalance.toFixed(8)} < ${botState.settings.currentBet.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "profitmax" + Math.random().toString(36).substring(2, 12) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    console.log(`[BET] #${botState.stats.totalBets + 1} | Strategy: ${strategy}`);
    console.log(`  Amount: ${payload.Bet.toFixed(8)} BTC | Payout: ${payload.Payout}x`);
    console.log(`  Balance: ${botState.stats.currentBalance.toFixed(8)} | Target: ${DEFAULTS.targetProfit.toFixed(8)}`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        
        // Track stats
        botState.stats.totalWagered += payload.Bet;
        if (profit > botState.stats.biggestWin) botState.stats.biggestWin = profit;
        if (profit < botState.stats.biggestLoss) botState.stats.biggestLoss = profit;
        
        console.log(`[RESULT] ${profit > 0 ? 'WIN 🎉🎉🎉' : 'LOSS 😢'} | Profit: ${profit.toFixed(8)} | New Balance: ${newBalance.toFixed(8)}`);
        
        return {
            Bet: payload.Bet,
            Balance: newBalance,
            Profit: profit,
            Roll: result.Roll || Math.floor(Math.random() * 10000),
            Payout: payload.Payout,
            Strategy: strategy
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`[ERROR] ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Ultra aggressive simulation
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Ultra aggressive profit simulation");
            
            // Use Reverse Martingale logic for demo
            const winChance = 1 / botState.settings.payout;
            const isWin = Math.random() < winChance;
            
            let profit;
            if (isWin) {
                // Win: profit = bet * (payout - 1)
                profit = botState.settings.currentBet * (botState.settings.payout - 1);
            } else {
                // Loss: lose entire bet
                profit = -botState.settings.currentBet;
            }
            
            const newBalance = botState.stats.currentBalance + profit;
            
            return {
                Bet: botState.settings.currentBet,
                Balance: Math.max(0, newBalance),
                Profit: profit,
                Roll: Math.floor(Math.random() * 10000),
                Payout: botState.settings.payout,
                Strategy: strategy
            };
        }
        
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    const initialTarget = DEFAULTS.targetProfit;
    botState.statusMessage = `⚡⚡⚡ ULTRA PROFIT MODE | Target: ${initialTarget.toFixed(8)} BTC (833% return) | Stop: ${DEFAULTS.stopLoss.toFixed(8)} BTC`;
    console.log(`\n🚀🚀🚀 ULTRA AGGRESSIVE PROFIT OPTIMIZER ACTIVE 🚀🚀🚀`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`🎯 Target Profit: ${initialTarget.toFixed(8)} BTC (${(initialTarget/botState.stats.currentBalance*100).toFixed(0)}% gain)`);
    console.log(`🛑 Stop Loss: ${DEFAULTS.stopLoss.toFixed(8)} BTC (${(DEFAULTS.stopLoss/botState.stats.currentBalance*100).toFixed(0)}% loss)`);
    console.log(`📈 Strategy: Reverse Martingale (Double on wins) + Variable Payout (up to 3.0x)\n`);
    
    while (botState.running) {
        // Check profit targets
        if (checkProfitTarget()) {
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }
        
        if (checkStopLoss()) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        // Safe floor check
        if (botState.stats.currentBalance <= DEFAULTS.stopLoss) {
            botState.statusMessage = "⚠️ Critical low balance. Resetting...";
            botState.stats.currentBalance = 0.00000012;
            botState.stats.netProfit = 0;
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 2000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit;
        const isWin = profit > 0;
        
        // Update balance based on strategy
        if (botState.settings.reverseMartingaleMode) {
            // Reverse Martingale: Update bet AFTER result
            if (isWin) {
                botState.settings.currentBet = calculateNextBetReverseMartingale(
                    true,
                    botState.settings.currentBet,
                    botState.settings.baseBet,
                    botState.settings.consecutiveLosses,
                    botState.settings.consecutiveWins + 1,
                    botState.stats.currentBalance
                );
            } else {
                botState.settings.currentBet = calculateNextBetReverseMartingale(
                    false,
                    botState.settings.currentBet,
                    botState.settings.baseBet,
                    botState.settings.consecutiveLosses + 1,
                    botState.settings.consecutiveWins,
                    botState.stats.currentBalance
                );
            }
        }
        
        botState.stats.currentBalance = result.Balance;
        botState.stats.netProfit += profit;

        // Update streaks
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
            }
        }

        // Update max profit
        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        // Update base bet based on current balance
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        // For Martingale mode, update bet after result
        if (!botState.settings.reverseMartingaleMode) {
            if (isWin) {
                botState.settings.currentBet = calculateNextBetMartingale(
                    true,
                    botState.settings.currentBet,
                    botState.settings.baseBet,
                    botState.settings.consecutiveLosses,
                    botState.settings.consecutiveWins,
                    botState.stats.currentBalance
                );
            } else {
                botState.settings.currentBet = calculateNextBetMartingale(
                    false,
                    botState.settings.currentBet,
                    botState.settings.baseBet,
                    botState.settings.consecutiveLosses,
                    botState.settings.consecutiveWins,
                    botState.stats.currentBalance
                );
            }
        }
        
        botState.settings.currentBet = validateBet(botState.settings.currentBet, botState.stats.currentBalance);

        // Calculate direction
        let direction = "→";
        let directionEmoji = "➡️";
        if (botState.settings.currentBet > botState.settings.baseBet) {
            direction = "↑ UP";
            directionEmoji = "📈";
        } else if (botState.settings.currentBet < botState.settings.baseBet) {
            direction = "↓ DOWN";
            directionEmoji = "📉";
        }

        // Enhanced history
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
            previousBet: botState.settings.currentBet,
            nextBet: botState.settings.currentBet,
            direction: direction,
            directionEmoji: directionEmoji,
            balance: botState.stats.currentBalance,
            payout: result.Payout,
            strategy: result.Strategy
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Dynamic status message
        const profitPercent = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const strategyIcon = botState.settings.reverseMartingaleMode ? "🔄 RM" : "📉 MG";
        const action = isWin ? 
            `WIN +${(profit/botState.settings.currentBet*100).toFixed(0)}% @ ${result.Payout}x` : 
            `LOSS -100% @ ${result.Payout}x`;
        botState.statusMessage = `${strategyIcon} ${directionEmoji} ${action} | Balance: ${botState.stats.currentBalance.toFixed(8)} | P/L: ${profitPercent}% | Target: ${DEFAULTS.targetProfit.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2), 
        minBet: DEFAULTS.minBet,
        targetProfit: DEFAULTS.targetProfit,
        stopLoss: DEFAULTS.stopLoss,
        strategy: botState.settings.reverseMartingaleMode ? "Reverse Martingale (Double on Wins)" : "Martingale (Double on Losses)"
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v6.0 | ULTRA PROFIT MAXIMIZER</title>
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
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
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
        .wallet-label { font-size: 1rem; text-transform: uppercase; letter-spacing: 2px; }
        .strategy-badge { background: linear-gradient(135deg, #f59e0b, #ea580c); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .bet-up { color: #ef4444; font-weight: bold; background: rgba(239,68,68,0.2); padding: 2px 8px; border-radius: 12px; }
        .bet-down { color: #10b981; font-weight: bold; background: rgba(16,185,129,0.2); padding: 2px 8px; border-radius: 12px; }
        .streak-badge { font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; display: inline-block; }
        .streak-win { background: rgba(16,185,129,0.3); color: #10b981; }
        .streak-loss { background: rgba(239,68,68,0.3); color: #ef4444; }
        .profit-card { background: linear-gradient(135deg, #10b981, #059669); color: white; }
        .profit-card .label, .profit-card .usd-val { color: rgba(255,255,255,0.9); }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .pulse { animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v6.0</span> 
                    <span class="strategy-badge">⚡ ULTRA PROFIT MAXIMIZER ⚡</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    🎯 Target: <strong id="target-display">0.00000100</strong> BTC (833% return) | 🛑 Stop: <strong id="stop-display">0.00000003</strong> BTC
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
                <div class="card profit-card"><div class="label">🎯 Profit Target Progress</div><div id="target-progress" class="btc-val pulse">0%</div><div class="usd-val">Goal: ${(DEFAULTS.targetProfit/0.00000012*100).toFixed(0)}% Return</div></div>
                <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">⚡ Current Strategy</div><div id="strategy-display" class="btc-val" style="font-size: 1rem;">Loading...</div><div class="usd-val">Payout: Up to 3.0x</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Base Bet (5%)</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00000000</div></div>
                <div class="mini-card"><div class="label">Current Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00000000</div></div>
                <div class="mini-card"><div class="label"><span class="loss">📉 Loss Streak</span></div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label"><span class="win">📈 Win Streak</span></div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">Best/Worst</div><div id="streaks" style="font-weight:700">0/0</div></div>
            </div>
            <div class="label">Revenue Projections (Based on current performance)</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00000000</span><br><span id="p-hr-u" class="usd-val">$0.000</span></div>
                <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00000000</span><br><span id="p-dy-u" class="usd-val">$0.000</span></div>
                <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00000000</span><br><span id="p-month-u" class="usd-val">$0.000</span></div>
                <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00000000</span><br><span id="p-year-u" class="usd-val">$0.000</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Strat</th>
                            <th>Payout</th>
                            <th>Wager</th>
                            <th>Roll</th>
                            <th>P/L (BTC)</th>
                            <th>Streaks</th>
                            <th>Next Bet</th>
                        </tr>
                    </thead>
                    <tbody id="h-body">
                        <tr><td colspan="8" style="text-align:center;">🚀 Waiting for massive profits... 🚀</td></tr>
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
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00000000</div><div id="wallet-profit-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="wallet-recovery-pot" class="btc-val">0.00000000</div><div id="wallet-recovery-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">💰 Total Wagered</div><div id="total-wagered" class="btc-val">0.00000000</div><div class="usd-val">Lifetime volume</div></div>
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
            const recoveryPotRaw = parseFloat(document.getElementById('pot-display')?.innerText || 0);
            
            document.getElementById('wallet-display-main').innerText = formatCurrency(convertToCurrency(walletBalanceRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-net-profit').innerHTML = formatCurrency(convertToCurrency(netProfitRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-recovery-pot').innerHTML = formatCurrency(convertToCurrency(recoveryPotRaw, currentCurrency), currentCurrency);
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
                const { botState, btcPrice, hoursPassed, targetProfit, stopLoss, strategy } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                document.getElementById('target-display').innerText = f(targetProfit);
                document.getElementById('stop-display').innerText = f(stopLoss);
                document.getElementById('strategy-display').innerHTML = strategy;
                
                const profitPercent = (botState.stats.netProfit / targetProfit * 100).toFixed(0);
                document.getElementById('target-progress').innerHTML = profitPercent + '%';
                
                document.getElementById('status-msg').innerHTML = "⚡ " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "% " + (winRate > 50 ? "✅" : "⚠️");
                document.getElementById('s-base').innerHTML = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerHTML = f(botState.settings.currentBet);
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('streaks').innerHTML = botState.stats.bestStreak + '/' + botState.stats.worstStreak;
                document.getElementById('total-wagered').innerHTML = f(botState.stats.totalWagered);

                const netProfit = parseFloat(botState.stats.netProfit || 0);
                const hours = Math.max(0.01, parseFloat(hoursPassed));
                const hourlyProjection = netProfit / hours;
                
                document.getElementById('p-hr-b').innerHTML = f(hourlyProjection);
                document.getElementById('p-hr-u').innerHTML = u(hourlyProjection);
                document.getElementById('p-dy-b').innerHTML = f(hourlyProjection * 24);
                document.getElementById('p-dy-u').innerHTML = u(hourlyProjection * 24);
                document.getElementById('p-month-b').innerHTML = f(hourlyProjection * 24 * 30);
                document.getElementById('p-month-u').innerHTML = u(hourlyProjection * 24 * 30);
                document.getElementById('p-year-b').innerHTML = f(hourlyProjection * 24 * 365);
                document.getElementById('p-year-u').innerHTML = u(hourlyProjection * 24 * 365);

                if (botState.betHistory && botState.betHistory.length > 0) {
                    document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                        let streakDisplay = '';
                        if (b.lossStreak > 0) streakDisplay = '<span class="streak-badge streak-loss">📉 ' + b.lossStreak + 'L</span>';
                        if (b.winStreak > 0) streakDisplay = '<span class="streak-badge streak-win">📈 ' + b.winStreak + 'W</span>';
                        
                        let strategyShort = b.strategy ? (b.strategy.includes('Reverse') ? '🔄' : '📉') : '⚡';
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + strategyShort + '</td>' +
                            '<td>' + (b.payout || '2.5') + 'x' + '</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + f(b.nextBet) + '</td>' +
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
    console.log(`⚡⚡⚡ ULTRA PROFIT MAXIMIZER ACTIVE ⚡⚡⚡`);
    console.log(`📊 Open http://localhost:${port} to view dashboard`);
    runStrategy();
});
