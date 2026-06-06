const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ MYDICEBOT CONFIGURATION ============
const CONFIG = {
    API_KEY: process.env.API_KEY || "wnFmqb88iyIVPgJJHRMrSfyPOaoySEbnFTrV4xsKJCxHQXjnPy",
    COIN: "BTC", // BTC, ETH, DOGE, LTC, etc.
    PAYOUT: 2.0,
    
    // STRATEGY SELECTION: "MARTINGALE", "ALEMBERT", "FIBONACCI", "LABOUCHERE", "OSCARS_GRIND"
    ACTIVE_STRATEGY: "ALEMBERT", 

    SETTINGS: {
        baseBet: 0.00000001,
        maxBet: 0.00100000,
        unit: 0.00000001,                // Used for D'Alembert and Oscar's Grind
        labouchereSequence: [1, 2, 3],   // Initial sequence for Labouchere
    },
    
    STOP_CONDITIONS: {
        stopAtProfit: 0.005,    // Stop if profit reaches this
        stopAtLoss: -0.01,      // Stop if loss reaches this
    }
};

// ============ BOT ENGINE STATE ============
let botState = {
    running: true,
    status: "Initializing",
    startTime: Date.now(),
    btcPrice: 0,
    balance: { initial: 0, current: 0 },
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        profit: 0,
        wagered: 0,
    },
    currentBet: CONFIG.SETTINGS.baseBet,
    history: [],
    // Strategy Internal States
    internal: {
        fibIndex: 0,
        labSequence: [...CONFIG.SETTINGS.labouchereSequence],
        oscarUnit: 1,
        oscarCycleProfit: 0
    }
};

// ============ STRATEGY LOGIC ============
const Strategies = {
    MARTINGALE: (isWin) => {
        if (isWin) {
            botState.currentBet = CONFIG.SETTINGS.baseBet;
        } else {
            botState.currentBet *= 2;
        }
    },

    ALEMBERT: (isWin) => {
        if (isWin) {
            botState.currentBet = Math.max(CONFIG.SETTINGS.baseBet, botState.currentBet - CONFIG.SETTINGS.unit);
        } else {
            botState.currentBet += CONFIG.SETTINGS.unit;
        }
    },

    FIBONACCI: (isWin) => {
        const fib = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
        if (isWin) {
            botState.internal.fibIndex = Math.max(0, botState.internal.fibIndex - 2);
        } else {
            botState.internal.fibIndex++;
        }
        const mult = fib[botState.internal.fibIndex] || fib[fib.length - 1];
        botState.currentBet = CONFIG.SETTINGS.baseBet * mult;
    },

    LABOUCHERE: (isWin) => {
        let seq = botState.internal.labSequence;
        if (seq.length === 0) seq = [...CONFIG.SETTINGS.labouchereSequence];

        if (isWin) {
            seq.shift();
            seq.pop();
            if (seq.length === 0) seq = [...CONFIG.SETTINGS.labouchereSequence];
        } else {
            const lastBetUnits = (seq[0] || 0) + (seq[seq.length - 1] || 0);
            seq.push(lastBetUnits || 1);
        }
        
        botState.internal.labSequence = seq;
        const nextUnits = seq.length > 1 ? seq[0] + seq[seq.length - 1] : seq[0];
        botState.currentBet = CONFIG.SETTINGS.baseBet * (nextUnits || 1);
    },

    OSCARS_GRIND: (isWin) => {
        const unit = CONFIG.SETTINGS.unit;
        if (isWin) {
            botState.internal.oscarCycleProfit += (botState.currentBet * (CONFIG.PAYOUT - 1));
            if (botState.internal.oscarCycleProfit >= unit) {
                // Cycle complete
                botState.internal.oscarCycleProfit = 0;
                botState.internal.oscarUnit = 1;
            } else {
                botState.internal.oscarUnit++;
            }
        } else {
            botState.internal.oscarCycleProfit -= botState.currentBet;
        }
        botState.currentBet = unit * botState.internal.oscarUnit;
    }
};

// ============ CORE ENGINE ============
async function placeBet() {
    const url = `https://api.crypto.games/v1/placebet/${CONFIG.COIN}/${CONFIG.API_KEY}`;
    
    // FIX: ClientSeed must be ALPHANUMERIC ONLY (no underscores)
    const randomString = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
    
    const payload = { 
        Bet: Number(botState.currentBet.toFixed(8)), 
        Payout: CONFIG.PAYOUT, 
        UnderOver: true, 
        ClientSeed: "MDB" + randomString 
    };

    try {
        const res = await axios.post(url, payload);
        return res.data;
    } catch (err) {
        botState.status = "API Error: " + (err.response?.data?.Message || "Service Unavailable");
        return null;
    }
}

async function runEngine() {
    botState.status = `Running ${CONFIG.ACTIVE_STRATEGY}...`;
    
    while (botState.running) {
        // 1. Check Stop Conditions
        if (botState.stats.profit >= CONFIG.STOP_CONDITIONS.stopAtProfit) {
            botState.status = "Target Profit Reached.";
            botState.running = false; break;
        }
        if (botState.stats.profit <= CONFIG.STOP_CONDITIONS.stopAtLoss) {
            botState.status = "Stop Loss Hit.";
            botState.running = false; break;
        }

        // 2. Execute Bet
        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 10000)); // Wait 10s on error
            continue; 
        }

        // 3. Update Balance & Stats
        if (botState.stats.totalBets === 0) botState.balance.initial = result.Balance;
        botState.balance.current = result.Balance;
        botState.stats.totalBets++;
        botState.stats.wagered += result.Bet;
        botState.stats.profit += result.Profit;

        const isWin = result.Profit > 0;
        if (isWin) botState.stats.wins++; else botState.stats.losses++;

        // 4. Run Strategy Logic
        Strategies[CONFIG.ACTIVE_STRATEGY](isWin);

        // 5. Safety Caps
        if (botState.currentBet > CONFIG.SETTINGS.maxBet) botState.currentBet = CONFIG.SETTINGS.maxBet;
        if (botState.currentBet > botState.balance.current) botState.currentBet = CONFIG.SETTINGS.baseBet;

        // 6. Log to History
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

        // 7. Rate Limit (approx 1 bet per second)
        await new Promise(r => setTimeout(r, 1100));
    }
}

// ============ DASHBOARD & API ============
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
        .container { display: grid; grid-template-columns: 320px 1fr; flex: 1; overflow: hidden; }
        .sidebar { background: #181a20; padding: 20px; border-right: 1px solid #2b2f36; }
        .main { padding: 20px; overflow-y: auto; }
        .stat-card { background: #1e2329; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #f0b90b; }
        .stat-val { font-size: 22px; font-weight: bold; color: #f0b90b; font-family: monospace; }
        .win { color: #0ecb81 !important; } .loss { color: #f6465d !important; }
        table { width: 100%; border-collapse: collapse; background: #181a20; border-radius: 8px; }
        th { text-align: left; padding: 12px; color: #848e9c; font-size: 12px; text-transform: uppercase; }
        td { padding: 12px; border-top: 1px solid #2b2f36; font-family: monospace; font-size: 13px; }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; background: #2b2f36; }
    </style>
</head>
<body>
    <div class="nav">
        <div style="font-weight: bold; font-size: 20px;">MyDiceBot <span style="color:#f0b90b">Pro</span></div>
        <div id="status-text">Status: Starting...</div>
    </div>
    <div class="container">
        <div class="sidebar">
            <div class="stat-card"><div>Strategy</div><div class="stat-val" style="font-size:16px">${CONFIG.ACTIVE_STRATEGY}</div></div>
            <div class="stat-card"><div>Profit (${CONFIG.COIN})</div><div id="p-btc" class="stat-val">0.00000000</div></div>
            <div class="stat-card"><div>Current Balance</div><div id="balance" class="stat-val">0.00000000</div></div>
            <div class="stat-card"><div>Win Rate</div><div id="wr" class="stat-val">0%</div></div>
            <div class="stat-card"><div>Wagered</div><div id="wagered" class="stat-val">0.00000000</div></div>
        </div>
        <div class="main">
            <table>
                <thead><tr><th>ID</th><th>Wager</th><th>Roll</th><th>Profit</th><th>Balance</th></tr></thead>
                <tbody id="hist-body"></tbody>
            </table>
        </div>
    </div>
    <script>
        async function update() {
            try {
                const r = await fetch('/api/data');
                const data = await r.json();
                
                document.getElementById('status-text').innerText = "Status: " + data.status;
                document.getElementById('p-btc').innerText = data.stats.profit.toFixed(8);
                document.getElementById('p-btc').className = data.stats.profit >= 0 ? "stat-val win" : "stat-val loss";
                document.getElementById('balance').innerText = data.balance.current.toFixed(8);
                document.getElementById('wagered').innerText = data.stats.wagered.toFixed(8);
                
                const wr = (data.stats.wins / data.stats.totalBets * 100) || 0;
                document.getElementById('wr').innerText = wr.toFixed(1) + "%";

                const rows = data.history.map(h => \`
                    <tr>
                        <td>#\${h.id}</td>
                        <td>\${h.wager.toFixed(8)}</td>
                        <td><span class="badge">\${h.roll}</span></td>
                        <td class="\${h.win?'win':'loss'}">\${h.profit.toFixed(8)}</td>
                        <td>\${h.bal.toFixed(8)}</td>
                    </tr>
                \`).join('');
                document.getElementById('hist-body').innerHTML = rows;
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

// ============ START BOT ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\x1b[32m[MyDiceBot] Dashboard: http://localhost:${port}\x1b[0m`);
    runEngine();
});
