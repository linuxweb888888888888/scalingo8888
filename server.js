const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
// Standard Taker Fees used for hurdle calculation
const exchanges = {
    lbank: { inst: new ccxt.lbank(), fee: 0.0010, color: '#38bdf8' },
    phemex: { inst: new ccxt.phemex({ options: { 'defaultType': 'spot' } }), fee: 0.0010, color: '#facc15' },
    htx: { inst: new ccxt.htx(), fee: 0.0020, color: '#818cf8' },
    coinex: { inst: new ccxt.coinex(), fee: 0.0020, color: '#2dd4bf' },
    bitrue: { inst: new ccxt.bitrue(), fee: 0.00098, color: '#f87171' },
    xeggex: { inst: new ccxt.xeggex(), fee: 0.0015, color: '#a78bfa' },
    tradeogre: { inst: new ccxt.tradeogre(), fee: 0.0020, color: '#94a3b8' }
};

const START_CAPITAL = 100;
let logs = [];
let allPaths = {};
let stats = { scanned: 0, bestRoi: -100, currentEx: 'Booting...', currentPair: '---' };

// --- PATHFINDER ---
async function buildPaths(id) {
    try {
        console.log(`Mapping ${id} markets...`);
        const markets = await exchanges[id].inst.loadMarkets();
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];

        // Dynamic Triangle Search: USDT -> A -> B -> USDT
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
        console.error(`Error loading ${id}:`, e.message);
        return [];
    }
}

async function runMasterLoop() {
    for (const id in exchanges) {
        allPaths[id] = await buildPaths(id);
    }

    while (true) {
        for (const id in exchanges) {
            if (!allPaths[id] || allPaths[id].length === 0) continue;
            
            stats.currentEx = id.toUpperCase();
            const ex = exchanges[id];
            
            try {
                // FetchTickers gets the best Bid/Ask for the entire market
                const tickers = await ex.inst.fetchTickers();
                
                for (const path of allPaths[id]) {
                    stats.scanned++;
                    stats.currentPair = path.s2;

                    const t1 = tickers[path.s1];
                    const t2 = tickers[path.s2];
                    const t3 = tickers[path.s3];

                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    // Compounded fee math: (1 - fee)^3
                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - ex.fee), 3);
                    const roi = ((net - START_CAPITAL) / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    // Log opportunities that exceed the fee hurdle
                    if (roi > 0.01) {
                        logs.unshift({
                            time: new Date().toLocaleTimeString(),
                            ex: id.toUpperCase(),
                            path: `${path.s1}>${path.s2}>${path.s3}`,
                            roi: roi.toFixed(4),
                            color: ex.color
                        });
                        if (logs.length > 100) logs.pop();
                    }
                }
            } catch (e) { /* Silent fail to keep loop running */ }
            
            // Scalingo-safe delay to avoid rate limiting across 7 exchanges
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// --- DASHBOARD UI ---
app.get('/status', (req, res) => res.json({ stats, logs }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Global Arb Scanner</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: 'Courier New', monospace; padding: 20px; }
                .container { max-width: 1000px; margin: auto; }
                .monitor { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; margin-bottom: 20px; display: flex; justify-content: space-between; }
                .ticker { color: #38bdf8; font-size: 1.8rem; font-weight: bold; }
                .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
                .stat-item { background: #1e293b; padding: 12px; border-radius: 8px; text-align: center; border: 1px solid #334155; font-size: 0.8rem; }
                .log-box { background: #020617; height: 500px; overflow-y: auto; padding: 15px; border-radius: 8px; border: 1px solid #1e293b; font-size: 0.75rem; }
                .log-entry { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #0f172a; }
                .green { color: #4ade80; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="monitor">
                    <div><small style="color:#64748b">ACTIVE ENGINE</small><br><div id="exName" class="ticker">---</div></div>
                    <div style="text-align:right"><small style="color:#64748b">SCANNING</small><br><div id="pairName" style="font-size:1.2rem">---</div></div>
                </div>
                <div class="stat-grid">
                    <div class="stat-item"><small>TOTAL SCANS</small><br><b id="totalScanned">0</b></div>
                    <div class="stat-item"><small>BEST ROI</small><br><b id="bestRoi" class="green">-100%</b></div>
                    <div class="stat-item"><small>BITRUE FEE</small><br><b>0.09%</b></div>
                    <div class="stat-item"><small>XEGGEX FEE</small><br><b>0.15%</b></div>
                    <div class="stat-item"><small>COINEX FEE</small><br><b>0.20%</b></div>
                    <div class="stat-item"><small>HTX FEE</small><br><b>0.20%</b></div>
                    <div class="stat-item"><small>LBANK FEE</small><br><b>0.10%</b></div>
                    <div class="stat-item"><small>PHEMEX FEE</small><br><b>0.10%</b></div>
                </div>
                <div class="log-box" id="logBox">Initializing 7 exchange feeds...</div>
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
                                '<div class="log-entry"><span><b style="color:'+l.color+'">['+l.ex+']</b> '+l.path+'</span><span class="green">+' + l.roi + '%</span></div>'
                            ).join('');
                        }
                    } catch (e) {}
                }
                setInterval(update, 250);
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => runMasterLoop());
