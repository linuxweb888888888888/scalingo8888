const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "ivA6fvYz8UfTRkpj1lCutsuqZ9ChoJAj6j9dZd2foZyfLVlE6U";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 2,          
    payout: 1.4,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001  
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: false,
    coin: DEFAULTS.coin,
    activeSeed: "", // Track the persistent seed
    profitProtection: { safeBalance: 0 },
    stats: {
        totalBets: 0,
        wins: 0,
        losses: 0,
        netProfit: 0,
        currentBalance: 0,
        startTime: Date.now(),
    },
    settings: {
        baseBet: 0.00000001,
        currentBet: 0.00000001,
        multiplier: DEFAULTS.multiplier,
        payout: DEFAULTS.payout
    },
    betHistory: []
};

// ============ UTILITIES ============
async function updateBTCPrice() {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        if (res.data.bitcoin && res.data.bitcoin.usd) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    const calculatedBase = Math.max(1, units) * DEFAULTS.betIncrement;
    return Number(calculatedBase.toFixed(8));
}

const STATE_PATH = process.env.HOME ? `${process.env.HOME}/bot-state.json` : './bot-state.json';

function saveState() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(botState, null, 2)); } catch (e) {}
}

function loadState() {
    if (fs.existsSync(STATE_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(STATE_PATH));
            botState.profitProtection = data.profitProtection || { safeBalance: 0 };
        } catch(e) {}
    }
}

// ============ API LOGIC ============
async function placeBet() {
    // Generate new seed every 10 bets or if no seed exists
    if (botState.stats.totalBets % 10 === 0 || !botState.activeSeed) {
        const randomSuffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 10);
        botState.activeSeed = "node20" + randomSuffix;
    }

    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: botState.activeSeed 
    };

    try {
        const response = await axios.post(url, payload);
        return response.data;
    } catch (error) { 
        console.error(`[!] API Error: ${error.response?.data?.Message || error.message}`);
        return null; 
    }
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    botState.running = true;
    while (botState.running) {
        const result = await placeBet();
        if (!result) { 
            await new Promise(r => setTimeout(r, 5000)); 
            continue; 
        }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.profitProtection.safeBalance += (profit * 0.50); 
            botState.settings.currentBet = botState.settings.baseBet;
        } else {
            botState.stats.losses++;
            
            let nextBet = botState.settings.currentBet * botState.settings.multiplier;
            botState.settings.currentBet = Math.ceil(nextBet * 100000000) / 100000000;
        }

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date(), bet: result.Bet, roll: result.Roll, 
            profit: profit, isWin: profit > 0, dynamicBase: botState.settings.baseBet
        });
        if (botState.betHistory.length > 50) botState.betHistory.pop();

        saveState();
        await new Promise(r => setTimeout(r, 1100)); 
    }
}

// ============ WEB DASHBOARD ============
app.get('/', (req, res) => {
    const fmt = (num) => (num || 0).toFixed(8);
    const usd = (num) => ((num || 0) * btcPrice).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const msPassed = Date.now() - botState.stats.startTime;
    const hoursPassed = Math.max(0.0001, msPassed / (1000 * 60 * 60));
    const pPerHour = botState.stats.netProfit / hoursPassed;
    const winRate = botState.stats.totalBets > 0 ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1) : 0;

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dice Pro | Corrected Martingale</title>
    <meta http-equiv="refresh" content="5">
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background-color: var(--bg); color: var(--text-main); padding: 2rem; line-height: 1.5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card.accent { border-top: 4px solid var(--accent); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); font-weight: 500; }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); border-bottom: 1px solid var(--border); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .live-dot { height: 8px; width: 8px; background-color: var(--success); border-radius: 50%; display: inline-block; box-shadow: 0 0 8px var(--success); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span class="live-dot"></span> Dice Pro Alpha</h1>
            <div style="text-align: right"><div class="label">Market BTC/USD</div><div style="font-weight: 700;">$${btcPrice.toLocaleString()}</div></div>
        </div>
        <div class="grid">
            <div class="card accent"><div class="label">🔒 Protected Profit (50%)</div><div class="btc-val">${fmt(botState.profitProtection.safeBalance)}</div><div class="usd-val">${usd(botState.profitProtection.safeBalance)}</div></div>
            <div class="card"><div class="label">💰 Wallet Balance</div><div class="btc-val">${fmt(botState.stats.currentBalance)}</div><div class="usd-val">${usd(botState.stats.currentBalance)}</div></div>
            <div class="card"><div class="label">📈 Session Profit</div><div class="btc-val ${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</div><div class="usd-val">${usd(botState.stats.netProfit)}</div></div>
            <div class="card"><div class="label">🎯 Target Next Bet</div><div class="btc-val">${fmt(botState.settings.currentBet)}</div><div class="usd-val">${usd(botState.settings.currentBet)}</div></div>
        </div>
        <div class="stats-row">
            <div class="mini-card"><div class="label">Win Rate</div><div style="font-weight:700">${winRate}%</div></div>
            <div class="mini-card"><div class="label">Total Bets</div><div style="font-weight:700">${botState.stats.totalBets}</div></div>
            <div class="mini-card"><div class="label">Scaling Base</div><div style="font-weight:700; color:var(--primary)">${fmt(botState.settings.baseBet)}</div></div>
            <div class="mini-card"><div class="label">Uptime</div><div style="font-weight:700">${(hoursPassed).toFixed(2)}h</div></div>
        </div>
        <div class="label">Projections</div>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><div class="win">${fmt(pPerHour)}</div><div class="usd-val">${usd(pPerHour)}</div></div>
            <div class="proj-card"><div class="label">Daily</div><div class="win">${fmt(pPerHour * 24)}</div><div class="usd-val">${usd(pPerHour * 24)}</div></div>
            <div class="proj-card"><div class="label">Monthly</div><div class="win">${fmt(pPerHour * 24 * 30)}</div><div class="usd-val">${usd(pPerHour * 24 * 30)}</div></div>
            <div class="proj-card"><div class="label">Yearly</div><div class="win">${fmt(pPerHour * 24 * 365)}</div><div class="usd-val">${usd(pPerHour * 24 * 365)}</div></div>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Base Unit</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Status</th></tr></thead>
            <tbody>
                ${botState.betHistory.map(b => `<tr><td>#${b.id}</td><td style="color:var(--primary)">${fmt(b.dynamicBase)}</td><td>${fmt(b.bet)}</td><td>${b.roll.toFixed(2)}</td><td class="${b.isWin ? 'win' : 'loss'}">${fmt(b.profit)}</td><td class="${b.isWin ? 'win' : 'loss'}"><strong>${b.isWin ? 'WIN' : 'LOSS'}</strong></td></tr>`).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>
    `);
});

loadState();
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Neat Dashboard Bot Online on port ${port}`);
    runStrategy();
});
