const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- THE MASTER EXCHANGE FLEET ---
const exchanges = {
    mexc: { inst: new ccxt.mexc(), fee: 0.0005, color: '#00ff00' },      // 0.05%
    pionex: { inst: new ccxt.pionex(), fee: 0.0005, color: '#ff6600' },  // 0.05%
    lbank: { inst: new ccxt.lbank(), fee: 0.0010, color: '#38bdf8' },    // 0.1%
    bitmart: { inst: new ccxt.bitmart(), fee: 0.0010, color: '#ffffff' },// 0.1%
    bingx: { inst: new ccxt.bingx(), fee: 0.0010, color: '#2563eb' },    // 0.1%
    bitrue: { inst: new ccxt.bitrue(), fee: 0.00098, color: '#ef4444' }, // 0.09%
    phemex: { inst: new ccxt.phemex(), fee: 0.0010, color: '#facc15' },  // 0.1%
    htx: { inst: new ccxt.htx(), fee: 0.0020, color: '#818cf8' },        // 0.2%
    coinex: { inst: new ccxt.coinex(), fee: 0.0020, color: '#2dd4bf' },  // 0.2%
    xeggex: { inst: new ccxt.xeggex(), fee: 0.0015, color: '#a78bfa' },  // 0.15%
    tradeogre: { inst: new ccxt.tradeogre(), fee: 0.0020, color: '#64748b' } // 0.2%
};

const START_CAPITAL = 100;
let logs = [];
let allPaths = {};
let stats = { scanned: 0, bestRoi: -100, currentEx: 'Booting...', currentPair: '---' };

// --- PATHFINDER ---
async function buildPaths(id) {
    try {
        const markets = await exchanges[id].inst.loadMarkets();
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];
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
    } catch (e) { return []; }
}

async function runMasterLoop() {
    for (const id in exchanges) { allPaths[id] = await buildPaths(id); }

    while (true) {
        for (const id in exchanges) {
            if (!allPaths[id]?.length) continue;
            stats.currentEx = id.toUpperCase();
            const ex = exchanges[id];
            
            try {
                const tickers = await ex.inst.fetchTickers();
                for (const path of allPaths[id]) {
                    stats.scanned++;
                    stats.currentPair = path.s2;
                    const t1 = tickers[path.s1], t2 = tickers[path.s2], t3 = tickers[path.s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - ex.fee), 3);
                    const roi = ((net - START_CAPITAL) / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;
                    if (roi > 0.001) {
                        logs.unshift({ time: new Date().toLocaleTimeString(), ex: id.toUpperCase(), path: `${path.s1}>${path.s2}>${path.s3}`, roi: roi.toFixed(4), color: ex.color });
                        if (logs.length > 100) logs.pop();
                    }
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 2000)); // Respecting all APIs
        }
    }
}

// --- DASHBOARD ---
app.get('/status', (req, res) => res.json({ stats, logs }));
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#f1f5f9; font-family:monospace; padding:20px;">
            <div style="max-width:1000px; margin:auto;">
                <div style="background:#0f172a; padding:20px; border-radius:12px; display:flex; justify-content:space-between; border:1px solid #1e293b;">
                    <div><small>ENGINE</small><br><b id="exName" style="color:#38bdf8; font-size:1.5rem">---</b></div>
                    <div style="text-align:right"><small>BEST ROI</small><br><b id="bestRoi" style="color:#4ade80; font-size:1.5rem">---</b></div>
                </div>
                <div style="margin:20px 0; font-size:0.7rem; color:#64748b;">SCANNED: <span id="totalScanned">0</span> | ACTIVE: BINGX, PIONEX, BITMART, MEXC, LBANK...</div>
                <div id="logBox" style="background:#09090b; padding:15px; height:600px; overflow-y:auto; border-radius:8px; border:1px solid #1e293b;"></div>
            </div>
            <script>
                async function update() {
                    const res = await fetch('/status'); const data = await res.json();
                    document.getElementById('exName').innerText = data.stats.currentEx;
                    document.getElementById('totalScanned').innerText = data.stats.scanned.toLocaleString();
                    document.getElementById('bestRoi').innerText = data.stats.bestRoi.toFixed(3) + '%';
                    document.getElementById('logBox').innerHTML = data.logs.map(l => 
                        '<div style="display:flex; justify-content:space-between; border-bottom:1px solid #1e293b; padding:5px 0;">' +
                        '<span><b style="color:'+l.color+'">['+l.ex+']</b> '+l.path+'</span>' +
                        '<b style="color:#4ade80">+' + l.roi + '%</b></div>'
                    ).join('') || 'Searching 11 exchanges...';
                }
                setInterval(update, 300);
            </script>
        </body>
    `);
});
app.listen(port, () => runMasterLoop());
