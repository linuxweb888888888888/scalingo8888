require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const pako = require('pako'); // HTX uses gzip compression
const app = express();
const PORT = process.env.PORT || 3000;

// --- BOT SETTINGS ---
const SYMBOL = 'shibusdt'; // HTX WS symbol format
const CONTRACT_SIZE = 1000; // 1 contract = 1000 SHIB
const GROWTH_CHECK_INTERVAL = 60000; // 1 minute (Time-based setting)
const DCA_ROI_TRIGGER = -10; // Trigger DCA if ROI is below -10%
const MULTIPLIER = 1.2;

// --- STATE MANAGEMENT ---
let botStartTime = new Date();
let currentPrice = { bid: 0, ask: 0, last: 0 };
let priceHistory = [];
let realizedPnl = 0;
let openPosition = null; // { side: 'long', size: 0, entryPrice: 0, contracts: 0 }
let tradeHistory = [];

// --- UTILITIES ---
const calculateROI = (entry, current) => ((current - entry) / entry) * 100;
const calculatePNL = (entry, current, size) => (current - entry) * size;

// --- WEBSOCKET CONNECTION (HTX) ---
function connectWS() {
    const ws = new WebSocket('wss://api.huobi.pro/ws');

    ws.on('open', () => {
        // Subscribe to SHIB/USDT Market Detail (ticker)
        ws.send(JSON.stringify({ sub: `market.${SYMBOL}.detail`, id: 'shib_bot' }));
    });

    ws.on('message', (data) => {
        const payload = JSON.parse(pako.inflate(data, { to: 'string' }));
        
        // Handle Ping/Pong
        if (payload.ping) {
            ws.send(JSON.stringify({ pong: payload.ping }));
            return;
        }

        if (payload.tick) {
            // HTX Detail provides close (last), bid, and ask
            currentPrice.last = payload.tick.close;
            // Simulated bid/ask spread for paper trading (0.01% offset)
            currentPrice.bid = payload.tick.close * 0.9999; 
            currentPrice.ask = payload.tick.close * 1.0001;
        }
    });

    ws.on('close', () => setTimeout(connectWS, 5000));
}

// --- TRADING LOGIC ---
function startPosition() {
    if (!openPosition) {
        const entry = currentPrice.ask; // Buy at ask
        openPosition = {
            side: 'long',
            contracts: 1,
            size: 1 * CONTRACT_SIZE,
            entryPrice: entry,
            timestamp: new Date()
        };
        console.log(`[BOT] Started first contract at ${entry}`);
    }
}

function checkStrategy() {
    if (!openPosition || currentPrice.last === 0) return;

    // 1. Calculate Growth Rate (Price vs 1 minute ago)
    priceHistory.push(currentPrice.last);
    if (priceHistory.length > 60) priceHistory.shift();
    
    const pastPrice = priceHistory[0];
    const growthRate = ((currentPrice.last - pastPrice) / pastPrice) * 100;

    // 2. Calculate ROI
    const roi = calculateROI(openPosition.entryPrice, currentPrice.bid);

    // 3. DCA Logic (Multiplier 1.2)
    if (roi <= DCA_ROI_TRIGGER) {
        const newContracts = openPosition.contracts * MULTIPLIER;
        const totalContracts = openPosition.contracts + newContracts;
        const newSize = totalContracts * CONTRACT_SIZE;
        
        // Average the entry price
        const totalCost = (openPosition.entryPrice * openPosition.size) + (currentPrice.ask * (newContracts * CONTRACT_SIZE));
        openPosition.entryPrice = totalCost / newSize;
        openPosition.contracts = totalContracts;
        openPosition.size = newSize;
        
        console.log(`[DCA] Triggered! New Size: ${openPosition.contracts.toFixed(2)} contracts. Avg Price: ${openPosition.entryPrice.toFixed(8)}`);
    }
}

// --- WEB SERVER ROUTES ---
app.get('/', (req, res) => {
    let unrealizedPnl = 0;
    let roi = 0;

    if (openPosition) {
        unrealizedPnl = calculatePNL(openPosition.entryPrice, currentPrice.bid, openPosition.size);
        roi = calculateROI(openPosition.entryPrice, currentPrice.bid);
    }

    const metrics = {
        bot_uptime: `${Math.floor((new Date() - botStartTime) / 1000 / 60)} mins`,
        symbol: SYMBOL.toUpperCase(),
        market: {
            last: currentPrice.last,
            bid: currentPrice.bid,
            ask: currentPrice.ask
        },
        position: openPosition ? {
            direction: openPosition.side.toUpperCase(),
            contracts: openPosition.contracts.toFixed(2),
            total_shib: openPosition.size,
            avg_entry: openPosition.entryPrice.toFixed(8),
            unrealized_pnl: unrealizedPnl.toFixed(4) + " USDT",
            roi: roi.toFixed(2) + "%"
        } : "No open position",
        closed_trades: tradeHistory,
        summary: {
            realized_pnl: realizedPnl.toFixed(4) + " USDT",
            total_profit_from_start: (realizedPnl + unrealizedPnl).toFixed(4) + " USDT"
        }
    };

    res.json(metrics);
});

// --- START BOT ---
connectWS();
// Initialize position once price is received
const initInterval = setInterval(() => {
    if (currentPrice.last > 0) {
        startPosition();
        clearInterval(initInterval);
    }
}, 2000);

// Set Growth Rate / DCA check interval
setInterval(checkStrategy, GROWTH_CHECK_INTERVAL);

app.listen(PORT, () => console.log(`Webserver running on port ${PORT}`));
