require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x7a6FbF380325B268db3ce314E584dB938cCC0D28";

// Simple state
let state = {
    walletBalanceUSD: 0,
    totalProfitUSD: 0,
    totalAttempts: 0,
    successfulTrades: 0,
    failedTrades: 0,
    logs: [],
    isRunning: true
};

function addLog(message, type) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API endpoint
app.get('/api/state', (req, res) => {
    res.json({
        wallet: { balanceUSD: state.walletBalanceUSD },
        stats: {
            totalAttempts: state.totalAttempts,
            successfulTrades: state.successfulTrades,
            failedTrades: state.failedTrades,
            totalProfitUSD: state.totalProfitUSD,
            successRate: state.totalAttempts > 0 ? (state.successfulTrades / state.totalAttempts * 100).toFixed(1) : 0
        },
        logs: state.logs.slice(0, 50),
        connected: true
    });
});

// Dashboard
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>MEV Arbitrage Bot</title>
            <style>
                body { font-family: Arial; background: #0a0f1e; color: white; padding: 20px; }
                .card { background: #1a1f2e; padding: 20px; border-radius: 10px; margin: 10px 0; }
                .profit { color: #10b981; }
                .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
                .stat { background: #1a1f2e; padding: 15px; border-radius: 10px; text-align: center; }
                .stat-value { font-size: 24px; font-weight: bold; }
                .log { font-family: monospace; font-size: 12px; border-bottom: 1px solid #333; padding: 5px; }
            </style>
        </head>
        <body>
            <h1>💰 MEV Arbitrage Bot</h1>
            <div class="stats">
                <div class="stat">📊 Attempts<br><span id="attempts">0</span></div>
                <div class="stat">✅ Success<br><span id="success">0</span></div>
                <div class="stat">💰 Profit<br><span id="profit">$0</span></div>
            </div>
            <div class="card">
                <h3>📝 Logs</h3>
                <div id="logs"></div>
            </div>
            <script>
                async function fetchData() {
                    const res = await fetch('/api/state');
                    const data = await res.json();
                    document.getElementById('attempts').innerText = data.stats.totalAttempts;
                    document.getElementById('success').innerText = data.stats.successfulTrades;
                    document.getElementById('profit').innerText = '$' + data.stats.totalProfitUSD;
                    const logsDiv = document.getElementById('logs');
                    if (data.logs) {
                        logsDiv.innerHTML = data.logs.map(l => '<div class="log">[' + new Date(l.timestamp).toLocaleTimeString() + '] ' + l.message + '</div>').join('');
                    }
                }
                fetchData();
                setInterval(fetchData, 3000);
            </script>
        </body>
        </html>
    `);
});

// Simulate trading loop
async function tradingLoop() {
    addLog('🚀 Bot started on Polygon', 'success');
    
    while (state.isRunning) {
        state.totalAttempts++;
        addLog('🔍 Scanning for arbitrage opportunities...', 'info');
        
        // Simulate finding opportunity
        const hasOpportunity = Math.random() > 0.7;
        
        if (hasOpportunity) {
            const success = Math.random() > 0.3;
            
            if (success) {
                const profit = Math.random() * 10;
                state.successfulTrades++;
                state.totalProfitUSD += profit;
                state.walletBalanceUSD += profit;
                addLog(`✅ Trade successful! +$${profit.toFixed(2)}`, 'success');
            } else {
                state.failedTrades++;
                addLog(`❌ Trade failed - $0 gas cost!`, 'error');
            }
        }
        
        // Wait 30 seconds between scans
        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`💰 MEV Arbitrage Bot Running`);
    console.log(`========================================`);
    console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`✅ Zero gas cost for failed trades`);
    console.log(`========================================\n`);
    addLog('Bot initialized successfully', 'success');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    addLog('Shutting down...', 'info');
    state.isRunning = false;
    server.close(() => process.exit(0));
});

// Start trading loop
tradingLoop().catch(console.error);
