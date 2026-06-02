const express = require('express');
const WebSocket = require('ws');
const zlib = require('zlib');
const app = express();
const port = process.env.PORT || 3000;

// --- BOT SETTINGS ---
const CONFIG = {
    SYMBOL: 'shibusdt',
    BASE_CONTRACT_SIZE: 1000, // 1 contract = 1000 SHIB
    DCA_MULTIPLIER: 1.2,
    DCA_TRIGGER_ROI: -10,     // Trigger DCA if ROI < -10%
    GROWTH_RATE_THRESHOLD: 0.05, // 0.05% growth
    GROWTH_WINDOW_MS: 60000,   // Check growth over 1 minute
};

// --- BOT STATE (Paper Trading) ---
let state = {
    priceHistory: [],
    position: null, // { avgPrice: 0, totalQty: 0, contracts: 0 }
    closedTrades: [],
    currentTicker: { bid: 0, ask: 0, last: 0 },
    lastUpdate: Date.now()
};

// --- UTILS ---
const calculateROI = (currentPrice, avgEntry) => ((currentPrice - avgEntry) / avgEntry) * 100;

// --- WEBSOCKET LOGIC (HTX) ---
const initWS = () => {
    const ws = new WebSocket('wss://api.huobi.pro/ws');

    ws.on('open', () => {
        // Subscribe to BBO (Best Bid Offer) for Paper Trading Bid/Ask
        ws.send(JSON.stringify({ sub: `market.${CONFIG.SYMBOL}.bbo`, id: 'id1' }));
    });

    ws.on('message', (data) => {
        // HTX sends GZIP compressed data
        const payload = zlib.gunzipSync(data).toString();
        const msg = JSON.parse(payload);

        // Handle Heartbeat
        if (msg.ping) {
            ws.send(JSON.stringify({ pong: msg.ping }));
            return;
        }

        if (msg.tick) {
            const { bid, ask } = msg.tick;
            state.currentTicker = { bid, ask, last: (bid + ask) / 2 };
            updateStrategy();
        }
    });

    ws.on('close', () => setTimeout(initWS, 5000));
};

// --- TRADING STRATEGY ---
function updateStrategy() {
    const now = Date.now();
    const currentPrice = state.currentTicker.ask; // Entry on Ask for Longs

    // 1. Manage Price History for Growth Rate
    state.priceHistory.push({ time: now, price: currentPrice });
    state.priceHistory = state.priceHistory.filter(p => now - p.time <= CONFIG.GROWTH_WINDOW_MS);

    // 2. Logic: If no position, check Growth Rate to Open Long
    if (!state.position && state.priceHistory.length > 2) {
        const oldest = state.priceHistory[0];
        const growth = ((currentPrice - oldest.price) / oldest.price) * 100;

        if (growth >= CONFIG.GROWTH_RATE_THRESHOLD) {
            openPosition(currentPrice, CONFIG.BASE_CONTRACT_SIZE);
        }
    }

    // 3. Logic: If in position, check for DCA trigger
    if (state.position) {
        const roi = calculateROI(state.currentTicker.bid, state.position.avgPrice);
        if (roi <= CONFIG.DCA_TRIGGER_ROI) {
            const dcaQty = state.position.totalQty * CONFIG.DCA_MULTIPLIER;
            openPosition(currentPrice, dcaQty, true);
        }
    }
}

function openPosition(price, qty, isDCA = false) {
    if (!state.position) {
        state.position = { avgPrice: price, totalQty: qty, contracts: qty / 1000, startTime: Date.now() };
    } else {
        // Update Weighted Average for DCA
        const newTotalQty = state.position.totalQty + qty;
        state.position.avgPrice = ((state.position.avgPrice * state.position.totalQty) + (price * qty)) / newTotalQty;
        state.position.totalQty = newTotalQty;
        state.position.contracts = newTotalQty / 1000;
    }
    console.log(`${isDCA ? 'DCA' : 'OPEN'} LONG at ${price} | Total Qty: ${state.position.totalQty}`);
}

// --- EXPRESS SERVER (Dashboard) ---
app.get('/', (req, res) => {
    let roi = 0, pnl = 0;
    if (state.position) {
        roi = calculateROI(state.currentTicker.bid, state.position.avgPrice);
        pnl = (state.currentTicker.bid - state.position.avgPrice) * state.position.totalQty;
    }

    const html = `
        <html>
            <body style="font-family: sans-serif; background: #121212; color: white; padding: 20px;">
                <h1>SHIB HTX Bot (Paper Trading)</h1>
                <div style="border: 1px solid #333; padding: 15px; margin-bottom: 20px;">
                    <h3>Market: SHIB/USDT</h3>
                    <p>Bid: ${state.currentTicker.bid} | Ask: ${state.currentTicker.ask}</p>
                </div>

                <div style="background: ${roi >= 0 ? '#1b5e20' : '#b71c1c'}; padding: 15px; border-radius: 8px;">
                    <h2>Active Position: LONG</h2>
                    <p>Status: ${state.position ? 'OPEN' : 'WAITING FOR GROWTH SIGNAL'}</p>
                    ${state.position ? `
                        <p>Avg Entry: ${state.position.avgPrice.toFixed(8)}</p>
                        <p>Contracts: ${state.position.contracts} (${state.position.totalQty} SHIB)</p>
                        <p><b>ROI: ${roi.toFixed(2)}%</b></p>
                        <p><b>Unrealized PnL: ${pnl.toFixed(4)} USDT</b></p>
                    ` : ''}
                </div>

                <h3>Closed Trades</h3>
                <pre>${JSON.stringify(state.closedTrades, null, 2)}</pre>
                
                <script>setTimeout(() => location.reload(), 2000);</script>
            </body>
        </html>
    `;
    res.send(html);
});

app.listen(port, () => {
    console.log(`Webserver running on port ${port}`);
    initWS();
});
