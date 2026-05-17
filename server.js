const axios = require('axios');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00;
const TAKER_FEE = 0.0000; 

// KCEX API Base - We try the 'www' subdomain which sometimes bypasses strict API filters
const API_BASE = 'https://www.kcex.com/api/v1'; 

// Hardened Headers to mimic a real Chrome Browser exactly
const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Origin': 'https://www.kcex.com',
        'Referer': 'https://www.kcex.com/en-US/spot/BTCUSDT',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site'
    },
    timeout: 15000
};

let metrics = {
    totalScans: 0,
    simulatedProfit: 0,
    history: [],
    liveAnalysis: [],
    status: "Initializing...",
    pathsTracked: 0,
    uniqueCoins: 0
};

let monitoredPaths = [];

async function mapKcexMarkets() {
    try {
        console.log("Attempting to reach KCEX...");
        // Using common/symbols instead of market/symbols (sometimes less protected)
        const response = await axios.get(`${API_BASE}/market/symbols`, axiosConfig);
        
        if (!response.data || !response.data.data) {
            throw new Error("Cloudflare blocked the request (403)");
        }

        const symbols = response.data.data;
        const adj = {};
        const coinSet = new Set();

        symbols.forEach(s => {
            if (s.symbol && s.symbol.endsWith('USDT')) {
                const base = s.symbol.replace('USDT', '');
                const quote = 'USDT';
                if (!adj[base]) adj[base] = [];
                if (!adj[quote]) adj[quote] = [];
                adj[base].push({ to: quote, pair: s.symbol, type: 'sell' });
                adj[quote].push({ to: base, pair: s.symbol, type: 'buy' });
                coinSet.add(base); coinSet.add(quote);
            }
        });

        metrics.uniqueCoins = coinSet.size;
        const paths = [];
        const startNode = 'USDT';
        const neighborsA = adj[startNode] || [];

        neighborsA.forEach(edge1 => {
            const coinA = edge1.to;
            const neighborsB = adj[coinA] || [];
            neighborsB.forEach(edge2 => {
                const coinB = edge2.to;
                if (coinB === startNode) return;
                const neighborsC = adj[coinB] || [];
                neighborsC.forEach(edge3 => {
                    if (edge3.to === startNode) {
                        paths.push([edge1, edge2, edge3]);
                    }
                });
            });
        });

        monitoredPaths = paths;
        metrics.pathsTracked = monitoredPaths.length;
        metrics.status = "KCEX Connected";
    } catch (e) {
        let msg = e.response ? `Status ${e.response.status}` : e.message;
        metrics.status = "Connection Failed: " + msg;
        console.log("Error details:", msg);
    }
}

async function startScanner() {
    if (monitoredPaths.length === 0) {
        await mapKcexMarkets();
        setTimeout(startScanner, 5000);
        return;
    }

    try {
        const response = await axios.get(`${API_BASE}/market/ticker/bookTicker`, axiosConfig);
        const tickersArr = response.data.data;
        const tickers = {};
        tickersArr.forEach(t => {
            tickers[t.symbol] = { bid: parseFloat(t.bidPrice), ask: parseFloat(t.askPrice) };
        });

        let batchData = [];
        for (const path of monitoredPaths) {
            let balance = WALLET_PRINCIPAL;
            let valid = true;
            for (const step of path) {
                const ticker = tickers[step.pair];
                if (!ticker || !ticker.ask || !ticker.bid || ticker.ask === 0) { valid = false; break; }
                if (step.type === 'buy') balance = (balance / ticker.ask);
                else balance = (balance * ticker.bid);
            }
            if (!valid) continue;
            const roi = ((balance - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;
            if (roi > -0.5) batchData.push({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi });
            if (roi > 0.01) {
                metrics.simulatedProfit += (balance - WALLET_PRINCIPAL);
                metrics.history.unshift({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi: roi.toFixed(4) + '%', time: new Date().toLocaleTimeString() });
                if (metrics.history.length > 10) metrics.history.pop();
            }
        }
        metrics.liveAnalysis = batchData.sort((a, b) => b.roi - a.roi).slice(0, 10);
        metrics.totalScans++;
        metrics.status = "Scanning Active";
    } catch (e) {
        metrics.status = "Scan Error: " + (e.response ? e.response.status : "Timeout");
    }
    setTimeout(startScanner, 3000);
}

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>KCEX Monitor</title><meta http-equiv="refresh" content="3">
            <style>
                body { background: #0b0e11; color: #fff; font-family: monospace; padding: 20px; }
                .green { color: #02c076; } .red { color: #ff3b30; }
                .card { background: #1e2329; padding: 15px; border-radius: 5px; border: 1px solid #333; margin-bottom: 15px; }
                table { width: 100%; border-collapse: collapse; }
                td { padding: 5px; border-bottom: 1px solid #333; font-size: 0.9em; }
            </style></head>
            <body>
                <h2>KCEX ARB [0% FEE]</h2>
                <div class="card">
                    Status: <span class="${metrics.status.includes('Failed') ? 'red' : 'green'}">${metrics.status}</span><br>
                    Profit: <span class="green">$${metrics.simulatedProfit.toFixed(6)}</span> | 
                    Paths: ${metrics.pathsTracked}
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div>
                        <h3>Top 10 ROI</h3>
                        <table>${metrics.liveAnalysis.map(a => `<tr><td>${a.path}</td><td class="green">${a.roi.toFixed(3)}%</td></tr>`).join('')}</table>
                    </div>
                    <div>
                        <h3>Log</h3>
                        ${metrics.history.map(h => `<div><small>${h.time}</small> <span class="green">${h.roi}</span></div>`).join('')}
                    </div>
                </div>
            </body>
        </html>
    `);
});

app.listen(port, () => { startScanner(); });
