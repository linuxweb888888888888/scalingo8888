const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const exchanges = {
    lbank: { inst: new ccxt.lbank(), fee: 0.0010, color: '#38bdf8' },
    phemex: { inst: new ccxt.phemex({ options: { 'defaultType': 'spot' } }), fee: 0.0010, color: '#facc15' },
    htx: { inst: new ccxt.htx(), fee: 0.0020, color: '#818cf8' }
};

const START_CAPITAL = 100;
let logs = [];
let allPaths = { lbank: [], phemex: [], htx: [] };
let stats = { scanned: 0, bestRoi: -100, currentEx: 'Initializing...', currentPair: '---' };

// --- PATHFINDER ---
async function buildPaths(id) {
    console.log(`Mapping ${id} markets...`);
    const markets = await exchanges[id].inst.loadMarkets();
    const symbols = Object.keys(markets).filter(s => markets[s].active);
    const paths = [];

    // Find USDT -> A -> B -> USDT
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
}

async function runMasterLoop() {
    // Initialize paths for all exchanges
    for (const id in exchanges) {
        allPaths[id] = await buildPaths(id);
    }

    while (true) {
        for (const id in exchanges) {
            stats.currentEx = id.toUpperCase();
            const ex = exchanges[id];
            
            try {
                const tickers = await ex.inst.fetchTickers();
                
                for (const path of allPaths[id]) {
                    stats.scanned++;
                    stats.currentPair = path.s2;

                    const t1 = tickers[path.s1];
                    const t2 = tickers[path.s2];
                    const t3 = tickers[path.s3];

                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    // Compounded fee math for 3 trades
                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - ex.fee), 3);
                    const roi = ((net - START_CAPITAL) / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    if (roi > 0.01) {
                        logs.unshift({
                            time: new Date().toLocaleTimeString(),
                            ex: id.toUpperCase(),
                            path: `${path.s1}>${path.s2}>${path.s3}`,
                            roi: roi.toFixed(4),
                            color: ex.color
                        });
                        if (logs.length > 50) logs.pop();
                    }
                }
            } catch (e) { console.error(`${id} error:`, e.message); }
            
            // Wait between exchanges to respect rate limits
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// --- WEB INTERFACE ---
app.get('/status', (req, res) => res.json({ stats, logs }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Multi-Exchange Arb</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: monospace; padding: 20px; }
                .container { max-width: 900px; margin: auto; }
                .monitor { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;}
                .ticker { color: #38bdf8; font-size: 1.8rem; font-weight: bold; }
                .stat-grid { display: flex; gap: 15px; margin-bottom: 20px; }
                .stat-item { flex: 1; background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
                .log-box { background: #020617; height: 400px; overflow-y: auto; padding: 15px; border-radius: 8px; border: 1px solid #1e293b; font-size: 0.8rem; }
                .log-entry { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #0f172a; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="monitor">
                    <div>
                        <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase;">Active Exchange</div>
                        <div id="exName" class="ticker">---</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 0.7rem; color: #64748b; text-transform: uppercase;">Scanning Pair</div>
                        <div id="pairName" style="font-size: 1.2rem; color: #f8fafc;">---</div>
                    </div>
                </div>

                <div class="stat-grid">
                    <div class="stat-item"><small>TOTAL SCANS</small><br><b id="totalScanned">0</b></div>
                    <div class="stat-item"><small>BEST ROI</small><br><b id="bestRoi" style="color:#4ade80">-100%</b></div>
                    <div class="stat-item"><small>PHEMEX (0.3%)</small><br><b>ACTIVE</b></div>
                    <div class="stat-item"><small>HTX (0.6%)</small><br><b>ACTIVE</b></div>
                    <div class="stat-item"><small>LBANK (0.3%)</small><br><b>ACTIVE</b></div>
                </div>

                <div class="log-box" id="logBox">Waiting for profitable market gap...</div>
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
                                '<div class="log-entry"><span><b style="color:'+l.color+'">['+l.ex+']</b> '+l.path+'</span><span style="color:#4ade80">+' + l.roi + '%</span></div>'
                            ).join('');
                        }
                    } catch (e) {}
                }
                setInterval(update, 200);
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => runMasterLoop());
