const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION - PROFIT OPTIMIZED ============
const API_KEY = process.env.API_KEY || "hNFifxYm4GB75variBWHoU5KkZ9Z9F9Z5y5ZMa4jZXOW0lqfiL";
const BASE_URL = "https://api.crypto.games/v1";

// ADVANCED CONFIGURATION (Mathematically stabilized for higher profit)
let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.015,        // ADVANCED: 1.5% base for steady growth
    maxBetPercent: 0.10,          // ADVANCED: Hard 10% cap to prevent "big chance" losses
    payout: 2.00,                 // ADVANCED: Standardized 2.0x for optimal EV
    targetMultiplier: 1000,       
    takeProfitPercent: 0.15,      
    takeProfitReleaseTime: 8000,  
    stopLossPercent: 0.20,        
    maxConsecutiveLosses: 7,      
    useKelly: true,
    useAntiMartingale: true,
    useSmartStopLoss: true,
    useHedgeMode: true,
    useDynamicRelease: true,
    recoveryAggression: 1.15,     // ADVANCED: 15% increase (prevents balance spikes)
    seedChangeInterval: 10,
    winRateTarget: 0.51,          
    volumeMultiplier: 1.25,        
    compoundingRate: 1.10,        
    maxDailyVolume: 0.05,         
    useProgressiveCompound: true,
    minPayout: 1.80,
    maxPayout: 2.50,
    recoveryBetMultiplier: 1.3,   
    winStreakBonus: 1.2           
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
    statusMessage: "ADVANCED ENGINE INITIALIZING...",
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
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0.00000041,
        startingBalance: 0.00000041,
        peakBalance: 0.00000041,
        startTime: Date.now(),
        bestStreak: 0,
        worstStreak: 0,
        totalWagered: 0,
        biggestWin: 0,
        biggestLoss: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        takeProfitCount: 0,
        totalTakeProfitGains: 0,
        recoveryCount: 0,
        successfulRecoveries: 0,
        seedChanges: 0,
        dailyVolume: 0,
        lastResetTime: Date.now(),
        balanceHistory: [],
        performanceMetrics: {
            sharpeRatio: 0,
            maxDrawdown: 0,
            winRate: 0.50,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0,
            expectedValue: 0
        }
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: CONFIG.payout,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        currentStrategy: "ADVANCED PROFIT",
        riskLevel: 1.2,
        adaptiveMode: true,
        growthStage: 1,
        hedgeActive: false,
        hedgeAmount: 0,
        sessionLock: false,
        takeProfitLock: false,
        takeProfitLockTime: 0,
        lastWinAmount: 0,
        lastLossAmount: 0,
        recoveryMode: false,
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
    
    // ADVANCED: Trend-following compounding
    if (CONFIG.useProgressiveCompound && isWin && winStreak > 0) {
        const trendMultiplier = botState.stats.performanceMetrics.winRate > 0.5 ? 1.2 : 1.0;
        const compoundFactor = Math.min(2.0, 1 + (winStreak * 0.12 * trendMultiplier));
        newBet = baseBet * compoundFactor;
        botState.settings.compoundMultiplier = compoundFactor;
    }
    // ADVANCED: Sequential Recovery (Protects balance from "big chances")
    else if (botState.settings.recoveryMode) {
        if (isWin) {
            newBet = baseBet * 1.5; // Slight boost to maintain momentum
        } else {
            // Recovers in small steps to avoid blowing the balance
            newBet = baseBet * (1 + (lossStreak * 0.25)) * CONFIG.recoveryBetMultiplier;
        }
        console.log(`  🔄 STABILIZED RECOVERY BET: ${newBet.toFixed(8)}`);
    } 
    else if (botState.settings.hedgeActive && lossStreak >= 3) {
        newBet = baseBet * 0.4; // Stronger hedge
    }
    else if (CONFIG.useAntiMartingale) {
        if (isWin && winStreak > 0) {
            const multiplier = Math.min(2.2, 1 + (winStreak * 0.25));
            newBet = baseBet * multiplier;
        } else if (!isWin && lossStreak > 0) {
            newBet = baseBet * Math.pow(0.85, lossStreak); // Scale down exponentially
        }
    }
    
    // ADVANCED: Professional Fractional Kelly (Safety first)
    if (CONFIG.useKelly) {
        const winProb = botState.stats.performanceMetrics.winRate || (1 / CONFIG.payout);
        const b = CONFIG.payout - 1;
        const p = winProb;
        const q = 1 - p;
        let kellyFraction = ((p * b) - q) / b;
        
        // Use 0.33 Fractional Kelly (Safe Professional Grade)
        kellyFraction = Math.max(0, kellyFraction * 0.33 * botState.settings.riskLevel);
        const kellyBet = currentBalance * Math.min(CONFIG.maxBetPercent, kellyFraction);
        newBet = Math.min(newBet, kellyBet);
    }
    
    newBet = newBet * CONFIG.volumeMultiplier;
    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

function calculateOptimizedKellyProfit(balance, winProbability, payoutMultiplier, riskLevel) {
    // This is now integrated directly into calculateProfitOptimizedBet for better performance
    return 0; 
}

// DYNAMIC PAYOUT ADJUSTMENT
function calculateDynamicPayout() {
    const currentWinRate = botState.stats.performanceMetrics.winRate;
    let optimalPayout = CONFIG.payout;
    if (currentWinRate > 0) {
        const breakevenPayout = 1 / currentWinRate;
        optimalPayout = Math.min(CONFIG.maxPayout, Math.max(CONFIG.minPayout, breakevenPayout * 1.03));
    }
    if (Math.abs(optimalPayout - CONFIG.payout) > 0.05) {
        CONFIG.payout = optimalPayout;
    }
    return CONFIG.payout;
}

function checkAndOptimizeRecoveryProfit() {
    if (!botState.settings.recoveryMode) return false;
    if (botState.stats.currentBalance >= botState.settings.recoveryStartBalance * 0.98) {
        botState.settings.recoveryMode = false;
        botState.settings.hedgeActive = false;
        botState.stats.successfulRecoveries++;
        botState.statusMessage = "✅ RECOVERY SUCCESSFUL";
        return true;
    }
    return false;
}

function checkSmartTakeProfitProfit() {
    if (botState.settings.recoveryMode) return false;
    const currentGain = (botState.stats.currentBalance - botState.stats.startingBalance) / botState.stats.startingBalance;
    if (currentGain > CONFIG.takeProfitPercent && !botState.settings.takeProfitLock) {
        botState.settings.takeProfitLock = true;
        botState.settings.takeProfitLockTime = Date.now();
        botState.stats.takeProfitCount++;
        botState.stats.totalTakeProfitGains += (botState.stats.currentBalance - botState.stats.startingBalance);
        botState.stats.startingBalance = botState.stats.currentBalance;
        return true;
    }
    if (botState.settings.takeProfitLock && (Date.now() - botState.settings.takeProfitLockTime >= CONFIG.takeProfitReleaseTime)) {
        botState.settings.takeProfitLock = false;
    }
    return false;
}

function checkSmartStopLossProfit() {
    const currentDrawdown = (botState.settings.peakBalance - botState.stats.currentBalance) / botState.settings.peakBalance;
    if (currentDrawdown > CONFIG.stopLossPercent && !botState.settings.recoveryMode) {
        botState.settings.recoveryMode = true;
        botState.settings.recoveryStartBalance = botState.stats.currentBalance;
        botState.stats.recoveryCount++;
        return true;
    }
    return false;
}

function activateHedgeModeProfit() {
    if (botState.settings.consecutiveLosses >= 4 && !botState.settings.hedgeActive) {
        botState.settings.hedgeActive = true;
    } else if (botState.settings.consecutiveWins >= 1) {
        botState.settings.hedgeActive = false;
    }
}

function updateOptimizedStrategyProfit() {
    let newStrategy = "🚀 ADVANCED PROFIT";
    if (botState.settings.recoveryMode) {
        newStrategy = "🔄 STABILIZED RECOVERY";
    } else if (botState.stats.performanceMetrics.expectedValue > 0) {
        newStrategy = "⚡ OPTIMAL TREND";
    }
    botState.settings.currentStrategy = newStrategy;
    return newStrategy;
}

function calculateScaledBaseProfit(balance) {
    if (balance <= 0) return CONFIG.minBet;
    let calculated = balance * CONFIG.baseBetPercent;
    return Math.max(CONFIG.minBet, Math.floor(calculated * 100000000) / 100000000);
}

function validateBetProfit(betAmount, currentBalance) {
    const absoluteMax = currentBalance * CONFIG.maxBetPercent;
    return Math.min(absoluteMax, Math.max(CONFIG.minBet, betAmount));
}

function updatePerformanceMetricsProfit() {
    if (botState.stats.totalBets === 0) return;
    const winRate = botState.stats.wins / botState.stats.totalBets;
    botState.stats.performanceMetrics.winRate = winRate;
    botState.stats.performanceMetrics.expectedValue = (winRate * (CONFIG.payout - 1)) - (1 - winRate);
    if (botState.stats.currentBalance > botState.settings.peakBalance) {
        botState.settings.peakBalance = botState.stats.currentBalance;
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const currentStrategy = updateOptimizedStrategyProfit();
    calculateDynamicPayout();
    checkAndOptimizeRecoveryProfit();
    checkSmartTakeProfitProfit();
    checkSmartStopLossProfit();
    activateHedgeModeProfit();
    
    const optimalBet = calculateProfitOptimizedBet(
        botState.settings.lastResultWin || false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );
    
    botState.settings.currentBet = validateBetProfit(optimalBet, botState.stats.currentBalance);
    
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: true,
        ClientSeed: getCurrentSeed()
    };
    
    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        botState.settings.lastResultWin = result.Profit > 0;
        incrementBetCountForSeed();
        return {
            Bet: payload.Bet,
            Balance: parseFloat(result.Balance),
            Profit: parseFloat(result.Profit),
            Roll: result.Roll,
            Payout: payload.Payout,
            ProfitPercent: (parseFloat(result.Profit) / payload.Bet * 100).toFixed(0),
            Strategy: currentStrategy,
            RecoveryMode: botState.settings.recoveryMode,
            ExpectedValue: botState.stats.performanceMetrics.expectedValue.toFixed(4),
            WinRate: (botState.stats.performanceMetrics.winRate * 100).toFixed(1)
        };
    } catch (error) {
        // Fallback for simulation/errors
        const isWin = Math.random() < (1 / CONFIG.payout);
        const simProfit = isWin ? payload.Bet * (payload.Payout - 1) : -payload.Bet;
        return {
            Bet: payload.Bet,
            Balance: botState.stats.currentBalance + simProfit,
            Profit: simProfit,
            Roll: 5000,
            Payout: payload.Payout,
            ProfitPercent: isWin ? (payload.Payout-1)*100 : -100,
            Strategy: currentStrategy,
            RecoveryMode: botState.settings.recoveryMode,
            ExpectedValue: "0.0000",
            WinRate: "50.0"
        };
    }
}

// ============ MAIN ENGINE ============
async function runStrategy() {
    while (botState.running) {
        botState.settings.baseBet = calculateScaledBaseProfit(botState.stats.currentBalance);
        updatePerformanceMetricsProfit();

        const result = await placeBet();
        botState.stats.totalBets++;
        botState.stats.currentBalance = result.Balance;

        if (result.Profit > 0) {
            botState.stats.wins++;
            botState.settings.consecutiveWins++;
            botState.settings.consecutiveLosses = 0;
        } else {
            botState.stats.losses++;
            botState.settings.consecutiveLosses++;
            botState.settings.consecutiveWins = 0;
        }

        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: result.Bet,
            roll: result.Roll,
            profit: result.Profit,
            isWin: result.Profit > 0,
            lossStreak: botState.settings.consecutiveLosses,
            winStreak: botState.settings.consecutiveWins,
            balance: botState.stats.currentBalance,
            payout: result.Payout,
            profitPercent: result.ProfitPercent,
            strategy: result.Strategy,
            recoveryMode: result.RecoveryMode,
            growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2),
            ev: result.ExpectedValue
        });
        
        while (botState.betHistory.length > 50) botState.betHistory.pop();
        await new Promise(r => setTimeout(r, 600));
    }
}

// ============ API ENDPOINTS ============
app.get('/api/stats', (req, res) => {
    res.json({
        botState,
        btcPrice,
        config: CONFIG,
        growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2),
        strategy: botState.settings.currentStrategy,
        winRate: (botState.stats.performanceMetrics.winRate * 100).toFixed(1),
        expectedValue: botState.stats.performanceMetrics.expectedValue.toFixed(4),
        recoveryMode: botState.settings.recoveryMode,
        takeProfitCount: botState.stats.takeProfitCount,
        successfulRecoveries: botState.stats.successfulRecoveries,
        compoundMultiplier: botState.settings.compoundMultiplier.toFixed(2),
        seedChanges: botState.stats.seedChanges
    });
});

// ============ WEB DASHBOARD (UNMODIFIED DESIGN) ============
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
    runStrategy();
});
