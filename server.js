const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION (RPC HARDCODED) ---
const RPC_URL = "https://polygon-rpc.com"; 
const ROUTER_ADDRESS = "0xa5E0829CaCEd8fFDD03942104b105c07C8510ed5"; // QuickSwap

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

const ROUTER_ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];

// --- BOT STATE ---
let botState = {
    isRunning: false,
    virtualBalance: 100.00, 
    totalVirtualProfit: 0.00,
    lastSpread: "0.00%",
    history: [],
    error: null
};

// --- INITIALIZE ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

// --- SIMULATION ENGINE ---
async function runSimulation() {
    if (!botState.isRunning) return;

    try {
        // Path: WMATIC -> USDC -> USDT -> WMATIC
        const path = [TOKENS.WMATIC, TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC];
        const tradeSize = ethers.parseEther("10"); // Simulating 10 MATIC per trade

        // Fetch real market prices
        const amounts = await router.getAmountsOut(tradeSize, path);
        const finalAmount = amounts[amounts.length - 1];
        
        // Calculation
        const profit = finalAmount - tradeSize;
        const profitReadable = parseFloat(ethers.formatEther(profit));
        const percentage = (profitReadable / 10) * 100;

        botState.lastSpread = `${percentage.toFixed(4)}%`;

        // If profit is positive, record the "virtual trade"
        if (profit > 0n) {
            botState.virtualBalance += profitReadable;
            botState.totalVirtualProfit += profitReadable;
            
            const log = `SUCCESS: Real-time spread found! +${profitReadable.toFixed(6)} MATIC`;
            botState.history.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        }

        if (botState.history.length > 8) botState.history.pop();
        botState.error = null;

    } catch (err) {
        console.error("RPC Error:", err.message);
        botState.error = "Connection glitch. Retrying...";
    }

    // Check again every 4 seconds for new price blocks
    setTimeout(runSimulation, 4000);
}

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    const statusColor = botState.isRunning ? '#00ff41' : '#ff4141';
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Paper Trading Console</title>
        <style>
            body { font-family: monospace; background: #0a0a0a; color: #00ff41; padding: 20px; }
            .terminal { max-width: 600px; margin: auto; border: 1px solid #00ff41; padding: 20px; box-shadow: 0 0 15px #00ff4133; }
            .header { border-bottom: 1px solid #00ff41; padding-bottom: 10px; margin-bottom: 20px; }
            .stat-line { display: flex; justify-content: space-between; margin: 10px 0; font-size: 1.1em; }
            .status { color: ${statusColor}; font-weight: bold; }
            .logs { background: #000; padding: 10px; height: 150px; overflow-y: hidden; border: 1px solid #111; margin: 20px 0; color: #888; font-size: 0.9em; }
            button { width: 100%; background: transparent; border: 1px solid #00ff41; color: #00ff41; padding: 15px; cursor: pointer; font-family: monospace; font-size: 1.2em; }
            button:hover { background: #00ff41; color: #000; }
            .error { color: #ff4141; text-align: center; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="terminal">
            <div class="header">
                <h2>TRIANGULAR_ARB_SIMULATOR v1.0</h2>
                <div>NETWORK: POLYGON_MAINNET (REAL-TIME)</div>
            </div>

            ${botState.error ? `<div class="error">${botState.error}</div>` : ''}

            <div class="stat-line"><span>STATUS:</span> <span class="status">${botState.isRunning ? 'ACTIVE' : 'IDLE'}</span></div>
            <div class="stat-line"><span>VIRTUAL WALLET:</span> <span>${botState.virtualBalance.toFixed(4)} MATIC</span></div>
            <div class="stat-line"><span>TOTAL PROFIT:</span> <span>+${botState.totalVirtualProfit.toFixed(6)}</span></div>
            <div class="stat-line"><span>CURRENT SPREAD:</span> <span>${botState.lastSpread}</span></div>

            <div class="logs">
                ${botState.history.length > 0 ? botState.history.join('<br>') : 'Scanning DEX liquidity...'}
            </div>

            <form action="/toggle" method="POST">
                <button type="submit">${botState.isRunning ? 'TERMINATE SESSION' : 'INITIALIZE SIMULATION'}</button>
            </form>
        </div>
    </body>
    </html>
    `);
});

app.post('/toggle', (req, res) => {
    botState.isRunning = !botState.isRunning;
    if (botState.isRunning) runSimulation();
    res.redirect('/');
});

app.listen(PORT, () => console.log(`Dashboard active on port ${PORT}`));
