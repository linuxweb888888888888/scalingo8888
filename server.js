const axios = require('axios');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00; 
const TAKER_FEE = 0.0000; // 0% Fee for KCEX Spot
const API_BASE = 'https://api.kcex.com';

// Standard Browser Headers to prevent 403 Forbidden
const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    },
    timeout: 10000
};

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
        // Added headers here to prevent 403
        const response = await axios.get(`${API_BASE}/api/v1/market/symbols`, axiosConfig);
        
        if (!response.data || !response.data.data) {
            throw new Error("Invalid API Response Structure");
        }

        const symbols = response.data.data;
        const adj = {};
        const coinSet = new Set();

        symbols.forEach(s => {
            if (s.symbol.endsWith('USDT')) {
                const base = s.symbol.replace('USDT', '');
                const quote = 'USDT';

                if (!adj[base]) adj[base] = [];
                if (!adj[quote]) adj[quote] = [];

                adj[base].push({ to: quote, pair: s.symbol, type: 'sell' });
                adj[quote].push({ to: base, pair: s.symbol, type: 'buy' });
                coinSet.add(base); coinSet.add(quote);
            }
        });

        metrics.uniqueCoins = coinSet.size;
        const paths = [];
        const startNode = 'USDT';
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
    } catch (e) {
        metrics.status = "Mapping Error: " + (e.response ? `Status ${e.response.status}` : e.message);
        console.error("Mapping Error Details:", e.message);
    }
}

// 2. Main Scanner Loop
async function startScanner() {
    try {
        // Added headers here to prevent 403
        const response = await axios.get(`${API_BASE}/api/v1/market/ticker/bookTicker`, axiosConfig);
        const tickersArr = response.data.data;
        
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
                if (!ticker || !ticker.ask || !ticker.bid || ticker.ask === 0) {
                    valid = false; break;
                }
                if (step.type === 'buy') {
                    balance = (balance / ticker.ask) * (1 - TAKER_FEE);
                } else {
                    balance = (balance * ticker.bid) * (1 - TAKER_FEE);
                }
            }

            if (!valid) continue;
            const roi = ((balance - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;

            if (roi > -1.0) {
                batchData.push({
                    path: `${path[0].pair} → ${path[1].pair} → ${path[2].pair}`,
                    roi: roi
                });
            }

            if (roi > 0.01) { 
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
        metrics.status = "Scanning Active (0% Fees)";
    } catch (e) {
        metrics.status = "Scan Error: " + (e.response ? `Status ${e.response.status}` : e.message);
    }
    setTimeout(startScanner, 3000); // Wait 3 seconds to stay safe
}

// 3. UI Dashboard
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>KCEX Monitor</title>
                <meta http-equiv="refresh" content="4">
                <style>
                    body { font-family: monospace; background: #0b0e11; color: #eaecef; padding: 20px; }
                    .card { background: #1e2329; padding: 15px; border-radius: 5px; margin-bottom: 20px; border: 1px solid #333; }
                    .green { color: #02c076; }
                    .red { color: #cf304a; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    td { padding: 8px; border-bottom: 1px solid #2b2f36; }
                    .box { background: #161a1e; padding: 10px; border-radius: 4px; }
                </style>
            </head>
            <body>
                <h2>KCEX ARBITRAGE DASHBOARD</h2>
                <div class="card">
                    Status: <span class="${metrics.status.includes('Error') ? 'red' : 'green'}">${metrics.status}</span> | 
                    Coins: ${metrics.uniqueCoins} | 
                    Total Scans: ${metrics.totalScans}
                </div>
                
                <div style="display:flex; gap: 20px;">
                    <div style="flex: 2;">
                        <h3>Live Best ROI</h3>
                        <div class="box">
                            <table>
                                ${metrics.liveAnalysis.map(a => `
                                    <tr>
                                        <td>${a.path}</td>
                                        <td class="${a.roi > 0 ? 'green' : ''}">${a.roi.toFixed(4)}%</td>
                                    </tr>
                                `).join('')}
                            </table>
                        </div>
                    </div>
                    <div style="flex: 1;">
                        <h3>Profit History</h3>
                        <div class="box" style="font-size: 0.8em;">
                            ${metrics.history.map(h => `<div>[${h.time}] <span class="green">${h.roi}</span></div>`).join('')}
                            ${metrics.history.length === 0 ? 'Watching...' : ''}
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
