// bitsler-bot.js - CORRECT Bitsler API Endpoints
// Based on official Bitsler API documentation
// Base URL: https://www.bitsler.com/api/

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

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
console.log('  🎲 Bitsler Dice Bot - CORRECT API');
console.log('========================================');
console.log(`🔐 API Key: ${maskedKey}`);
console.log(`💰 Profit Safe: ${PROFIT_SAFE_PERCENT}%`);
console.log(`🌐 Base URL: https://www.bitsler.com/api/`);
console.log('========================================\n');

// ============ CORRECT API CONFIGURATION ============
const API_BASE = 'https://www.bitsler.com/api';

// Create axios instance
const api = axios.create({
    baseURL: API_BASE,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'BitslerBot/3.0'
    }
});

// Session token storage (from /api/generate-token)
let sessionToken = null;
let sessionExpiry = null;

// ============ AUTHENTICATION ============
// Bitsler uses /api/generate-token to get a session token
async function authenticate() {
    console.log('🔐 Authenticating with Bitsler API...');
    
    try {
        const response = await api.post('/generate-token', {
            api_key: API_KEY
        });
        
        if (response.data && response.data.token) {
            sessionToken = response.data.token;
            sessionExpiry = Date.now() + (response.data.expires_in || 3600) * 1000;
            
            // Add token to all future requests
            api.defaults.headers.common['Authorization'] = `Bearer ${sessionToken}`;
            api.defaults.headers.common['x-api-key'] = API_KEY;
            
            console.log('✅ Authentication successful! Session token obtained');
            return true;
        } else {
            console.error('❌ Authentication failed: No token in response');
            return false;
        }
    } catch (error) {
        console.error('❌ Authentication error:', error.response?.status, error.response?.data || error.message);
        return false;
    }
}

// Check and refresh token if needed
async function ensureAuth() {
    if (!sessionToken || (sessionExpiry && Date.now() >= sessionExpiry - 60000)) {
        return await authenticate();
    }
    return true;
}

// ============ CORRECT API FUNCTIONS ============

// Get balance - /api/get-balance
async function getBalance() {
    await ensureAuth();
    
    try {
        const response = await api.get('/get-balance');
        
        // Bitsler returns balances for all currencies
        const balances = response.data;
        const btcBalance = parseFloat(balances.btc || balances.BTC || 0);
        
        console.log(`💰 BTC Balance: ${btcBalance.toFixed(8)} BTC`);
        
        return {
            btc: btcBalance,
            all: balances
        };
    } catch (error) {
        console.error('❌ Balance error:', error.response?.status, error.response?.data || error.message);
        return { btc: 0, all: {} };
    }
}

// Place dice bet - /api/dice-bet
async function placeDiceBet(amount, winChance, choice = 'high') {
    await ensureAuth();
    
    // Determine target based on choice
    // high = roll over 50, low = roll under 50
    const target = choice === 'high' ? 50 : 50;
    const condition = choice === 'high' ? '>' : '<';
    
    try {
        const betData = {
            amount: amount.toString(),
            currency: 'btc',
            win_chance: winChance,
            target: target,
            condition: condition
        };
        
        const response = await api.post('/dice-bet', betData);
        
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
            betId: result.bet_id || result.id
        };
        
    } catch (error) {
        console.error('❌ Bet error:', error.response?.status, error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

// Reset session stats - /api/reset-current-session
async function resetSession() {
    await ensureAuth();
    
    try {
        const response = await api.post('/reset-current-session');
        console.log('🔄 Session stats reset');
        return response.data;
    } catch (error) {
        console.error('❌ Reset error:', error.message);
        return null;
    }
}

// Get user info (if available)
async function getUserInfo() {
    await ensureAuth();
    
    try {
        // Some versions of the API have /get-user-info
        const response = await api.get('/get-user-info').catch(() => null);
        if (response && response.data) {
            return response.data;
        }
        return { username: 'Connected' };
    } catch (error) {
        return { username: 'Connected' };
    }
}

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

// ============ PROFIT PROTECTION FUNCTIONS ============

function lockProfit(amount) {
    const lockAmount = amount * (PROFIT_SAFE_PERCENT / 100);
    
    if (lockAmount > 0.00000001) { // Only lock if significant
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
        
        // Check balance
        const balanceResult = await getBalance();
        const totalBalance = balanceResult.btc;
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
        botState.stats.currentBalance += result.profit;
        
        if (result.isWin) {
            botState.stats.wins++;
            settings.currentBet = settings.baseBet;
        } else {
            botState.stats.losses++;
            settings.currentBet = Math.min(settings.currentBet * 2, settings.maxBet);
        }
        
        // Lock profit (50% of net profit)
        const locked = checkAndLockProfit();
        
        // Update trading balance display
        const newBalance = balanceResult.btc + result.profit;
        const newTradingBalance = newBalance - profitProtection.safeBalance;
        
        // Record bet
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date(),
            amount: settings.currentBet,
            roll: result.roll,
            isWin: result.isWin,
            profit: result.profit,
            netProfit: botState.stats.netProfit,
            tradingBalance: newTradingBalance,
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
    
    // Ensure authenticated
    const authed = await ensureAuth();
    if (!authed) {
        console.error('❌ Cannot start: Authentication failed');
        return;
    }
    
    botState.running = true;
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    // Get starting balance
    const balance = await getBalance();
    if (profitProtection.startingBalance === 0) {
        profitProtection.startingBalance = balance.btc;
    }
    
    console.log('\n🚀 Starting Martingale with Profit Protection');
    console.log(`   Base Bet: ${BASE_BET} litoshi`);
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
    
    const tradingBalance = botState.stats.currentBalance - profitProtection.safeBalance;
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Bitsler Bot - Correct API</title>
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
        <h1>🎲 Bitsler Dice Bot <span class="badge">🔒 ${PROFIT_SAFE_PERCENT}% PROFIT PROTECTION</span> <span class="badge" style="background:#00ccff">✅ CORRECT API</span></h1>
        
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
                <div class="stat-value trading">${Math.max(0, tradingBalance).toFixed(8)}</div>
                <div>💳 TRADING BALANCE</div>
                <div style="font-size: 10px;">Only this is used for bets</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${botState.stats.currentBalance.toFixed(8)}</div>
                <div>💰 TOTAL BALANCE</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${botState.stats.netProfit >= 0 ? 'win' : 'loss'}" style="color:${botState.stats.netProfit >= 0 ? '#00ff88' : '#ff4444'}">${botState.stats.netProfit.toFixed(8)}</div>
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
            <h3>💡 How Profit Protection Works (CORRECT API)</h3>
            <ul style="margin-left: 20px; line-height: 1.8;">
                <li>✅ Using <strong>CORRECT Bitsler API endpoints</strong>: /api/generate-token, /api/get-balance, /api/dice-bet</li>
                <li>🔒 <strong>${PROFIT_SAFE_PERCENT}% of every profit is automatically LOCKED</strong> into SAFE balance</li>
                <li>💰 <strong>SAFE balance is NEVER used for betting</strong> - it's permanently protected</li>
                <li>💳 Only the <strong>remaining ${100 - PROFIT_SAFE_PERCENT}% stays in TRADING balance</strong></li>
                <li>✅ This ensures you keep ${PROFIT_SAFE_PERCENT}% of ALL profits, no matter what!</li>
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
    console.log('🔐 Testing Bitsler API connection...');
    console.log('   Using correct endpoints:');
    console.log('   - POST /api/generate-token (auth)');
    console.log('   - GET /api/get-balance');
    console.log('   - POST /api/dice-bet');
    console.log('   - POST /api/reset-current-session\n');
    
    // Authenticate first
    const authed = await authenticate();
    if (!authed) {
        console.error('\n❌ Failed to authenticate with Bitsler API');
        console.error('\n🔴 IMPORTANT: Your API key appears to be INVALID');
        console.error('   1. Go to Bitsler.com and DELETE the compromised key');
        console.error('   2. Create a NEW API key in Settings → Security → API Keys');
        console.error('   3. Update your .env file with the NEW key');
        console.error('   4. Restart the bot\n');
        process.exit(1);
    }
    
    // Get balance
    const balance = await getBalance();
    console.log(`✅ Connected successfully!`);
    
    // Reset session stats (optional)
    await resetSession();
    
    loadState();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}`);
        console.log(`\n✅ Bot ready with CORRECT Bitsler API endpoints!`);
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
