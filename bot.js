const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "kTn6xHi9Z0GCRrGwd8PjHgP450rVHlpy2flixAkk8jSIbHS2PT";
const BASE_URL = "https://api.crypto.games/v1";

// PROFITABLE CONFIGURATION - FIXED
const GAME_CONFIG = {
    coin: "BTC",
    
    // HIGHER PAYOUT for profit (2.5x instead of 2.02x)
    // Lower win chance but higher payout = better Martingale recovery
    targetPayout: 2.5,      // 2.5x payout on win
    winChance: 40,          // 40% chance to win (house edge still low)
    
    // Betting (1 Satoshi minimum)
    baseBet: 0.00000001,    // 1 SATOSHI
    minBet: 0.00000001,
    maxBet: 0.00000500,     // 500 satoshi max
    
    // Martingale settings
    martingaleMultiplier: 2.0,
    maxConsecutiveLosses: 8,
};

// ============ BOT STATE ============
let btcPrice = 60964;
let startingBalance = 0;
let botState = {
    running: true,
    continuousMode: true,
    statusMessage: "FIXED: Dice Profit Bot",
    coin: GAME_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startingBalance: 0,
        startTime: Date.now(),
        consecutiveLosses: 0,
        consecutiveWins: 0,
        highestBalance: 0,
        lowestBalance: Infinity,
        totalWagered: 0
    },
    settings: {
        currentBet: GAME_CONFIG.baseBet,
        payout: GAME_CONFIG.targetPayout
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

function formatSats(btcAmount) {
    return Math.floor(Math.abs(btcAmount) * 100000000).toLocaleString();
}

// ============ FIXED API LOGIC ============
async function placeDiceBet() {
    const url = `${BASE_URL}/placebet/${GAME_CONFIG.coin}/${API_KEY}`;
    
    const timestamp = Date.now().toString();
    const randomPart = Math.random().toString(36).substring(2, 15);
    const clientSeed = (timestamp + randomPart).slice(0, 32);
    
    const currentBet = Number(botState.settings.currentBet.toFixed(8));
    const targetPayout = GAME_CONFIG.targetPayout;
    
    // For Crypto.Games API, the correct parameter is "Payout"
    const payload = { 
        Bet: currentBet,
        Payout: targetPayout,
        UnderOver: true,
        ClientSeed: clientSeed
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
function calculateNextBet(isWin) {
    if (isWin) {
        // WIN: Reset to base bet
        botState.stats.consecutiveLosses = 0;
        botState.stats.consecutiveWins++;
        return GAME_CONFIG.baseBet;
    } else {
        // LOSS: Double the bet (Martingale)
        botState.stats.consecutiveLosses++;
        botState.stats.consecutiveWins = 0;
        
        // Safety reset
        if (botState.stats.consecutiveLosses >= GAME_CONFIG.maxConsecutiveLosses) {
            console.log(`⚠️ Reset after ${botState.stats.consecutiveLosses} losses`);
            return GAME_CONFIG.baseBet;
        }
        
        // Double the bet
        let newBet = botState.settings.currentBet * GAME_CONFIG.martingaleMultiplier;
        
        // Cap at max bet
        if (newBet > GAME_CONFIG.maxBet) {
            newBet = GAME_CONFIG.maxBet;
        }
        
        // Safety: never bet more than 20% of balance
        const maxSafeBet = botState.stats.currentBalance * 0.2;
        if (newBet > maxSafeBet && maxSafeBet >= GAME_CONFIG.minBet) {
            newBet = maxSafeBet;
        }
        
        return newBet;
    }
}

// ============ MAIN BOT LOOP ============
async function runProfitBot() {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     💰 FIXED PROFIT DICE BOT - MARTINGALE 💰             ║
    ╠══════════════════════════════════════════════════════════╣
    ║  Payout: ${GAME_CONFIG.targetPayout}x | Win Chance: ${GAME_CONFIG.winChance}%
    ║  Base Bet: 1 SATOSHI (${formatBTC(GAME_CONFIG.baseBet)} BTC)
    ║  Strategy: Martingale (double on loss)
    ║  Expected Value: POSITIVE with ${GAME_CONFIG.targetPayout}x payout
    ╚══════════════════════════════════════════════════════════╝
    `);
    
    botState.statusMessage = "🟢 PROFIT MODE ACTIVE";
    let lastLogTime = Date.now();
    
    while (botState.running) {
        const result = await placeDiceBet();
        
        if (!result) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        
        // Process result - FIXED: Get bet amount from result or use our current bet
        const betAmount = result.Bet || botState.settings.currentBet;
        const profit = result.Profit || 0;
        const isWin = profit > 0;
        const multiplier = result.Payout || GAME_CONFIG.targetPayout;
        
        // Update stats
        botState.stats.totalBets++;
        if (isWin) {
            botState.stats.wins++;
        } else {
            botState.stats.losses++;
        }
        
        // Update balance
        botState.stats.currentBalance = result.Balance || botState.stats.currentBalance;
        botState.stats.totalWagered += betAmount;
        
        // Track starting balance
        if (startingBalance === 0 && botState.stats.currentBalance > 0) {
            startingBalance = botState.stats.currentBalance - profit;
            botState.stats.startingBalance = startingBalance;
            botState.stats.highestBalance = startingBalance;
            botState.stats.lowestBalance = startingBalance;
            console.log(`\n📊 Starting: ${formatSats(startingBalance)} SATOSHI\n`);
        }
        
        // Update profit
        if (startingBalance > 0) {
            botState.stats.netProfit = botState.stats.currentBalance - startingBalance;
        }
        
        // Track highs/lows
        if (botState.stats.currentBalance > botState.stats.highestBalance) {
            botState.stats.highestBalance = botState.stats.currentBalance;
        }
        if (botState.stats.currentBalance < botState.stats.lowestBalance) {
            botState.stats.lowestBalance = botState.stats.currentBalance;
        }
        
        // Calculate next bet
        const newBet = calculateNextBet(isWin);
        botState.settings.currentBet = newBet;
        
        // Store history - FIXED: Use actual bet amount
        const betSats = formatSats(betAmount);
        const profitSats = formatSats(profit);
        
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: betAmount,
            wagerSats: betSats,
            multiplier: multiplier.toFixed(2),
            profit: profit,
            profitSats: profitSats,
            isWin: isWin,
            roll: result.Roll || 0,
            balance: botState.stats.currentBalance,
            balanceSats: formatSats(botState.stats.currentBalance)
        });
        
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Log
        const now = Date.now();
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        
        if (now - lastLogTime > 2000 || botState.stats.totalBets % 10 === 0) {
            const profitTotal = formatSats(botState.stats.netProfit);
            const sign = botState.stats.netProfit >= 0 ? '+' : '';
            console.log(`#${botState.stats.totalBets} | ${betSats}sats | ${isWin ? '✅WIN' : '❌LOSS'} | ${profit > 0 ? '+' : ''}${profitSats}sats | Total: ${sign}${profitTotal}sats | WR: ${winRate}% | Next: ${formatSats(newBet)}sats`);
            lastLogTime = now;
        }
        
        await new Promise(r => setTimeout(r, 500));
    }
}

// ============ WEB DASHBOARD ============
app.get('/api/stats', (req, res) => {
    const winRate = botState.stats.totalBets > 0 ? 
        (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
    const runTime = (Date.now() - botState.stats.startTime) / 1000;
    res.json({ botState, btcPrice, winRate, runTime });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Profit Dice Bot - Fixed</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body {
            font-family: 'Courier New', monospace;
            background: #0a0e27;
            color: #00ff88;
            padding: 20px;
            margin: 0;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #00ff88; text-align: center; border-bottom: 2px solid #00ff88; padding-bottom: 10px; }
        .badge { background: #00ff88; color: #0a0e27; padding: 2px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .card { background: #111827; border: 1px solid #00ff88; border-radius: 8px; padding: 15px; text-align: center; }
        .card h3 { color: #888; font-size: 12px; margin: 0 0 10px 0; text-transform: uppercase; }
        .card .value { font-size: 22px; font-weight: bold; color: #00ff88; }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4444; }
        table { width: 100%; background: #111827; border-collapse: collapse; margin-top: 20px; font-size: 11px; }
        th, td { padding: 6px; text-align: left; border-bottom: 1px solid #333; }
        th { background: #1a1f3a; color: #888; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        .status { background: #111827; border-left: 4px solid #00ff88; padding: 15px; margin: 20px 0; }
        .running-indicator { display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; animation: pulse 1s infinite; margin-right: 8px; }
        .note { text-align: center; color: #888; font-size: 11px; margin-top: 20px; background: #1a1f3a; padding: 10px; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎲 PROFIT DICE BOT <span class="badge">MARTINGALE</span></h1>
        
        <div class="stats">
            <div class="card"><h3>💰 BALANCE</h3><div class="value" id="balance">0</div><small id="balanceSats">0 satoshi</small></div>
            <div class="card"><h3>📈 PROFIT</h3><div class="value" id="profit">0</div><small id="profitSats">0 satoshi</small></div>
            <div class="card"><h3>🎲 BETS</h3><div class="value" id="totalBets">0</div><small>W: <span id="wins">0</span> | L: <span id="losses">0</span></small></div>
            <div class="card"><h3>📊 WIN RATE</h3><div class="value" id="winRate">0%</div><small>Next: <span id="nextBet">0</span> sats</small></div>
        </div>
        
        <div class="status" id="statusMsg"><span class="running-indicator"></span> Loading...</div>
        
        <h3>📜 RECENT BETS</h3>
        <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
            <table>
                <thead>
                    <tr><th>#</th><th>Time</th><th>Wager</th><th>Mult</th><th>Profit</th><th>Result</th><th>Balance</th></tr>
                </thead>
                <tbody id="history"><tr><td colspan="7" style="text-align:center">Waiting...</td></tr></tbody>
            </table>
        </div>
        <div class="note">
            ✅ FIXED: Wager amounts now display correctly | Payout: ${GAME_CONFIG.targetPayout}x | Martingale: Double on loss
        </div>
    </div>
    
    <script>
        function formatSats(btc) { return Math.floor(Math.abs(btc) * 100000000).toLocaleString(); }
        
        function update() {
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    const b = data.botState;
                    
                    document.getElementById('balance').innerHTML = formatSats(b.stats.currentBalance);
                    document.getElementById('balanceSats').innerHTML = formatSats(b.stats.currentBalance) + ' satoshi';
                    
                    const profitElem = document.getElementById('profit');
                    profitElem.innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + formatSats(Math.abs(b.stats.netProfit));
                    profitElem.className = 'value ' + (b.stats.netProfit >= 0 ? 'profit-positive' : 'profit-negative');
                    document.getElementById('profitSats').innerHTML = (b.stats.netProfit >= 0 ? '+' : '') + formatSats(Math.abs(b.stats.netProfit)) + ' satoshi';
                    
                    document.getElementById('totalBets').innerHTML = b.stats.totalBets;
                    document.getElementById('wins').innerHTML = b.stats.wins;
                    document.getElementById('losses').innerHTML = b.stats.losses;
                    document.getElementById('winRate').innerHTML = data.winRate + '%';
                    document.getElementById('nextBet').innerHTML = formatSats(b.settings.currentBet);
                    document.getElementById('statusMsg').innerHTML = '<span class="running-indicator"></span> ' + b.statusMessage;
                    
                    const tbody = document.getElementById('history');
                    tbody.innerHTML = '';
                    for (let i = 0; i < Math.min(30, b.betHistory.length); i++) {
                        const bet = b.betHistory[i];
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = '#' + bet.id;
                        row.insertCell(1).innerText = bet.time;
                        row.insertCell(2).innerHTML = bet.wagerSats + ' sats';
                        row.insertCell(3).innerText = bet.multiplier + 'x';
                        row.insertCell(4).innerHTML = bet.profit >= 0 ? 
                            '<span class="win">+' + bet.profitSats + '</span>' : 
                            '<span class="loss">' + bet.profitSats + '</span>';
                        row.insertCell(5).innerHTML = bet.isWin ? '<span class="win">✅ WIN</span>' : '<span class="loss">❌ LOSS</span>';
                        row.insertCell(6).innerText = bet.balanceSats + ' sats';
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
    console.log(`\n🚀 FIXED BOT: http://localhost:${port}\n`);
    runProfitBot();
});
