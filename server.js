const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });

// --- REALISTIC SETTINGS ---
const WALLET_PRINCIPAL = 10.00; // The only money you actually "own"
const TAKER_FEE = 0.0005;        // 20 bps

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalVolume: 0,         // Cumulative Trading Volume (Turnover)
    history: [],
    status: "Initializing...",
    lastLatency: 0
};

let monitoredPaths = [];

// Graph Search logic (truncated for brevity - same logic as before)
async function findDeepPaths() {
    try {
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
            if (depth > 5) return;
            if (currentCoin === 'USDT' && depth >= 3) { paths.push([...pairs]); return; }
            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    find(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };
        find('USDT', ['USDT'], [], 0);
        monitoredPaths = paths.slice(0, 500); 
    } catch (e) { metrics.status = "Error"; }
}

function executePath(path, tickers) {
    let balance = WALLET_PRINCIPAL;
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
            const profit = final - WALLET_PRINCIPAL;
            const roi = (profit / WALLET_PRINCIPAL) * 100;

            if (roi > 0.01 && roi < 3) {
                const pathKey = path.join('>');
                const last = metrics.history.find(h => h.path === pathKey);
                if (!last || (Date.now() - last.ts > 10000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    metrics.totalVolume += (WALLET_PRINCIPAL * path.length); // Correct Turnover calculation

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
    } catch (e) { }
    setTimeout(scan, 400);
}

// --- REALISTIC DASHBOARD ---
app.get('/', (req, res) => {
    // Efficiency: How many cents of profit did we get for every $100 of volume?
    const efficiency = metrics.totalVolume > 0 ? (metrics.simulatedProfit / metrics.totalVolume * 100).toFixed(4) : 0;

    res.send(`
        <html>
            <head>
                <title>Realistic Arb Metrics</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
                    .container { max-width: 1000px; margin: auto; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
                    .label { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
                    .val { font-size: 1.5rem; font-weight: 700; color: #38bdf8; }
                    .success { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
                    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #334155; font-size: 0.9rem; }
                    th { background: #334155; color: #94a3b8; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Arbitrage Realism Dashboard</h1>
                    
                    <div class="stats">
                        <div class="card">
                            <div class="label">Actual Capital Required</div>
                            <div class="val">$${WALLET_PRINCIPAL.toFixed(2)} <small style="font-size:0.5em">USDT</small></div>
                        </div>
                        <div class="card">
                            <div class="label">Net Profit Earned</div>
                            <div class="val success">$${metrics.simulatedProfit.toFixed(4)}</div>
                        </div>
                        <div class="card">
                            <div class="label">Market Turnover (Volume)</div>
                            <div class="val" style="color: #f8fafc;">$${metrics.totalVolume.toLocaleString()}</div>
                        </div>
                        <div class="card">
                            <div class="label">Capture Efficiency</div>
                            <div class="val">${efficiency}%</div>
                            <div style="font-size:0.7em; color:#94a3b8">Profit per $100 traded</div>
                        </div>
                    </div>

                    <h3>Execution Log</h3>
                    <table>
                        <tr><th>Path</th><th>Complexity</th><th>ROI</th><th>Net Win</th><th>Time</th></tr>
                        ${metrics.history.map(o => `
                            <tr>
                                <td><code>${o.path}</code></td>
                                <td>${o.steps} Steps</td>
                                <td class="success">${o.roi}</td>
                                <td class="success">$${o.profit}</td>
                                <td style="color:#64748b">${o.time}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findDeepPaths();
    scan();
});
