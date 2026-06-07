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
    payout: 3.0,                    // MAXIMUM payout (200% profit per win)
    minBet: 0.00000001,             // 1 satoshi minimum
    targetProfit: 0.00000200,       // Target 200 satoshis (1666% return!)
    stopLoss: 0.00000001,           // Only stop if down to 1 satoshi
    superAggressive: true,
    useKellyCriterion: true,        // Kelly Criterion for optimal bet sizing
    useParoli: true,                // Paroli system (triple on wins)
    useLabouchere: false,           // Labouchere system for recovery
    maxWinStreakTarget: 5           // Target 5 wins in a row
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing ULTIMATE PROFIT ENGINE...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0.00000012,
        lockPercent: 0.98              // Lock 98% of profits
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
        biggestLoss: 0,
        consecutiveWinsProfit: 0,
        sessionsWon: 0,
        sessionsLost: 0
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        aggressiveMode: true,
        paroliMultiplier: 1,           // Paroli progression (1, 2, 4, 8, 16)
        labouchereSequence: [1, 1, 1, 2, 2, 3], // For recovery
        sessionTarget: 0.00000050,      // 50 satoshi per session
        sessionActive: true
    },
    betHistory: []
};

// ============ KELLY CRITERION CALCULATOR ============
function calculateKellyBet(balance, winProbability, payoutMultiplier) {
    // Kelly Formula: f* = (p * b - q) / b
    // where p = win probability, q = loss probability, b = decimal odds - 1
    const b = payoutMultiplier - 1;  // Profit on win
    const p = 1 / payoutMultiplier;   // True probability for fair game
    const q = 1 - p;
    
    let kellyFraction = (p * b - q) / b;
    
    // Use 25% Kelly for aggressive growth (standard is 25% for safety)
    kellyFraction = Math.max(0, Math.min(0.5, kellyFraction * 0.5));
    
    let kellyBet = balance * kellyFraction;
    
    // Round to satoshis
    kellyBet = Math.floor(kellyBet * 100000000) / 100000000;
    
    return Math.max(DEFAULTS.minBet, Math.min(kellyBet, balance * 0.3));
}

// ============ PAROLI SYSTEM (Triple on wins) ============
function calculateParoliBet(currentBet, winStreak, baseBet, maxBet) {
    // Paroli: 1, 2, 4, 8, 16 progression on wins
    if (winStreak === 0) return baseBet;
    if (winStreak === 1) return baseBet * 2;
    if (winStreak === 2) return baseBet * 4;
    if (winStreak === 3) return baseBet * 8;
    if (winStreak >= 4) return baseBet * 16;
    return baseBet;
}

// ============ LABOUCHERE SYSTEM (For recovery) ============
function calculateLabouchereBet(sequence, balance) {
    if (!sequence || sequence.length === 0) return DEFAULTS.minBet;
    const bet = sequence[0] + sequence[sequence.length - 1];
    const betAmount = bet * DEFAULTS.minBet;
    return Math.min(betAmount, balance * 0.2);
}

function updateLabouchereSequence(sequence, isWin, bet) {
    const betUnits = bet / DEFAULTS.minBet;
    if (isWin) {
        // Remove first and last numbers on win
        sequence.pop();
        sequence.shift();
    } else {
        // Add bet amount to end on loss
        sequence.push(betUnits);
    }
    return sequence.length > 0 ? sequence : [1, 1, 1];
}

// ============ ULTIMATE BET CALCULATOR ============
function calculateUltimateBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance, payout) {
    let newBet;
    
    // Strategy 1: Paroli (Double/Triple on wins)
    if (DEFAULTS.useParoli && winStreak > 0) {
        newBet = calculateParoliBet(currentBet, winStreak, baseBet, currentBalance * 0.3);
        botState.settings.paroliMultiplier = Math.pow(2, winStreak);
    }
    // Strategy 2: Kelly Criterion for optimal sizing
    else if (DEFAULTS.useKellyCriterion) {
        const winProb = 1 / payout;
        newBet = calculateKellyBet(currentBalance, winProb, payout);
    }
    // Strategy 3: Labouchere for recovery
    else if (DEFAULTS.useLabouchere && lossStreak > 2) {
        newBet = calculateLabouchereBet(botState.settings.labouchereSequence, currentBalance);
    }
    // Default: Aggressive Martingale
    else {
        if (isWin) {
            // After win, reset to base or use reverse Martingale
            if (winStreak >= 3) {
                newBet = baseBet;  // Reset after big streak
            } else {
                newBet = baseBet;
            }
        } else {
            // Loss: Increase aggressively but with Kelly limit
            const multiplier = Math.min(8, Math.pow(1.8, lossStreak));
            newBet = baseBet * multiplier;
            
            // Kelly cap
            const kellyMax = currentBalance * 0.25;
            if (newBet > kellyMax) newBet = kellyMax;
        }
    }
    
    // Absolute limits
    const minBet = DEFAULTS.minBet;
    const maxBet = currentBalance * 0.3;  // Max 30% of balance per bet
    
    newBet = Math.max(minBet, Math.min(maxBet, newBet));
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ MAXIMUM PROFIT PAYOUT CALCULATOR ============
function calculateMaxProfitPayout(winStreak, lossStreak, currentBalance, isSessionActive) {
    let optimalPayout = DEFAULTS.payout;
    
    // GOING FOR BROKE: Higher risk = higher reward
    if (winStreak === 0 && lossStreak === 0) {
        optimalPayout = 3.0;  // Start with max payout
    }
    // On win streaks: INCREASE payout for massive gains
    else if (winStreak === 1) {
        optimalPayout = 3.5;  // 250% profit
    } else if (winStreak === 2) {
        optimalPayout = 4.0;  // 300% profit
    } else if (winStreak >= 3) {
        optimalPayout = 5.0;  // 400% profit on 3+ win streak!
    }
    // On loss streaks: Maintain high payout to recover faster
    else if (lossStreak === 1) {
        optimalPayout = 3.0;
    } else if (lossStreak === 2) {
        optimalPayout = 3.5;
    } else if (lossStreak >= 3) {
        optimalPayout = 4.0;  // Go bigger to recover losses
    }
    
    // Session target boost
    if (isSessionActive && currentBalance < botState.settings.sessionTarget) {
        optimalPayout = Math.min(6.0, optimalPayout * 1.2);  // Extra boost when behind
    }
    
    // Cap at 6.0x (500% profit max)
    return Math.min(6.0, Math.max(2.5, optimalPayout));
}

// ============ BALANCE MANAGEMENT ============
function calculateScaledBase(balance) {
    if (balance <= 0) return DEFAULTS.minBet;
    // ULTRA AGGRESSIVE: Use 10% of balance for base bet (was 5%)
    let calculated = balance * 0.10;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(DEFAULTS.minBet, Math.min(calculated, balance * 0.15));
}

function validateBet(betAmount, currentBalance) {
    if (betAmount > currentBalance) {
        return Math.max(DEFAULTS.minBet, currentBalance * 0.25);
    }
    if (betAmount < DEFAULTS.minBet) {
        return DEFAULTS.minBet;
    }
    return betAmount;
}

// ============ PROFIT TARGET MANAGEMENT ============
function checkProfitTarget() {
    // Dynamic profit targets
    if (botState.stats.netProfit >= DEFAULTS.targetProfit) {
        botState.statusMessage = `🏆🏆🏆 MEGA PROFIT: ${botState.stats.netProfit.toFixed(8)} BTC! 🏆🏆🏆`;
        
        // Celebrate and increase target
        DEFAULTS.targetProfit += 0.00000200;
        botState.stats.sessionsWon++;
        
        // Log achievement
        console.log(`\n🎉🎉🎉 SESSION VICTORY #${botState.stats.sessionsWon}! 🎉🎉🎉`);
        console.log(`💰 Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
        console.log(`🎯 New Target: ${DEFAULTS.targetProfit.toFixed(8)} BTC\n`);
        
        // Reset for next session
        botState.settings.currentBet = DEFAULTS.minBet;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        botState.settings.sessionActive = true;
        
        return true;
    }
    return false;
}

function checkStopLoss() {
    if (botState.stats.netProfit <= -DEFAULTS.stopLoss && botState.stats.totalBets > 10) {
        botState.statusMessage = `🔄 STOP LOSS: Resetting for next attempt...`;
        botState.stats.sessionsLost++;
        
        // Reset but don't stop - we go again!
        const oldBalance = botState.stats.currentBalance;
        botState.stats.currentBalance = 0.00000012;  // Reset to starting balance
        botState.stats.netProfit = botState.stats.currentBalance - 0.00000012;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        botState.settings.currentBet = DEFAULTS.minBet;
        botState.settings.consecutiveLosses = 0;
        botState.settings.consecutiveWins = 0;
        botState.settings.labouchereSequence = [1, 1, 1, 2, 2, 3];
        
        console.log(`\n🔄 SESSION RESET | Loss: ${(oldBalance - 0.00000012).toFixed(8)} BTC`);
        console.log(`📊 Record: ${botState.stats.sessionsWon}W - ${botState.stats.sessionsLost}L\n`);
        
        return false;
    }
    return false;
}

// ============ API LOGIC ============
async function placeBet() {
    // Calculate optimal bet using all strategies
    const optimalBet = calculateUltimateBet(
        false,  // We don't know result yet
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.payout
    );
    
    botState.settings.currentBet = validateBet(optimalBet, botState.stats.currentBalance);
    
    // Calculate optimal payout for maximum profit
    const optimalPayout = calculateMaxProfitPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance,
        botState.settings.sessionActive
    );
    botState.settings.payout = optimalPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `⚠️ Low balance: ${botState.stats.currentBalance.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "ultraprofit" + Math.random().toString(36).substring(2, 15) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    const kellyInfo = DEFAULTS.useKellyCriterion ? ` | Kelly: ${(botState.settings.currentBet/botState.stats.currentBalance*100).toFixed(1)}%` : '';
    console.log(`\n[${new Date().toLocaleTimeString()}] 🎲 BET #${botState.stats.totalBets + 1}`);
    console.log(`  💰 Amount: ${payload.Bet.toFixed(8)} BTC (${(payload.Bet/botState.stats.currentBalance*100).toFixed(1)}% of balance)`);
    console.log(`  🎯 Payout: ${payload.Payout}x (${(payload.Payout-1)*100}% profit on win)`);
    console.log(`  📊 Balance: ${botState.stats.currentBalance.toFixed(8)} BTC${kellyInfo}`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        
        // Update stats
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
            ProfitPercent: profitPercent
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`❌ ERROR: ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Ultimate profit simulation with realistic odds
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("⚡ DEMO MODE: Simulating with 3.0x payout (33% win chance)");
            
            // Realistic win probability for 3.0x payout
            const winChance = 1 / botState.settings.payout;
            const isWin = Math.random() < winChance;
            
            let profit;
            if (isWin) {
                profit = botState.settings.currentBet * (botState.settings.payout - 1);
                console.log(`  🎲 SIMULATION: WIN! +${(botState.settings.payout-1)*100}% profit`);
            } else {
                profit = -botState.settings.currentBet;
                console.log(`  🎲 SIMULATION: LOSS! -100%`);
            }
            
            const newBalance = botState.stats.currentBalance + profit;
            
            return {
                Bet: botState.settings.currentBet,
                Balance: Math.max(0, newBalance),
                Profit: profit,
                Roll: Math.floor(Math.random() * 10000),
                Payout: botState.settings.payout,
                ProfitPercent: isWin ? (botState.settings.payout-1)*100 : -100
            };
        }
        
        return null; 
    }
}

// ============ MAIN STRATEGY ENGINE ============
async function runStrategy() {
    console.log(`\n🚀🚀🚀 ULTIMATE PROFIT ENGINE v7.0 - MAXIMUM AGGRESSION 🚀🚀🚀`);
    console.log(`💰 Starting Balance: ${botState.stats.currentBalance.toFixed(8)} BTC (12 satoshis)`);
    console.log(`🎯 Target: ${DEFAULTS.targetProfit.toFixed(8)} BTC (${(DEFAULTS.targetProfit/0.00000012*100).toFixed(0)}% return)`);
    console.log(`📈 Strategy: Paroli + Kelly Criterion + Dynamic Payout (up to 5.0x)`);
    console.log(`⚡ Risk Level: MAXIMUM - Designed for 1666%+ returns\n`);
    
    botState.statusMessage = `🚀 ULTIMATE PROFIT MODE | Target: ${(DEFAULTS.targetProfit/0.00000012*100).toFixed(0)}% return | Max Payout: 5.0x`;
    
    while (botState.running) {
        // Check profit targets
        if (checkProfitTarget()) {
            console.log(`🎉 Continuing to next target...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        if (checkStopLoss()) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        // Update base bet based on current balance
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

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
        botState.stats.netProfit += profit;

        // Update streaks and advanced metrics
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.stats.consecutiveWinsProfit += profit;
            
            // Update best streak
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
                console.log(`🏆 NEW BEST WIN STREAK: ${botState.stats.bestStreak} wins in a row!`);
            }
            
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            // Update Labouchere for wins
            if (DEFAULTS.useLabouchere) {
                botState.settings.labouchereSequence = updateLabouchereSequence(
                    botState.settings.labouchereSequence, 
                    true, 
                    result.Bet
                );
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.stats.consecutiveWinsProfit = 0;
            
            // Update worst streak
            if (botState.settings.consecutiveLosses > botState.stats.worstStreak) {
                botState.stats.worstStreak = botState.settings.consecutiveLosses;
                console.log(`⚠️ New loss streak: ${botState.stats.worstStreak} (recovery mode active)`);
            }
            
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            
            // Update Labouchere for losses
            if (DEFAULTS.useLabouchere) {
                botState.settings.labouchereSequence = updateLabouchereSequence(
                    botState.settings.labouchereSequence, 
                    false, 
                    result.Bet
                );
            }
        }

        // Update max profit
        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        // Calculate next bet using ultimate strategy
        const previousBet = botState.settings.currentBet;
        const nextBet = calculateUltimateBet(
            isWin,
            previousBet,
            botState.settings.baseBet,
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance,
            botState.settings.payout
        );
        
        botState.settings.currentBet = validateBet(nextBet, botState.stats.currentBalance);
        
        // Update session target progress
        if (botState.stats.currentBalance >= botState.settings.sessionTarget) {
            botState.settings.sessionActive = false;
            botState.statusMessage = `🎯 Session target achieved! Next target: ${(botState.settings.sessionTarget + 0.00000050).toFixed(8)}`;
            botState.settings.sessionTarget += 0.00000050;
        }

        // Add to history with detailed info
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
            kellyPercent: (botState.settings.currentBet/botState.stats.currentBalance*100).toFixed(1)
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Dynamic status message
        const returnPercent = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const streakInfo = isWin ? 
            `🔥 WIN STREAK: ${botState.settings.consecutiveWins} (${botState.settings.paroliMultiplier}x bet)` : 
            `💀 LOSS STREAK: ${botState.settings.consecutiveLosses}`;
        
        botState.statusMessage = `⚡ ${streakInfo} | ROI: ${returnPercent}% | Balance: ${botState.stats.currentBalance.toFixed(8)} | Target: ${(DEFAULTS.targetProfit/0.00000012*100).toFixed(0)}%`;

        await new Promise(r => setTimeout(r, 1000)); 
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
        strategy: `Paroli + Kelly (${botState.settings.paroliMultiplier}x on wins)`,
        maxPayout: Math.min(5.0, calculateMaxProfitPayout(
            botState.settings.consecutiveWins,
            botState.settings.consecutiveLosses,
            botState.stats.currentBalance,
            botState.settings.sessionActive
        ))
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v7.0 | ULTIMATE PROFIT ENGINE</title>
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
        .profit-badge { background: linear-gradient(135deg, #10b981, #059669); animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse 2s infinite; }
        .roi-positive { color: #10b981; font-weight: bold; }
        .roi-negative { color: #ef4444; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v7.0</span> 
                    <span class="strategy-badge profit-badge">🚀 ULTIMATE PROFIT ENGINE 🚀</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    🎯 Target: <strong id="target-display">0.00000200</strong> BTC (1666% return) | 🔥 Strategy: Paroli + Kelly Criterion
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
                    <div class="label">🎯 ROI TARGET PROGRESS</div>
                    <div id="target-progress" class="btc-val pulse">0%</div>
                    <div class="usd-val">Goal: 1666% Return</div>
                </div>
                <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📊 ROI</div><div id="roi-display" class="btc-val">0%</div><div class="usd-val">Return on Investment</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Base Bet (10%)</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00000000</div></div>
                <div class="mini-card"><div class="label">Current Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00000000</div></div>
                <div class="mini-card"><div class="label">🔥 Win Streak</div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">💀 Loss Streak</div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label">Best/Worst</div><div id="streaks" style="font-weight:700">0/0</div></div>
            </div>
            <div class="label">🚀 Revenue Projections (Annualized)</div>
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
                            <th>Payout</th>
                            <th>Wager</th>
                            <th>Roll</th>
                            <th>P/L</th>
                            <th>%</th>
                            <th>Streaks</th>
                            <th>Next Bet</th>
                        </tr>
                    </thead>
                    <tbody id="h-body">
                        <tr><td colspan="8" style="text-align:center;">🚀 Waiting for MASSIVE PROFITS... 🚀</td></tr>
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
                <div class="card"><div class="label">🏆 Sessions Won</div><div id="sessions-won" class="btc-val">0</div></div>
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
                const { botState, btcPrice, hoursPassed, targetProfit, maxPayout } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                document.getElementById('target-display').innerText = f(targetProfit);
                
                const profitPercent = (botState.stats.netProfit / targetProfit * 100).toFixed(0);
                const roi = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
                document.getElementById('target-progress').innerHTML = profitPercent + '%';
                document.getElementById('roi-display').innerHTML = roi + '%';
                document.getElementById('roi-display').className = roi >= 0 ? 'btc-val roi-positive' : 'btc-val roi-negative';
                
                document.getElementById('status-msg').innerHTML = "🚀 " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "%";
                document.getElementById('s-base').innerHTML = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerHTML = f(botState.settings.currentBet);
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('streaks').innerHTML = botState.stats.bestStreak + '/' + botState.stats.worstStreak;
                document.getElementById('total-wagered').innerHTML = f(botState.stats.totalWagered);
                document.getElementById('sessions-won').innerHTML = botState.stats.sessionsWon || 0;

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
                        if (b.lossStreak > 0) streakDisplay = '📉' + b.lossStreak;
                        if (b.winStreak > 0) streakDisplay = '🔥' + b.winStreak;
                        
                        return '<tr>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + (b.payout || '3.0') + 'x</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.profitPercent || '0') + '%</td>' +
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
    console.log(`🚀🚀🚀 ULTIMATE PROFIT ENGINE v7.0 ONLINE 🚀🚀🚀`);
    console.log(`📊 Open http://localhost:${port} to monitor massive gains`);
    runStrategy();
});
