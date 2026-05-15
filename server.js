const express = require('express');
const ccxt = require('ccxt');
const mongoose = require('mongoose');

// ==================== CONFIGURATION ====================
const API_KEY = 'a961bee8-b730aff5-qv2d5ctgbn-990d3';
const API_SECRET = 'caab0880-9a1832ee-738173d7-c923b';
const SYMBOL = 'SHIB/USDT:USDT';
const LEVERAGE = 75;

const TAKE_PROFIT_ROI = 5.0;  // 5% Profit
const STOP_LOSS_ROI = -15.0; // -15% Loss

// ==================== ENGINE ====================
const htx = new ccxt.htx({
    apiKey: API_KEY,
    secret: API_SECRET,
    options: { defaultType: 'swap' },
    enableRateLimit: true
});

let botStatus = {
    active: false,
    side: 'IDLE',
    contracts: 0,
    entryPrice: 0,
    currentPrice: 0,
    roi: 0,
    pnl: 0,
    balance: 0,
    lastAction: "Monitoring Position..."
};

async function managePosition() {
    console.log("🛠️ Position Manager Active...");

    while (true) {
        try {
            // 1. Get Wallet Balance
            const bal = await htx.fetchBalance({ type: 'swap' });
            botStatus.balance = bal.total?.USDT || 0;

            // 2. Get Current SHIB Price
            const ticker = await htx.fetchTicker(SYMBOL);
            botStatus.currentPrice = ticker.last;

            // 3. Get Active Position from Exchange
            const positions = await htx.fetchPositions([SYMBOL]);
            const activePos = positions.find(p => p.symbol === SYMBOL && p.contracts > 0);

            if (activePos) {
                // --- We are in a trade! ---
                botStatus.active = true;
                botStatus.side = activePos.side.toUpperCase();
                botStatus.contracts = activePos.contracts;
                botStatus.entryPrice = activePos.entryPrice;
                
                // Use exchange's own ROI and PnL values
                botStatus.roi = parseFloat(activePos.percentage) || 0;
                botStatus.pnl = parseFloat(activePos.unrealizedPnl) || 0;

                console.log(`Watching ${botStatus.side}: ROI ${botStatus.roi.toFixed(2)}% | PnL: ${botStatus.pnl.toFixed(6)}`);

                // --- CHECK EXIT CONDITIONS ---
                if (botStatus.roi >= TAKE_PROFIT_ROI) {
                    botStatus.lastAction = "Closing: TAKE PROFIT REACHED";
                    await closeTrade(activePos);
                } else if (botStatus.roi <= STOP_LOSS_ROI) {
                    botStatus.lastAction = "Closing: STOP LOSS REACHED";
                    await closeTrade(activePos);
                }

            } else {
                // --- No trade active ---
                botStatus.active = false;
                botStatus.side = "IDLE";
                botStatus.roi = 0;
                botStatus.pnl = 0;
                botStatus.lastAction = "No active position found on Exchange.";
            }

        } catch (e) {
            console.log("Manager Error: " + e.message);
        }

        await new Promise(r => setTimeout(r, 2000)); // Refresh every 2 seconds
    }
}

async function closeTrade(pos) {
    try {
        console.log(`🚀 EXITING POSITION: ${pos.contracts} contracts`);
        const side = (pos.side === 'long' || pos.side === 'buy') ? 'sell' : 'buy';
        
        await htx.createMarketOrder(SYMBOL, side, pos.contracts, undefined, { 'reduceOnly': true });
        
        console.log("✅ Position Closed Successfully.");
    } catch (e) {
        console.log("❌ Error closing position: " + e.message);
    }
}

managePosition();

// ==================== UI MONITOR ====================
const app = express();
app.get('/', (req, res) => {
    const color = botStatus.roi >= 0 ? "lime" : "red";
    res.send(`
        <body style="background:#020617; color:white; font-family:monospace; padding:50px;">
            <h1 style="color:orange;">SHIB MANAGER V4</h1>
            <div style="border:1px solid #1e293b; padding:30px; border-radius:15px; background:#0f172a;">
                <p>WALLET: <span style="color:cyan">${botStatus.balance.toFixed(6)} USDT</span></p>
                <p>STATUS: <span style="font-weight:bold">${botStatus.side}</span></p>
                <p>CONTRACTS: ${botStatus.contracts}</p>
                <hr style="border:0; border-top:1px solid #334155;">
                <p>ENTRY: ${botStatus.entryPrice.toFixed(8)}</p>
                <p>PRICE: ${botStatus.currentPrice.toFixed(8)}</p>
                <h2 style="color:${color}">LIVE ROI: ${botStatus.roi.toFixed(2)}%</h2>
                <h2 style="color:${color}">LIVE PNL: ${botStatus.pnl.toFixed(6)} USDT</h2>
                <p style="color:gray">LAST LOG: ${botStatus.lastAction}</p>
            </div>
            <script>setTimeout(() => location.reload(), 1500);</script>
        </body>
    `);
});
app.listen(3000, () => console.log("🌐 Monitor active on port 3000"));
