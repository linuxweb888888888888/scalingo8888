const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });

// --- SETTINGS ---
const STARTING_BALANCE = 10; // Your actual capital
const TAKER_FEE = 0.0002;     // 20 bps (Standard HTX Fee)

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalVolumeTraded: 0, // Cumulative volume (The "Used" amount)
    history: [],
    status: "Initializing...",
    pathsTracked: 0,
    lastLatency: 0
};

let monitoredPaths = [];

/**
 * GRAPH SEARCH (3 to 6 Steps)
 */
async function findDeepPaths() {
    try {
        metrics.status = "Mapping market structure...";
        const markets = await exchange.loadMarkets();
        const adj = {}; 

        Object.keys(markets).forEach(symbol => {
            if (!markets[symbol].active || !symbol.includes('/')) return;
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
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }
            if (depth === 6) return;
            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    find(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        find('USDT', ['USDT'], [], 0);
        monitoredPaths = paths.sort((a, b) => a.length - b.length).slice(0, 800); 
        metrics.pathsTracked = monitoredPaths.length;
    } catch (e) { metrics.status = "Discovery Error"; }
}

/**
 * ENGINE
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

            if (roi > 0.01 && roi < 5) {
                const pathKey = path.join('>');
                const last = metrics.history.find(h => h.path === pathKey);
                
                if (!last || (Date.now() - last.ts > 10000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    
                    // CALCULATE VOLUME: Every step in the path "uses" the $10
                    const volumeUsedInThisTrade = STARTING_BALANCE * path.length;
                    metrics.totalVolumeTraded += volumeUsedInThisTrade;

                    metrics.history.unshift({
                        path: path.join(' → '),
                        steps: path.length,
                        capitalUsed: `$${STARTING_BALANCE.toFixed(2)}`,
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(4) + ' USDT',
                        time: new Date().toLocaleTimeString(),
                        ts: Date.now()
                    });
                    if (metrics.history.length > 50) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
        metrics.lastLatency = Date.now() - start;
    } catch (e) { }
    setTimeout(scan, 300);
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    // Calculate Multiplier: How many times did we flip the $10?
    const multiplier = (metrics.totalVolumeTraded / STARTING_BALANCE).toFixed(0);

    res.send(`
        <html>
            <head>
                <title>Capital Metrics Bot</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: sans-serif; background: #020617; color: white; padding: 20px; }
                    .stats { display: flex; gap: 15px; margin-bottom: 20px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 10px; border: 1px solid #334155; flex: 1; }
                    .label { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; margin-bottom: 5px; }
                    .val { font-size: 1.6em; font-weight: bold; }
                    .p { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; }
                    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
                </style>
            </head>
            <body>
                <h2>HTX Deep Arbitrage <small style="color:#64748b">Efficiency Metrics</small></h2>
                
                <div class="stats">
                    <div class="card">
                        <div class="label">Net Profit (Earned)</div>
                        <div class="val p">$${metrics.simulatedProfit.toFixed(4)}</div>
                    </div>
                    <div class="card">
                        <div class="label">Total Capital Cycled (Used)</div>
                        <div class="val">$${metrics.totalVolumeTraded.toLocaleString()} <small style="font-size:0.5em; color:#94a3b8">USDT</small></div>
                    </div>
                    <div class="card">
                        <div class="label">Wallet Rollover</div>
                        <div class="val" style="color:#38bdf8">${multiplier}x</div>
                        <div style="font-size:0.7em; color:#94a3b8">Times your $10 was traded</div>
                    </div>
                </div>

                <h3>Recent Trade Executions</h3>
                <table>
                    <tr><th>Path Strategy</th><th>Complexity</th><th>Trade Size</th><th>ROI</th><th>Net Profit</th><th>Time</th></tr>
                    ${metrics.history.map(o => `
                        <tr>
                            <td><code>${o.path}</code></td>
                            <td>${o.steps} Legs</td>
                            <td>${o.capitalUsed}</td>
                            <td class="p">${o.roi}</td>
                            <td class="p">$${o.profit}</td>
                            <td style="color:#94a3b8">${o.time}</td>
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
