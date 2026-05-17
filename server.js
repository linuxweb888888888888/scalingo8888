const express = require('express');
const { ethers } = require('ethers');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL; // e.g., Quicknode or Infura URL
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ROUTER_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router

// Token Addresses (Example: WETH, USDC, DAI on Ethereum Mainnet)
const TOKENS = [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48", // USDC
    "0x6B175474E89094C44Da98b954EedeAC495271d0F"  // DAI
];

const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
];

// --- BOT STATE ---
let botState = {
    isRunning: false,
    lastCheck: null,
    totalTrades: 0,
    error: null
};

const app = express();
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);

// --- ARBITRAGE ENGINE ---
async function performTriangularCheck() {
    if (!botState.isRunning) return;

    try {
        const amountIn = ethers.parseEther("0.1"); // Amount of WETH to test with
        const path = [TOKENS[0], TOKENS[1], TOKENS[2], TOKENS[0]];

        // Get expected output
        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];

        const profit = amountOut - amountIn;
        const profitReadable = ethers.formatEther(profit);

        botState.lastCheck = {
            time: new Date().toISOString(),
            expectedProfit: profitReadable,
            profitable: profit > 0n
        };

        console.log(`Checking: Profit potential ${profitReadable} ETH`);

        // EXECUTION LOGIC
        // Note: Realistically, you'd only swap if (profit > gas_costs)
        if (profit > 0n) {
            console.log("Profit detected! Attempting swap...");
            // Add swap logic here
            botState.totalTrades++;
        }

    } catch (err) {
        console.error("Engine Error:", err.message);
        botState.error = err.message;
    }

    // Loop every 10 seconds
    setTimeout(performTriangularCheck, 10000);
}

// --- EXPRESS ROUTES ---
app.get('/', (req, res) => {
    res.send(`
        <h1>Triangular Bot Dashboard</h1>
        <p>Status: <strong>${botState.isRunning ? 'RUNNING' : 'STOPPED'}</strong></p>
        <p>Last Check: ${JSON.stringify(botState.lastCheck)}</p>
        <p>Trades Executed: ${botState.totalTrades}</p>
        <hr>
        <form action="/toggle" method="POST"><button>Toggle Bot Start/Stop</button></form>
    `);
});

app.post('/toggle', (req, res) => {
    botState.isRunning = !botState.isRunning;
    if (botState.isRunning) {
        botState.error = null;
        performTriangularCheck();
    }
    res.redirect('/');
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
