// bitsler-standalone.js - STANDALONE DICE BOT with $10 Credit
// No API keys needed - runs completely independently

const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const INITIAL_CREDIT = 10.00; // $10 starting credit
const PROFIT_SAFE_PERCENT = 50; // Keep 50% of profits permanently
const BASE_BET = 0.10; // $0.10 base bet
const WIN_CHANCE = 49.5; // 49.5% win chance (house edge ~1%)
const STOP_ON_PROFIT = 20.00; // Stop at $20 profit
const STOP_ON_LOSS = 5.00; // Stop at $5 loss
const MAX_BET = 5.00; // Maximum bet of $5

// ============ STATE MANAGEMENT ============
let profitProtection = {
    safeBalance: 0,           // Permanently locked profit (never traded)
    totalProfitEver: 0,       // Total profit ever made
    permanentLocks: [],       // Record of permanently locked amounts
    withdrawableBalance: 0    // Balance that can be withdrawn
};

let botState = {
    running: false,
    autoRestart: true,
    restartCount: 0,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        lockedProfit: 0,
        permanentLocked: 0,
        currentBalance: INITIAL_CREDIT,
        startTime: null,
        lastRestart: null,
        highestBalance: INITIAL_CREDIT,
        lowestBalance: INITIAL_CREDIT
    },
    settings: {
        baseBet: BASE_BET,
        currentBet: BASE_BET,
        winChance: WIN_CHANCE,
        maxBet: MAX_BET,
        stopProfit: STOP_ON_PROFIT,
        stopLoss: STOP_ON_LOSS
    },
    betHistory: []
};

// ============ PERMANENT PROFIT LOCKING (50%) ============
function lockProfitPermanently(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0.001) { // Minimum $0.001 to lock
        profitProtection.safeBalance += lockAmount;
        profitProtection.totalProfitEver += lockAmount;
        profitProtection.withdrawableBalance += lockAmount;
        profitProtection.permanentLocks.unshift({
            time: new Date(),
            amount: lockAmount,
            percentage: PROFIT_SAFE_PERCENT,
            totalSafe: profitProtection.safeBalance,
            reason: 'permanent_profit_lock'
        });
        
        botState.stats.lockedProfit = profitProtection.safeBalance;
        botState.stats.permanentLocked = profitProtection.safeBalance;
        
        console.log(`\n🔒 PERMANENT LOCK: $${lockAmount.toFixed(2)} (${PROFIT_SAFE_PERCENT}% of profit)`);
        console.log(`   💰 TOTAL PERMANENTLY PROTECTED: $${profitProtection.safeBalance.toFixed(2)}`);
        console.log(`   ✅ WITHDRAWABLE: $${profitProtection.withdrawableBalance.toFixed(2)}\n`);
        
        saveState();
    }
    return lockAmount;
}

function checkAndLockProfitPermanent() {
    const currentNetProfit = botState.stats.netProfit;
    const lockedSoFar = profitProtection.safeBalance;
    const eligibleProfit = currentNetProfit - lockedSoFar;
    
    if (eligibleProfit > 0.001) {
        return lockProfitPermanently(eligibleProfit);
    }
    return 0;
}

// ============ DICE GAME SIMULATOR ============
function rollDice() {
    // Generate random number between 0 and 100
    return Math.random() * 100;
}

function placeDiceBet(amount, winChance) {
    // Simulate the dice roll
    const roll = rollDice();
    const isWin = roll <= winChance;
    
    // Calculate multiplier (99% payout for 49.5% win chance)
    const multiplier = 100 / winChance * 0.99; // 2x for 49.5% (actually 1.99x due to house edge)
    const profit = isWin ? amount * (multiplier - 1) : -amount;
    
    return {
        success: true,
        isWin: isWin,
        roll: roll.toFixed(2),
        profit: profit,
        multiplier: multiplier.toFixed(2),
        betId: Date.now()
    };
}

// ============ PERSISTENCE ============
const STATE_FILE = './sessions/bot-state.json';

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
            profitProtection: {
                safeBalance: profitProtection.safeBalance,
                totalProfitEver: profitProtection.totalProfitEver,
                withdrawableBalance: profitProtection.withdrawableBalance,
                lockHistory: profitProtection.lockHistory?.slice(-50),
                permanentLocks: profitProtection.permanentLocks.slice(-50)
            },
            betHistory: botState.betHistory.slice(-100),
            restartCount: botState.restartCount
        }, null, 2));
        console.log('💾 State saved');
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
            botState.restartCount = data.restartCount || 0;
            if (data.profitProtection) {
                profitProtection.safeBalance = data.profitProtection.safeBalance || 0;
                profitProtection.totalProfitEver = data.profitProtection.totalProfitEver || 0;
                profitProtection.withdrawableBalance = data.profitProtection.withdrawableBalance || 0;
                profitProtection.lockHistory = data.profitProtection.lockHistory || [];
                profitProtection.permanentLocks = data.profitProtection.permanentLocks || [];
            }
            console.log(`🔒 Loaded PERMANENTLY PROTECTED: $${profitProtection.safeBalance.toFixed(2)}`);
            console.log(`💰 Current balance: $${botState.stats.currentBalance.toFixed(2)}`);
        } else {
            console.log('🆕 New session - Starting with $10 credit');
            botState.stats.currentBalance = INITIAL_CREDIT;
            botState.stats.highestBalance = INITIAL_CREDIT;
            botState.stats.lowestBalance = INITIAL_CREDIT;
        }
    } catch (e) {
        console.log('Error loading state, starting fresh');
        botState.stats.currentBalance = INITIAL_CREDIT;
    }
}

// ============ MARTINGALE STRATEGY ============
async function runMartingale() {
    const settings = botState.settings;
    
    while (botState.running) {
        // Update highest/lowest balance
        if (botState.stats.currentBalance > botState.stats.highestBalance) {
            botState.stats.highestBalance = botState.stats.currentBalance;
        }
        if (botState.stats.currentBalance < botState.stats.lowestBalance) {
            botState.stats.lowestBalance = botState.stats.currentBalance;
        }
        
        // Check profit target
        if (botState.stats.netProfit >= settings.stopProfit) {
            console.log(`\n🎯 Profit target reached: $${botState.stats.netProfit.toFixed(2)}`);
            checkAndLockProfitPermanent();
            console.log(`\n🔄 Auto-restarting in 10 seconds...`);
            await new Promise(r => setTimeout(r, 10000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Check loss limit
        if (botState.stats.netProfit <= -settings.stopLoss) {
            console.log(`\n🛑 Loss limit reached: $${botState.stats.netProfit.toFixed(2)}`);
            console.log(`\n🔄 Auto-restarting in 30 seconds...`);
            await new Promise(r => setTimeout(r, 30000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Check max bet
        if (settings.currentBet > settings.maxBet) {
            console.log(`\n⚠️ Max bet reached: $${settings.currentBet.toFixed(2)}`);
            console.log(`\n🔄 Auto-restarting in 60 seconds...`);
            await new Promise(r => setTimeout(r, 60000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Check available balance
        const tradingBalance = botState.stats.currentBalance - profitProtection.safeBalance;
        if (settings.currentBet > tradingBalance) {
            console.log(`\n⚠️ Insufficient trading balance!`);
            console.log(`   Trading: $${tradingBalance.toFixed(2)} | Need: $${settings.currentBet.toFixed(2)}`);
            console.log(`\n🔄 Auto-restarting in 30 seconds...`);
            await new Promise(r => setTimeout(r, 30000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Place bet
        const result = placeDiceBet(settings.currentBet, settings.winChance);
        
        if (!result.success) {
            console.log('⚠️ Bet failed, retrying...');
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        
        // Update stats
        botState.stats.totalBets++;
        botState.stats.netProfit += result.profit;
        botState.stats.currentBalance += result.profit;
        
        if (result.isWin) {
            botState.stats.wins++;
            settings.currentBet = settings.baseBet;
        } else {
            botState.stats.losses++;
            settings.currentBet = Math.min(settings.currentBet * 2, settings.maxBet);
        }
        
        // Lock 50% of profit PERMANENTLY
        const locked = checkAndLockProfitPermanent();
        
        // Record bet
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date(),
            amount: settings.currentBet,
            roll: result.roll,
            isWin: result.isWin,
            profit: result.profit,
            netProfit: botState.stats.netProfit,
            balance: botState.stats.currentBalance,
            safeBalance: profitProtection.safeBalance,
            permanentLocked: locked,
            restartCount: botState.restartCount
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log with formatting
        const emoji = result.isWin ? '✅' : '❌';
        const profitColor = result.profit >= 0 ? '+' : '';
        const betAmount = settings.currentBet;
        
        console.log(`${emoji} #${botState.stats.totalBets} | Bet: $${betAmount.toFixed(2)} | Roll: ${result.roll} | Profit: ${profitColor}$${result.profit.toFixed(2)} | Balance: $${botState.stats.currentBalance.toFixed(2)} | 🔒 Safe: $${profitProtection.safeBalance.toFixed(2)}`);
        
        if (locked > 0) {
            console.log(`   🔒 LOCKED $${locked.toFixed(2)} (${PROFIT_SAFE_PERCENT}% of profit saved FOREVER!)`);
        }
        
        // Progress indicator
        if (botState.stats.totalBets % 10 === 0) {
            const winRate = (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1);
            console.log(`\n📊 Progress: ${botState.stats.totalBets} bets | Win Rate: ${winRate}% | Net: $${botState.stats.netProfit.toFixed(2)} | Protected: $${profitProtection.safeBalance.toFixed(2)}\n`);
        }
        
        saveState();
        
        // Wait between bets (1 second for realism)
        await new Promise(r => setTimeout(r, 1000));
    }
    
    return true;
}

// ============ AUTO-RESTART FUNCTION ============
async function restartBot() {
    console.log('\n========================================');
    console.log('🔄 AUTO-RESTARTING BOT...');
    console.log('========================================');
    
    botState.running = false;
    botState.restartCount++;
    botState.stats.lastRestart = new Date();
    
    // Lock any pending profit before restart
    checkAndLockProfitPermanent();
    
    // Reset betting settings but keep accumulated locked profit
    botState.settings.currentBet = botState.settings.baseBet;
    
    console.log(`💰 Current balance: $${botState.stats.currentBalance.toFixed(2)}`);
    console.log(`🔒 Permanently protected: $${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`💳 Trading balance: $${(botState.stats.currentBalance - profitProtection.safeBalance).toFixed(2)}`);
    console.log(`🔄 Restart #${botState.restartCount}`);
    
    saveState();
    
    // Brief pause before restart
    await new Promise(r => setTimeout(r, 5000));
    
    // Start bot again
    botState.running = true;
    console.log(`\n✅ Bot restarted! Resuming trading...\n`);
    
    // Run martingale again
    await runMartingale();
}

// ============ BOT CONTROL ============
async function startBot() {
    if (botState.running) {
        console.log('Bot already running');
        return;
    }
    
    botState.running = true;
    botState.autoRestart = true;
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    console.log('\n========================================');
    console.log('🚀 STARTING DICE BOT');
    console.log('========================================');
    console.log(`💰 Starting Balance: $${botState.stats.currentBalance.toFixed(2)}`);
    console.log(`🔒 Protected Balance: $${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`💳 Trading Balance: $${(botState.stats.currentBalance - profitProtection.safeBalance).toFixed(2)}`);
    console.log(`🎲 Base Bet: $${botState.settings.baseBet.toFixed(2)}`);
    console.log(`📊 Win Chance: ${botState.settings.winChance}%`);
    console.log(`🎯 Stop Profit: $${botState.settings.stopProfit} | Stop Loss: $${botState.settings.stopLoss}`);
    console.log(`🔒 ${PROFIT_SAFE_PERCENT}% of ALL profits locked PERMANENTLY`);
    console.log(`🔄 AUTO-RESTART: ENABLED`);
    console.log('========================================\n');
    
    await runMartingale();
    
    console.log('\n========================================');
    console.log('📊 BOT STATS');
    console.log('========================================');
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses}`);
    console.log(`Win Rate: ${(botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)}%`);
    console.log(`Net Profit: $${botState.stats.netProfit.toFixed(2)}`);
    console.log(`🔒 PERMANENTLY LOCKED: $${profitProtection.safeBalance.toFixed(2)}`);
    console.log(`💰 Current Balance: $${botState.stats.currentBalance.toFixed(2)}`);
    console.log(`📈 Highest Balance: $${botState.stats.highestBalance.toFixed(2)}`);
    console.log(`📉 Lowest Balance: $${botState.stats.lowestBalance.toFixed(2)}`);
    console.log('========================================\n');
    
    saveState();
    botState.running = false;
}

function stopBot() {
    botState.running = false;
    botState.autoRestart = false;
    checkAndLockProfitPermanent();
    saveState();
    console.log('\n⏹️ Bot stopped manually');
}

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = botState.stats.startTime 
        ? Math.floor((Date.now() - new Date(botState.stats.startTime).getTime()) / 1000)
        : 0;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const winRate = botState.stats.totalBets > 0 
        ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)
        : 0;
    
    const tradingBalance = Math.max(0, botState.stats.currentBalance - profitProtection.safeBalance);
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dice Bot - $10 Credit | 50% Permanent Profit Protection</title>
    <meta http-equiv="refresh" content="2">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Courier New', monospace; 
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            color: #00ff88; 
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 2em; margin-bottom: 10px; }
        .badge { 
            display: inline-block; 
            background: #ff6600; 
            color: #000; 
            padding: 5px 12px; 
            border-radius: 20px; 
            font-size: 12px; 
            font-weight: bold;
            margin: 0 5px;
        }
        .badge-blue { background: #00ccff; }
        .badge-green { background: #00ff88; color: #000; }
        .card { 
            background: rgba(26, 31, 58, 0.95);
            backdrop-filter: blur(10px);
            padding: 20px; 
            border-radius: 15px; 
            margin-bottom: 20px;
            border: 1px solid rgba(0, 255, 136, 0.2);
        }
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 20px; 
            margin-bottom: 20px;
        }
        .stat-card { 
            background: rgba(26, 31, 58, 0.95);
            padding: 20px; 
            border-radius: 15px; 
            text-align: center;
            transition: transform 0.3s;
        }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-value { font-size: 28px; font-weight: bold; margin: 10px 0; }
        .stat-label { font-size: 12px; opacity: 0.8; text-transform: uppercase; letter-spacing: 1px; }
        .safe-card { border: 2px solid #ff6600; background: rgba(255, 102, 0, 0.1); }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4444; }
        button { 
            background: #00ff88; 
            color: #000; 
            border: none; 
            padding: 12px 30px; 
            border-radius: 25px; 
            cursor: pointer; 
            margin: 5px; 
            font-weight: bold;
            font-size: 16px;
            transition: all 0.3s;
        }
        button:hover { transform: scale(1.05); box-shadow: 0 0 20px rgba(0,255,136,0.5); }
        button.danger { background: #ff4444; color: #fff; }
        .live { 
            display: inline-block; 
            width: 12px; 
            height: 12px; 
            background: #00ff88; 
            border-radius: 50%; 
            animation: pulse 1s infinite; 
            margin-right: 8px; 
        }
        @keyframes pulse { 
            0%, 100% { opacity: 1; transform: scale(1); } 
            50% { opacity: 0.5; transform: scale(1.2); } 
        }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(0, 255, 136, 0.2); }
        th { background: rgba(0, 255, 136, 0.1); font-weight: bold; }
        .bet-history { max-height: 400px; overflow-y: auto; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .controls { display: flex; justify-content: center; gap: 15px; margin-top: 20px; }
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .stat-value { font-size: 20px; }
            h1 { font-size: 1.5em; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎲 DICE BOT <span class="badge">🔒 50% PERMANENT PROTECTION</span> <span class="badge badge-blue">🔄 AUTO-RESTART</span></h1>
            <p>Starting Credit: $10 | Martingale Strategy | House Edge: 1%</p>
        </div>
        
        <div class="card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div><span class="live"></span> <strong>${botState.running ? 'RUNNING' : 'STOPPED'}</strong> | Uptime: ${hours}h ${minutes}m | Restarts: ${botState.restartCount}</div>
                <div style="font-size: 12px;">💡 50% of all profits are permanently locked and withdrawable</div>
            </div>
            <div class="controls">
                ${!botState.running ? '<button onclick="start()">▶️ START BOT</button>' : '<button onclick="stop()" class="danger">⏹️ STOP BOT</button>'}
            </div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card safe-card">
                <div class="stat-label">🔒 PERMANENTLY PROTECTED</div>
                <div class="stat-value" style="color: #ffaa00">$${profitProtection.safeBalance.toFixed(2)}</div>
                <div style="font-size: 11px;">50% of ALL profits - WITHDRAWABLE</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">💳 TRADING BALANCE</div>
                <div class="stat-value" style="color: #00ccff">$${tradingBalance.toFixed(2)}</div>
                <div style="font-size: 11px;">Used for betting</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">💰 TOTAL BALANCE</div>
                <div class="stat-value">$${botState.stats.currentBalance.toFixed(2)}</div>
                <div style="font-size: 11px;">Protected + Trading</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📊 NET PROFIT</div>
                <div class="stat-value ${botState.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative'}">
                    ${botState.stats.netProfit >= 0 ? '+' : ''}$${botState.stats.netProfit.toFixed(2)}
                </div>
            </div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">🎲 TOTAL BETS</div>
                <div class="stat-value">${botState.stats.totalBets}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">✅ WINS</div>
                <div class="stat-value" style="color: #00ff88">${botState.stats.wins}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">❌ LOSSES</div>
                <div class="stat-value" style="color: #ff4444">${botState.stats.losses}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📈 WIN RATE</div>
                <div class="stat-value">${winRate}%</div>
            </div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">💰 TOTAL PROFIT EVER</div>
                <div class="stat-value" style="color: #ffaa00">$${profitProtection.totalProfitEver.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📈 HIGHEST BALANCE</div>
                <div class="stat-value" style="color: #00ff88">$${botState.stats.highestBalance.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📉 LOWEST BALANCE</div>
                <div class="stat-value" style="color: #ff4444">$${botState.stats.lowestBalance.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">🎯 CURRENT BET</div>
                <div class="stat-value">$${botState.settings.currentBet.toFixed(2)}</div>
            </div>
        </div>
        
        <div class="card">
            <h3>📜 RECENT BETS (Last 50)</h3>
            <div class="bet-history">
                <table>
                    <thead>
                        <tr><th>#</th><th>Time</th><th>Bet</th><th>Roll</th><th>Result</th><th>Profit</th><th>Balance</th><th>🔒 Safe</th></tr>
                    </thead>
                    <tbody>
                        ${botState.betHistory.slice(0, 50).map(b => `
                            <tr>
                                <td>${b.id}</td>
                                <td>${new Date(b.time).toLocaleTimeString()}</td>
                                <td>$${b.amount.toFixed(2)}</td>
                                <td>${b.roll}</td>
                                <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
                                <td class="${b.profit >= 0 ? 'win' : 'loss'}">${b.profit >= 0 ? '+' : ''}$${b.profit.toFixed(2)}</td>
                                <td>$${b.balance.toFixed(2)}</td>
                                <td style="color:#ffaa00">$${b.safeBalance.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>🔒 PERMANENT PROFIT LOCKS</h3>
            <div style="max-height: 200px; overflow-y: auto;">
                <table>
                    <thead><tr><th>Time</th><th>Amount Locked</th><th>Total Protected</th></tr></thead>
                    <tbody>
                        ${profitProtection.permanentLocks.slice(0, 20).map(lock => `
                            <tr>
                                <td>${new Date(lock.time).toLocaleString()}</td>
                                <td style="color:#ffaa00">$${lock.amount.toFixed(2)}</td>
                                <td style="color:#00ff88">$${lock.totalSafe.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>ℹ️ HOW IT WORKS</h3>
            <ul style="margin-left: 20px; line-height: 1.8;">
                <li>✅ Starts with <strong>$10 credit</strong> (simulated balance)</li>
                <li>✅ Uses <strong>Martingale strategy</strong> - doubles bet after loss, resets after win</li>
                <li>✅ <strong>49.5% win chance</strong> with 1% house edge (realistic dice game)</li>
                <li>✅ <strong>50% of EVERY profit</strong> is permanently locked and withdrawable</li>
                <li>✅ Locked profits are <strong>NEVER used for betting again</strong></li>
                <li>✅ Bot <strong>auto-restarts</strong> when targets are reached or issues occur</li>
                <li>✅ Runs completely <strong>standalone</strong> - no API keys needed!</li>
            </ul>
        </div>
    </div>
    
    <script>
        async function start() {
            const response = await fetch('/api/start', { method: 'POST' });
            if (response.ok) location.reload();
        }
        async function stop() {
            const response = await fetch('/api/stop', { method: 'POST' });
            if (response.ok) location.reload();
        }
    </script>
</body>
</html>
    `);
});

app.post('/api/start', (req, res) => {
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
        autoRestart: botState.autoRestart,
        restartCount: botState.restartCount,
        stats: botState.stats,
        settings: botState.settings,
        profitProtection: {
            safeBalance: profitProtection.safeBalance,
            totalProfitEver: profitProtection.totalProfitEver,
            withdrawableBalance: profitProtection.withdrawableBalance,
            tradingBalance: Math.max(0, botState.stats.currentBalance - profitProtection.safeBalance)
        }
    });
});

// ============ MAIN ============
async function main() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║     🎲 DICE BOT - STANDALONE MODE     ║');
    console.log('║     Starting Credit: $10 USD          ║');
    console.log('║     50% Permanent Profit Protection   ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    loadState();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}`);
        console.log(`\n✅ Bot is ready!`);
        console.log(`💰 Starting balance: $${botState.stats.currentBalance.toFixed(2)}`);
        console.log(`🔒 Protected balance: $${profitProtection.safeBalance.toFixed(2)}`);
        console.log(`🔄 Auto-restart: ENABLED`);
        console.log(`\n🎲 The bot will now start automatically...\n`);
    });
    
    // Auto-start after 3 seconds
    await new Promise(r => setTimeout(r, 3000));
    await startBot();
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    checkAndLockProfitPermanent();
    saveState();
    console.log('💾 Final state saved');
    process.exit(0);
});

main().catch(console.error);
