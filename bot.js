require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    // Dice game settings
    gameUrl: process.env.GAME_API_URL || 'https://api.crypto-game.com',
    apiKey: process.env.API_KEY,
    privateKey: process.env.PRIVATE_KEY,
    
    // Martingale settings
    baseBet: parseFloat(process.env.BASE_BET) || 1, // Starting bet in USDT/crypto
    multiplier: 1.2, // Bet increase per step (1.2x)
    stepDistancePct: 10, // Trigger next step at -10% ROI
    takeProfitPct: 15, // Take profit at +15% ROI
    maxSteps: 10, // Maximum martingale steps
    
    // Game settings
    winChance: parseFloat(process.env.WIN_CHANCE) || 49.5, // 49.5% = 2x payout
    payoutMultiplier: 2, // 2x payout for 49.5% win chance
    houseEdge: 1, // 1% house edge
    
    // Risk management
    maxBet: parseFloat(process.env.MAX_BET) || 1000,
    minBalance: parseFloat(process.env.MIN_BALANCE) || 10,
    riskPercent: 2, // Risk 2% of bankroll per sequence
    autoCompound: true,
    
    // Hedge betting (long/short equivalent)
    hedgeEnabled: process.env.HEDGE_ENABLED === 'true' || true,
    hedgeRatio: 0.5, // 50% of main bet on hedge
    
    // Monitoring
    port: process.env.PORT || 3000,
    pollInterval: 500
};

let game = {
    status: 'Active',
    balance: 0,
    initialBalance: 0,
    totalNetGain: 0,
    growthPct: 0,
    startTime: Date.now(),
    peakBalance: 0,
    maxDrawdown: 0,
    totalBets: 0,
    winningBets: 0,
    losingBets: 0,
    totalFeesPaid: 0,
    currentBaseBet: config.baseBet,
    currentRiskAmount: 0,
    lastPriceUpdate: Date.now(),
    balanceHistory: []
};

let betHistory = [];
let gameStates = {};

// Two "accounts" for hedging (long = over 50.5, short = under 49.5)
const gameAccounts = [
    { id: 1, direction: 'over', target: 50.5, description: 'OVER (Bullish)' },
    { id: 2, direction: 'under', target: 49.5, description: 'UNDER (Bearish)' }
];

gameAccounts.forEach((account, idx) => {
    gameStates[account.id] = {
        direction: account.direction,
        targetNumber: account.target,
        roi: 0,
        currentBet: 0,
        unrealizedProfit: 0,
        entryPrice: 0, // The number rolled
        currentEquity: 0,
        availableBalance: 0,
        initialEquity: null,
        isLocked: false,
        pendingBetId: null,
        lastAction: 'Idle',
        startTime: null,
        lastStepPrice: 0,
        lastAddedBet: 0,
        realizedPnl: 0,
        totalFees: 0,
        stepCount: 0,
        sequenceWins: 0,
        sequenceLosses: 0
    };
});

function calculateBetFromBalance(totalBalance) {
    if (!config.autoCompound || totalBalance <= 0) {
        return config.baseBet;
    }
    
    // Risk 2% of balance per sequence
    let betAmount = Math.floor(totalBalance * (config.riskPercent / 100));
    
    // Ensure minimum and maximum
    betAmount = Math.max(config.baseBet, betAmount);
    betAmount = Math.min(config.maxBet, betAmount);
    
    game.currentRiskAmount = betAmount * config.riskPercent / 100;
    
    console.log(`\n💰 AUTO-COMPOUNDING CALCULATION:`);
    console.log(`   Balance: $${totalBalance.toFixed(8)}`);
    console.log(`   ${config.riskPercent}% Risk: $${betAmount.toFixed(8)}`);
    console.log(`   Base Bet: ${betAmount.toFixed(8)} USDT`);
    console.log(`   Risk per bet: $${(betAmount * 0.02).toFixed(8)}\n`);
    
    return betAmount;
}

function calculateStepFromBet(currentBet, baseBet, multiplier) {
    if (currentBet === 0) return 0;
    
    let totalBet = 0;
    let step = 0;
    
    while (totalBet < currentBet) {
        const stepBet = step === 0 ? baseBet : Math.ceil(baseBet * Math.pow(multiplier, step));
        totalBet += stepBet;
        if (totalBet <= currentBet) {
            step++;
        } else {
            break;
        }
    }
    
    return step;
}

function calculateBetForStep(step, baseBet, multiplier) {
    let totalBet = 0;
    for (let i = 0; i <= step; i++) {
        const stepBet = i === 0 ? baseBet : Math.ceil(baseBet * Math.pow(multiplier, i));
        totalBet += stepBet;
    }
    return totalBet;
}

function calculateTargetNumber(state, currentNumber) {
    // For over bets: need a number above target (higher = win)
    // For under bets: need a number below target (lower = win)
    const requiredDistancePct = config.takeProfitPct / 100;
    
    if (state.direction === 'over') {
        // Win when number > target, profit based on how far above
        return state.targetNumber + (50 * requiredDistancePct);
    } else {
        // Win when number < target, profit based on how far below
        return state.targetNumber - (50 * requiredDistancePct);
    }
}

function updateBalanceGrowth(totalBalance) {
    const now = Date.now();
    
    const lastRecord = game.balanceHistory[game.balanceHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000 || Math.abs(lastRecord.balance - totalBalance) > 0.000001) {
        game.balanceHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            balance: totalBalance,
            pnl: totalBalance - game.initialBalance,
            pnlPercent: game.initialBalance > 0 ? ((totalBalance - game.initialBalance) / game.initialBalance) * 100 : 0,
            baseBet: game.currentBaseBet,
            riskAmount: game.currentRiskAmount
        });
        
        if (game.balanceHistory.length > 100) game.balanceHistory.shift();
    }
    
    if (totalBalance > game.peakBalance) {
        game.peakBalance = totalBalance;
    }
    
    if (game.peakBalance > 0) {
        const currentDrawdown = ((game.peakBalance - totalBalance) / game.peakBalance) * 100;
        if (currentDrawdown > game.maxDrawdown) {
            game.maxDrawdown = currentDrawdown;
        }
    }
}

async function placeBet(account, state, betAmount, isHedge = false) {
    try {
        // Random number generation for dice (0-100)
        const roll = Math.random() * 100;
        const won = state.direction === 'over' ? roll > state.targetNumber : roll < state.targetNumber;
        const payout = won ? betAmount * config.payoutMultiplier : 0;
        const profit = won ? (betAmount * config.payoutMultiplier) - betAmount : -betAmount;
        
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 100));
        
        return {
            success: true,
            betId: crypto.randomBytes(16).toString('hex'),
            roll: roll,
            won: won,
            betAmount: betAmount,
            payout: payout,
            profit: profit,
            rollNumber: roll.toFixed(2)
        };
        
    } catch (e) {
        console.error(`Bet Error: ${e.message}`);
        return { success: false, error: e.message };
    }
}

async function syncGameState(account, state) {
    const now = Date.now();
    
    // Simulate balance check (in real implementation, call game API)
    // For demo, we'll simulate balance changes
    if (game.initialBalance === 0 && game.balance > 0) {
        game.initialBalance = game.balance;
        game.peakBalance = game.balance;
    }
    
    state.currentEquity = game.balance;
    state.availableBalance = game.balance;
    
    if (state.initialEquity === null) {
        state.initialEquity = state.currentEquity;
    }
}

function logBetExchangeStyle(state, result, exitTime, finalRoi, finalPnl) {
    const step = calculateStepFromBet(state.currentBet, game.currentBaseBet, config.multiplier);
    const estimatedFee = Math.abs(finalPnl) * 0.01; // 1% fee estimate
    
    game.totalBets++;
    if (finalPnl >= 0) {
        game.winningBets++;
        state.sequenceWins++;
    } else {
        game.losingBets++;
        state.sequenceLosses++;
    }
    game.totalFeesPaid += estimatedFee;
    
    betHistory.unshift({
        direction: state.direction.toUpperCase(),
        rollNumber: result.rollNumber,
        betAmount: result.betAmount.toFixed(8),
        result: result.won ? 'WIN' : 'LOSS',
        profit: finalPnl.toFixed(8),
        step: step,
        roi: finalRoi.toFixed(2) + '%',
        time: exitTime,
        sequenceWins: state.sequenceWins,
        sequenceLosses: state.sequenceLosses
    });
    
    if (betHistory.length > 50) betHistory.pop();
    
    state.realizedPnl += finalPnl;
    state.totalFees += estimatedFee;
    
    console.log(`📊 ${state.direction.toUpperCase()} | Roll: ${result.rollNumber} | ${result.won ? 'WIN' : 'LOSS'} | ROI: ${finalRoi.toFixed(2)}% | PnL: ${finalPnl >= 0 ? '+' : ''}$${finalPnl.toFixed(8)}`);
}

async function processMartingale() {
    for (const account of gameAccounts) {
        const state = gameStates[account.id];
        if (state.isLocked) continue;
        
        // Get current bet amount based on auto-compounding
        const currentBaseBet = calculateBetFromBalance(game.balance);
        game.currentBaseBet = currentBaseBet;
        
        if (state.currentBet === 0) {
            // No active sequence, start new one
            const betAmount = currentBaseBet;
            
            console.log(`🎲 Starting ${state.direction} sequence with ${betAmount.toFixed(8)} USDT (${state.targetNumber} ${state.direction === 'over' ? '↑' : '↓'})`);
            state.isLocked = true;
            state.lastAction = "Placing Bet...";
            state.stepCount = 0;
            
            const result = await placeBet(account, state, betAmount);
            
            if (result.success) {
                state.pendingBetId = result.betId;
                state.currentBet = betAmount;
                state.entryPrice = result.rollNumber;
                state.lastStepPrice = result.rollNumber;
                state.lastAddedBet = betAmount;
                
                if (result.won) {
                    // Win on first bet - take profit
                    const profit = result.profit;
                    game.balance += profit;
                    const finalRoi = (profit / betAmount) * 100;
                    
                    logBetExchangeStyle(state, result, new Date().toLocaleString(), finalRoi, profit);
                    
                    // Reset sequence
                    state.currentBet = 0;
                    state.roi = 0;
                    state.unrealizedProfit = 0;
                    state.stepCount = 0;
                    state.lastStepPrice = 0;
                    state.startTime = null;
                    state.isLocked = false;
                } else {
                    // Loss on first bet - start martingale
                    state.startTime = new Date().toLocaleString();
                    state.roi = -100; // -100% ROI on lost bet
                    state.unrealizedProfit = result.profit;
                    state.isLocked = false;
                    console.log(`📉 LOSS on ${state.direction} - Starting martingale sequence`);
                }
            } else {
                state.isLocked = false;
                state.lastAction = "Bet Failed";
            }
            continue;
        }
        
        // We have an active sequence, check if we should add martingale step
        const currentStep = calculateStepFromBet(state.currentBet, currentBaseBet, config.multiplier);
        const totalLoss = Math.abs(state.unrealizedProfit);
        const lossPercent = (totalLoss / state.currentBet) * 100;
        
        // Trigger martingale step when loss reaches -10% or more
        if (lossPercent >= config.stepDistancePct && state.stepCount < config.maxSteps) {
            const nextStepNumber = currentStep + 1;
            let nextBet;
            
            if (nextStepNumber === 1) {
                nextBet = Math.ceil(currentBaseBet * config.multiplier);
            } else {
                nextBet = Math.ceil(currentBaseBet * Math.pow(config.multiplier, nextStepNumber));
            }
            
            // Cap at max bet
            nextBet = Math.min(nextBet, config.maxBet);
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} for ${state.direction} - Loss: ${lossPercent.toFixed(2)}% | Current Total: ${state.currentBet.toFixed(8)} | Adding: ${nextBet.toFixed(8)}`);
            state.isLocked = true;
            state.stepCount++;
            
            const result = await placeBet(account, state, nextBet);
            
            if (result.success) {
                state.pendingBetId = result.betId;
                state.currentBet += nextBet;
                state.lastAddedBet = nextBet;
                state.lastStepPrice = result.rollNumber;
                
                // Check if this win recovers all losses + profit
                const totalWon = result.won ? result.payout : 0;
                const totalInvested = state.currentBet;
                const netPosition = totalWon - totalInvested;
                
                if (result.won && netPosition > 0) {
                    // Martingale succeeded - take profit
                    const finalRoi = (netPosition / state.currentBet) * 100;
                    console.log(`🎉 MARTINGALE SUCCESS! ${state.direction} | Recovered ${totalInvested.toFixed(8)} + Profit ${netPosition.toFixed(8)}`);
                    
                    game.balance += netPosition;
                    logBetExchangeStyle(state, result, new Date().toLocaleString(), finalRoi, netPosition);
                    
                    // Reset sequence
                    state.currentBet = 0;
                    state.roi = 0;
                    state.unrealizedProfit = 0;
                    state.stepCount = 0;
                    state.lastStepPrice = 0;
                    state.startTime = null;
                    state.isLocked = false;
                } else if (result.won && netPosition <= 0) {
                    // Win but not enough to recover - keep sequence
                    state.unrealizedProfit += result.profit;
                    state.roi = (state.unrealizedProfit / state.currentBet) * 100;
                    state.isLocked = false;
                    console.log(`⚠️ Partial recovery - still down ${Math.abs(state.unrealizedProfit).toFixed(8)}`);
                } else {
                    // Loss - continue martingale
                    state.unrealizedProfit += result.profit;
                    state.roi = (state.unrealizedProfit / state.currentBet) * 100;
                    state.isLocked = false;
                    
                    if (state.stepCount >= config.maxSteps) {
                        console.log(`💥 MAX STEPS REACHED for ${state.direction} - Total loss: ${Math.abs(state.unrealizedProfit).toFixed(8)}`);
                        game.balance += state.unrealizedProfit; // Realize loss
                        logBetExchangeStyle(state, result, new Date().toLocaleString(), state.roi, state.unrealizedProfit);
                        
                        // Reset sequence
                        state.currentBet = 0;
                        state.roi = 0;
                        state.unrealizedProfit = 0;
                        state.stepCount = 0;
                        state.lastStepPrice = 0;
                        state.startTime = null;
                        state.isLocked = false;
                    }
                }
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        } else {
            const step = calculateStepFromBet(state.currentBet, currentBaseBet, config.multiplier);
            state.lastAction = `Active - Step ${step} | Total Bet: ${state.currentBet.toFixed(8)} | Loss: ${Math.abs(state.unrealizedProfit).toFixed(8)}`;
        }
    }
}

async function backgroundLoop() {
    try {
        // Update game.balance (simulate or fetch from API)
        // For demo, balance is updated in bet results
        
        for (const account of gameAccounts) {
            await syncGameState(account, gameStates[account.id]);
        }
        
        const s1 = gameStates[1];
        const s2 = gameStates[2];
        
        if (game.initialBalance === 0 && game.balance > 0) {
            game.initialBalance = game.balance;
            game.peakBalance = game.balance;
            console.log(`\n💰 INITIAL BALANCE: $${game.initialBalance.toFixed(8)} USDT\n`);
        }
        
        if (game.initialBalance > 0) {
            const totalBalance = game.balance;
            
            game.totalNetGain = totalBalance - game.initialBalance;
            game.growthPct = (game.totalNetGain / game.initialBalance) * 100;
            const elapsedHours = (Date.now() - game.startTime) / (1000 * 60 * 60);
            game.dgr = elapsedHours > 0 ? (game.growthPct / elapsedHours) : 0;
            
            updateBalanceGrowth(totalBalance);
            
            const lastRecord = game.balanceHistory[game.balanceHistory.length - 2];
            if (lastRecord && Math.abs(game.growthPct - lastRecord.pnlPercent) > 0.1) {
                console.log(`💰 BALANCE: $${totalBalance.toFixed(8)} | PnL: ${game.totalNetGain >= 0 ? '+' : ''}$${game.totalNetGain.toFixed(8)} (${game.growthPct >= 0 ? '+' : ''}${game.growthPct.toFixed(2)}%)`);
                console.log(`   Base Bet: ${game.currentBaseBet.toFixed(8)} USDT | Risk: $${game.currentRiskAmount.toFixed(8)}`);
            }
        }
        
        if (game.status === 'Active') {
            await processMartingale();
        }
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// Express API endpoints
app.get('/api/status', (req, res) => {
    const totalBalance = game.balance;
    
    const accountsWithInfo = Object.values(gameStates).map(state => {
        const step = calculateStepFromBet(state.currentBet, game.currentBaseBet, config.multiplier);
        return {
            direction: state.direction,
            targetNumber: state.targetNumber,
            roi: state.roi,
            currentBet: state.currentBet,
            step: step,
            unrealizedProfit: state.unrealizedProfit,
            lastAction: state.lastAction,
            startTime: state.startTime,
            realizedPnl: state.realizedPnl,
            totalFees: state.totalFees,
            sequenceWins: state.sequenceWins,
            sequenceLosses: state.sequenceLosses
        };
    });
    
    res.json({
        game: {
            ...game,
            balance: totalBalance,
            totalNetGain: game.totalNetGain,
            growthPct: game.growthPct,
            peakBalance: game.peakBalance,
            maxDrawdown: game.maxDrawdown,
            totalBets: game.totalBets,
            winningBets: game.winningBets,
            losingBets: game.losingBets,
            winRate: game.totalBets > 0 ? (game.winningBets / game.totalBets * 100).toFixed(1) : 0,
            balanceHistory: game.balanceHistory.slice(-20),
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent,
            currentBaseBet: game.currentBaseBet,
            currentRiskAmount: game.currentRiskAmount
        },
        accounts: accountsWithInfo,
        betHistory: betHistory.slice(0, 20),
        config: {
            winChance: config.winChance,
            payoutMultiplier: config.payoutMultiplier,
            takeProfitPct: config.takeProfitPct,
            stepDistancePct: config.stepDistancePct,
            maxSteps: config.maxSteps,
            baseBet: game.currentBaseBet,
            multiplier: config.multiplier,
            autoCompound: config.autoCompound,
            riskPercent: config.riskPercent
        }
    });
});

app.post('/api/bet', async (req, res) => {
    const { direction, amount } = req.body;
    const account = gameAccounts.find(a => a.direction === direction);
    if (!account) {
        return res.status(400).json({ error: 'Invalid direction' });
    }
    
    const state = gameStates[account.id];
    if (state.isLocked) {
        return res.status(400).json({ error: 'Game is locked' });
    }
    
    const result = await placeBet(account, state, amount || game.currentBaseBet);
    res.json(result);
});

app.post('/api/reset', async (req, res) => {
    console.log("🔄 Resetting game state...");
    game.balance = game.initialBalance;
    game.totalBets = 0;
    game.winningBets = 0;
    game.losingBets = 0;
    
    for (const state of Object.values(gameStates)) {
        state.currentBet = 0;
        state.roi = 0;
        state.unrealizedProfit = 0;
        state.stepCount = 0;
        state.sequenceWins = 0;
        state.sequenceLosses = 0;
        state.realizedPnl = 0;
    }
    
    res.json({ status: 'ok' });
});

app.post('/api/set-balance', async (req, res) => {
    const { balance } = req.body;
    game.balance = parseFloat(balance);
    if (game.initialBalance === 0) {
        game.initialBalance = game.balance;
    }
    res.json({ status: 'ok', balance: game.balance });
});

// HTML Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dice Martingale Pro - Auto-Compounding</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .stat-number { font-size: 28px; font-weight: 900; }
        .dice { font-size: 48px; font-weight: bold; }
        .win { color: #00D1B2; }
        .loss { color: #FF4D6D; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">🎲 DICE MARTINGALE <span class="text-indigo-500">PRO</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                    <span class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    <span class="text-[10px] text-slate-500">49.5% Win Chance</span>
                    <span class="text-[10px] text-slate-500">2x Payout</span>
                </div>
            </div>
            <div>
                <button onclick="resetGame()" class="bg-yellow-500/20 border border-yellow-500 text-yellow-500 px-4 py-2 rounded">🔄 RESET</button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="card">
                <p class="stat-label">BALANCE</p>
                <p id="balance" class="stat-number value-positive">$0.00</p>
                <div class="mt-4">
                    <input type="number" id="setBalance" placeholder="Set balance" class="bg-black/30 p-2 rounded">
                    <button onclick="setBalance()" class="ml-2 bg-indigo-500/20 border border-indigo-500 px-4 py-2 rounded">SET</button>
                </div>
            </div>
            <div class="card">
                <p class="stat-label">PERFORMANCE</p>
                <p id="pnl" class="stat-number">$0.00</p>
                <p id="winRate" class="text-sm text-green-400 mt-2">Win Rate: 0%</p>
                <p id="totalBets" class="text-xs text-slate-400">Total Bets: 0</p>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">🎯 ACTIVE SEQUENCES</h3>
            <div class="grid grid-cols-2 gap-4">
                <div id="overStatus" class="p-4 bg-black/20 rounded">
                    <p class="text-xl font-bold text-green-400">OVER (50.5+)</p>
                    <p id="overRoi" class="text-2xl font-black mt-2">0%</p>
                    <p id="overBet" class="text-sm">Bet: $0.00</p>
                    <p id="overStep" class="text-xs text-slate-400">Step 0</p>
                </div>
                <div id="underStatus" class="p-4 bg-black/20 rounded">
                    <p class="text-xl font-bold text-red-400">UNDER (49.5-)</p>
                    <p id="underRoi" class="text-2xl font-black mt-2">0%</p>
                    <p id="underBet" class="text-sm">Bet: $0.00</p>
                    <p id="underStep" class="text-xs text-slate-400">Step 0</p>
                </div>
            </div>
        </div>

        <div class="card">
            <h3 class="font-bold mb-4">📊 BET HISTORY</h3>
            <div class="overflow-x-auto max-h-96 overflow-y-auto">
                <table class="w-full">
                    <thead class="bg-[#0F141C] sticky top-0">
                        <tr>
                            <th class="text-left p-3">DIR</th>
                            <th class="text-left p-3">ROLL</th>
                            <th class="text-right p-3">BET</th>
                            <th class="text-right p-3">RESULT</th>
                            <th class="text-right p-3">PROFIT</th>
                            <th class="text-right p-3">STEP</th>
                            <th class="text-right p-3">ROI</th>
                        </tr>
                    </thead>
                    <tbody id="betsBody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        async function setBalance() {
            const balance = document.getElementById('setBalance').value;
            await fetch('/api/set-balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ balance: parseFloat(balance) })
            });
        }
        
        async function resetGame() {
            if(confirm('Reset all stats?')) {
                await fetch('/api/reset', {method: 'POST'});
            }
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('balance').textContent = '$' + (data.game.balance || 0).toFixed(8);
                document.getElementById('pnl').textContent = (data.game.totalNetGain >= 0 ? '+' : '') + '$' + (data.game.totalNetGain || 0).toFixed(8);
                document.getElementById('winRate').textContent = 'Win Rate: ' + (data.game.winRate || 0) + '%';
                document.getElementById('totalBets').textContent = 'Total Bets: ' + (data.game.totalBets || 0);
                
                const over = data.accounts.find(a => a.direction === 'over');
                const under = data.accounts.find(a => a.direction === 'under');
                
                if (over) {
                    document.getElementById('overRoi').textContent = (over.roi || 0).toFixed(2) + '%';
                    document.getElementById('overRoi').className = 'text-2xl font-black ' + (over.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('overBet').textContent = 'Bet: $' + (over.currentBet || 0).toFixed(8);
                    document.getElementById('overStep').textContent = 'Step ' + (over.step || 0) + ' | ' + (over.lastAction || 'Idle');
                }
                
                if (under) {
                    document.getElementById('underRoi').textContent = (under.roi || 0).toFixed(2) + '%';
                    document.getElementById('underRoi').className = 'text-2xl font-black ' + (under.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('underBet').textContent = 'Bet: $' + (under.currentBet || 0).toFixed(8);
                    document.getElementById('underStep').textContent = 'Step ' + (under.step || 0) + ' | ' + (under.lastAction || 'Idle');
                }
                
                let betsHtml = '';
                if (data.betHistory && data.betHistory.length > 0) {
                    data.betHistory.forEach(b => {
                        betsHtml += '<tr class="border-b border-[#1A212E]">' +
                            '<td class="p-3"><span class="' + (b.direction === 'OVER' ? 'text-green-400' : 'text-red-400') + ' font-bold">' + b.direction + '</span></td>' +
                            '<td class="p-3 font-mono">' + b.rollNumber + '</td>' +
                            '<td class="p-3 text-right">$' + b.betAmount + '</td>' +
                            '<td class="p-3 text-right"><span class="' + (b.result === 'WIN' ? 'text-green-400' : 'text-red-400') + '">' + b.result + '</span></td>' +
                            '<td class="p-3 text-right ' + (parseFloat(b.profit) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(b.profit) >= 0 ? '+' : '') + '$' + b.profit + '</td>' +
                            '<td class="p-3 text-right">' + b.step + '</td>' +
                            '<td class="p-3 text-right ' + (parseFloat(b.roi) >= 0 ? 'value-positive' : 'value-negative') + '">' + b.roi + '</td>' +
                        '</tr>';
                    });
                }
                document.getElementById('betsBody').innerHTML = betsHtml || '<tr><td colspan="7" class="text-center text-slate-500 p-12">No bets yet</td></tr>';
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>
    `);
});

// Initialize with starting balance
game.balance = parseFloat(process.env.STARTING_BALANCE) || 1000;
game.initialBalance = game.balance;
game.peakBalance = game.balance;

// Start the bot
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n🎲 DICE MARTINGALE PRO STARTED`);
    console.log(`🎯 Win Chance: ${config.winChance}% (2x payout)`);
    console.log(`📈 Martingale Step Trigger: -${config.stepDistancePct}% loss`);
    console.log(`💰 Take Profit: ${config.takeProfitPct}% ROI`);
    console.log(`🎲 Auto-Compounding: ${config.riskPercent}% of balance`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
    console.log(`💰 Starting Balance: $${game.balance}\n`);
});
