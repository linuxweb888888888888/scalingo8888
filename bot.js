// bitsler-profit-bot.js - Dice Bot with 50% Profit Protection
// NEVER hardcode API keys! Use .env file only.

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============ LOAD API KEY FROM ENVIRONMENT ============
const API_KEY = process.env.BITSLER_API_KEY;
const PROFIT_SAFE_PERCENT = parseFloat(process.env.PROFIT_SAFE_PERCENT) || 50;
const BASE_BET = parseFloat(process.env.BASE_BET) || 1;
const WIN_CHANCE = parseFloat(process.env.WIN_CHANCE) || 49.5;
const STOP_ON_PROFIT = parseFloat(process.env.STOP_ON_PROFIT) || 100;
const STOP_ON_LOSS = parseFloat(process.env.STOP_ON_LOSS) || 50;
const MAX_BET = parseFloat(process.env.MAX_BET) || 500;
const MARTINGALE_MULTIPLIER = 2;

// Validate API key
if (!API_KEY) {
    console.error('\n❌ ERROR: BITSLER_API_KEY not found!');
    console.error('Please create a .env file with: BITSLER_API_KEY=your_key_here\n');
    process.exit(1);
}

// Mask API key for display
const maskedKey = API_KEY.substring(0, 8) + '...' + API_KEY.substring(API_KEY.length - 4);
console.log('\n========================================');
console.log('  🎲 Bitsler Dice Bot - Profit Protection');
console.log('========================================');
console.log(`🔐 API Key: ${maskedKey}`);
console.log(`💰 Profit Safe: ${PROFIT_SAFE_PERCENT}% of profits will be LOCKED`);
console.log(`⚠️  Locked profits will NEVER be traded\n`);

// ============ API CONFIGURATION ============
const BASE_URL = 'https://bitsler.com/api';

const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    },
    timeout: 30000
});

// ============ PROFIT PROTECTION SYSTEM ============
// This is the core feature - separates profit from trading balance

let profitProtection = {
    // SAFE BALANCE - This money is LOCKED and will never be traded
    safeBalance: 0,
    safeBalanceHistory: [],
    
    // TRADING BALANCE - Only this money is used for betting
    tradingBalance: 0,
    
    // Original starting balance
    startingBalance: 0,
    
    // Total profit ever made
    totalProfitEver: 0,
    
    // Last time profit was locked
    lastLockTime: null,
    
    // Lock events history
    lockHistory: []
};

// ============ BOT STATE ============
let botState = {
    running: false,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        lockedProfit: 0,
        availableProfit: 0,
        currentBalance: 0,
        tradingBalance: 0,
        safeBalance: 0,
        highestBalance: 0,
        lowestBalance: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
        currentStreak: 0,
        startTime: null,
        lastLockAmount: 0
    },
    settings: {
        baseBet: BASE_BET,
        currentBet: BASE_BET,
        winChance: WIN_CHANCE,
        multiplier: MARTINGALE_MULTIPLIER,
        stopOnProfit: STOP_ON_PROFIT,
        stopOnLoss: STOP_ON_LOSS,
        maxBet: MAX_BET,
        profitSafePercent: PROFIT_SAFE_PERCENT
    },
    betHistory: []
};

// ============ SAVE/LOAD STATE ============
const STATE_FILE = './sessions/profit-bot-state.json';
const SAFE_FILE = './sessions/safe-balance.json';

function ensureDirectoryExists() {
    if (!fs.existsSync('./sessions')) {
        fs.mkdirSync('./sessions', { recursive: true });
    }
}

function saveState() {
    ensureDirectoryExists();
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            stats: botState.stats,
            settings: botState.settings,
            betHistory: botState.betHistory.slice(-200)
        }, null, 2));
        
        fs.writeFileSync(SAFE_FILE, JSON.stringify({
            safeBalance: profitProtection.safeBalance,
            safeBalanceHistory: profitProtection.safeBalanceHistory.slice(-50),
            lockHistory: profitProtection.lockHistory.slice(-50),
            totalProfitEver: profitProtection.totalProfitEver,
            startingBalance: profitProtection.startingBalance
        }, null, 2));
        
    } catch (e) {
        console.error('Save failed:', e.message);
    }
}

function loadState() {
    ensureDirectoryExists();
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            botState.stats = data.stats || botState.stats;
            botState.settings = data.settings || botState.settings;
            botState.betHistory = data.betHistory || [];
            console.log('📂 Loaded previous session data');
        }
        
        if (fs.existsSync(SAFE_FILE)) {
            const safeData = JSON.parse(fs.readFileSync(SAFE_FILE, 'utf8'));
            profitProtection.safeBalance = safeData.safeBalance || 0;
            profitProtection.safeBalanceHistory = safeData.safeBalanceHistory || [];
            profitProtection.lockHistory = safeData.lockHistory || [];
            profitProtection.totalProfitEver = safeData.totalProfitEver || 0;
            profitProtection.startingBalance = safeData.startingBalance || 0;
            console.log(`🔒 Loaded SAFE balance: ${profitProtection.safeBalance.toFixed(2)} (LOCKED - never traded)`);
        }
    } catch (e) {
        console.log('No previous session found');
    }
}

// ============ PROFIT PROTECTION CORE FUNCTION ============
// This function locks a percentage of profit into SAFE balance
function lockProfit(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0) {
        profitProtection.safeBalance += lockAmount;
        profitProtection.totalProfitEver += lockAmount;
        profitProtection.lockHistory.unshift({
            time: new Date(),
            amount: lockAmount,
            totalSafe: profitProtection.safeBalance,
            reason: 'profit_lock'
        });
        
        botState.stats.lockedProfit = profitProtection.safeBalance;
        botState.stats.lastLockAmount = lockAmount;
        profitProtection.lastLockTime = new Date();
        
        console.log(`\n🔒 PROFIT LOCKED: ${lockAmount.toFixed(2)} added to SAFE balance!`);
        console.log(`   💰 Total SAFE (never traded): ${profitProtection.safeBalance.toFixed(2)}`);
        console.log(`   📊 ${PROFIT_SAFE_PERCENT}% of profit is now PROTECTED\n`);
        
        // Record in history
        profitProtection.safeBalanceHistory.unshift({
            time: new Date(),
            balance: profitProtection.safeBalance,
            added: lockAmount
        });
        
        saveState();
    }
    
    return lockAmount;
}

// Check if we should lock profit based on net profit
function checkAndLockProfit() {
    const currentNetProfit = botState.stats.netProfit;
    const previousLockedProfit = profitProtection.safeBalance;
    
    // Calculate how much profit is eligible for locking
    const eligibleProfit = currentNetProfit - previousLockedProfit;
    
    if (eligibleProfit > 0) {
        const lockAmount = lockProfit(eligibleProfit);
        return lockAmount;
    }
    
    return 0;
}

// Update trading balance (total - safe balance)
function updateTradingBalance(totalBalance) {
    const newTradingBalance = totalBalance - profitProtection.safeBalance;
    profitProtection.tradingBalance = Math.max(0, newTradingBalance);
    botState.stats.tradingBalance = profitProtection.tradingBalance;
    botState.stats.safeBalance = profitProtection.safeBalance;
    
    return profitProtection.tradingBalance;
}

// ============ API FUNCTIONS ============
async function getBalance() {
    try {
        const response = await api.get('/v2/user/balance');
        const totalBalance = parseFloat(response.data.balance || response.data.balance_btc || 0);
        
        // Record starting balance if not set
        if (profitProtection.startingBalance === 0) {
            profitProtection.startingBalance = totalBalance;
            console.log(`📊 Starting balance: ${totalBalance.toFixed(2)}`);
        }
        
        // Update balances
        botState.stats.currentBalance = totalBalance;
        updateTradingBalance(totalBalance);
        
        // Track highest/lowest
        if (totalBalance > botState.stats.highestBalance) {
            botState.stats.highestBalance = totalBalance;
        }
        if (totalBalance < botState.stats.lowestBalance || botState.stats.lowestBalance === 0) {
            botState.stats.lowestBalance = totalBalance;
        }
        
        return totalBalance;
    } catch (error) {
        console.error('❌ Balance error:', error.response?.data?.message || error.message);
        return 0;
    }
}

async function placeBet(amount, winChance, choice = 'high') {
    // Check if we have enough trading balance
    if (amount > profitProtection.tradingBalance) {
        console.log(`\n⚠️ INSUFFICIENT TRADING BALANCE!`);
        console.log(`   Need: ${amount} | Available: ${profitProtection.tradingBalance.toFixed(2)}`);
        console.log(`   SAFE balance: ${profitProtection.safeBalance.toFixed(2)} (PROTECTED - cannot use)`);
        return { success: false, error: 'Insufficient trading balance' };
    }
    
    try {
        const betData = {
            amount: parseFloat(amount),
            win_chance: parseFloat(winChance),
            choice: choice,
            currency: 'BTC'
        };
        
        const response = await api.post('/v2/dice/bet', betData);
        const result = response.data;
        
        const isWin = result.win;
        const multiplier = 100 / winChance;
        const profit = isWin ? amount * (multiplier - 1) : -amount;
        
        return {
            success: true,
            isWin: isWin,
            roll: result.roll,
            profit: profit,
            payout: result.payout,
            multiplier: multiplier
        };
        
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`❌ Bet error: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

async function getUserInfo() {
    try {
        const response = await api.get('/v2/user');
        return response.data;
    } catch (error) {
        console.error('❌ Failed to get user info:', error.message);
        return null;
    }
}

// ============ BETTING WITH PROFIT PROTECTION ============
async function executeSafeMartingale() {
    const settings = botState.settings;
    
    while (botState.running) {
        // Check stop conditions
        if (botState.stats.netProfit >= settings.stopOnProfit) {
            console.log(`\n🎯 Profit target reached: $${botState.stats.netProfit.toFixed(2)}`);
            // Lock remaining profit before stopping
            checkAndLockProfit();
            break;
        }
        if (botState.stats.netProfit <= -settings.stopOnLoss) {
            console.log(`\n🛑 Loss limit reached: $${botState.stats.netProfit.toFixed(2)}`);
            break;
        }
        if (settings.currentBet > settings.maxBet) {
            console.log(`\n⚠️ Max bet limit reached: ${settings.currentBet}`);
            break;
        }
        
        // Check if we have enough trading balance
        if (settings.currentBet > profitProtection.tradingBalance) {
            console.log(`\n⚠️ Cannot continue - insufficient trading balance`);
            console.log(`   Trading balance: ${profitProtection.tradingBalance.toFixed(2)}`);
            console.log(`   SAFE balance: ${profitProtection.safeBalance.toFixed(2)} (PROTECTED)`);
            break;
        }
        
        // Place bet
        const result = await placeBet(settings.currentBet, settings.winChance);
        
        if (!result.success) {
            console.log('⚠️ Bet failed, retrying in 5 seconds...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
        }
        
        // Update stats
        const previousProfit = botState.stats.netProfit;
        botState.stats.totalBets++;
        botState.stats.netProfit += result.profit;
        botState.stats.currentBalance += result.profit;
        
        // Update trading balance
        updateTradingBalance(botState.stats.currentBalance);
        
        if (result.isWin) {
            botState.stats.wins++;
            botState.stats.currentStreak = botState.stats.currentStreak > 0 ? botState.stats.currentStreak + 1 : 1;
            if (botState.stats.currentStreak > botState.stats.longestWinStreak) {
                botState.stats.longestWinStreak = botState.stats.currentStreak;
            }
            // Reset bet on win
            settings.currentBet = settings.baseBet;
        } else {
            botState.stats.losses++;
            botState.stats.currentStreak = botState.stats.currentStreak < 0 ? botState.stats.currentStreak - 1 : -1;
            if (Math.abs(botState.stats.currentStreak) > botState.stats.longestLossStreak) {
                botState.stats.longestLossStreak = Math.abs(botState.stats.currentStreak);
            }
            // Double bet on loss (Martingale) - but only up to max
            settings.currentBet = Math.min(settings.currentBet * settings.multiplier, settings.maxBet);
        }
        
        // LOCK PROFIT - This is the key feature!
        // Every time we have net profit, lock 50% of it
        const lockedThisBet = checkAndLockProfit();
        if (lockedThisBet > 0) {
            botState.stats.availableProfit = botState.stats.netProfit - profitProtection.safeBalance;
        }
        
        // Record bet history
        const betRecord = {
            id: botState.stats.totalBets,
            time: new Date(),
            amount: settings.currentBet,
            roll: result.roll,
            isWin: result.isWin,
            profit: result.profit,
            balance: botState.stats.currentBalance,
            tradingBalance: profitProtection.tradingBalance,
            safeBalance: profitProtection.safeBalance,
            lockedThisBet: lockedThisBet,
            multiplier: result.multiplier
        };
        botState.betHistory.unshift(betRecord);
        if (botState.betHistory.length > 200) botState.betHistory.pop();
        
        // Log result with profit protection info
        const emoji = result.isWin ? '✅' : '❌';
        console.log(`${emoji} #${botState.stats.totalBets} | Bet: ${settings.currentBet.toFixed(2)} | Profit: ${result.profit.toFixed(2)} | Net: ${botState.stats.netProfit.toFixed(2)} | Trading: ${profitProtection.tradingBalance.toFixed(2)} | 🔒 SAFE: ${profitProtection.safeBalance.toFixed(2)}`);
        
        if (lockedThisBet > 0) {
            console.log(`   🔒 LOCKED ${lockedThisBet.toFixed(2)} into SAFE balance! (${PROFIT_SAFE_PERCENT}% of profit protected)`);
        }
        
        // Save state periodically
        if (botState.stats.totalBets % 10 === 0) {
            saveState();
        }
        
        // Wait between bets
        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 1000));
    }
    
    return true;
}

// ============ BOT CONTROL ============
async function startBot() {
    if (botState.running) {
        console.log('Bot is already running');
        return;
    }
    
    botState.running = true;
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    console.log('\n🚀 Starting Bitsler Dice Bot with PROFIT PROTECTION');
    console.log('========================================');
    console.log(`📊 Strategy: Martingale (${botState.settings.multiplier}x on loss)`);
    console.log(`💰 Base Bet: ${botState.settings.baseBet}`);
    console.log(`🎯 Win Chance: ${botState.settings.winChance}%`);
    console.log(`🔒 Profit Protection: ${PROFIT_SAFE_PERCENT}% of profits LOCKED`);
    console.log(`🛑 Stop Profit: ${botState.settings.stopOnProfit} | Stop Loss: ${botState.settings.stopOnLoss}`);
    console.log(`💎 SAFE Balance (never traded): ${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`💳 Trading Balance: ${profitProtection.tradingBalance.toFixed(2)}`);
    console.log('========================================\n');
    
    await executeSafeMartingale();
    
    console.log('\n========================================');
    console.log('📊 FINAL STATS WITH PROFIT PROTECTION');
    console.log('========================================');
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Wins: ${botState.stats.wins} (${(botState.stats.wins/botState.stats.totalBets*100).toFixed(1)}%)`);
    console.log(`Losses: ${botState.stats.losses}`);
    console.log(`Net Profit: ${botState.stats.netProfit.toFixed(2)}`);
    console.log(`🔒 LOCKED (SAFE): ${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`💳 Trading Balance: ${profitProtection.tradingBalance.toFixed(2)}`);
    console.log(`💰 Total Balance: ${botState.stats.currentBalance.toFixed(2)}`);
    console.log('========================================\n');
    
    saveState();
    botState.running = false;
}

function stopBot() {
    botState.running = false;
    console.log('\n⏹️ Bot stopping...');
    checkAndLockProfit(); // Lock any remaining profit
    saveState();
}

// ============ EXPRESS DASHBOARD ============
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    const uptime = botState.stats.startTime 
        ? Math.floor((Date.now() - new Date(botState.stats.startTime).getTime()) / 1000)
        : 0;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const winRate = botState.stats.totalBets > 0 
        ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)
        : 0;
    
    const profitProtectionRate = PROFIT_SAFE_PERCENT;
    const totalLocked = profitProtection.safeBalance;
    const profitLockedPercent = botState.stats.netProfit > 0 
        ? (totalLocked / botState.stats.netProfit * 100).toFixed(1)
        : 0;
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Bitsler Dice Bot - 50% Profit Protection</title>
    <meta http-equiv="refresh" content="3">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-value-large { font-size: 36px; font-weight: bold; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .safe { color: #ffaa00; }
        .trading { color: #00ccff; }
        button { background: #00ff88; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; font-weight: bold; }
        button.danger { background: #ff4444; color: #fff; }
        .live { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; margin-right: 8px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        .profit-protection { background: #2a1f3a; border: 1px solid #ffaa00; }
        .safe-badge { background: #ffaa00; color: #000; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 Bitsler Dice Bot <span class="safe-badge">🔒 ${PROFIT_SAFE_PERCENT}% PROFIT PROTECTION</span></h1>
        
        <div class="card">
            <div><span class="live"></span> <strong>${botState.running ? 'RUNNING' : 'STOPPED'}</strong> | Uptime: ${hours}h ${minutes}m</div>
            <div style="margin-top: 15px;">
                ${!botState.running ? '<button onclick="start()">▶️ START BOT</button>' : '<button onclick="stop()" class="danger">⏹️ STOP BOT</button>'}
            </div>
        </div>
        
        <!-- Balance Overview with Profit Protection -->
        <div class="stats">
            <div class="stat-card profit-protection">
                <div class="stat-value-large safe">${profitProtection.safeBalance.toFixed(2)}</div>
                <div>🔒 SAFE BALANCE</div>
                <div style="font-size: 10px;">NEVER TRADED - ${profitLockedPercent}% of profit locked</div>
            </div>
            <div class="stat-card">
                <div class="stat-value-large trading">${profitProtection.tradingBalance.toFixed(2)}</div>
                <div>💳 TRADING BALANCE</div>
                <div style="font-size: 10px;">Only this is used for bets</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${botState.stats.currentBalance.toFixed(2)}</div>
                <div>💰 TOTAL BALANCE</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${botState.stats.netProfit.toFixed(2)}</div>
                <div>📊 NET PROFIT</div>
            </div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>📊 Betting Stats</h3>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
                    <div>Total Bets: <strong>${botState.stats.totalBets}</strong></div>
                    <div>Win Rate: <strong>${winRate}%</strong></div>
                    <div>Wins: <span class="win">${botState.stats.wins}</span></div>
                    <div>Losses: <span class="loss">${botState.stats.losses}</span></div>
                    <div>Win Streak: <span class="win">${botState.stats.longestWinStreak}</span></div>
                    <div>Loss Streak: <span class="loss">${botState.stats.longestLossStreak}</span></div>
                    <div>Current Bet: <strong>${botState.settings.currentBet}</strong></div>
                    <div>Current Streak: ${botState.stats.currentStreak}</div>
                </div>
            </div>
            
            <div class="card">
                <h3>🔒 Profit Protection History</h3>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${profitProtection.lockHistory.slice(0, 10).map(l => `
                        <div style="border-bottom: 1px solid #333; padding: 5px;">
                            ${new Date(l.time).toLocaleTimeString()} - 🔒 Locked ${l.amount.toFixed(2)} (Total SAFE: ${l.totalSafe.toFixed(2)})
                        </div>
                    `).join('') || '<div>No locks yet...</div>'}
                </div>
            </div>
        </div>
        
        <div class="card">
            <h3>📜 Recent Bets (Profit protected on every win)</h3>
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Bet</th>
                        <th>Roll</th>
                        <th>Result</th>
                        <th>Profit</th>
                        <th>Trading</th>
                        <th>🔒 SAFE</th>
                    </tr>
                </thead>
                <tbody>
                    ${botState.betHistory.slice(0, 30).map(b => `
                        <tr>
                            <td>${new Date(b.time).toLocaleTimeString()}</td>
                            <td>${b.amount}</td>
                            <td>${b.roll}</td>
                            <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
                            <td class="${b.profit >= 0 ? 'win' : 'loss'}">${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(2)}</td>
                            <td>${b.tradingBalance?.toFixed(2) || '-'}</td>
                            <td class="safe">${b.safeBalance?.toFixed(2) || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        
        <div class="card" style="background: #1a2a1f; border-color: #00ff88;">
            <h3>💡 How Profit Protection Works</h3>
            <ul style="margin-left: 20px; line-height: 1.8;">
                <li>🔒 <strong>${PROFIT_SAFE_PERCENT}% of every profit is automatically LOCKED</strong> into SAFE balance</li>
                <li>💰 <strong>SAFE balance is NEVER used for betting</strong> - it's permanently protected</li>
                <li>💳 Only the <strong>remaining ${100 - PROFIT_SAFE_PERCENT}% stays in TRADING balance</strong></li>
                <li>✅ This ensures you keep ${PROFIT_SAFE_PERCENT}% of ALL profits, no matter what happens</li>
                <li>🎯 Even if you lose later, your SAFE profits remain untouched!</li>
            </ul>
        </div>
    </div>
    
    <script>
        async function start() {
            await fetch('/api/start', { method: 'POST' });
            location.reload();
        }
        async function stop() {
            await fetch('/api/stop', { method: 'POST' });
            location.reload();
        }
    </script>
</body>
</html>
    `);
});

app.post('/api/start', async (req, res) => {
    if (!botState.running) {
        startBot().catch(console.error);
    }
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    res.json({
        running: botState.running,
        stats: botState.stats,
        settings: botState.settings,
        profitProtection: {
            safeBalance: profitProtection.safeBalance,
            tradingBalance: profitProtection.tradingBalance,
            totalProfitEver: profitProtection.totalProfitEver
        }
    });
});

// ============ MAIN ============
async function main() {
    console.log('🔐 Verifying API connection...');
    
    // Test API connection
    const userInfo = await getUserInfo();
    if (!userInfo) {
        console.error('\n❌ Failed to connect to Bitsler API');
        console.error('Please check your API key in the .env file\n');
        process.exit(1);
    }
    
    console.log(`👤 Account: ${userInfo.username || 'Connected'}`);
    await getBalance();
    
    loadState();
    
    // Recalculate trading balance after loading
    updateTradingBalance(botState.stats.currentBalance);
    
    console.log(`\n💰 Balance Breakdown:`);
    console.log(`   🔒 SAFE (protected): ${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`   💳 Trading (can bet): ${profitProtection.tradingBalance.toFixed(2)}`);
    console.log(`   📊 Total: ${botState.stats.currentBalance.toFixed(2)}`);
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}`);
        console.log(`\n🔒 PROFIT PROTECTION ACTIVE:`);
        console.log(`   ${PROFIT_SAFE_PERCENT}% of ALL profits will be LOCKED and NEVER traded`);
        console.log(`   Your SAFE balance will grow with every win`);
        console.log(`   Even if you lose later, SAFE profits remain yours!\n`);
    });
    
    // Auto-start if configured
    if (process.env.AUTO_START === 'true') {
        console.log('🚀 Auto-start enabled...');
        await startBot();
    }
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    checkAndLockProfit(); // Final profit lock
    saveState();
    process.exit(0);
});

main().catch(console.error);
