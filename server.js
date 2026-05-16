const ccxt = require('ccxt');
const express = require('express');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });
const STARTING_BALANCE = 1000; 
const TRADING_FEE = 0.0002; // 0.2% per leg
const SCAN_DELAY = 100;    // Milliseconds to wait between API calls (Prevents IP ban)

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    recentOpportunities: [],
    status: "Initializing...",
    lastScanTime: 0,
    trianglesCount: 0
};

let triangles = [];

/**
 * 1. AUTOMATIC PATH DISCOVERY (Runs once at startup)
 */
async function findTriangles() {
    try {
        metrics.status = "Mapping market loops...";
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const paths = [];
        const base = 'USDT';

        const usdtPairs = symbols.filter(s => s.includes(base));

        for (const pair1 of usdtPairs) {
            const parts1 = pair1.split('/');
            const alt1 = parts1[0] === base ? parts1[1].split(':')[0] : parts1[0];
            const alt1Pairs = symbols.filter(s => s.includes(alt1) && !s.includes(base));

            for (const pair2 of alt1Pairs) {
                const parts2 = pair2.split('/');
                const alt2 = parts2[0] === alt1 ? parts2[1].split(':')[0] : parts2[0];
                const pair3 = symbols.find(s => s === `${alt2}/${base}` || s === `${base}/${alt2}`);

                if (pair3) {
                    paths.push([pair1, pair2, pair3]);
                }
            }
        }
        // Deduplicate and filter out low-quality paths
        const uniquePaths = Array.from(new Set(paths.map(JSON.stringify)), JSON.parse);
        triangles = uniquePaths.slice(0, 200); // Limit to top 200 paths for CPU efficiency
        metrics.trianglesCount = triangles.length;
        console.log(`Ready! Monitoring ${triangles.length} loops.`);
    } catch (e) {
        console.error("Discovery Error:", e);
    }
}

/**
 * 2. DIRECTIONAL TRADE CALCULATOR
 */
function calculateTrade(currentBalance, pair, currentCoin, tickers) {
    const ticker = tickers[pair];
    if (!ticker || !ticker.ask || !ticker.bid || ticker.ask === 0) return { amount: 0, nextCoin: null };

    const [base, quoteRaw] = pair.split('/');
    const quote = quoteRaw.split(':')[0];

    if (currentCoin === quote) {
        return { amount: (currentBalance / ticker.ask) * (1 - TRADING_FEE), nextCoin: base };
    } else if (currentCoin === base) {
        return { amount: (currentBalance * ticker.bid) * (1 - TRADING_FEE), nextCoin: quote };
    }
    return { amount: 0, nextCoin: null };
}

/**
 * 3. HIGH-SPEED SCAN ENGINE
 * Uses a recursive loop for maximum execution speed.
 */
async function fastScan() {
    const startTick = Date.now();
    try {
        // Fetch all prices in ONE call
        const tickers = await exchange.fetchTickers();
        
        for (const path of triangles) {
            let balance = STARTING_BALANCE;
            let currentCoin = 'USDT';

            for (const pair of path) {
                const result = calculateTrade(balance, pair, currentCoin, tickers);
                balance = result.amount;
                currentCoin = result.nextCoin;
                if (balance <= 0) break;
            }

            const roi = ((balance - STARTING_BALANCE) / STARTING_BALANCE) * 100;

            // Logic: 0.05% - 3% is the realistic "goldilocks" zone for arb
            if (roi > 0.05 && roi < 3) {
                metrics.opportunitiesFound++;
                metrics.simulatedProfit += (balance - STARTING_BALANCE);
                metrics.recentOpportunities.unshift({
                    path: path.join(' → '),
                    roi: roi.toFixed(4) + '%',
                    profit: (balance - STARTING_BALANCE).toFixed(4) + ' USDT',
                    time: new Date().toLocaleTimeString()
                });
                if (metrics.recentOpportunities.length > 15) metrics.recentOpportunities.pop();
            }
        }
        
        metrics.totalScans++;
        metrics.lastScanTime = Date.now() - startTick;
        metrics.status = `Live: ${metrics.lastScanTime}ms latency`;

    } catch (e) {
        metrics.status = "API Error (Backing off): " + e.message;
        await new Promise(r => setTimeout(r, 2000)); // Pause for 2s if rate limited
    }

    // This triggers the next scan as fast as possible
    setTimeout(fastScan, SCAN_DELAY);
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>High-Speed Arb Bot</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: sans-serif; background: #020617; color: #f1f5f9; padding: 20px; }
                    .stats { display: flex; gap: 15px; margin-bottom: 20px; flex-wrap: wrap; }
                    .card { background: #1e293b; padding: 20px; border-radius: 10px; flex: 1; min-width: 200px; border: 1px solid #334155; }
                    .val { font-size: 1.5em; font-weight: bold; color: #38bdf8; }
                    .profit { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; }
                    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #334155; }
                    tr:hover { background: #0f172a; }
                </style>
            </head>
            <body>
                <h2>HTX High-Speed Triangular Arb <small style="color:#64748b">Paper Trading</small></h2>
                <p>Status: <span style="color:#fbbf24">${metrics.status}</span></p>
                <div class="stats">
                    <div class="card"><div>Total Profit</div><div class="val profit">$${metrics.simulatedProfit.toFixed(4)}</div></div>
                    <div class="card"><div>Total Scans</div><div class="val">${metrics.totalScans}</div></div>
                    <div class="card"><div>Loop Latency</div><div class="val">${metrics.lastScanTime}ms</div></div>
                    <div class="card"><div>Loops Tracked</div><div class="val">${metrics.trianglesCount}</div></div>
                </div>
                <table>
                    <tr><th>Path</th><th>ROI</th><th>Sim Profit</th><th>Time</th></tr>
                    ${metrics.recentOpportunities.map(o => `
                        <tr><td>${o.path}</td><td style="color:#4ade80"><b>${o.roi}</b></td><td>${o.profit}</td><td>${o.time}</td></tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `);
});

// --- START ---
app.listen(port, async () => {
    await findTriangles();
    fastScan(); // Start the high-speed recursive loop
    console.log(`Dashboard live on port ${port}`);
});
