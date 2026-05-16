const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });

const STARTING_BALANCE = 10; // $10 Paper Wallet
const TAKER_FEE = 0.001;     // 20 bps

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    history: [],
    status: "Initializing...",
    pathsTracked: 0,
    lastLatency: 0
};

let monitoredPaths = [];

/**
 * GRAPH-BASED PATH FINDER (Depth-Limited Search)
 * Finds loops from 3 to 6 steps
 */
async function findDeepPaths() {
    try {
        metrics.status = "Building market graph...";
        const markets = await exchange.loadMarkets();
        const adj = {}; // Adjacency list

        // Build the graph: { 'BTC': ['USDT', 'ETH', ...], 'USDT': ['BTC', ...] }
        Object.keys(markets).forEach(symbol => {
            if (!markets[symbol].active) return;
            const [base, quote] = symbol.split('/');
            const q = quote.split(':')[0];
            if (!adj[base]) adj[base] = [];
            if (!adj[q]) adj[q] = [];
            adj[base].push({ to: q, pair: symbol });
            adj[q].push({ to: base, pair: symbol });
        });

        const paths = [];
        const find = (currentCoin, path, pairs, depth) => {
            if (depth > 6) return;
            
            // If we found a way back to USDT and it's at least 3 steps
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }

            if (depth === 6) return; // Max depth reached

            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                // Avoid visiting the same coin twice in one loop (except USDT at end)
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    find(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        // Start search from USDT
        find('USDT', ['USDT'], [], 0);

        // Sort by length (shortest first) and take the top 1000 most interesting
        monitoredPaths = paths
            .sort((a, b) => a.length - b.length)
            .slice(0, 1000); 

        metrics.pathsTracked = monitoredPaths.length;
        metrics.status = `Monitoring ${monitoredPaths.length} deep loops`;
    } catch (e) { console.error(e); }
}

/**
 * ENGINE: Executes the chain of trades
 */
function executePath(path, tickers) {
    let balance = STARTING_BALANCE;
    let currentCoin = 'USDT';

    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return 0;
        
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
    const start = Date.now();
    try {
        const tickers = await exchange.fetchTickers();
        for (const path of monitoredPaths) {
            const final = executePath(path, tickers);
            const profit = final - STARTING_BALANCE;
            const roi = (profit / STARTING_BALANCE) * 100;

            // Threshold: 0.01% profit after all fees
            if (roi > 0.01 && roi < 5) {
                const pathKey = path.join('>');
                const last = metrics.history.find(h => h.path === pathKey);
                
                if (!last || (Date.now() - last.ts > 15000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    metrics.history.unshift({
                        path: path.join(' → '),
                        steps: path.length,
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(4) + ' USDT',
                        time: new Date().toLocaleTimeString(),
                        ts: Date.now()
                    });
                    if (metrics.history.length > 100) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
        metrics.lastLatency = Date.now() - start;
    } catch (e) { }
    setTimeout(scan, 500); // 500ms delay to handle large graph processing
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Deep Arb Bot</title><meta http-equiv="refresh" content="5">
            <style>
                body { font-family: sans-serif; background: #020617; color: white; padding: 20px; }
                .stats { display: flex; gap: 15px; margin-bottom: 20px; }
                .card { background: #1e293b; padding: 15px; border-radius: 8px; border: 1px solid #334155; flex: 1; }
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 10px; border-bottom: 1px solid #334155; text-align: left; }
                .p { color: #4ade80; font-weight: bold; }
                .step-tag { background: #334155; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; }
            </style>
            </head>
            <body>
                <h2>HTX Deep Arbitrage <small style="color:#64748b">Up to 6-Step Paths</small></h2>
                <div class="stats">
                    <div class="card">Total Profit<br><span class="p" style="font-size:1.4em">$${metrics.simulatedProfit.toFixed(4)}</span></div>
                    <div class="card">Latency<br><span style="font-size:1.4em">${metrics.lastLatency}ms</span></div>
                    <div class="card">Paths Active<br><span style="font-size:1.4em">${metrics.pathsTracked}</span></div>
                </div>
                <table>
                    <tr><th>Path Strategy</th><th>Complexity</th><th>ROI</th><th>Profit</th><th>Time</th></tr>
                    ${metrics.history.map(o => `
                        <tr>
                            <td><code>${o.path}</code></td>
                            <td><span class="step-tag">${o.steps} Steps</span></td>
                            <td class="p">${o.roi}</td>
                            <td class="p">$${o.profit}</td>
                            <td>${o.time}</td>
                        </tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findDeepPaths();
    scan();
});
