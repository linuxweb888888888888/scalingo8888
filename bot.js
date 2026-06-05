// bitsler-bot.js - AUTO-START with 50% PERMANENT PROFIT PROTECTION
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ LOAD CONFIGURATION ============
const ACCESS_TOKEN = process.env.BITSLER_ACCESS_TOKEN;
const PROFIT_SAFE_PERCENT = 50; // HARDCODED to 50% - keeps half of all profits permanently
const BASE_BET = parseFloat(process.env.BASE_BET) || 1;
const WIN_CHANCE = parseFloat(process.env.WIN_CHANCE) || 49.5;
const STOP_ON_PROFIT = parseFloat(process.env.STOP_ON_PROFIT) || 100;
const STOP_ON_LOSS = parseFloat(process.env.STOP_ON_LOSS) || 50;
const MAX_BET = parseFloat(process.env.MAX_BET) || 500;

if (!ACCESS_TOKEN) {
    console.error('\n❌ ERROR: BITSLER_ACCESS_TOKEN not found in .env');
    console.error('Please get your token by:');
    console.error('1. Login to Bitsler.com');
    console.error('2. Press F12 -> Console tab');
    console.error('3. Type: console.log(access_token)');
    console.error('4. Copy the token to .env file\n');
    process.exit(1);
}

// Mask for display
const maskedToken = ACCESS_TOKEN.substring(0, 8) + '...' + ACCESS_TOKEN.substring(ACCESS_TOKEN.length - 4);

console.log('\n========================================');
console.log('  🎲 Bitsler Dice Bot - 50% PROFIT PROTECTION');
console.log('========================================');
console.log(`🔐 Using Access Token: ${maskedToken}`);
console.log(`💰 PERMANENT PROFIT LOCK: ${PROFIT_SAFE_PERCENT}% of ALL profits`);
console.log(`🔄 AUTO-START: ENABLED - Bot will restart automatically`);
console.log('========================================\n');

// ============ API CONFIGURATION ============
const API_BASE = 'https://www.bitsler.com/api';

const api = axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'BitslerNodeBot/1.0'
    }
});

// ============ API FUNCTIONS ============
async function getUserInfo() {
    try {
        const response = await api.get('/get-info', {
            params: { token: ACCESS_TOKEN }
        });
        
        if (response.data && response.data.success !== false) {
            const userData = response.data;
            const btcBalance = parseFloat(userData.balance_btc || userData.balance || 0);
            
            console.log(`👤 User: ${userData.username || 'Connected'}`);
            console.log(`💰 BTC Balance: ${btcBalance.toFixed(8)} BTC`);
            
            return {
                success: true,
                username: userData.username,
                balance: btcBalance,
                raw: userData
            };
        } else {
            console.error('❌ API returned error:', response.data);
            return { success: false };
        }
    } catch (error) {
        console.error('❌ API error:', error.response?.status, error.response?.data || error.message);
        return { success: false };
    }
}

async function placeDiceBet(amount, winChance, choice = 'high') {
    try {
        const betData = {
            token: ACCESS_TOKEN,
            amount: amount.toString(),
            win_chance: winChance,
            type: 1
        };
        
        if (choice === 'high') {
            betData.high = true;
        } else {
            betData.low = true;
        }
        
        const response = await api.post('/dice-bet', betData);
        
        if (response.data && response.data.success !== false) {
            const result = response.data;
            const isWin = result.win === true || result.result === 'win';
            const roll = result.roll || result.number;
            const multiplier = 100 / winChance;
            const profit = isWin ? amount * (multiplier - 1) : -amount;
            
            return {
                success: true,
                isWin: isWin,
                roll: roll,
                profit: profit,
                multiplier: multiplier,
                payout: result.payout,
                betId: result.bet_id
            };
        } else {
            console.error('❌ Bet failed:', response.data);
            return { success: false, error: response.data?.message || 'Bet failed' };
        }
        
    } catch (error) {
        console.error('❌ Bet error:', error.response?.status, error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// ============ PERMANENT PROFIT PROTECTION (50% LOCKED FOREVER) ============
let profitProtection = {
    safeBalance: 0,           // Permanently locked profit (never traded)
    totalProfitEver: 0,       // Total profit ever made
    lockHistory: [],          // History of locks
    permanentLocks: []        // Record of permanently locked amounts
};

let botState = {
    running: false,
    autoRestart: true,        // AUTO-RESTART ENABLED
    restartCount: 0,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        lockedProfit: 0,
        permanentLocked: 0,    // Total permanently locked (50% of all profit)
        currentBalance: 0,
        startTime: null,
        lastRestart: null
    },
    settings: {
        baseBet: BASE_BET,
        currentBet: BASE_BET,
        winChance: WIN_CHANCE,
        maxBet: MAX_BET
    },
    betHistory: []
};

// ============ PERMANENT PROFIT LOCKING (50%) ============
function lockProfitPermanently(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0.00000001) {
        profitProtection.safeBalance += lockAmount;
        profitProtection.totalProfitEver += lockAmount;
        profitProtection.permanentLocks.unshift({
            time: new Date(),
            amount: lockAmount,
            percentage: PROFIT_SAFE_PERCENT,
            totalSafe: profitProtection.safeBalance,
            reason: 'permanent_profit_lock'
        });
        
        botState.stats.lockedProfit = profitProtection.safeBalance;
        botState.stats.permanentLocked = profitProtection.safeBalance;
        
        console.log(`\n🔒 PERMANENT LOCK: ${lockAmount.toFixed(8)} BTC (${PROFIT_SAFE_PERCENT}% of profit)`);
        console.log(`   💰 TOTAL PERMANENTLY PROTECTED: ${profitProtection.safeBalance.toFixed(8)} BTC`);
        console.log(`   ⚠️  This amount is SAFE and will NEVER be traded again!\n`);
        
        saveState();
    }
    return lockAmount;
}

function checkAndLockProfitPermanent() {
    const currentNetProfit = botState.stats.netProfit;
    const lockedSoFar = profitProtection.safeBalance;
    const eligibleProfit = currentNetProfit - lockedSoFar;
    
    if (eligibleProfit > 0.00000001) {
        return lockProfitPermanently(eligibleProfit);
    }
    return 0;
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
                lockHistory: profitProtection.lockHistory.slice(-50),
                permanentLocks: profitProtection.permanentLocks.slice(-50)
            },
            betHistory: botState.betHistory.slice(-100),
            restartCount: botState.restartCount
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
            botState.restartCount = data.restartCount || 0;
            if (data.profitProtection) {
                profitProtection.safeBalance = data.profitProtection.safeBalance || 0;
                profitProtection.totalProfitEver = data.profitProtection.totalProfitEver || 0;
                profitProtection.lockHistory = data.profitProtection.lockHistory || [];
                profitProtection.permanentLocks = data.profitProtection.permanentLocks || [];
            }
            console.log(`🔒 Loaded PERMANENTLY PROTECTED balance: ${profitProtection.safeBalance.toFixed(8)} BTC`);
            console.log(`💰 Total profit ever made: ${profitProtection.totalProfitEver.toFixed(8)} BTC`);
        }
    } catch (e) {
        console.log('No previous session found - starting fresh');
    }
}

// ============ AUTO-RESTART MARTINGALE WITH PERMANENT PROTECTION ============
async function runMartingale() {
    const settings = botState.settings;
    
    while (botState.running) {
        // Check profit target
        if (botState.stats.netProfit >= STOP_ON_PROFIT) {
            console.log(`\n🎯 Profit target reached: ${botState.stats.netProfit.toFixed(8)} BTC`);
            checkAndLockProfitPermanent();
            console.log(`\n🔄 Auto-restarting bot in 10 seconds...`);
            await new Promise(r => setTimeout(r, 10000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue; // Restart the loop with fresh state
            } else {
                break;
            }
        }
        
        // Check loss limit
        if (botState.stats.netProfit <= -STOP_ON_LOSS) {
            console.log(`\n🛑 Loss limit reached: ${botState.stats.netProfit.toFixed(8)} BTC`);
            console.log(`\n🔄 Auto-restarting bot in 30 seconds...`);
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
            console.log(`\n⚠️ Max bet reached: ${settings.currentBet}`);
            console.log(`\n🔄 Auto-restarting bot in 60 seconds...`);
            await new Promise(r => setTimeout(r, 60000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Get current balance
        const userInfo = await getUserInfo();
        if (!userInfo.success) {
            console.log('⚠️ Cannot get balance, retrying in 5 seconds...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const totalBalance = userInfo.balance;
        const tradingBalance = totalBalance - profitProtection.safeBalance;
        
        if (settings.currentBet > tradingBalance) {
            console.log(`\n⚠️ Insufficient trading balance!`);
            console.log(`   Trading: ${tradingBalance.toFixed(8)} | Need: ${settings.currentBet}`);
            console.log(`\n🔄 Auto-restarting after balance check in 30 seconds...`);
            await new Promise(r => setTimeout(r, 30000));
            
            if (botState.autoRestart) {
                await restartBot();
                continue;
            } else {
                break;
            }
        }
        
        // Place bet
        const result = await placeDiceBet(settings.currentBet, settings.winChance);
        
        if (!result.success) {
            console.log('⚠️ Bet failed, retrying in 5 seconds...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        // Update stats
        botState.stats.totalBets++;
        botState.stats.netProfit += result.profit;
        botState.stats.currentBalance = totalBalance + result.profit;
        
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
            safeBalance: profitProtection.safeBalance,
            permanentLocked: locked,
            restartCount: botState.restartCount
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log with permanent lock indicator
        const emoji = result.isWin ? '✅' : '❌';
        console.log(`${emoji} #${botState.stats.totalBets} | Bet: ${settings.currentBet.toFixed(8)} | Roll: ${result.roll} | Profit: ${result.profit.toFixed(8)} | Net: ${botState.stats.netProfit.toFixed(8)} | 🔒 PERMANENT: ${profitProtection.safeBalance.toFixed(8)}`);
        
        if (locked > 0) {
            console.log(`   🔒 PERMANENTLY LOCKED ${locked.toFixed(8)} BTC (${PROFIT_SAFE_PERCENT}% of profit saved FOREVER!)`);
        }
        
        saveState();
        await new Promise(r => setTimeout(r, 1500));
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
    
    // Brief pause before restart
    await new Promise(r => setTimeout(r, 5000));
    
    // Get fresh balance
    const userInfo = await getUserInfo();
    if (userInfo.success) {
        botState.stats.currentBalance = userInfo.balance;
        console.log(`💰 Current balance: ${userInfo.balance.toFixed(8)} BTC`);
        console.log(`🔒 Permanently protected: ${profitProtection.safeBalance.toFixed(8)} BTC`);
        console.log(`💳 Trading balance: ${(userInfo.balance - profitProtection.safeBalance).toFixed(8)} BTC`);
    }
    
    console.log(`\n🔄 Restart #${botState.restartCount} - Resuming bot...\n`);
    
    // Start bot again
    botState.running = true;
    saveState();
    
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
    botState.autoRestart = true; // Auto-restart always enabled
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    // Verify connection
    const userInfo = await getUserInfo();
    if (!userInfo.success) {
        console.error('❌ Cannot connect to Bitsler API. Please check your access token.');
        botState.running = false;
        return;
    }
    
    if (profitProtection.safeBalance === 0) {
        console.log('\n💡 FIRST RUN: 50% of all profits will be PERMANENTLY LOCKED and NEVER traded again!');
    }
    
    console.log('\n🚀 Starting Martingale with PERMANENT Profit Protection');
    console.log(`   Base Bet: ${BASE_BET} satoshi`);
    console.log(`   Win Chance: ${WIN_CHANCE}%`);
    console.log(`   Stop Profit: ${STOP_ON_PROFIT} | Stop Loss: ${STOP_ON_LOSS}`);
    console.log(`   🔒 ${PROFIT_SAFE_PERCENT}% of ALL profits locked PERMANENTLY!`);
    console.log(`   🔄 AUTO-RESTART: ENABLED (bot will never stop automatically)\n`);
    
    await runMartingale();
    
    // This will only be reached if auto-restart is disabled (which it isn't)
    console.log('\n========================================');
    console.log('📊 BOT STATS (Will auto-restart)');
    console.log('========================================');
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses}`);
    console.log(`Win Rate: ${botState.stats.totalBets > 0 ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0}%`);
    console.log(`Net Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`🔒 PERMANENTLY LOCKED: ${profitProtection.safeBalance.toFixed(8)} BTC (${PROFIT_SAFE_PERCENT}% of all profit)`);
    console.log(`🔄 Bot will auto-restart shortly...`);
    console.log('========================================\n');
    
    saveState();
    botState.running = false;
    
    // Auto-restart
    if (botState.autoRestart) {
        await new Promise(r => setTimeout(r, 10000));
        await startBot();
    }
}

function stopBot() {
    botState.running = false;
    botState.autoRestart = false; // Disable auto-restart on manual stop
    checkAndLockProfitPermanent();
    saveState();
    console.log('\n⏹️ Bot stopped manually (auto-restart disabled)');
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = botState.stats.startTime 
        ? Math.floor((Date.now() - new Date(botState.stats.startTime).getTime()) / 1000)
        : 0;
    const minutes = Math.floor(uptime / 60);
    
    const winRate = botState.stats.totalBets > 0 
        ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)
        : 0;
    
    const tradingBalance = Math.max(0, botState.stats.currentBalance - profitProtection.safeBalance);
    const totalProfitEver = profitProtection.totalProfitEver;
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Bitsler Bot - 50% PERMANENT PROFIT PROTECTION</title>
    <meta http-equiv="refresh" content="3">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stats { display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; text-align: center; min-width: 180px; }
        .stat-value { font-size: 24px; font-weight: bold; }
        .safe { color: #ffaa00; }
        .permanent { color: #ff6600; }
        .trading { color: #00ccff; }
        button { background: #00ff88; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; font-weight: bold; }
        button.danger { background: #ff4444; color: #fff; }
        .live { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; margin-right: 8px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        .profit-protection { border: 2px solid #ff6600; background: #2a1f1a; }
        .badge { background: #ff6600; color: #000; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; }
        .auto-restart { background: #00ccff; color: #000; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 Bitsler Dice Bot <span class="badge">🔒 PERMANENT 50% PROTECTION</span> <span class="badge auto-restart">🔄 AUTO-RESTART ON</span></h1>
        
        <div class="card">
            <div><span class="live"></span> <strong>${botState.running ? 'RUNNING' : 'STOPPED'}</strong> | Uptime: ${minutes} minutes | Restarts: ${botState.restartCount}</div>
            <div style="margin-top: 15px;">
                ${!botState.running ? '<button onclick="start()">▶️ START BOT</button>' : '<button onclick="stop()" class="danger">⏹️ STOP BOT</button>'}
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card profit-protection">
                <div class="stat-value permanent">${profitProtection.safeBalance.toFixed(8)}</div>
                <div>🔒 PERMANENTLY PROTECTED</div>
                <div style="font-size: 10px;">50% of ALL profits - NEVER TRADED AGAIN</div>
            </div>
            <div class="stat-card">
                <div class="stat-value trading">${tradingBalance.toFixed(8)}</div>
                <div>💳 ACTIVE TRADING BALANCE</div>
                <div style="font-size: 10px;">Only this is used for betting</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${botState.stats.currentBalance.toFixed(8)}</div>
                <div>💰 TOTAL BALANCE</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:${botState.stats.netProfit >= 0 ? '#00ff88' : '#ff4444'}">${botState.stats.netProfit.toFixed(8)}</div>
                <div>📊 NET PROFIT</div>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${profitProtection.totalProfitEver.toFixed(8)}</div>
                <div>💰 TOTAL PROFIT EVER</div>
                <div style="font-size: 10px;">Lifetime profit generated</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${botState.stats.totalBets}</div>
                <div>Total Bets</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:#00ff88">${botState.stats.wins}</div>
                <div>Wins</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color:#ff4444">${botState.stats.losses}</div>
                <div>Losses</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${winRate}%</div>
                <div>Win Rate</div>
            </div>
        </div>
        
        <div class="card">
            <h3>📜 Recent Bets <span style="font-size: 10px;">(50% profit permanently locked from each win)</span></h3>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Bet</th>
                            <th>Roll</th>
                            <th>Result</th>
                            <th>Profit</th>
                            <th>Net Profit</th>
                            <th>🔒 PERMANENT</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${botState.betHistory.slice(0, 30).map(b => `
                            <tr>
                                <td>${new Date(b.time).toLocaleTimeString()}</td>
                                <td>${b.amount.toFixed(8)}</td>
                                <td>${b.roll}</td>
                                <td style="color:${b.isWin ? '#00ff88' : '#ff4444'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
                                <td style="color:${b.profit >= 0 ? '#00ff88' : '#ff4444'}">${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(8)}</td>
                                <td style="color:${b.netProfit >= 0 ? '#00ff88' : '#ff4444'}">${b.netProfit >= 0 ? '+' : ''}${b.netProfit.toFixed(8)}</td>
                                <td style="color:#ff6600">${b.permanentLocked > 0 ? '🔒 ' + b.permanentLocked.toFixed(8) : '-'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>🔒 Permanent Profit Protection Log</h3>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr><th>Time</th><th>Amount Locked</th><th>Total Protected</th><th>Reason</th></tr>
                    </thead>
                    <tbody>
                        ${profitProtection.permanentLocks.slice(0, 20).map(lock => `
                            <tr>
                                <td>${new Date(lock.time).toLocaleString()}</td>
                                <td style="color:#ffaa00">${lock.amount.toFixed(8)} BTC</td>
                                <td style="color:#00ff88">${lock.totalSafe.toFixed(8)} BTC</td>
                                <td>${lock.reason} (${lock.percentage}%)</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card" style="background: #1a2a1f;">
            <h3>💡 How 50% Permanent Profit Protection Works</h3>
            <ul style="margin-left: 20px; line-height: 1.8;">
                <li>✅ <strong>50% of EVERY profit is LOCKED PERMANENTLY</strong></li>
                <li>✅ Locked amount is <strong>NEVER used for betting again</strong></li>
                <li>✅ This creates a <strong>permanent profit reserve</strong> that grows over time</li>
                <li>✅ Bot <strong>AUTO-RESTARTS</strong> when targets are reached or issues occur</li>
                <li>✅ Your locked profits are <strong>SAFE</strong> regardless of future losses</li>
                <li>✅ The other 50% stays in trading balance for continued growth</li>
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
            tradingBalance: Math.max(0, botState.stats.currentBalance - profitProtection.safeBalance),
            permanentLockPercentage: PROFIT_SAFE_PERCENT
        }
    });
});

// ============ MAIN ============
async function main() {
    console.log('🔐 Testing Bitsler API connection...');
    
    // Test connection immediately
    const userInfo = await getUserInfo();
    if (!userInfo.success) {
        console.error('\n❌ Failed to connect to Bitsler API');
        console.error('\n🔴 IMPORTANT: Your access token appears to be INVALID');
        console.error('   1. Login to Bitsler.com');
        console.error('   2. Press F12 -> Console tab');
        console.error('   3. Type: console.log(access_token)');
        console.error('   4. Copy the token to .env file');
        console.error('   5. Restart the bot\n');
        process.exit(1);
    }
    
    loadState();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}`);
        console.log(`\n✅ Bot ready with PERMANENT 50% PROFIT PROTECTION!`);
        console.log(`🔒 ${PROFIT_SAFE_PERCENT}% of ALL profits will be LOCKED PERMANENTLY`);
        console.log(`🔄 AUTO-START: ENABLED - Bot will never stop automatically`);
        console.log(`\n⚠️  Locked profits are SAFE and will NEVER be traded again!\n`);
    });
    
    // AUTO-START the bot immediately (no manual intervention needed)
    console.log('🚀 Auto-starting bot in 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));
    await startBot();
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    checkAndLockProfitPermanent();
    saveState();
    process.exit(0);
});

main().catch(console.error);
