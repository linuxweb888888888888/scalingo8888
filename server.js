const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// Use a global to allow manual Garbage Collection if the flag is set
const forceGC = () => { if (global.gc) global.gc(); };

// --- 1. CONFIGURATION (Reduced list to keep it stable) ---
const exchangeConfig = {
    mexc: { fee: 0.0005, color: '#00ff00', name: 'MEXC' },
    lbank: { fee: 0.0010, color: '#38bdf8', name: 'LBANK' },
    bitget: { fee: 0.0010, color: '#38bdf8', name: 'BITGET' },
    phemex: { fee: 0.0010, color: '#facc15', name: 'PHEMEX' },
    bitrue: { fee: 0.00098, color: '#ef4444', name: 'BITRUE' },
    bybit: { fee: 0.0010, color: '#f7d060', name: 'BYBIT' },
    kucoin: { fee: 0.0010, color: '#2dd4bf', name: 'KUCOIN' },
    gate: { fee: 0.0020, color: '#f97316', name: 'GATE.IO' },
    bitmart: { fee: 0.0010, color: '#ffffff', name: 'BITMART' },
    coinex: { fee: 0.0020, color: '#10b981', name: 'COINEX' },
    xeggex: { fee: 0.0015, color: '#a78bfa', name: 'XEGGEX' },
    tradeogre: { fee: 0.0020, color: '#64748b', name: 'TRADEOGRE' }
};

// --- 2. STATE ---
let logs = [];
let stats = { scanned: 0, bestRoi: 0, currentEx: 'Starting...', currentPair: '---' };

// --- 3. THE SEQUENTIAL SCANNER ---
async function runMasterLoop() {
    while (true) {
        for (const id in exchangeConfig) {
            let ex = null;
            try {
                stats.currentEx = exchangeConfig[id].name;
                
                // 1. Initialize exchange only when needed
                ex = new ccxt[id]({ enableRateLimit: true });
                
                // 2. Load Markets
                const markets = await ex.loadMarkets();
                const symbols = Object.keys(markets).filter(s => markets[s].active);
                
                // 3. Build Paths
                const paths = [];
                const quotes = ['BTC', 'ETH', 'USDC'];
                for (const q of quotes) {
                    const crossPairs = symbols.filter(s => markets[s].quote === q);
                    for (const cp of crossPairs) {
                        const alt = cp.split('/')[0];
                        if (markets[`${alt}/USDT`] && markets[`${q}/USDT`]) {
                            paths.push([`${q}/USDT`, cp, `${alt}/USDT`]);
                        }
                    }
                }

                // 4. Fetch Tickers
                const tickers = await ex.fetchTickers();
                
                // 5. Calculate
                for (const [s1, s2, s3] of paths) {
                    stats.scanned++;
                    stats.currentPair = s2;
                    const t1 = tickers[s1], t2 = tickers[s2], t3 = tickers[s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const net = (100 / t1.ask / t2.ask) * t3.bid * Math.pow((1 - exchangeConfig[id].fee), 3);
                    const roi = (net - 100);

                    if (roi > stats.bestRoi) stats.bestRoi = roi;
                    if (roi > 0.01) {
                        logs.unshift({ time: new Date().toLocaleTimeString(), ex: exchangeConfig[id].name, path: `${s1}>${s2}>${s3}`, roi: roi.toFixed(4), color: exchangeConfig[id].color });
                        if (logs.length > 50) logs.pop();
                    }
                }
            } catch (e) {
                console.log(`Error scanning ${id}: ${e.message}`);
            } finally {
                // 6. CRITICAL: WIPE MEMORY
                if (ex) {
                    ex.markets = {};
                    ex = null; 
                }
                forceGC(); // Request Garbage Collection
            }
            // Small pause between exchanges
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// --- 4. ROUTES ---
app.get('/status', (req, res) => res.json({ stats, logs }));
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#f1f5f9; font-family:monospace; padding:20px;">
            <div style="max-width:800px; margin:auto;">
                <h2 style="color:#38bdf8">Global Arb Lite (Sequential Mode)</h2>
                <div style="background:#0f172a; padding:15px; border-radius:8px; border:1px solid #1e293b; margin-bottom:15px;">
                    <div>ENGINE: <b id="exName">...</b> | SCANNING: <b id="pairName">...</b></div>
                    <div style="margin-top:10px;">BEST ROI: <b id="bestRoi" style="color:#4ade80">0%</b> | SCANS: <b id="scanned">0</b></div>
                </div>
                <div id="logBox" style="background:#09090b; padding:15px; height:400px; overflow-y:auto; border-radius:8px; border:1px solid #1e293b;"></div>
            </div>
            <script>
                async function update() {
                    try {
                        const r = await fetch('/status'); const d = await r.json();
                        document.getElementById('exName').innerText = d.stats.currentEx;
                        document.getElementById('pairName').innerText = d.stats.currentPair;
                        document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
                        document.getElementById('bestRoi').innerText = d.stats.bestRoi.toFixed(3) + '%';
                        document.getElementById('logBox').innerHTML = d.logs.map(l => 
                            '<div style="border-bottom:1px solid #1e293b; padding:5px 0;">['+l.ex+'] '+l.path+' <span style="float:right; color:#4ade80">+' + l.roi + '%</span></div>'
                        ).join('');
                    } catch(e){}
                }
                setInterval(update, 500);
            </script>
        </body>
    `);
});

app.listen(port, () => runMasterLoop());
