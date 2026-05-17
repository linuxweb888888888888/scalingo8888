const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION & ENV CHECK ---
const RPC_URL = process.env.RPC_URL;
let rawKey = process.env.PRIVATE_KEY || "";
if (rawKey && !rawKey.startsWith('0x')) rawKey = `0x${rawKey}`;
const PRIVATE_KEY = rawKey.trim();

// Setup Router (Uniswap V2 Example - Change for BSC/Polygon)
const ROUTER_ADDRESS = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; 
const TOKENS = [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // Token A (WETH)
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48", // Token B (USDC)
    "0x6B175474E89094C44Da98b954EedeAC495271d0F"  // Token C (DAI)
];

const ROUTER_ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];

// --- BOT STATE ---
let botState = {
    isRunning: false,
    lastCheck: null,
    totalTrades: 0,
    error: null,
    walletAddress: null
};

// --- INITIALIZATION ---
let provider, wallet, router;

function initialize() {
    try {
        if (!RPC_URL) throw new Error("RPC_URL is missing in environment variables");
        if (!PRIVATE_KEY || PRIVATE_KEY.length < 60) throw new Error("PRIVATE_KEY is missing or invalid");

        provider = new ethers.JsonRpcProvider(RPC_URL);
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
        
        botState.walletAddress = wallet.address;
        botState.error = null; // Clear error if successful
    } catch (e) {
        botState.error = "Configuration Error: " + e.message;
    }
}
initialize();

// --- ARBITRAGE LOOP ---
async function runEngine() {
    if (!botState.isRunning || botState.error) return;

    try {
        const amountIn = ethers.parseEther("0.1"); 
        const path = [TOKENS[0], TOKENS[1], TOKENS[2], TOKENS[0]];
        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];
        
        botState.lastCheck = {
            time: new Date().toLocaleTimeString(),
            profit: ethers.formatEther(amountOut - amountIn),
            status: amountOut > amountIn ? "PROFITABLE" : "NO MARGIN"
        };
    } catch (err) {
        console.error(err);
    }
    setTimeout(runEngine, 10000);
}

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    const statusColor = botState.isRunning ? '#2ecc71' : '#e74c3c';
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>DEX Bot Console</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f7f6; color: #333; padding: 40px; }
            .card { background: white; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
            h1 { margin-top: 0; font-size: 24px; border-bottom: 2px solid #eee; padding-bottom: 10px; }
            .status-badge { display: inline-block; padding: 5px 15px; border-radius: 20px; color: white; font-weight: bold; background: ${statusColor}; }
            .error-box { background: #fee; border-left: 4px solid #e74c3c; padding: 15px; margin: 20px 0; color: #c0392b; font-size: 14px; }
            .stats { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-top: 20px; font-family: monospace; }
            button { background: #3498db; color: white; border: none; padding: 12px 25px; border-radius: 6px; cursor: pointer; font-size: 16px; width: 100%; transition: 0.2s; }
            button:hover { background: #2980b9; }
            .wallet { font-size: 12px; color: #7f8c8d; margin-top: 10px; }
        </style>
    </head>
    <body>
        <div class="card">
            <h1>Triangular Bot Dashboard</h1>
            
            <p>Status: <span class="status-badge">${botState.isRunning ? 'RUNNING' : 'STOPPED'}</span></p>

            ${botState.error ? `
                <div class="error-box">
                    <strong>⚠️ Error:</strong><br>${botState.error}
                </div>
            ` : ''}

            <div class="stats">
                <strong>Last Check:</strong> ${botState.lastCheck ? JSON.stringify(botState.lastCheck, null, 2) : 'No data yet'}<br>
                <strong>Total Trades:</strong> ${botState.totalTrades}
            </div>

            <p class="wallet">Connected Wallet: ${botState.walletAddress || 'Not Connected'}</p>

            <form action="/toggle" method="POST" style="margin-top:20px;">
                <button type="submit">${botState.isRunning ? 'Stop Bot' : 'Start Bot'}</button>
            </form>
        </div>
    </body>
    </html>
    `);
});

app.post('/toggle', (req, res) => {
    if (!botState.error) {
        botState.isRunning = !botState.isRunning;
        if (botState.isRunning) runEngine();
    }
    res.redirect('/');
});

app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));
