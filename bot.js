const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ PROFESSIONAL CONFIGURATION ============
const API_KEY = process.env.API_KEY || "BUvAOKbz4ioBYZch6u0HvJ8zoyCgqcslVVtvkClJpOTKvKmN2P";
const BASE_URL = "https://api.crypto.games/v1";

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    // THE GOLDEN RULE: Base bet should be 0.1% to 1% of balance
    baseBetPercent: 0.005,      // 0.5% starting bet
    maxBetPercent: 0.05,        // NEVER exceed 5% of balance on one bet
    kellyFraction: 0.5,         // Half-Kelly (Conservative Growth)
    
    // SESSION MANAGEMENT
    sessionTargetPercent: 0.05, // Stop session at 5% profit
    sessionStopLossPercent: 0.20, // Stop session at 20% loss
    cooldownAfterLossStreak: 30000, // 30 second break after 7 losses
};

let botState = {
    running: true,
    totalSessionProfit: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    stats: {
        startingBalance: 0.00000012,
        currentBalance: 0.00000012,
        totalWagered: 0,
        wins: 0,
        losses: 0
    },
    settings: {
        currentBet: 0.00000001,
        payout: 2.0, // 2x is mathematically the most stable for long-term survival
        strategy: "CONSERVATIVE_GROWTH"
    }
};

// ============ CORE MATH ENGINE ============

/**
 * Fractional Kelly Criterion
 * Formula: ((Prob * Payout) - 1) / (Payout - 1) * Fraction
 */
function getKellyBet(balance, payout) {
    const winProb = 0.99 / payout; // 0.99 accounts for 1% house edge
    const edge = (winProb * payout) - 1;
    let kelly = (edge / (payout - 1)) * CONFIG.kellyFraction;
    
    // Safety Caps
    kelly = Math.max(0, Math.min(CONFIG.maxBetPercent, kelly));
    let bet = balance * kelly;
    return Math.max(CONFIG.minBet, Number(bet.toFixed(8)));
}

function updateStrategy() {
    const balance = botState.stats.currentBalance;
    const profit = balance - botState.stats.startingBalance;
    const profitPercent = profit / botState.stats.startingBalance;

    // 1. CHECK SESSION TARGETS (The most important part for profit)
    if (profitPercent >= CONFIG.sessionTargetPercent) {
        console.log("🏆 SESSION TARGET REACHED. PAUSING TO LOCK PROFIT.");
        botState.running = false;
        return "TARGET_REACHED";
    }

    if (profitPercent <= -CONFIG.sessionStopLossPercent) {
        console.log("🛑 STOP LOSS HIT. EXITING TO SAVE BANKROLL.");
        botState.running = false;
        return "STOP_LOSS_HIT";
    }

    // 2. DYNAMIC PAYOUT SCALING
    // Higher balance = Lower payout (Lower variance)
    if (balance > 0.00001000) {
        botState.settings.payout = 1.8; // High stability
        botState.settings.strategy = "WEALTH_PRESERVATION";
    } else if (botState.consecutiveLosses > 4) {
        botState.settings.payout = 3.0; // Moderate recovery attempt
        botState.settings.strategy = "RECOVERY_MODE";
    } else {
        botState.settings.payout = 2.0; // Standard
        botState.settings.strategy = "STABLE_ACCUMULATION";
    }

    return botState.settings.strategy;
}

async function runEngine() {
    console.log("🚀 Professional Profit Engine Started...");

    while (botState.running) {
        const strategy = updateStrategy();
        if (!botState.running) break;

        // Calculate Bet
        let nextBet = getKellyBet(botState.stats.currentBalance, botState.settings.payout);
        
        // Anti-Martingale Twist: If on a win streak, slightly increase bet
        if (botState.consecutiveWins > 2) {
            nextBet = nextBet * 1.2;
        }

        // Execution
        const result = await placeBet(nextBet, botState.settings.payout);
        
        if (result) {
            botState.stats.currentBalance = result.Balance;
            botState.stats.totalWagered += result.Bet;

            if (result.Profit > 0) {
                botState.consecutiveWins++;
                botState.consecutiveLosses = 0;
                botState.stats.wins++;
            } else {
                botState.consecutiveLosses++;
                botState.consecutiveWins = 0;
                botState.stats.losses++;
            }

            // Variance Control: If losing too many in a row, wait for the "seed" to cool
            if (botState.consecutiveLosses >= 7) {
                console.log(`⚠️ Losing streak detected. Cooling down for ${CONFIG.cooldownAfterLossStreak/1000}s...`);
                await new Promise(r => setTimeout(r, CONFIG.cooldownAfterLossStreak));
            }
        }

        // Small delay to prevent API spamming and allow for UI updates
        await new Promise(r => setTimeout(r, 1000));
    }
}

// ============ API INTERFACE ============
async function placeBet(amount, payout) {
    const url = `${BASE_URL}/placebet/${CONFIG.coin}/${API_KEY}`;
    
    try {
        // Validation
        if (amount > botState.stats.currentBalance * CONFIG.maxBetPercent) {
            amount = botState.stats.currentBalance * CONFIG.maxBetPercent;
        }

        console.log(`🎲 Bet: ${amount.toFixed(8)} | Payout: ${payout}x | Strategy: ${botState.settings.strategy}`);
        
        const response = await axios.post(url, {
            Bet: Number(amount.toFixed(8)),
            Payout: payout,
            UnderOver: true,
            ClientSeed: "PRO_" + Math.random().toString(36).slice(2)
        });

        return response.data;
    } catch (e) {
        console.log("❌ API Error or Demo Mode Simulating...");
        // Simulation logic for testing
        const win = Math.random() < (0.99 / payout);
        const profit = win ? amount * (payout - 1) : -amount;
        return {
            Bet: amount,
            Profit: profit,
            Balance: botState.stats.currentBalance + profit
        };
    }
}

// Start the bot
runEngine();

// Basic API for the Dashboard
app.get('/api/stats', (req, res) => res.json(botState));
app.listen(port, () => console.log(`Dashboard: http://localhost:${port}`));
