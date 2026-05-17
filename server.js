const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// Function to force Node.js to clean up RAM
const forceGC = () => { if (global.gc) global.gc(); };

// --- 1. FULL EXCHANGE CONFIGURATION ---
const exchangeConfig = {
    mexc: { fee: 0.0005, color: '#00ff00', name: 'MEXC' },
    bitget: { fee: 0.0010, color: '#38bdf8', name: 'BITGET' },
    phemex: { fee: 0.0010, color: '#facc15', name: 'PHEMEX' },
    bitrue: { fee: 0.00098, color: '#ef4444', name: 'BITRUE' },
    lbank: { fee: 0.0010, color: '#38bdf8', name: 'LBANK' },
    gate: { fee: 0.0020, color: '#f97316', name: 'GATE.IO' },
    okx: { fee: 0.0010, color: '#ffffff', name: 'OKX' },
    bybit: { fee: 0.0010, color: '#f7d060', name: 'BYBIT' },
    kucoin: { fee: 0.0010, color: '#2dd4bf', name: 'KUCOIN' },
    bitmart: { fee: 0.0010, color: '#ffffff', name: 'BITMART' },
    poloniex: { fee: 0.00155, color: '#0ea5e9', name: 'POLONIEX' },
    coinex: { fee: 0.0020, color: '#10b981', name: 'COINEX' },
    htx: { fee: 0.0020, color: '#818cf8', name: 'HTX' },
    xt: { fee: 0.0020, color: '#a855f7', name: 'XT' },
    xeggex: { fee: 0.0015, color: '#a78bfa', name: 'XEGGEX' },
    tradeogre: { fee: 0.0020, color: '#64748b', name: 'TRADEOGRE' },
    latoken: { fee: 0.0010, color: '#fbbf24', name: 'LATOKEN' },
    whitebit: { fee: 0.0010, color: '#ec4899', name: 'WHITEBIT' },
    coinw: { fee: 0.0020, color: '#ff6600', name: 'COINW' },
    azbit: { fee: 0.0010, color: '#14b8a6', name: 'AZBIT' }
};

// --- 2. BOT STATE ---
const START_CAPITAL = 100; // Profit based on $100 trades
let logs = [];
let stats = { 
    scanned: 0, 
    bestRoi: 0, 
    totalProfit: 0, 
    currentEx: 'Starting...', 
    currentPair: '---',
    uptime: Date.now() 
};

// --- 3. THE SEQUENTIAL SCANNER ENGINE ---
async function runMasterLoop() {
    const exchangeIds = Object.keys(exchangeConfig);
    
    while (true) {
        for (const id of exchangeIds) {
            let ex = null;
            try {
                stats.currentEx = exchangeConfig[id].name;
                
                // Load Exchange temporarily
                ex = new ccxt[id]({ enableRateLimit: true });
                const markets = await ex.loadMarkets();
                const symbols = Object.keys(markets).filter(s => markets[s].active);
                
                // Build Paths (BTC, ETH, USDC middle hops)
                const paths = [];
                const quotes = ['BTC', 'ETH', 'USDC'];
                for (const q of quotes) {
                    const cross = symbols.filter(s => markets[s].quote === q);
                    for (const cp of cross) {
                        const alt = cp.split('/')[0];
                        if (markets[`${alt}/USDT`] && markets[`${q}/USDT`]) {
                            paths.push([`${q}/USDT`, cp, `${alt}/USDT`]);
                        }
                    }
                }

                const tickers = await ex.fetchTickers();
                
                // Calculate
                for (const [s1, s2, s3] of paths) {
                    stats.scanned++;
                    stats.currentPair = s2;
                    const t1 = tickers[s1], t2 = tickers[s2], t3 = tickers[s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - exchangeConfig[id].fee), 3);
                    const netProfit = net - START_CAPITAL;
                    const roi = (netProfit / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    if (roi > 0.01) {
                        stats.totalProfit += netProfit;
                        logs.unshift({ 
                            time: new Date().toLocaleTimeString(), 
                            ex: exchangeConfig[id].name, 
                            path: `${s1}>${s2}>${s3}`, 
                            roi: roi.toFixed(4), 
                            profit: netProfit.toFixed(4),
                            color: exchangeConfig[id].color 
                        });
                        if (logs.length > 500) logs.pop();
                    }
                }
            } catch (e) {
                console.log(`[Error] ${id}: ${e.message}`);
            } finally {
                // IMPORTANT: Wipe memory completely
                if (ex) { ex.markets = {}; ex = null; }
                forceGC(); 
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// --- 4. DASHBOARD UI ---
app.get('/status', (req, res) => res.json({ stats, logs }));
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Global Arb Fleet v3.2</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: monospace; padding: 20px; }
                .wrapper { max-width: 1000px; margin: auto; }
                .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
                .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
                .log-box { background: #020617; min-height: 500px; border-radius: 12px; border: 1px solid #1e293b; overflow: hidden; }
                .log-row { display: flex; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid #0f172a; font-size: 0.8rem; align-items: center; }
                .ex-tag { padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.7rem; border: 1px solid; }
                .green { color: #4ade80; font-weight: bold; }
                .pagination { display: flex; justify-content: center; align-items: center; gap: 20px; padding: 15px; background: #0f172a; }
                button { background: #38bdf8; color: #020617; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; }
            </style>
        </head>
        <body>
            <div class="wrapper">
                <div class="header">
                    <div><small style="color:#64748b">SCANNING ENGINE</small><br><div id="exName" style="font-size:1.5rem; color:#38bdf8; font-weight:bold;">...</div></div>
                    <div style="text-align:right"><small style="color:#64748b">PATH</small><br><div id="pairName" style="font-weight:bold;">---</div></div>
                </div>
                <div class="stat-grid">
                    <div class="stat-card"><small>SCANS</small><br><b id="scanned">0</b></div>
                    <div class="stat-card"><small>BEST ROI</small><br><b id="bestRoi" class="green">0%</b></div>
                    <div class="stat-card"><small>TOTAL PROFIT FOUND</small><br><b id="totalProfit" class="green">$0.00</b></div>
                    <div class="stat-card"><small>RAM PROTECTION</small><br><b style="color:#38bdf8">ACTIVE</b></div>
                </div>
                <div class="log-box">
                    <div id="logContent"></div>
                    <div class="pagination">
                        <button onclick="changePage(-1)">PREV</button>
                        <span id="pageInfo">Page 1</span>
                        <button onclick="changePage(1)">NEXT</button>
                    </div>
                </div>
            </div>
            <script>
                let currentPage = 1; let pageSize = 12; let allLogs = [];
                async function update() {
                    const r = await fetch('/status'); const d = await r.json();
                    allLogs = d.logs;
                    document.getElementById('exName').innerText = d.stats.currentEx;
                    document.getElementById('pairName').innerText = d.stats.currentPair;
                    document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
                    document.getElementById('bestRoi').innerText = d.stats.bestRoi.toFixed(3) + '%';
                    document.getElementById('totalProfit').innerText = '$' + d.stats.totalProfit.toFixed(2);
                    render();
                }
                function render() {
                    const start = (currentPage-1)*pageSize;
                    const pageLogs = allLogs.slice(start, start+pageSize);
                    document.getElementById('logContent').innerHTML = pageLogs.map(l => \`
                        <div class="log-row">
                            <span><span class="ex-tag" style="color:\${l.color}; border-color:\${l.color}">\${l.ex}</span> \${l.path}</span>
                            <span style="text-align:right"><span class="green">+\$ \${l.profit}</span><br><small style="color:#64748b">\${l.roi}%</small></span>
                        </div>
                    \`).join('') || '<div style="padding:50px; text-align:center">Scanning for gaps...</div>';
                    document.getElementById('pageInfo').innerText = "Page " + currentPage;
                }
                function changePage(s) { currentPage = Math.max(1, currentPage + s); render(); }
                setInterval(update, 800);
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => runMasterLoop());
