const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const exchange = new ccxt.mexc();
const TAKER_FEE = 0.0005; // 0.05% per trade
const START_CAPITAL = 100; // Hypothetical $100 for ROI calculation

// --- BOT STATE ---
let logs = [];
let lastScanTime = null;
let trianglePaths = [];
let stats = {
    totalScanned: 0,
    trianglesFound: 0,
    bestRoi: 0,
    uptime: Date.now()
};

async function initBot() {
    console.log("Initializing MEXC Arb Bot...");
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets);
    
    // Find paths: USDT -> A -> B -> USDT
    for (const s1 of symbols) {
        const [t1, q1] = s1.split('/');
        if (q1 !== 'USDT') continue;
        for (const s2 of symbols) {
            const [t2, q2] = s2.split('/');
            if (q2 !== t1) continue;
            const s3 = `${t2}/USDT`;
            if (markets[s3]) trianglePaths.push([s1, s2, s3]);
        }
    }
    stats.trianglesFound = trianglePaths.length;
    runLoop();
}

async function runLoop() {
    while (true) {
        try {
            const tickers = await exchange.fetchTickers();
            lastScanTime = new Date().toLocaleTimeString();
            
            for (const path of trianglePaths) {
                stats.totalScanned++;
                const [s1, s2, s3] = path;
                if (!tickers[s1] || !tickers[s2] || !tickers[s3]) continue;

                // Step 1: USDT -> CoinA (Ask Price)
                const price1 = tickers[s1].ask;
                // Step 2: CoinA -> CoinB (Ask Price)
                const price2 = tickers[s2].ask;
                // Step 3: CoinB -> USDT (Bid Price)
                const price3 = tickers[s3].bid;

                if (price1 === 0 || price2 === 0) continue;

                // Math: How much USDT we end with
                const amount1 = START_CAPITAL / price1;
                const amount2 = amount1 / price2;
                const finalUsdt = amount2 * price3;

                // Subtract Fees (3 trades * 0.05%)
                const totalFees = START_CAPITAL * (TAKER_FEE * 3);
                const netResult = finalUsdt - totalFees;
                const roi = ((netResult - START_CAPITAL) / START_CAPITAL) * 100;

                if (roi > 0.01) { // Log anything with > 0.01% ROI
                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    const logEntry = {
                        time: lastScanTime,
                        path: path.join(' ➔ '),
                        details: `Rates: [1]${price1} [2]${price2} [3]${price3}`,
                        roi: roi.toFixed(4),
                        profit: (netResult - START_CAPITAL).toFixed(4)
                    };

                    logs.unshift(logEntry);
                    if (logs.length > 50) logs.pop();
                }
            }
        } catch (e) {
            console.error("Loop Error:", e.message);
        }
        await new Promise(r => setTimeout(r, 3000)); // Cool down to avoid rate limits
    }
}

// --- WEB UI ---
app.get('/', (req, res) => {
    const uptimeMins = Math.floor((Date.now() - stats.uptime) / 60000);
    const logRows = logs.map(l => `
        <div style="border-bottom: 1px solid #1e293b; padding: 10px 0;">
            <span style="color: #94a3b8;">[${l.time}]</span> 
            <b style="color: #f8fafc;">${l.path}</b><br>
            <small style="color: #64748b;">${l.details}</small> | 
            <span style="color: #4ade80; font-weight: bold;">ROI: ${l.roi}% (+$${l.profit})</span>
        </div>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8"><meta http-equiv="refresh" content="5">
            <title>MEXC Arb Monitor</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: 'Segoe UI', sans-serif; padding: 20px; }
                .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
                .stat-card { background: #0f172a; padding: 15px; border-radius: 8px; border: 1px solid #1e293b; text-align: center; }
                .stat-val { display: block; font-size: 1.5rem; font-weight: bold; color: #38bdf8; }
                .stat-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; }
                .log-container { background: #0f172a; padding: 20px; border-radius: 8px; border: 1px solid #1e293b; height: 500px; overflow-y: auto; }
                h1 { font-size: 1.2rem; margin-bottom: 20px; color: #94a3b8; }
                .green { color: #4ade80; }
            </style>
        </head>
        <body>
            <h1>Arbitrage Performance Monitor <span style="font-size:0.8rem">| MEXC Low-Fee Engine</span></h1>
            
            <div class="grid">
                <div class="stat-card">
                    <span class="stat-label">Total Paths Scanned</span>
                    <span class="stat-val">${stats.totalScanned.toLocaleString()}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Best ROI Found</span>
                    <span class="stat-val green">${stats.bestRoi.toFixed(3)}%</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Triangles Tracked</span>
                    <span class="stat-val">${stats.trianglesFound}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">Bot Uptime</span>
                    <span class="stat-val">${uptimeMins}m</span>
                </div>
            </div>

            <div class="log-container">
                <div style="margin-bottom: 10px; color: #38bdf8; font-size: 0.8rem; border-bottom: 1px solid #38bdf8;">LIVE PROFIT OPPORTUNITIES (AFTER FEES)</div>
                ${logs.length > 0 ? logRows : '<div style="color:#64748b">Scanning markets... No profitable triangles detected yet.</div>'}
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Server: http://localhost:${port}`);
    initBot();
});
