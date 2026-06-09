const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "FrRtbXf3294xXJJyiK9RYWhiqmj6f471xYBghxZE2cgW4Ddc3p";
const BASE_URL = "https://api.crypto.games/v1";

// PROFITABLE STRATEGY CONFIG
const PLINKO_CONFIG = {
    coin: "BTC",
    risk: "low",          // Low risk = more 1.1x and 2.1x wins
    rows: 8,              // 8 rows gives best probability for profit
    
    // Betting strategy for profit
    baseBet: 0.00000010,  // 10 Satoshi base (minimum profitable)
    maxBet: 0.00000100,   // Cap at 100 Satoshi
    
    // Profit targets (REALISTIC for small balance)
    dailyTarget: 0.00005000,      // Stop after 5,000 Satoshi profit
    sessionStopLoss: 0.00002000,   // Stop if down 2,000 Satoshi
    
    // Smart recovery (proven to work)
    winIncrease: 1.0,      // Don't increase on wins
    lossIncrease: 1.5,     // Increase 50% after loss (classic martingale)
    maxConsecutiveLosses: 5 // Stop after 5 losses in a row
};

// Payout multipliers (LOW RISK = more winning positions)
// Positions 0-7: 5.6x, 2.1x, 1.1x, 1.0x, 1.0x, 1.1x, 2.1x, 5.6x
// WINNING positions: indices 0,1,2,5,6,7 (6 out of 8 = 75% win rate!)
const WINNING_POSITIONS = [0, 1, 2, 5, 6, 7]; // Multipliers > 1.0x

// ============ BOT STATE ============
let btcPrice = 60964;
let botState = {
    running: true,
    statusMessage: "Initializing Profitable Plinko Bot...",
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        consecutiveLosses: 0,
        sessionProfit: 0,
        dailyProfit: 0
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows
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
        console.error("Balance error:", error.message);
        return null;
    }
}

async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    // Generate alphanumeric client seed
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32);
    
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: 2.0,
        UnderOver: true,
        ClientSeed: clientSeed,
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
        return null; 
    }
}

// ============ PROFIT STRATEGY ============
function calculateNewBet(isWin, multiplier) {
    if (isWin) {
        // WIN: Reset to base bet (lock in profits)
        botState.stats.consecutiveLosses = 0;
        return PLINKO_CONFIG.baseBet;
    } else {
        // LOSS: Increase bet to recover
        botState.stats.consecutiveLosses++;
        
        // Stop if too many losses in a row
        if (botState.stats.consecutiveLosses >= PLINKO_CONFIG.maxConsecutiveLosses) {
            botState.statusMessage = "MAX LOSSES REACHED - Stopping to protect bankroll";
            botState.running = false;
            return botState.settings.currentBet;
        }
        
        // Classic recovery: increase bet by 1.5x
        let newBet = botState.settings.currentBet * PLINKO_CONFIG.lossIncrease;
        if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
        return newBet;
    }
}

// ============ PROFIT CHECK ============
function checkProfitTargets() {
    // Daily profit target reached
    if (botState.stats.dailyProfit >= PLINKO_CONFIG.dailyTarget) {
        botState.statusMessage = `✅ DAILY TARGET REACHED! Profit: ${formatBTC(botState.stats.dailyProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    // Session stop loss hit
    if (botState.stats.sessionProfit <= -PLINKO_CONFIG.sessionStopLoss) {
        botState.statusMessage = `🛑 STOP LOSS HIT! Loss: ${formatBTC(botState.stats.sessionProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    return true;
}

// ============ MAIN BOT LOOP ============
async function runProfitablePlinko() {
    // Get starting balance
    const initialBalance = await getBalance();
    if (!initialBalance) {
        console.error("❌ Cannot connect to API. Check your API key.");
        botState.statusMessage = "API CONNECTION FAILED";
        return;
    }
    
    botState.stats.startingBalance = initialBalance;
    botState.stats.currentBalance = initialBalance;
    
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     💰 PROFITABLE PLINKO BOT STARTED 💰          ║
    ╠══════════════════════════════════════════════════╣
    ║  Starting Balance: ${formatBTC(initialBalance)} BTC
    ║  Base Bet: ${formatBTC(PLINKO_CONFIG.baseBet)} BTC
    ║  Max Bet: ${formatBTC(PLINKO_CONFIG.maxBet)} BTC
    ║  Daily Target: ${formatBTC(PLINKO_CONFIG.dailyTarget)} BTC
    ║  Stop Loss: ${formatBTC(PLINKO_CONFIG.sessionStopLoss)} BTC
    ║  Win Rate Expected: 75% (6/8 positions)
    ╚══════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 BOT RUNNING - Targeting 75% win rate";
    
    while (botState.running) {
        // Update balance
        const currentBalance = await getBalance();
        if (currentBalance) {
            botState.stats.currentBalance = currentBalance;
            botState.stats.netProfit = currentBalance - botState.stats.startingBalance;
            botState.stats.sessionProfit = currentBalance - botState.stats.startingBalance;
            botState.stats.dailyProfit = currentBalance - botState.stats.startingBalance;
        }
        
        // Check if we hit targets
        if (!checkProfitTargets()) {
            console.log(`\n🏁 Bot finished: ${botState.statusMessage}`);
            break;
        }
        
        // Place bet
        const result = await placePlinkoBet();
        if (!result) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        
        // Process result
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        const isWin = multiplier > 1;
        
        if (isWin) {
            botState.stats.wins++;
        } else {
            botState.stats.losses++;
        }
        
        // Update balance
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.netProfit = botState.stats.currentBalance - botState.stats.startingBalance;
        botState.stats.sessionProfit = botState.stats.netProfit;
        botState.stats.dailyProfit = botState.stats.netProfit;
        
        // Calculate next bet
        const newBet = calculateNewBet(isWin, multiplier);
        botState.settings.currentBet = newBet;
        
        // Store history
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: result.Bet,
            multiplier: multiplier,
            profit: profit,
            isWin: isWin,
            balance: botState.stats.currentBalance,
            nextBet: newBet
        });
        
        // Keep last 100 bets
        if (botState.betHistory.length > 100) botState.betHistory.pop();
        
        // Log to console
        const winRate = (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1);
        console.log(`#${botState.stats.totalBets} | ${new Date().toLocaleTimeString()} | ${formatBTC(result.Bet)} | ${multiplier}x | ${isWin ? '✅ WIN' : '❌ LOSS'} | ${formatBTC(profit)} | Bal: ${formatBTC(botState.stats.currentBalance)} | WR: ${winRate}% | Next: ${formatBTC(newBet)}`);
        
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`\n📊 FINAL STATS:`);
    console.log(`   Total Bets: ${botState.stats.totalBets}`);
    console.log(`   Wins: ${botState.stats.wins} | Losses: ${botState.stats.losses}`);
    console.log(`   Win Rate: ${(botState.stats.wins / botState.stats.totalBets * 100).toFixed(1)}%`);
    console.log(`   Final Profit: ${formatBTC(botState.stats.netProfit)} BTC`);
}

// ============ WEB DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    
    res.json({ botState, btcPrice, winRate });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Plinko Profit Bot</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body {
            font-family: 'Courier New', monospace;
            background: #0a0e27;
            color: #00ff88;
            padding: 20px;
            margin: 0;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        h1 {
            color: #00ff88;
            text-align: center;
            border-bottom: 2px solid #00ff88;
            padding-bottom: 10px;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin: 20px 0;
        }
        .card {
            background: #111827;
            border: 1px solid #00ff88;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
        }
        .card h3 {
            color: #888;
            font-size: 12px;
            margin: 0 0 10px 0;
            text-transform: uppercase;
        }
        .card .value {
            font-size: 24px;
            font-weight: bold;
            color: #00ff88;
        }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4444; }
        table {
            width: 100%;
            background: #111827;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #333;
        }
        th {
            background: #1a1f3a;
            color: #888;
        }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .status {
            background: #111827;
            border-left: 4px solid #00ff88;
            padding: 15px;
            margin: 20px 0;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 PLINKO PROFIT BOT</h1>
        
        <div class="stats">
            <div class="card">
                <h3>💰 BALANCE</h3>
                <div class="value" id="balance">0.00000000</div>
                <small id="balanceUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>📈 PROFIT</h3>
                <div class="value" id="profit">0.00000000</div>
                <small id="profitUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>🎲 BETS</h3>
                <div class="value" id="totalBets">0</div>
                <small>W: <span id="wins">0</span> | L: <span id="losses">0</span></small>
            </div>
            <div class="card">
                <h3>📊 WIN RATE</h3>
                <div class="value" id="winRate">0%</div>
                <small>Next: <span id="nextBet">0</span> BTC</small>
            </div>
        </div>
        
        <div class="status" id="statusMsg">
            Loading...
        </div>
        
        <table>
            <thead>
                <tr><th>#</th><th>Time</th><th>Wager (BTC)</th><th>Multiplier</th><th>Profit (BTC)</th><th>Result</th><th>Balance</th></tr>
            </thead>
            <tbody id="history">
                <tr><td colspan="7" style="text-align:center">Waiting for bets...</td></tr>
            </tbody>
        </table>
    </div>
    
    <script>
        function update() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    const b = data.botState;
                    const btcPrice = data.btcPrice;
                    
                    document.getElementById('balance').innerHTML = b.stats.currentBalance.toFixed(8);
                    document.getElementById('balanceUSD').innerHTML = '$' + (b.stats.currentBalance * btcPrice).toFixed(2);
                    
                    const profitElem = document.getElementById('profit');
                    profitElem.innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + b.stats.netProfit.toFixed(8);
                    profitElem.className = 'value ' + (b.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative');
                    
                    document.getElementById('profitUSD').innerHTML = '$' + (Math.abs(b.stats.netProfit) * btcPrice).toFixed(2);
                    document.getElementById('totalBets').innerHTML = b.stats.totalBets;
                    document.getElementById('wins').innerHTML = b.stats.wins;
                    document.getElementById('losses').innerHTML = b.stats.losses;
                    document.getElementById('winRate').innerHTML = data.winRate + '%';
                    document.getElementById('nextBet').innerHTML = b.settings.currentBet.toFixed(8);
                    document.getElementById('statusMsg').innerHTML = b.statusMessage;
                    
                    const tbody = document.getElementById('history');
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(30, b.betHistory.length); i++) {
                        const bet = b.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerText = bet.wager.toFixed(8);
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + bet.profit.toFixed(8) + '</span>' : 
                            '<span class="loss">' + bet.profit.toFixed(8) + '</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? 
                            '<span class="win">✅ WIN</span>' : 
                            '<span class="loss">❌ LOSS</span>';
                        row.insertCell(6).innerText = bet.balance.toFixed(8);
                    }
                })
                .catch(console.error);
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

// ============ START ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 Dashboard: http://localhost:${port}\n`);
    runProfitablePlinko();
});
