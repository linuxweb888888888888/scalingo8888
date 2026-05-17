const axios = require('axios');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 100.00;
const TAKER_FEE = 0; // KCEX Spot Taker fee is typically 0.1%
const API_BASE = 'https://api.kcex.com';

let metrics = {
    totalScans: 0,
    simulatedProfit: 0,
    history: [],
    liveAnalysis: [],
    status: "Initializing...",
    pathsTracked: 0,
    uniqueCoins: 0
};

let monitoredPaths = [];

// 1. Fetch Markets and Map Triangular Paths
async function mapKcexMarkets() {
    try {
        console.log("Fetching KCEX Market Data...");
        const response = await axios.get(`${API_BASE}/api/v1/market/symbols`);
        const symbols = response.data.data; // KCEX returns list of symbols
        
        const adj = {};
        const coinSet = new Set();

        symbols.forEach(s => {
            // KCEX symbol format is usually "BTCUSDT"
            // We need to parse these. Usually, Quote is USDT.
            if (s.symbol.endsWith('USDT')) {
                const base = s.symbol.replace('USDT', '');
                const quote = 'USDT';

                if (!adj[base]) adj[base] = [];
                if (!adj[quote]) adj[quote] = [];

                // Store relation
                adj[base].push({ to: quote, pair: s.symbol, type: 'sell' });
                adj[quote].push({ to: base, pair: s.symbol, type: 'buy' });
                coinSet.add(base); coinSet.add(quote);
            } else {
                // Handle cross pairs like ETHBTC if they exist on KCEX spot
                // For now, most KCEX liquidity is in USDT pairs.
            }
        });

        metrics.uniqueCoins = coinSet.size;
        const paths = [];
        const startNode = 'USDT';

        // Logic: USDT -> CoinA -> CoinB -> USDT
        const neighborsA = adj[startNode] || [];
        neighborsA.forEach(edge1 => {
            const coinA = edge1.to;
            const neighborsB = adj[coinA] || [];

            neighborsB.forEach(edge2 => {
                const coinB = edge2.to;
                if (coinB === startNode) return;

                const neighborsC = adj[coinB] || [];
                neighborsC.forEach(edge3 => {
                    if (edge3.to === startNode) {
                        paths.push([edge1, edge2, edge3]);
                    }
                });
            });
        });

        monitoredPaths = paths;
        metrics.pathsTracked = monitoredPaths.length;
        metrics.status = "KCEX Scanner Ready";
        console.log(`Mapped ${metrics.pathsTracked} paths on KCEX.`);
    } catch (e) {
        metrics.status = "Mapping Error: " + e.message;
    }
}

// 2. Main Scanner Loop
async function startScanner() {
    try {
        // KCEX Book Ticker gives us best Bid/Ask for all symbols
        const response = await axios.get(`${API_BASE}/api/v1/market/ticker/bookTicker`);
        const tickersArr = response.data.data;
        
        // Convert array to object for O(1) lookup
        const tickers = {};
        tickersArr.forEach(t => {
            tickers[t.symbol] = {
                bid: parseFloat(t.bidPrice),
                ask: parseFloat(t.askPrice)
            };
        });

        let batchData = [];

        for (const path of monitoredPaths) {
            let balance = WALLET_PRINCIPAL;
            let valid = true;

            for (const step of path) {
                const ticker = tickers[step.pair];
                if (!ticker || !ticker.ask || !ticker.bid) {
                    valid = false; break;
                }

                if (step.type === 'buy') {
                    // Buying the base (e.g., USDT -> BTC)
                    balance = (balance / ticker.ask) * (1 - TAKER_FEE);
                } else {
                    // Selling the base (e.g., BTC -> USDT)
                    balance = (balance * ticker.bid) * (1 - TAKER_FEE);
                }
            }

            if (!valid) continue;

            const roi = ((balance - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;

            if (roi > -1.5) {
                batchData.push({
                    path: `${path[0].pair} → ${path[1].pair} → ${path[2].pair}`,
                    roi: roi
                });
            }

            if (roi > 0.05) { // Log if profit > 0.05%
                metrics.simulatedProfit += (balance - WALLET_PRINCIPAL);
                metrics.history.unshift({
                    path: `${path[0].pair} → ${path[1].pair} → ${path[2].pair}`,
                    roi: roi.toFixed(4) + '%',
                    time: new Date().toLocaleTimeString()
                });
                if (metrics.history.length > 15) metrics.history.pop();
            }
        }

        metrics.liveAnalysis = batchData.sort((a, b) => b.roi - a.roi).slice(0, 15);
        metrics.totalScans++;
    } catch (e) {
        metrics.status = "Scan Error: " + e.message;
    }
    setTimeout(startScanner, 2000); 
}

// 3. Express Dashboard
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>KCEX Arbitrage Monitor</title>
                <meta http-equiv="refresh" content="3">
                <style>
                    body { font-family: 'Segoe UI', sans-serif; background: #0b0e11; color: #eaecef; padding: 20px; }
                    .container { max-width: 1000px; margin: auto; }
                    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
                    .card { background: #1e2329; padding: 20px; border-radius: 8px; border: 1px solid #333; text-align: center; }
                    .box { background: #1e2329; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
                    .green { color: #02c076; }
                    table { width: 100%; border-collapse: collapse; }
                    td, th { padding: 10px; text-align: left; border-bottom: 1px solid #2b2f36; }
                    .header { display: flex; justify-content: space-between; align-items: center; }
                    .status-dot { height: 10px; width: 10px; background-color: #02c076; border-radius: 50%; display: inline-block; margin-right: 5px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2>KCEX TRIANGULAR MONITOR</h2>
                        <div><span class="status-dot"></span> ${metrics.status}</div>
                    </div>
                    
                    <div class="stats">
                        <div class="card">Simulated Profit<br><span class="green" style="font-size:1.8em">$${metrics.simulatedProfit.toFixed(6)}</span></div>
                        <div class="card">Unique Coins<br><span style="font-size:1.8em">${metrics.uniqueCoins}</span></div>
                        <div class="card">Paths Scanned<br><span style="font-size:1.8em">${(metrics.totalScans * metrics.pathsTracked).toLocaleString()}</span></div>
                    </div>

                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px;">
                        <div>
                            <h3>Real-time Opportunities</h3>
                            <div class="box">
                                <table>
                                    <thead><tr><th>Path</th><th>ROI</th></tr></thead>
                                    <tbody>
                                        ${metrics.liveAnalysis.map(a => `
                                            <tr>
                                                <td>${a.path}</td>
                                                <td class="${a.roi > 0 ? 'green' : ''}">${a.roi.toFixed(4)}%</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <div>
                            <h3>Profit Log</h3>
                            <div class="box" style="font-size: 0.85em; max-height: 400px; overflow-y: auto;">
                                ${metrics.history.map(h => `
                                    <div style="margin-bottom: 8px; border-bottom: 1px solid #2b2f36; padding-bottom: 4px;">
                                        <span class="green">${h.roi}</span><br>
                                        <small>${h.path}</small>
                                    </div>
                                `).join('')}
                                ${metrics.history.length === 0 ? 'Scanning for gaps...' : ''}
                            </div>
                        </div>
                    </div>
                </div>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await mapKcexMarkets();
    startScanner();
});
