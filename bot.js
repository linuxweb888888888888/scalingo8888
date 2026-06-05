const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
// Scalingo dynamic port handling
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "pGajBYIXPZUBfph1gfif9TrtJSTKtXG3Drxfs7iTtCc2mwj8kx";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    multiplier: 1.2,          
    payout: 2.0,              
    balanceStep: 0.00000050,  
    betIncrement: 0.00000001  
};

// ============ BOT STATE ============
let btcPrice = 65000; 
let botState = {
    running: false,
    coin: DEFAULTS.coin,
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
        if (res.data.bitcoin.usd) btcPrice = res.data.bitcoin.usd;
    } catch (e) {}
}
setInterval(updateBTCPrice, 60000);
updateBTCPrice();

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    const calculatedBase = Math.max(1, units) * DEFAULTS.betIncrement;
    return Number(calculatedBase.toFixed(8));
}

// State persistence (Ephemeral on Scalingo unless volume is attached)
function saveState() {
    try { fs.writeFileSync('/tmp/bot-state.json', JSON.stringify(botState, null, 2)); } catch (e) {}
}

function loadState() {
    if (fs.existsSync('/tmp/bot-state.json')) {
        try {
            const data = JSON.parse(fs.readFileSync('/tmp/bot-state.json'));
            botState.profitProtection = data.profitProtection || { safeBalance: 0 };
        } catch(e) {}
    }
}

// ============ API LOGIC ============
async function placeBet() {
    const url = `${BASE_URL}/placebet/${botState.coin}/${API_KEY}`;
    const randomSuffix = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').substring(0, 8);
    const payload = { 
        Bet: botState.settings.currentBet, 
        Payout: botState.settings.payout, 
        UnderOver: true, 
        ClientSeed: "node20_" + randomSuffix 
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
        if (!result) { await new Promise(r => setTimeout(r, 5000)); continue; }

        botState.stats.totalBets++;
        const profit = result.Profit || 0;
        botState.stats.netProfit += profit;
        botState.stats.currentBalance = result.Balance || 0;

        // Apply Absolute Scaling logic
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);

        if (profit > 0) {
            botState.stats.wins++;
            botState.profitProtection.safeBalance += (profit * 0.50); 
            botState.settings.currentBet = botState.settings.baseBet;
        } else {
            botState.stats.losses++;
            // Martingale 1.2x
            botState.settings.currentBet = Number((botState.settings.currentBet * botState.settings.multiplier).toFixed(8));
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
    const hoursPassed = msPassed / (1000 * 60 * 60) || 0.0001;
    const pPerHour = botState.stats.netProfit / hoursPassed;
    const winRate = botState.stats.totalBets > 0 ? ((botState.stats.wins / botState.stats.totalBets) * 100).toFixed(1) : 0;

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dice Pro | Node 20</title>
    <meta http-equiv="refresh" content="5">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%); color: #00ff88; padding: 20px; min-height: 100vh; }
        .container { max-width: 1300px; margin: 0 auto; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .card { background: rgba(26, 31, 58, 0.95); padding: 20px; border-radius: 15px; border: 1px solid rgba(0, 255, 136, 0.2); text-align: center; }
        .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        .btc-val { font-size: 22px; font-weight: bold; margin: 5px 0; display: block; }
        .usd-val { font-size: 14px; color: #ffaa00; }
        .safe-card { border: 2px solid #ff6600; background: rgba(255, 102, 0, 0.05); }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-top: 20px; }
        .proj-card { background: rgba(10, 14, 39, 0.7); border: 1px dashed #00ff8844; padding: 15px; border-radius: 12px; text-align: center; }
        .win { color: #00ff88; } .loss { color: #ff4444; }
        table { width: 100%; border-collapse: collapse; margin-top: 30px; font-size: 12px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .live-dot { height: 10px; width: 10px; background-color: #00ff88; border-radius: 50%; display: inline-block; animation: pulse 1s infinite; margin-right: 5px; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
    </style>
</head>
<body>
    <div class="container">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:30px;">
            <h1><span class="live-dot"></span> DICE PRO: NODE 20 SCALING</h1>
            <div style="text-align:right"><div class="label">BTC PRICE</div><div style="color:#ffaa00; font-weight:bold;">$${btcPrice.toLocaleString()}</div></div>
        </div>
        <div class="grid">
            <div class="card safe-card"><div class="label">🔒 Protected Profit (50%)</div><span class="btc-val" style="color:#ffaa00">${fmt(botState.profitProtection.safeBalance)}</span><span class="usd-val">${usd(botState.profitProtection.safeBalance)}</span></div>
            <div class="card"><div class="label">💰 Balance</div><span class="btc-val">${fmt(botState.stats.currentBalance)}</span><span class="usd-val">${usd(botState.stats.currentBalance)}</span></div>
            <div class="card"><div class="label">📊 Net Profit</div><span class="btc-val ${botState.stats.netProfit >= 0 ? 'win' : 'loss'}">${fmt(botState.stats.netProfit)}</span><span class="usd-val">${usd(botState.stats.netProfit)}</span></div>
            <div class="card"><div class="label">🎯 Next Bet</div><span class="btc-val">${fmt(botState.settings.currentBet)}</span><span class="usd-val">${usd(botState.settings.currentBet)}</span></div>
        </div>
        <div class="grid">
            <div class="card"><div class="label">Win Rate</div><div class="btc-val">${winRate}%</div></div>
            <div class="card"><div class="label">Total Bets</div><div class="btc-val">${botState.stats.totalBets}</div></div>
            <div class="card"><div class="label">Scaled Base</div><div class="btc-val" style="color:#00ccff">${fmt(botState.settings.baseBet)}</div></div>
            <div class="card"><div class="label">Uptime</div><div class="btc-val">${(hoursPassed).toFixed(2)}h</div></div>
        </div>
        <h3 style="margin:30px 0 15px 0; color:#888; font-size:14px; text-transform:uppercase;">📈 Profit Projections</h3>
        <div class="proj-grid">
            <div class="proj-card"><div class="label">Hourly</div><div class="win">${fmt(pPerHour)}</div><div class="usd-val">${usd(pPerHour)}</div></div>
            <div class="proj-card"><div class="label">Daily</div><div class="win">${fmt(pPerHour * 24)}</div><div class="usd-val">${usd(pPerHour * 24)}</div></div>
            <div class="proj-card"><div class="label">Monthly</div><div class="win">${fmt(pPerHour * 24 * 30)}</div><div class="usd-val">${usd(pPerHour * 24 * 30)}</div></div>
            <div class="proj-card"><div class="label">Yearly</div><div class="win">${fmt(pPerHour * 24 * 365)}</div><div class="usd-val">${usd(pPerHour * 24 * 365)}</div></div>
        </div>
        <table>
            <thead><tr><th>#</th><th>Base Used</th><th>Bet Amount</th><th>Roll</th><th>Profit BTC</th><th>Result</th></tr></thead>
            <tbody>
                ${botState.betHistory.map(b => `<tr><td>${b.id}</td><td style="color:#00ccff">${fmt(b.dynamicBase)}</td><td>${fmt(b.bet)}</td><td>${b.roll.toFixed(2)}</td><td class="${b.isWin ? 'win' : 'loss'}">${fmt(b.profit)}</td><td class="${b.isWin ? 'win' : 'loss'}"><b>${b.isWin ? 'WIN' : 'LOSS'}</b></td></tr>`).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>
    `);
});

// ============ RUN ============
loadState();
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Node 20 Bot Online on port ${port}`);
    runStrategy();
});
