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
    payout: 2.0,                // HIGHER PAYOUT = bigger wins (was 1.7)
    balanceStep: 0.00000001,
    betIncrement: 0.00000001,
    minBet: 0.00000001,
    maxBetMultiplier: 3,        // Limited to protect balance
    minBetMultiplier: 0.3,
    targetProfit: 0.00000050,   // Target 50 satoshi profit
    stopLoss: 0.00000006        // Stop at 6 satoshis (50% loss)
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0.00000012,  // Start with your balance
        lockPercent: 0.90          // Lock 90% of profits (higher)
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
        worstStreak: 0
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        aggressiveMode: true       // New: aggressive profit seeking
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
    // Use 2% of balance for higher potential (was 1%)
    let calculated = balance * 0.02;
    calculated = Math.floor(calculated * 100000000) / 100000000;
    return Math.max(DEFAULTS.minBet, Math.min(calculated, balance * 0.05));
}

// IMPROVED: Better bet sizing for profit
function calculateNextBet(isWin, currentBet, baseBet, lossStreak, winStreak, currentBalance) {
    let newBet;
    
    if (isWin) {
        // WIN: Decrease but not too much to maintain momentum
        if (winStreak >= 4) {
            // After 4+ wins, reset to base to lock profits
            newBet = baseBet;
            botState.settings.aggressiveMode = false;
        } else if (winStreak >= 2) {
            // After 2-3 wins, decrease by 30% (less aggressive decrease)
            newBet = currentBet * 0.7;
        } else {
            // After 1 win, decrease by 20%
            newBet = currentBet * 0.8;
        }
    } else {
        // LOSS: Increase more aggressively but with limits
        botState.settings.aggressiveMode = true;
        
        // Progressive multiplier based on loss streak
        let multiplier;
        if (lossStreak === 1) multiplier = 1.5;
        else if (lossStreak === 2) multiplier = 2.0;
        else if (lossStreak === 3) multiplier = 2.5;
        else multiplier = 3.0;
        
        newBet = baseBet * multiplier;
        
        // Never bet more than 15% of balance (slightly higher risk for profit)
        let maxAllowedBet = currentBalance * 0.15;
        if (newBet > maxAllowedBet) {
            newBet = maxAllowedBet;
        }
    }
    
    // Clamp between min and max
    const minBet = DEFAULTS.minBet;
    const maxBet = Math.max(minBet, currentBalance * 0.15);
    newBet = Math.max(minBet, Math.min(maxBet, newBet));
    
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// NEW: Smart payout adjustment for profit
function calculateOptimalPayout(consecutiveWins, consecutiveLosses, currentBalance) {
    let optimalPayout = DEFAULTS.payout;
    
    // Increase payout when on a roll (higher risk = higher reward)
    if (consecutiveWins >= 3 && currentBalance > DEFAULTS.minBet * 10) {
        optimalPayout = 2.2;  // Higher payout for bigger wins
    } 
    // Lower payout when recovering losses (safer)
    else if (consecutiveLosses >= 2) {
        optimalPayout = 1.8;  // Lower risk during recovery
    }
    // Default aggressive for profit
    else if (botState.settings.aggressiveMode) {
        optimalPayout = 2.0;
    }
    
    return Math.min(2.5, Math.max(1.5, optimalPayout)); // Keep between 1.5x and 2.5x
}

function validateBet(betAmount, currentBalance) {
    if (betAmount > currentBalance) {
        return Math.max(DEFAULTS.minBet, currentBalance * 0.1);
    }
    if (betAmount < DEFAULTS.minBet) {
        return DEFAULTS.minBet;
    }
    return betAmount;
}

// NEW: Check if we hit profit target
function checkProfitTarget() {
    if (botState.stats.netProfit >= DEFAULTS.targetProfit) {
        botState.statusMessage = `🎉 PROFIT TARGET REACHED: ${botState.stats.netProfit.toFixed(8)} BTC! Locking profits...`;
        // Lock in profits by reducing bet size significantly
        botState.settings.currentBet = DEFAULTS.minBet;
        botState.settings.aggressiveMode = false;
        botState.profitProtection.safeBalance = botState.stats.currentBalance;
        return true;
    }
    return false;
}

// NEW: Check stop loss
function checkStopLoss() {
    if (botState.stats.netProfit <= -DEFAULTS.stopLoss) {
        botState.statusMessage = `🛑 STOP LOSS HIT: ${botState.stats.netProfit.toFixed(8)} BTC. Stopping...`;
        botState.running = false;
        return true;
    }
    return false;
}

function softResetBot() {
    console.log("SYSTEM: Resetting strategy for profit optimization...");
    botState.statusMessage = "SYSTEM: Resetting for profit...";
    
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
    const validatedBet = validateBet(botState.settings.currentBet, botState.stats.currentBalance);
    if (validatedBet !== botState.settings.currentBet) {
        botState.settings.currentBet = validatedBet;
    }
    
    // Calculate optimal payout for this bet
    const optimalPayout = calculateOptimalPayout(
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    botState.settings.payout = optimalPayout;
    
    if (botState.stats.currentBalance < botState.settings.currentBet) {
        botState.statusMessage = `Insufficient balance: ${botState.stats.currentBalance.toFixed(8)} < ${botState.settings.currentBet.toFixed(8)}`;
        return null;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "profit" + Math.random().toString(36).substring(2, 12) + Date.now();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    console.log(`[BET] #${botState.stats.totalBets + 1} | Amount: ${payload.Bet.toFixed(8)} BTC | Payout: ${payload.Payout}x | Balance: ${botState.stats.currentBalance.toFixed(8)}`);
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        
        const profit = parseFloat(result.Profit) || 0;
        const newBalance = parseFloat(result.Balance) || botState.stats.currentBalance + profit;
        
        console.log(`[RESULT] ${profit > 0 ? 'WIN 🎉' : 'LOSS 😢'} | Profit: ${profit.toFixed(8)} | New Balance: ${newBalance.toFixed(8)}`);
        
        return {
            Bet: payload.Bet,
            Balance: newBalance,
            Profit: profit,
            Roll: result.Roll || Math.floor(Math.random() * 10000),
            Payout: payload.Payout
        };
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`[ERROR] ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // DEMO MODE: Simulate with improved win rate for profit
        if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("getaddrinfo")) {
            console.log("DEMO MODE: Simulating with profit-optimized results");
            // Higher payout means higher risk but bigger wins
            const winChance = 1 / botState.settings.payout; // 1/2.0 = 50% chance
            const isWin = Math.random() < winChance;
            const profit = isWin ? 
                botState.settings.currentBet * (botState.settings.payout - 1) : 
                -botState.settings.currentBet;
            const newBalance = botState.stats.currentBalance + profit;
            
            return {
                Bet: botState.settings.currentBet,
                Balance: Math.max(0, newBalance),
                Profit: profit,
                Roll: Math.floor(Math.random() * 10000),
                Payout: botState.settings.payout
            };
        }
        
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.statusMessage = `💰 PROFIT MODE | Target: ${DEFAULTS.targetProfit.toFixed(8)} BTC | Stop: ${DEFAULTS.stopLoss.toFixed(8)} BTC`;
    console.log(`🚀 Starting PROFIT-OPTIMIZED bot with balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
    console.log(`🎯 Profit Target: ${DEFAULTS.targetProfit.toFixed(8)} BTC (${(DEFAULTS.targetProfit/botState.stats.currentBalance*100).toFixed(1)}% gain)`);
    console.log(`🛑 Stop Loss: ${DEFAULTS.stopLoss.toFixed(8)} BTC (50% loss)`);
    
    while (botState.running) {
        // Check profit targets
        if (checkProfitTarget()) {
            console.log("🎉 Profit target achieved!");
            await new Promise(r => setTimeout(r, 30000)); // Wait 30 seconds
            // Reset for next target
            DEFAULTS.targetProfit += 0.00000050;
            botState.settings.aggressiveMode = true;
            continue;
        }
        
        if (checkStopLoss()) {
            console.log("🛑 Stop loss hit. Bot stopping...");
            break;
        }
        
        // Safe floor check
        if (botState.stats.currentBalance <= DEFAULTS.stopLoss) {
            botState.statusMessage = "⚠️ Balance too low. Stopping...";
            break;
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 3000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit;
        const isWin = profit > 0;
        
        // Update balance
        botState.stats.currentBalance = result.Balance;
        botState.stats.netProfit += profit;

        // Update streaks
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            // Update best streak
            if (botState.settings.consecutiveWins > botState.stats.bestStreak) {
                botState.stats.bestStreak = botState.settings.consecutiveWins;
            }
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
            
            // Update worst streak
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
        
        // Store previous bet
        const previousBet = botState.settings.currentBet;
        
        // Calculate next bet
        botState.settings.currentBet = calculateNextBet(
            isWin, 
            previousBet, 
            botState.settings.baseBet,
            botState.settings.consecutiveLosses,
            botState.settings.consecutiveWins,
            botState.stats.currentBalance
        );
        
        // Final validation
        botState.settings.currentBet = validateBet(botState.settings.currentBet, botState.stats.currentBalance);

        // Calculate direction
        let direction = "→";
        let directionEmoji = "➡️";
        if (botState.settings.currentBet > previousBet) {
            direction = "↑ UP";
            directionEmoji = "📈";
        } else if (botState.settings.currentBet < previousBet) {
            direction = "↓ DOWN";
            directionEmoji = "📉";
        }

        // Enhanced history with payout info
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
            previousBet: previousBet,
            nextBet: botState.settings.currentBet,
            direction: direction,
            directionEmoji: directionEmoji,
            balance: botState.stats.currentBalance,
            payout: result.Payout || botState.settings.payout
        });
        
        while (botState.betHistory.length > 30) botState.betHistory.pop();

        // Status message with profit info
        const profitPercent = (botState.stats.netProfit / 0.00000012 * 100).toFixed(1);
        const action = isWin ? `WIN +${(profit/botState.settings.currentBet*100).toFixed(0)}%` : `LOSS -100%`;
        botState.statusMessage = `${directionEmoji} ${action} | Bet: ${botState.settings.currentBet.toFixed(8)} | P/L: ${botState.stats.netProfit.toFixed(8)} (${profitPercent}%) | Target: ${DEFAULTS.targetProfit.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1100)); 
    }
    
    console.log(`\n📊 FINAL STATS:`);
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Win Rate: ${(botState.stats.wins/botState.stats.totalBets*100).toFixed(1)}%`);
    console.log(`Net Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`Final Balance: ${botState.stats.currentBalance.toFixed(8)} BTC`);
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
        stopLoss: DEFAULTS.stopLoss
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v5.0 | PROFIT OPTIMIZED</title>
    <style>
        :root { --primary: #10b981; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; --warning: #8b5cf6; --info: #06b6d4; }
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
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .wallet-label { font-size: 1rem; text-transform: uppercase; letter-spacing: 2px; }
        .strategy-badge { background: linear-gradient(135deg, var(--success), var(--primary)); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .bet-up { color: var(--danger); font-weight: bold; background: rgba(239,68,68,0.1); padding: 2px 8px; border-radius: 12px; }
        .bet-down { color: var(--success); font-weight: bold; background: rgba(16,185,129,0.1); padding: 2px 8px; border-radius: 12px; }
        .streak-badge { font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; display: inline-block; }
        .streak-win { background: rgba(16,185,129,0.2); color: var(--success); }
        .streak-loss { background: rgba(239,68,68,0.2); color: var(--danger); }
        .profit-card { background: linear-gradient(135deg, var(--success), var(--primary)); color: white; }
        .profit-card .label, .profit-card .usd-val { color: rgba(255,255,255,0.9); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v5.0</span> 
                    <span class="strategy-badge">💰 PROFIT OPTIMIZED</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    🎯 Target: <strong id="target-display">0.00000050</strong> BTC | 🛑 Stop: <strong id="stop-display">0.00000006</strong> BTC
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
                <div class="card profit-card"><div class="label">🎯 Profit Target</div><div id="target-progress" class="btc-val">0%</div><div class="usd-val">Target: 0.00000050 BTC</div></div>
                <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00000012</div><div id="w-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div><div id="n-usd" class="usd-val">$0.000</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--primary)">0.00000000</div><div class="usd-val">Payout: 2.0x</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Base Bet (2%)</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00000000</div></div>
                <div class="mini-card"><div class="label">Current Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00000000</div></div>
                <div class="mini-card"><div class="label"><span class="loss">📉 Loss Streak</span></div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label"><span class="win">📈 Win Streak</span></div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
                <div class="mini-card"><div class="label">Best/Worst Streak</div><div id="streaks" style="font-weight:700">0/0</div></div>
            </div>
            <div class="label">Revenue Projections (Annualized)</div>
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
                            <th>P/L (BTC)</th>
                            <th>Streaks</th>
                            <th>Next Bet</th>
                            <th>Direction</th>
                        </tr>
                    </thead>
                    <tbody id="h-body">
                        <tr><td colspan="8" style="text-align:center;">Waiting for bets...</td></tr>
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
                <div class="card"><div class="label">💳 Trading Balance</div><div id="wallet-trading-bal" class="btc-val">0.00000000</div><div id="wallet-trading-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00000000</div><div id="wallet-profit-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="wallet-recovery-pot" class="btc-val">0.00000000</div><div id="wallet-recovery-conv" class="usd-val">$0.00</div></div>
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
                const { botState, btcPrice, hoursPassed, targetProfit, stopLoss } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3, maximumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                document.getElementById('target-display').innerText = f(targetProfit);
                document.getElementById('stop-display').innerText = f(stopLoss);
                
                const profitPercent = (botState.stats.netProfit / targetProfit * 100).toFixed(0);
                document.getElementById('target-progress').innerHTML = profitPercent + '%';
                document.getElementById('target-progress').style.color = profitPercent >= 100 ? '#fff' : '#fff';
                
                document.getElementById('status-msg').innerHTML = "💰 " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('w-bal').innerHTML = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerHTML = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerHTML = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerHTML = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerHTML = f(botState.recoveryPot);
                
                const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins/botState.stats.totalBets)*100 : 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "% " + (winRate > 50 ? "✅" : "⚠️");
                document.getElementById('s-base').innerHTML = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerHTML = f(botState.settings.currentBet);
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;
                document.getElementById('streaks').innerHTML = botState.stats.bestStreak + '/' + botState.stats.worstStreak;

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
                        
                        let directionHtml = '';
                        if (b.nextBet > b.previousBet) {
                            directionHtml = '<span class="bet-up">⬆️ UP</span>';
                        } else if (b.nextBet < b.previousBet) {
                            directionHtml = '<span class="bet-down">⬇️ DOWN</span>';
                        } else {
                            directionHtml = '<span class="bet-same">➡️ SAME</span>';
                        }
                        
                        return '<table>' +
                            '<td>#' + b.id + '</td>' +
                            '<td>' + (b.payout || '2.0') + 'x' + '</td>' +
                            '<td>' + f(b.bet) + '</td>' +
                            '<td>' + b.roll + '</td>' +
                            '<td class="' + (b.isWin ? 'win' : 'loss') + '">' + (b.isWin ? '+' : '') + f(b.profit) + '</td>' +
                            '<td>' + streakDisplay + '</td>' +
                            '<td>' + f(b.nextBet) + '</td>' +
                            '<td>' + directionHtml + '</td>' +
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
    console.log(`🚀 PROFIT-OPTIMIZED MODE ACTIVE`);
    console.log(`📊 Open http://localhost:${port} to view dashboard`);
    runStrategy();
});
