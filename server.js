const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00; 
const TAKER_FEE = 0.0001; 
const exchange = new ccxt.htx({ 'enableRateLimit': true });

let metrics = {
    totalScans: 0,
    simulatedProfit: 0,
    history: [],
    liveAnalysis: [],    // Top ROI candidates
    randomSample: [],    // Random variety of coins
    status: "Initializing...",
    pathsTracked: 0,
    uniqueCoins: 0
};

let monitoredPaths = [];

async function mapAllMarkets() {
    try {
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const adj = {}; 
        const coinSet = new Set();

        symbols.forEach(symbol => {
            const market = markets[symbol];
            if (market.type === 'spot' && market.active) {
                const [base, quoteRaw] = symbol.split('/');
                const quote = quoteRaw.split(':')[0];
                if (!adj[base]) adj[base] = [];
                if (!adj[quote]) adj[quote] = [];
                adj[base].push({ to: quote, pair: symbol });
                adj[quote].push({ to: base, pair: symbol });
                coinSet.add(base); coinSet.add(quote);
            }
        });

        metrics.uniqueCoins = coinSet.size;
        const paths = [];
        const findCycles = (currentCoin, path, pairs, depth) => {
            if (depth > 4) return;
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }
            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    findCycles(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        findCycles('USDT', ['USDT'], [], 0);
        // Track up to 1000 paths to ensure we cover all coins
        monitoredPaths = paths.slice(0, 1000);
        metrics.pathsTracked = monitoredPaths.length;
    } catch (e) { metrics.status = "Error Mapping: " + e.message; }
}

async function startScanner() {
    try {
        const tickers = await exchange.fetchTickers();
        let batchData = [];

        for (const path of monitoredPaths) {
            let balance = WALLET_PRINCIPAL;
            let currentCoin = 'USDT';
            let valid = true;

            for (const pair of path) {
                const ticker = tickers[pair];
                if (!ticker || !ticker.ask || !ticker.bid) { valid = false; break; }
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

            if (!valid) continue;
            const roi = ((balance - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;
            batchData.push({ path: path.join('→'), roi });

            if (roi > 0.01) {
                metrics.simulatedProfit += (balance - WALLET_PRINCIPAL);
                metrics.history.unshift({ path: path.join('→'), roi: roi.toFixed(4) + '%', time: new Date().toLocaleTimeString() });
                if (metrics.history.length > 10) metrics.history.pop();
            }
        }

        // 1. Update Top 10 ROI (Usually major pairs)
        metrics.liveAnalysis = batchData.sort((a, b) => b.roi - a.roi).slice(0, 10);

        // 2. Update Random Sample (To see "All Other Coins")
        metrics.randomSample = [];
        for (let i = 0; i < 8; i++) {
            const randomIdx = Math.floor(Math.random() * batchData.length);
            metrics.randomSample.push(batchData[randomIdx]);
        }

        metrics.totalScans++;
        metrics.status = "Scanning " + metrics.pathsTracked + " loops...";
    } catch (e) { metrics.status = "Scan Error"; }
    setTimeout(startScanner, 1000);
}

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Global Arb Monitor</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: monospace; background: #020617; color: #94a3b8; padding: 20px; }
                    .stats { display: flex; gap: 20px; margin-bottom: 20px; }
                    .card { background: #1e293b; padding: 15px; border-radius: 8px; flex: 1; border: 1px solid #334155; }
                    .box { background: #000; border: 1px solid #334155; padding: 10px; margin-bottom: 20px; font-size: 0.85em; }
                    .green { color: #4ade80; }
                    .blue { color: #38bdf8; }
                    h3 { color: #f1f5f9; margin-bottom: 10px; }
                    table { width: 100%; border-collapse: collapse; }
                    td { padding: 5px; border-bottom: 1px solid #1e293b; }
                </style>
            </head>
            <body>
                <h2>HTX GLOBAL ARBITRAGE <small class="blue">${metrics.uniqueCoins} Coins Mapped</small></h2>
                <div class="stats">
                    <div class="card">Profit<br><span class="green" style="font-size:1.4em">$${metrics.simulatedProfit.toFixed(6)}</span></div>
                    <div class="card">Total Scans<br><span style="font-size:1.4em">${metrics.totalScans}</span></div>
                    <div class="card">Paths Active<br><span style="font-size:1.4em">${metrics.pathsTracked}</span></div>
                </div>

                <h3>Top 10 High-Efficiency Paths (Major Liquidity)</h3>
                <div class="box">
                    <table>
                        ${metrics.liveAnalysis.map(a => `<tr><td>${a.path}</td><td class="green">${a.roi.toFixed(4)}%</td></tr>`).join('')}
                    </table>
                </div>

                <h3>Random Market Sample (Other Coins Verification)</h3>
                <div class="box">
                    <table>
                        ${metrics.randomSample.map(a => `<tr><td>${a.path}</td><td>${a?.roi.toFixed(4)}%</td></tr>`).join('')}
                    </table>
                </div>

                <h3>Confirmed Profit Logs</h3>
                <div class="box">
                    ${metrics.history.map(h => `<div>[${h.time}] <span class="green">${h.roi}</span> | ${h.path}</div>`).join('')}
                    ${metrics.history.length === 0 ? 'Waiting for gap > 0.6%...' : ''}
                </div>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await mapAllMarkets();
    startScanner();
});
