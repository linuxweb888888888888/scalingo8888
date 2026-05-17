const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// Defaulting to Polygon (QuickSwap) for low gas fees
const RPC_URL = process.env.RPC_URL; 
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "").trim().startsWith('0x') 
    ? process.env.PRIVATE_KEY.trim() 
    : `0x${(process.env.PRIVATE_KEY || "").trim()}`;

const ROUTER_ADDRESS = "0xa5E0829CaCEd8fFDD03942104b105c07C8510ed5"; // QuickSwap Router (Polygon)

// Polygon Mainnet Token Addresses
const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

const ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function approve(address spender, uint256 amount) external returns (bool)"
];

// --- BOT STATE ---
let botState = {
    isRunning: false,
    lastCheck: "Never",
    totalTrades: 0,
    balance: "0",
    error: null,
    logs: []
};

let provider, wallet, router;

// --- INITIALIZATION ---
function init() {
    try {
        if (!RPC_URL || RPC_URL.length < 10) throw new Error("RPC_URL is missing or invalid");
        if (PRIVATE_KEY.length < 60) throw new Error("PRIVATE_KEY is missing or invalid");

        provider = new ethers.JsonRpcProvider(RPC_URL);
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        router = new ethers.Contract(ROUTER_ADDRESS, ABI, wallet);
        
        addLog("System Initialized. Ready to trade on Polygon.");
        updateBalance();
    } catch (e) {
        botState.error = e.message;
    }
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    botState.logs.unshift(`[${time}] ${msg}`);
    if (botState.logs.length > 10) botState.logs.pop();
}

async function updateBalance() {
    if (!wallet) return;
    const bal = await provider.getBalance(wallet.address);
    botState.balance = ethers.formatEther(bal);
}

// --- ARBITRAGE CORE ---
async function checkAndTrade() {
    if (!botState.isRunning || botState.error) return;

    try {
        // Path: WMATIC -> USDC -> USDT -> WMATIC
        const path = [TOKENS.WMATIC, TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC];
        const amountIn = ethers.parseEther("1.0"); // Testing with 1 WMATIC

        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];

        // Calculation: Is output > input + gas?
        const profit = amountOut - amountIn;
        const profitInEth = ethers.formatEther(profit);

        botState.lastCheck = `${profitInEth} WMATIC`;

        if (profit > 0n) {
            addLog(`Opportunity found! Potential: ${profitInEth} WMATIC`);
            
            // EXECUTION (Uncomment below to enable actual trading)
            /*
            addLog("Executing Swap...");
            const tx = await router.swapExactTokensForTokens(
                amountIn,
                amountIn, // In production, use a tiny bit less for slippage
                path,
                wallet.address,
                Math.floor(Date.now() / 1000) + 60 * 10
            );
            await tx.wait();
            botState.totalTrades++;
            updateBalance();
            */
        }
    } catch (e) {
        console.error(e);
        addLog("Price check failed. Check RPC connection.");
    }

    setTimeout(checkAndTrade, 5000); // Check every 5 seconds
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>DEX Arb Bot</title>
        <style>
            body { font-family: sans-serif; background: #1a1a1a; color: white; padding: 20px; display: flex; justify-content: center; }
            .container { width: 100%; max-width: 500px; background: #2a2a2a; padding: 20px; border-radius: 10px; border: 1px solid #444; }
            .status { font-size: 20px; font-weight: bold; color: ${botState.isRunning ? '#4CAF50' : '#f44336'}; }
            .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; }
            .stat-card { background: #333; padding: 15px; border-radius: 5px; text-align: center; }
            .log-box { background: black; padding: 10px; height: 150px; overflow-y: auto; font-family: monospace; font-size: 12px; border-radius: 5px; }
            button { width: 100%; padding: 15px; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; background: #2196F3; color: white; }
            .error { color: #ff5252; background: #422; padding: 10px; border-radius: 5px; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Triangular Arb Bot (Polygon)</h2>
            ${botState.error ? `<div class="error"><b>Error:</b> ${botState.error}</div>` : ''}
            
            <div class="status">● ${botState.isRunning ? 'RUNNING' : 'STOPPED'}</div>
            
            <div class="stat-grid">
                <div class="stat-card"><small>Profit/Check</small><br><b>${botState.lastCheck}</b></div>
                <div class="stat-card"><small>Balance</small><br><b>${parseFloat(botState.balance).toFixed(4)} MATIC</b></div>
            </div>

            <form action="/toggle" method="POST"><button>${botState.isRunning ? 'STOP BOT' : 'START BOT'}</button></form>

            <h4>Activity Log:</h4>
            <div class="log-box">${botState.logs.join('<br>')}</div>
        </div>
    </body>
    </html>
    `);
});

app.post('/toggle', (req, res) => {
    if (!botState.error) {
        botState.isRunning = !botState.isRunning;
        if (botState.isRunning) checkAndTrade();
    }
    res.redirect('/');
});

init();
app.listen(PORT, () => console.log(`Server ready on port ${PORT}`));
