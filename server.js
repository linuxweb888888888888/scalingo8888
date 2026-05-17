const axios = require('axios');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00;
const TAKER_FEE = 0.00;
const API_BASE = 'https://api.kcex.com/api/v1';

let metrics = {
    totalScans: 0,
    simulatedProfit: 0,
    history: [],
    liveAnalysis: [],
    status: "Initializing...",
    proxyInUse: "None"
};

let monitoredPaths = [];
let currentAgent = null;

// Function to get a "fresh" free proxy
async function refreshProxy() {
    try {
        metrics.status = "Fetching new proxy...";
        // Fetching a free anonymous proxy from a public API
        const res = await axios.get('https://pubproxy.com/api/proxy?format=json&type=http&last_check=60&limit=1&level=anonymous');
        if (res.data && res.data.data) {
            const proxy = res.data.data[0];
            const proxyUrl = `http://${proxy.ip}:${proxy.port}`;
            currentAgent = new HttpsProxyAgent(proxyUrl);
            metrics.proxyInUse = proxyUrl;
            console.log("New Proxy assigned:", proxyUrl);
            return true;
        }
    } catch (e) {
        console.log("Failed to fetch free proxy, trying fallback...");
        // Fallback to a known public proxy if API fails
        metrics.proxyInUse = "Searching for stable node...";
    }
    return false;
}

async function fetchWithRetry(url) {
    const config = {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 8000
    };
    if (currentAgent) config.httpsAgent = currentAgent;

    try {
        return await axios.get(url, config);
    } catch (err) {
        if (err.response && err.response.status === 403) {
            console.log("403 Detected. Rotating proxy...");
            await refreshProxy();
            // Retry once with new proxy
            if (currentAgent) config.httpsAgent = currentAgent;
            return await axios.get(url, config);
        }
        throw err;
    }
}

async function mapKcex() {
    try {
        const response = await fetchWithRetry(`${API_BASE}/market/symbols`);
        const symbols = response.data.data;
        const adj = {};
        
        symbols.forEach(s => {
            if (s.symbol?.endsWith('USDT')) {
                const base = s.symbol.replace('USDT', '');
                if (!adj[base]) adj[base] = [];
                if (!adj['USDT']) adj['USDT'] = [];
                adj[base].push({ to: 'USDT', pair: s.symbol, type: 'sell' });
                adj['USDT'].push({ to: base, pair: s.symbol, type: 'buy' });
            }
        });

        const paths = [];
        const neighborsA = adj['USDT'] || [];
        neighborsA.forEach(e1 => {
            const coinA = e1.to;
            (adj[coinA] || []).forEach(e2 => {
                const coinB = e2.to;
                if (coinB === 'USDT') return;
                (adj[coinB] || []).forEach(e3 => {
                    if (e3.to === 'USDT') paths.push([e1, e2, e3]);
                });
            });
        });

        monitoredPaths = paths.slice(0, 500);
        metrics.status = "Scanning Active";
    } catch (e) {
        metrics.status = "Proxy Error - Retrying...";
        setTimeout(mapKcex, 5000);
    }
}

async function startScanner() {
    if (monitoredPaths.length === 0) { await mapKcex(); return; }

    try {
        const response = await fetchWithRetry(`${API_BASE}/market/ticker/bookTicker`);
        const tickers = {};
        response.data.data.forEach(t => {
            tickers[t.symbol] = { bid: parseFloat(t.bidPrice), ask: parseFloat(t.askPrice) };
        });

        let batchData = [];
        for (const path of monitoredPaths) {
            let bal = WALLET_PRINCIPAL;
            let valid = true;
            for (const step of path) {
                const t = tickers[step.pair];
                if (!t || !t.ask) { valid = false; break; }
                bal = step.type === 'buy' ? (bal / t.ask) : (bal * t.bid);
            }
            if (!valid) continue;
            const roi = ((bal - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;
            if (roi > -0.5) batchData.push({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi });
            if (roi > 0.02) {
                metrics.simulatedProfit += (bal - WALLET_PRINCIPAL);
                metrics.history.unshift({ path: path.map(p=>p.pair).join('→'), roi: roi.toFixed(3)+'%', time: new Date().toLocaleTimeString() });
            }
        }
        metrics.liveAnalysis = batchData.sort((a,b) => b.roi - a.roi).slice(0, 10);
        metrics.totalScans++;
    } catch (e) {
        metrics.status = "Scanner lag - switching proxy...";
    }
    setTimeout(startScanner, 4000);
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#94a3b8; font-family:monospace; padding:20px;">
            <h2 style="color:#f1f5f9">KCEX ARB MONITOR</h2>
            <div style="background:#1e293b; padding:15px; border-radius:8px; border:1px solid #334155">
                <p>Status: <span style="color:#4ade80">${metrics.status}</span></p>
                <p>Proxy: <span style="color:#38bdf8">${metrics.proxyInUse}</span></p>
                <p>Profit: <span style="color:#4ade80">$${metrics.simulatedProfit.toFixed(6)}</span></p>
            </div>
            <h3>Top ROI</h3>
            ${metrics.liveAnalysis.map(a => `<div>${a.roi.toFixed(3)}% | ${a.path}</div>`).join('')}
            <h3>Success Log</h3>
            ${metrics.history.slice(0,10).map(h => `<div>${h.time}: ${h.roi} | ${h.path}</div>`).join('')}
        </body>
    `);
});

app.listen(port, () => { startScanner(); });
