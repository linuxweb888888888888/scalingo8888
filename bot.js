const express = require('express');
const ccxt = require('ccxt');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// --- SETTINGS ---
const SYMBOL = 'SHIB/USDT:USDT'; // HTX Perpetual Swap
const GROWTH_INTERVAL_MS = 60 * 60 * 1000; // Time-based: Every 1 hour
const BASE_CONTRACTS = 1;         // Start with 1 contract
const DCA_MULTIPLIER = 1.2;       // Multiplier for DCA
const DCA_ROI_TRIGGER = -10;      // Trigger if ROI < -10%
const CONTRACT_SIZE = 1000000;    // 1 SHIB contract on HTX is typically 1M SHIB

// --- PAPER TRADING STATE ---
let paperAccount = {
    totalContracts: 0,
    totalCostBasis: 0, // In USDT
    closedTrades: [],
    lastPrice: 0,
    nextBuyAmount: BASE_CONTRACTS
};

const exchange = new ccxt.htx();

// --- LOGIC ---
async function calculateGrowth() {
    try {
        const ticker = await exchange.fetchTicker(SYMBOL);
        const currentPrice = ticker.last;
        paperAccount.lastPrice = currentPrice;

        const currentPositionValue = paperAccount.totalContracts * CONTRACT_SIZE * currentPrice;
        
        // ROI Calculation
        let roi = 0;
        if (paperAccount.totalCostBasis > 0) {
            roi = ((currentPositionValue - paperAccount.totalCostBasis) / paperAccount.totalCostBasis) * 100;
        }

        console.log(`[${new Date().toISOString()}] Price: ${currentPrice} | ROI: ${roi.toFixed(2)}% | Pos: ${paperAccount.totalContracts} conts`);

        // DCA Trigger Logic
        if (paperAccount.totalContracts === 0 || roi < DCA_ROI_TRIGGER) {
            const amountToBuy = paperAccount.totalContracts === 0 ? BASE_CONTRACTS : paperAccount.nextBuyAmount;
            
            // Execute Paper Buy
            const cost = amountToBuy * CONTRACT_SIZE * currentPrice;
            paperAccount.totalContracts += amountToBuy;
            paperAccount.totalCostBasis += cost;
            
            console.log(`>>> DCA BUY: ${amountToBuy} contracts at ${currentPrice}`);

            // Set next multiplier if we are in a dip
            if (roi < DCA_ROI_TRIGGER) {
                paperAccount.nextBuyAmount *= DCA_MULTIPLIER;
            } else {
                paperAccount.nextBuyAmount = BASE_CONTRACTS;
            }
        }

        // Logic to "Close" Paper Trade (Take Profit example at 5%)
        if (roi >= 5) {
            const profit = currentPositionValue - paperAccount.totalCostBasis;
            paperAccount.closedTrades.push({
                type: 'Long',
                contracts: paperAccount.totalContracts,
                entryPrice: (paperAccount.totalCostBasis / (paperAccount.totalContracts * CONTRACT_SIZE)).toFixed(10),
                exitPrice: currentPrice,
                pnl: profit.toFixed(4),
                roi: roi.toFixed(2),
                timestamp: new Date().toLocaleString()
            });
            // Reset position
            paperAccount.totalContracts = 0;
            paperAccount.totalCostBasis = 0;
            paperAccount.nextBuyAmount = BASE_CONTRACTS;
            console.log(`### CLOSED TRADE: Profit ${profit.toFixed(4)} USDT`);
        }

    } catch (e) {
        console.error("Exchange Error:", e.message);
    }
}

// Start the Growth Loop
setInterval(calculateGrowth, GROWTH_INTERVAL_MS);
calculateGrowth(); // Run immediately on start

// --- WEBSERVER ROUTES ---
app.get('/', (req, res) => {
    const currentVal = paperAccount.totalContracts * CONTRACT_SIZE * paperAccount.lastPrice;
    const pnl = currentVal - paperAccount.totalCostBasis;
    const roi = paperAccount.totalCostBasis > 0 ? (pnl / paperAccount.totalCostBasis * 100) : 0;

    let html = `
    <html>
    <head><title>SHIB Growth Bot</title><style>body{font-family:sans-serif; padding:20px;} .card{border:1px solid #ccc; padding:15px; margin-bottom:10px; border-radius:5px;}</style></head>
    <body>
        <h1>SHIB Growth Bot Dashboard</h1>
        <div class="card">
            <h3>Current Open Position</h3>
            <p>Contracts: ${paperAccount.totalContracts}</p>
            <p>Cost Basis: ${paperAccount.totalCostBasis.toFixed(4)} USDT</p>
            <p>Current PnL: <b>${pnl.toFixed(4)} USDT</b></p>
            <p>Current ROI: <b>${roi.toFixed(2)}%</b></p>
            <p>Next DCA Multiplier: ${paperAccount.nextBuyAmount.toFixed(2)}x</p>
        </div>
        <h3>Closed Paper Trades</h3>
        <table border="1" cellpadding="10" style="border-collapse:collapse; width:100%;">
            <tr><th>Time</th><th>Contracts</th><th>Entry</th><th>Exit</th><th>PnL (USDT)</th><th>ROI</th></tr>
            ${paperAccount.closedTrades.map(t => `
                <tr>
                    <td>${t.timestamp}</td>
                    <td>${t.contracts}</td>
                    <td>${t.entryPrice}</td>
                    <td>${t.exitPrice}</td>
                    <td>${t.pnl}</td>
                    <td>${t.roi}%</td>
                </tr>
            `).join('')}
        </table>
    </body>
    </html>`;
    res.send(html);
});

app.listen(port, () => {
    console.log(`Dashboard running at port ${port}`);
});
