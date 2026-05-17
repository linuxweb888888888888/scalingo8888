const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- MULTIPLE RPC FALLBACKS ---
const RPC_ENDPOINTS = [
    "https://polygon.llamarpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon-rpc.com"
];
let currentRpcIndex = 0;

const ROUTER_ADDRESS = "0xa5E0829CaCEd8fFDD03942104b105c07C8510ed5"; 
const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

const ROUTER_ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];

let botState = {
    isRunning: false,
    virtualBalance: 100.00, 
    totalVirtualProfit: 0.00,
    lastSpread: "0.00%",
    history: [],
    error: null,
    currentRpc: RPC_ENDPOINTS[0]
};

async function runSimulation() {
    if (!botState.isRunning) return;

    try {
        const provider = new ethers.JsonRpcProvider(botState.currentRpc);
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

        const path = [TOKENS.WMATIC, TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC];
        const tradeSize = ethers.parseEther("10"); 

        const amounts = await router.getAmountsOut(tradeSize, path);
        const finalAmount = amounts[amounts.length - 1];
        
        const profit = finalAmount - tradeSize;
        const profitReadable = parseFloat(ethers.formatEther(profit));
        const percentage = (profitReadable / 10) * 100;

        botState.lastSpread = `${percentage.toFixed(4)}%`;
        botState.error = null; // Clear error on success

        if (profit > 0n) {
            botState.virtualBalance += profitReadable;
            botState.totalVirtualProfit += profitReadable;
            botState.history.unshift(`[${new Date().toLocaleTimeString()}] PROFIT: +${profitReadable.toFixed(6)} MATIC`);
        } else {
            botState.history.unshift(`[${new Date().toLocaleTimeString()}] Scan: No margin (${percentage.toFixed(4)}%)`);
        }

        if (botState.history.length > 8) botState.history.pop();

    } catch (err) {
        console.error("RPC Error:", err.message);
        // Switch to next RPC if one fails
        currentRpcIndex = (currentRpcIndex + 1) % RPC_ENDPOINTS.length;
        botState.currentRpc = RPC_ENDPOINTS[currentRpcIndex];
        botState.error = "Connection Busy. Switching Node...";
    }

    // Increased delay slightly to avoid rate-limiting (6 seconds)
    setTimeout(runSimulation, 6000);
}

app.get('/', (req, res) => {
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
            .status { color: ${botState.isRunning ? '#00ff41' : '#ff4141'}; font-weight: bold; }
            .logs { background: #000; padding: 10px; height: 180px; overflow-y: hidden; border: 1px solid #111; margin: 20px 0; color: #888; font-size: 0.85em; line-height: 1.4; }
            button { width: 100%; background: transparent; border: 1px solid #00ff41; color: #00ff41; padding: 15px; cursor: pointer; font-family: monospace; font-size: 1.2em; }
            button:hover { background: #00ff41; color: #000; }
            .error { color: #000; background: #ff4141; text-align: center; margin-bottom: 10px; padding: 5px; font-weight: bold; }
            .node-info { font-size: 0.7em; color: #444; margin-top: 10px; display: block; }
        </style>
    </head>
    <body>
        <div class="terminal">
            <div class="header">
                <h2>TRIANGULAR_ARB_SIMULATOR v1.1</h2>
                <div>NETWORK: POLYGON_MAINNET</div>
            </div>

            ${botState.error ? `<div class="error">STATUS: ${botState.error}</div>` : ''}

            <div class="stat-line"><span>ENGINE:</span> <span class="status">${botState.isRunning ? 'ACTIVE' : 'IDLE'}</span></div>
            <div class="stat-line"><span>VIRTUAL WALLET:</span> <span>${botState.virtualBalance.toFixed(4)} MATIC</span></div>
            <div class="stat-line"><span>TOTAL PROFIT:</span> <span>+${botState.totalVirtualProfit.toFixed(6)}</span></div>
            <div class="stat-line"><span>CURRENT SPREAD:</span> <span>${botState.lastSpread}</span></div>

            <div class="logs">
                ${botState.history.length > 0 ? botState.history.join('<br>') : 'Initializing connection to DEX liquidity pools...'}
            </div>

            <form action="/toggle" method="POST">
                <button type="submit">${botState.isRunning ? 'TERMINATE SESSION' : 'INITIALIZE SIMULATION'}</button>
            </form>
            
            <span class="node-info">Active Node: ${botState.currentRpc}</span>
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
