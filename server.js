const express = require('express');
const { ethers } = require('ethers');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL;

// Fix for Private Key formatting
let rawKey = process.env.PRIVATE_KEY || "";
if (rawKey && !rawKey.startsWith('0x')) {
    rawKey = `0x${rawKey}`;
}
const PRIVATE_KEY = rawKey.trim();

const ROUTER_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; 

// WETH, USDC, DAI (Ethereum Mainnet Example)
const TOKENS = [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48", 
    "0x6B175474E89094C44Da98b954EedeAC495271d0F"  
];

const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

let botState = {
    isRunning: false,
    lastCheck: null,
    totalTrades: 0,
    error: null
};

const app = express();

// --- VALIDATION & INITIALIZATION ---
let provider;
let wallet;
let router;

try {
    if (!RPC_URL) throw new Error("RPC_URL is missing in environment variables");
    if (!PRIVATE_KEY || PRIVATE_KEY.length < 64) throw new Error("PRIVATE_KEY is missing or too short");

    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
    console.log("Wallet initialized for address:", wallet.address);
} catch (e) {
    console.error("Initialization Error:", e.message);
    botState.error = "Configuration Error: " + e.message;
}

// --- ARBITRAGE ENGINE ---
async function performTriangularCheck() {
    if (!botState.isRunning || botState.error) return;

    try {
        const amountIn = ethers.parseEther("0.1"); 
        const path = [TOKENS[0], TOKENS[1], TOKENS[2], TOKENS[0]];

        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];
        const profit = amountOut - amountIn;

        botState.lastCheck = {
            time: new Date().toISOString(),
            expectedProfit: ethers.formatEther(profit),
            profitable: profit > 0n
        };
    } catch (err) {
        console.error("Loop Error:", err.message);
    }

    setTimeout(performTriangularCheck, 10000);
}

// --- ROUTES ---
app.get('/', (req, res) => {
    res.send(`
        <style>body { font-family: sans-serif; padding: 20px; line-height: 1.6; }</style>
        <h1>Triangular Bot Dashboard</h1>
        <p>Status: <strong style="color: ${botState.isRunning ? 'green' : 'red'}">${botState.isRunning ? 'RUNNING' : 'STOPPED'}</strong></p>
        ${botState.error ? `<p style="color: red"><b>Error:</b> ${botState.error}</p>` : ''}
        <pre>${JSON.stringify(botState.lastCheck, null, 2)}</pre>
        <form action="/toggle" method="POST"><button style="padding: 10px 20px; cursor: pointer;">Start/Stop Bot</button></form>
    `);
});

app.post('/toggle', (req, res) => {
    if (botState.error) return res.status(500).send("Cannot start bot with configuration errors.");
    botState.isRunning = !botState.isRunning;
    if (botState.isRunning) performTriangularCheck();
    res.redirect('/');
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
