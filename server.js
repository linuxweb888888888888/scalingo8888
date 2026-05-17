const express = require('express');
const ccxt = require('ccxt');
const app = express();
const port = process.env.PORT || 3000;

const exchange = new ccxt.lbank({ apiKey: 'YOUR_KEY', secret: 'YOUR_SECRET' });
const TAKER_FEE = 0.001; // 0.1%
const START_CAPITAL = 100;

let logs = [];
let trianglePaths = [];
let lastScanTime = "Initializing...";
let stats = { scanned: 0, paths: 0, bestRoi: -100, uptime: Date.now() };

async function initBot() {
    console.log("Deep Scanning LBank Markets...");
    const markets = await exchange.loadMarkets();
    const symbols = Object.keys(markets).filter(s => markets[s].active);
    
    const usdtPairs = symbols.filter(s => markets[s].quote === 'USDT');
    const btcPairs = symbols.filter(s => markets[s].quote === 'BTC');
    const ethPairs = symbols.filter(s => markets[s].quote === 'ETH');
    const usdcPairs = symbols.filter(s => markets[s].quote === 'USDC');

    // PATH TYPE 1: USDT -> BTC -> ALT -> USDT
    for (const btcPair of btcPairs) {
        const alt = btcPair.split('/')[0];
        if (markets[`${alt}/USDT`] && markets['BTC/USDT']) {
            trianglePaths.push({type: 'BBS', s1: 'BTC/USDT', s2: btcPair, s3: `${alt}/USDT`});
            trianglePaths.push({type: 'BSS', s1: `${alt}/USDT`, s2: btcPair, s3: 'BTC/USDT'});
        }
    }

    // PATH TYPE 2: USDT -> USDC -> ALT -> USDT (Very active!)
    for (const usdcPair of usdcPairs) {
        const alt = usdcPair.split('/')[0];
        if (markets[`${alt}/USDT`] && markets['USDC/USDT']) {
            trianglePaths.push({type: 'BBS', s1: 'USDC/USDT', s2: usdcPair, s3: `${alt}/USDT`});
        }
    }

    stats.paths = trianglePaths.length;
    console.log(`Expansion Complete: Monitoring ${trianglePaths.length} paths.`);
    runLoop();
}

async function runLoop() {
    while (true) {
        try {
            const tickers = await exchange.fetchTickers();
            lastScanTime = new Date().toLocaleTimeString();
            
            for (const path of trianglePaths) {
                stats.scanned++;
                const {s1, s2, s3, type} = path;
                if (!tickers[s1] || !tickers[s2] || !tickers[s3]) continue;

                let final = 0;
                if (type === 'BBS') {
                    // Buy A with USDT -> Buy B with A -> Sell B for USDT
                    final = (START_CAPITAL / tickers[s1].ask / tickers[s2].ask) * tickers[s3].bid;
                } else {
                    // Buy B with USDT -> Sell B for A -> Sell A for USDT
                    final = (START_CAPITAL / tickers[s1].ask) * tickers[s2].bid * tickers[s3].bid;
                }

                const net = final * Math.pow((1 - TAKER_FEE), 3);
                const roi = ((net - START_CAPITAL) / START_CAPITAL) * 100;

                if (roi > -5) { // Track best ROI even if negative to show it's working
                    if (roi > stats.bestRoi) stats.bestRoi = roi;
                }

                if (roi > 0.01) {
                    logs.unshift({ time: lastScanTime, path: `${s1}>${s2}>${s3}`, roi: roi.toFixed(4) });
                    if (logs.length > 50) logs.pop();
                }
            }
        } catch (e) { console.log("API Error"); }
        await new Promise(r => setTimeout(r, 3000));
    }
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#0f172a; color:#f8fafc; font-family:monospace; padding:20px;">
            <div style="max-width:800px; margin:auto;">
                <h2>LBank Pro Scanner</h2>
                <div style="display:flex; gap:10px; margin-bottom:20px;">
                    <div style="background:#1e293b; padding:15px; flex:1; border-radius:8px;">
                        PATHS: <b>${stats.paths}</b>
                    </div>
                    <div style="background:#1e293b; padding:15px; flex:1; border-radius:8px;">
                        BEST ROI: <b style="color:${stats.bestRoi > 0 ? '#4ade80' : '#f87171'}">${stats.bestRoi.toFixed(3)}%</b>
                    </div>
                </div>
                <div style="background:#020617; padding:20px; height:400px; overflow-y:auto; border-radius:8px; border:1px solid #1e293b;">
                    ${logs.length > 0 ? logs.map(l => `<div>[${l.time}] ${l.path} <span style="float:right; color:#4ade80">+${l.roi}%</span></div>`).join('') : 'Scanning for spreads > 0.30%...'}
                </div>
            </div>
            <script>setTimeout(()=>location.reload(), 5000)</script>
        </body>
    `);
});

app.listen(port, () => initBot());
