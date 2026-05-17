const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const exchange = new ccxt.lbank({
    apiKey: 'YOUR_API_KEY',
    secret: 'YOUR_SECRET_KEY',
});

// LBank standard taker fee is 0.1% (0.001)
// Total loop fee for 3 trades = 0.30%
const TAKER_FEE = 0.001; 
const START_CAPITAL = 100; // Simulated USDT amount

// --- BOT STATE ---
let logs = [];
let trianglePaths = [];
let lastScanTime = "Initializing...";
let stats = {
    totalScanned: 0,
    trianglesFound: 0,
    bestRoi: -100,
    uptime: Date.now()
};

async function initBot() {
    console.log("Connecting to LBank and mapping markets...");
    try {
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const base = 'USDT';

        // Find triangular paths: USDT -> CoinA -> CoinB -> USDT
        for (const s1 of symbols) {
            const m1 = markets[s1];
            if (m1.quote !== base || !m1.active) continue;
            
            const coinA = m1.base; // e.g., BTC

            for (const s2 of symbols) {
                const m2 = markets[s2];
                // Look for cross-pairs where CoinA is the quote currency (e.g., ETH/BTC)
                if (m2.quote !== coinA || !m2.active) continue;

                const coinB = m2.base; // e.g., ETH
                const s3 = `${coinB}/${base}`; // Must be ETH/USDT

                if (markets[s3] && markets[s3].active) {
                    trianglePaths.push([s1, s2, s3]);
                }
            }
        }
        stats.trianglesFound = trianglePaths.length;
        console.log(`LBank Bot Ready: Monitoring ${trianglePaths.length} triangles.`);
        runLoop();
    } catch (e) {
        console.error("Initialization error:", e.message);
    }
}

async function runLoop() {
    while (true) {
        try {
            // LBank fetchTickers is efficient for full-market scanning
            const tickers = await exchange.fetchTickers();
            lastScanTime = new Date().toLocaleTimeString();
            
            for (const path of trianglePaths) {
                stats.totalScanned++;
                const [s1, s2, s3] = path;

                if (!tickers[s1] || !tickers[s2] || !tickers[s3]) continue;

                const p1 = tickers[s1].ask; // Buy CoinA with USDT
                const p2 = tickers[s2].ask; // Buy CoinB with CoinA
                const p3 = tickers[s3].bid; // Sell CoinB for USDT

                if (!p1 || !p2 || !p3 || p1 === 0 || p2 === 0) continue;

                // 1. Calculate Gross Result
                const amount1 = START_CAPITAL / p1;
                const amount2 = amount1 / p2;
                const finalUsdt = amount2 * p3;

                // 2. Subtract LBank Fees (0.1% per trade ^ 3 trades)
                // finalNet = finalUsdt * (0.999 * 0.999 * 0.999)
                const netResult = finalUsdt * Math.pow((1 - TAKER_FEE), 3);
                
                // 3. ROI Calculation
                const roi = ((netResult - START_CAPITAL) / START_CAPITAL) * 100;

                if (roi > -0.2) { // Log everything near break-even to show activity
                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    if (roi > 0.01) { // Only store logs for profitable opportunities
                        logs.unshift({
                            time: lastScanTime,
                            path: path.join(' ➔ '),
                            roi: roi.toFixed(4),
                            profit: (netResult - START_CAPITAL).toFixed(4)
                        });
                        if (logs.length > 50) logs.pop();
                    }
                }
            }
        } catch (e) {
            console.log("LBank API Pulse Error:", e.message);
        }
        // LBank Rate Limit: 3-5 seconds is safe for ticker polling
        await new Promise(r => setTimeout(r, 4000));
    }
}

// --- DASHBOARD UI ---
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.uptime) / 60000);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>LBank Arb Dashboard</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #0f172a; color: #f8fafc; font-family: 'Segoe UI', monospace; padding: 20px; }
                .container { max-width: 900px; margin: auto; }
                .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
                .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; border: 1px solid #334155; text-align: center; }
                .stat-val { display: block; font-size: 1.5rem; font-weight: bold; color: #38bdf8; }
                .stat-label { font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; }
                .log-box { background: #020617; padding: 20px; border-radius: 8px; border: 1px solid #1e293b; height: 450px; overflow-y: auto; }
                .log-entry { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #0f172a; font-size: 0.85rem; }
                .profit { color: #4ade80; font-weight: bold; }
                h1 { font-size: 1.2rem; color: #f1f5f9; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>LBank Triangular Scanner <span style="font-size:0.7rem; color:#64748b">| Fee: 0.30% Total</span></h1>
                
                <div class="grid">
                    <div class="stat-card">
                        <span class="stat-label">Total Scanned</span>
                        <span class="stat-val">${stats.totalScanned.toLocaleString()}</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Best ROI (After Fees)</span>
                        <span class="stat-val" style="color:#4ade80">${stats.bestRoi.toFixed(3)}%</span>
                    </div>
                    <div class="stat-card">
                        <span class="stat-label">Active Paths</span>
                        <span class="stat-val">${stats.trianglesFound}</span>
                    </div>
                </div>

                <div class="log-box">
                    <div style="color:#38bdf8; font-size:0.7rem; margin-bottom:10px; border-bottom:1px solid #38bdf8">LIVE PROFITABLE SPREADS</div>
                    ${logs.length > 0 ? logs.map(l => `
                        <div class="log-entry">
                            <span><span style="color:#475569">[${l.time}]</span> ${l.path}</span>
                            <span class="profit">+${l.roi}% ($${l.profit})</span>
                        </div>
                    `).join('') : '<div style="color:#475569">Monitoring markets... waiting for gaps > 0.30%</div>'}
                </div>
                <div style="margin-top:10px; font-size:0.7rem; color:#475569">
                    Uptime: ${uptime}m | Scanning all USDT pairs on LBank.
                </div>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    initBot();
});
