const ccxt = require('ccxt');
const express = require('express');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });
const STARTING_BALANCE = 1000; 
const TRADING_FEE = 0.002; // 0.2% per trade (Total 0.6% for 3 trades)

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    recentOpportunities: [],
    status: "Initializing...",
    trianglesCount: 0
};

let triangles = [];

/**
 * 1. AUTOMATIC PATH FINDER
 * Scans all HTX markets to find loops like USDT -> BTC -> ETH -> USDT
 */
async function findTriangles() {
    try {
        metrics.status = "Mapping all possible loops...";
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const paths = [];

        // We want loops starting and ending with USDT
        const base = 'USDT';

        // Find all pairs that have USDT as a base or quote (e.g., BTC/USDT)
        const usdtPairs = symbols.filter(s => s.includes(base));

        for (const pair1 of usdtPairs) {
            const parts1 = pair1.split('/');
            const alt1 = parts1[0] === base ? parts1[1].split(':')[0] : parts1[0];

            // Find pairs that connect alt1 to a second alt coin (e.g., ETH/BTC)
            const alt1Pairs = symbols.filter(s => s.includes(alt1) && !s.includes(base));

            for (const pair2 of alt1Pairs) {
                const parts2 = pair2.split('/');
                const alt2 = parts2[0] === alt1 ? parts2[1].split(':')[0] : parts2[0];

                // Find a pair that connects alt2 back to USDT
                const pair3 = symbols.find(s => 
                    (s === `${alt2}/${base}`) || 
                    (s === `${base}/${alt2}`) ||
                    (s.startsWith(`${alt2}/${base}:`))
                );

                if (pair3) {
                    paths.push([pair1, pair2, pair3]);
                }
            }
        }

        // Remove duplicates and limit to avoid CPU overload
        const uniquePaths = Array.from(new Set(paths.map(JSON.stringify)), JSON.parse);
        triangles = uniquePaths;
        metrics.trianglesCount = triangles.length;
        metrics.status = `Monitoring ${triangles.length} paths`;
        console.log(`Found ${triangles.length} triangular paths.`);
    } catch (e) {
        console.error("Path Discovery Error:", e);
    }
}

/**
 * 2. REALISTIC CALCULATOR
 * Correctly determines if it needs to Buy or Sell at each step
 */
function calculateTrade(currentBalance, pair, currentCoin, tickers) {
    const ticker = tickers[pair];
    if (!ticker || !ticker.ask || !ticker.bid) return { amount: 0, nextCoin: null };

    const [base, quoteRaw] = pair.split('/');
    const quote = quoteRaw.split(':')[0]; // Handle CCXT :USDT notation

    // If we have the Quote (USDT) and want the Base (BTC), we BUY
    if (currentCoin === quote) {
        return {
            amount: (currentBalance / ticker.ask) * (1 - TRADING_FEE),
            nextCoin: base
        };
    } 
    // If we have the Base (BTC) and want the Quote (USDT), we SELL
    else if (currentCoin === base) {
        return {
            amount: (currentBalance * ticker.bid) * (1 - TRADING_FEE),
            nextCoin: quote
        };
    }
    return { amount: 0, nextCoin: null };
}

/**
 * 3. SCANNER ENGINE
 */
async function scan() {
    if (triangles.length === 0) return;

    try {
        const tickers = await exchange.fetchTickers();
        metrics.totalScans++;

        for (const path of triangles) {
            let balance = STARTING_BALANCE;
            let currentCoin = 'USDT';

            for (const pair of path) {
                const result = calculateTrade(balance, pair, currentCoin, tickers);
                balance = result.amount;
                currentCoin = result.nextCoin;
                if (balance === 0) break;
            }

            const profit = balance - STARTING_BALANCE;
            const roi = (profit / STARTING_BALANCE) * 100;

            // Only show realistic gains (0.01% to 5%)
            // Anything over 5% is usually "Ghost Liquidity" (API errors)
            if (roi > 0.05 && roi < 5) {
                metrics.opportunitiesFound++;
                metrics.simulatedProfit += profit;

                metrics.recentOpportunities.unshift({
                    path: path.join(' → '),
                    roi: roi.toFixed(4) + '%',
                    profit: profit.toFixed(4) + ' USDT',
                    time: new Date().toLocaleTimeString()
                });

                if (metrics.recentOpportunities.length > 20) metrics.recentOpportunities.pop();
            }
        }
    } catch (e) {
        metrics.status = "Scan Error: " + e.message;
    }
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Global HTX Arb</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: white; padding: 30px; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
                    .big { font-size: 1.8em; font-weight: bold; color: #38bdf8; }
                    .profit { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { padding: 12px; border-bottom: 1px solid #334155; text-align: left; }
                    th { color: #94a3b8; text-transform: uppercase; font-size: 0.8em; }
                </style>
            </head>
            <body>
                <h1>HTX Global Arbitrage Bot</h1>
                <p>Status: ${metrics.status}</p>
                <div class="stats">
                    <div class="card"><div>Simulated Profit</div><div class="big profit">$${metrics.simulatedProfit.toFixed(4)}</div></div>
                    <div class="card"><div>Total Scans</div><div class="big">${metrics.totalScans}</div></div>
                    <div class="card"><div>Total Loops</div><div class="big">${metrics.trianglesCount}</div></div>
                    <div class="card"><div>Opportunities</div><div class="big">${metrics.opportunitiesFound}</div></div>
                </div>
                <table>
                    <tr><th>Path</th><th>ROI</th><th>Sim Profit</th><th>Time</th></tr>
                    ${metrics.recentOpportunities.map(o => `
                        <tr><td>${o.path}</td><td style="color:#4ade80;font-weight:bold">${o.roi}</td><td>${o.profit}</td><td>${o.time}</td></tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `);
});

// --- START ---
app.listen(port, async () => {
    await findTriangles();
    setInterval(scan, 4000); // Scan every 4 seconds to respect API limits
    console.log(`Bot active on port ${port}`);
});
