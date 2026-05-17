const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const exchange = new ccxt.phemex({
    apiKey: 'YOUR_API_KEY',
    secret: 'YOUR_SECRET_KEY',
    options: { 'defaultType': 'spot' }
});

const TAKER_FEE = 0.001; // 0.10% per trade
const START_CAPITAL = 100; // Hypothetical USDT for ROI math

let logs = [];
let trianglePaths = [];
let stats = { scanned: 0, bestRoi: 0, uptime: Date.now() };

// --- BOT LOGIC ---
async function initBot() {
    console.log("Connecting to Phemex...");
    try {
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const base = 'USDT';

        // Find: USDT -> A -> B -> USDT
        for (const s1 of symbols) {
            const m1 = markets[s1];
            if (m1.quote !== base || !m1.active) continue;
            
            const coinA = m1.base;

            for (const s2 of symbols) {
                const m2 = markets[s2];
                if (m2.quote !== coinA || !m2.active) continue;

                const coinB = m2.base;
                const s3 = `${coinB}/${base}`;

                if (markets[s3] && markets[s3].active) {
                    trianglePaths.push([s1, s2, s3]);
                }
            }
        }
        console.log(`Phemex Bot Ready: ${trianglePaths.length} paths discovered.`);
        runLoop();
    } catch (e) {
        console.error("Init Error:", e.message);
    }
}

async function runLoop() {
    while (true) {
        try {
            // Phemex fetchTickers provides all spot prices in one call
            const tickers = await exchange.fetchTickers();
            const now = new Date().toLocaleTimeString();
            
            for (const path of trianglePaths) {
                stats.scanned++;
                const [s1, s2, s3] = path;

                if (!tickers[s1] || !tickers[s2] || !tickers[s3]) continue;

                const p1 = tickers[s1].ask; // Buy A with USDT
                const p2 = tickers[s2].ask; // Buy B with A
                const p3 = tickers[s3].bid; // Sell B for USDT

                if (!p1 || !p2 || !p3) continue;

                // Triangulation Math
                const amount1 = START_CAPITAL / p1;
                const amount2 = amount1 / p2;
                const finalUsdt = amount2 * p3;

                // Deduct 0.1% fee per trade (3 trades)
                const netResult = finalUsdt * Math.pow((1 - TAKER_FEE), 3);
                const roi = ((netResult - START_CAPITAL) / START_CAPITAL) * 100;

                if (roi > 0.001) { // Threshold for logging
                    if (roi > stats.bestRoi) stats.bestRoi = roi;
                    logs.unshift({
                        time: now,
                        path: path.join(' ➔ '),
                        roi: roi.toFixed(4),
                        profit: (netResult - START_CAPITAL).toFixed(4)
                    });
                    if (logs.length > 50) logs.pop();
                }
            }
        } catch (e) {
            console.log("Phemex API Pulse Error:", e.message);
        }
        // Respect Phemex Rate Limits
        await new Promise(r => setTimeout(r, 3000));
    }
}

// --- WEB DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Phemex Arb Bot</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #0a0a0a; color: #d4d4d8; font-family: 'Segoe UI', Tahoma, sans-serif; padding: 30px; }
                .grid { display: flex; gap: 20px; margin-bottom: 30px; }
                .card { background: #18181b; padding: 20px; border-radius: 12px; border: 1px solid #27272a; flex: 1; }
                .val { display: block; font-size: 1.8rem; font-weight: bold; color: #60a5fa; }
                .label { font-size: 0.75rem; color: #71717a; text-transform: uppercase; letter-spacing: 1px; }
                .log-box { background: #09090b; padding: 20px; border-radius: 12px; height: 450px; overflow-y: auto; border: 1px solid #27272a; }
                .log-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #18181b; font-family: monospace; }
                .roi-pos { color: #4ade80; font-weight: bold; }
            </style>
        </head>
        <body>
            <h2 style="color: #f4f4f5;">Phemex Arbitrage Dashboard</h2>
            <div class="grid">
                <div class="card"><span class="label">Paths Scanned</span><span class="val">${stats.scanned.toLocaleString()}</span></div>
                <div class="card"><span class="label">Best ROI Found</span><span class="val" style="color:#4ade80">${stats.bestRoi.toFixed(3)}%</span></div>
                <div class="card"><span class="label">Bot Uptime</span><span class="val">${Math.floor((Date.now()-stats.uptime)/60000)}m</span></div>
            </div>
            <div class="log-box">
                <div style="color: #60a5fa; margin-bottom: 15px; font-size: 0.8rem;">LIVE OPPORTUNITIES (> 0.3% spread)</div>
                ${logs.length > 0 ? logs.map(l => `
                    <div class="log-row">
                        <span><span style="color:#52525b">[${l.time}]</span> ${l.path}</span>
                        <span class="roi-pos">+${l.roi}% ($${l.profit})</span>
                    </div>
                `).join('') : '<div style="color:#3f3f46">Scanning Phemex spot markets...</div>'}
            </div>
            <p style="font-size:0.7rem; color:#3f3f46; margin-top:10px;">Fees: 0.1% Taker per trade. Refresh: 5s.</p>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    initBot();
});
