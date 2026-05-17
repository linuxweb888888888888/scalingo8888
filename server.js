const axios = require('axios');
const express = require('express');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00;
const TAKER_FEE = 0.0000; 

// KCEX Mobile API Endpoint (sometimes less protected)
const API_BASE = 'https://api.kcex.com/api/v1';

const stealthConfig = {
    headers: {
        // Impersonating the KCEX Android App
        'User-Agent': 'okhttp/4.9.1',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'x-mxc-sdk-version': '1.0.0',
        'Cache-Control': 'no-cache'
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
        metrics.status = "Attempting Mobile API handshake...";
        const response = await axios.get(`${API_BASE}/market/symbols`, stealthConfig);
        
        if (!response.data || !response.data.data) {
            throw new Error("Empty response from exchange");
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
                coinSet.add(base);
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
        metrics.status = "KCEX Mobile-Link Active";
    } catch (e) {
        let errorMsg = e.response ? `Code ${e.response.status}` : e.message;
        metrics.status = "Connection Failed: " + errorMsg;
        
        if (errorMsg.includes("403")) {
            metrics.status = "BLOCKED BY CLOUDFLARE (IP Block)";
        }
    }
}

async function startScanner() {
    if (monitoredPaths.length === 0) {
        await mapKcexMarkets();
        setTimeout(startScanner, 10000); // Wait longer if blocked
        return;
    }

    try {
        const response = await axios.get(`${API_BASE}/market/ticker/bookTicker`, stealthConfig);
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
            if (roi > -2.0) batchData.push({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi });
            
            if (roi > 0.001) {
                metrics.simulatedProfit += (balance - WALLET_PRINCIPAL);
                metrics.history.unshift({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi: roi.toFixed(4) + '%', time: new Date().toLocaleTimeString() });
                if (metrics.history.length > 10) metrics.history.pop();
            }
        }
        metrics.liveAnalysis = batchData.sort((a, b) => b.roi - a.roi).slice(0, 10);
        metrics.totalScans++;
        metrics.status = "Scanning Active";
    } catch (e) {
        metrics.status = "Scan Interrupted";
    }
    setTimeout(startScanner, 2000);
}

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>KCEX Stealth Monitor</title><meta http-equiv="refresh" content="3">
            <style>
                body { background: #0b0e11; color: #fff; font-family: monospace; padding: 20px; text-align: center;}
                .green { color: #02c076; } .red { color: #ff3b30; }
                .card { background: #1e2329; padding: 20px; border-radius: 10px; border: 1px solid #333; display: inline-block; min-width: 300px; }
                .box { background: #161a1e; padding: 15px; border-radius: 5px; margin-top: 20px; text-align: left; }
                table { width: 100%; margin-top: 10px; border-collapse: collapse; }
                td { padding: 5px; border-bottom: 1px solid #333; }
            </style></head>
            <body>
                <h2>KCEX SCANNER (0% FEES)</h2>
                <div class="card">
                    <div style="font-size: 0.8em; color: #848e9c;">ENGINE STATUS</div>
                    <div class="${metrics.status.includes('BLOCKED') ? 'red' : 'green'}" style="font-size: 1.2em; font-weight: bold;">${metrics.status}</div>
                    <hr style="border: 0; border-top: 1px solid #333; margin: 15px 0;">
                    <div style="font-size: 0.8em; color: #848e9c;">SIMULATED PROFIT</div>
                    <div class="green" style="font-size: 2em;">$${metrics.simulatedProfit.toFixed(6)}</div>
                </div>

                <div style="max-width: 800px; margin: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    <div class="box">
                        <h3>Live Gaps</h3>
                        <table>
                            ${metrics.liveAnalysis.map(a => `<tr><td>${a.path}</td><td class="green">${a.roi.toFixed(3)}%</td></tr>`).join('')}
                        </table>
                    </div>
                    <div class="box">
                        <h3>History</h3>
                        ${metrics.history.map(h => `<div style="font-size: 0.85em; margin-bottom: 5px;">[${h.time}] <span class="green">${h.roi}</span></div>`).join('')}
                    </div>
                </div>
                ${metrics.status.includes('BLOCKED') ? `<p class="red">Your server's IP is banned by KCEX. You must run this locally or use a VPN/Proxy.</p>` : ''}
            </body>
        </html>
    `);
});

app.listen(port, () => { startScanner(); });
