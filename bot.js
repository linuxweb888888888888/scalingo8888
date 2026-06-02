const express = require('express');
const axios = require('axios');
const app = express();

// --- SETTINGS ---
const SYMBOL = 'shibusdt';
const INITIAL_SIZE = 1.0;     // Start 1 contract
const DCA_THRESHOLD = -10.0;  // -10% ROI
const DCA_MULTIPLIER = 1.2;   // 1.2x Multiplier
const HOURLY_GROWTH = 0.04;   // 0.04% per hour (~1% daily)
const TICK_INTERVAL = 20000;  // 20 seconds

// --- STATE ---
let state = {
    startTime: Date.now(),
    entryPrice: 0,
    currentSize: INITIAL_SIZE,
    totalDcaCount: 0,
    market: { bid: 0, ask: 0, last: 0 },
    roi: 0,
    pnl: 0,
    history: []
};

function logEvent(msg) {
    const timestamp = new Date().toLocaleString();
    const log = `[${timestamp}] ${msg}`;
    console.log(log);
    state.history.push(log);
    if (state.history.length > 50) state.history.shift(); // Keep last 50
}

// --- LOGIC ---
async function updateBot() {
    try {
        const response = await axios.get(`https://api.huobi.pro/market/detail/merged?symbol=${SYMBOL}`);
        const tick = response.data.tick;
        
        state.market.last = tick.close;
        state.market.bid = tick.bid[0];
        state.market.ask = tick.ask[0];

        // 1. Initial Entry
        if (state.entryPrice === 0) {
            state.entryPrice = state.market.ask;
            logEvent(`START: Initial 1 unit bought at ${state.entryPrice}`);
        }

        // 2. Calculations
        state.pnl = (state.market.bid - state.entryPrice) * state.currentSize;
        state.roi = (state.pnl / (state.entryPrice * state.currentSize)) * 100;

        // 3. DCA Logic
        if (state.roi <= DCA_THRESHOLD) {
            let addedSize = state.currentSize * DCA_MULTIPLIER;
            let newTotalSize = state.currentSize + addedSize;
            
            // Weighted Average Entry
            state.entryPrice = ((state.entryPrice * state.currentSize) + (state.market.ask * addedSize)) / newTotalSize;
            state.currentSize = newTotalSize;
            state.totalDcaCount++;
            
            logEvent(`DCA TRIGGERED: Added ${addedSize.toFixed(2)}. New Entry: ${state.entryPrice.toFixed(10)}`);
        }
    } catch (error) {
        console.error("Fetch Error:", error.message);
    }
}

// --- ROUTES ---
app.get('/', (req, res) => {
    const elapsedHours = (Date.now() - state.startTime) / 3600000;
    const targetPnl = (state.entryPrice * INITIAL_SIZE) * (HOURLY_GROWTH / 100) * elapsedHours;

    res.json({
        bot_status: "ONLINE",
        symbol: SYMBOL.toUpperCase(),
        uptime_hours: elapsedHours.toFixed(2),
        market: state.market,
        position: {
            entry_price: state.entryPrice.toFixed(10),
            current_size: state.currentSize.toFixed(2),
            roi_percent: state.roi.toFixed(4) + "%",
            unrealized_pnl_usdt: state.pnl.toFixed(10),
            dca_events: state.totalDcaCount
        },
        growth_tracking: {
            target_pnl_benchmark: targetPnl.toFixed(10),
            performance_vs_target: (state.pnl - targetPnl).toFixed(10)
        },
        last_update: new Date().toISOString()
    });
});

app.get('/trades', (req, res) => {
    res.json(state.history);
});

// --- START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(updateBot, TICK_INTERVAL);
    updateBot(); // Run immediately
});
