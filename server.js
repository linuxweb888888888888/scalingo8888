const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- ROBUST RPC LIST ---
const RPC_ENDPOINTS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.llamarpc.com",
    "https://1rpc.io/matic",
    "https://rpc.ankr.com/polygon",
    "https://polygon-mainnet.public.blastapi.io"
];
let rpcIndex = 0;

const ROUTER_ADDRESS = "0xa5E0829CaCEd8fFDD03942104b105c07C8510ed5"; 
const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

const ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];

let botState = {
    isRunning: false,
    virtualBalance: 100.00, 
    totalVirtualProfit: 0.00,
    lastSpread: "0.00%",
    history: [],
    error: null,
    activeNode: RPC_ENDPOINTS[0]
};

async function runSimulation() {
    if (!botState.isRunning) return;

    try {
        // Use Fetch-based provider with a timeout to prevent hanging
        const provider = new ethers.JsonRpcProvider(botState.activeNode, undefined, {
            staticNetwork: true
        });

        const router = new ethers.Contract(ROUTER_ADDRESS, ABI, provider);
        const path = [TOKENS.WMATIC, TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC];
        const tradeSize = ethers.parseEther("10"); 

        // Get prices
        const amounts = await router.getAmountsOut(tradeSize, path);
        const finalAmount = amounts[amounts.length - 1];
        
        const profit = finalAmount - tradeSize;
        const profitReadable = parseFloat(ethers.formatEther(profit));
        const percentage = (profitReadable / 10) * 100;

        botState.lastSpread = `${percentage.toFixed(4)}%`;
        botState.error = null; // Success!

        const time = new Date().toLocaleTimeString();
        if (profit > 0n) {
            botState.virtualBalance += profitReadable;
            botState.totalVirtualProfit += profitReadable;
            botState.history.unshift(`[${time}] 💰 PROFIT: +${profitReadable.toFixed(6)}`);
        } else {
            botState.history.unshift(`[${time}] Scan: ${percentage.toFixed(4)}%`);
        }

    } catch (err) {
        console.log(`Node ${botState.activeNode} failed:`, err.message);
        
        // Pick next node
        rpcIndex = (rpcIndex + 1) % RPC_ENDPOINTS.length;
        botState.activeNode = RPC_ENDPOINTS[rpcIndex];
        
        // Show short error on UI
        botState.error = err.message.includes("429") ? "Rate Limited (429)" : "Node Busy/Timeout";
    }

    if (botState.history.length > 10) botState.history.pop();

    // Slower polling to respect public node limits
    setTimeout(runSimulation, 8000);
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Paper Trading Console</title>
        <meta http-equiv="refresh" content="10"> <!-- Auto-refresh page every 10s -->
        <style>
            body { font-family: 'Courier New', monospace; background: #050505; color: #00ff41; padding: 20px; }
            .terminal { max-width: 600px; margin: auto; border: 1px solid #00ff41; padding: 20px; }
            .status-bar { display: flex; justify-content: space-between; padding: 5px; background: #003300; color: white; margin-bottom: 20px; font-size: 0.8em; }
            .stat-line { display: flex; justify-content: space-between; margin: 10px 0; border-bottom: 1px dotted #222; }
            .logs { height: 200px; overflow: hidden; color: #888; font-size: 0.9em; margin: 20px 0; }
            button { width: 100%; padding: 15px; background: #00ff41; color: black; border: none; cursor: pointer; font-family: monospace; font-weight: bold; }
            .error { color: #ff0000; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="terminal">
            <div class="status-bar">
                <span>NODE: ${botState.activeNode.split('/')[2]}</span>
                <span>STATUS: ${botState.isRunning ? 'RUNNING' : 'STOPPED'}</span>
            </div>

            ${botState.error ? `<div class="error">ERROR: ${botState.error}</div>` : ''}

            <div class="stat-line"><span>VIRTUAL WALLET:</span> <span>${botState.virtualBalance.toFixed(4)} MATIC</span></div>
            <div class="stat-line"><span>TOTAL PROFIT:</span> <span>+${botState.totalVirtualProfit.toFixed(6)}</span></div>
            <div class="stat-line"><span>LAST SPREAD:</span> <span>${botState.lastSpread}</span></div>

            <div class="logs">
                ${botState.history.join('<br>')}
            </div>

            <form action="/toggle" method="POST">
                <button type="submit">${botState.isRunning ? 'HALT TRADING' : 'START SIMULATION'}</button>
            </form>
            <p style="font-size: 0.7em; color: #333; text-align: center;">Page auto-refreshes every 10s</p>
        </div>
    </body>
    </html>
    `);
});

app.post('/toggle', (req, res) => {
    botState.isRunning = !botState.isRunning;
    if (botState.isRunning) {
        botState.error = null;
        runSimulation();
    }
    res.redirect('/');
});

app.listen(PORT, () => console.log(`Dashboard active` || 3000));
