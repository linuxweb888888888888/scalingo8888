// bitsler-bot.js - FIXED VERSION using access_token method from working PHP bot
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ LOAD CONFIGURATION ============
// THIS IS THE KEY CHANGE: Use ACCESS_TOKEN, not an API key
const ACCESS_TOKEN = process.env.BITSLER_ACCESS_TOKEN;
const PROFIT_SAFE_PERCENT = parseFloat(process.env.PROFIT_SAFE_PERCENT) || 50;
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

// Mask for display (show first/last few chars)
const maskedToken = ACCESS_TOKEN.substring(0, 8) + '...' + ACCESS_TOKEN.substring(ACCESS_TOKEN.length - 4);

console.log('\n========================================');
console.log('  🎲 Bitsler Dice Bot - WORKING API');
console.log('========================================');
console.log(`🔐 Using Access Token: ${maskedToken}`);
console.log(`💰 Profit Safe: ${PROFIT_SAFE_PERCENT}%`);
console.log('========================================\n');

// ============ API CONFIGURATION ============
const API_BASE = 'https://www.bitsler.com/api';

// Create axios instance with the access_token in headers
const api = axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'BitslerNodeBot/1.0'
    }
});

// ============ CORRECT API FUNCTIONS (Based on working PHP bot) ============

// Get user info and balance - Using /api/get-info endpoint
async function getUserInfo() {
    try {
        // The working PHP bot sends token in request data, not headers
        // Let's try both methods
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

// Place a dice bet - Using /api/dice-bet endpoint
async function placeDiceBet(amount, winChance, choice = 'high') {
    try {
        // Based on working PHP bot: sends token, amount, and type (1 for dice)
        const betData = {
            token: ACCESS_TOKEN,
            amount: amount.toString(),
            win_chance: winChance,
            type: 1 // 1 = Roll Dice game
        };
        
        // Add high/low choice if needed (original PHP bot may handle this differently)
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

// ============ PROFIT PROTECTION SYSTEM ============
let profitProtection = {
    safeBalance: 0,
    startingBalance: 0,
    totalProfitEver: 0,
    lockHistory: []
};

let botState = {
    running: false,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        lockedProfit: 0,
        currentBalance: 0,
        startTime: null
    },
    settings: {
        baseBet: BASE_BET,
        currentBet: BASE_BET,
        winChance: WIN_CHANCE,
        maxBet: MAX_BET
    },
    betHistory: []
};

// ============ PROFIT PROTECTION FUNCTIONS ============
function lockProfit(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0.00000001) {
        profitProtection.safeBalance += lockAmount;
        profitProtection.totalProfitEver += lockAmount;
        profitProtection.lockHistory.unshift({
            time: new Date(),
            amount: lockAmount,
            totalSafe: profitProtection.safeBalance
        });
        
        botState.stats.lockedProfit = profitProtection.safeBalance;
        
        console.log(`\n🔒 PROFIT LOCKED: ${lockAmount.toFixed(8)} BTC added to SAFE!`);
        console.log(`   💰 Total SAFE (never traded): ${profitProtection.safeBalance.toFixed(8)} BTC\n`);
        
        saveState();
    }
    return lockAmount;
}

function checkAndLockProfit() {
    const currentNetProfit = botState.stats.netProfit;
    const lockedSoFar = profitProtection.safeBalance;
    const eligibleProfit = currentNetProfit - lockedSoFar;
    
    if (eligibleProfit > 0.00000001) {
        return lockProfit(eligibleProfit);
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
                lockHistory: profitProtection.lockHistory.slice(-50)
            },
            betHistory: botState.betHistory.slice(-100)
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
            if (data.profitProtection) {
                profitProtection.safeBalance = data.profitProtection.safeBalance || 0;
                profitProtection.totalProfitEver = data.profitProtection.totalProfitEver || 0;
                profitProtection.lockHistory = data.profitProtection.lockHistory || [];
            }
            console.log(`🔒 Loaded SAFE balance: ${profitProtection.safeBalance.toFixed(8)} BTC`);
        }
    } catch (e) {
        console.log('No previous session found');
    }
}

// ============ MARTINGALE WITH PROFIT PROTECTION ============
async function runMartingale() {
    const settings = botState.settings;
    
    while (botState.running) {
        // Stop conditions
        if (botState.stats.netProfit >= STOP_ON_PROFIT) {
            console.log(`\n🎯 Profit target reached: ${botState.stats.netProfit.toFixed(8)} BTC`);
            checkAndLockProfit();
            break;
        }
        if (botState.stats.netProfit <= -STOP_ON_LOSS) {
            console.log(`\n🛑 Loss limit reached: ${botState.stats.netProfit.toFixed(8)} BTC`);
            break;
        }
        if (settings.currentBet > settings.maxBet) {
            console.log(`\n⚠️ Max bet reached: ${settings.currentBet}`);
            break;
        }
        
        // Get current balance first
        const userInfo = await getUserInfo();
        if (!userInfo.success) {
            console.log('⚠️ Cannot get balance, retrying...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const totalBalance = userInfo.balance;
        const tradingBalance = totalBalance - profitProtection.safeBalance;
        
        if (settings.currentBet > tradingBalance) {
            console.log(`\n⚠️ Insufficient trading balance!`);
            console.log(`   Trading: ${tradingBalance.toFixed(8)} | Need: ${settings.currentBet}`);
            break;
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
        
        // Lock profit (50% of net profit)
        const locked = checkAndLockProfit();
        
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
            locked: locked
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log
        const emoji = result.isWin ? '✅' : '❌';
        console.log(`${emoji} #${botState.stats.totalBets} | Bet: ${settings.currentBet.toFixed(8)} | Roll: ${result.roll} | Profit: ${result.profit.toFixed(8)} | Net: ${botState.stats.netProfit.toFixed(8)} | 🔒 SAFE: ${profitProtection.safeBalance.toFixed(8)}`);
        
        if (locked > 0) {
            console.log(`   🔒 LOCKED ${locked.toFixed(8)} BTC (${PROFIT_SAFE_PERCENT}% of profit saved!)`);
        }
        
        saveState();
        await new Promise(r => setTimeout(r, 1500));
    }
    
    return true;
}

// ============ BOT CONTROL ============
async function startBot() {
    if (botState.running) {
        console.log('Bot already running');
        return;
    }
    
    botState.running = true;
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    // Verify connection first
    const userInfo = await getUserInfo();
    if (!userInfo.success) {
        console.error('❌ Cannot connect to Bitsler API. Please check your access token.');
        botState.running = false;
        return;
    }
    
    if (profitProtection.startingBalance === 0) {
        profitProtection.startingBalance = userInfo.balance;
    }
    
    console.log('\n🚀 Starting Martingale with Profit Protection');
    console.log(`   Base Bet: ${BASE_BET} satoshi`);
    console.log(`   Win Chance: ${WIN_CHANCE}%`);
    console.log(`   Stop Profit: ${STOP_ON_PROFIT} | Stop Loss: ${STOP_ON_LOSS}`);
    console.log(`   🔒 ${PROFIT_SAFE_PERCENT}% of profits locked forever!\n`);
    
    await runMartingale();
    
    console.log('\n========================================');
    console.log('📊 FINAL STATS');
    console.log('========================================');
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses}`);
    console.log(`Win Rate: ${botState.stats.totalBets > 0 ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0}%`);
    console.log(`Net Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`🔒 SAFE Balance: ${profitProtection.safeBalance.toFixed(8)} BTC (PROTECTED - never traded)`);
    console.log('========================================\n');
    
    saveState();
    botState.running = false;
}

function stopBot() {
    botState.running = false;
    checkAndLockProfit();
    saveState();
    console.log('\n⏹️ Bot stopped');
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
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Bitsler Bot - WORKING VERSION</title>
    <meta http-equiv="refresh" content="3">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stats { display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; }
        .stat-card { background: #1a1f3a; padding: 20px; border-radius: 10px; text-align: center; min-width: 180px; }
        .stat-value { font-size: 24px; font-weight: bold; }
        .safe { color: #ffaa00; }
        .trading { color: #00ccff; }
        button { background: #00ff88; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; font-weight: bold; }
        button.danger { background: #ff4444; color: #fff; }
        .live { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; margin-right: 8px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        .profit-protection { border: 2px solid #ffaa00; }
        .badge { background: #ffaa00; color: #000; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 Bitsler Dice Bot <span class="badge">🔒 ${PROFIT_SAFE_PERCENT}% PROFIT PROTECTION</span> <span class="badge" style="background:#00ccff">✅ WORKING API</span></h1>
        
        <div class="card">
            <div><span class="live"></span> <strong>${botState.running ? 'RUNNING' : 'STOPPED'}</strong> | Uptime: ${minutes} minutes</div>
            <div style="margin-top: 15px;">
                ${!botState.running ? '<button onclick="start()">▶️ START BOT</button>' : '<button onclick="stop()" class="danger">⏹️ STOP BOT</button>'}
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card profit-protection">
                <div class="stat-value safe">${profitProtection.safeBalance.toFixed(8)}</div>
                <div>🔒 SAFE BALANCE</div>
                <div style="font-size: 10px;">NEVER TRADED - PERMANENTLY PROTECTED</div>
            </div>
            <div class="stat-card">
                <div class="stat-value trading">${tradingBalance.toFixed(8)}</div>
                <div>💳 TRADING BALANCE</div>
                <div style="font-size: 10px;">Only this is used for bets</div>
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
            <h3>📜 Recent Bets</h3>
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
                            <th>🔒 SAFE</th>
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
                                <td style="color:#ffaa00">${b.safeBalance?.toFixed(8) || '0'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card" style="background: #1a2a1f;">
            <h3>💡 How to Get Your Access Token (Working Method)</h3>
            <ol style="margin-left: 20px; line-height: 1.8;">
                <li>✅ Login to <strong>Bitsler.com</strong> using Firefox or Chrome</li>
                <li>✅ Press <strong>F12</strong> to open Developer Tools</li>
                <li>✅ Click the <strong>Console</strong> tab</li>
                <li>✅ Type: <strong><code>console.log(access_token)</code></strong> and press Enter</li>
                <li>✅ Copy the token that appears</li>
                <li>✅ Add it to your <strong>.env</strong> file as <code>BITSLER_ACCESS_TOKEN=your_token_here</code></li>
            </ol>
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
        stats: botState.stats,
        settings: botState.settings,
        profitProtection: {
            safeBalance: profitProtection.safeBalance,
            tradingBalance: Math.max(0, botState.stats.currentBalance - profitProtection.safeBalance)
        }
    });
});

// ============ MAIN ============
async function main() {
    console.log('🔐 Testing Bitsler API connection with access_token...');
    console.log('   Using working endpoints from GitHub PHP bot:');
    console.log('   - GET /api/get-info (with token param)');
    console.log('   - POST /api/dice-bet (with token in body)\n');
    
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
        console.log(`\n✅ Bot ready with WORKING Bitsler API!`);
        console.log(`🔒 ${PROFIT_SAFE_PERCENT}% of all profits will be LOCKED and PROTECTED`);
        console.log(`\n⚠️  Make sure you have REVOKED the compromised API key!\n`);
    });
    
    // Auto-start if configured
    if (process.env.AUTO_START === 'true') {
        console.log('🚀 Auto-start enabled...');
        await startBot();
    }
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down...');
    checkAndLockProfit();
    saveState();
    process.exit(0);
});

main().catch(console.error);
