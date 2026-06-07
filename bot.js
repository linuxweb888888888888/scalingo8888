const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ MYDICEBOT CONFIGURATION ============
const CONFIG = {
    API_KEY: process.env.API_KEY || "7nvnuDAK9yBa6ytpm1hKwndnqzgO6zPVkhWAgVo73LppRGwhMO",
    COIN: "BTC",
    PAYOUT: 2.0,
    STRATEGY: {
        baseBet: 0.00000001,
        maxBet: 0.00100000,
        // On Loss Logic (MyDiceBot Style)
        onLoss: {
            action: "increase", // "increase", "reset"
            value: 100,         // 100% increase = Martingale | 10% = Conservative
        },
        // On Win Logic
        onWin: {
            action: "reset",    // "reset", "increase"
            value: 0
        }
    },
    STOP_CONDITIONS: {
        stopAtProfit: 0.005,    // Stop bot if profit hits this
        stopAtLoss: -0.01,      // Stop bot if loss hits this
        maxBets: 0              // 0 = Infinite
    }
};

// ============ BOT ENGINE STATE ============
let botState = {
    running: true,
    status: "Initializing",
    startTime: Date.now(),
    btcPrice: 0,
    balance: { initial: 0, current: 0, high: 0 },
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        profit: 0,
        wagered: 0,
        maxBetSeen: 0
    },
    currentBet: CONFIG.STRATEGY.baseBet,
    history: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        botState.btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function logBet(betData) {
    botState.history.unshift(betData);
    if (botState.history.length > 50) botState.history.pop();
}

// ============ CORE BETTING LOGIC ============
async function placeBet() {
    const url = `https://api.crypto.games/v1/placebet/${CONFIG.COIN}/${CONFIG.API_KEY}`;
    const payload = { 
        Bet: Number(botState.currentBet.toFixed(8)), 
        Payout: CONFIG.PAYOUT, 
        UnderOver: true, 
        ClientSeed: "MDB_" + Math.random().toString(36).substring(2, 10)
    };

    try {
        const res = await axios.post(url, payload);
        return res.data;
    } catch (err) {
        botState.status = "API Error: " + (err.response?.data?.Message || "Offline");
        return null;
    }
}

async function runEngine() {
    botState.status = "Running Strategy...";
    
    while (botState.running) {
        // 1. Check Stop Conditions
        if (CONFIG.STOP_CONDITIONS.stopAtProfit > 0 && botState.stats.profit >= CONFIG.STOP_CONDITIONS.stopAtProfit) {
            botState.status = "Target Profit Reached. Stopping.";
            botState.running = false; break;
        }
        if (CONFIG.STOP_CONDITIONS.stopAtLoss < 0 && botState.stats.profit <= CONFIG.STOP_CONDITIONS.stopAtLoss) {
            botState.status = "Stop Loss Hit. Stopping.";
            botState.running = false; break;
        }

        // 2. Execute Bet
        const result = await placeBet();
        if (!result) { await new Promise(r => setTimeout(r, 10000)); continue; }

        // 3. Update Balance & Stats
        if (botState.stats.totalBets === 0) botState.balance.initial = result.Balance;
        botState.balance.current = result.Balance;
        botState.stats.totalBets++;
        botState.stats.wagered += result.Bet;
        botState.stats.profit += result.Profit;
        if (result.Bet > botState.stats.maxBetSeen) botState.stats.maxBetSeen = result.Bet;

        const isWin = result.Profit > 0;
        if (isWin) botState.stats.wins++; else botState.stats.losses++;

        // 4. MyDiceBot Strategy Logic
        if (isWin) {
            if (CONFIG.STRATEGY.onWin.action === "reset") {
                botState.currentBet = CONFIG.STRATEGY.baseBet;
            } else {
                botState.currentBet += (botState.currentBet * (CONFIG.STRATEGY.onWin.value / 100));
            }
        } else {
            if (CONFIG.STRATEGY.onLoss.action === "reset") {
                botState.currentBet = CONFIG.STRATEGY.baseBet;
            } else {
                // Example: 100% value means Martingale (Double)
                botState.currentBet += (botState.currentBet * (CONFIG.STRATEGY.onLoss.value / 100));
            }
        }

        // 5. Safety Caps
        if (botState.currentBet > CONFIG.STRATEGY.maxBet) botState.currentBet = CONFIG.STRATEGY.maxBet;
        if (botState.currentBet > botState.balance.current) botState.currentBet = CONFIG.STRATEGY.baseBet;

        logBet({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: result.Bet,
            roll: result.Roll,
            profit: result.Profit,
            win: isWin,
            bal: result.Balance
        });

        await new Promise(r => setTimeout(r, 1100));
    }
}

// ============ WEB UI (MODERN DASHBOARD) ============
app.get('/api/data', (req, res) => res.json(botState));

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>MyDiceBot-Node v4.0</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0b0e11; color: #eaecef; margin: 0; display: flex; flex-direction: column; height: 100vh; }
        .nav { background: #181a20; padding: 15px 30px; display: flex; justify-content: space-between; border-bottom: 1px solid #2b2f36; }
        .container { display: grid; grid-template-columns: 300px 1fr; flex: 1; overflow: hidden; }
        .sidebar { background: #181a20; padding: 20px; border-right: 1px solid #2b2f36; }
        .main { padding: 20px; overflow-y: auto; }
        .stat-card { background: #1e2329; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #f0b90b; }
        .stat-val { font-size: 20px; font-weight: bold; color: #f0b90b; }
        .win { color: #0ecb81; } .loss { color: #f6465d; }
        table { width: 100%; border-collapse: collapse; background: #181a20; border-radius: 8px; }
        th { text-align: left; padding: 12px; color: #848e9c; font-size: 12px; text-transform: uppercase; }
        td { padding: 12px; border-top: 1px solid #2b2f36; font-family: 'Courier New', monospace; font-size: 13px; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; background: #2b2f36; }
    </style>
</head>
<body>
    <div class="nav">
        <div style="font-weight: bold; font-size: 20px;">MyDiceBot <span style="color:#f0b90b">Pro</span></div>
        <div id="status-text">Status: Loading...</div>
    </div>
    <div class="container">
        <div class="sidebar">
            <div class="stat-card"><div>Profit (${CONFIG.COIN})</div><div id="p-btc" class="stat-val">0.00000000</div><div id="p-usd" style="font-size:12px"></div></div>
            <div class="stat-card"><div>Balance</div><div id="balance" class="stat-val">0.00000000</div></div>
            <div class="stat-card"><div>Win Rate</div><div id="wr" class="stat-val">0%</div></div>
            <div class="stat-card"><div>Total Wagered</div><div id="wagered" class="stat-val">0.00000000</div></div>
        </div>
        <div class="main">
            <table id="history">
                <thead><tr><th>ID</th><th>Wager</th><th>Target</th><th>Roll</th><th>Profit</th><th>Balance</th></tr></thead>
                <tbody id="hist-body"></tbody>
            </table>
        </div>
    </div>
    <script>
        async function update() {
            const r = await fetch('/api/data');
            const data = await r.json();
            
            document.getElementById('status-text').innerText = "Status: " + data.status;
            document.getElementById('p-btc').innerText = data.stats.profit.toFixed(8);
            document.getElementById('p-btc').className = data.stats.profit >= 0 ? "stat-val win" : "stat-val loss";
            document.getElementById('p-usd').innerText = "$" + (data.stats.profit * data.btcPrice).toFixed(2);
            document.getElementById('balance').innerText = data.balance.current.toFixed(8);
            document.getElementById('wagered').innerText = data.stats.wagered.toFixed(8);
            
            const wr = (data.stats.wins / data.stats.totalBets * 100) || 0;
            document.getElementById('wr').innerText = wr.toFixed(1) + "%";

            const rows = data.history.map(h => `
                <tr>
                    <td>#${h.id}</td>
                    <td>${h.wager.toFixed(8)}</td>
                    <td>${${CONFIG.PAYOUT}x}</td>
                    <td><span class="badge">${h.roll}</span></td>
                    <td class="${h.win?'win':'loss'}">${h.profit.toFixed(8)}</td>
                    <td>${h.bal.toFixed(8)}</td>
                </tr>
            `).join('');
            document.getElementById('hist-body').innerHTML = rows;
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`MyDiceBot Console: http://localhost:${port}`);
    runEngine();
});


app.listen(port, '0.0.0.0', () => runStrategy());
