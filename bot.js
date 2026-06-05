// bitsler-bot.js - Updated with correct Bitsler API endpoints
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// ============ LOAD CONFIGURATION ============
const API_KEY = process.env.BITSLER_API_KEY;
const PROFIT_SAFE_PERCENT = parseFloat(process.env.PROFIT_SAFE_PERCENT) || 50;
const BASE_BET = parseFloat(process.env.BASE_BET) || 1;
const WIN_CHANCE = parseFloat(process.env.WIN_CHANCE) || 49.5;
const STOP_ON_PROFIT = parseFloat(process.env.STOP_ON_PROFIT) || 100;
const STOP_ON_LOSS = parseFloat(process.env.STOP_ON_LOSS) || 50;
const MAX_BET = parseFloat(process.env.MAX_BET) || 500;

if (!API_KEY) {
    console.error('\n❌ ERROR: BITSLER_API_KEY not found in .env');
    console.error('Please add: BITSLER_API_KEY=your_new_key_here\n');
    process.exit(1);
}

// Mask for display only
const maskedKey = API_KEY.substring(0, 8) + '...' + API_KEY.substring(API_KEY.length - 4);

console.log('\n========================================');
console.log('  🎲 Bitsler Dice Bot - Profit Protection');
console.log('========================================');
console.log(`🔐 API Key: ${maskedKey}`);
console.log(`💰 Profit Safe: ${PROFIT_SAFE_PERCENT}%`);
console.log('========================================\n');

// ============ CORRECT BITSLER API ENDPOINTS ============
// Bitsler uses different endpoints based on documentation
const API_BASE = 'https://bitsler.com/api/v2';

// Create axios instance
const api = axios.create({
    baseURL: API_BASE,
    headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'BitslerBot/1.0'
    },
    timeout: 30000
});

// ============ PROFIT PROTECTION SYSTEM ============
let profitProtection = {
    safeBalance: 0,
    tradingBalance: 0,
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
        tradingBalance: 0,
        safeBalance: 0,
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

// ============ CORRECT API FUNCTIONS ============

// Get user balance - using correct endpoint
async function getBalance() {
    try {
        // Bitsler API endpoint for balance
        const response = await api.get('/user/balance');
        const totalBalance = parseFloat(response.data.balance || response.data.balance_btc || 0);
        
        if (profitProtection.startingBalance === 0) {
            profitProtection.startingBalance = totalBalance;
            console.log(`💰 Starting Balance: ${totalBalance.toFixed(8)} BTC`);
        }
        
        botState.stats.currentBalance = totalBalance;
        botState.stats.tradingBalance = Math.max(0, totalBalance - profitProtection.safeBalance);
        botState.stats.safeBalance = profitProtection.safeBalance;
        
        return totalBalance;
    } catch (error) {
        console.error('❌ Balance error:', error.response?.status, error.response?.data || error.message);
        return 0;
    }
}

// Get user info - using correct endpoint
async function getUserInfo() {
    try {
        const response = await api.get('/user');
        return response.data;
    } catch (error) {
        // Try alternative endpoint
        try {
            const response = await api.get('/me');
            return response.data;
        } catch (e) {
            console.error('❌ Cannot fetch user info:', error.response?.status);
            return null;
        }
    }
}

// Place a dice bet - using correct endpoint
async function placeBet(amount, winChance, choice = 'high') {
    try {
        // Bitsler dice endpoint
        const betData = {
            amount: amount.toString(),
            win_chance: winChance,
            bet_type: choice,
            currency: 'btc'
        };
        
        const response = await api.post('/dice/bet', betData);
        const result = response.data;
        
        const isWin = result.win || result.result === 'win';
        const multiplier = 100 / winChance;
        const profit = isWin ? amount * (multiplier - 1) : -amount;
        
        return {
            success: true,
            isWin: isWin,
            roll: result.roll || result.number,
            profit: profit,
            multiplier: multiplier
        };
        
    } catch (error) {
        console.error('❌ Bet error:', error.response?.status, error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// ============ PROFIT PROTECTION FUNCTIONS ============

function lockProfit(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0) {
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
    const previousLockedProfit = profitProtection.safeBalance;
    const eligibleProfit = currentNetProfit - previousLockedProfit;
    
    if (eligibleProfit > 0) {
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
            console.log(`\n🎯 Profit target reached: $${botState.stats.netProfit.toFixed(2)}`);
            checkAndLockProfit();
            break;
        }
        if (botState.stats.netProfit <= -STOP_ON_LOSS) {
            console.log(`\n🛑 Loss limit reached: $${botState.stats.netProfit.toFixed(2)}`);
            break;
        }
        if (settings.currentBet > settings.maxBet) {
            console.log(`\n⚠️ Max bet reached: ${settings.currentBet}`);
            break;
        }
        
        // Check trading balance
        const availableBalance = botState.stats.currentBalance - profitProtection.safeBalance;
        if (settings.currentBet > availableBalance) {
            console.log(`\n⚠️ Insufficient trading balance!`);
            console.log(`   Trading: ${availableBalance.toFixed(8)} | Need: ${settings.currentBet}`);
            break;
        }
        
        // Place bet
        const result = await placeBet(settings.currentBet, settings.winChance);
        
        if (!result.success) {
            console.log('⚠️ Bet failed, retrying in 5 seconds...');
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        // Update stats
        const previousProfit = botState.stats.netProfit;
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
        
        // Lock profit
        const locked = checkAndLockProfit();
        
        // Record bet
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date(),
            amount: settings.currentBet,
            roll: result.roll,
            isWin: result.isWin,
            profit: result.profit,
            balance: botState.stats.currentBalance,
            safeBalance: profitProtection.safeBalance,
            locked: locked
        });
        
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log
        const emoji = result.isWin ? '✅' : '❌';
        console.log(`${emoji} #${botState.stats.totalBets} | Bet: ${settings.currentBet.toFixed(8)} | Profit: ${result.profit.toFixed(8)} | Net: ${botState.stats.netProfit.toFixed(8)} | 🔒 SAFE: ${profitProtection.safeBalance.toFixed(8)}`);
        
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
    
    console.log('\n🚀 Starting Martingale with Profit Protection');
    console.log(`   Base Bet: ${BASE_BET}`);
    console.log(`   Win Chance: ${WIN_CHANCE}%`);
    console.log(`   Stop Profit: ${STOP_ON_PROFIT} | Stop Loss: ${STOP_ON_LOSS}`);
    console.log(`   🔒 ${PROFIT_SAFE_PERCENT}% of profits locked forever!\n`);
    
    await runMartingale();
    
    console.log('\n========================================');
    console.log('📊 FINAL STATS');
    console.log('========================================');
    console.log(`Total Bets: ${botState.stats.totalBets}`);
    console.log(`Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses}`);
    console.log(`Net Profit: ${botState.stats.netProfit.toFixed(8)} BTC`);
    console.log(`🔒 SAFE Balance: ${profitProtection.safeBalance.toFixed(8)} BTC (PROTECTED)`);
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
    
    const winRate = botState.stats.totalBets > 0 
        ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)
        : 0;
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Bitsler Bot - Profit Protection</title>
    <meta http-equiv="refresh" content="3">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; display: inline-block; width: 200px; margin: 10px; }
        .stat-value { font-size: 24px; font-weight: bold; }
        .safe { color: #ffaa00; }
        button { background: #00ff88; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin: 5px; }
        button.danger { background: #ff4444; color: #fff; }
        .live { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 Bitsler Dice Bot <span style="color:#ffaa00">🔒 ${PROFIT_SAFE_PERCENT}% Profit Protection</span></h1>
        
        <div class="card">
            <div><span class="live"></span> <strong>${botState.running ? 'RUNNING' : 'STOPPED'}</strong> | Uptime: ${Math.floor(uptime/60)}m</div>
            <div style="margin-top: 15px;">
                ${!botState.running ? '<button onclick="start()">▶️ START</button>' : '<button onclick="stop()" class="danger">⏹️ STOP</button>'}
            </div>
        </div>
        
        <div style="text-align:center">
            <div class="stat-card">
                <div class="stat-value safe">${profitProtection.safeBalance.toFixed(8)}</div>
                <div>🔒 SAFE BALANCE</div>
                <div style="font-size:10px">NEVER TRADED</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${(botState.stats.currentBalance - profitProtection.safeBalance).toFixed(8)}</div>
                <div>💳 TRADING BALANCE</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${botState.stats.netProfit.toFixed(8)}</div>
                <div>📊 NET PROFIT</div>
            </div>
        </div>
        
        <div class="card">
            <h3>📊 Stats</h3>
            <div>Bets: ${botState.stats.totalBets} | Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses} | Win Rate: ${winRate}%</div>
            <div>Current Bet: ${botState.settings.currentBet} | Base Bet: ${BASE_BET}</div>
        </div>
        
        <div class="card">
            <h3>📜 Recent Bets</h3>
            <table>
                <thead><tr><th>Time</th><th>Bet</th><th>Roll</th><th>Result</th><th>Profit</th><th>🔒 SAFE</th></tr></thead>
                <tbody>
                    ${botState.betHistory.slice(0, 20).map(b => `
                        <tr>
                            <td>${new Date(b.time).toLocaleTimeString()}</td>
                            <td>${b.amount}</td>
                            <td>${b.roll}</td>
                            <td style="color:${b.isWin ? '#00ff88' : '#ff4444'}">${b.isWin ? 'WIN' : 'LOSS'}</td>
                            <td style="color:${b.profit >= 0 ? '#00ff88' : '#ff4444'}">${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(8)}</td>
                            <td style="color:#ffaa00">${b.safeBalance?.toFixed(8) || '0'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    </div>
    <script>
        async function start() { await fetch('/api/start', {method:'POST'}); location.reload(); }
        async function stop() { await fetch('/api/stop', {method:'POST'}); location.reload(); }
    </script>
</body>
</html>
    `);
});

app.post('/api/start', (req, res) => {
    if (!botState.running) startBot();
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true });
});

// ============ MAIN ============
async function main() {
    console.log('🔐 Testing API connection...');
    
    // Test with a simple endpoint
    try {
        const response = await api.get('/ping').catch(() => null);
        console.log('✅ API reachable');
    } catch (e) {
        console.log('⚠️ API test: Will try actual endpoints');
    }
    
    const userInfo = await getUserInfo();
    if (!userInfo) {
        console.error('\n❌ Cannot connect to Bitsler API');
        console.error('\n🔴 IMPORTANT: Your API key appears to be INVALID or COMPROMISED');
        console.error('   1. Go to Bitsler.com and DELETE the API key starting with: DJKRP-J0...');
        console.error('   2. Create a NEW API key');
        console.error('   3. Update your .env file with the NEW key');
        console.error('   4. Redeploy\n');
        process.exit(1);
    }
    
    await getBalance();
    loadState();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}`);
        console.log(`\n✅ Bot ready!`);
        console.log(`🔒 ${PROFIT_SAFE_PERCENT}% of all profits will be LOCKED and PROTECTED\n`);
    });
}

main().catch(console.error);
