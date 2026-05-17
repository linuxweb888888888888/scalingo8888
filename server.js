const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- 1. CONFIGURATION ---
const exchangeConfig = {
    mexc: { fee: 0.0005, color: '#00ff00', name: 'MEXC' },
    okx: { fee: 0.0010, color: '#ffffff', name: 'OKX' },
    bybit: { fee: 0.0010, color: '#f7d060', name: 'BYBIT' },
    kucoin: { fee: 0.0010, color: '#2dd4bf', name: 'KUCOIN' },
    bitget: { fee: 0.0010, color: '#38bdf8', name: 'BITGET' },
    phemex: { fee: 0.0010, color: '#facc15', name: 'PHEMEX' },
    lbank: { fee: 0.0010, color: '#38bdf8', name: 'LBANK' },
    gate: { fee: 0.0020, color: '#f97316', name: 'GATE.IO' },
    bitmart: { fee: 0.0010, color: '#ffffff', name: 'BITMART' },
    poloniex: { fee: 0.00155, color: '#0ea5e9', name: 'POLONIEX' },
    ascendex: { fee: 0.0010, color: '#8b5cf6', name: 'ASCENDEX' },
    coinw: { fee: 0.0020, color: '#ff6600', name: 'COINW' },
    tapbit: { fee: 0.0020, color: '#3b82f6', name: 'TAPBIT' },
    bigone: { fee: 0.0020, color: '#22c55e', name: 'BIGONE' },
    xt: { fee: 0.0020, color: '#a855f7', name: 'XT' },
    bitrue: { fee: 0.00098, color: '#ef4444', name: 'BITRUE' },
    coinex: { fee: 0.0020, color: '#10b981', name: 'COINEX' },
    xeggex: { fee: 0.0015, color: '#a78bfa', name: 'XEGGEX' },
    azbit: { fee: 0.0010, color: '#14b8a6', name: 'AZBIT' },
    tradeogre: { fee: 0.0020, color: '#64748b', name: 'TRADEOGRE' },
    nonkyc: { fee: 0.0020, color: '#fb7185', name: 'NONKYC' },
    latoken: { fee: 0.0010, color: '#fbbf24', name: 'LATOKEN' },
    whitebit: { fee: 0.0010, color: '#ec4899', name: 'WHITEBIT' },
    probit: { fee: 0.0020, color: '#3b82f6', name: 'PROBIT' }
};

const exchanges = {};
for (const id in exchangeConfig) {
    if (ccxt[id]) {
        try {
            exchanges[id] = {
                inst: new ccxt[id]({ enableRateLimit: true }),
                fee: exchangeConfig[id].fee,
                color: exchangeConfig[id].color,
                name: exchangeConfig[id].name
            };
        } catch (e) {}
    }
}

// --- 2. STATE ---
const START_CAPITAL = 100;
let logs = [];
let allPaths = {};
let stats = { scanned: 0, bestRoi: -100, totalProfitFound: 0, currentEx: 'Booting...', currentPair: '---' };

// --- 3. MEMORY OPTIMIZED PATHFINDER ---
async function buildPaths(id) {
    try {
        const ex = exchanges[id].inst;
        const markets = await ex.loadMarkets(); // Large memory allocation
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];
        const quotes = ['BTC', 'ETH', 'USDC', 'BNB', 'TRX', 'SOL'];
        
        for (const q of quotes) {
            const crossPairs = symbols.filter(s => markets[s].quote === q);
            for (const cp of crossPairs) {
                const alt = cp.split('/')[0];
                if (markets[`${alt}/USDT`] && markets[`${q}/USDT`]) {
                    paths.push(`${q}/USDT|${cp}|${alt}/USDT`);
                }
            }
        }
        
        // CRITICAL: Delete markets from memory after paths are built
        ex.markets = {}; 
        return paths;
    } catch (e) { return []; }
}

// --- 4. OPTIMIZED MASTER LOOP ---
async function runMasterLoop() {
    for (const id in exchanges) { 
        allPaths[id] = await buildPaths(id); 
    }
    
    while (true) {
        for (const id in exchanges) {
            if (!allPaths[id]?.length) continue;
            stats.currentEx = exchanges[id].name;
            const ex = exchanges[id];
            
            try {
                let tickers = await ex.inst.fetchTickers();
                
                for (const pathStr of allPaths[id]) {
                    stats.scanned++;
                    const [s1, s2, s3] = pathStr.split('|');
                    stats.currentPair = s2;

                    const t1 = tickers[s1], t2 = tickers[s2], t3 = tickers[s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const gross = (START_CAPITAL / t1.ask / t2.ask) * t3.bid;
                    const net = gross * Math.pow((1 - ex.fee), 3);
                    const netProfit = net - START_CAPITAL;
                    const roi = (netProfit / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;
                    if (roi > 0.01) {
                        stats.totalProfitFound += netProfit;
                        logs.unshift({ time: new Date().toLocaleTimeString(), ex: ex.name, path: pathStr.replace(/\|/g, '>'), roi: roi.toFixed(4), profit: netProfit.toFixed(4), color: ex.color });
                        if (logs.length > 300) logs.pop();
                    }
                }
                // Memory cleanup
                tickers = null; 
            } catch (e) {}
            
            // Allow GC to run between exchanges
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// --- 5. DASHBOARD ROUTES ---
app.get('/status', (req, res) => res.json({ stats, logs }));
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>ArbFleet v3.1 MemoryOptimized</title><style>
            body { background: #020617; color: #f1f5f9; font-family: monospace; padding: 20px; }
            .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
            .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
            .log-box { background: #020617; height: 500px; overflow-y: auto; padding: 15px; border-radius: 12px; border: 1px solid #1e293b; }
            .green { color: #4ade80; font-weight: bold; }
        </style></head>
        <body>
            <div class="header">
                <div><small>ENGINE</small><br><div id="exName" style="font-size:1.8rem; color:#38bdf8; font-weight:bold;">BOOTING</div></div>
                <div style="text-align:right"><small>ANALYZING</small><br><div id="pairName" style="font-size:1.2rem; font-weight:bold;">---</div></div>
            </div>
            <div class="stat-grid">
                <div class="stat-card"><small>SCANS</small><br><b id="totalScanned">0</b></div>
                <div class="stat-card"><small>BEST ROI</small><br><b id="bestRoi" class="green">0%</b></div>
                <div class="stat-card"><small>CUMULATIVE</small><br><b id="totalProfit" class="green">$0.00</b></div>
                <div class="stat-card"><small>MEM LIMIT</small><br><b>512MB</b></div>
            </div>
            <div class="log-box" id="logBox"></div>
            <script>
                async function update() {
                    const res = await fetch('/status'); const data = await res.json();
                    document.getElementById('exName').innerText = data.stats.currentEx;
                    document.getElementById('pairName').innerText = data.stats.currentPair;
                    document.getElementById('totalScanned').innerText = data.stats.scanned.toLocaleString();
                    document.getElementById('bestRoi').innerText = data.stats.bestRoi.toFixed(3) + '%';
                    document.getElementById('totalProfit').innerText = '$' + data.stats.totalProfitFound.toFixed(2);
                    document.getElementById('logBox').innerHTML = data.logs.map(l => 
                        '<div style="padding:5px 0; border-bottom:1px solid #0f172a;"><b>['+l.ex+']</b> '+l.path+' <span style="float:right" class="green">+$'+l.profit+'</span></div>'
                    ).join('');
                }
                setInterval(update, 500);
            </script>
        </body></html>
    `);
});

app.listen(port, () => runMasterLoop());
