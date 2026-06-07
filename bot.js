const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "qErHdIdfJSCKQrFJyPar80NnCCJNIUsvfcurIMSQ8lJ3xK1tL1";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 1.7,              
    balanceStep: 0.00000025,   // Increased for proper minimum bets (was 0.00000025)
    betIncrement: 0.00000001,  // Increased minimum bet increment (was 0.00000001)
    minBet: 0.00000001,        // MINIMUM BET: 1000 satoshis (0.00000100 BTC)
    maxBetMultiplier: 20,      // Maximum bet size multiplier from base
    minBetMultiplier: 0.5      // Minimum bet size multiplier from base (50% of base)
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0,
        lockPercent: 0.80 
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: DEFAULTS.minBet,
        currentBet: DEFAULTS.minBet,
        payout: DEFAULTS.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0
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
    // Ensure balance is enough for minimum bet
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    let calculated = Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
    // Never go below minimum bet
    return Math.max(DEFAULTS.minBet, calculated);
}

/**
 * DYNAMIC BET CALCULATION - BOTH UP AND DOWN
 * WIN  → Bet DECREASES (goes lower)
 * LOSS → Bet INCREASES (goes higher)
 */
function calculateNextBet(isWin, currentBet, baseBet, lossStreak, winStreak) {
    let newBet;
    
    if (isWin) {
        // WIN: Bet goes DOWN (decrease)
        if (winStreak >= 5) {
            // After 5+ wins, drop to minimum
            newBet = baseBet * DEFAULTS.minBetMultiplier;
        } else if (winStreak >= 3) {
            // After 3-4 wins, drop to 60% of base
            newBet = baseBet * 0.6;
        } else if (winStreak >= 1) {
            // After 1-2 wins, decrease by 30%
            newBet = currentBet * 0.7;
        } else {
            newBet = baseBet;
        }
    } else {
        // LOSS: Bet goes UP (increase)
        let multiplier = Math.min(DEFAULTS.maxBetMultiplier, Math.pow(1.4, lossStreak));
        newBet = baseBet * multiplier;
        
        // Max 2x increase per step
        let maxIncrease = currentBet * 2;
        if (newBet > maxIncrease) newBet = maxIncrease;
    }
    
    // Clamp between min and max (using absolute minimum bet)
    const minBet = Math.max(DEFAULTS.minBet, baseBet * DEFAULTS.minBetMultiplier);
    const maxBet = baseBet * DEFAULTS.maxBetMultiplier;
    newBet = Math.max(minBet, Math.min(maxBet, newBet));
    
    // Round to 8 decimal places
    return Number(newBet.toFixed(8));
}

/**
 * VALIDATE BET BEFORE PLACING
 */
function validateBet(betAmount, currentBalance) {
    if (betAmount < DEFAULTS.minBet) {
        console.log(`Bet ${betAmount} below minimum ${DEFAULTS.minBet}, adjusting...`);
        return DEFAULTS.minBet;
    }
    if (betAmount > currentBalance) {
        console.log(`Bet ${betAmount} exceeds balance ${currentBalance}, reducing...`);
        return currentBalance * 0.1; // Bet 10% of balance if too high
    }
    return betAmount;
}

/**
 * SOFT REBOOT: Reset strategy on safe floor hit
 */
function softResetBot() {
    console.log("SYSTEM: SAFE FLOOR HIT. Performing soft reboot...");
    botState.statusMessage = "SYSTEM: SAFE FLOOR HIT: Resetting Strategy...";
    
    botState.profitProtection.safeBalance = 0; 
    botState.recoveryPot = 0; 
    
    botState.stats = {
        totalBets: 0, 
        wins: 0, 
        losses: 0, 
        netProfit: botState.stats.netProfit, 
        maxSessionProfit: 0,
        currentBalance: botState.stats.currentBalance,
        startTime: Date.now()
    };
    
    botState.betHistory = [];
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
    botState.settings.consecutiveLosses = 0;
    botState.settings.consecutiveWins = 0;
}

// ============ API LOGIC ============
async function placeBet() {
    // Validate bet amount before placing
    const validatedBet = validateBet(botState.settings.currentBet, botState.stats.currentBalance);
    if (validatedBet !== botState.settings.currentBet) {
        botState.settings.currentBet = validatedBet;
        botState.statusMessage = `Bet adjusted to minimum: ${validatedBet.toFixed(8)} BTC`;
    }
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = "pro" + Math.random().toString(36).substring(2, 12); 

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    console.log(`[BET] Placing bet: ${payload.Bet} BTC | Payout: ${payload.Payout}`);
    
    try {
        const response = await axios.post(url, payload);
        console.log(`[RESULT] Win: ${response.data.Profit > 0} | Profit: ${response.data.Profit} | New Balance: ${response.data.Balance}`);
        return response.data;
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message || "API Error";
        console.error(`[ERROR] ${errorMsg}`);
        botState.statusMessage = `Error: ${errorMsg}`;
        
        // If invalid bet amount, adjust base bet upward
        if (errorMsg.includes("Invalid bet amount") || errorMsg.includes("minimum")) {
            console.log("Adjusting minimum bet upward...");
            DEFAULTS.minBet = Math.min(DEFAULTS.minBet * 1.5, 0.00001000); // Increase min bet up to 0.00001
            botState.settings.baseBet = Math.max(DEFAULTS.minBet, botState.settings.baseBet);
            botState.settings.currentBet = botState.settings.baseBet;
            botState.statusMessage = `Adjusted min bet to ${DEFAULTS.minBet.toFixed(8)} BTC`;
        }
        
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.statusMessage = `Dynamic Up/Down Mode | Min Bet: ${DEFAULTS.minBet.toFixed(8)} BTC`;
    
    while (true) {
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            softResetBot();
            await new Promise(r => setTimeout(r, 5000));
            continue; 
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const isWin = profit > 0;
        
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        // Update streaks BEFORE calculating next bet
        if (isWin) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
            botState.recoveryPot += Math.abs(profit);
        }

        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        // Update base bet based on current balance
        const oldBase = botState.settings.baseBet;
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        // Store previous bet for comparison
        const previousBet = botState.settings.currentBet;
        
        // Calculate next bet using dynamic up/down strategy
        botState.settings.currentBet = calculateNextBet(
            isWin, 
            previousBet, 
            botState.settings.baseBet,
            botState.settings.consecutiveLosses,
            botState.settings.consecutiveWins
        );
        
        // Final validation before next loop
        botState.settings.currentBet = validateBet(botState.settings.currentBet, botState.stats.currentBalance);
        
        // Update safe balance floor (80% profit lock)
        if (isWin && botState.recoveryPot === 0) {
            botState.profitProtection.safeBalance += (profit * 0.80);
        }

        // Calculate direction for display
        let direction = "→";
        let directionEmoji = "➡️";
        if (botState.settings.currentBet > previousBet) {
            direction = "↑ UP";
            directionEmoji = "📈";
        } else if (botState.settings.currentBet < previousBet) {
            direction = "↓ DOWN";
            directionEmoji = "📉";
        }

        // Enhanced bet history with full details
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
            directionEmoji: directionEmoji
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        // Dynamic status message
        const action = isWin ? `WIN → Bet DOWN to ${botState.settings.currentBet.toFixed(8)}` : `LOSS → Bet UP to ${botState.settings.currentBet.toFixed(8)}`;
        const streakInfo = isWin ? 
            `Win streak: ${botState.settings.consecutiveWins} (⬇️ decreasing bet)` : 
            `Loss streak: ${botState.settings.consecutiveLosses} (⬆️ increasing bet)`;
        botState.statusMessage = `${directionEmoji} ${action} | ${streakInfo} | Min: ${DEFAULTS.minBet.toFixed(8)} | Base: ${botState.settings.baseBet.toFixed(8)}`;

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2), minBet: DEFAULTS.minBet });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v4.1 | Fixed Min Bet</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; --warning: #8b5cf6; --info: #06b6d4; }
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
        .stats-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .wallet-label { font-size: 1rem; text-transform: uppercase; letter-spacing: 2px; }
        .strategy-badge { background: linear-gradient(135deg, var(--warning), var(--info)); color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: bold; display: inline-block; margin-left: 10px; }
        .bet-up { color: var(--danger); font-weight: bold; background: rgba(239,68,68,0.1); padding: 2px 8px; border-radius: 12px; }
        .bet-down { color: var(--success); font-weight: bold; background: rgba(16,185,129,0.1); padding: 2px 8px; border-radius: 12px; }
        .bet-same { color: var(--text-muted); }
        .streak-badge { font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; display: inline-block; }
        .streak-win { background: rgba(16,185,129,0.2); color: var(--success); }
        .streak-loss { background: rgba(239,68,68,0.2); color: var(--danger); }
        .error-box { background: rgba(239,68,68,0.1); border-left: 3px solid var(--danger); padding: 10px; margin-bottom: 15px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>Dice Pro <span style="color:var(--primary)">v4.1</span> 
                    <span class="strategy-badge">⬆️ UP on LOSS ⬇️ DOWN on WIN</span>
                </h1>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 5px;">
                    Min Bet: <strong id="min-bet-display">0.00000100</strong> BTC (1000 satoshis)
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
                <div class="card"><div class="label">💳 Trading Balance</div><div id="t-bal" class="btc-val" style="color:var(--danger)">0.00</div><div id="t-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--primary)">0.00</div><div class="usd-val">Mode: Dynamic ⬆️⬇️</div></div>
            </div>
            <div class="stats-row">
                <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
                <div class="mini-card"><div class="label">Base Bet</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00</div></div>
                <div class="mini-card"><div class="label">Current Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00</div></div>
                <div class="mini-card"><div class="label"><span class="loss">📉 Loss Streak</span></div><div id="loss-streak" style="font-weight:700; color:var(--danger)">0</div></div>
                <div class="mini-card"><div class="label"><span class="win">📈 Win Streak</span></div><div id="win-streak" style="font-weight:700; color:var(--success)">0</div></div>
            </div>
            <div class="label">Revenue Projections (Based on current profit rate)</div>
            <div class="proj-grid">
                <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span><br><span id="p-hr-u" class="usd-val">0.00</span></div>
                <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span><br><span id="p-dy-u" class="usd-val">0.00</span></div>
                <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00</span><br><span id="p-month-u" class="usd-val">0.00</span></div>
                <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00</span><br><span id="p-year-u" class="usd-val">0.00</span></div>
            </div>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Base</th>
                            <th>Wager</th>
                            <th>Roll</th>
                            <th>P/L (BTC)</th>
                            <th>Streaks</th>
                            <th>Next Bet</th>
                            <th>Direction</th>
                        </tr>
                    </thead>
                    <tbody id="h-body"></tbody>
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
                <div class="wallet-display" id="wallet-display-main">0.00000000 BTC</div>
                <div style="font-size: 1.2rem; opacity: 0.9;" id="wallet-conversion-note">≈ $0.00 USD</div>
            </div>
            <div class="grid" style="margin-top: 2rem;">
                <div class="card"><div class="label">💳 Trading Balance</div><div id="wallet-trading-bal" class="btc-val">0.00</div><div id="wallet-trading-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00</div><div id="wallet-profit-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="wallet-recovery-pot" class="btc-val">0.00</div><div id="wallet-recovery-conv" class="usd-val">$0.00</div></div>
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
            return symbol + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }
        
        function updateWalletDisplay() {
            const selector = document.getElementById('currency-selector');
            if (selector) currentCurrency = selector.value;
            const walletBalanceRaw = parseFloat(document.getElementById('w-bal')?.innerText || 0);
            const tradingBalanceRaw = parseFloat(document.getElementById('t-bal')?.innerText || 0);
            const netProfitRaw = parseFloat(document.getElementById('n-prof')?.innerText || 0);
            const recoveryPotRaw = parseFloat(document.getElementById('pot-display')?.innerText || 0);
            
            document.getElementById('wallet-display-main').innerText = formatCurrency(convertToCurrency(walletBalanceRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-trading-bal').innerText = formatCurrency(convertToCurrency(tradingBalanceRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-net-profit').innerText = formatCurrency(convertToCurrency(netProfitRaw, currentCurrency), currentCurrency);
            document.getElementById('wallet-recovery-pot').innerText = formatCurrency(convertToCurrency(recoveryPotRaw, currentCurrency), currentCurrency);
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
                const { botState, btcPrice, hoursPassed, minBet } = data;
                
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                document.getElementById('min-bet-display').innerText = f(minBet);
                
                const tradingAvailable = Math.max(0, (botState.stats.currentBalance - botState.profitProtection.safeBalance) / 8);

                document.getElementById('status-msg').innerHTML = "🎲 " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                
                document.getElementById('t-bal').innerText = f(tradingAvailable);
                document.getElementById('t-usd').innerText = u(tradingAvailable);
                
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                const winRate = (botState.stats.wins/botState.stats.totalBets)*100 || 0;
                document.getElementById('wr').innerHTML = winRate.toFixed(1) + "% " + (winRate > 50 ? "✅" : "⚠️");
                document.getElementById('s-base').innerText = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('loss-streak').innerHTML = botState.settings.consecutiveLosses || 0;
                document.getElementById('win-streak').innerHTML = botState.settings.consecutiveWins || 0;

                const netProfit = parseFloat(botState.stats.netProfit || 0);
                const hours = Math.max(0.01, parseFloat(hoursPassed));
                const hourlyProjection = netProfit / hours;
                
                document.getElementById('p-hr-b').innerText = f(hourlyProjection);
                document.getElementById('p-hr-u').innerText = u(hourlyProjection);
                document.getElementById('p-dy-b').innerText = f(hourlyProjection * 24);
                document.getElementById('p-dy-u').innerText = u(hourlyProjection * 24);
                document.getElementById('p-month-b').innerText = f(hourlyProjection * 24 * 30);
                document.getElementById('p-month-u').innerText = u(hourlyProjection * 24 * 30);
                document.getElementById('p-year-b').innerText = f(hourlyProjection * 24 * 365);
                document.getElementById('p-year-u').innerText = u(hourlyProjection * 24 * 365);

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                    let streakDisplay = '';
                    if (b.lossStreak > 0) streakDisplay = \`<span class="streak-badge streak-loss">📉 \${b.lossStreak}L</span>\`;
                    if (b.winStreak > 0) streakDisplay = \`<span class="streak-badge streak-win">📈 \${b.winStreak}W</span>\`;
                    
                    let directionHtml = '';
                    if (b.nextBet > b.previousBet) {
                        directionHtml = '<span class="bet-up">⬆️ UP</span>';
                    } else if (b.nextBet < b.previousBet) {
                        directionHtml = '<span class="bet-down">⬇️ DOWN</span>';
                    } else {
                        directionHtml = '<span class="bet-same">➡️ SAME</span>';
                    }
                    
                    return \`
                        <tr>
                            <td>#\${b.id}</td>
                            <td>\${f(b.dBase)}</td>
                            <td>\${f(b.bet)}</td>
                            <td>\${b.roll}</td>
                            <td class="\${b.isWin?'win':'loss'}">\${b.isWin?'+':' '}\${f(b.profit)}</td>
                            <td>\${streakDisplay}</td>
                            <td>\${f(b.nextBet)}</td>
                            <td>\${directionHtml}</td>
                        </tr>
                    \`;
                }).join('');
                
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
    console.log(`Server running on port ${port}`);
    console.log(`Minimum bet set to ${DEFAULTS.minBet} BTC (1000 satoshis)`);
    runStrategy();
});
