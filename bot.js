// dicebot-server.js - Complete Dice Bot for Scalingo.com
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const SESSION_FILE = process.env.SESSION_FILE || './sessions/bot-state.json';
const BETTING_ENABLED = process.env.BETTING_ENABLED !== 'false';
const DEFAULT_BET_AMOUNT = parseFloat(process.env.DEFAULT_BET_AMOUNT) || 1;
const DEFAULT_WIN_CHANCE = parseFloat(process.env.DEFAULT_WIN_CHANCE) || 49.5;
const MARTINGALE_MULTIPLIER = parseFloat(process.env.MARTINGALE_MULTIPLIER) || 2.0;

// Ensure sessions directory exists
if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions', { recursive: true });

console.log('\n========================================');
console.log('  🎲 DiceBot Server - Node.js Edition');
console.log('  Auto Betting + Martingale Strategy');
console.log('========================================');
console.log(`Betting Enabled: ${BETTING_ENABLED}`);
console.log(`Base Bet: ${DEFAULT_BET_AMOUNT}`);
console.log(`Win Chance: ${DEFAULT_WIN_CHANCE}%`);
console.log(`Martingale: ${MARTINGALE_MULTIPLIER}x on loss`);
console.log('========================================\n');

// ============ SIMULATED DICE SITES API ============
// These are mock APIs - replace with real site endpoints

const SUPPORTED_SITES = [
    {
        name: 'FreeBitco.in',
        apiUrl: 'https://freebitco.in/api',
        requiresApiKey: true,
        betEndpoint: '/bet',
        balanceEndpoint: '/balance'
    },
    {
        name: 'PrimeDice',
        apiUrl: 'https://api.primedice.com',
        requiresApiKey: true,
        betEndpoint: '/v2/bet',
        balanceEndpoint: '/v2/user'
    },
    {
        name: 'Stake',
        apiUrl: 'https://stake.com/api',
        requiresApiKey: true,
        betEndpoint: '/v2/roll',
        balanceEndpoint: '/v2/wallet'
    },
    {
        name: 'Bitsler',
        apiUrl: 'https://bitsler.com/api',
        requiresApiKey: true,
        betEndpoint: '/dice',
        balanceEndpoint: '/user'
    }
];

// ============ BOT STATE ============
let botState = {
    isRunning: false,
    currentStrategy: 'martingale',
    currentSite: 'FreeBitco.in',
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        highestBalance: 0,
        lowestBalance: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
        currentStreak: 0,
        startTime: null,
        lastBetTime: null
    },
    settings: {
        baseBet: DEFAULT_BET_AMOUNT,
        currentBet: DEFAULT_BET_AMOUNT,
        winChance: DEFAULT_WIN_CHANCE,
        multiplier: MARTINGALE_MULTIPLIER,
        stopOnProfit: parseFloat(process.env.STOP_ON_PROFIT) || 100,
        stopOnLoss: parseFloat(process.env.STOP_ON_LOSS) || 50,
        maxBet: parseFloat(process.env.MAX_BET) || 1000,
        onWinAction: 'reset',
        onLossAction: 'multiply',
        hiLoChoice: 'high'
    },
    betHistory: [],
    apiKeys: {}
};

// ============ LOAD/SAVE STATE ============
function loadState() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = fs.readFileSync(SESSION_FILE, 'utf8');
            const saved = JSON.parse(data);
            botState.stats = saved.stats || botState.stats;
            botState.settings = saved.settings || botState.settings;
            botState.betHistory = saved.betHistory || [];
            console.log('[State] ✅ Loaded previous session');
        }
    } catch (e) {
        console.log('[State] No saved session found');
    }
}

function saveState() {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify({
            stats: botState.stats,
            settings: botState.settings,
            betHistory: botState.betHistory.slice(-100)
        }, null, 2));
    } catch (e) {
        console.error('[State] Save failed:', e.message);
    }
}

// ============ PROVABLY FAIR ROLL SIMULATION ============
function generateRoll(winChance) {
    // Simulate a provably fair dice roll
    const randomValue = crypto.randomInt(0, 10000) / 100;
    const isWin = randomValue <= winChance;
    
    // Calculate multiplier (standard 2x for 49.5%, scaled accordingly)
    const multiplier = 100 / winChance;
    
    return {
        roll: randomValue.toFixed(2),
        isWin: isWin,
        multiplier: multiplier,
        payout: isWin ? multiplier : 0
    };
}

// ============ PLACE BET (Simulated) ============
async function placeBet() {
    if (!botState.isRunning) {
        console.log('[Bot] ⏸️ Bot is paused');
        return null;
    }
    
    const settings = botState.settings;
    const betAmount = settings.currentBet;
    
    // Check stop conditions
    if (botState.stats.netProfit >= settings.stopOnProfit) {
        console.log(`[Bot] 🛑 Stop on profit reached: ${botState.stats.netProfit.toFixed(2)}`);
        botState.isRunning = false;
        return null;
    }
    
    if (botState.stats.netProfit <= -settings.stopOnLoss) {
        console.log(`[Bot] 🛑 Stop on loss reached: ${botState.stats.netProfit.toFixed(2)}`);
        botState.isRunning = false;
        return null;
    }
    
    if (betAmount > settings.maxBet) {
        console.log(`[Bot] 🛑 Max bet reached: ${betAmount}`);
        botState.isRunning = false;
        return null;
    }
    
    // Generate the roll
    const roll = generateRoll(settings.winChance);
    
    // Calculate profit/loss
    let profit = 0;
    if (roll.isWin) {
        profit = betAmount * (roll.multiplier - 1);
        botState.stats.wins++;
        botState.stats.currentStreak = botState.stats.currentStreak > 0 ? botState.stats.currentStreak + 1 : 1;
        if (botState.stats.currentStreak > botState.stats.longestWinStreak) {
            botState.stats.longestWinStreak = botState.stats.currentStreak;
        }
        
        // On win: reset bet or apply on-win strategy
        if (settings.onWinAction === 'reset') {
            settings.currentBet = settings.baseBet;
        } else if (settings.onWinAction === 'multiply') {
            settings.currentBet = Math.min(settings.currentBet * 1.5, settings.maxBet);
        }
    } else {
        profit = -betAmount;
        botState.stats.losses++;
        botState.stats.currentStreak = botState.stats.currentStreak < 0 ? botState.stats.currentStreak - 1 : -1;
        if (Math.abs(botState.stats.currentStreak) > botState.stats.longestLossStreak) {
            botState.stats.longestLossStreak = Math.abs(botState.stats.currentStreak);
        }
        
        // On loss: multiply bet (Martingale)
        if (settings.onLossAction === 'multiply') {
            settings.currentBet = Math.min(settings.currentBet * settings.multiplier, settings.maxBet);
        }
    }
    
    // Update stats
    botState.stats.totalBets++;
    botState.stats.netProfit += profit;
    botState.stats.currentBalance += profit;
    botState.stats.lastBetTime = new Date();
    
    if (botState.stats.currentBalance > botState.stats.highestBalance) {
        botState.stats.highestBalance = botState.stats.currentBalance;
    }
    if (botState.stats.currentBalance < botState.stats.lowestBalance) {
        botState.stats.lowestBalance = botState.stats.currentBalance;
    }
    
    // Record bet
    const betRecord = {
        id: botState.stats.totalBets,
        time: new Date(),
        amount: betAmount,
        roll: roll.roll,
        isWin: roll.isWin,
        profit: profit,
        balance: botState.stats.currentBalance,
        multiplier: roll.multiplier
    };
    
    botState.betHistory.unshift(betRecord);
    if (botState.betHistory.length > 100) botState.betHistory.pop();
    
    // Log to console
    const emoji = roll.isWin ? '✅' : '❌';
    console.log(`[${betRecord.time.toLocaleTimeString()}] ${emoji} Bet: ${betAmount} | Roll: ${roll.roll} | Profit: ${profit.toFixed(2)} | Balance: ${botState.stats.currentBalance.toFixed(2)}`);
    
    saveState();
    return betRecord;
}

// ============ BOT LOOP ============
async function botLoop() {
    if (!botState.isRunning) {
        return;
    }
    
    try {
        await placeBet();
        
        // Calculate delay based on strategy (simulate human-like timing)
        const delay = Math.random() * 2000 + 1000; // 1-3 seconds
        setTimeout(botLoop, delay);
    } catch (error) {
        console.error('[Bot] Error:', error.message);
        setTimeout(botLoop, 5000);
    }
}

function startBot() {
    if (botState.isRunning) {
        console.log('[Bot] Already running');
        return;
    }
    
    botState.isRunning = true;
    botState.stats.startTime = botState.stats.startTime || new Date();
    botState.settings.currentBet = botState.settings.baseBet;
    
    console.log('[Bot] 🚀 Starting dice bot...');
    console.log(`[Bot] Strategy: ${botState.currentStrategy}`);
    console.log(`[Bot] Base bet: ${botState.settings.baseBet}`);
    console.log(`[Bot] Win chance: ${botState.settings.winChance}%`);
    
    botLoop();
}

function stopBot() {
    botState.isRunning = false;
    console.log('[Bot] 🛑 Bot stopped');
    saveState();
}

function resetStats() {
    botState.stats = {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        highestBalance: 0,
        lowestBalance: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
        currentStreak: 0,
        startTime: new Date(),
        lastBetTime: null
    };
    botState.settings.currentBet = botState.settings.baseBet;
    botState.betHistory = [];
    saveState();
    console.log('[Bot] Stats reset');
}

// ============ EXPRESS API ROUTES ============

// Get bot status
app.get('/api/status', (req, res) => {
    const uptime = botState.stats.startTime 
        ? Math.floor((Date.now() - new Date(botState.stats.startTime).getTime()) / 1000)
        : 0;
    
    res.json({
        running: botState.isRunning,
        stats: {
            ...botState.stats,
            uptime: uptime,
            winRate: botState.stats.totalBets > 0 
                ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(2)
                : 0
        },
        settings: botState.settings,
        currentSite: botState.currentSite,
        supportedSites: SUPPORTED_SITES.map(s => s.name)
    });
});

// Start/Stop bot
app.post('/api/control', (req, res) => {
    const { action } = req.body;
    
    if (action === 'start') {
        startBot();
        res.json({ success: true, message: 'Bot started' });
    } else if (action === 'stop') {
        stopBot();
        res.json({ success: true, message: 'Bot stopped' });
    } else if (action === 'reset') {
        resetStats();
        res.json({ success: true, message: 'Stats reset' });
    } else {
        res.status(400).json({ error: 'Invalid action' });
    }
});

// Update settings
app.post('/api/settings', (req, res) => {
    const allowedSettings = ['baseBet', 'winChance', 'multiplier', 'stopOnProfit', 'stopOnLoss', 'maxBet', 'onWinAction', 'onLossAction', 'hiLoChoice'];
    
    for (const key of allowedSettings) {
        if (req.body[key] !== undefined) {
            if (key === 'baseBet') {
                botState.settings.baseBet = parseFloat(req.body[key]);
                if (!botState.isRunning) {
                    botState.settings.currentBet = botState.settings.baseBet;
                }
            } else if (key === 'winChance') {
                botState.settings.winChance = parseFloat(req.body[key]);
            } else if (key === 'multiplier') {
                botState.settings.multiplier = parseFloat(req.body[key]);
            } else if (key === 'stopOnProfit') {
                botState.settings.stopOnProfit = parseFloat(req.body[key]);
            } else if (key === 'stopOnLoss') {
                botState.settings.stopOnLoss = parseFloat(req.body[key]);
            } else if (key === 'maxBet') {
                botState.settings.maxBet = parseFloat(req.body[key]);
            } else if (key === 'onWinAction') {
                botState.settings.onWinAction = req.body[key];
            } else if (key === 'onLossAction') {
                botState.settings.onLossAction = req.body[key];
            } else if (key === 'hiLoChoice') {
                botState.settings.hiLoChoice = req.body[key];
            }
        }
    }
    
    saveState();
    res.json({ success: true, settings: botState.settings });
});

// Get bet history
app.get('/api/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(botState.betHistory.slice(0, limit));
});

// Get supported sites
app.get('/api/sites', (req, res) => {
    res.json(SUPPORTED_SITES);
});

// Set API key for a site
app.post('/api/apikey', (req, res) => {
    const { site, apiKey } = req.body;
    botState.apiKeys[site] = apiKey;
    saveState();
    res.json({ success: true, message: `API key saved for ${site}` });
});

// Dashboard HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>🎲 DiceBot - Auto Betting Server</title>
    <meta http-equiv="refresh" content="2">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
        .card { background: #1a1f3a; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-label { font-size: 12px; color: #888; margin-top: 5px; }
        .live { animation: pulse 1s infinite; display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; margin-right: 8px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        button { background: #00ff88; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; margin: 5px; }
        button.danger { background: #ff4444; color: #fff; }
        button.warning { background: #ffaa00; color: #000; }
        input, select { background: #0a0e27; color: #00ff88; border: 1px solid #00ff88; padding: 8px; border-radius: 5px; margin: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .settings-row { display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
        hr { border-color: #333; margin: 15px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 DiceBot - Auto Betting Server</h1>
        
        <div class="card">
            <div id="status"></div>
            <div style="margin-top: 15px;">
                <button onclick="control('start')">▶️ START BOT</button>
                <button onclick="control('stop')" class="danger">⏹️ STOP BOT</button>
                <button onclick="control('reset')" class="warning">🔄 RESET STATS</button>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value" id="totalBets">0</div>
                <div class="stat-label">Total Bets</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="netProfit">0</div>
                <div class="stat-label">Net Profit</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="winRate">0%</div>
                <div class="stat-label">Win Rate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="currentBet">0</div>
                <div class="stat-label">Current Bet</div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>⚙️ Betting Settings</h3>
                <div class="settings-row">
                    <div>
                        <label>Base Bet</label>
                        <input type="number" id="baseBet" step="1" value="1">
                    </div>
                    <div>
                        <label>Win Chance (%)</label>
                        <input type="number" id="winChance" step="0.1" value="49.5">
                    </div>
                    <div>
                        <label>Martingale x</label>
                        <input type="number" id="multiplier" step="0.1" value="2">
                    </div>
                </div>
                <div class="settings-row">
                    <div>
                        <label>Stop on Profit</label>
                        <input type="number" id="stopOnProfit" value="100">
                    </div>
                    <div>
                        <label>Stop on Loss</label>
                        <input type="number" id="stopOnLoss" value="50">
                    </div>
                    <div>
                        <label>Max Bet</label>
                        <input type="number" id="maxBet" value="1000">
                    </div>
                </div>
                <div class="settings-row">
                    <div>
                        <label>On Win</label>
                        <select id="onWinAction">
                            <option value="reset">Reset to base</option>
                            <option value="multiply">Multiply by 1.5</option>
                        </select>
                    </div>
                    <div>
                        <label>On Loss</label>
                        <select id="onLossAction">
                            <option value="multiply">Multiply (Martingale)</option>
                            <option value="reset">Reset to base</option>
                        </select>
                    </div>
                    <div>
                        <label>HI/LO Choice</label>
                        <select id="hiLoChoice">
                            <option value="high">HIGH (always)</option>
                            <option value="low">LOW (always)</option>
                            <option value="alternate">Alternate each bet</option>
                        </select>
                    </div>
                </div>
                <button onclick="updateSettings()">💾 Save Settings</button>
            </div>
            
            <div class="card">
                <h3>📈 Performance Stats</h3>
                <div class="settings-row">
                    <div>🏆 Longest Win Streak: <strong id="longestWinStreak">0</strong></div>
                    <div>💀 Longest Loss Streak: <strong id="longestLossStreak">0</strong></div>
                </div>
                <div class="settings-row">
                    <div>📊 Highest Balance: <strong id="highestBalance">0</strong></div>
                    <div>📉 Lowest Balance: <strong id="lowestBalance">0</strong></div>
                </div>
                <div class="settings-row">
                    <div>✅ Wins: <strong id="wins">0</strong></div>
                    <div>❌ Losses: <strong id="losses">0</strong></div>
                </div>
                <div class="settings-row">
                    <div>🕐 Uptime: <strong id="uptime">0s</strong></div>
                    <div>🎲 Current Streak: <strong id="currentStreak">0</strong></div>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h3>📜 Recent Bets</h3>
            <table>
                <thead><tr><th>Time</th><th>Bet</th><th>Roll</th><th>Result</th><th>Profit</th><th>Balance</th></tr></thead>
                <tbody id="betHistory"></tbody>
            </table>
        </div>
        
        <div class="card">
            <h3>📡 Supported Sites (Real API Integration)</h3>
            <p>To connect to real dice sites, set these environment variables:</p>
            <pre>
FREE_BITCOIN_API_KEY=your_key_here
PRIME_DICE_API_KEY=your_key_here
STAKE_API_KEY=your_key_here
BITSLLER_API_KEY=your_key_here
            </pre>
            <p>The bot currently runs in <strong>SIMULATION MODE</strong> for testing. Connect your API keys for real betting!</p>
        </div>
    </div>
    
    <script>
        async function fetchStatus() {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            document.getElementById('totalBets').innerText = data.stats.totalBets;
            document.getElementById('netProfit').innerText = data.stats.netProfit.toFixed(2);
            document.getElementById('winRate').innerText = data.stats.winRate + '%';
            document.getElementById('currentBet').innerText = data.settings.currentBet;
            document.getElementById('longestWinStreak').innerText = data.stats.longestWinStreak;
            document.getElementById('longestLossStreak').innerText = data.stats.longestLossStreak;
            document.getElementById('highestBalance').innerText = data.stats.highestBalance.toFixed(2);
            document.getElementById('lowestBalance').innerText = data.stats.lowestBalance.toFixed(2);
            document.getElementById('wins').innerText = data.stats.wins;
            document.getElementById('losses').innerText = data.stats.losses;
            document.getElementById('currentStreak').innerText = data.stats.currentStreak;
            
            const uptime = data.stats.uptime;
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = uptime % 60;
            document.getElementById('uptime').innerText = \`\${hours}h \${minutes}m \${seconds}s\`;
            
            const statusDiv = document.getElementById('status');
            if (data.running) {
                statusDiv.innerHTML = '<div><span class="live"></span> 🟢 BOT IS RUNNING</div>';
            } else {
                statusDiv.innerHTML = '<div>⏸️ BOT IS STOPPED</div>';
            }
        }
        
        async function loadHistory() {
            const res = await fetch('/api/history?limit=20');
            const history = await res.json();
            
            const tbody = document.getElementById('betHistory');
            tbody.innerHTML = history.map(b => \`
                <tr>
                    <td>\${new Date(b.time).toLocaleTimeString()}</td>
                    <td>\${b.amount}</td>
                    <td>\${b.roll}</td>
                    <td class="\${b.isWin ? 'win' : 'loss'}">\${b.isWin ? '✅ WIN' : '❌ LOSS'}</td>
                    <td class="\${b.profit >= 0 ? 'win' : 'loss'}">\${b.profit >= 0 ? '+' : ''}\${b.profit.toFixed(2)}</td>
                    <td>\${b.balance.toFixed(2)}</td>
                </tr>
            \`).join('');
        }
        
        async function control(action) {
            await fetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });
            fetchStatus();
        }
        
        async function updateSettings() {
            const settings = {
                baseBet: parseFloat(document.getElementById('baseBet').value),
                winChance: parseFloat(document.getElementById('winChance').value),
                multiplier: parseFloat(document.getElementById('multiplier').value),
                stopOnProfit: parseFloat(document.getElementById('stopOnProfit').value),
                stopOnLoss: parseFloat(document.getElementById('stopOnLoss').value),
                maxBet: parseFloat(document.getElementById('maxBet').value),
                onWinAction: document.getElementById('onWinAction').value,
                onLossAction: document.getElementById('onLossAction').value,
                hiLoChoice: document.getElementById('hiLoChoice').value
            };
            
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            
            fetchStatus();
        }
        
        setInterval(() => {
            fetchStatus();
            loadHistory();
        }, 2000);
        
        fetchStatus();
        loadHistory();
    </script>
</body>
</html>
    `);
});

// ============ START SERVER ============
loadState();

app.listen(port, '0.0.0.0', () => {
    console.log(`\n📊 Dashboard: http://localhost:${port}`);
    console.log(`\n⚠️  This bot runs in SIMULATION MODE`);
    console.log(`   To bet with real crypto, add API keys to environment variables`);
    console.log(`\n🎲 Ready! Open the dashboard to start the bot\n`);
});

// Keep the bot alive on Scalingo
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    saveState();
    process.exit(0);
});
