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
    risk: "low",
    rows: 8,
    baseBet: 0.00000010,
    maxBet: 0.00000100,
    dailyTarget: 0.00005000,
    sessionStopLoss: 0.00002000,
    winIncrease: 1.0,
    lossIncrease: 1.5,
    maxConsecutiveLosses: 5
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    statusMessage: "Initializing Profitable Plinko Bot...",
    coin: PLINKO_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        consecutiveLosses: 0
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

// ============ API LOGIC (WORKING VERSION) ============
async function placePlinkoBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    // Generate alphanumeric client seed (same as working version)
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
        botState.statusMessage = `API Error: ${errorMsg}`;
        return null; 
    }
}

// ============ PROFIT STRATEGY ============
function calculateNewBet(isWin, multiplier) {
    if (isWin) {
        botState.stats.consecutiveLosses = 0;
        return PLINKO_CONFIG.baseBet;
    } else {
        botState.stats.consecutiveLosses++;
        
        if (botState.stats.consecutiveLosses >= PLINKO_CONFIG.maxConsecutiveLosses) {
            botState.statusMessage = "MAX LOSSES REACHED - Stopping";
            botState.running = false;
            return botState.settings.currentBet;
        }
        
        let newBet = botState.settings.currentBet * PLINKO_CONFIG.lossIncrease;
        if (newBet > PLINKO_CONFIG.maxBet) newBet = PLINKO_CONFIG.maxBet;
        return newBet;
    }
}

function checkProfitTargets() {
    if (botState.stats.netProfit >= PLINKO_CONFIG.dailyTarget) {
        botState.statusMessage = `TARGET REACHED! Profit: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    if (botState.stats.netProfit <= -PLINKO_CONFIG.sessionStopLoss) {
        botState.statusMessage = `STOP LOSS HIT! Loss: ${formatBTC(botState.stats.netProfit)} BTC`;
        botState.running = false;
        return false;
    }
    
    return true;
}

// ============ MAIN BOT LOOP ============
async function runProfitablePlinko() {
    startingBalance = 0.00010000; // Default fallback
    
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║     💰 PROFITABLE PLINKO BOT STARTED 💰          ║
    ╠══════════════════════════════════════════════════╣
    ║  Base Bet: ${formatBTC(PLINKO_CONFIG.baseBet)} BTC
    ║  Max Bet: ${formatBTC(PLINKO_CONFIG.maxBet)} BTC
    ║  Daily Target: ${formatBTC(PLINKO_CONFIG.dailyTarget)} BTC
    ║  Stop Loss: ${formatBTC(PLINKO_CONFIG.sessionStopLoss)} BTC
    ║  Expected Win Rate: 75%
    ╚══════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "BOT RUNNING - Targeting profit";
    
    while (botState.running) {
        // Check profit targets
        if (!checkProfitTargets()) {
            console.log(`\n Bot finished: ${botState.statusMessage}`);
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
        botState.stats.netProfit = profit;
        if (startingBalance === 0 && botState.stats.currentBalance > 0) {
            startingBalance = botState.stats.currentBalance - profit;
            botState.stats.startingBalance = startingBalance;
            botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        } else if (startingBalance > 0) {
            botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        }
        
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
            balance: botState.stats.currentBalance
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Log to console
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        console.log(`#${botState.stats.totalBets} | ${new Date().toLocaleTimeString()} | ${formatBTC(result.Bet)} | ${multiplier}x | ${isWin ? 'WIN' : 'LOSS'} | ${formatBTC(profit)} | Bal: ${formatBTC(botState.stats.currentBalance)} | WR: ${winRate}%`);
        
        await new Promise(r => setTimeout(r, 500));
    }
}

// ============ WEB DASHBOARD (FIXED) ============
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
        <h1>PLINKO PROFIT BOT</h1>
        
        <div class="stats">
            <div class="card">
                <h3>BALANCE</h3>
                <div class="value" id="balance">0.00000000</div>
                <small id="balanceUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>PROFIT</h3>
                <div class="value" id="profit">0.00000000</div>
                <small id="profitUSD">$0.00</small>
            </div>
            <div class="card">
                <h3>BETS</h3>
                <div class="value" id="totalBets">0</div>
                <small>W: <span id="wins">0</span> | L: <span id="losses">0</span></small>
            </div>
            <div class="card">
                <h3>WIN RATE</h3>
                <div class="value" id="winRate">0%</div>
                <small>Next: <span id="nextBet">0</span> BTC</small>
            </div>
        </div>
        
        <div class="status" id="statusMsg">
            Loading...
        </div>
        
        <table>
            <thead>
                <tr><th>#</th><th>Time</th><th>Wager</th><th>Multiplier</th><th>Profit</th><th>Result</th><th>Balance</th></tr>
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
                    for (let i = 0; i < b.betHistory.length; i++) {
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
                            '<span class="win">WIN</span>' : 
                            '<span class="loss">LOSS</span>';
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
    console.log(`\n Dashboard: http://localhost:${port}\n`);
    runProfitablePlinko();
});
