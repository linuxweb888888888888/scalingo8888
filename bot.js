const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ MYDICEBOT CONFIGURATION ============
const CONFIG = {
    API_KEY: process.env.API_KEY || "wnFmqb88iyIVPgJJHRMrSfyPOaoySEbnFTrV4xsKJCxHQXjnPy",
    COIN: "BTC", 
    PAYOUT: 2.0, 
    
    // MATHEMATICAL STRATEGY: SMART_SCALER
    // Automatically adjusts bets based on your balance to survive long streaks.
    ACTIVE_STRATEGY: "SMART_SCALER", 

    SETTINGS: {
        baseBet: 0.00000001,
        maxBet: 0.00500000,
        // How many losses in a row do you want to survive? (14-16 is recommended for 2x payout)
        survivalStreak: 15, 
    },
    
    STOP_CONDITIONS: {
        stopAtProfit: 0.005,    
        stopAtLoss: -0.02,      
    }
};

// ============ BOT ENGINE STATE ============
let botState = {
    running: true,
    status: "Initializing...",
    startTime: Date.now(),
    balance: { initial: 0, current: 0 },
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        profit: 0,
        wagered: 0,
        maxLossStreak: 0,
        currentStreak: 0,
        highestBet: 0
    },
    currentBet: CONFIG.SETTINGS.baseBet,
    history: []
};

// ============ MATHEMATICAL LOGIC ============
const Strategies = {
    SMART_SCALER: (isWin) => {
        // Calculate the "Safe Base" (Balance divided by 2 to the power of survival streak)
        // This ensures math-wise that we can lose X times before hitting 0.
        const divisor = Math.pow(2, CONFIG.SETTINGS.survivalStreak);
        const dynamicBase = Math.max(CONFIG.SETTINGS.baseBet, botState.balance.current / divisor);

        if (isWin) {
            botState.stats.currentStreak = 0;
            botState.currentBet = dynamicBase;
        } else {
            botState.stats.currentStreak++;
            botState.stats.maxLossStreak = Math.max(botState.stats.maxLossStreak, botState.stats.currentStreak);
            
            // If we hit our survival limit, reset to base to save the remaining bankroll
            if (botState.stats.currentStreak >= CONFIG.SETTINGS.survivalStreak) {
                botState.currentBet = dynamicBase;
            } else {
                botState.currentBet *= 2;
            }
        }
    }
};

// ============ CORE ENGINE ============
async function placeBet() {
    const url = `https://api.crypto.games/v1/placebet/${CONFIG.COIN}/${CONFIG.API_KEY}`;
    const randomString = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
    
    const payload = { 
        Bet: Number(botState.currentBet.toFixed(8)), 
        Payout: CONFIG.PAYOUT, 
        UnderOver: true, 
        ClientSeed: "MDB" + randomString 
    };

    try {
        const res = await axios.post(url, payload);
        if (res.data && res.data.Message) throw new Error(res.data.Message);
        return res.data;
    } catch (err) {
        botState.status = "Error: " + (err.response?.data?.Message || err.message);
        return null;
    }
}

async function runEngine() {
    botState.status = "Engine Active";
    
    while (botState.running) {
        // Stop Condition Check
        if (botState.stats.profit >= CONFIG.STOP_CONDITIONS.stopAtProfit) {
            botState.status = "Profit Target Reached";
            botState.running = false; break;
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 10000)); 
            continue; 
        }

        // Global Stats Update
        if (botState.stats.totalBets === 0) botState.balance.initial = result.Balance;
        botState.balance.current = result.Balance;
        botState.stats.totalBets++;
        botState.stats.wagered += result.Bet;
        botState.stats.profit += result.Profit;
        botState.stats.highestBet = Math.max(botState.stats.highestBet, result.Bet);

        const isWin = result.Profit > 0;
        if (isWin) botState.stats.wins++; else botState.stats.losses++;

        // Strategy Execution
        Strategies[CONFIG.ACTIVE_STRATEGY](isWin);

        // History Log
        botState.history.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            wager: result.Bet,
            roll: result.Roll,
            profit: result.Profit,
            win: isWin,
            bal: result.Balance
        });
        if (botState.history.length > 50) botState.history.pop();

        await new Promise(r => setTimeout(r, 1100)); // Rate limiting
    }
}

// ============ DASHBOARD ============
app.get('/api/data', (req, res) => {
    // Calculate extra metrics for the UI
    const elapsedHrs = (Date.now() - botState.startTime) / 3600000;
    const profitPerHour = (botState.stats.profit / elapsedHrs) || 0;
    res.json({ ...botState, profitPerHour, uptime: elapsedHrs });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>MyDiceBot Pro - v4.5</title>
    <style>
        :root { --primary: #3498db; --success: #27ae60; --danger: #e74c3c; --bg: #f4f7f6; --text: #2c3e50; }
        body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; }
        .nav { background: white; padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .grid { display: grid; grid-template-columns: 300px 1fr; gap: 20px; padding: 20px; max-width: 1400px; margin: auto; }
        .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.02); border: 1px solid #eef2f3; }
        .metric-group { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .metric-box { padding: 15px; background: #fafbfc; border-radius: 8px; border: 1px solid #f0f3f5; }
        .label { font-size: 11px; text-transform: uppercase; color: #7f8c8d; font-weight: 600; margin-bottom: 5px; }
        .value { font-size: 18px; font-weight: 700; font-family: 'Monaco', monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th { text-align: left; font-size: 11px; color: #95a5a6; padding: 12px; border-bottom: 2px solid #f4f7f6; }
        td { padding: 12px; font-size: 13px; border-bottom: 1px solid #f4f7f6; font-family: 'Monaco', monospace; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; background: #ebf5fb; color: var(--primary); font-weight: bold; }
        .status-dot { height: 10px; width: 10px; background-color: var(--success); border-radius: 50%; display: inline-block; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="nav">
        <div style="font-size: 1.2rem; font-weight: 800; letter-spacing: -0.5px;">MYDICEBOT <span style="color: var(--primary)">PRO</span></div>
        <div id="status-area" style="font-size: 13px; font-weight: 500;">
            <span class="status-dot"></span> <span id="status-text">Connecting...</span>
        </div>
    </div>

    <div class="grid">
        <div class="sidebar">
            <div class="card">
                <div class="label">Profit (${CONFIG.COIN})</div>
                <div id="main-profit" class="value" style="font-size: 28px;">0.00000000</div>
                <hr style="border:0; border-top: 1px solid #f4f7f6; margin: 15px 0;">
                <div class="metric-group">
                    <div class="metric-box"><div class="label">Win Rate</div><div id="win-rate" class="value">0%</div></div>
                    <div class="metric-box"><div class="label">Current Bal</div><div id="bal" class="value" style="font-size:14px">0.000</div></div>
                    <div class="metric-box"><div class="label">Max Loss Streak</div><div id="max-streak" class="value loss">0</div></div>
                    <div class="metric-box"><div class="label">Prof / Hour</div><div id="pph" class="value win" style="font-size:14px">0.000</div></div>
                </div>
                <div class="metric-box" style="margin-top:10px;">
                    <div class="label">Highest Bet Encountered</div>
                    <div id="high-bet" class="value">0.00000000</div>
                </div>
                <div class="metric-box" style="margin-top:10px;">
                    <div class="label">Session Duration</div>
                    <div id="uptime" class="value">00:00:00</div>
                </div>
            </div>
        </div>

        <div class="main-content">
            <div class="card" style="padding: 0;">
                <table id="history-table">
                    <thead>
                        <tr>
                            <th>TIME</th>
                            <th>ID</th>
                            <th>WAGER</th>
                            <th>ROLL</th>
                            <th>PROFIT</th>
                            <th>RESULTING BALANCE</th>
                        </tr>
                    </thead>
                    <tbody id="history-body"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        function formatTime(hrs) {
            const h = Math.floor(hrs);
            const m = Math.floor((hrs * 60) % 60);
            const s = Math.floor((hrs * 3600) % 60);
            return \`\${h}h \${m}m \${s}s\`;
        }

        async function refresh() {
            try {
                const res = await fetch('/api/data');
                const data = await res.json();
                
                document.getElementById('status-text').innerText = data.status;
                document.getElementById('main-profit').innerText = data.stats.profit.toFixed(8);
                document.getElementById('main-profit').className = "value " + (data.stats.profit >= 0 ? "win" : "loss");
                document.getElementById('bal').innerText = data.balance.current.toFixed(8);
                document.getElementById('win-rate').innerText = ((data.stats.wins / data.stats.totalBets) * 100 || 0).toFixed(1) + "%";
                document.getElementById('max-streak').innerText = data.stats.maxLossStreak;
                document.getElementById('pph').innerText = data.profitPerHour.toFixed(8);
                document.getElementById('high-bet').innerText = data.stats.highestBet.toFixed(8);
                document.getElementById('uptime').innerText = formatTime(data.uptime);

                const rows = data.history.map(h => \`
                    <tr>
                        <td>\${h.time}</td>
                        <td>#\${h.id}</td>
                        <td>\${h.wager.toFixed(8)}</td>
                        <td><span class="badge">\${h.roll}</span></td>
                        <td class="\${h.win ? 'win' : 'loss'}">\${h.profit.toFixed(8)}</td>
                        <td style="color: #7f8c8d">\${h.bal.toFixed(8)}</td>
                    </tr>
                \`).join('');
                document.getElementById('history-body').innerHTML = rows;
            } catch (e) { console.error(e); }
        }
        setInterval(refresh, 1000);
    </script>
</body>
</html>
    `);
});

// ============ START BOT ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n\x1b[36mMyDiceBot Pro Running\x1b[0m`);
    console.log(`\x1b[32mDashboard: http://localhost:${port}\x1b[0m\n`);
    runEngine();
});
