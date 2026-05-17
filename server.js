const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- 1. EXCHANGE CONFIGURATION ---
const exchangeConfig = {
    mexc: { fee: 0.0005, color: '#00ff00', name: 'MEXC' },
    lbank: { fee: 0.0010, color: '#38bdf8', name: 'LBANK' },
    phemex: { fee: 0.0010, color: '#facc15', name: 'PHEMEX' },
    bitrue: { fee: 0.00098, color: '#ef4444', name: 'BITRUE' },
    bingx: { fee: 0.0010, color: '#2563eb', name: 'BINGX' },
    bitmart: { fee: 0.0010, color: '#ffffff', name: 'BITMART' },
    coinex: { fee: 0.0020, color: '#2dd4bf', name: 'COINEX' },
    htx: { fee: 0.0020, color: '#818cf8', name: 'HTX' },
    xeggex: { fee: 0.0015, color: '#a78bfa', name: 'XEGGEX' },
    tradeogre: { fee: 0.0020, color: '#64748b', name: 'TRADEOGRE' },
    pionex: { fee: 0.0005, color: '#ff6600', name: 'PIONEX' } 
};

// --- 2. SELF-HEALING INITIALIZATION ---
const exchanges = {};
console.log("--- Initializing Exchange Fleet ---");
for (const id in exchangeConfig) {
    // This check prevents the "is not a constructor" crash
    if (ccxt[id]) {
        try {
            exchanges[id] = {
                inst: new ccxt[id]({ enableRateLimit: true }),
                fee: exchangeConfig[id].fee,
                color: exchangeConfig[id].color,
                name: exchangeConfig[id].name
            };
            console.log(`[OK] Loaded ${id.toUpperCase()}`);
        } catch (e) {
            console.error(`[ERROR] Could not start ${id}:`, e.message);
        }
    } else {
        console.warn(`[SKIP] ${id.toUpperCase()} not supported in current CCXT version.`);
    }
}

// --- 3. BOT STATE ---
const START_CAPITAL = 100;
let logs = [];
let allPaths = {};
let stats = {
    scanned: 0,
    bestRoi: -100,
    currentEx: 'Booting...',
    currentPair: '---',
    uptime: Date.now()
};

// --- 4. DYNAMIC PATHFINDER ---
async function buildPaths(id) {
    try {
        const ex = exchanges[id].inst;
        const markets = await ex.loadMarkets();
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];
        
        // We look for triangles using USDT, BTC, ETH, and USDC as middle-hops
        const quotes = ['BTC', 'ETH', 'USDC'];
        for (const q of quotes) {
            const crossPairs = symbols.filter(s => markets[s].quote === q);
            for (const cp of crossPairs) {
                const alt = cp.split('/')[0];
                if (markets[`${alt}/USDT`] && markets[`${q}/USDT`]) {
                    paths.push({ s1: `${q}/USDT`, s2: cp, s3: `${alt}/USDT` });
                }
            }
        }
        return paths;
    } catch (e) {
        return [];
    }
}

// --- 5. MASTER SCANNER LOOP ---
async function runMasterLoop() {
    // Build paths for all successfully loaded exchanges
    for (const id in exchanges) {
        allPaths[id] = await buildPaths(id);
    }

    while (true) {
        for (const id in exchanges) {
            if (!allPaths[id] || allPaths[id].length === 0) continue;
            
            stats.currentEx = exchanges[id].name;
            const ex = exchanges[id];
            
            try {
                const tickers = await ex.inst.fetchTickers();
                
                for (const path of allPaths[id]) {
                    stats.scanned++;
                    stats.currentPair = path.s2;

                    const t1 = tickers[path.s1], t2 = tickers[path.s2], t3 = tickers[path.s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    // Compounded fee math: (1 - fee)^3
                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - ex.fee), 3);
                    const roi = ((net - START_CAPITAL) / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    if (roi > 0.01) { // Threshold for logging profit
                        logs.unshift({
                            time: new Date().toLocaleTimeString(),
                            ex: ex.name,
                            path: `${path.s1} ➔ ${path.s2} ➔ ${path.s3}`,
                            roi: roi.toFixed(4),
                            color: ex.color
                        });
                        if (logs.length > 100) logs.pop();
                    }
                }
            } catch (e) { /* API connection error handling */ }
            
            // Respect API rate limits (3s per exchange cycle)
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// --- 6. DASHBOARD ROUTES ---
app.get('/status', (req, res) => {
    res.json({ stats, logs });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Master Arb Fleet</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: monospace; padding: 20px; }
                .container { max-width: 1000px; margin: auto; }
                .monitor { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .ticker-label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
                .ticker-val { font-size: 1.8rem; font-weight: bold; color: #38bdf8; }
                .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
                .stat-card { background: #1e293b; padding: 12px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
                .log-box { background: #020617; height: 500px; overflow-y: auto; padding: 20px; border-radius: 8px; border: 1px solid #1e293b; font-size: 0.8rem; }
                .log-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #0f172a; }
                .green { color: #4ade80; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="monitor">
                    <div>
                        <div class="ticker-label">Active Engine</div>
                        <div id="exName" class="ticker-val">BOOTING</div>
                    </div>
                    <div style="text-align: right;">
                        <div class="ticker-label">Analyzing Path</div>
                        <div id="pairName" style="font-size: 1.2rem; color: #f8fafc;">---</div>
                    </div>
                </div>

                <div class="stat-grid">
                    <div class="stat-card">
                        <small style="color:#64748b">TOTAL SCANS</small><br>
                        <b id="totalScanned">0</b>
                    </div>
                    <div class="stat-card">
                        <small style="color:#64748b">BEST ROI</small><br>
                        <b id="bestRoi" class="green">-100%</b>
                    </div>
                    <div class="stat-card">
                        <small style="color:#64748b">UPTIME</small><br>
                        <b id="uptime">0m</b>
                    </div>
                    <div class="stat-card">
                        <small style="color:#64748b">EXCHANGES</small><br>
                        <b>${Object.keys(exchanges).length} ACTIVE</b>
                    </div>
                </div>

                <div class="log-box" id="logBox">Initializing 11-exchange scan feeds...</div>
            </div>

            <script>
                async function update() {
                    try {
                        const res = await fetch('/status');
                        const data = await res.json();
                        document.getElementById('exName').innerText = data.stats.currentEx;
                        document.getElementById('pairName').innerText = data.stats.currentPair;
                        document.getElementById('totalScanned').innerText = data.stats.scanned.toLocaleString();
                        document.getElementById('bestRoi').innerText = data.stats.bestRoi + '%';
                        
                        if (data.logs.length > 0) {
                            document.getElementById('logBox').innerHTML = data.logs.map(l => 
                                '<div class="log-row"><span><b style="color:'+l.color+'">['+l.ex+']</b> '+l.path+'</span><span class="green">+' + l.roi + '%</span></div>'
                            ).join('');
                        }
                    } catch (e) {}
                }
                setInterval(update, 200); // UI updates every 200ms
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    runMasterLoop();
});
