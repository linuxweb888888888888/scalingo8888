const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });

const STARTING_BALANCE = 10;
const STD_FEE = 0.0002; // 20 bps

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    history: [],
    status: "Initializing...",
    pathsTracked: 0
};

let allPaths = [];

/**
 * ADVANCED PATH FINDER
 * Finds 3-step and 4-step loops and ranks them by 24h Volume
 */
async function findAdvancedPaths() {
    try {
        metrics.status = "Deep mapping market structures...";
        const markets = await exchange.loadMarkets();
        const tickers = await exchange.fetchTickers(); // Get volume data
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];

        const base = 'USDT';
        const usdtPairs = symbols.filter(s => s.includes(base));

        for (const pair1 of usdtPairs) {
            const parts1 = pair1.split('/');
            const alt1 = parts1[0] === base ? parts1[1].split(':')[0] : parts1[0];
            
            // Look for intermediate steps
            const alt1Pairs = symbols.filter(s => s.includes(alt1) && !s.includes(base));

            for (const pair2 of alt1Pairs) {
                const parts2 = pair2.split('/');
                const alt2 = parts2[0] === alt1 ? parts2[1].split(':')[0] : parts2[0];

                // OPTION A: 3-Step (Triangular)
                const pair3Tri = symbols.find(s => s === `${alt2}/${base}` || s === `${base}/${alt2}`);
                if (pair3Tri) {
                    paths.push({ steps: [pair1, pair2, pair3Tri], vol: (tickers[pair1]?.quoteVolume || 0) });
                }

                // OPTION B: 4-Step (Quadrangular)
                const alt2Pairs = symbols.filter(s => s.includes(alt2) && !s.includes(alt1) && !s.includes(base));
                for (const pair3Quad of alt2Pairs) {
                    const parts3 = pair3Quad.split('/');
                    const alt3 = parts3[0] === alt2 ? parts3[1].split(':')[0] : parts3[0];
                    const pair4Quad = symbols.find(s => s === `${alt3}/${base}` || s === `${base}/${alt3}`);
                    
                    if (pair4Quad) {
                        paths.push({ steps: [pair1, pair2, pair3Quad, pair4Quad], vol: (tickers[pair1]?.quoteVolume || 0) });
                    }
                }
            }
        }

        // Sort by volume (highest first) and remove duplicates
        const sorted = paths.sort((a, b) => b.vol - a.vol);
        allPaths = Array.from(new Set(sorted.map(p => JSON.stringify(p.steps))), JSON.parse).slice(0, 600);
        
        metrics.pathsTracked = allPaths.length;
        metrics.status = `Monitoring ${allPaths.length} high-volume loops`;
    } catch (e) { console.error("Discovery Error:", e); }
}

/**
 * CALCULATOR ENGINE (Handles N-step paths)
 */
function runPath(path, tickers) {
    let balance = STARTING_BALANCE;
    let currentCoin = 'USDT';

    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return 0;
        
        const [base, quoteRaw] = pair.split('/');
        const quote = quoteRaw.split(':')[0];

        if (currentCoin === quote) {
            balance = (balance / ticker.ask) * (1 - STD_FEE);
            currentCoin = base;
        } else {
            balance = (balance * ticker.bid) * (1 - STD_FEE);
            currentCoin = quote;
        }
    }
    return balance;
}

async function fastScan() {
    try {
        const tickers = await exchange.fetchTickers();
        for (const path of allPaths) {
            const finalBalance = runPath(path, tickers);
            const netProfit = finalBalance - STARTING_BALANCE;
            const roi = (netProfit / STARTING_BALANCE) * 100;

            // Log if profitable after fees (Adjusted threshold for 4-step)
            const minRoi = path.length === 3 ? 0.02 : 0.04; 

            if (roi > minRoi && roi < 3) {
                const pathStr = path.join(' → ');
                const lastSeen = metrics.history.find(h => h.path === pathStr);
                
                if (!lastSeen || (Date.now() - lastSeen.timestamp > 10000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += netProfit;
                    metrics.history.unshift({
                        path: pathStr,
                        steps: path.length,
                        roi: roi.toFixed(3) + '%',
                        profit: netProfit.toFixed(4) + ' USDT',
                        time: new Date().toLocaleTimeString(),
                        timestamp: Date.now()
                    });
                    if (metrics.history.length > 500) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
    } catch (e) { }
    setTimeout(fastScan, 250); // Slightly more delay to handle 600 paths
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Advanced Arb Bot</title><meta http-equiv="refresh" content="10">
            <style>
                body { font-family: sans-serif; background: #020617; color: white; padding: 20px; }
                .grid { display: flex; gap: 15px; margin-bottom: 20px; }
                .card { background: #1e293b; padding: 20px; border-radius: 10px; border: 1px solid #334155; flex: 1; }
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
                .profit { color: #4ade80; }
                .tag { font-size: 0.7em; padding: 3px 6px; border-radius: 4px; background: #334155; margin-left: 10px; }
            </style>
            </head>
            <body>
                <h1>HTX Advanced Arbitrage <small style="color:#64748b">3 & 4-Step Loops</small></h1>
                <div class="grid">
                    <div class="card">Total Profit<br><b class="profit" style="font-size:1.5em">$${metrics.simulatedProfit.toFixed(4)}</b></div>
                    <div class="card">Paths Scanned<br><b style="font-size:1.5em">${metrics.pathsTracked}</b></div>
                    <div class="card">Total Scans<br><b style="font-size:1.5em">${metrics.totalScans}</b></div>
                </div>
                <table>
                    <tr><th>Path Strategy</th><th>Step Count</th><th>ROI</th><th>Profit</th><th>Time</th></tr>
                    ${metrics.history.map(o => `
                        <tr>
                            <td><code>${o.path}</code></td>
                            <td><span class="tag">${o.steps} Legs</span></td>
                            <td class="profit">${o.roi}</td>
                            <td class="profit">$${o.profit}</td>
                            <td style="color:#94a3b8">${o.time}</td>
                        </tr>
                    `).join('')}
                </table>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findAdvancedPaths();
    fastScan();
});
