const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "M7kmPCdpBfGBgY3SUX65E1C0EGiUaPa13U9lcIMGRFDBcikOcy";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 1.7,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001,
    houseEdge: 0.01  // 1% house edge (typical for crypto dice)
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
        lockPercent: 0.80 // Locking 80% of profit
    }, 
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        grossProfit: 0,
        houseEdgePaid: 0,
        maxSessionProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        payout: DEFAULTS.payout,
        winProbability: 0, // Will calculate from payout
        expectedValue: 0
    },
    betHistory: []
};

// Calculate true odds and house edge impact
function calculateGameMetrics(payout) {
    // For a dice game with payout multiplier P, the break-even win probability is 1/P
    const breakEvenProb = 1 / payout;
    // With house edge H, actual win probability = breakEvenProb * (1 - H)
    const actualProb = breakEvenProb * (1 - DEFAULTS.houseEdge);
    // Expected value per bet = (payout * actualProb) - (1 - actualProb)
    const expectedValue = (payout * actualProb) - (1 - actualProb);
    
    return {
        breakEvenProb,
        actualProb,
        expectedValue,
        houseEdgePercent: DEFAULTS.houseEdge * 100,
        theoreticalLossPerBet: DEFAULTS.houseEdge,
        payoutMultiplier: payout
    };
}

// Update expected value calculations
function updateExpectedValue() {
    const metrics = calculateGameMetrics(botState.settings.payout);
    botState.settings.winProbability = metrics.actualProb;
    botState.settings.expectedValue = metrics.expectedValue;
    return metrics;
}

// ============ SEED MANAGEMENT ============
let currentSeed = null;
let betsSinceSeedChange = 0;
const SEED_CHANGE_INTERVAL = 10;

function generateNewSeed() {
    const rawSuffix = Math.random().toString(36).substring(2);
    const alphanumericSuffix = rawSuffix.replace(/[^a-z0-9]/gi, '').substring(0, 12);
    const safeSeed = "pro" + alphanumericSuffix;
    return safeSeed;
}

function getCurrentSeed() {
    if (currentSeed === null) {
        currentSeed = generateNewSeed();
        betsSinceSeedChange = 0;
        botState.statusMessage = `New seed generated: ${currentSeed}`;
    }
    return currentSeed;
}

function checkAndRotateSeed() {
    betsSinceSeedChange++;
    if (betsSinceSeedChange >= SEED_CHANGE_INTERVAL) {
        currentSeed = generateNewSeed();
        betsSinceSeedChange = 0;
        botState.statusMessage = `Seed rotated (every ${SEED_CHANGE_INTERVAL} bets) - New seed: ${currentSeed}`;
        console.log(`[SEED] Rotated to: ${currentSeed}`);
    }
}

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

function resetSession() {
    botState.statusMessage = "SYSTEM: SAFE FLOOR HIT: Locking Profits...";
    botState.profitProtection.safeBalance = botState.stats.currentBalance * 0.80;
    botState.recoveryPot = 0;
    botState.stats = {
        totalBets: 0, wins: 0, losses: 0, netProfit: botState.stats.netProfit, 
        grossProfit: 0, houseEdgePaid: botState.stats.houseEdgePaid,
        maxSessionProfit: 0,
        currentBalance: botState.stats.currentBalance,
        startTime: Date.now()
    };
    botState.betHistory = [];
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
    
    currentSeed = null;
    betsSinceSeedChange = 0;
    updateExpectedValue();
}

// Calculate theoretical house edge contribution for a bet
function calculateHouseEdgeContribution(betAmount, resultProfit) {
    // If the bet lost, the house edge contributed is the full bet amount * house edge
    // If the bet won, the house edge reduced the payout by (expected payout - actual payout)
    const expectedPayoutNoEdge = betAmount * botState.settings.payout;
    const actualPayout = betAmount + resultProfit;
    const theoreticalPayoutWithEdge = expectedPayoutNoEdge * (1 - DEFAULTS.houseEdge);
    
    // House edge amount is the difference between what you would get without edge vs with edge
    const edgeAmount = Math.max(0, betAmount * DEFAULTS.houseEdge);
    return edgeAmount;
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const safeSeed = getCurrentSeed();

    const payload = { 
        Bet: Number(botState.settings.currentBet.toFixed(8)), 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: safeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        checkAndRotateSeed();
        return response.data;
    } catch (error) { 
        botState.statusMessage = error.response?.data?.Message || "API Error";
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    updateExpectedValue();
    const gameMetrics = calculateGameMetrics(botState.settings.payout);
    botState.statusMessage = `Linear Recovery Mode (80% Profit Lock) | House Edge: ${gameMetrics.houseEdgePercent}% | Expected Value per bet: ${(gameMetrics.expectedValue * 100).toFixed(4)}%`;
    
    while (true) {
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            resetSession();
            await new Promise(r => setTimeout(r, 5000));
            continue; 
        }

        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        
        // Track gross profit before house edge
        const theoreticalWinWithoutEdge = profit > 0 ? profit + (botState.settings.currentBet * DEFAULTS.houseEdge * botState.settings.payout) : 0;
        const houseEdgePaid = calculateHouseEdgeContribution(botState.settings.currentBet, profit);
        
        botState.stats.houseEdgePaid += houseEdgePaid;
        botState.stats.grossProfit += theoreticalWinWithoutEdge;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;

            if (botState.recoveryPot === 0) {
                botState.settings.currentBet = botState.settings.baseBet;
                botState.profitProtection.safeBalance += (profit * 0.80); 
            }
        } else {
            botState.stats.losses++;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.currentBet += DEFAULTS.betIncrement;
        }

        // Update expected value metrics after each bet
        const currentMetrics = updateExpectedValue();

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), 
            bet: result.Bet, roll: result.Roll, profit: profit, isWin: profit > 0, 
            pot: botState.recoveryPot.toFixed(8), dBase: botState.settings.baseBet,
            seed: currentSeed,
            betsOnSeed: betsSinceSeedChange,
            houseEdgeContribution: houseEdgePaid,
            theoreticalValue: currentMetrics.expectedValue * result.Bet
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();

        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ AJAX API ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    const gameMetrics = calculateGameMetrics(botState.settings.payout);
    const edgeImpact = botState.stats.houseEdgePaid / botState.stats.totalBets;
    
    res.json({ 
        botState, 
        btcPrice, 
        hoursPassed: hours.toFixed(2),
        houseEdgeMetrics: {
            houseEdgePercent: gameMetrics.houseEdgePercent,
            winProbability: gameMetrics.actualProb,
            breakEvenProbability: gameMetrics.breakEvenProb,
            expectedValuePerBet: gameMetrics.expectedValue,
            expectedValuePercent: gameMetrics.expectedValue * 100,
            totalHouseEdgePaid: botState.stats.houseEdgePaid,
            averageHouseEdgePerBet: edgeImpact,
            theoreticalGrossProfit: botState.stats.grossProfit,
            actualNetProfit: botState.stats.netProfit,
            edgeEfficiency: botState.stats.grossProfit > 0 ? (botState.stats.netProfit / botState.stats.grossProfit) * 100 : 0
        },
        seedInfo: {
            currentSeed: currentSeed,
            betsUntilNextSeed: SEED_CHANGE_INTERVAL - betsSinceSeedChange,
            seedChangeInterval: SEED_CHANGE_INTERVAL
        }
    });
});

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro v4.0 | House Edge Analysis | Seed Rotation</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; --warning: #f97316; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        .seed-info { background: #1e293b; color: white; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-family: monospace; font-size: 0.8rem; }
        .edge-panel { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .stat-value { font-size: 1.5rem; font-weight: bold; }
        .stat-label { font-size: 0.7rem; color: var(--text-muted); }
        .edge-badge { background: rgba(255,255,255,0.2); padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v4.0</span> <span class="edge-badge">House Edge Analytics</span></h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div id="price-tag" style="font-weight: 700;">$0.00</div></div>
        </div>
        <div class="status-bar" id="status-msg">Status: Initializing...</div>
        
        <!-- House Edge Panel -->
        <div class="edge-panel" id="edge-panel">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div><strong>🏠 House Edge Analysis</strong> <span id="house-edge-percent" style="font-size: 1.2rem;">-</span></div>
                <div>Expected Value: <span id="expected-value">-</span>% per bet</div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;">
                <div><div class="stat-label">Theoretical Win Prob</div><div id="win-prob" class="stat-value">-</div></div>
                <div><div class="stat-label">Break-even Prob</div><div id="break-even" class="stat-value">-</div></div>
                <div><div class="stat-label">House Edge Paid</div><div id="edge-paid" class="stat-value">- BTC</div></div>
                <div><div class="stat-label">Edge Efficiency</div><div id="edge-efficiency" class="stat-value">-</div></div>
            </div>
        </div>
        
        <div class="seed-info" id="seed-info">
            <div>🎲 Current Seed: <span id="current-seed">Loading...</span></div>
            <div>🔄 Bets until next seed change: <span id="bets-until-seed">0</span> / <span id="seed-interval">10</span></div>
        </div>
        
        <div class="grid">
            <div class="card"><div class="label">💳 Trading Balance</div><div id="t-bal" class="btc-val" style="color:var(--danger)">0.00</div><div id="t-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📈 Net Profit (After Edge)</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
            <div class="card"><div class="label">📊 Gross Profit (No Edge)</div><div id="g-prof" class="btc-val" style="color:var(--accent)">0.00</div><div id="g-usd" class="usd-val">$0.00</div></div>
        </div>
        
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div id="wr" style="font-weight:700">0%</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div id="s-base" style="font-weight:700; color:var(--primary)">0.00</div></div>
            <div class="mini-card"><div class="label">Next Bet</div><div id="n-bet" style="font-weight:700; color:var(--accent)">0.00</div></div>
            <div class="mini-card"><div class="label">Recovery Pot</div><div id="pot-display" style="font-weight:700; color:var(--warning)">0.00</div></div>
        </div>
        
        <div class="stats-row">
            <div class="mini-card"><div class="label">Total Bets</div><div id="total-bets" style="font-weight:700">0</div></div>
            <div class="mini-card"><div class="label">Wins/Losses</div><div id="wl-ratio" style="font-weight:700">0/0</div></div>
            <div class="mini-card"><div class="label">Payout Multiplier</div><div id="payout" style="font-weight:700">${DEFAULTS.payout}x</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div id="uptime" style="font-weight:700">0h</div></div>
        </div>
        
        <div class="label">Revenue Projections (Based on Wallet Balance)</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><span id="p-hr-b" class="win">0.00</span><br><span id="p-hr-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Daily</div><span id="p-dy-b" class="win">0.00</span><br><span id="p-dy-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Monthly</div><span id="p-month-b" class="win">0.00</span><br><span id="p-month-u" class="usd-val">0.00</span></div>
            <div class="proj-card"><div class="label">Yearly</div><span id="p-year-b" class="win">0.00</span><br><span id="p-year-u" class="usd-val">0.00</span></div>
        </div>
        
        <div class="label">Bet History (with House Edge Impact)</div>
        <table>
            <thead>
                <tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Edge Paid</th><th>Pot Remaining</th></tr>
            </thead>
            <tbody id="h-body"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const { botState, btcPrice, hoursPassed, seedInfo, houseEdgeMetrics } = await res.json();
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3});
                
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('t-bal').innerText = f(botState.stats.currentBalance - botState.profitProtection.safeBalance);
                document.getElementById('t-usd').innerText = u(botState.stats.currentBalance - botState.profitProtection.safeBalance);
                document.getElementById('w-bal').innerText = f(botState.stats.currentBalance);
                document.getElementById('w-usd').innerText = u(botState.stats.currentBalance);
                document.getElementById('n-prof').innerText = f(botState.stats.netProfit);
                document.getElementById('n-usd').innerText = u(botState.stats.netProfit);
                document.getElementById('g-prof').innerText = f(houseEdgeMetrics.theoreticalGrossProfit);
                document.getElementById('g-usd').innerText = u(houseEdgeMetrics.theoreticalGrossProfit);
                document.getElementById('pot-display').innerText = f(botState.recoveryPot);
                document.getElementById('wr').innerText = ((botState.stats.wins/botState.stats.totalBets)*100 || 0).toFixed(1) + "%";
                document.getElementById('s-base').innerText = f(botState.settings.baseBet);
                document.getElementById('n-bet').innerText = f(botState.settings.currentBet);
                document.getElementById('total-bets').innerText = botState.stats.totalBets;
                document.getElementById('wl-ratio').innerText = botState.stats.wins + '/' + botState.stats.losses;
                document.getElementById('payout').innerText = botState.settings.payout + 'x';
                document.getElementById('uptime').innerText = hoursPassed + "h";
                
                // House Edge Display
                document.getElementById('house-edge-percent').innerHTML = \`\${houseEdgeMetrics.houseEdgePercent.toFixed(2)}% House Edge\`;
                document.getElementById('expected-value').innerHTML = houseEdgeMetrics.expectedValuePercent.toFixed(4) + '%';
                document.getElementById('win-prob').innerHTML = (houseEdgeMetrics.winProbability * 100).toFixed(2) + '%';
                document.getElementById('break-even').innerHTML = (houseEdgeMetrics.breakEvenProbability * 100).toFixed(2) + '%';
                document.getElementById('edge-paid').innerHTML = f(houseEdgeMetrics.totalHouseEdgePaid) + ' BTC';
                document.getElementById('edge-efficiency').innerHTML = houseEdgeMetrics.edgeEfficiency.toFixed(2) + '%';
                
                if (seedInfo) {
                    document.getElementById('current-seed').innerText = seedInfo.currentSeed || 'None';
                    document.getElementById('bets-until-seed').innerText = seedInfo.betsUntilNextSeed;
                    document.getElementById('seed-interval').innerText = seedInfo.seedChangeInterval;
                }

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

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr>
                        <td>#\${b.id}</td>
                        <td>\${f(b.dBase)}</td>
                        <td>\${f(b.bet)}</td>
                        <td>\${b.roll}</td>
                        <td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td>
                        <td class="loss">\${f(b.houseEdgeContribution)}</td>
                        <td>\${b.pot} BTC</td>
                    </tr>
                \`).join('');
            } catch(e) {
                console.error('Update error:', e);
            }
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    runStrategy();
});
