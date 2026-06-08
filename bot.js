const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "IMoywOIynQ2pPom9ip9GW9kujnvlamXgvikGQOsj1vXQRxJivG";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 1.7,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001
};

// ============ BOT STATE ============
let btcPrice = 60964; 
let botState = {
    running: true,
    statusMessage: "Initializing...",
    recoveryPot: 0, 
    coin: DEFAULTS.coin,
    profitProtection: { 
        safeBalance: 0,
        lockPercent: 0.80
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        maxSessionProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout
    },
    betHistory: [],
    consecutiveWins: 0,
    consecutiveLosses: 0
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

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    return Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    const rawSuffix = Math.random().toString(36).substring(2); 
    const alphanumericSuffix = rawSuffix.replace(/[^a-z0-9]/gi, '').substring(0, 12);
    const safeSeed = "pro" + alphanumericSuffix; 

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        botState.statusMessage = error.response?.data?.Message || "API Error";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.statusMessage = "Symmetric Mode - Increment on Loss, Increment on Win Streak";
    
    while (true) {
        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            // WIN
            botState.stats.wins++;
            botState.consecutiveWins++;
            botState.consecutiveLosses = 0;
            
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;

            // Increment bet size on wins (but going DOWN from base)
            // Win streak 1: baseBet
            // Win streak 2: baseBet - increment
            // Win streak 3: baseBet - (2 * increment)
            if (botState.consecutiveWins === 1) {
                // First win after a loss - set to base bet
                botState.settings.currentBet = botState.settings.baseBet;
            } else {
                // Decrease bet on consecutive wins
                let decreasedBet = botState.settings.baseBet - ((botState.consecutiveWins - 1) * DEFAULTS.betIncrement);
                // Don't go below minimum bet (0.00000001)
                botState.settings.currentBet = Math.max(0.00000001, decreasedBet);
            }
            
            if (botState.recoveryPot === 0) {
                botState.profitProtection.safeBalance += (profit * 0.80);
                // Reset to base bet when recovery is complete
                botState.settings.currentBet = botState.settings.baseBet;
                botState.consecutiveWins = 0;
            }
        } else {
            // LOSS
            botState.stats.losses++;
            botState.consecutiveLosses++;
            botState.consecutiveWins = 0;
            
            botState.recoveryPot += Math.abs(profit);
            
            // Increment bet size on losses (going UP from base)
            // Loss streak 1: baseBet + increment
            // Loss streak 2: baseBet + (2 * increment)
            // Loss streak 3: baseBet + (3 * increment)
            let increasedBet = botState.settings.baseBet + (botState.consecutiveLosses * DEFAULTS.betIncrement);
            botState.settings.currentBet = increasedBet;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, 
            time: new Date().toLocaleTimeString(), 
            bet: result.Bet, 
            roll: result.Roll, 
            profit: profit, 
            isWin: profit > 0, 
            pot: botState.recoveryPot.toFixed(8), 
            dBase: botState.settings.baseBet,
            currentBet: botState.settings.currentBet,
            consecWins: botState.consecutiveWins,
            consecLosses: botState.consecutiveLosses
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v3.3 | Symmetric Increment</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        .streak-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; }
        .win-streak { background: #10b98120; color: #10b981; }
        .loss-streak { background: #ef444420; color: #ef4444; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .formula-hint { font-size: 0.7rem; color: var(--text-muted); margin-top: 10px; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v3.3</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div class="status-bar" id="status-msg">Status: Initializing...</div>
        <div class="grid">
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="pot-display" class="btc-val" style="color:var(--primary)">0.00</div><div class="usd-val">⬆️ Losses ⬇️ Wins</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00</div></div>
            <div class="mini-card"><div class="label">Next Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        <div class="label">Revenue Projections</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span><br><span id="p-hr-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span><br><span id="p-dy-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00</span><br><span id="p-month-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00</span><br><span id="p-year-u" class="usd-val">0.00</span></div>
        </div>
        <div class="label">Bet History (Increment on Losses UP / Increment on Wins DOWN)</div>
        <div class="formula-hint">
            📐 Formula: Loss Bet = Base + (LossStreak × Increment) | Win Bet = Base - ((WinStreak-1) × Increment) [Minimum 0.00000001]
        </div>
        <table>
            <thead>
                <tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Pot</th><th>Streak</th></tr>
            </thead>
            <tbody id="h-body"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const { botState, btcPrice, hoursPassed } = await res.json();
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3});
                
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                document.getElementById('wr').innerText = ((botState.stats.wins/botState.stats.totalBets)*100 || 0).toFixed(1) + "%";
                document.getElementById('s-base').innerText = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('uptime').innerText = hoursPassed + "h";

                const walletBalance = parseFloat(botState.stats.currentBalance || 0);
                const hours = parseFloat(hoursPassed);
                const hourlyProjection = walletBalance / hours;
                
                document.getElementById('p-hr-b').innerText = f(hourlyProjection);
                document.getElementById('p-hr-u').innerText = u(hourlyProjection);
                document.getElementById('p-dy-b').innerText = f(hourlyProjection * 24);
                document.getElementById('p-dy-u').innerText = u(hourlyProjection * 24);
                document.getElementById('p-month-b').innerText = f(hourlyProjection * 24 * 30);
                document.getElementById('p-month-u').innerText = u(hourlyProjection * 24 * 30);
                document.getElementById('p-year-b').innerText = f(hourlyProjection * 24 * 365);
                document.getElementById('p-year-u').innerText = u(hourlyProjection * 24 * 365);

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => {
                    let streakHtml = '';
                    if (b.consecWins > 1) streakHtml = '<span class="streak-badge win-streak">🟢 ' + b.consecWins + 'W</span>';
                    if (b.consecLosses > 1) streakHtml = '<span class="streak-badge loss-streak">🔴 ' + b.consecLosses + 'L</span>';
                    if (b.consecWins === 1) streakHtml = '<span class="streak-badge win-streak">🟢 1W</span>';
                    if (b.consecLosses === 1) streakHtml = '<span class="streak-badge loss-streak">🔴 1L</span>';
                    return \`
                        <tr>
                            <td style="font-family: monospace;">#\${b.id}</td>
                            <td style="font-family: monospace;">\${f(b.dBase)}</td>
                            <td style="font-family: monospace; font-weight: bold; color: \${b.currentBet > b.dBase ? '#ef4444' : '#10b981'};">\${f(b.currentBet || b.bet)}</td>
                            <td style="font-family: monospace;">\${b.roll}</td>
                            <td class="\${b.isWin?'win':'loss'}" style="font-family: monospace;">\${f(b.profit)}</td>
                            <td style="font-family: monospace;">\${b.pot}</td>
                            <td>\${streakHtml}</td>
                        </tr>
                    \`;
                }).join('');
            } catch(e) {
                console.error('Update error:', e);
            }
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    runStrategy();
});
