const express = require('express');
const WebSocket = require('ws');
const pako = require('pako'); // HTX uses GZIP compression
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Bot Settings & State
let botState = {
    symbol: 'shibusdt', // HTX spot or '1000shibusdt' for futures
    isRunning: true,
    startTime: new Date(),
    priceHistory: [],
    currentPrice: { bid: 0, ask: 0 },
    openPosition: null, // { entryPrice, contracts, totalCost, direction: 'LONG' }
    closedTrades: [],
    totalRealizedPnl: 0,
    metrics: {
        roi: 0,
        unrealizedPnl: 0,
        growthRate: 0
    }
};

// 1. WebSocket for Real-time Data
const connectHTX = () => {
    const ws = new WebSocket('wss://api.huobi.pro/ws');

    ws.on('open', () => {
        // Subscribe to Market Detail (gives bid/ask/last price)
        ws.send(JSON.stringify({ sub: `market.${botState.symbol}.detail`, id: 'shib_bot' }));
    });

    ws.on('message', (data) => {
        const payload = JSON.parse(pako.ungzip(data, { to: 'string' }));
        
        // Handle Ping/Pong to keep connection alive
        if (payload.ping) {
            ws.send(JSON.stringify({ pong: payload.ping }));
            return;
        }

        if (payload.tick) {
            botState.currentPrice.bid = payload.tick.bid[0];
            botState.currentPrice.ask = payload.tick.ask[0];
            updateLogic();
        }
    });

    ws.on('close', () => setTimeout(connectHTX, 5000));
};

// 2. Trading Strategy & DCA Logic
const updateLogic = () => {
    const price = botState.currentPrice.bid;
    if (!price) return;

    // Maintain Price History for Growth Rate (Time-based)
    const now = Date.now();
    botState.priceHistory.push({ price, time: now });
    const windowMs = process.env.GROWTH_RATE_WINDOW_MINS * 60000;
    botState.priceHistory = botState.priceHistory.filter(p => now - p.time <= windowMs);

    // Calculate Growth Rate
    if (botState.priceHistory.length > 1) {
        const oldPrice = botState.priceHistory[0].price;
        botState.metrics.growthRate = ((price - oldPrice) / oldPrice) * 100;
    }

    // Initialize first contract (1000 SHIB unit)
    if (!botState.openPosition) {
        openPosition(1); // Start with 1 contract
        return;
    }

    // Calculate ROI & Unrealized PNL
    const pos = botState.openPosition;
    botState.metrics.unrealizedPnl = (price - pos.entryPrice) * (pos.contracts * 1000);
    botState.metrics.roi = (botState.metrics.unrealizedPnl / pos.totalCost) * 100;

    // DCA Logic: Trigger if ROI below -10% (drawdown)
    const dcaThreshold = parseFloat(process.env.DCA_THRESHOLD_PERCENT);
    if (botState.metrics.roi <= dcaThreshold) {
        const multiplier = parseFloat(process.env.DCA_MULTIPLIER);
        const newContracts = pos.contracts * multiplier;
        console.log(`DCA Triggered! Buying ${newContracts.toFixed(2)} units...`);
        openPosition(newContracts, true);
    }
};

const openPosition = (contracts, isDca = false) => {
    const price = botState.currentPrice.ask; // Buy at Ask
    const cost = price * (contracts * 1000);

    if (!isDca) {
        botState.openPosition = {
            entryPrice: price,
            contracts: contracts,
            totalCost: cost,
            direction: 'LONG'
        };
    } else {
        // Average Down Logic
        const totalContracts = botState.openPosition.contracts + contracts;
        const totalCost = botState.openPosition.totalCost + cost;
        botState.openPosition.entryPrice = totalCost / (totalContracts * 1000);
        botState.openPosition.contracts = totalContracts;
        botState.openPosition.totalCost = totalCost;
    }
};

// 3. Webserver UI
app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="font-family:sans-serif; background:#121212; color:white; padding:20px;">
                <h1>SHIB HTX Growth Bot (Paper)</h1>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                    <div style="border:1px solid #333; padding:15px;">
                        <h3>Active Position</h3>
                        <p>Direction: <b style="color:#00ff00">${botState.openPosition?.direction || 'NONE'}</b></p>
                        <p>Contracts: ${botState.openPosition?.contracts.toFixed(2) || 0} (1k/unit)</p>
                        <p>Avg Entry: $${botState.openPosition?.entryPrice.toFixed(8) || 0}</p>
                        <p>Current Bid: $${botState.currentPrice.bid.toFixed(8)}</p>
                    </div>
                    <div style="border:1px solid #333; padding:15px;">
                        <h3>Metrics</h3>
                        <p>ROI: <span style="color:${botState.metrics.roi >= 0 ? '#00ff00' : '#ff4444'}">${botState.metrics.roi.toFixed(2)}%</span></p>
                        <p>Unrealized PNL: $${botState.metrics.unrealizedPnl.toFixed(4)}</p>
                        <p>Realized PNL: $${botState.totalRealizedPnl.toFixed(4)}</p>
                        <p>Growth Rate (${process.env.GROWTH_RATE_WINDOW_MINS}m): ${botState.metrics.growthRate.toFixed(4)}%</p>
                    </div>
                </div>
                <h3>Bot Uptime: ${Math.floor((Date.now() - botState.startTime)/60000)} mins</h3>
            </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    connectHTX();
});
