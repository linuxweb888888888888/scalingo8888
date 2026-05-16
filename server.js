const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00; 
const TAKER_FEE = 0.0002; 
const exchange = new ccxt.htx({ 'enableRateLimit': true });

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    totalTurnover: 0,
    history: [],
    systemLogs: [],      // Engine events
    liveAnalysis: [],    // Current "best" failures or wins
    status: "Initializing...",
    pathsTracked: 0
};

let monitoredPaths = [];

// Helper to add logs
function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    metrics.systemLogs.unshift(`[${time}] ${msg}`);
    if (metrics.systemLogs.length > 15) metrics.systemLogs.pop();
}

/**
 * 1. GRAPH BUILDER
 */
async function mapAllMarkets() {
    try {
        addLog("Fetching market data from HTX...");
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const adj = {}; 

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

        addLog("Analyzing connections for 3-5 step loops...");
        const paths = [];
        const findCycles = (currentCoin, path, pairs, depth) => {
            if (depth > 5) return;
            if (currentCoin === 'USDT' && depth >= 3) {
                paths.push([...pairs]);
                return;
            }
            if (depth === 5) return;
            const neighbors = adj[currentCoin] || [];
            for (const edge of neighbors) {
                if (!path.includes(edge.to) || (edge.to === 'USDT' && depth >= 2)) {
                    findCycles(edge.to, [...path, edge.to], [...pairs, edge.pair], depth + 1);
                }
            }
        };

        findCycles('USDT', ['USDT'], [], 0);
        monitoredPaths = Array.from(new Set(paths.map(JSON.stringify)), JSON.parse).slice(0, 1500);
        metrics.pathsTracked = monitoredPaths.length;
        addLog(`Engine Ready. Monitoring ${monitoredPaths.length} paths.`);
    } catch (e) { addLog("Error: " + e.message); }
}

/**
 * 2. CORE CALCULATION
 */
function calculateStep(balance, pair, currentCoin, tickers) {
    const ticker = tickers[pair];
    if (!ticker || !ticker.ask || !ticker.bid) return null;
    const [base, quoteRaw] = pair.split('/');
    const quote = quoteRaw.split(':')[0];

    if (currentCoin === quote) {
        return { 
            amount: (balance / ticker.ask) * (1 - TAKER_FEE), 
            nextCoin: base,
            action: 'BUY' 
        };
    } else {
        return { 
            amount: (balance * ticker.bid) * (1 - TAKER_FEE), 
            nextCoin: quote,
            action: 'SELL' 
        };
    }
}

async function startScanner() {
    try {
        addLog(`Scan #${metrics.totalScans + 1} starting...`);
        const tickers = await exchange.fetchTickers();
        let currentBatchAnalysis = [];

        for (const path of monitoredPaths) {
            let balance = WALLET_PRINCIPAL;
            let currentCoin = 'USDT';
            let validPath = true;

            for (const pair of path) {
                const step = calculateStep(balance, pair, currentCoin, tickers);
                if (!step) { validPath = false; break; }
                balance = step.amount;
                currentCoin = step.nextCoin;
            }

            if (!validPath) continue;

            const profit = balance - WALLET_PRINCIPAL;
            const roi = (profit / WALLET_PRINCIPAL) * 100;

            // Track for live analysis window (Top 5 closest to profit)
            currentBatchAnalysis.push({ path: path.join('→'), roi });

            if (roi > 0.01 && roi < 5) {
                const pathStr = path.join(' → ');
                metrics.opportunitiesFound++;
                metrics.simulatedProfit += profit;
                metrics.totalTurnover += (WALLET_PRINCIPAL * path.length);
                metrics.history.unshift({
                    path: pathStr,
                    roi: roi.toFixed(4) + '%',
                    profit: profit.toFixed(6),
                    time: new Date().toLocaleTimeString()
                });
                if (metrics.history.length > 20) metrics.history.pop();
                addLog(`PROFIT FOUND: ${pathStr} (${roi.toFixed(3)}%)`);
            }
        }

        // Update Analysis Window with top 5 candidates of this scan
        metrics.liveAnalysis = currentBatchAnalysis
            .sort((a, b) => b.roi - a.roi)
            .slice(0, 5);

        metrics.totalScans++;
        addLog(`Scan #${metrics.totalScans} complete. Found ${currentBatchAnalysis.length} valid paths.`);
    } catch (e) { addLog("Scan Error: " + e.message); }
    setTimeout(startScanner, 1000);
}

/**
 * 3. WEB DASHBOARD
 */
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Engine Log - HTX Arb</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: 'Courier New', monospace; background: #0a0f1e; color: #cbd5e1; padding: 20px; line-height: 1.4; }
                    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
                    .card { background: #1e293b; padding: 15px; border-radius: 8px; border-left: 4px solid #38bdf8; }
                    .panel { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                    .log-box { background: #000; border: 1px solid #334155; padding: 15px; height: 300px; overflow-y: auto; font-size: 0.85em; }
                    .green { color: #4ade80; }
                    .blue { color: #38bdf8; }
                    .gold { color: #fbbf24; }
                    table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #1e293b; }
                    h3 { border-bottom: 1px solid #334155; padding-bottom: 5px; color: #f8fafc; }
                </style>
            </head>
            <body>
                <h2>HTX ARBITRAGE ENGINE <small class="blue">v2.0 High-Speed</small></h2>
                
                <div class="stats">
                    <div class="card">Net Profit<br><span class="green" style="font-size:1.4em">$${metrics.simulatedProfit.toFixed(6)}</span></div>
                    <div class="card">Total Scans<br><span class="gold" style="font-size:1.4em">${metrics.totalScans}</span></div>
                    <div class="card">Paths Tracked<br><span style="font-size:1.4em">${metrics.pathsTracked}</span></div>
                    <div class="card">Turnover Used<br><span class="blue" style="font-size:1.4em">$${metrics.totalTurnover.toLocaleString()}</span></div>
                </div>

                <div class="panel">
                    <div>
                        <h3>Live Scanner Analysis (Current Batch)</h3>
                        <div class="log-box">
                            <table>
                                <tr><th>Path Loop</th><th>ROI %</th></tr>
                                ${metrics.liveAnalysis.map(a => `
                                    <tr>
                                        <td>${a.path}</td>
                                        <td class="${a.roi > 0 ? 'green' : ''}">${a.roi.toFixed(4)}%</td>
                                    </tr>
                                `).join('')}
                            </table>
                            <p style="font-size: 0.8em; color: #64748b; margin-top: 10px;">
                                * ROI must be > 0.00% to clear the 0.6% fee hurdle.
                            </p>
                        </div>
                    </div>
                    <div>
                        <h3>System Event Log</h3>
                        <div class="log-box">
                            ${metrics.systemLogs.map(l => `<div>${l}</div>`).join('')}
                        </div>
                    </div>
                </div>

                <h3>Confirmed Profit History</h3>
                <table>
                    <tr style="color:#94a3b8"><th>Path Strategy</th><th>Complexity</th><th>Net ROI</th><th>Profit</th><th>Time</th></tr>
                    ${metrics.history.map(h => `
                        <tr><td class="blue"><code>${h.path}</code></td><td>${h.path.split('→').length} steps</td><td class="green">${h.roi}</td><td class="green">$${h.profit}</td><td>${h.time}</td></tr>
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
