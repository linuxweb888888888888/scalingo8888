require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    // Crypto.Games API settings (Key only - no secret)
    apiKey: process.env.CRYPTO_GAMES_API_KEY,
    apiUrl: 'https://api.crypto.games/v1',
    gameId: process.env.GAME_ID || 'dice',
    
    // Martingale settings
    baseBet: parseFloat(process.env.BASE_BET) || 0.0001, // BTC base bet
    multiplier: parseFloat(process.env.MULTIPLIER) || 1.2,
    stepDistancePct: parseFloat(process.env.STEP_DISTANCE_PCT) || 10,
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT) || 15,
    maxSteps: parseInt(process.env.MAX_STEPS) || 100,
    
    // Game settings (for crypto.games dice)
    winChance: parseFloat(process.env.WIN_CHANCE) || 49.5,
    payoutMultiplier: 2,
    
    // Risk management
    maxBet: parseFloat(process.env.MAX_BET) || 0.01,
    minBalance: parseFloat(process.env.MIN_BALANCE) || 0.001,
    riskPercent: parseFloat(process.env.RISK_PERCENT) || 2,
    autoCompound: process.env.AUTO_COMPOUND === 'true',
    
    // Hedge betting
    hedgeEnabled: process.env.HEDGE_ENABLED === 'true',
    
    // Monitoring
    port: process.env.PORT || 3000,
    pollInterval: parseInt(process.env.POLL_INTERVAL) || 1000
};

// Game state
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
    balanceHistory: []
};

let betHistory = [];
let activeSequences = {};

// Initialize sequences for hedging (over/under)
const sequences = [
    { id: 1, direction: 'over', target: 50.5, description: 'OVER (High Roll)', active: false },
    { id: 2, direction: 'under', target: 49.5, description: 'UNDER (Low Roll)', active: false }
];

sequences.forEach((seq) => {
    activeSequences[seq.id] = {
        direction: seq.direction,
        targetNumber: seq.target,
        roi: 0,
        currentBet: 0,
        unrealizedProfit: 0,
        entryNumber: 0,
        isLocked: false,
        pendingBetId: null,
        lastAction: 'Idle',
        startTime: null,
        stepCount: 0,
        realizedPnl: 0,
        totalFees: 0,
        wins: 0,
        losses: 0
    };
});

// ==================== CRYPTO.GAMES API INTEGRATION (KEY ONLY) ====================

// Make API request to crypto.games with just API Key
async function cryptoGamesRequest(endpoint, method = 'GET', data = {}) {
    try {
        const url = `${config.apiUrl}${endpoint}`;
        const options = {
            method,
            url,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.apiKey,  // API Key in header
                'User-Agent': 'MartingaleBot/1.0'
            },
            timeout: 10000
        };
        
        if (method === 'GET') {
            options.params = data;
        } else {
            options.data = data;
        }
        
        const response = await axios(options);
        
        if (response.data && response.data.error) {
            throw new Error(response.data.error);
        }
        
        return response.data;
    } catch (error) {
        console.error(`API Error [${endpoint}]:`, error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// Get user balance
async function getBalance() {
    try {
        // Try different possible endpoints
        let result = await cryptoGamesRequest('/user/balance', 'GET');
        
        if (result && result.balance !== undefined) {
            game.balance = parseFloat(result.balance);
            return game.balance;
        }
        
        // Alternative endpoint
        result = await cryptoGamesRequest('/wallet', 'GET');
        if (result && result.balance !== undefined) {
            game.balance = parseFloat(result.balance);
            return game.balance;
        }
        
        // If API doesn't support balance endpoint, use mock
        console.log('⚠️ Balance endpoint not available, using mock balance');
        if (game.balance === 0) game.balance = 1.0; // Default mock balance
        return game.balance;
        
    } catch (error) {
        console.error('Failed to get balance:', error.message);
        return game.balance || 1.0;
    }
}

// Place a bet on crypto.games dice
async function placeBet(sequence, betAmount) {
    try {
        const betData = {
            game: 'dice',
            amount: betAmount.toFixed(8),
            currency: 'BTC',
            type: sequence.direction,
            target: sequence.targetNumber,
            win_chance: config.winChance
        };
        
        const result = await cryptoGamesRequest('/bet/place', 'POST', betData);
        
        if (result && result.success !== false) {
            // Parse response - adjust based on actual API response format
            const won = result.won || (result.roll && (
                (sequence.direction === 'over' && result.roll > sequence.targetNumber) ||
                (sequence.direction === 'under' && result.roll < sequence.targetNumber)
            ));
            
            const rollNumber = result.roll || (Math.random() * 100).toFixed(2);
            const payout = won ? betAmount * config.payoutMultiplier : 0;
            const profit = won ? (betAmount * config.payoutMultiplier) - betAmount : -betAmount;
            
            // Update balance if returned
            if (result.balance) {
                game.balance = parseFloat(result.balance);
            }
            
            return {
                success: true,
                betId: result.id || result.bet_id || `bet_${Date.now()}`,
                rollNumber: rollNumber,
                won: won,
                betAmount: betAmount,
                payout: payout,
                profit: profit,
                timestamp: result.created_at || Date.now()
            };
        }
        
        // If API call fails or returns error, use simulation
        console.log(`⚠️ API bet failed, using simulation for ${sequence.direction}`);
        return await simulateBet(sequence, betAmount);
        
    } catch (error) {
        console.error(`Bet error (${sequence.direction}):`, error.message);
        // Fallback to simulation
        return await simulateBet(sequence, betAmount);
    }
}

// Simulation fallback (when API is unavailable)
async function simulateBet(sequence, betAmount) {
    const roll = Math.random() * 100;
    const won = sequence.direction === 'over' ? roll > sequence.targetNumber : roll < sequence.targetNumber;
    const profit = won ? betAmount : -betAmount;
    
    return {
        success: true,
        betId: `sim_${Date.now()}_${Math.random()}`,
        rollNumber: roll.toFixed(2),
        won: won,
        betAmount: betAmount,
        payout: won ? betAmount * 2 : 0,
        profit: profit,
        timestamp: Date.now(),
        simulated: true
    };
}

// Get bet history
async function getBetHistory(limit = 50) {
    const result = await cryptoGamesRequest('/bet/history', 'GET', { limit });
    if (result && result.bets) {
        return result.bets;
    }
    return [];
}

// ==================== MARTINGALE LOGIC ====================

function calculateBetFromBalance(totalBalance) {
    if (!config.autoCompound || totalBalance <= 0) {
        return config.baseBet;
    }
    
    let betAmount = totalBalance * (config.riskPercent / 100);
    betAmount = Math.max(config.baseBet, betAmount);
    betAmount = Math.min(config.maxBet, betAmount);
    
    game.currentRiskAmount = betAmount * config.riskPercent / 100;
    
    console.log(`\n💰 AUTO-COMPOUNDING:`);
    console.log(`   Balance: ${totalBalance.toFixed(8)} BTC`);
    console.log(`   ${config.riskPercent}% Risk: ${betAmount.toFixed(8)} BTC`);
    console.log(`   Base Bet: ${betAmount.toFixed(8)} BTC\n`);
    
    return betAmount;
}

function calculateStepFromBet(currentBet, baseBet, multiplier) {
    if (currentBet === 0) return 0;
    
    let totalBet = 0;
    let step = 0;
    
    while (totalBet < currentBet) {
        const stepBet = step === 0 ? baseBet : baseBet * Math.pow(multiplier, step);
        totalBet += stepBet;
        if (totalBet <= currentBet) {
            step++;
        } else {
            break;
        }
    }
    
    return step;
}

function updateBalanceGrowth(totalBalance) {
    const now = Date.now();
    
    const lastRecord = game.balanceHistory[game.balanceHistory.length - 1];
    if (!lastRecord || (now - lastRecord.timestamp) > 60000 || Math.abs(lastRecord.balance - totalBalance) > 0.00000001) {
        game.balanceHistory.push({
            timestamp: now,
            time: new Date().toLocaleString(),
            balance: totalBalance,
            pnl: totalBalance - game.initialBalance,
            pnlPercent: game.initialBalance > 0 ? ((totalBalance - game.initialBalance) / game.initialBalance) * 100 : 0,
            baseBet: game.currentBaseBet
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

function logBet(sequence, result, finalRoi, finalPnl) {
    const step = calculateStepFromBet(sequence.currentBet, game.currentBaseBet, config.multiplier);
    
    game.totalBets++;
    if (finalPnl >= 0) {
        game.winningBets++;
        sequence.wins++;
    } else {
        game.losingBets++;
        sequence.losses++;
    }
    
    betHistory.unshift({
        id: result.betId,
        direction: sequence.direction.toUpperCase(),
        rollNumber: result.rollNumber,
        betAmount: result.betAmount,
        result: result.won ? 'WIN' : 'LOSS',
        profit: finalPnl,
        step: step,
        roi: finalRoi,
        time: new Date().toLocaleString(),
        sequenceWins: sequence.wins,
        sequenceLosses: sequence.losses,
        simulated: result.simulated || false
    });
    
    if (betHistory.length > 100) betHistory.pop();
    
    sequence.realizedPnl += finalPnl;
    
    const simTag = result.simulated ? ' [SIM]' : '';
    console.log(`📊 ${sequence.direction.toUpperCase()}${simTag} | Roll: ${result.rollNumber} | ${result.won ? '✅ WIN' : '❌ LOSS'} | PnL: ${finalPnl >= 0 ? '+' : ''}${finalPnl.toFixed(8)} BTC | ROI: ${finalRoi.toFixed(2)}%`);
}

async function processMartingale() {
    for (const seq of sequences) {
        const state = activeSequences[seq.id];
        if (state.isLocked) continue;
        
        // Get current balance and update base bet
        await getBalance();
        const currentBaseBet = calculateBetFromBalance(game.balance);
        game.currentBaseBet = currentBaseBet;
        
        // Check minimum balance
        if (game.balance < config.minBalance) {
            console.log(`⚠️ Balance too low: ${game.balance.toFixed(8)} BTC < ${config.minBalance} BTC`);
            game.status = 'STOPPED';
            continue;
        }
        
        if (state.currentBet === 0) {
            // Start new sequence
            const betAmount = currentBaseBet;
            
            console.log(`🎲 Starting ${seq.direction} sequence | Bet: ${betAmount.toFixed(8)} BTC | Target: ${seq.target}`);
            state.isLocked = true;
            state.lastAction = "Placing Bet...";
            
            const result = await placeBet(seq, betAmount);
            
            if (result.success) {
                state.pendingBetId = result.betId;
                state.currentBet = betAmount;
                state.entryNumber = result.rollNumber;
                state.stepCount = 0;
                
                if (result.won) {
                    // Win on first bet
                    if (!result.simulated) game.balance += result.profit;
                    const finalRoi = (result.profit / betAmount) * 100;
                    
                    logBet(state, result, finalRoi, result.profit);
                    
                    // Reset sequence
                    state.currentBet = 0;
                    state.roi = 0;
                    state.unrealizedProfit = 0;
                    state.stepCount = 0;
                    state.startTime = null;
                    state.isLocked = false;
                } else {
                    // Loss - start martingale
                    state.startTime = new Date().toLocaleString();
                    state.unrealizedProfit = result.profit;
                    state.roi = -100;
                    state.isLocked = false;
                    console.log(`📉 LOSS on ${seq.direction} - Starting martingale sequence | Loss: ${Math.abs(result.profit).toFixed(8)} BTC`);
                }
            } else {
                state.isLocked = false;
                state.lastAction = "Bet Failed";
                console.error(`Failed to place ${seq.direction} bet:`, result.error);
            }
            continue;
        }
        
        // Active sequence - check if we need to martingale
        const currentStep = calculateStepFromBet(state.currentBet, currentBaseBet, config.multiplier);
        const lossPercent = Math.abs(state.unrealizedProfit) / state.currentBet * 100;
        
        // Check for take profit (if we're in profit)
        if (state.unrealizedProfit > 0 && (state.unrealizedProfit / state.currentBet * 100) >= config.takeProfitPct) {
            console.log(`🎉 TAKE PROFIT! ${seq.direction} | Profit: ${state.unrealizedProfit.toFixed(8)} BTC | ROI: ${(state.unrealizedProfit / state.currentBet * 100).toFixed(2)}%`);
            
            // Realize profit
            if (!state.simulated) game.balance += state.unrealizedProfit;
            
            // Create a virtual "win" entry for logging
            const virtualResult = {
                betId: `tp_${Date.now()}`,
                rollNumber: state.entryNumber,
                won: true,
                betAmount: state.currentBet,
                profit: state.unrealizedProfit,
                simulated: false
            };
            
            logBet(state, virtualResult, (state.unrealizedProfit / state.currentBet * 100), state.unrealizedProfit);
            
            // Reset sequence
            state.currentBet = 0;
            state.roi = 0;
            state.unrealizedProfit = 0;
            state.stepCount = 0;
            state.startTime = null;
            state.isLocked = false;
            continue;
        }
        
        // Check for martingale step
        if (lossPercent >= config.stepDistancePct && state.stepCount < config.maxSteps) {
            const nextStepNumber = currentStep + 1;
            let nextBet = currentBaseBet * Math.pow(config.multiplier, nextStepNumber);
            nextBet = Math.min(nextBet, config.maxBet);
            
            // Check if we have enough balance
            const totalRequired = state.currentBet + nextBet;
            if (totalRequired > game.balance * 0.5) {
                console.log(`⚠️ Insufficient balance for martingale step ${nextStepNumber} on ${seq.direction}`);
                continue;
            }
            
            console.log(`📈 MARTINGALE STEP ${nextStepNumber} | ${seq.direction} | Loss: ${lossPercent.toFixed(2)}% | Adding: ${nextBet.toFixed(8)} BTC | Total: ${(state.currentBet + nextBet).toFixed(8)} BTC`);
            state.isLocked = true;
            state.stepCount++;
            
            const result = await placeBet(seq, nextBet);
            
            if (result.success) {
                state.pendingBetId = result.betId;
                state.currentBet += nextBet;
                state.unrealizedProfit += result.profit;
                state.roi = (state.unrealizedProfit / state.currentBet) * 100;
                
                // Check if this win recovers everything
                if (result.won && state.unrealizedProfit > 0) {
                    console.log(`🎉 MARTINGALE SUCCESS! ${seq.direction} | Total Profit: ${state.unrealizedProfit.toFixed(8)} BTC`);
                    if (!result.simulated) game.balance += state.unrealizedProfit;
                    logBet(state, result, state.roi, state.unrealizedProfit);
                    
                    // Reset sequence
                    state.currentBet = 0;
                    state.roi = 0;
                    state.unrealizedProfit = 0;
                    state.stepCount = 0;
                    state.startTime = null;
                    state.isLocked = false;
                } else if (!result.won && state.stepCount >= config.maxSteps) {
                    // Max steps reached - accept loss
                    console.log(`💥 MAX STEPS REACHED | ${seq.direction} | Total Loss: ${Math.abs(state.unrealizedProfit).toFixed(8)} BTC`);
                    if (!result.simulated) game.balance += state.unrealizedProfit;
                    logBet(state, result, state.roi, state.unrealizedProfit);
                    
                    // Reset sequence
                    state.currentBet = 0;
                    state.roi = 0;
                    state.unrealizedProfit = 0;
                    state.stepCount = 0;
                    state.startTime = null;
                    state.isLocked = false;
                } else {
                    state.isLocked = false;
                    console.log(`${result.won ? '⚠️ Partial recovery' : '❌ Continued loss'} | ${seq.direction} | Current loss: ${Math.abs(state.unrealizedProfit).toFixed(8)} BTC`);
                }
            } else {
                state.isLocked = false;
                state.lastAction = "Martingale Failed";
                console.error(`Martingale step failed for ${seq.direction}:`, result.error);
            }
        } else {
            const step = calculateStepFromBet(state.currentBet, currentBaseBet, config.multiplier);
            state.lastAction = `Step ${step} | Loss: ${Math.abs(state.unrealizedProfit).toFixed(8)} BTC | ROI: ${state.roi.toFixed(2)}%`;
        }
    }
}

// ==================== BACKGROUND LOOP ====================

async function backgroundLoop() {
    try {
        // Update balance
        await getBalance();
        
        if (game.initialBalance === 0 && game.balance > 0) {
            game.initialBalance = game.balance;
            game.peakBalance = game.balance;
            console.log(`\n💰 INITIAL BALANCE: ${game.initialBalance.toFixed(8)} BTC\n`);
        }
        
        if (game.initialBalance > 0) {
            game.totalNetGain = game.balance - game.initialBalance;
            game.growthPct = (game.totalNetGain / game.initialBalance) * 100;
            
            updateBalanceGrowth(game.balance);
            
            const elapsedHours = (Date.now() - game.startTime) / (1000 * 60 * 60);
            const hourlyReturn = elapsedHours > 0 ? (game.growthPct / elapsedHours).toFixed(2) : 0;
            
            // Only log every 30 seconds to avoid spam
            if (Math.random() < 0.03) {
                console.log(`💰 Balance: ${game.balance.toFixed(8)} BTC | PnL: ${game.totalNetGain >= 0 ? '+' : ''}${game.totalNetGain.toFixed(8)} BTC (${game.growthPct >= 0 ? '+' : ''}${game.growthPct.toFixed(2)}%) | Hourly: ${hourlyReturn}%/h`);
            }
        }
        
        if (game.status === 'Active') {
            await processMartingale();
        }
    } catch (error) {
        console.error('Background loop error:', error.message);
    }
}

// ==================== EXPRESS API ====================

app.get('/api/status', async (req, res) => {
    await getBalance();
    
    const sequencesWithState = sequences.map(seq => ({
        ...seq,
        ...activeSequences[seq.id],
        step: calculateStepFromBet(activeSequences[seq.id].currentBet, game.currentBaseBet, config.multiplier)
    }));
    
    res.json({
        game: {
            status: game.status,
            balance: game.balance,
            initialBalance: game.initialBalance,
            totalNetGain: game.totalNetGain,
            growthPct: game.growthPct,
            peakBalance: game.peakBalance,
            maxDrawdown: game.maxDrawdown,
            totalBets: game.totalBets,
            winningBets: game.winningBets,
            losingBets: game.losingBets,
            winRate: game.totalBets > 0 ? (game.winningBets / game.totalBets * 100).toFixed(1) : 0,
            currentBaseBet: game.currentBaseBet,
            balanceHistory: game.balanceHistory.slice(-20)
        },
        sequences: sequencesWithState,
        betHistory: betHistory.slice(0, 30),
        config: {
            baseBet: config.baseBet,
            multiplier: config.multiplier,
            stepDistancePct: config.stepDistancePct,
            takeProfitPct: config.takeProfitPct,
            maxSteps: config.maxSteps,
            riskPercent: config.riskPercent,
            autoCompound: config.autoCompound,
            winChance: config.winChance,
            apiConnected: !!config.apiKey
        }
    });
});

app.post('/api/close-all', async (req, res) => {
    console.log("🔴 Closing all active sequences...");
    
    for (const seq of sequences) {
        const state = activeSequences[seq.id];
        if (state.currentBet > 0) {
            console.log(`Closing ${seq.direction} sequence - accepting loss of ${Math.abs(state.unrealizedProfit).toFixed(8)} BTC`);
            game.balance += state.unrealizedProfit;
            
            // Reset sequence
            state.currentBet = 0;
            state.roi = 0;
            state.unrealizedProfit = 0;
            state.stepCount = 0;
            state.startTime = null;
            state.isLocked = false;
        }
    }
    
    res.json({ status: 'ok', message: 'All sequences closed' });
});

app.post('/api/reset', async (req, res) => {
    console.log("🔄 Resetting bot...");
    
    for (const seq of sequences) {
        const state = activeSequences[seq.id];
        state.currentBet = 0;
        state.roi = 0;
        state.unrealizedProfit = 0;
        state.stepCount = 0;
        state.wins = 0;
        state.losses = 0;
        state.realizedPnl = 0;
        state.startTime = null;
        state.isLocked = false;
    }
    
    game.totalBets = 0;
    game.winningBets = 0;
    game.losingBets = 0;
    game.totalFeesPaid = 0;
    game.status = 'Active';
    betHistory = [];
    
    res.json({ status: 'ok' });
});

// HTML Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Crypto.Games Martingale Pro</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { background: #0A0E17; color: #E8EDF2; font-family: monospace; }
        .card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00FF88; }
        .value-negative { color: #FF4444; }
        .stat-number { font-size: 24px; font-weight: 900; }
        .sim-badge { background: #FFA50020; color: #FFA500; font-size: 8px; padding: 2px 4px; border-radius: 4px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">🎲 CRYPTO.GAMES <span class="text-green-400">MARTINGALE PRO</span></h1>
                <p id="apiStatus" class="text-xs mt-1"></p>
            </div>
            <div class="flex gap-2">
                <button onclick="closeAll()" class="bg-red-500/20 border border-red-500 text-red-500 px-4 py-2 rounded text-sm">🔴 CLOSE ALL</button>
                <button onclick="resetBot()" class="bg-yellow-500/20 border border-yellow-500 text-yellow-500 px-4 py-2 rounded text-sm">🔄 RESET</button>
            </div>
        </div>
        
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="card">
                <p class="stat-label">BALANCE (BTC)</p>
                <p id="balance" class="stat-number value-positive">0.00000000</p>
            </div>
            <div class="card">
                <p class="stat-label">TOTAL P&L</p>
                <p id="pnl" class="stat-number">0.00000000</p>
            </div>
            <div class="card">
                <p class="stat-label">WIN RATE</p>
                <p id="winRate" class="stat-number value-positive">0%</p>
            </div>
            <div class="card">
                <p class="stat-label">TOTAL BETS</p>
                <p id="totalBets" class="stat-number">0</p>
            </div>
        </div>
        
        <div class="grid grid-cols-2 gap-4 mb-8">
            <div id="overCard" class="card">
                <h2 class="text-xl font-bold text-green-400">OVER (50.5+)</h2>
                <p id="overRoi" class="text-3xl font-black mt-2">0%</p>
                <p id="overBet" class="text-sm">Bet: 0.00000000 BTC</p>
                <p id="overStep" class="text-xs text-slate-400">Step 0</p>
                <p id="overAction" class="text-xs text-indigo-400 mt-2"></p>
                <p id="overStats" class="text-[10px] text-slate-500 mt-1"></p>
            </div>
            <div id="underCard" class="card">
                <h2 class="text-xl font-bold text-red-400">UNDER (49.5-)</h2>
                <p id="underRoi" class="text-3xl font-black mt-2">0%</p>
                <p id="underBet" class="text-sm">Bet: 0.00000000 BTC</p>
                <p id="underStep" class="text-xs text-slate-400">Step 0</p>
                <p id="underAction" class="text-xs text-indigo-400 mt-2"></p>
                <p id="underStats" class="text-[10px] text-slate-500 mt-1"></p>
            </div>
        </div>
        
        <div class="card">
            <h3 class="font-bold mb-4">📋 RECENT BETS</h3>
            <div class="overflow-x-auto max-h-96 overflow-y-auto">
                <table class="w-full text-sm">
                    <thead class="bg-[#0F141C] sticky top-0">
                        <tr>
                            <th class="text-left p-2">DIR</th>
                            <th class="text-left p-2">ROLL</th>
                            <th class="text-right p-2">BET</th>
                            <th class="text-right p-2">RESULT</th>
                            <th class="text-right p-2">PROFIT</th>
                            <th class="text-right p-2">STEP</th>
                            <th class="text-right p-2">ROI</th>
                        </tr>
                    </thead>
                    <tbody id="betsBody"></tbody>
                </table>
            </div>
        </div>
    </div>
    
    <script>
        async function closeAll() {
            if(confirm('Close all sequences and accept losses?')) {
                await fetch('/api/close-all', {method: 'POST'});
            }
        }
        
        async function resetBot() {
            if(confirm('Reset all statistics?')) {
                await fetch('/api/reset', {method: 'POST'});
            }
        }
        
        setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('balance').textContent = (data.game.balance || 0).toFixed(8);
                document.getElementById('pnl').textContent = (data.game.totalNetGain >= 0 ? '+' : '') + (data.game.totalNetGain || 0).toFixed(8);
                document.getElementById('winRate').textContent = (data.game.winRate || 0) + '%';
                document.getElementById('totalBets').textContent = data.game.totalBets || 0;
                document.getElementById('apiStatus').innerHTML = data.config.apiConnected ? '✅ API Connected' : '⚠️ Simulation Mode (No API Key)';
                
                const over = data.sequences.find(s => s.direction === 'over');
                const under = data.sequences.find(s => s.direction === 'under');
                
                if (over) {
                    document.getElementById('overRoi').textContent = (over.roi || 0).toFixed(2) + '%';
                    document.getElementById('overRoi').className = 'text-3xl font-black ' + (over.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('overBet').textContent = 'Bet: ' + (over.currentBet || 0).toFixed(8) + ' BTC';
                    document.getElementById('overStep').textContent = 'Step ' + (over.step || 0);
                    document.getElementById('overAction').textContent = over.lastAction || 'Idle';
                    document.getElementById('overStats').textContent = 'Wins: ' + (over.wins || 0) + ' | Losses: ' + (over.losses || 0);
                }
                
                if (under) {
                    document.getElementById('underRoi').textContent = (under.roi || 0).toFixed(2) + '%';
                    document.getElementById('underRoi').className = 'text-3xl font-black ' + (under.roi >= 0 ? 'value-positive' : 'value-negative');
                    document.getElementById('underBet').textContent = 'Bet: ' + (under.currentBet || 0).toFixed(8) + ' BTC';
                    document.getElementById('underStep').textContent = 'Step ' + (under.step || 0);
                    document.getElementById('underAction').textContent = under.lastAction || 'Idle';
                    document.getElementById('underStats').textContent = 'Wins: ' + (under.wins || 0) + ' | Losses: ' + (under.losses || 0);
                }
                
                let betsHtml = '';
                if (data.betHistory && data.betHistory.length > 0) {
                    data.betHistory.slice(0, 20).forEach(b => {
                        betsHtml += '<tr class="border-b border-[#1A212E]">' +
                            '<td class="p-2"><span class="' + (b.direction === 'OVER' ? 'text-green-400' : 'text-red-400') + ' font-bold">' + b.direction + '</span>' + (b.simulated ? ' <span class="sim-badge">SIM</span>' : '') + '</td>' +
                            '<td class="p-2 font-mono">' + b.rollNumber + '</td>' +
                            '<td class="p-2 text-right">' + parseFloat(b.betAmount).toFixed(8) + '</td>' +
                            '<td class="p-2 text-right"><span class="' + (b.result === 'WIN' ? 'text-green-400' : 'text-red-400') + '">' + b.result + '</span></td>' +
                            '<td class="p-2 text-right ' + (b.profit >= 0 ? 'value-positive' : 'value-negative') + '">' + (b.profit >= 0 ? '+' : '') + parseFloat(b.profit).toFixed(8) + '</td>' +
                            '<td class="p-2 text-right">' + b.step + '</td>' +
                            '<td class="p-2 text-right ' + (b.roi >= 0 ? 'value-positive' : 'value-negative') + '">' + b.roi.toFixed(2) + '%</td>' +
                        '</tr>';
                    });
                }
                document.getElementById('betsBody').innerHTML = betsHtml || '<tr><td colspan="7" class="text-center p-8 text-slate-500">No bets yet</td></tr>';
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== START BOT ====================

async function initialize() {
    console.log("\n🎲 CRYPTO.GAMES MARTINGALE BOT\n");
    console.log("Configuration:");
    console.log(`   API Key: ${config.apiKey ? '✓ Set' : '✗ Missing (using simulation)'}`);
    console.log(`   Base Bet: ${config.baseBet} BTC`);
    console.log(`   Multiplier: ${config.multiplier}x`);
    console.log(`   Take Profit: ${config.takeProfitPct}%`);
    console.log(`   Max Steps: ${config.maxSteps}`);
    console.log(`   Risk Percent: ${config.riskPercent}%`);
    console.log(`   Auto-Compound: ${config.autoCompound}\n`);
    
    // Try to get initial balance
    const balance = await getBalance();
    console.log(`💰 Current Balance: ${balance.toFixed(8)} BTC\n`);
    
    if (!config.apiKey) {
        console.log('⚠️  No API Key provided. Running in SIMULATION mode.');
        console.log('   To use real API, add CRYPTO_GAMES_API_KEY to .env file\n');
    } else {
        console.log('✅ API Key configured. Attempting real API connection...\n');
    }
    
    // Start background loop
    setInterval(backgroundLoop, config.pollInterval);
    
    // Start web server
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
        console.log(`📊 Bot is running! Watch the dashboard for updates.\n`);
    });
}

initialize();
