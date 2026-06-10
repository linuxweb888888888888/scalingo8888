const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const API_URL = "https://api.paradice.in/api.php";
const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJwYXJhZGljZS5pbiIsImF1ZCI6InBhcmFkaWNlLmluIiwiaWF0IjoxNzgxMDc0MTk3LCJuYmYiOjE3ODEwNzQxOTcsImRhdGEiOnsiaWQiOiIzMjc1NzIiLCJsb2dpbiI6IndlYndlYjg4ODgiLCJrZXkiOiJQZ0Z4WUhnMkk2bFpRVVM2aU1MUVRjaWxTaTFqMjR6TyJ9fQ.xX9ZnJlxNF8PIPFuhUHasX7LM9EyIClBzqO0sTN_2RljA6plqjVGG0dwkkxv88NlrvVY4t1guKUuLHGH8rPDCpZiX6RfpBRx_5dqBijcQBi0HY_ZmfR_oNH8wSs9Fft6iABBVbpUWc2vmpTvxeu47rFEZDidXDFcMKrXsNPSWGbigGpVmxfxqWKd9iDINhIpi_fV7RJeGiSyDpd-dwZaagMXZhyrAYX7erTM93h91eogyNaGmPI_4HkDeZf_2HRLhOQqM4DC29pe-oQBiRM4aRNpoz59MOi6_HNNtd1K0m4Um4IEJPLLHj4sespPRdQjc9l8K44pkejkALsOxve0NA";

const DEFAULTS = {
    currency: "BTC",
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
    betHistory: []
};

// ============ GRAPHQL QUERIES ============
const GRAPHQL_QUERIES = {
    getMe: `
        query GetMe {
            me {
                id
                login
                wallets {
                    currency
                    balance
                    bonus
                }
            }
        }
    `,
    
    rollDice: `
        mutation RollDice($number: Float!, $betAmount: Float!, $side: RollSideEnum!, $currency: CurrencyEnum!) {
            rollDice(number: $number, betAmount: $betAmount, side: $side, currency: $currency) {
                id
                date
                betAmount
                winAmount
                roll
                win
                multiplier
                chance
                user {
                    id
                    login
                    wallets {
                        currency
                        balance
                    }
                }
            }
        }
    `
};

// ============ GRAPHQL REQUEST FUNCTION WITH MULTIPLE AUTH METHODS ============
async function graphqlRequest(query, variables = {}, retryCount = 0) {
    // Try different authentication methods
    const authMethods = [
        { name: 'Bearer', headers: { 'Authorization': `Bearer ${API_KEY}` } },
        { name: 'API-Key', headers: { 'API-Key': API_KEY } },
        { name: 'X-API-Key', headers: { 'X-API-Key': API_KEY } },
        { name: 'Token', headers: { 'Token': API_KEY } }
    ];
    
    const method = authMethods[retryCount % authMethods.length];
    
    try {
        const response = await axios.post(API_URL, {
            query: query,
            variables: variables
        }, {
            headers: {
                'Content-Type': 'application/json',
                ...method.headers
            }
        });
        
        if (response.data.errors) {
            // Check if it's an auth error
            const isAuthError = response.data.errors.some(e => 
                e.message?.toLowerCase().includes('unauthorized') || 
                e.message?.toLowerCase().includes('authentication')
            );
            
            if (isAuthError && retryCount < authMethods.length * 2) {
                console.log(`Auth method "${method.name}" failed, trying next method...`);
                return graphqlRequest(query, variables, retryCount + 1);
            }
            
            console.error("GraphQL Errors:", JSON.stringify(response.data.errors, null, 2));
            return null;
        }
        
        if (retryCount > 0) {
            console.log(`Successfully authenticated with method: ${method.name}`);
        }
        
        return response.data.data;
    } catch (error) {
        console.error(`Request Error (${method.name}):`, error.message);
        if (error.response) {
            console.error("Response status:", error.response.status);
            console.error("Response headers:", error.response.headers);
        }
        
        if (retryCount < authMethods.length * 2) {
            return graphqlRequest(query, variables, retryCount + 1);
        }
        return null;
    }
}

// ============ TEST AUTHENTICATION ON STARTUP ============
async function testAuthentication() {
    console.log("Testing authentication to Paradice.in API...");
    const result = await graphqlRequest(GRAPHQL_QUERIES.getMe);
    
    if (result?.me) {
        console.log("✅ Authentication successful!");
        console.log(`Logged in as: ${result.me.login}`);
        console.log(`User ID: ${result.me.id}`);
        if (result.me.wallets) {
            result.me.wallets.forEach(w => {
                console.log(`${w.currency}: ${w.balance} (Bonus: ${w.bonus})`);
            });
        }
        return true;
    } else {
        console.error("❌ Authentication failed! Please check your API key.");
        console.error("The API key might be expired or invalid for this endpoint.");
        return false;
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

async function getCurrentBalance() {
    const result = await graphqlRequest(GRAPHQL_QUERIES.getMe);
    if (result?.me?.wallets) {
        const btcWallet = result.me.wallets.find(w => w.currency === DEFAULTS.currency);
        return btcWallet ? parseFloat(btcWallet.balance) : 0;
    }
    return 0;
}

function resetSession() {
    botState.statusMessage = "SYSTEM: SAFE FLOOR HIT: Locking Profits...";
    botState.profitProtection.safeBalance = botState.stats.currentBalance * 0.98;
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

// ============ PLACE BET ============
async function placeBet() {
    const targetNumber = 50;
    const side = "BELOW";
    
    const variables = {
        number: targetNumber,
        betAmount: Number(botState.settings.currentBet.toFixed(8)),
        side: side,
        currency: DEFAULTS.currency
    };
    
    const result = await graphqlRequest(GRAPHQL_QUERIES.rollDice, variables);
    
    if (result?.rollDice) {
        const betResult = result.rollDice;
        const profit = betResult.win ? betResult.winAmount - betResult.betAmount : -betResult.betAmount;
        
        return {
            success: true,
            id: betResult.id,
            betAmount: parseFloat(betResult.betAmount),
            winAmount: parseFloat(betResult.winAmount),
            roll: betResult.roll,
            win: betResult.win,
            profit: profit,
            multiplier: betResult.multiplier,
            newBalance: betResult.user?.wallets?.[0]?.balance ? parseFloat(betResult.user.wallets[0].balance) : null
        };
    }
    
    return null;
}

// ============ MAIN STRATEGY ============
async function runStrategy() {
    // First test authentication
    const isAuthenticated = await testAuthentication();
    if (!isAuthenticated) {
        console.error("Cannot start bot - authentication failed!");
        botState.statusMessage = "AUTHENTICATION FAILED - Check API Key";
        return;
    }
    
    console.log("Starting bot with API URL:", API_URL);
    botState.statusMessage = "Linear Recovery Mode (80% Profit Lock) - Paradice.in";
    
    // Initial balance fetch
    botState.stats.currentBalance = await getCurrentBalance();
    botState.profitProtection.safeBalance = botState.stats.currentBalance * 0.98;
    botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
    botState.settings.currentBet = botState.settings.baseBet;
    
    console.log(`Starting balance: ${botState.stats.currentBalance} BTC`);
    console.log(`Safe balance: ${botState.profitProtection.safeBalance} BTC`);
    console.log(`Base bet: ${botState.settings.baseBet} BTC`);
    
    while (true) {
        // Update balance periodically
        if (botState.stats.totalBets % 10 === 0) {
            const freshBalance = await getCurrentBalance();
            if (freshBalance > 0) {
                botState.stats.currentBalance = freshBalance;
            }
        }
        
        // Check safe floor
        if (botState.stats.totalBets > 0 && botState.stats.currentBalance <= botState.profitProtection.safeBalance) {
            console.log("Safe floor hit! Resetting...");
            resetSession();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const result = await placeBet();
        if (!result) {
            botState.statusMessage = "API Error - Retrying...";
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        botState.stats.totalBets++;
        const profit = result.profit;
        botState.stats.netProfit += profit;
        
        if (result.newBalance) {
            botState.stats.currentBalance = result.newBalance;
        } else {
            botState.stats.currentBalance += profit;
        }
        
        if (botState.stats.netProfit > botState.stats.maxSessionProfit) {
            botState.stats.maxSessionProfit = botState.stats.netProfit;
        }
        
        botState.settings.baseBet = calculateScaledBase(botState.stats.currentBalance);
        
        if (result.win) {
            botState.stats.wins++;
            botState.recoveryPot -= profit;
            if (botState.recoveryPot < 0) botState.recoveryPot = 0;
            
            if (botState.recoveryPot === 0) {
                botState.settings.currentBet = botState.settings.baseBet;
                botState.profitProtection.safeBalance += (profit * 0.80);
                console.log(`WIN! +${profit.toFixed(8)} | New safe: ${botState.profitProtection.safeBalance.toFixed(8)}`);
            } else {
                console.log(`WIN! +${profit.toFixed(8)} | Pot: ${botState.recoveryPot.toFixed(8)}`);
            }
        } else {
            botState.stats.losses++;
            botState.recoveryPot += Math.abs(profit);
            botState.settings.currentBet += DEFAULTS.betIncrement;
            console.log(`LOSS! -${Math.abs(profit).toFixed(8)} | Next bet: ${botState.settings.currentBet.toFixed(8)} | Pot: ${botState.recoveryPot.toFixed(8)}`);
        }
        
        botState.betHistory.unshift({
            id: botState.stats.totalBets,
            time: new Date().toLocaleTimeString(),
            bet: result.betAmount,
            roll: result.roll,
            profit: profit,
            isWin: result.win,
            pot: botState.recoveryPot.toFixed(8),
            dBase: botState.settings.baseBet
        });
        if (botState.betHistory.length > 30) botState.betHistory.pop();
        
        const winRate = botState.stats.totalBets > 0 ? (botState.stats.wins / botState.stats.totalBets * 100).toFixed(1) : 0;
        botState.statusMessage = `Running | Balance: ${botState.stats.currentBalance.toFixed(8)} BTC | Profit: ${botState.stats.netProfit.toFixed(8)} | WR: ${winRate}% | Next: ${botState.settings.currentBet.toFixed(8)}`;
        
        await new Promise(r => setTimeout(r, 1100));
    }
}

// ============ WEB SERVER ============
app.get('/api/stats', (req, res) => {
    const hours = Math.max(0.0001, (Date.now() - botState.stats.startTime) / 3600000);
    res.json({ botState, btcPrice, hoursPassed: hours.toFixed(2) });
});

app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dice Bot | Paradice.in</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        .status { background: #1a1a2e; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #00ff88; font-family: monospace; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .card { background: #1a1a2e; padding: 20px; border-radius: 8px; }
        .label { font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 5px; }
        .value { font-size: 24px; font-weight: bold; }
        .win { color: #00ff88; }
        .loss { color: #ff4444; }
        table { width: 100%; background: #1a1a2e; border-radius: 8px; overflow: hidden; }
        th { background: #16213e; padding: 12px; text-align: left; font-size: 12px; }
        td { padding: 10px 12px; border-bottom: 1px solid #2a2a3e; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎲 Dice Bot <span style="color:#00ff88">v3.3</span></h1>
            <p>Paradice.in | 80% Profit Lock Strategy</p>
        </div>
        <div class="status" id="statusMsg">Loading...</div>
        <div class="grid">
            <div class="card"><div class="label">💰 Balance</div><div class="value" id="balance">0.00</div><div id="balanceUsd" style="color:#888"></div></div>
            <div class="card"><div class="label">📈 Net Profit</div><div class="value" id="profit">0.00</div><div id="profitUsd" style="color:#888"></div></div>
            <div class="card"><div class="label">⚡ Win Rate</div><div class="value" id="winRate">0%</div></div>
            <div class="card"><div class="label">🎯 Next Bet</div><div class="value" id="nextBet">0.00</div></div>
        </div>
        <div class="grid">
            <div class="card"><div class="label">🛡️ Safe Balance</div><div class="value" id="safeBalance">0.00</div></div>
            <div class="card"><div class="label">📦 Recovery Pot</div><div class="value" id="recoveryPot">0.00</div></div>
            <div class="card"><div class="label">📊 Total Bets</div><div class="value" id="totalBets">0</div></div>
            <div class="card"><div class="label">⏱️ Uptime</div><div class="value" id="uptime">0h</div></div>
        </div>
        <h3>Recent Bets</h3>
        <table>
            <thead>
                <tr><th>#</th><th>Wager</th><th>Roll</th><th>Profit</th><th>Pot</th></tr>
            </thead>
            <tbody id="betTable"></tbody>
        </table>
    </div>
    <script>
        async function update() {
            try {
                const res = await fetch('/api/stats');
                const data = await res.json();
                const btcPrice = data.btcPrice;
                const s = data.botState;
                
                document.getElementById('statusMsg').innerHTML = '🔵 ' + s.statusMessage;
                document.getElementById('balance').innerHTML = s.stats.currentBalance.toFixed(8) + ' BTC';
                document.getElementById('balanceUsd').innerHTML = '$' + (s.stats.currentBalance * btcPrice).toLocaleString();
                document.getElementById('profit').innerHTML = (s.stats.netProfit > 0 ? '+' : '') + s.stats.netProfit.toFixed(8);
                document.getElementById('profitUsd').innerHTML = '$' + (s.stats.netProfit * btcPrice).toLocaleString();
                document.getElementById('winRate').innerHTML = ((s.stats.wins/s.stats.totalBets)*100 || 0).toFixed(1) + '%';
                document.getElementById('nextBet').innerHTML = s.settings.currentBet.toFixed(8) + ' BTC';
                document.getElementById('safeBalance').innerHTML = s.profitProtection.safeBalance.toFixed(8);
                document.getElementById('recoveryPot').innerHTML = s.recoveryPot.toFixed(8);
                document.getElementById('totalBets').innerHTML = s.stats.totalBets;
                document.getElementById('uptime').innerHTML = data.hoursPassed + 'h';
                
                let tableHtml = '';
                for (let i = 0; i < s.betHistory.length; i++) {
                    const b = s.betHistory[i];
                    const profitClass = b.isWin ? 'win' : 'loss';
                    const profitSign = b.profit > 0 ? '+' : '';
                    tableHtml += '<tr>' +
                        '<td>#' + b.id + '</td>' +
                        '<td>' + b.bet.toFixed(8) + '</td>' +
                        '<td>' + b.roll + '</td>' +
                        '<td class="' + profitClass + '">' + profitSign + b.profit.toFixed(8) + '</td>' +
                        '<td>' + b.pot + '</td>' +
                        '</tr>';
                }
                document.getElementById('betTable').innerHTML = tableHtml;
            } catch(e) { console.error(e); }
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `;
    res.send(html);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    console.log(`Web dashboard available at http://localhost:${port}`);
    runStrategy();
});
