const ccxt = require('ccxt');
const express = require('express');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00; // Your actual starting capital
const TAKER_FEE = 0.0002;        // 20 bps (Standard HTX Taker Fee)
const exchange = new ccxt.htx({ 'enableRateLimit': true });

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalVolume: 0,         // Cumulative turnover (Used amount)
    history: [],
    status: "Initializing...",
    lastLatency: 0,
    pathsTracked: 0
};

let monitoredPaths = [];

/**
 * PATH DISCOVERY
 * Uses Depth-Limited Search to find cycles from 3 to 5 steps starting at USDT
 */
async function findDeepPaths() {
    try {
        metrics.status = "Building market graph...";
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
            if (depth > 5) return;
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
        // Limit to 600 paths to maintain high-speed scanning on cloud CPU
        monitoredPaths = paths.sort((a, b) => a.length - b.length).slice(0, 600); 
        metrics.pathsTracked = monitoredPaths.length;
        metrics.status = "Market mapped. Starting scans...";
    } catch (e) { 
        metrics.status = "Error loading markets: " + e.message;
    }
}

/**
 * TRADE EXECUTION LOGIC
 * Correctly determines Buy/Sell direction and applies fees at every leg
 */
function executePath(path, tickers) {
    let balance = WALLET_PRINCIPAL;
    let currentCoin = 'USDT';

    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return 0;
        
        const [base, quoteRaw] = pair.split('/');
        const quote = quoteRaw.split(':')[0];

        if (currentCoin === quote) {
            // We have USDT (Quote), we want BTC (Base) -> BUY
            balance = (balance / ticker.ask) * (1 - TAKER_FEE);
            currentCoin = base;
        } else {
            // We have BTC (Base), we want USDT (Quote) -> SELL
            balance = (balance * ticker.bid) * (1 - TAKER_FEE);
            currentCoin = quote;
        }
    }
    return balance;
}

/**
 * SCANNER ENGINE
 */
async function scan() {
    const start = Date.now();
    try {
        const tickers = await exchange.fetchTickers();
        for (const path of monitoredPaths) {
            const finalBalance = executePath(path, tickers);
            const profit = finalBalance - WALLET_PRINCIPAL;
            const roi = (profit / WALLET_PRINCIPAL) * 100;

            // Threshold: 0.01% Net Profit after all fees
            if (roi > 0.01 && roi < 3) {
                const pathKey = path.join('>');
                const lastSeen = metrics.history.find(h => h.path === pathKey);
                
                // 10-second cooldown per path to prevent dashboard spam
                if (!lastSeen || (Date.now() - lastSeen.ts > 10000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    metrics.totalVolume += (WALLET_PRINCIPAL * path.length);

                    metrics.history.unshift({
                        path: path.join(' → '),
                        steps: path.length,
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(6) + ' USDT',
                        time: new Date().toLocaleTimeString(),
                        ts: Date.now()
                    });
                    if (metrics.history.length > 30) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
        metrics.lastLatency = Date.now() - start;
        metrics.status = "Running High-Speed Scan";
    } catch (e) {
        metrics.status = "Scan latency error: " + e.message;
    }
    setTimeout(scan, 400); // Respect API rate limits
}

/**
 * WEB DASHBOARD
 */
app.get('/', (req, res) => {
    const efficiency = metrics.totalVolume > 0 ? (metrics.simulatedProfit / metrics.totalVolume * 100).toFixed(4) : 0;
    res.send(`
        <html>
            <head>
                <title>HTX Arb Efficiency</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
                    .container { max-width: 1100px; margin: auto; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 30px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
                    .label { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; margin-bottom: 8px; }
                    .val { font-size: 1.5rem; font-weight: bold; color: #38bdf8; }
                    .success { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
                    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #334155; }
                    th { background: #334155; color: #94a3b8; font-size: 0.8rem; }
                    code { background: #0f172a; padding: 4px 8px; border-radius: 4px; color: #e2e8f0; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>HTX Arbitrage Realism Dashboard</h1>
                    <p style="color:#94a3b8">Status: ${metrics.status}</p>
                    
                    <div class="stats">
                        <div class="card"><div class="label">Capital Required</div><div class="val">$${WALLET_PRINCIPAL.toFixed(2)} USDT</div></div>
                        <div class="card"><div class="label">Net Profit Earned</div><div class="val success">$${metrics.simulatedProfit.toFixed(4)}</div></div>
                        <div class="card"><div class="label">Turnover (Volume Used)</div><div class="val">$${metrics.totalVolume.toLocaleString()}</div></div>
                        <div class="card"><div class="label">Capture Efficiency</div><div class="val">${efficiency}%</div><div style="font-size:0.7em; color:#94a3b8">Profit per $100 traded</div></div>
                    </div>

                    <h3>Execution Log (Latest Profit Windows)</h3>
                    <table>
                        <thead>
                            <tr><th>Path Strategy</th><th>Complexity</th><th>Net ROI</th><th>Net Win</th><th>Time</th></tr>
                        </thead>
                        <tbody>
                            ${metrics.history.map(o => `
                                <tr>
                                    <td><code>${o.path}</code></td>
                                    <td>${o.steps} Legs</td>
                                    <td class="success">${o.roi}</td>
                                    <td class="success">$${o.profit}</td>
                                    <td style="color:#64748b">${o.time}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findDeepPaths();
    scan();
    console.log(`Bot active on port ${port}`);
});
