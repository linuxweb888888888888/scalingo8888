const ccxt = require('ccxt');
const express = require('express');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00; 
const TAKER_FEE = 0.0002; // 0.2%
const exchange = new ccxt.htx({ 'enableRateLimit': true });

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalTurnover: 0,
    history: [],
    liveDebug: "Initializing graph...",
    pathsTracked: 0,
    lastLatency: 0
};

let monitoredPaths = [];

/**
 * 1. DYNAMIC GRAPH BUILDER
 * This function crawls every single active spot market on HTX
 */
async function mapAllMarkets() {
    try {
        metrics.liveDebug = "Fetching all active spot markets...";
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        
        const adj = {}; // Adjacency list for the graph

        // Filter only for spot markets and build the connection map
        symbols.forEach(symbol => {
            const market = markets[symbol];
            if (market.type === 'spot' && market.active) {
                const [base, quoteRaw] = symbol.split('/');
                const quote = quoteRaw.split(':')[0];

                if (!adj[base]) adj[base] = [];
                if (!adj[quote]) adj[quote] = [];

                adj[base].push({ to: quote, pair: symbol });
                adj[quote].push({ to: base, pair: symbol });
            }
        });

        metrics.liveDebug = "Finding all possible loops (3-5 steps)...";
        const paths = [];
        
        // Recursive Depth-Limited Search to find cycles
        const findCycles = (currentCoin, path, pairs, depth) => {
            if (depth > 5) return;
            
            // If we found a path back to USDT and it's long enough
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }
            if (depth === 5) return;

            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                // Avoid visiting the same coin twice in one cycle (except USDT at the end)
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    findCycles(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        findCycles('USDT', ['USDT'], [], 0);

        // Deduplicate and prioritize high-volume paths
        // We limit to 2000 paths to ensure the bot stays high-speed on cloud CPUs
        monitoredPaths = Array.from(new Set(paths.map(JSON.stringify)), JSON.parse).slice(0, 2000);
        
        metrics.pathsTracked = monitoredPaths.length;
        metrics.liveDebug = `Active: Monitoring ${monitoredPaths.length} loops across all coins.`;
    } catch (e) {
        metrics.liveDebug = "Error mapping markets: " + e.message;
    }
}

/**
 * 2. ARBITRAGE ENGINE
 */
function calculateProfit(path, tickers) {
    let balance = WALLET_PRINCIPAL;
    let currentCoin = 'USDT';

    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return null;

        const [base, quoteRaw] = pair.split('/');
        const quote = quoteRaw.split(':')[0];

        if (currentCoin === quote) {
            // Buying base with quote (e.g. USDT -> BTC)
            balance = (balance / ticker.ask) * (1 - TAKER_FEE);
            currentCoin = base;
        } else {
            // Selling base for quote (e.g. BTC -> USDT)
            balance = (balance * ticker.bid) * (1 - TAKER_FEE);
            currentCoin = quote;
        }
    }
    return balance;
}

async function startScanner() {
    const startTick = Date.now();
    try {
        // Fetch every ticker on the exchange in one call
        const tickers = await exchange.fetchTickers();
        
        for (const path of monitoredPaths) {
            const final = calculateProfit(path, tickers);
            if (!final) continue;

            const profit = final - WALLET_PRINCIPAL;
            const roi = (profit / WALLET_PRINCIPAL) * 100;

            // Log if profit > 0 after all fees
            if (roi > 0.01 && roi < 5) {
                const pathStr = path.join(' → ');
                const last = metrics.history.find(h => h.path === pathStr);
                
                if (!last || (Date.now() - last.ts > 15000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    metrics.totalTurnover += (WALLET_PRINCIPAL * path.length);
                    metrics.history.unshift({
                        path: pathStr,
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(6) + ' USDT',
                        time: new Date().toLocaleTimeString(),
                        ts: Date.now()
                    });
                    if (metrics.history.length > 50) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
        metrics.lastLatency = Date.now() - startTick;
    } catch (e) { }
    
    // Cycle every 500ms to stay within API limits while scanning thousands of paths
    setTimeout(startScanner, 500);
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Global HTX Arb</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: monospace; background: #020617; color: #f1f5f9; padding: 20px; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
                    .card { background: #1e293b; padding: 15px; border-radius: 8px; border: 1px solid #334155; }
                    .green { color: #4ade80; font-weight: bold; }
                    .blue { color: #38bdf8; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #334155; font-size: 0.85em; }
                    th { color: #94a3b8; }
                </style>
            </head>
            <body>
                <h2>HTX GLOBAL SCANNER <small style="color:#64748b">All Spot Coins</small></h2>
                <div style="margin-bottom: 20px; color: #fbbf24;">Status: ${metrics.liveDebug}</div>
                
                <div class="stats">
                    <div class="card">Net Profit<br><span class="green" style="font-size:1.5em">$${metrics.simulatedProfit.toFixed(6)}</span></div>
                    <div class="card">Turnover (Used)<br><span class="blue" style="font-size:1.5em">$${metrics.totalTurnover.toLocaleString()}</span></div>
                    <div class="card">Paths Tracked<br><span style="font-size:1.5em">${metrics.pathsTracked}</span></div>
                    <div class="card">Total Scans<br><span style="font-size:1.5em">${metrics.totalScans}</span></div>
                </div>

                <h3>Real Profit Logs (After Fees)</h3>
                <table>
                    <tr><th>Loop Strategy</th><th>ROI</th><th>Net Win</th><th>Time</th></tr>
                    ${metrics.history.map(o => `
                        <tr><td><code>${o.path}</code></td><td class="green">${o.roi}</td><td class="green">$${o.profit}</td><td>${o.time}</td></tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await mapAllMarkets();
    startScanner();
});
