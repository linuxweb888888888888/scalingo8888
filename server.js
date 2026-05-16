const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00;
const TAKER_FEE = 0.002; // 0.2% fee
const exchange = new ccxt.htx({ 'enableRateLimit': true });

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalVolume: 0,
    history: [],
    liveLogs: [], // New: Store the last few checks
    status: "Initializing...",
    pathsTracked: 0
};

let monitoredPaths = [];

async function findDeepPaths() {
    try {
        metrics.status = "Mapping market graph...";
        const markets = await exchange.loadMarkets();
        const adj = {}; 

        Object.keys(markets).forEach(symbol => {
            if (!markets[symbol].active || !symbol.includes('/')) return;
            const [base, quoteRaw] = symbol.split('/');
            const quote = quoteRaw.split(':')[0];
            if (!adj[base]) adj[base] = [];
            if (!adj[quote]) adj[quote] = [];
            adj[base].push({ to: quote, pair: symbol });
            adj[quote].push({ to: base, pair: symbol });
        });

        const paths = [];
        const find = (currentCoin, path, pairs, depth) => {
            if (depth > 4) return; // Reduced to 4 for faster debug scanning
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }
            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    find(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        find('USDT', ['USDT'], [], 0);
        monitoredPaths = paths.slice(0, 400); 
        metrics.pathsTracked = monitoredPaths.length;
    } catch (e) { metrics.status = "Discovery Error"; }
}

function executePath(path, tickers) {
    let balance = WALLET_PRINCIPAL;
    let currentCoin = 'USDT';
    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return null;
        const [base, quoteRaw] = pair.split('/');
        const quote = quoteRaw.split(':')[0];
        if (currentCoin === quote) {
            balance = (balance / ticker.ask) * (1 - TAKER_FEE);
            currentCoin = base;
        } else {
            balance = (balance * ticker.bid) * (1 - TAKER_FEE);
            currentCoin = quote;
        }
    }
    return balance;
}

async function scan() {
    try {
        const tickers = await exchange.fetchTickers();
        let bestPathInThisScan = null;
        let highestRoiFound = -999;

        for (const path of monitoredPaths) {
            const finalBalance = executePath(path, tickers);
            if (finalBalance === null) continue;

            const profit = finalBalance - WALLET_PRINCIPAL;
            const roi = (profit / WALLET_PRINCIPAL) * 100;

            // Track the "Best of the Batch" for the debug log
            if (roi > highestRoiFound) {
                highestRoiFound = roi;
                bestPathInThisScan = { path: path.join('→'), roi };
            }

            // Real Profit Logging
            if (roi > 0.01 && roi < 5) {
                const pathKey = path.join('>');
                const lastSeen = metrics.history.find(h => h.path === pathKey);
                if (!lastSeen || (Date.now() - lastSeen.ts > 15000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    metrics.totalVolume += (WALLET_PRINCIPAL * path.length);
                    metrics.history.unshift({
                        path: path.join(' → '),
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(6),
                        time: new Date().toLocaleTimeString(),
                        ts: Date.now()
                    });
                }
            }
        }

        // Add to Live Debug Logs
        if (bestPathInThisScan) {
            const logEntry = `[${new Date().toLocaleTimeString()}] Best candidate: ${bestPathInThisScan.path} | ROI: ${highestRoiFound.toFixed(4)}%`;
            metrics.liveLogs.unshift(logEntry);
            if (metrics.liveLogs.length > 10) metrics.liveLogs.pop();
        }

        metrics.totalScans++;
        metrics.status = `Scanning ${metrics.pathsTracked} paths...`;
    } catch (e) { metrics.status = "API Error: " + e.message; }
    setTimeout(scan, 800);
}

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Arb Debugger</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: monospace; background: #0a0a0a; color: #00ff00; padding: 20px; }
                    .card { border: 1px solid #333; padding: 15px; margin-bottom: 20px; background: #111; }
                    .log-window { background: #000; border: 1px solid #444; padding: 10px; height: 200px; overflow-y: auto; color: #aaa; font-size: 0.9em; }
                    .profit { color: #00ff00; font-weight: bold; font-size: 1.2em; }
                    .fail { color: #ff4444; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #222; }
                </style>
            </head>
            <body>
                <h1>HTX ARB DEBUGGER v1.0</h1>
                <div class="card">
                    <div>Status: ${metrics.status}</div>
                    <div>Total Scans: ${metrics.totalScans}</div>
                    <div>Paths Mapped: ${metrics.pathsTracked}</div>
                    <div class="profit">Net Profit: $${metrics.simulatedProfit.toFixed(6)} USDT</div>
                </div>

                <h3>Live Scanner Activity (Raw Output)</h3>
                <div class="log-window">
                    ${metrics.liveLogs.map(log => `<div>${log}</div>`).join('')}
                </div>

                <h3>Confirmed Profit Opportunities</h3>
                <table>
                    <tr><th>Path</th><th>Net ROI</th><th>Profit</th><th>Time</th></tr>
                    ${metrics.history.length === 0 ? '<tr><td colspan="4">No paths have cleared the 0.6% fee hurdle yet...</td></tr>' : ''}
                    ${metrics.history.map(o => `
                        <tr><td>${o.path}</td><td>${o.roi}</td><td>$${o.profit}</td><td>${o.time}</td></tr>
                    `).join('')}
                </table>

                <p style="color: #666; margin-top: 20px;">
                    Note: If "Best candidate" ROI is negative (e.g. -0.2500%), it means the price gap is too small to cover the fees. 
                    Opportunities only appear in the bottom table when ROI > 0.
                </p>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findDeepPaths();
    scan();
});
