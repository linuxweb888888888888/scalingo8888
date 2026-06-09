const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION (SMALL BALANCE OPTIMIZED) ============
const API_KEY = process.env.API_KEY || "YOUR_API_KEY_HERE";
const BASE_URL = "https://api.crypto.games/v1";

const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",          // Low risk = more frequent small wins
    rows: 8,              // Fewer rows = less volatility
    
    // MICRO BALANCE SETTINGS - Starts with 1 Satoshi!
    baseBet: 0.00000001,  // 1 Satoshi minimum bet
    maxBet: 0.00000050,   // Never bet more than 50 Satoshi
    recoveryMultiplier: 1.2,  // Slow recovery (20% increase on loss)
    
    // Safety stops to protect your small balance
    targetProfit: 0.00001000,  // Stop if you profit 1,000 Satoshi
    stopLoss: 0.00000500,      // Stop if you lose 500 Satoshi
    maxDrawdownPercent: 0.30,  // Stop if down 30% of starting balance
};

// Plinko payout multipliers (low risk, 8 rows)
const PLINKO_PAYOUTS = {
    low: {
        8: [5.6, 2.1, 1.1, 1.0, 1.0, 1.1, 2.1, 5.6],
    },
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    statusMessage: "Initializing Micro Plinko Bot...",
    coin: PLINKO_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        maxDrawdown: 0,
        peakBalance: 0,
        sessionHigh: 0,
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows,
    },
    betHistory: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (res.data.bitcoin) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function formatBTC(amount) {
    return (amount || 0).toFixed(8);
}

// ============ API LOGIC ============
async function getBalance() {
    const url = `${BASE_URL}/balance/${botState.coin}/${API_KEY}`;
    try {
        const response = await axios.get(url);
        return response.data.Balance || 0;
    } catch (error) {
        console.error("Balance check error:", error.message);
        return null;
    }
}

async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    // Generate alphanumeric-only client seed (no special characters)
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32); // Max 32 chars, alphanumeric only
    
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: 2.0,
        UnderOver: true,
        ClientSeed: clientSeed,  // Now only contains 0-9a-z
        Game: "plinko",
        Rows: botState.settings.rows,
        Risk: botState.settings.risk
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response.data;
    } catch (error) { 
        const errorMsg = error.response?.data?.Message || error.message;
        console.error("API Error:", errorMsg);
        botState.statusMessage = `API Error: ${errorMsg}`;
        return null; 
    }
}

// ============ SAFETY CHECK ============
function checkSafetyConditions() {
    // Stop loss check
    if (botState.stats.netProfit <= -PLINKO_CONFIG.stopLoss) {
        botState.statusMessage = `STOP LOSS TRIGGERED! Loss: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    // Target profit check
    if (botState.stats.netProfit >= PLINKO_CONFIG.targetProfit) {
        botState.statusMessage = `TARGET REACHED! Profit: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    // Drawdown check
    if (startingBalance > 0) {
        const currentDrawdown = (startingBalance - botState.stats.currentBalance) / startingBalance;
        if (currentDrawdown >= PLINKO_CONFIG.maxDrawdownPercent) {
            botState.statusMessage = `MAX DRAWDOWN REACHED! Down ${(currentDrawdown * 100).toFixed(1)}%`;
            botState.running = false;
            return false;
        }
    }
    
    // Never bet more than 10% of remaining balance
    const maxSafeBet = botState.stats.currentBalance * 0.10;
    if (botState.settings.currentBet > maxSafeBet && maxSafeBet > 0) {
        botState.settings.currentBet = Math.max(PLINKO_CONFIG.baseBet, maxSafeBet);
    }
    
    return true;
}

// ============ MAIN PLINKO STRATEGY ============
async function runPlinkoStrategy() {
    // Get initial balance
    const initialBalance = await getBalance();
    if (initialBalance === null) {
        console.error("Failed to get balance. Check your API key.");
        botState.statusMessage = "FAILED: Cannot connect to API";
        return;
    }
    
    startingBalance = initialBalance;
    botState.stats.startingBalance = startingBalance;
    botState.stats.currentBalance = startingBalance;
    botState.stats.peakBalance = startingBalance;
    botState.stats.sessionHigh = startingBalance;
    
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     🎯 MICRO PLINKO BOT STARTED 🎯               ║
    ╠══════════════════════════════════════════════════╣
    ║  Starting Balance: ${formatBTC(startingBalance)} BTC
    ║  Base Bet: ${formatBTC(PLINKO_CONFIG.baseBet)} BTC (1 SATOSHI!)
    ║  Max Bet: ${formatBTC(PLINKO_CONFIG.maxBet)} BTC
    ║  Risk: ${PLINKO_CONFIG.risk.toUpperCase()} | Rows: ${PLINKO_CONFIG.rows}
    ║  Stop Loss: ${formatBTC(PLINKO_CONFIG.stopLoss)} BTC
    ║  Target: ${formatBTC(PLINKO_CONFIG.targetProfit)} BTC
    ╚══════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "Bot Running - Low Risk / 1 Satoshi Base Bet";
    
    while (botState.running) {
        // Update current balance periodically
        const freshBalance = await getBalance();
        if (freshBalance !== null) {
            botState.stats.currentBalance = freshBalance;
            botState.stats.netProfit = freshBalance - startingBalance;
        }
        
        // Track peak balance for drawdown calculation
        if (botState.stats.currentBalance > botState.stats.peakBalance) {
            botState.stats.peakBalance = botState.stats.currentBalance;
        }
        
        // Calculate current drawdown
        const drawdown = botState.stats.peakBalance - botState.stats.currentBalance;
        if (drawdown > botState.stats.maxDrawdown) {
            botState.stats.maxDrawdown = drawdown;
        }
        
        // Safety checks before placing bet
        if (!checkSafetyConditions()) {
            console.log("\nBot stopped due to safety condition:", botState.statusMessage);
            break;
        }
        
        // Place the bet
        const result = await placePlinkoBet();
        
        if (!result) { 
            console.log("Bet failed, waiting 5 seconds...");
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }
        
        // Process result
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        
        // Update balance and profit
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        
        // Track session high
        if (botState.stats.currentBalance > botState.stats.sessionHigh) {
            botState.stats.sessionHigh = botState.stats.sessionHigh;
        }
        
        // Win/Loss logic with MICRO-FRIENDLY recovery
        if (multiplier > 1) {
            botState.stats.wins++;
            // WIN: Reset to base bet (1 Satoshi)
            botState.settings.currentBet = PLINKO_CONFIG.baseBet;
        } else {
            botState.stats.losses++;
            // LOSS: Increase bet by 20% (slow recovery)
            let newBet = botState.settings.currentBet * PLINKO_CONFIG.recoveryMultiplier;
            if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
            botState.settings.currentBet = newBet;
        }
        
        // Store history
        botState.betHistory.unshift({ 
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: result.Bet,
            multiplier: multiplier,
            profit: profit,
            isWin: multiplier > 1,
            currentBet: botState.settings.currentBet
        });
        
        // Keep last 50 bets
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Console log
        console.log(`[${new Date().toLocaleTimeString()}] Bet #${botState.stats.totalBets}: ${formatBTC(result.Bet)} BTC | ${multiplier}x | ${profit > 0 ? '+' : ''}${formatBTC(profit)} | Balance: ${formatBTC(botState.stats.currentBalance)} | Next: ${formatBTC(botState.settings.currentBet)}`);
        
        // Rate limiting to avoid API spam
        await new Promise(r => setTimeout(r, 800));
    }
    
    console.log("\n Bot Finished:", botState.statusMessage);
}

// ============ EXPRESS DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2),
        winRate
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Plinko Bot - Crypto.Games</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 20px;
            color: #eee;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        
        h1 { text-align: center; margin-bottom: 10px; color: #e94560; }
        .subtitle { text-align: center; margin-bottom: 30px; color: #888; }
        
        .status-bar { 
            background: #0f3460; 
            padding: 15px; 
            border-radius: 10px; 
            margin-bottom: 20px;
            text-align: center;
            font-weight: bold;
            border-left: 4px solid #e94560;
        }
        
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 15px; 
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: #16213e; 
            padding: 20px; 
            border-radius: 10px; 
            text-align: center;
            border: 1px solid #0f3460;
        }
        
        .stat-label { 
            font-size: 12px; 
            text-transform: uppercase; 
            color: #888; 
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        
        .stat-value { 
            font-size: 24px; 
            font-weight: bold; 
            color: #e94560;
            font-family: monospace;
        }
        
        .stat-sub { font-size: 12px; color: #666; margin-top: 5px; }
        
        .win { color: #4CAF50; }
        .loss { color: #f44336; }
        
        .history-table {
            background: #16213e;
            border-radius: 10px;
            overflow: hidden;
            margin-top: 20px;
        }
        
        table { width: 100%; border-collapse: collapse; }
        
        th { 
            background: #0f3460; 
            padding: 12px; 
            text-align: left; 
            font-size: 12px;
            color: #888;
        }
        
        td { 
            padding: 10px 12px; 
            border-bottom: 1px solid #0f3460;
            font-family: monospace;
            font-size: 13px;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
        }
        
        .badge-win { background: #4CAF50; color: white; }
        .badge-loss { background: #f44336; color: white; }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
        
        .running { animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 PLINKO BOT</h1>
        <div class="subtitle">Crypto.Games | 1 Satoshi Base Bet | Low Risk</div>
        
        <div class="status-bar" id="statusMsg">
            🔄 Initializing...
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">💰 Balance</div>
                <div class="stat-value" id="balance">0.00000000</div>
                <div class="stat-sub" id="balanceUSD">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📈 Profit</div>
                <div class="stat-value" id="profit">0.00000000</div>
                <div class="stat-sub" id="profitUSD">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">🎲 Total Bets</div>
                <div class="stat-value" id="totalBets">0</div>
                <div class="stat-sub">W: <span id="wins">0</span> | L: <span id="losses">0</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📊 Win Rate</div>
                <div class="stat-value" id="winRate">0%</div>
                <div class="stat-sub">Next Bet: <span id="nextBet">0</span> BTC</div>
            </div>
        </div>
        
        <div class="history-table">
            <table>
                <thead>
                    <tr><th>#</th><th>Time</th><th>Wager (BTC)</th><th>Multiplier</th><th>Profit (BTC)</th><th>Result</th></tr>
                </thead>
                <tbody id="historyBody">
                    <tr><td colspan="6" style="text-align: center;">Waiting for bets...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
    
    <script>
        async function updateDashboard() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();
                const bot = data.botState;
                const btcPrice = data.btcPrice;
                
                // Update status
                const statusDiv = document.getElementById('statusMsg');
                if (bot.running) {
                    statusDiv.innerHTML = '🟢 ' + bot.statusMessage;
                    statusDiv.style.borderLeftColor = '#4CAF50';
                } else {
                    statusDiv.innerHTML = '🔴 ' + bot.statusMessage;
                    statusDiv.style.borderLeftColor = '#f44336';
                }
                
                // Update stats
                const balance = bot.stats.currentBalance;
                const profit = bot.stats.netProfit;
                
                document.getElementById('balance').innerHTML = balance.toFixed(8) + ' BTC';
                document.getElementById('balanceUSD').innerHTML = '$' + (balance * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('profit').innerHTML = (profit >= 0 ? '+' : '') + profit.toFixed(8) + ' BTC';
                document.getElementById('profitUSD').innerHTML = '$' + (Math.abs(profit) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('totalBets').innerHTML = bot.stats.totalBets;
                document.getElementById('wins').innerHTML = bot.stats.wins;
                document.getElementById('losses').innerHTML = bot.stats.losses;
                document.getElementById('winRate').innerHTML = data.winRate + '%';
                document.getElementById('nextBet').innerHTML = bot.settings.currentBet.toFixed(8);
                
                // Update history
                const tbody = document.getElementById('historyBody');
                if (bot.betHistory.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">Waiting for bets...</td></tr>';
                } else {
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(20, bot.betHistory.length); i++) {
                        const bet = bot.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerText = bet.bet.toFixed(8);
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + bet.profit.toFixed(8) + '</span>' : 
                            '<span class="loss">' + bet.profit.toFixed(8) + '</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? 
                            '<span class="badge badge-win">WIN</span>' : 
                            '<span class="badge badge-loss">LOSS</span>';
                    }
                }
            } catch(e) {
                console.error('Dashboard error:', e);
            }
        }
        
        // Update every second
        setInterval(updateDashboard, 1000);
        updateDashboard();
    </script>
</body>
</html>
    `);
});

// ============ START THE BOT ============
app.listen(port, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════════╗
    ║     🎯 PLINKO BOT SERVER STARTED 🎯       ║
    ╠═══════════════════════════════════════════╣
    ║  Dashboard: http://localhost:${port}       ║
    ║  API Status: Ready                        ║
    ║  Waiting for bets...                      ║
    ╚═══════════════════════════════════════════╝
    `);
    runPlinkoStrategy();
});
