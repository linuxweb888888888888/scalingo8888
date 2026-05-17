const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// I've included a public RPC fallback, but Scalingo works best if you set your own RPC_URL
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com"; 

const ROUTER_ADDRESS = "0xa5E0829CaCEd8fFDD03942104b105c07C8510ed5"; // QuickSwap on Polygon

const TOKENS = {
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    USDC:   "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
};

const ROUTER_ABI = ["function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"];

// --- BOT STATE (Stored in Memory) ---
let botState = {
    isRunning: false,
    virtualBalance: 100, // Starting with 100 "Virtual" MATIC
    totalVirtualProfit: 0,
    lastSpread: "0%",
    history: [],
    error: null
};

// --- INITIALIZE PROVIDER ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

// --- SIMULATION ENGINE ---
async function runSimulation() {
    if (!botState.isRunning) return;

    try {
        // Path: WMATIC -> USDC -> USDT -> WMATIC
        const path = [TOKENS.WMATIC, TOKENS.USDC, TOKENS.USDT, TOKENS.WMATIC];
        const tradeSize = ethers.parseEther("10"); // Simulating a 10 MATIC trade

        // Fetch real prices from DEX
        const amounts = await router.getAmountsOut(tradeSize, path);
        const finalAmount = amounts[amounts.length - 1];
        
        // Calculate Profit/Loss
        const profit = finalAmount - tradeSize;
        const profitReadable = ethers.formatEther(profit);
        const percentage = (Number(profit) / Number(tradeSize)) * 100;

        botState.lastSpread = `${percentage.toFixed(4)}%`;

        // If profit > 0 (In paper trading, we "execute" every positive spread)
        if (profit > 0n) {
            botState.virtualBalance += parseFloat(profitReadable);
            botState.totalVirtualProfit += parseFloat(profitReadable);
            
            const log = `PROFIT: +${parseFloat(profitReadable).toFixed(6)} MATIC via USDC/USDT`;
            botState.history.unshift(`[${new Date().toLocaleTimeString()}] ${log}`);
        } else {
            // Just log the check
            console.log(`Check performed: ${percentage.toFixed(4)}% spread (No profit)`);
        }

        if (botState.history.length > 10) botState.history.pop();
        botState.error = null;

    } catch (err) {
        console.error("Price Fetch Error:", err.message);
        botState.error = "RPC Error: Check your RPC_URL connection.";
    }

    // Run again in 5 seconds
    setTimeout(runSimulation, 5000);
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Paper Trading Bot</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0e1111; color: #00ff41; padding: 20px; text-align: center; }
            .container { max-width: 600px; margin: auto; background: #1a1a1a; padding: 30px; border-radius: 15px; border: 1px solid #00ff41; box-shadow: 0 0 20px rgba(0,255,65,0.2); }
            .status { font-size: 24px; margin: 20px 0; color: ${botState.isRunning ? '#00ff41' : '#ff4141'}; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
            .card { background: #222; padding: 15px; border-radius: 10px; border: 1px solid #333; }
            .val { font-size: 20px; font-weight: bold; display: block; color: white; }
            button { background: transparent; color: #00ff41; border: 2px solid #00ff41; padding: 15px 30px; font-size: 18px; cursor: pointer; border-radius: 5px; width: 100%; transition: 0.3s; }
            button:hover { background: #00ff41; color: black; }
            .logs { text-align: left; background: black; padding: 10px; font-family: monospace; height: 120px; overflow-y: auto; font-size: 12px; margin-top: 20px; color: #aaa; border: 1px solid #333; }
            .error { color: #ff4141; margin-bottom: 10px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>ARB-BOT SIMULATOR</h1>
            ${botState.error ? `<div class="error">${botState.error}</div>` : ''}
            
            <div class="status">SYSTEM: ${botState.isRunning ? 'ACTIVE' : 'IDLE'}</div>

            <div class="grid">
                <div class="card"><small>VIRTUAL BALANCE</small><span class="val">${botState.virtualBalance.toFixed(4)} MATIC</span></div>
                <div class="card"><small>TOTAL PROFIT</small><span class="val">${botState.totalVirtualProfit.toFixed(6)}</span></div>
                <div class="card"><small>CURRENT SPREAD</small><span class="val">${botState.lastSpread}</span></div>
                <div class="card"><small>NETWORK</small><span class="val">Polygon</span></div>
            </div>

            <form action="/toggle" method="POST">
                <button type="submit">${botState.isRunning ? 'STOP SIMULATION' : 'START SIMULATION'}</button>
            </form>

            <div class="logs">
                ${botState.history.length > 0 ? botState.history.join('<br>') : 'Waiting for market data...'}
            </div>
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

app.listen(PORT, () => console.log(`Paper trading active on port ${PORT}`));
