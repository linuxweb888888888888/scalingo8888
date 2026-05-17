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
    azbit: { fee: 0.0010, color: '#14b8a6', name: 'AZBIT' },
    probit: { fee: 0.0020, color: '#3b82f6', name: 'PROBIT' }
};

// --- 2. BOT STATE ---
const START_CAPITAL = 100; // All calcs based on $100 trade
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
            if (!ccxt[id]) continue; // Skip if exchange doesn't exist in CCXT
            
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

                // Fetch Prices
                const tickers = await ex.fetchTickers();
                
                // Calculation Loop
                for (const [s1, s2, s3] of paths) {
                    stats.scanned++;
                    stats.currentPair = s2;
                    const t1 = tickers[s1], t2 = tickers[s2], t3 = tickers[s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const net = (START_CAPITAL / t1.ask / t2.ask) * t3.bid * Math.pow((1 - exchangeConfig[id].fee), 3);
                    const netProfit = net - START_CAPITAL;
                    const roi = (netProfit / START_CAPITAL) * 100;

                    // --- SANITY FILTER ---
                    // Arbitrage over 10% is almost always a pricing error or low liquidity (Fake)
                    if (roi > 0.01 && roi < 10) {
                        if (roi > stats.bestRoi) stats.bestRoi = roi;
                        stats.totalProfit += netProfit;

                        logs.unshift({ 
                            time: new Date().toLocaleTimeString(), 
                            ex: exchangeConfig[id].name, 
                            path: `${s1} ➔ ${s2} ➔ ${s3}`, 
                            roi: roi.toFixed(4), 
                            profit: netProfit.toFixed(4),
                            color: exchangeConfig[id].color 
                        });
                        if (logs.length > 500) logs.pop();
                    } else if (roi >= 10) {
                        // We skip adding these to stats because they are likely fake
                        console.log(`[Filtered] Suspect ROI of ${roi.toFixed(0)}% on ${exchangeConfig[id].name} (${s2})`);
                    }
                }
            } catch (e) {
                console.log(`[Error] ${id}: ${e.message}`);
            } finally {
                // IMPORTANT: Wipe memory completely to prevent Scalingo crash
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
            <title>ArbFleet v3.5 Pro</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: 'Inter', sans-serif; padding: 20px; margin: 0; }
                .wrapper { max-width: 1100px; margin: auto; }
                .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .ticker-val { font-size: 1.8rem; font-weight: 800; color: #38bdf8; }
                .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
                .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
                .log-box { background: #020617; min-height: 600px; border-radius: 12px; border: 1px solid #1e293b; overflow: hidden; display: flex; flex-direction: column; }
                .log-header { background: #1e293b; padding: 12px 20px; display: flex; justify-content: space-between; font-size: 0.8rem; color: #94a3b8; font-weight: bold; }
                .log-row { display: flex; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid #0f172a; font-size: 0.85rem; align-items: center; }
                .ex-tag { padding: 3px 10px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; border: 1px solid; }
                .green { color: #4ade80; font-weight: bold; }
                .pagination { display: flex; justify-content: center; align-items: center; gap: 20px; padding: 15px; background: #0f172a; }
                button { background: #38bdf8; color: #020617; border: none; padding: 8px 18px; border-radius: 6px; font-weight: bold; cursor: pointer; }
                button:disabled { background: #334155; color: #94a3b8; }
            </style>
        </head>
        <body>
            <div class="wrapper">
                <div class="header">
                    <div><small style="color:#64748b">ENGINE STATUS</small><br><div id="exName" class="ticker-val">BOOTING</div></div>
                    <div style="text-align: right;"><small style="color:#64748b">SCANNING PAIR</small><br><div id="pairName" style="font-size: 1.4rem; font-weight:bold;">---</div></div>
                </div>
                <div class="stat-grid">
                    <div class="stat-card"><small style="color:#64748b">TOTAL SCANS</small><br><b id="scanned">0</b></div>
                    <div class="stat-card"><small style="color:#64748b">BEST REAL ROI</small><br><b id="bestRoi" class="green">0%</b></div>
                    <div class="stat-card"><small style="color:#64748b">ESTIMATED PROFIT</small><br><b id="totalProfit" class="green">$0.00</b></div>
                    <div class="stat-card"><small style="color:#64748b">FLEET SIZE</small><br><b>${Object.keys(exchangeConfig).length} EXCHANGES</b></div>
                </div>
                <div class="log-box">
                    <div class="log-header"><span>EXCHANGE & TRIANGLE PATH</span><span style="text-align:right">NET PROFIT / ROI</span></div>
                    <div id="logContent" style="flex:1"></div>
                    <div class="pagination">
                        <button id="prevBtn" onclick="changePage(-1)">PREV</button>
                        <span id="pageInfo">Page 1</span>
                        <button id="nextBtn" onclick="changePage(1)">NEXT</button>
                    </div>
                </div>
            </div>
            <script>
                let currentPage = 1; let pageSize = 15; let allLogs = [];
                async function update() {
                    try {
                        const r = await fetch('/status'); const d = await r.json();
                        allLogs = d.logs;
                        document.getElementById('exName').innerText = d.stats.currentEx;
                        document.getElementById('pairName').innerText = d.stats.currentPair;
                        document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
                        document.getElementById('bestRoi').innerText = d.stats.bestRoi.toFixed(3) + '%';
                        document.getElementById('totalProfit').innerText = '$' + d.stats.totalProfit.toFixed(2);
                        render();
                    } catch(e) {}
                }
                function render() {
                    const totalPages = Math.max(1, Math.ceil(allLogs.length / pageSize));
                    const start = (currentPage-1)*pageSize;
                    const pageLogs = allLogs.slice(start, start+pageSize);
                    document.getElementById('logContent').innerHTML = pageLogs.map(l => \`
                        <div class="log-row">
                            <span><span class="ex-tag" style="color:\${l.color}; border-color:\${l.color}">\${l.ex}</span> <small style="color:#64748b">[\${l.time}]</small> \${l.path}</span>
                            <span style="text-align:right"><span class="green">+\$ \${l.profit}</span><br><small style="color:#64748b">ROI: \${l.roi}%</small></span>
                        </div>
                    \`).join('') || '<div style="padding:100px; text-align:center">Scanning for realistic spreads...</div>';
                    document.getElementById('pageInfo').innerText = "Page " + currentPage + " of " + totalPages;
                    document.getElementById('prevBtn').disabled = currentPage === 1;
                    document.getElementById('nextBtn').disabled = currentPage >= totalPages;
                }
                function changePage(s) { currentPage = Math.max(1, currentPage + s); render(); }
                setInterval(update, 500);
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => runMasterLoop());
