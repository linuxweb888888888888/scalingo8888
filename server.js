const ccxt = require('ccxt');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const exchange = new ccxt.htx({ 'enableRateLimit': true });

// --- SETTINGS ---
const STARTING_BALANCE = 10;   // Your $10 Paper Wallet
const STD_FEE = 0.002;         // 0.2% (Standard)
const VIP_FEE = 0.0012;        // 0.12% (If you use HTX Token for fees)

let metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    simulatedProfit: 0,
    history: [],
    status: "Initializing...",
    lastScanTime: 0,
    trianglesCount: 0
};

const MAX_HISTORY = 500;
const PAGE_SIZE = 15;

// --- DYNAMIC PATH FINDING ---
let triangles = [];
async function findTriangles() {
    try {
        const markets = await exchange.loadMarkets();
        const symbols = Object.keys(markets);
        const paths = [];
        const base = 'USDT';
        const usdtPairs = symbols.filter(s => s.includes(base));
        for (const pair1 of usdtPairs) {
            const parts1 = pair1.split('/');
            const alt1 = parts1[0] === base ? parts1[1].split(':')[0] : parts1[0];
            const alt1Pairs = symbols.filter(s => s.includes(alt1) && !s.includes(base));
            for (const pair2 of alt1Pairs) {
                const parts2 = pair2.split('/');
                const alt2 = parts2[0] === alt1 ? parts2[1].split(':')[0] : parts2[0];
                const pair3 = symbols.find(s => s === `${alt2}/${base}` || s === `${base}/${alt2}`);
                if (pair3) paths.push([pair1, pair2, pair3]);
            }
        }
        triangles = Array.from(new Set(paths.map(JSON.stringify)), JSON.parse).slice(0, 250);
        metrics.trianglesCount = triangles.length;
    } catch (e) { console.error(e); }
}

// --- TRADE CALCULATOR ---
function runSimulation(path, tickers, feeRate) {
    let balance = STARTING_BALANCE;
    let currentCoin = 'USDT';

    for (const pair of path) {
        const ticker = tickers[pair];
        if (!ticker || !ticker.ask || !ticker.bid) return 0;
        const [base, quoteRaw] = pair.split('/');
        const quote = quoteRaw.split(':')[0];

        if (currentCoin === quote) {
            balance = (balance / ticker.ask) * (1 - feeRate);
            currentCoin = base;
        } else {
            balance = (balance * ticker.bid) * (1 - feeRate);
            currentCoin = quote;
        }
    }
    return balance;
}

// --- SCANNER ---
async function fastScan() {
    const startTick = Date.now();
    try {
        const tickers = await exchange.fetchTickers();
        for (const path of triangles) {
            // Calculate with Standard Fee
            const finalBalanceStd = runSimulation(path, tickers, STD_FEE);
            const netProfitStd = finalBalanceStd - STARTING_BALANCE;
            const roiStd = (netProfitStd / STARTING_BALANCE) * 100;

            // Calculate with VIP Fee (to show how much "smaller" the fee could be)
            const finalBalanceVip = runSimulation(path, tickers, VIP_FEE);
            const netProfitVip = finalBalanceVip - STARTING_BALANCE;

            // Log if even slightly profitable (using 0.01% threshold)
            if (roiStd > 0.01 && roiStd < 4) {
                const pathStr = path.join(' → ');
                const lastSeen = metrics.history.find(h => h.path === pathStr);
                
                if (!lastSeen || (Date.now() - lastSeen.timestamp > 8000)) {
                    metrics.opportunitiesFound++;
                    metrics.simulatedProfit += netProfitStd;
                    metrics.history.unshift({
                        path: pathStr,
                        tradeAmount: STARTING_BALANCE.toFixed(2),
                        roi: roiStd.toFixed(3) + '%',
                        profit: netProfitStd.toFixed(4),
                        vipProfit: netProfitVip.toFixed(4), // Comparison
                        time: new Date().toLocaleTimeString(),
                        timestamp: Date.now()
                    });
                    if (metrics.history.length > MAX_HISTORY) metrics.history.pop();
                }
            }
        }
        metrics.totalScans++;
        metrics.lastScanTime = Date.now() - startTick;
        metrics.status = "Scanning...";
    } catch (e) { }
    setTimeout(fastScan, 100);
}

// --- DASHBOARD ---
app.get('/', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const items = metrics.history.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const totalPages = Math.ceil(metrics.history.length / PAGE_SIZE);

    res.send(`
        <html>
            <head>
                <title>HTX $10 Arb Bot</title>
                <style>
                    body { font-family: sans-serif; background: #020617; color: white; padding: 20px; }
                    .header { display: flex; gap: 20px; margin-bottom: 20px; }
                    .card { background: #1e293b; padding: 15px; border-radius: 10px; border: 1px solid #334155; flex: 1; }
                    .fee-box { font-size: 0.8em; color: #94a3b8; }
                    table { width: 100%; border-collapse: collapse; }
                    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; }
                    .profit { color: #4ade80; font-weight: bold; }
                    .vip { color: #38bdf8; font-size: 0.9em; }
                    .btn { padding: 5px 15px; background: #334155; color: white; text-decoration: none; border-radius: 5px; }
                </style>
            </head>
            <body>
                <h1>HTX Arbitrage <small style="color:#64748b">$10 Paper Wallet</small></h1>
                
                <div class="header">
                    <div class="card">
                        <div class="fee-box">Total Paper Profit</div>
                        <div class="profit" style="font-size:1.5em">$${metrics.simulatedProfit.toFixed(4)} USDT</div>
                    </div>
                    <div class="card">
                        <div class="fee-box">Current Fee Setup</div>
                        <div>Standard: <b>20 bps</b> (0.2%)</div>
                        <div class="vip">VIP Target: <b>12 bps</b> (0.12%)</div>
                    </div>
                    <div class="card">
                        <div class="fee-box">System Info</div>
                        <div>Scans: ${metrics.totalScans}</div>
                        <div>Latency: ${metrics.lastScanTime}ms</div>
                    </div>
                </div>

                <table>
                    <tr>
                        <th>Path</th>
                        <th>Trade Vol</th>
                        <th>Net ROI</th>
                        <th>Net Profit</th>
                        <th>If VIP Profit</th>
                        <th>Time</th>
                    </tr>
                    ${items.map(o => `
                        <tr>
                            <td>${o.path}</td>
                            <td>$${o.tradeAmount}</td>
                            <td class="profit">${o.roi}</td>
                            <td class="profit">$${o.profit}</td>
                            <td class="vip">$${o.vipProfit}</td>
                            <td style="color:#64748b">${o.time}</td>
                        </tr>
                    `).join('')}
                </table>

                <div style="margin-top:20px;">
                    <a class="btn" href="/?page=${page - 1}">Back</a>
                    <span> Page ${page} of ${totalPages || 1} </span>
                    <a class="btn" href="/?page=${page + 1}">Next</a>
                </div>
            </body>
        </html>
    `);
});

app.listen(port, async () => {
    await findTriangles();
    fastScan();
});
