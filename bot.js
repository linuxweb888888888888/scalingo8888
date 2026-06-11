require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== SIMULATED CONFIGURATION ====================
const SIM_CONFIG = {
    startingBalance: parseFloat(process.env.SIM_BALANCE || 2.00),
    scanIntervalMs: 3000,
    minProfitPercent: 0.3,
    gasFeeUSD: 0.48,
    slippagePercent: 0.5,
    pairs: [
        { name: 'BNB/BUSD', buyDex: 'PancakeSwap', sellDex: 'BiSwap', volatility: 0.02 },
        { name: 'CAKE/BNB', buyDex: 'ApeSwap', sellDex: 'PancakeSwap', volatility: 0.03 },
        { name: 'BUSD/USDT', buyDex: 'PancakeSwap', sellDex: 'Bakeryswap', volatility: 0.01 },
        { name: 'DOGE/BUSD', buyDex: 'PancakeSwap', sellDex: 'BiSwap', volatility: 0.04 },
        { name: 'SHIB/BUSD', buyDex: 'BiSwap', sellDex: 'PancakeSwap', volatility: 0.05 }
    ]
};

// ==================== SIMULATED STATE ====================
let state = {
    isRunning: true,
    balance: SIM_CONFIG.startingBalance,
    startingBalance: SIM_CONFIG.startingBalance,
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalGasSpent: 0,
    totalProfit: 0,
    tradeHistory: [],
    opportunitiesFound: 0,
    currentOpportunity: null,
    lastScanTime: Date.now(),
    logs: []
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, message, type: type || 'info' };
    state.logs.unshift(logEntry);
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

function findArbitrageOpportunity() {
    const chance = Math.random();
    if (chance < 0.1) {
        const pair = SIM_CONFIG.pairs[Math.floor(Math.random() * SIM_CONFIG.pairs.length)];
        const baseProfit = (Math.random() * pair.volatility * 100);
        const profitPercent = Math.max(0.1, Math.min(5, baseProfit));
        const tradeAmount = state.balance * 0.5;
        const grossProfit = tradeAmount * (profitPercent / 100);
        const netProfit = grossProfit - SIM_CONFIG.gasFeeUSD;
        
        return {
            found: true,
            pair: pair.name,
            buyDex: pair.buyDex,
            sellDex: pair.sellDex,
            profitPercent: profitPercent,
            grossProfit: grossProfit,
            netProfit: netProfit,
            tradeAmount: tradeAmount,
            timestamp: Date.now()
        };
    }
    return { found: false };
}

async function executeTrade(opportunity) {
    const { pair, buyDex, sellDex, profitPercent, grossProfit, netProfit, tradeAmount } = opportunity;
    
    addLog(`🚀 EXECUTING TRADE: ${pair}`, 'trade');
    addLog(`   Buy on ${buyDex} → Sell on ${sellDex}`, 'info');
    addLog(`   Trade Amount: $${tradeAmount.toFixed(2)}`, 'info');
    addLog(`   Expected Profit: ${profitPercent.toFixed(2)}% ($${grossProfit.toFixed(4)})`, 'info');
    addLog(`   Gas Fee: $${SIM_CONFIG.gasFeeUSD.toFixed(2)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(4)}`, 'info');
    
    state.totalGasSpent += SIM_CONFIG.gasFeeUSD;
    const success = Math.random() < 0.9;
    
    if (success && netProfit > 0) {
        state.balance += netProfit;
        state.totalProfit += netProfit;
        state.successfulTrades++;
        addLog(`✅ TRADE SUCCESSFUL! New Balance: $${state.balance.toFixed(4)}`, 'success');
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            pair: pair,
            type: 'BUY/SELL',
            amount: tradeAmount,
            profit: netProfit,
            success: true
        });
    } else {
        state.failedTrades++;
        addLog(`❌ TRADE FAILED! Lost gas fee: $${SIM_CONFIG.gasFeeUSD.toFixed(2)}`, 'error');
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            pair: pair,
            type: 'FAILED',
            amount: tradeAmount,
            loss: SIM_CONFIG.gasFeeUSD,
            success: false
        });
    }
    state.totalTrades++;
    if (state.tradeHistory.length > 50) state.tradeHistory.pop();
}

async function simulationLoop() {
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            const opportunity = findArbitrageOpportunity();
            
            if (opportunity.found) {
                state.opportunitiesFound++;
                addLog(`📈 OPPORTUNITY #${state.opportunitiesFound}: ${opportunity.pair} (${opportunity.profitPercent.toFixed(2)}% profit potential)`, 'opportunity');
                
                if (opportunity.netProfit > 0 && state.balance >= (opportunity.tradeAmount + SIM_CONFIG.gasFeeUSD)) {
                    await executeTrade(opportunity);
                } else if (opportunity.netProfit <= 0) {
                    addLog(`   ⏭️ Skipping: Net profit too low ($${opportunity.netProfit.toFixed(4)})`, 'warning');
                } else {
                    addLog(`   ⏭️ Skipping: Insufficient balance (Need $${(opportunity.tradeAmount + SIM_CONFIG.gasFeeUSD).toFixed(2)})`, 'warning');
                }
            }
            
            if (state.balance < 0.10) {
                addLog(`🛑 Simulation stopped: Balance below $0.10`, 'error');
                state.isRunning = false;
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, SIM_CONFIG.scanIntervalMs));
        } catch (error) {
            addLog(`Error in simulation loop: ${error.message}`, 'error');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// ==================== EXPRESS API ====================
app.get('/api/state', (req, res) => {
    const profitLoss = state.balance - state.startingBalance;
    const profitPercent = (profitLoss / state.startingBalance) * 100;
    
    res.json({
        isRunning: state.isRunning,
        balance: state.balance,
        startingBalance: state.startingBalance,
        profitLoss: profitLoss,
        profitPercent: profitPercent,
        totalTrades: state.totalTrades,
        successfulTrades: state.successfulTrades,
        failedTrades: state.failedTrades,
        totalGasSpent: state.totalGasSpent,
        totalProfit: state.totalProfit,
        opportunitiesFound: state.opportunitiesFound,
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        config: {
            startingBalance: SIM_CONFIG.startingBalance,
            gasFeeUSD: SIM_CONFIG.gasFeeUSD,
            scanIntervalMs: SIM_CONFIG.scanIntervalMs,
            minProfitPercent: SIM_CONFIG.minProfitPercent
        }
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        isRunning: true,
        balance: SIM_CONFIG.startingBalance,
        startingBalance: SIM_CONFIG.startingBalance,
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasSpent: 0,
        totalProfit: 0,
        tradeHistory: [],
        opportunitiesFound: 0,
        currentOpportunity: null,
        lastScanTime: Date.now(),
        logs: []
    };
    addLog(`🔄 Simulation reset. Starting balance: $${SIM_CONFIG.startingBalance}`, 'info');
    res.json({ status: 'reset', balance: SIM_CONFIG.startingBalance });
});

// ==================== HTML DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PancakeSwap Arbitrage Simulator</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 2rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.2); }
        .card-title { font-size: 1rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; }
        .stat-value { font-size: 1.8rem; font-weight: bold; margin: 10px 0; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .neutral { color: #f0b90b; }
        table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .log-entry { font-family: monospace; font-size: 0.7rem; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        button { background: #f0b90b; border: none; padding: 8px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; margin: 5px; }
        button:hover { background: #ffd700; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
        .running { animation: pulse 2s infinite; }
        .scrollable { max-height: 300px; overflow-y: auto; }
        .text-small { font-size: 0.7rem; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>PancakeSwap Arbitrage Simulator</h1>
            <p class="text-small">Realistic simulation with fake money | No crypto or wallet needed</p>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">BALANCE</div>
                <div class="stat-value" id="balance">$0.00</div>
                <div>P&L: <span id="pnl" class="positive">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
            </div>
            <div class="card">
                <div class="card-title">TRADES</div>
                <div>Total: <span id="totalTrades">0</span></div>
                <div>Successful: <span id="successTrades">0</span> | Failed: <span id="failedTrades">0</span></div>
                <div>Opportunities Found: <span id="opportunities">0</span></div>
            </div>
            <div class="card">
                <div class="card-title">GAS & FEES</div>
                <div>Total Gas Spent: $<span id="gasSpent">0.00</span></div>
                <div>Gas per Trade: $0.48 (simulated)</div>
                <div>Status: <span id="status" class="running">RUNNING</span></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">RECENT TRADES</div>
                <div class="scrollable">
                    <table id="tradesTable">
                        <thead><tr><th>Time</th><th>Pair</th><th>Profit/Loss</th></tr></thead>
                        <tbody><tr><td colspan="3" class="text-center">No trades yet</td></tr></tbody>
                    </table>
                </div>
            </div>
            <div class="card">
                <div class="card-title">LIVE LOGS</div>
                <div class="scrollable" id="logsContainer" style="font-family: monospace; font-size: 0.7rem;">Waiting for simulation...</div>
            </div>
        </div>

        <div class="text-center mt-20">
            <button onclick="resetSimulation()">Reset Simulation</button>
            <button onclick="location.reload()">Refresh</button>
        </div>

        <div class="text-center mt-20 text-small" style="opacity: 0.7;">
            <p>This is a SIMULATION. No real money is used, no blockchain transactions occur.</p>
            <p>The bot simulates finding arbitrage opportunities and executing trades with realistic gas fees.</p>
        </div>
    </div>

    <script>
        async function fetchState() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                document.getElementById('balance').innerHTML = '$' + data.balance.toFixed(4);
                const pnl = data.profitLoss;
                const pnlPercent = data.profitPercent;
                document.getElementById('pnl').innerHTML = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(4);
                document.getElementById('pnlPercent').innerHTML = (pnlPercent >= 0 ? '+' : '') + pnlPercent.toFixed(2) + '%';
                document.getElementById('pnl').className = pnl >= 0 ? 'positive' : 'negative';
                document.getElementById('totalTrades').innerHTML = data.totalTrades;
                document.getElementById('successTrades').innerHTML = data.successfulTrades;
                document.getElementById('failedTrades').innerHTML = data.failedTrades;
                document.getElementById('opportunities').innerHTML = data.opportunitiesFound;
                document.getElementById('gasSpent').innerHTML = data.totalGasSpent.toFixed(4);
                document.getElementById('status').innerHTML = data.isRunning ? 'RUNNING' : 'STOPPED';
                
                const tradesBody = document.getElementById('tradesTable').querySelector('tbody');
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    let html = '';
                    for (let i = 0; i < data.tradeHistory.length; i++) {
                        const t = data.tradeHistory[i];
                        const profit = t.profit || (t.loss ? -t.loss : 0);
                        const profitClass = profit >= 0 ? 'positive' : 'negative';
                        const profitSign = profit >= 0 ? '+' : '';
                        html += '<tr><td>' + new Date(t.timestamp).toLocaleTimeString() + '</td>';
                        html += '<td>' + (t.pair || 'N/A') + '</td>';
                        html += '<td class="' + profitClass + '">' + profitSign + '$' + Math.abs(profit).toFixed(6) + '</td></tr>';
                    }
                    tradesBody.innerHTML = html;
                } else {
                    tradesBody.innerHTML = '<tr><td colspan="3" class="text-center">No trades yet</td></tr>';
                }
                
                const logsContainer = document.getElementById('logsContainer');
                if (data.logs && data.logs.length > 0) {
                    let logsHtml = '';
                    for (let i = 0; i < data.logs.length; i++) {
                        const log = data.logs[i];
                        let color = '#888';
                        if (log.type === 'error') color = '#ef4444';
                        else if (log.type === 'success') color = '#10b981';
                        else if (log.type === 'opportunity') color = '#f0b90b';
                        logsHtml += '<div style="color: ' + color + '; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0;">';
                        logsHtml += '[' + new Date(log.timestamp).toLocaleTimeString() + '] ' + log.message;
                        logsHtml += '</div>';
                    }
                    logsContainer.innerHTML = logsHtml;
                } else {
                    logsContainer.innerHTML = '<div>Waiting for simulation...</div>';
                }
            } catch(e) {
                console.error(e);
            }
        }
        
        async function resetSimulation() {
            await fetch('/api/reset', { method: 'POST' });
            setTimeout(fetchState, 500);
        }
        
        fetchState();
        setInterval(fetchState, 1000);
    </script>
</body>
</html>
    `);
});

// ==================== START THE BOT ====================
console.log('\n============================================================');
console.log('PancakeSwap Arbitrage Simulator');
console.log('============================================================');
console.log(`\nSimulator Started`);
console.log(`Starting Balance: $${SIM_CONFIG.startingBalance}`);
console.log(`Simulated Gas Fee per Trade: $${SIM_CONFIG.gasFeeUSD}`);
console.log(`Scan Interval: ${SIM_CONFIG.scanIntervalMs}ms`);
console.log(`Dashboard: http://localhost:${PORT}`);
console.log(`\nThis is a SIMULATION - No real money or blockchain transactions\n`);

simulationLoop().catch(console.error);
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Web dashboard running on port ${PORT}`);
});
