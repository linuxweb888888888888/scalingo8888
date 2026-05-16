const ccxt = require('ccxt');
const express = require('express');
const app = express();

// --- CONFIGURATION ---
const port = process.env.PORT || 3000; // Required for Scalingo
const exchange = new ccxt.htx({ 'enableRateLimit': true });
const STARTING_BALANCE = 1000; // Simulated USDT
const TRADING_FEE = 0.002;      // 0.2% simulated fee per leg (0.6% total)

// Global metrics object
let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    bestPath: null,
    recentOpportunities: [],
    status: "Initializing..."
};

/**
 * Finds valid triangular paths (e.g., USDT -> BTC -> SHIB -> USDT)
 */
async function findTriangles() {
    try {
        metrics.status = "Mapping market pairs...";
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const triangles = [];
        
        // Find pairs ending in USDT (Leg 1 and Leg 3)
        const pairsWithUSDT = symbols.filter(s => s.endsWith('/USDT'));

        for (const pair1 of pairsWithUSDT) {
            const altCoin = pair1.split('/')[0]; // e.g., 'BTC'
            
            // Find intermediate pairs (Leg 2) like SHIB/BTC
            const intermediatePairs = symbols.filter(s => s.endsWith(`/${altCoin}`) || s.startsWith(`${altCoin}/`));

            for (const pair2 of intermediatePairs) {
                const thirdCoin = pair2.replace(altCoin, '').replace('/', '');
                const pair3 = `${thirdCoin}/USDT`;

                if (symbols.includes(pair3) && pair1 !== pair3) {
                    triangles.push([pair1, pair2, pair3]);
                }
            }
        }
        metrics.status = `Monitoring ${triangles.length} paths`;
        return triangles.slice(0, 40); // Limit to top 40 for stability on cloud hosting
    } catch (e) {
        metrics.status = "Error loading markets: " + e.message;
        return [];
    }
}

/**
 * Core Arbitrage Logic
 */
async function scanPrices(paths) {
    if (paths.length === 0) return;
    
    try {
        const tickers = await exchange.fetchTickers();
        metrics.totalScans++;

        for (const path of paths) {
            const [p1, p2, p3] = path;
            
            try {
                const price1 = tickers[p1].ask; // Buy Alt1 with USDT
                const price2 = tickers[p2].ask; // Buy Alt2 with Alt1
                const price3 = tickers[p3].bid; // Sell Alt2 for USDT

                if (!price1 || !price2 || !price3) continue;

                // Simulation Math
                let balance = STARTING_BALANCE;
                
                // Leg 1: USDT -> BTC
                balance = (balance / price1) * (1 - TRADING_FEE);
                // Leg 2: BTC -> SHIB
                balance = (balance / price2) * (1 - TRADING_FEE);
                // Leg 3: SHIB -> USDT
                balance = (balance * price3) * (1 - TRADING_FEE);

                const profit = balance - STARTING_BALANCE;
                const roi = (profit / STARTING_BALANCE) * 100;

                if (roi > 0) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    
                    const log = {
                        path: path.join(' → '),
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(4) + ' USDT',
                        time: new Date().toLocaleTimeString()
                    };

                    metrics.recentOpportunities.unshift(log);
                    if (metrics.recentOpportunities.length > 15) metrics.recentOpportunities.pop();
                    
                    if (!metrics.bestPath || roi > parseFloat(metrics.bestPath.roi)) {
                        metrics.bestPath = log;
                    }
                }
            } catch (err) { /* Handle missing pairs */ }
        }
    } catch (e) {
        console.error("Scan Error:", e.message);
    }
}

// --- WEB DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
            <head>
                <title>HTX Arb Bot</title>
                <meta http-equiv="refresh" content="10">
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; }
                    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
                    .label { color: #94a3b8; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 8px; }
                    .value { font-size: 1.8rem; font-weight: bold; color: #38bdf8; }
                    .profit { color: #4ade80; }
                    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
                    th, td { padding: 15px; text-align: left; border-bottom: 1px solid #334155; }
                    th { background: #334155; color: #94a3b8; }
                    tr:hover { background: #2d3748; }
                </style>
            </head>
            <body>
                <h1 style="margin-bottom:10px;">HTX Triangular Arbitrage <small style="color:#64748b; font-size: 0.5em;">Paper Trading</small></h1>
                <p style="margin-bottom:30px; color:#94a3b8;">Status: ${metrics.status}</p>

                <div class="grid">
                    <div class="card">
                        <div class="label">Simulated Profit</div>
                        <div class="value profit">$${metrics.simulatedProfit.toFixed(4)} <small style="font-size:0.5em">USDT</small></div>
                    </div>
                    <div class="card">
                        <div class="label">Total Scans</div>
                        <div class="value">${metrics.totalScans}</div>
                    </div>
                    <div class="card">
                        <div class="label">Opportunities Found</div>
                        <div class="value">${metrics.opportunitiesFound}</div>
                    </div>
                </div>

                <h2>Recent Opportunities (ROI > Fees)</h2>
                <table>
                    <thead>
                        <tr><th>Path</th><th>ROI</th><th>Profit (Sim)</th><th>Time</th></tr>
                    </thead>
                    <tbody>
                        ${metrics.recentOpportunities.map(o => `
                            <tr>
                                <td style="font-family:monospace">${o.path}</td>
                                <td style="color:#4ade80; font-weight:bold">${o.roi}</td>
                                <td>${o.profit}</td>
                                <td style="color:#94a3b8">${o.time}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </body>
        </html>
    `);
});

// --- EXECUTION ---
async function main() {
    const paths = await findTriangles();
    
    // Start scanning every 5 seconds
    setInterval(() => scanPrices(paths), 5000);
    
    app.listen(port, () => {
        console.log(`Bot live at port ${port}`);
    });
}

main();
