const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "YOUR_API_KEY_HERE";
const BASE_URL = "https://api.crypto.games/v1";

const PLINKO_CONFIG = {
    coin: "BTC",
    // Plinko specific settings
    risk: "medium",      // Options: "low", "medium", "high"
    rows: 16,            // Number of pin rows (8-16 typical)
    // Betting strategy
    baseBet: 0.00000010,  // 1000 satoshis base bet
    maxBet: 0.00001000,   // Cap at 100k satoshis
    targetProfit: 0.00010000,  // Stop if profit hits 0.001 BTC
    stopLoss: 0.00005000,      // Stop if loss hits 0.0005 BTC
};

// Plinko payout multipliers for different risk levels
const PLINKO_PAYOUTS = {
    low: {
        8: [5.6, 2.1, 1.1, 1, 1, 1.1, 2.1, 5.6],
        16: [16, 9, 3, 1.4, 1.2, 1.1, 1, 1, 1, 1, 1.1, 1.2, 1.4, 3, 9, 16]
    },
    medium: {
        8: [13, 3, 1.3, 0.7, 0.7, 1.3, 3, 13],
        16: [29, 13, 5, 2.3, 1.4, 1, 0.7, 0.5, 0.5, 0.7, 1, 1.4, 2.3, 5, 13, 29]
    },
    high: {
        8: [29, 4, 1.5, 0.3, 0.3, 1.5, 4, 29],
        16: [89, 29, 13, 5, 2.3, 1.2, 0.5, 0.3, 0.3, 0.5, 1.2, 2.3, 5, 13, 29, 89]
    }
};

// ============ BOT STATE ============
let btcPrice = 60964;
let botState = {
    running: true,
    statusMessage: "Initializing Plinko Bot...",
    coin: PLINKO_CONFIG.coin,
    stats: {
        totalBets: 0,
        wins: 0,        // Bets with multiplier > 1x
        losses: 0,      // Bets with multiplier < 1x
        netProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
        maxDrawdown: 0,
        peakBalance: 0,
    },
    settings: {
        currentBet: PLINKO_CONFIG.baseBet,
        risk: PLINKO_CONFIG.risk,
        rows: PLINKO_CONFIG.rows,
    },
    betHistory: [],
    sessionActive: true
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

function getRandomPosition(rows) {
    // Returns random landing position (0 to rows-1)
    return Math.floor(Math.random() * rows);
}

function getMultiplier(risk, rows, position) {
    const payouts = PLINKO_PAYOUTS[risk][rows];
    return payouts[position] || 1;
}

// ============ API LOGIC ============
async function placePlinkoBet() {
    // Crypto.Games Plinko endpoint format
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    const clientSeed = `plinko_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    
    // For Plinko, we need to specify the game type
    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)),
        Payout: 2.0,  // Placeholder - actual payout determined by landing position
        UnderOver: true,
        ClientSeed: clientSeed,
        Game: "plinko",  // Specify Plinko game
        Rows: botState.settings.rows,
        Risk: botState.settings.risk
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response.data;
    } catch (error) { 
        console.error("API Error:", error.response?.data || error.message);
        botState.statusMessage = `API Error: ${error.response?.data?.Message || error.message}`;
        return null; 
    }
}

// ============ MARTINGALE-LIKE PLINKO STRATEGY ============
async function runPlinkoStrategy() {
    botState.statusMessage = "Plinko Bot Running - Medium Risk";
    
    while (botState.running) {
        // Check stop conditions
        if (botState.stats.netProfit >= PLINKO_CONFIG.targetProfit) {
            botState.statusMessage = `🎯 Target profit reached: ${botState.stats.netProfit.toFixed(8)} BTC`;
            botState.running = false;
            break;
        }
        
        if (botState.stats.netProfit <= -PLINKO_CONFIG.stopLoss) {
            botState.statusMessage = `🛑 Stop loss triggered: ${botState.stats.netProfit.toFixed(8)} BTC`;
            botState.running = false;
            break;
        }
        
        // Update current balance and track drawdown
        if (botState.stats.currentBalance > botState.stats.peakBalance) {
            botState.stats.peakBalance = botState.stats.currentBalance;
        }
        const drawdown = botState.stats.peakBalance - botState.stats.currentBalance;
        if (drawdown > botState.stats.maxDrawdown) {
            botState.stats.maxDrawdown = drawdown;
        }
        
        // Place the bet
        const result = await placePlinkoBet();
        
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }
        
        // Process result
        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        const multiplier = result.Multiplier || 1;
        
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;
        
        // Track win/loss (multiplier > 1 = win, < 1 = loss)
        if (multiplier > 1) {
            botState.stats.wins++;
            // After a win, reset to base bet
            botState.settings.currentBet = PLINKO_CONFIG.baseBet;
        } else {
            botState.stats.losses++;
            // After a loss, increase bet (recovery mode)
            let newBet = botState.settings.currentBet * 1.5;
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
            position: result.Position || "?",
            currentBet: botState.settings.currentBet
        });
        
        // Keep last 50 bets
        if (botState.betHistory.length > 50) botState.betHistory.pop();
        
        // Calculate win rate display
        const winRate = botState.stats.totalBets > 0 ? 
            (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        
        console.log(`[${new Date().toLocaleTimeString()}] Bet #${botState.stats.totalBets}: ${result.Bet.toFixed(8)} BTC | Multiplier: ${multiplier}x | ${profit > 0 ? 'WIN' : 'LOSS'} +${profit.toFixed(8)} | Balance: ${botState.stats.currentBalance.toFixed(8)} | WR: ${winRate}%`);
        
        // Rate limiting - Plinko is fast but don't overwhelm API
        await new Promise(r => setTimeout(r, 800));
    }
    
    console.log("Bot stopped:", botState.statusMessage);
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
        config: PLINKO_CONFIG,
        winRate
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Plinko Bot | Crypto.Games Automation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1300px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; color: white; }
        .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .header p { opacity: 0.9; }
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .stat-label { font-size: 0.8rem; text-transform: uppercase; color: #666; letter-spacing: 1px; margin-bottom: 8px; }
        .stat-value { font-size: 1.8rem; font-weight: bold; color: #333; }
        .stat-sub { font-size: 0.9rem; color: #888; margin-top: 5px; }
        
        .plinko-visual { background: white; border-radius: 15px; padding: 20px; margin-bottom: 30px; }
        .pin-row { display: flex; justify-content: center; margin: 5px 0; }
        .pin { width: 30px; height: 30px; background: #764ba2; border-radius: 50%; margin: 0 15px; display: inline-block; }
        .bucket { width: 40px; height: 50px; background: #667eea; border-radius: 5px; margin: 0 10px; display: inline-flex; align-items: center; justify-content: center; color: white; font-weight: bold; }
        
        .history-table { background: white; border-radius: 15px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f8f9fa; padding: 15px; text-align: left; font-weight: 600; color: #555; }
        td { padding: 12px 15px; border-bottom: 1px solid #eee; font-family: monospace; }
        .win { color: #10b981; font-weight: bold; }
        .loss { color: #ef4444; font-weight: bold; }
        .status-bar { background: #1e293b; color: white; padding: 15px; border-radius: 10px; margin-bottom: 20px; font-weight: bold; text-align: center; }
        
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .running { animation: pulse 2s infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎯 PLINKO BOT</h1>
            <p>Crypto.Games Automated Betting System</p>
        </div>
        
        <div class="status-bar" id="statusMsg">🟢 Bot Status: Running...</div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">💰 Wallet Balance</div>
                <div class="stat-value" id="walletBalance">0.00000000</div>
                <div class="stat-sub" id="walletUSD">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📈 Net Profit</div>
                <div class="stat-value" id="netProfit" style="color: #10b981;">0.00000000</div>
                <div class="stat-sub" id="profitUSD">$0.00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">🎲 Total Bets</div>
                <div class="stat-value" id="totalBets">0</div>
                <div class="stat-sub">Wins: <span id="wins">0</span> | Losses: <span id="losses">0</span></div>
            </div>
            <div class="stat-card">
                <div class="stat-label">📊 Win Rate</div>
                <div class="stat-value" id="winRate">0%</div>
                <div class="stat-sub">Current Bet: <span id="currentBet">0</span> BTC</div>
            </div>
        </div>
        
        <div class="plinko-visual">
            <h3 style="margin-bottom: 20px;">🎮 Plinko Board (${PLINKO_CONFIG.rows} Rows | ${PLINKO_CONFIG.risk.toUpperCase()} Risk)</h3>
            <div id="plinkoBoard" style="text-align: center; overflow-x: auto;">
                <!-- Dynamic Plinko visualization -->
            </div>
        </div>
        
        <div class="history-table">
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Time</th>
                        <th>Wager (BTC)</th>
                        <th>Multiplier</th>
                        <th>Profit (BTC)</th>
                        <th>Result</th>
                        <th>Next Bet</th>
                    </tr>
                </thead>
                <tbody id="historyBody">
                    <tr><td colspan="7" style="text-align: center;">Waiting for bets...</td></tr>
                </tbody>
            </div>
        </div>
    </div>
    
    <script>
        async function updateDashboard() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                const { botState, btcPrice, winRate } = data;
                
                // Update basic stats
                document.getElementById('walletBalance').innerText = botState.stats.currentBalance.toFixed(8);
                document.getElementById('walletUSD').innerText = '$' + (botState.stats.currentBalance * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('netProfit').innerText = (botState.stats.netProfit > 0 ? '+' : '') + botState.stats.netProfit.toFixed(8);
                document.getElementById('profitUSD').innerText = '$' + (Math.abs(botState.stats.netProfit) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 2});
                document.getElementById('totalBets').innerText = botState.stats.totalBets;
                document.getElementById('wins').innerText = botState.stats.wins;
                document.getElementById('losses').innerText = botState.stats.losses;
                document.getElementById('winRate').innerText = winRate + '%';
                document.getElementById('currentBet').innerText = botState.settings.currentBet.toFixed(8);
                document.getElementById('statusMsg').innerHTML = botState.running ? '🟢 Bot Status: ' + botState.statusMessage : '🔴 Bot Status: ' + botState.statusMessage;
                
                // Update history table
                const historyBody = document.getElementById('historyBody');
                if (botState.betHistory.length > 0) {
                    historyBody.innerHTML = botState.betHistory.map(b => `
                        <tr>
                            <td>#${b.id}</td>
                            <td>${b.time}</td>
                            <td>${b.bet.toFixed(8)}</td>
                            <td>${b.multiplier}x</td>
                            <td class="${b.isWin ? 'win' : 'loss'}">${b.profit > 0 ? '+' : ''}${b.profit.toFixed(8)}</td>
                            <td class="${b.isWin ? 'win' : 'loss'}">${b.isWin ? '🎉 WIN' : '💀 LOSS'}</td>
                            <td>${b.currentBet.toFixed(8)}</td>
                        </tr>
                    `).join('');
                }
                
                // Simple Plinko visualization
                const positions = botState.betHistory[0]?.position || 8;
                const rows = ${PLINKO_CONFIG.rows};
                let boardHtml = '';
                for (let i = 1; i <= rows; i++) {
                    boardHtml += '<div class="pin-row">';
                    for (let j = 0; j < i; j++) {
                        boardHtml += '<div class="pin"></div>';
                    }
                    boardHtml += '</div>';
                }
                boardHtml += '<div class="pin-row">';
                const multipliers = ${JSON.stringify(PLINKO_PAYOUTS[PLINKO_CONFIG.risk][PLINKO_CONFIG.rows])};
                for (let m of multipliers) {
                    boardHtml += `<div class="bucket">${m}x</div>`;
                }
                boardHtml += '</div>';
                document.getElementById('plinkoBoard').innerHTML = boardHtml;
                
            } catch(e) {
                console.error('Dashboard update error:', e);
            }
        }
        
        setInterval(updateDashboard, 1000);
        updateDashboard();
    </script>
</body>
</html>
    `);
});

// ============ START BOT ============
app.listen(port, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════════╗
    ║     🎯 PLINKO BOT STARTED 🎯              ║
    ╠═══════════════════════════════════════════╣
    ║  Dashboard: http://localhost:${port}      ║
    ║  Game: Plinko (${PLINKO_CONFIG.rows} rows / ${PLINKO_CONFIG.risk} risk)    ║
    ║  Base Bet: ${PLINKO_CONFIG.baseBet} BTC           ║
    ║  Target: ${PLINKO_CONFIG.targetProfit} BTC        ║
    ║  Stop Loss: ${PLINKO_CONFIG.stopLoss} BTC         ║
    ╚═══════════════════════════════════════════╝
    `);
    runPlinkoStrategy();
});
