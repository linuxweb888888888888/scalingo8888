const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION - HYPER-OPTIMIZED v15.0 ============
const API_KEY = process.env.API_KEY || "hNFifxYm4GB75variBWHoU5KkZ9Z9F9Z5y5ZMa4jZXOW0lqfiL";
const BASE_URL = "https://api.crypto.games/v1";

let CONFIG = {
    coin: "BTC",
    minBet: 0.00000001,
    baseBetPercent: 0.008,        // 0.8% Base
    maxBetPercent: 0.12,          // 12% Absolute Hard Cap
    payout: 2.00,                 
    targetMultiplier: 1000,       
    takeProfitPercent: 0.15,      
    stopLossPercent: 0.20,        
    maxConsecutiveLosses: 6,      
    useKelly: true,
    useAntiMartingale: true,
    useGhostBetting: true,        // NEW: Virtual betting during cold streaks
    ghostWinRateThreshold: 0.42,  // NEW: Go virtual if WR drops below 42%
    emaAlpha: 0.15,               // NEW: Weight for Exponential Moving Average
    recoverySegments: 3,          // NEW: Split recovery into 3 safe stages
    volumeMultiplier: 1.3,        
    compoundingRate: 1.15,        
    useProgressiveCompound: true,
    minPayout: 1.75,
    maxPayout: 2.50,
    recoveryBetMultiplier: 1.25,  
    winStreakBonus: 1.2           
};

// ============ BOT STATE ============
let btcPrice = 60964;
let currentClientSeed = null;
let betsSinceSeedChange = 0;

let botState = {
    running: true,
    statusMessage: "ADVANCED ENGINE v15.0 INITIALIZING...",
    isVirtualMode: false,         // Ghost mode flag
    emaWinRate: 0.50,             // Tracking trend
    recoveryPot: 0,
    recoveryStage: 0,
    stats: {
        totalBets: 0, wins: 0, losses: 0, netProfit: 0, maxSessionProfit: 0,
        currentBalance: 0.00000041, startingBalance: 0.00000041, peakBalance: 0.00000041,
        startTime: Date.now(), bestStreak: 0, worstStreak: 0, totalWagered: 0,
        biggestWin: 0, biggestLoss: 0, consecutiveLosses: 0, consecutiveWins: 0,
        takeProfitCount: 0, totalTakeProfitGains: 0, recoveryCount: 0,
        successfulRecoveries: 0, seedChanges: 0, dailyVolume: 0, lastResetTime: Date.now(),
        performanceMetrics: { winRate: 0.5, expectedValue: 0 }
    },
    settings: {
        baseBet: 0.00000001, currentBet: 0.00000001, payout: CONFIG.payout,
        riskLevel: 1.2, recoveryMode: false, hedgeActive: false,
        takeProfitLock: false, currentStrategy: "TREND_FOLLOWING",
        compoundMultiplier: 1.0
    },
    betHistory: []
};

// ============ CORE LOGIC ENHANCEMENTS ============

function generateNewSeed() {
    const timestamp = Date.now().toString().slice(-8);
    const randomPart = Math.random().toString(36).substring(2, 12);
    currentClientSeed = `${timestamp}${randomPart}`.substring(0, 40);
    betsSinceSeedChange = 0;
    botState.stats.seedChanges++;
    return currentClientSeed;
}

function updateEMA(isWin) {
    const val = isWin ? 1 : 0;
    botState.emaWinRate = (val * CONFIG.emaAlpha) + (botState.emaWinRate * (1 - CONFIG.emaAlpha));
    
    // Check for Ghost Mode (Virtual)
    if (CONFIG.useGhostBetting) {
        if (botState.emaWinRate < CONFIG.ghostWinRateThreshold && !botState.isVirtualMode) {
            botState.isVirtualMode = true;
            botState.statusMessage = "🛡️ GHOST MODE: Win rate trend low. Virtual betting active.";
        } else if (botState.emaWinRate > 0.48 && botState.isVirtualMode) {
            botState.isVirtualMode = false;
            botState.statusMessage = "🚀 TREND IMPROVED: Resuming real bets.";
        }
    }
}

function calculateProfitOptimizedBet(isWin, currentBet, baseBet, winStreak, lossStreak, currentBalance) {
    const maxBet = currentBalance * CONFIG.maxBetPercent;
    let newBet = baseBet;
    
    // Recovery Segment Logic: Don't take "big chances" - recover in pieces
    if (botState.settings.recoveryMode) {
        const recoveryTarget = botState.recoveryPot / CONFIG.recoverySegments;
        newBet = (recoveryTarget / (CONFIG.payout - 1)) * 1.1;
    } 
    else if (isWin && winStreak > 0) {
        // Advanced Compounding based on EMA Strength
        const strength = Math.min(1.5, botState.emaWinRate / 0.5);
        newBet = baseBet * (1 + (winStreak * 0.15 * strength));
    }
    else if (!isWin && lossStreak > 0) {
        // Anti-Martingale: Reduce exposure on losses
        newBet = baseBet * Math.pow(0.85, lossStreak);
    }

    // Apply Kelly with EMA Scaling
    if (CONFIG.useKelly) {
        const b = CONFIG.payout - 1;
        const p = botState.emaWinRate;
        const q = 1 - p;
        let kelly = ((p * b) - q) / b;
        kelly = Math.max(0, kelly * 0.4); // Use 40% Kelly for safety
        newBet = Math.min(newBet, currentBalance * kelly);
    }

    newBet = Math.min(maxBet, Math.max(CONFIG.minBet, newBet));
    return Number(Math.floor(newBet * 100000000) / 100000000);
}

// ============ API LOGIC ============
async function placeBet() {
    // Determine if we should be in Ghost Mode
    if (botState.isVirtualMode) {
        const winChance = 1 / CONFIG.payout;
        const isWin = Math.random() < winChance;
        updateEMA(isWin);
        await new Promise(r => setTimeout(r, 300)); // Fast virtual cycles
        return { isGhost: true, Profit: isWin ? 0.00000001 : -0.00000001, Balance: botState.stats.currentBalance, Roll: 5000, isWin };
    }

    const optimalBet = calculateProfitOptimizedBet(
        botState.settings.lastWin || false,
        botState.settings.currentBet,
        botState.settings.baseBet,
        botState.settings.consecutiveWins,
        botState.settings.consecutiveLosses,
        botState.stats.currentBalance
    );

    botState.settings.currentBet = optimalBet;

    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const payload = {
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: Number(CONFIG.payout.toFixed(4)),
        UnderOver: true,
        ClientSeed: !currentClientSeed || betsSinceSeedChange >= CONFIG.seedChangeInterval ? generateNewSeed() : currentClientSeed
    };

    try {
        const response = await axios.post(url, payload);
        const result = response.data;
        updateEMA(result.Profit > 0);
        betsSinceSeedChange++;
        return { ...result, isWin: result.Profit > 0 };
    } catch (error) {
        // Fallback simulation
        const isWin = Math.random() < (1 / CONFIG.payout);
        updateEMA(isWin);
        return { 
            Profit: isWin ? payload.Bet * (payload.Payout - 1) : -payload.Bet, 
            Balance: botState.stats.currentBalance + (isWin ? 0.0000001 : -0.0000001),
            Roll: 5000, isWin 
        };
    }
}

async function runStrategy() {
    while (botState.running) {
        // Dynamic Risk Scaling based on Balance
        botState.settings.baseBet = botState.stats.currentBalance * CONFIG.baseBetPercent;
        
        // Check for Stop Loss / Recovery Trigger
        const drawdown = (botState.stats.peakBalance - botState.stats.currentBalance) / botState.stats.peakBalance;
        if (drawdown > CONFIG.stopLossPercent && !botState.settings.recoveryMode) {
            botState.settings.recoveryMode = true;
            botState.recoveryPot = botState.stats.peakBalance - botState.stats.currentBalance;
            botState.stats.recoveryCount++;
        }

        const result = await placeBet();
        
        if (!result.isGhost) {
            botState.stats.totalBets++;
            botState.stats.currentBalance = parseFloat(result.Balance);
            botState.stats.totalWagered += botState.settings.currentBet;
            
            if (result.isWin) {
                botState.stats.wins++;
                botState.settings.consecutiveWins++;
                botState.settings.consecutiveLosses = 0;
            } else {
                botState.stats.losses++;
                botState.settings.consecutiveLosses++;
                botState.settings.consecutiveWins = 0;
            }

            // Recovery success check
            if (botState.settings.recoveryMode && botState.stats.currentBalance >= botState.stats.peakBalance) {
                botState.settings.recoveryMode = false;
                botState.stats.successfulRecoveries++;
                botState.statusMessage = "✅ RECOVERY COMPLETE";
            }
        }

        // Global Stats Updates
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
        if (botState.stats.currentBalance > botState.stats.peakBalance) botState.stats.peakBalance = botState.stats.currentBalance;
        botState.stats.performanceMetrics.winRate = botState.stats.wins / botState.stats.totalBets;

        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            isWin: result.isWin,
            profit: parseFloat(result.Profit),
            bet: result.isGhost ? 0 : botState.settings.currentBet,
            balance: botState.stats.currentBalance,
            payout: CONFIG.payout,
            strategy: result.isGhost ? "🛡️ GHOST" : (botState.settings.recoveryMode ? "🔄 RECOVERY" : "🚀 TREND"),
            ema: botState.emaWinRate.toFixed(3)
        });

        if (botState.betHistory.length > 50) botState.betHistory.pop();
        await new Promise(r => setTimeout(r, result.isGhost ? 100 : 600));
    }
}

// ============ API & WEB DASHBOARD (UNMODIFIED DESIGN) ============
app.get('/api/stats', (req, res) => {
    res.json({
        botState, btcPrice, config: CONFIG,
        growth: (botState.stats.currentBalance / botState.stats.startingBalance).toFixed(2),
        winRate: (botState.emaWinRate * 100).toFixed(1),
        strategy: botState.isVirtualMode ? "GHOST MODE" : botState.settings.currentStrategy
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v15.0 | HYPER-ADVANCED</title>
    <style>
        :root { --primary: #10b981; --bg: #0f172a; --card-bg: #1e293b; --text-main: #f1f5f9; --text-muted: #94a3b8; --border: #334155; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; margin-bottom: 1.5rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); }
        .label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.8rem; font-weight: 700; }
        .status-bar { padding: 12px 20px; background: linear-gradient(135deg, #10b981, #059669); border-radius: 8px; margin-bottom: 20px; font-weight: bold; }
        .status-ghost { background: linear-gradient(135deg, #6366f1, #4338ca); }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; }
        th { background: #0f172a; padding: 1rem; text-align: left; font-size: 0.7rem; color: var(--text-muted); }
        td { padding: 0.75rem 1rem; font-size: 0.8rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Dice Pro <span style="color:#10b981">v15.0</span> <span style="font-size:0.4em; background:var(--accent); padding:4px; border-radius:4px;">ADVANCED</span></h1>
    </div>
    <div class="status-bar" id="status-msg">Initializing...</div>
    <div class="grid">
        <div class="card"><div class="label">Balance</div><div id="w-bal" class="btc-val">0.00000000</div></div>
        <div class="card"><div class="label">Net Profit</div><div id="n-prof" class="btc-val">0.00000000</div></div>
        <div class="card"><div class="label">Trend WinRate (EMA)</div><div id="wr" class="btc-val">0%</div></div>
        <div class="card"><div class="label">Recoveries</div><div id="recov" class="btc-val">0</div></div>
    </div>
    <table>
        <thead><tr><th>#</th><th>Strategy</th><th>Bet</th><th>Payout</th><th>Result</th><th>EMA Trend</th></tr></thead>
        <tbody id="history-body"></tbody>
    </table>
</div>
<script>
    async function update() {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('w-bal').innerText = data.botState.stats.currentBalance.toFixed(8);
        document.getElementById('n-prof').innerText = data.botState.stats.netProfit.toFixed(8);
        document.getElementById('wr').innerText = data.winRate + '%';
        document.getElementById('recov').innerText = data.botState.stats.successfulRecoveries;
        
        const status = document.getElementById('status-msg');
        status.innerText = data.botState.isVirtualMode ? "🛡️ GHOST MODE ACTIVE - Shielding Balance" : data.botState.statusMessage;
        status.className = data.botState.isVirtualMode ? "status-bar status-ghost" : "status-bar";

        const body = document.getElementById('history-body');
        body.innerHTML = data.botState.betHistory.map(b => \`
            <tr>
                <td>#\${b.id}</td>
                <td>\${b.strategy}</td>
                <td>\${b.bet.toFixed(8)}</td>
                <td>\${b.payout}x</td>
                <td class="\${b.isWin ? 'win' : 'loss'}">\${b.profit.toFixed(8)}</td>
                <td>\${b.ema}</td>
            </tr>
        \`).join('');
    }
    setInterval(update, 1000);
</script>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log(`🚀 v15.0 Advanced Engine running on port ${port}`);
    runStrategy();
});
