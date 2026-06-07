const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_KEY = process.env.API_KEY || "i57lk4i2fyabkEBmL5Kq4GiPZIg5WszlcTG6P9Y778UJtoaDmu";
const BASE_URL = "https://api.crypto.games/v1";

const DEFAULTS = {
    coin: "BTC",
    payout: 2.0,              
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
        lockPercent: 0.80 // Locking 80% of profit
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

function calculateScaledBase(balance) {
    const units = Math.floor(balance / DEFAULTS.balanceStep);
    return Number((Math.max(1, units) * DEFAULTS.betIncrement).toFixed(8));
}

function resetSession() {
    // UPDATED MESSAGE
    botState.statusMessage = "SYSTEM: SAFE FLOOR HIT: Locking Profits...";
    botState.profitProtection.safeBalance = botState.stats.currentBalance * 0.98; // Protect 98% of remaining on crash
    botState.recoveryPot = 0;
    botState.stats = {
        totalBets: 0, wins: 0, losses: 0, netProfit: botState.stats.netProfit, maxSessionProfit: 0,
        currentBalance: botState.stats.currentBalance,
        startTime: Date.now()
    };
    botState.betHistory = [];
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
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
    botState.statusMessage = "Linear Recovery Mode (80% Profit Lock)";
    
    while (true) {
        // Floor Auto-Reboot
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            resetSession();
            // UPDATED: Now waits for 5 seconds (5000ms)
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

        botState.betHistory.unshift({ 
            id: botState.stats.totalBets, time: new Date().toLocaleTimeString(), 
            bet: result.Bet, roll: result.Roll, profit: profit, isWin: profit > 0, 
            pot: botState.recoveryPot.toFixed(8), dBase: botState.settings.baseBet
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
    <title>Dice Pro v3.3 | 80% Lock</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card-bg: #ffffff; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; --success: #10b981; --danger: #ef4444; --accent: #f59e0b; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text-main); padding: 2rem; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
        .menu-tab { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 2px solid var(--border); padding-bottom: 0.5rem; }
        .menu-item { padding: 0.5rem 1rem; cursor: pointer; font-weight: 600; color: var(--text-muted); transition: all 0.3s; }
        .menu-item.active { color: var(--primary); border-bottom: 2px solid var(--primary); margin-bottom: -0.5rem; }
        .page { display: none; }
        .page.active-page { display: block; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem; }
        .btc-val { font-size: 1.75rem; font-weight: 700; }
        .usd-val { font-size: 0.875rem; color: var(--accent); }
        .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .mini-card { background: var(--card-bg); padding: 1rem; border-radius: 8px; border: 1px solid var(--border); text-align: center; }
        .proj-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
        .proj-card { background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: center; }
        table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
        th { background: #f8fafc; padding: 1rem; text-align: left; font-size: 0.75rem; color: var(--text-muted); }
        td { padding: 1rem; font-size: 0.875rem; border-bottom: 1px solid var(--border); font-family: monospace; }
        .win { color: var(--success); } .loss { color: var(--danger); }
        .status-bar { padding: 12px; background: #1e293b; color: white; border-radius: 8px; margin-bottom: 20px; font-weight: bold; font-size: 0.9rem; }
        .currency-selector { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--border); font-size: 1rem; margin-left: 1rem; }
        .wallet-display { font-size: 3rem; font-weight: 800; text-align: center; margin: 2rem 0; }
        .wallet-label { font-size: 1rem; text-transform: uppercase; letter-spacing: 2px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Dice Pro <span style="color:var(--primary)">v3.3</span></h1>
            <div style="text-align: right">
                <div class="label">Market BTC/USD</div>
                <div id="price-tag" style="font-weight: 700;">$0.00</div>
            </div>
        </div>
        
        <div class="menu-tab">
            <div class="menu-item active" onclick="showPage('dashboard')">📊 Dashboard</div>
            <div class="menu-item" onclick="showPage('wallet')">💰 Wallet Balance</div>
        </div>
        
        <div id="dashboard-page" class="page active-page">
            <div class="status-bar" id="status-msg">Status: Initializing...</div>
            <div class="grid">
                <div class="card"><div class="label">💳 Trading Balance</div><div id="t-bal" class="btc-val" style="color:var(--danger)">0.00</div><div id="t-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">💰 Wallet Balance</div><div id="w-bal" class="btc-val">0.00</div><div id="w-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="n-prof" class="btc-val">0.00</div><div id="n-usd" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot (Remaining)</div><div id="pot-display" class="btc-val" style="color:var(--primary)">0.00</div><div class="usd-val">Mode: 80% Profit Lock</div></div>
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
            <table>
                <thead><tr><th>ID</th><th>Base</th><th>Wager</th><th>Roll</th><th>Net (BTC)</th><th>Pot Remaining</th></tr></thead>
                <tbody id="h-body"></tbody>
            </table>
        </div>
        
        <div id="wallet-page" class="page">
            <div class="status-bar" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                💰 WALLET BALANCE - Select Currency Below
            </div>
            <div style="text-align: center; margin: 2rem 0;">
                <select id="currency-selector" class="currency-selector" onchange="updateWalletDisplay()">
                    <option value="BTC">₿ Bitcoin (BTC)</option>
                    <option value="LTC">Ł Litecoin (LTC)</option>
                    <option value="USD">$ US Dollar (USD)</option>
                    <option value="USDT">₮ Tether (USDT)</option>
                    <option value="EUR">€ Euro (EUR)</option>
                    <option value="GBP">£ Pound Sterling (GBP)</option>
                    <option value="ZAR">R South African Rand (ZAR)</option>
                </select>
            </div>
            <div class="card" style="text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
                <div class="wallet-label">YOUR WALLET BALANCE</div>
                <div class="wallet-display" id="wallet-display-main">0.00000000 BTC</div>
                <div style="font-size: 1.2rem; opacity: 0.9;" id="wallet-conversion-note">≈ $0.00 USD</div>
            </div>
            <div class="grid" style="margin-top: 2rem;">
                <div class="card"><div class="label">💳 Trading Balance</div><div id="wallet-trading-bal" class="btc-val">0.00</div><div id="wallet-trading-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">📈 Net Profit</div><div id="wallet-net-profit" class="btc-val">0.00</div><div id="wallet-profit-conv" class="usd-val">$0.00</div></div>
                <div class="card"><div class="label">⚖️ Recovery Pot</div><div id="wallet-recovery-pot" class="btc-val">0.00</div><div id="wallet-recovery-conv" class="usd-val">$0.00</div></div>
            </div>
        </div>
    </div>
    <script>
        let currentCurrency = 'BTC';
        const exchangeRates = {
            BTC: 1,
            LTC: 0.016,  // Approximate LTC to BTC rate
            USD: 60964,   // BTC to USD
            USDT: 60964,  // USDT to USD then to BTC
            EUR: 0.92,    // EUR to USD rate
            GBP: 0.79,    // GBP to USD rate
            ZAR: 18.5     // ZAR to USD rate
        };
        
        function convertToCurrency(btcAmount, currency) {
            if (currency === 'BTC') return btcAmount;
            const usdAmount = btcAmount * exchangeRates.USD;
            if (currency === 'USD') return usdAmount;
            if (currency === 'USDT') return usdAmount;
            if (currency === 'EUR') return usdAmount * exchangeRates.EUR;
            if (currency === 'GBP') return usdAmount * exchangeRates.GBP;
            if (currency === 'ZAR') return usdAmount * exchangeRates.ZAR;
            if (currency === 'LTC') return btcAmount / exchangeRates.LTC;
            return btcAmount;
        }
        
        function formatCurrency(amount, currency) {
            if (currency === 'BTC') return amount.toFixed(8) + ' BTC';
            if (currency === 'LTC') return amount.toFixed(8) + ' LTC';
            if (currency === 'USD') return '$' + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            if (currency === 'USDT') return '₮' + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            if (currency === 'EUR') return '€' + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            if (currency === 'GBP') return '£' + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            if (currency === 'ZAR') return 'R' + amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
            return amount.toString();
        }
        
        function updateWalletDisplay() {
            const selector = document.getElementById('currency-selector');
            if (selector) currentCurrency = selector.value;
            
            const walletBalanceRaw = parseFloat(document.getElementById('w-bal')?.innerText || 0);
            const tradingBalanceRaw = parseFloat(document.getElementById('t-bal')?.innerText || 0);
            const netProfitRaw = parseFloat(document.getElementById('n-prof')?.innerText || 0);
            const recoveryPotRaw = parseFloat(document.getElementById('pot-display')?.innerText || 0);
            
            const walletConverted = convertToCurrency(walletBalanceRaw, currentCurrency);
            const tradingConverted = convertToCurrency(tradingBalanceRaw, currentCurrency);
            const profitConverted = convertToCurrency(netProfitRaw, currentCurrency);
            const recoveryConverted = convertToCurrency(recoveryPotRaw, currentCurrency);
            
            const walletDisplayElem = document.getElementById('wallet-display-main');
            if (walletDisplayElem) walletDisplayElem.innerText = formatCurrency(walletConverted, currentCurrency);
            
            const tradingElem = document.getElementById('wallet-trading-bal');
            if (tradingElem) tradingElem.innerText = formatCurrency(tradingConverted, currentCurrency);
            
            const profitElem = document.getElementById('wallet-net-profit');
            if (profitElem) profitElem.innerText = formatCurrency(profitConverted, currentCurrency);
            
            const recoveryElem = document.getElementById('wallet-recovery-pot');
            if (recoveryElem) recoveryElem.innerText = formatCurrency(recoveryConverted, currentCurrency);
            
            const conversionNote = document.getElementById('wallet-conversion-note');
            if (conversionNote && currentCurrency !== 'BTC') {
                const btcValue = walletBalanceRaw;
                conversionNote.innerText = '≈ ' + btcValue.toFixed(8) + ' BTC';
            } else if (conversionNote) {
                const usdValue = convertToCurrency(walletBalanceRaw, 'USD');
                conversionNote.innerText = '≈ $' + usdValue.toLocaleString(undefined, {minimumFractionDigits: 2});
            }
            
            const tradingConv = document.getElementById('wallet-trading-conv');
            if (tradingConv && currentCurrency !== 'BTC') {
                const btcTrading = tradingBalanceRaw;
                tradingConv.innerText = '≈ ' + btcTrading.toFixed(8) + ' BTC';
            } else if (tradingConv) {
                const usdTrading = convertToCurrency(tradingBalanceRaw, 'USD');
                tradingConv.innerText = '≈ $' + usdTrading.toLocaleString(undefined, {minimumFractionDigits: 2});
            }
            
            const profitConv = document.getElementById('wallet-profit-conv');
            if (profitConv && currentCurrency !== 'BTC') {
                const btcProfit = netProfitRaw;
                profitConv.innerText = '≈ ' + btcProfit.toFixed(8) + ' BTC';
            } else if (profitConv) {
                const usdProfit = convertToCurrency(netProfitRaw, 'USD');
                profitConv.innerText = '≈ $' + usdProfit.toLocaleString(undefined, {minimumFractionDigits: 2});
            }
            
            const recoveryConv = document.getElementById('wallet-recovery-conv');
            if (recoveryConv && currentCurrency !== 'BTC') {
                const btcRecovery = recoveryPotRaw;
                recoveryConv.innerText = '≈ ' + btcRecovery.toFixed(8) + ' BTC';
            } else if (recoveryConv) {
                const usdRecovery = convertToCurrency(recoveryPotRaw, 'USD');
                recoveryConv.innerText = '≈ $' + usdRecovery.toLocaleString(undefined, {minimumFractionDigits: 2});
            }
        }
        
        function showPage(pageName) {
            document.querySelectorAll('.page').forEach(page => {
                page.classList.remove('active-page');
            });
            document.querySelectorAll('.menu-item').forEach(item => {
                item.classList.remove('active');
            });
            
            if (pageName === 'dashboard') {
                document.getElementById('dashboard-page').classList.add('active-page');
                document.querySelector('.menu-item:first-child').classList.add('active');
            } else if (pageName === 'wallet') {
                document.getElementById('wallet-page').classList.add('active-page');
                document.querySelector('.menu-item:last-child').classList.add('active');
                updateWalletDisplay();
            }
        }
        
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const { botState, btcPrice, hoursPassed } = await res.json();
                const f = (n) => parseFloat(n || 0).toFixed(8);
                const u = (n) => "$" + (parseFloat(n || 0) * btcPrice).toLocaleString(undefined, {minimumFractionDigits: 3});
                
                exchangeRates.USD = btcPrice;
                exchangeRates.USDT = btcPrice;
                
                document.getElementById('status-msg').innerText = "Status: " + botState.statusMessage;
                document.getElementById('price-tag').innerText = "$" + btcPrice.toLocaleString();
                document.getElementById('t-bal').innerText = f(botState.stats.currentBalance - botState.profitProtection.safeBalance);
                document.getElementById('t-usd').innerText = u(botState.stats.currentBalance - botState.profitProtection.safeBalance);
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

                document.getElementById('h-body').innerHTML = botState.betHistory.map(b => \`
                    <tr><td>#\${b.id}</td><td>\${f(b.dBase)}</td><td>\${f(b.bet)}</td><td>\${b.roll}</td><td class="\${b.isWin?'win':'loss'}">\${f(b.profit)}</td><td>\${b.pot} BTC</td></tr>
                \`).join('');
                
                if (document.getElementById('wallet-page').classList.contains('active-page')) {
                    updateWalletDisplay();
                }
            } catch(e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.listen(port, '0.0.0.0', () => runStrategy());
