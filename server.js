const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

// --- 1. EXCHANGE CONFIGURATION ---
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

// --- 2. DYNAMIC INITIALIZATION ---
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

// --- 3. BOT STATE ---
const START_CAPITAL = 100; // All profit calcs based on $100 trades
let logs = [];
let allPaths = {};
let stats = { 
    scanned: 0, 
    bestRoi: -100, 
    totalProfitFound: 0, 
    currentEx: 'Booting...', 
    currentPair: '---' 
};

// --- 4. PATHFINDER ---
async function buildPaths(id) {
    try {
        const ex = exchanges[id].inst;
        const markets = await ex.loadMarkets();
        const symbols = Object.keys(markets).filter(s => markets[s].active);
        const paths = [];
        const quotes = ['BTC', 'ETH', 'USDC', 'BNB', 'TRX', 'SOL'];
        
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

// --- 5. MASTER LOOP ---
async function runMasterLoop() {
    for (const id in exchanges) { allPaths[id] = await buildPaths(id); }
    
    while (true) {
        for (const id in exchanges) {
            if (!allPaths[id]?.length) continue;
            stats.currentEx = exchanges[id].name;
            const ex = exchanges[id];
            
            try {
                const tickers = await ex.inst.fetchTickers();
                for (const path of allPaths[id]) {
                    stats.scanned++;
                    stats.currentPair = path.s2;

                    const t1 = tickers[path.s1], t2 = tickers[path.s2], t3 = tickers[path.s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    // Compounded trade: USDT -> Quote -> Alt -> USDT
                    const gross = (START_CAPITAL / t1.ask / t2.ask) * t3.bid;
                    const net = gross * Math.pow((1 - ex.fee), 3);
                    
                    const netProfit = net - START_CAPITAL;
                    const roi = (netProfit / START_CAPITAL) * 100;

                    if (roi > stats.bestRoi) stats.bestRoi = roi;

                    if (roi > 0.01) {
                        stats.totalProfitFound += netProfit;
                        logs.unshift({ 
                            time: new Date().toLocaleTimeString(), 
                            ex: ex.name, 
                            path: `${path.s1}>${path.s2}>${path.s3}`, 
                            roi: roi.toFixed(4), 
                            profit: netProfit.toFixed(4),
                            color: ex.color 
                        });
                        if (logs.length > 1000) logs.pop();
                    }
                }
            } catch (e) {}
            await new Promise(r => setTimeout(r, 2500));
        }
    }
}

// --- 6. DASHBOARD & UI ---
app.get('/status', (req, res) => res.json({ stats, logs }));
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ArbFleet Pro v3.0</title>
            <style>
                body { background: #020617; color: #f1f5f9; font-family: 'Inter', sans-serif; padding: 20px; margin: 0; }
                .wrapper { max-width: 1200px; margin: auto; }
                .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
                .ticker-val { font-size: 1.8rem; font-weight: 800; color: #38bdf8; }
                .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
                .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
                .log-box { background: #020617; min-height: 650px; border-radius: 12px; border: 1px solid #1e293b; overflow: hidden; display: flex; flex-direction: column; }
                .log-header { background: #1e293b; padding: 12px 20px; display: flex; justify-content: space-between; font-size: 0.8rem; color: #94a3b8; font-weight: bold; }
                .log-row { display: flex; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid #0f172a; font-size: 0.85rem; align-items: center; }
                .ex-tag { padding: 3px 10px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; border: 1px solid; }
                .green { color: #4ade80; font-weight: bold; }
                .roi-col { text-align: right; min-width: 150px; }
                .pagination { display: flex; justify-content: center; align-items: center; gap: 20px; padding: 20px; background: #0f172a; border-top: 1px solid #1e293b; }
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
                    <div class="stat-card"><small style="color:#64748b">TOTAL SCANS</small><br><b id="totalScanned">0</b></div>
                    <div class="stat-card"><small style="color:#64748b">BEST ROI</small><br><b id="bestRoi" class="green">0%</b></div>
                    <div class="stat-card"><small style="color:#64748b">CUMULATIVE PROFIT</small><br><b id="totalProfit" class="green">$0.00</b></div>
                    <div class="stat-card"><small style="color:#64748b">FLEET SIZE</small><br><b>${Object.keys(exchanges).length} EXCHANGES</b></div>
                </div>

                <div class="log-box">
                    <div class="log-header"><span>EXCHANGE & TRIANGLE PATH</span><span style="text-align:right">NET PROFIT / ROI</span></div>
                    <div id="logContent" style="flex:1"></div>
                    <div class="pagination">
                        <button id="prevBtn" onclick="changePage(-1)">PREV</button>
                        <span id="pageInfo">Page 1 of 1</span>
                        <button id="nextBtn" onclick="changePage(1)">NEXT</button>
                    </div>
                </div>
            </div>

            <script>
                let currentPage = 1;
                const pageSize = 15;
                let allLogs = [];

                async function update() {
                    try {
                        const res = await fetch('/status');
                        const data = await res.json();
                        allLogs = data.logs;

                        document.getElementById('exName').innerText = data.stats.currentEx;
                        document.getElementById('pairName').innerText = data.stats.currentPair;
                        document.getElementById('totalScanned').innerText = data.stats.scanned.toLocaleString();
                        document.getElementById('bestRoi').innerText = data.stats.bestRoi.toFixed(3) + '%';
                        document.getElementById('totalProfit').innerText = '$' + data.stats.totalProfitFound.toFixed(2);

                        renderLogs();
                    } catch (e) {}
                }

                function renderLogs() {
                    const totalPages = Math.max(1, Math.ceil(allLogs.length / pageSize));
                    if (currentPage > totalPages) currentPage = totalPages;
                    const start = (currentPage - 1) * pageSize;
                    const pageLogs = allLogs.slice(start, start + pageSize);

                    const html = pageLogs.map(l => \`
                        <div class="log-row">
                            <span>
                                <span class="ex-tag" style="color:\${l.color}; border-color:\${l.color}">\${l.ex}</span>
                                <span style="color:#64748b">[\${l.time}]</span> 
                                <b style="margin-left:10px">\${l.path}</b>
                            </span>
                            <span class="roi-col">
                                <span class="green">+\$ \${l.profit}</span><br>
                                <small style="color:#64748b">ROI: \${l.roi}%</small>
                            </span>
                        </div>
                    \`).join('');

                    document.getElementById('logContent').innerHTML = html || '<div style="padding:100px; text-align:center; color:#475569">Scanning for profit...</div>';
                    document.getElementById('pageInfo').innerText = \`Page \${currentPage} of \${totalPages}\`;
                    document.getElementById('prevBtn').disabled = currentPage === 1;
                    document.getElementById('nextBtn').disabled = currentPage === totalPages;
                }

                function changePage(step) { currentPage += step; renderLogs(); }
                setInterval(update, 500);
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => runMasterLoop());
