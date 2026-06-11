require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== STATE ====================
let state = {
    walletBalanceUSD: 0.00,
    startingBalanceUSD: 0.00,
    totalProfitUSD: 0.00,
    totalAttempts: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalGasPaidFromProfit: 0,
    opportunities: [],
    tradeHistory: [],
    logs: [],
    isRunning: true
};

// ==================== SIMULATION ====================
function addLog(message, type) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 50) state.logs.pop();
    console.log('[' + timestamp + '] ' + message);
}

// Simulate finding opportunities (for testing)
function findOpportunity() {
    const tokens = ['ADA', 'XRP', 'WBNB', 'DOGE', 'SHIB', 'CAKE'];
    const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
    const profitPercent = (Math.random() * 2).toFixed(2);
    return {
        token: randomToken,
        profitPercent: parseFloat(profitPercent),
        netProfit: parseFloat((profitPercent * 10).toFixed(2))
    };
}

// Simulate trade execution
async function executeTrade() {
    const opp = findOpportunity();
    state.totalAttempts++;
    
    addLog('📈 OPPORTUNITY: ' + opp.token + ' - ' + opp.profitPercent + '% profit', 'opportunity');
    
    // 70% success rate
    const success = Math.random() < 0.7;
    const gasCost = 0.63;
    
    if (success) {
        const profit = opp.netProfit;
        state.walletBalanceUSD += profit;
        state.totalProfitUSD += profit;
        state.successfulTrades++;
        state.totalGasPaidFromProfit += gasCost;
        
        addLog('✅ SUCCESS! +$' + profit.toFixed(2) + ' | New Balance: $' + state.walletBalanceUSD.toFixed(2), 'success');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: opp.token,
            profit: profit,
            success: true
        });
    } else {
        state.failedTrades++;
        addLog('❌ FAILED - ZERO COST! No gas fee paid.', 'error');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: opp.token,
            success: false
        });
    }
    
    if (state.tradeHistory.length > 20) state.tradeHistory.pop();
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    const profitLoss = state.walletBalanceUSD - state.startingBalanceUSD;
    
    res.json({
        wallet: {
            balanceUSD: state.walletBalanceUSD,
            profitLoss: profitLoss
        },
        stats: {
            totalAttempts: state.totalAttempts,
            successfulTrades: state.successfulTrades,
            failedTrades: state.failedTrades,
            totalGasPaidFromProfit: state.totalGasPaidFromProfit,
            totalProfitUSD: state.totalProfitUSD,
            successRate: state.totalAttempts > 0 ? (state.successfulTrades / state.totalAttempts * 100).toFixed(1) : 0
        },
        tradeHistory: state.tradeHistory.slice(0, 15),
        logs: state.logs.slice(0, 30)
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        walletBalanceUSD: 0.00,
        startingBalanceUSD: 0.00,
        totalProfitUSD: 0.00,
        totalAttempts: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasPaidFromProfit: 0,
        opportunities: [],
        tradeHistory: [],
        logs: [],
        isRunning: true
    };
    addLog('🔄 Bot reset. Starting fresh with $0 balance.', 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zero-Cost Flash Loan Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 25px; }
        h1 { font-size: 1.5rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; padding: 2px 10px; border-radius: 20px; font-size: 0.65rem; margin-left: 8px; }
        .zero-badge { background: #ef4444; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 14px; padding: 15px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.7rem; font-weight: 600; margin-bottom: 10px; color: #f0b90b; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 1.8rem; font-weight: bold; }
        .positive { color: #10b981; }
        .profit { color: #f0b90b; }
        .zero-cost { color: #10b981; }
        .scrollable { max-height: 280px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px 5px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; color: #0a0f1e; margin: 5px; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
        .log-entry { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.6rem; font-family: monospace; }
        .log-error { color: #ef4444; }
        .log-success { color: #10b981; }
        .log-opportunity { color: #f0b90b; }
        .log-info { color: #888; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Zero-Cost Flash Loan Bot <span class="badge">$0 CAPITAL</span><span class="badge zero-badge">$0 GAS FOR FAILURES</span></h1>
        <p class="text-small">No upfront capital | Zero cost for unsuccessful trades | Only pay gas from profits</p>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">💰 PROFIT (Wallet)</div>
            <div class="stat-value positive" id="balance">$0.00</div>
            <div>Total Profit: <span id="totalProfit">$0.00</span></div>
        </div>
        <div class="card">
            <div class="card-title">⚡ STATS</div>
            <div>Attempts: <span id="totalAttempts">0</span> | ✅ <span id="successTxs">0</span> | ❌ <span id="failedTxs">0</span></div>
            <div>Gas Paid: $<span id="gasPaid">0.00</span> (from profit only)</div>
            <div>Success Rate: <span id="successRate">0</span>%</div>
        </div>
        <div class="card">
            <div class="card-title">🎯 ZERO-COST GUARANTEE</div>
            <div class="zero-cost">✅ Failed trades: $0.00</div>
            <div class="zero-cost">✅ Flash loan capital: $0.00</div>
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">📋 TRADE HISTORY</div>
            <div class="scrollable">
                <table id="tradesTable">
                    <thead><tr><th>Time</th><th>Token</th><th>Result</th></tr></thead>
                    <tbody><tr><td colspan="3" class="text-center">No trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-title">📝 LIVE LOGS</div>
            <div class="scrollable" id="logsContainer">Initializing...</div>
        </div>
    </div>

    <div class="text-center mt-20">
        <button onclick="resetSimulation()">🔄 Reset</button>
        <button onclick="location.reload()">⟳ Refresh</button>
    </div>
</div>

<script>
    async function fetchState() {
        try {
            const response = await fetch('/api/state');
            const data = await response.json();
            
            document.getElementById('balance').innerHTML = '$' + (data.wallet?.balanceUSD || 0).toFixed(2);
            document.getElementById('totalProfit').innerHTML = '$' + (data.stats?.totalProfitUSD || 0).toFixed(2);
            document.getElementById('totalAttempts').innerHTML = data.stats?.totalAttempts || 0;
            document.getElementById('successTxs').innerHTML = data.stats?.successfulTrades || 0;
            document.getElementById('failedTxs').innerHTML = data.stats?.failedTrades || 0;
            document.getElementById('gasPaid').innerHTML = (data.stats?.totalGasPaidFromProfit || 0).toFixed(4);
            document.getElementById('successRate').innerHTML = data.stats?.successRate || 0;
            
            // Update trade history
            const tradesBody = document.querySelector('#tradesTable tbody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let i = 0; i < data.tradeHistory.length; i++) {
                    const t = data.tradeHistory[i];
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    if (t.success) {
                        html += '<tr><td>' + time + '</td><td>' + t.token + '</td><td class="positive">+$' + t.profit.toFixed(2) + '</td></tr>';
                    } else {
                        html += '<tr><td>' + time + '</td><td>' + t.token + '</td><td class="zero-cost">$0 (failed)</td></tr>';
                    }
                }
                tradesBody.innerHTML = html;
            } else {
                tradesBody.innerHTML = '<tr><td colspan="3" class="text-center">No trades yet</td></tr>';
            }
            
            // Update logs
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let html = '';
                for (let i = 0; i < data.logs.length; i++) {
                    const log = data.logs[i];
                    let logClass = 'log-info';
                    if (log.type === 'error') logClass = 'log-error';
                    else if (log.type === 'success') logClass = 'log-success';
                    else if (log.type === 'opportunity') logClass = 'log-opportunity';
                    html += '<div class="log-entry ' + logClass + '">[' + new Date(log.timestamp).toLocaleTimeString() + '] ' + log.message + '</div>';
                }
                logsContainer.innerHTML = html;
            } else {
                logsContainer.innerHTML = '<div class="log-entry log-info">Waiting for bot to start...</div>';
            }
        } catch (error) {
            console.error('Fetch error:', error);
            document.getElementById('logsContainer').innerHTML = '<div class="log-entry log-error">Error connecting to bot API. Make sure the bot is running.</div>';
        }
    }
    
    async function resetSimulation() {
        await fetch('/api/reset', { method: 'POST' });
        setTimeout(fetchState, 500);
    }
    
    fetchState();
    setInterval(fetchState, 2000);
</script>
</body>
</html>`;
    res.send(html);
});

// ==================== MAIN LOOP ====================
async function mainLoop() {
    addLog('🚀 ZERO-COST FLASH LOAN BOT STARTED', 'success');
    addLog('⚡ Simulating flash loan arbitrage...', 'info');
    
    while (state.isRunning) {
        await executeTrade();
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ ZERO-COST FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(60));
    console.log('\n💰 Starting Balance: $0.00');
    console.log('✅ Failed trades: $0.00 cost');
    console.log('🌐 Dashboard: http://localhost:' + PORT + '\n');
    
    addLog('Bot initializing...', 'info');
    
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', function() {
        console.log('Web dashboard running on http://localhost:' + PORT);
    });
}

start();
