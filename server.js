const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const exchange = new ccxt.mexc();
const takerFee = 0.0005; // 0.05%
const minProfitUsdt = 0.05; // Minimum profit to log ($0.05 per $100)
let logs = [];
let lastScan = "Initializing...";
let trianglePaths = [];

// --- BOT LOGIC ---
async function initBot() {
    console.log("Loading MEXC markets...");
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets);
    const base = 'USDT';

    // Build unique triangular paths: USDT -> A -> B -> USDT
    for (const s1 of symbols) {
        const [t1, q1] = s1.split('/');
        if (q1 !== base) continue;
        for (const s2 of symbols) {
            const [t2, q2] = s2.split('/');
            if (q2 !== t1) continue;
            const s3 = `${t2}/${base}`;
            if (markets[s3]) trianglePaths.push([s1, s2, s3]);
        }
    }
    console.log(`Found ${trianglePaths.length} paths. Starting scan...`);
    runLoop();
}

async function runLoop() {
    while (true) {
        try {
            const tickers = await exchange.fetchTickers();
            lastScan = new Date().toLocaleTimeString();
            
            for (const path of trianglePaths) {
                const [s1, s2, s3] = path;
                if (!tickers[s1] || !tickers[s2] || !tickers[s3]) continue;

                const p1 = tickers[s1].ask; // Buy A with USDT
                const p2 = tickers[s2].ask; // Buy B with A
                const p3 = tickers[s3].bid; // Sell B for USDT

                const final = (100 / p1 / p2) * p3;
                const profit = final - (100 * (1 + takerFee * 3));

                if (profit > minProfitUsdt) {
                    const entry = `[${lastScan}] ${path.join(' ➔ ')} | Profit: +$${profit.toFixed(4)}`;
                    logs.unshift(entry);
                    if (logs.length > 30) logs.pop();
                    console.log(entry);
                }
            }
        } catch (e) {
            console.error("Scan error:", e.message);
        }
        await new Promise(r => setTimeout(r, 5000)); // Scan every 5 seconds
    }
}

// --- WEB INTERFACE ---
app.get('/', (req, res) => {
    const logHtml = logs.map(l => `<div style="padding:5px; border-bottom:1px solid #1e293b;">${l}</div>`).join('');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ArbBot MEXC</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #0f172a; color: #38bdf8; font-family: monospace; padding: 20px; line-height: 1.5; }
                .card { max-width: 900px; margin: auto; border: 1px solid #1e293b; padding: 20px; border-radius: 10px; background: #111827; }
                h1 { color: #f8fafc; font-size: 1.2rem; border-bottom: 2px solid #334155; padding-bottom: 10px; }
                .status { color: #4ade80; margin: 10px 0; font-weight: bold; }
                .logs { background: #020617; height: 400px; overflow-y: auto; padding: 10px; border-radius: 5px; font-size: 0.85rem; border: 1px solid #1e293b; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Triangular Arbitrage Dashboard (MEXC)</h1>
                <div class="status">● SCANNING ${trianglePaths.length} PAIRS | Last Update: ${lastScan}</div>
                <div class="logs">
                    ${logs.length > 0 ? logHtml : "<div>Watching markets for spreads...</div>"}
                </div>
                <p style="font-size: 0.7rem; color: #64748b;">Fee: 0.05% Taker | Logic: USDT ➔ AltA ➔ AltB ➔ USDT</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Web server active on port ${port}`);
    initBot();
});
