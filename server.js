const ccxt = require('ccxt');
const express = require('express');
const app = express();
const port = 3000;

// --- CONFIGURATION ---
const exchange = new ccxt.htx({ 'enableRateLimit': true });
const BASE_CURRENCY = 'USDT';
const STARTING_BALANCE = 1000; // Simulated USDT
const TRADING_FEE = 0.002;      // 0.2% fee (standard for low-tier)

// Metrics Storage
let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    bestPath: null,
    recentOpportunities: []
};

/**
 * Automatically finds valid triangular paths on the exchange
 */
async function findTriangles() {
    console.log("Identifying valid triangular paths...");
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets);
    
    const triangles = [];
    const pairsWithUSDT = symbols.filter(s => s.endsWith('/USDT'));

    for (const pair1 of pairsWithUSDT) {
        const altCoin = pair1.split('/')[0]; // e.g., 'BTC' in 'BTC/USDT'
        
        // Find pairs that connect the AltCoin to something else (e.g., 'SHIB/BTC')
        const intermediatePairs = symbols.filter(s => s.endsWith(`/${altCoin}`) || s.startsWith(`${altCoin}/`));

        for (const pair2 of intermediatePairs) {
            const thirdCoin = pair2.replace(altCoin, '').replace('/', '');
            const pair3 = `${thirdCoin}/USDT`;

            if (symbols.includes(pair3) && pair1 !== pair3) {
                triangles.push([pair1, pair2, pair3]);
            }
        }
    }
    console.log(`Found ${triangles.length} potential triangular paths.`);
    return triangles.slice(0, 50); // Limit to top 50 for performance
}

/**
 * Logic to calculate potential profit
 */
async function scanPrices(paths) {
    try {
        const tickers = await exchange.fetchTickers();
        metrics.totalScans++;

        for (const path of paths) {
            const [p1, p2, p3] = path;
            
            // Simplified Math: Buy P1 -> Buy/Sell P2 -> Sell P3
            // This example assumes the path: USDT -> BTC -> SHIB -> USDT
            try {
                const price1 = tickers[p1].ask; // Buy BTC with USDT
                const price2 = tickers[p2].ask; // Buy SHIB with BTC
                const price3 = tickers[p3].bid; // Sell SHIB for USDT

                if (!price1 || !price2 || !price3) continue;

                // Execution Simulation
                let amount = STARTING_BALANCE;
                amount *= (1 - TRADING_FEE); // Fee to buy P1
                const amountAfterP1 = amount / price1;

                amount *= (1 - TRADING_FEE); // Fee to trade P2
                const amountAfterP2 = amountAfterP1 / price2;

                amount *= (1 - TRADING_FEE); // Fee to sell P3
                const finalBalance = amountAfterP2 * price3;

                const profit = finalBalance - STARTING_BALANCE;
                const roi = (profit / STARTING_BALANCE) * 100;

                if (roi > 0) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += profit;
                    const log = {
                        path: path.join(' -> '),
                        roi: roi.toFixed(4) + '%',
                        profit: profit.toFixed(4),
                        time: new Date().toLocaleTimeString()
                    };
                    metrics.recentOpportunities.unshift(log);
                    if (metrics.recentOpportunities.length > 10) metrics.recentOpportunities.pop();
                    
                    if (!metrics.bestPath || roi > parseFloat(metrics.bestPath.roi)) {
                        metrics.bestPath = log;
                    }
                }
            } catch (err) { /* Skip symbols with missing ticker data */ }
        }
    } catch (e) {
        console.error("Fetch Error:", e.message);
    }
}

// --- EXPRESS SERVER FOR DASHBOARD ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>HTX Arb Bot - Paper Trading</title>
                <meta http-equiv="refresh" content="5">
                <style>
                    body { font-family: sans-serif; background: #121212; color: #e0e0e0; padding: 20px; }
                    .card { background: #1e1e1e; padding: 20px; border-radius: 8px; margin-bottom: 10px; border: 1px solid #333; }
                    .profit { color: #4caf50; font-size: 1.5em; font-weight: bold; }
                    .metric { color: #2196f3; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #333; }
                </style>
            </head>
            <body>
                <h1>HTX Triangular Arbitrage (Paper Trading)</h1>
                <div class="card">
                    <div>Simulated Total Profit: <span class="profit">$${metrics.simulatedProfit.toFixed(4)} USDT</span></div>
                    <div>Scans Performed: <span class="metric">${metrics.totalScans}</span></div>
                    <div>Arbitrage Gaps Spotted: <span class="metric">${metrics.opportunitiesFound}</span></div>
                </div>

                <h2>Recent Opportunities</h2>
                <div class="card">
                    <table>
                        <tr><th>Path</th><th>ROI</th><th>Profit (Sim)</th><th>Time</th></tr>
                        ${metrics.recentOpportunities.map(o => `
                            <tr>
                                <td>${o.path}</td>
                                <td style="color:#4caf50">${o.roi}</td>
                                <td>$${o.profit}</td>
                                <td>${o.time}</td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
                <p><i>Dashboard auto-refreshes every 5 seconds.</i></p>
            </body>
        </html>
    `);
});

// --- START BOT ---
async function start() {
    const paths = await findTriangles();
    console.log("Bot running. Open http://localhost:3000 in your browser.");
    
    // Scan every 3 seconds
    setInterval(() => scanPrices(paths), 3000);
}

app.listen(port, () => start());
