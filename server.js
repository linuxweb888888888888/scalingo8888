const axios = require('axios');
const express = require('express');
const { HttpsProxyAgent } = require('https-proxy-agent');
const app = express();

const port = process.env.PORT || 3000;
const WALLET_PRINCIPAL = 10.00;
const API_BASE = 'https://api.kcex.com/api/v1';

let metrics = {
    totalScans: 0,
    simulatedProfit: 0,
    history: [],
    liveAnalysis: [],
    status: "Initializing...",
    proxyInUse: "None",
    activePaths: 0,
    errors: 0
};

let monitoredPaths = [];
let proxyList = [];
let currentAgent = null;

// 1. Scrape fresh proxies from multiple sources
async function refreshProxyList() {
    try {
        metrics.status = "Scraping fresh proxy list...";
        // Fixed ProxyScrape URL + Fallback
        const sources = [
            'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
            'https://www.proxy-list.download/api/v1/get?type=http'
        ];
        
        let allProxies = [];
        for (let url of sources) {
            try {
                const res = await axios.get(url, { timeout: 5000 });
                const list = res.data.split(/\r?\n/).filter(p => p.trim().includes(':'));
                allProxies = [...allProxies, ...list];
            } catch (e) { continue; }
        }

        // Shuffle list to avoid everyone using the same "top" proxy
        proxyList = allProxies.sort(() => Math.random() - 0.5);
        console.log(`Found ${proxyList.length} potential proxies.`);
        return proxyList.length > 0;
    } catch (e) {
        metrics.status = "Failed to fetch any proxies.";
        return false;
    }
}

// 2. Find a proxy that bypasses Cloudflare 403
async function findWorkingProxy() {
    if (proxyList.length < 5) await refreshProxyList();

    let attempts = 0;
    while (attempts < 15) {
        const proxy = proxyList.shift();
        if (!proxy) break;

        const testAgent = new HttpsProxyAgent(`http://${proxy.trim()}`);
        metrics.status = `Testing: ${proxy.trim()}...`;
        
        try {
            // Test against KCEX Symbols endpoint
            const res = await axios.get(`${API_BASE}/market/symbols`, { 
                httpsAgent: testAgent, 
                timeout: 4000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            
            if (res.data && res.data.data) {
                currentAgent = testAgent;
                metrics.proxyInUse = proxy;
                return true;
            }
        } catch (e) {
            attempts++;
            console.log(`Proxy ${proxy} failed.`);
        }
    }
    return false;
}

async function mapKcex() {
    try {
        const res = await axios.get(`${API_BASE}/market/symbols`, { 
            httpsAgent: currentAgent,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const symbols = res.data.data;
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

        monitoredPaths = paths.slice(0, 800);
        metrics.activePaths = monitoredPaths.length;
        metrics.status = "Scanner Active";
    } catch (e) {
        metrics.status = "Cloudflare Blocked Proxy. Rotating...";
        currentAgent = null;
    }
}

async function startScanner() {
    if (!currentAgent) {
        const found = await findWorkingProxy();
        if (!found) {
            metrics.status = "No working proxies found. Retrying scraper...";
            proxyList = [];
            setTimeout(startScanner, 5000);
            return;
        }
    }

    if (monitoredPaths.length === 0) {
        await mapKcex();
        setTimeout(startScanner, 1000);
        return;
    }

    try {
        const response = await axios.get(`${API_BASE}/market/ticker/bookTicker`, { 
            httpsAgent: currentAgent,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
        });

        if (!response.data || !response.data.data) throw new Error("Empty Ticker");

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
                if (!t || !t.ask || t.ask === 0) { valid = false; break; }
                bal = step.type === 'buy' ? (bal / t.ask) : (bal * t.bid);
            }
            if (!valid) continue;
            const roi = ((bal - WALLET_PRINCIPAL) / WALLET_PRINCIPAL) * 100;
            if (roi > -0.5) batchData.push({ path: `${path[0].pair}→${path[1].pair}→${path[2].pair}`, roi });
            if (roi > 0.01) {
                metrics.simulatedProfit += (bal - WALLET_PRINCIPAL);
                metrics.history.unshift({ path: path.map(p=>p.pair).join('→'), roi: roi.toFixed(3)+'%', time: new Date().toLocaleTimeString() });
                if (metrics.history.length > 10) metrics.history.pop();
            }
        }
        metrics.liveAnalysis = batchData.sort((a,b) => b.roi - a.roi).slice(0, 10);
        metrics.totalScans++;
    } catch (e) {
        metrics.errors++;
        if (metrics.errors > 3) {
            metrics.status = "Proxy unstable. Rotating...";
            currentAgent = null;
            metrics.errors = 0;
        }
    }
    setTimeout(startScanner, 3000);
}

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#94a3b8; font-family:monospace; padding:20px;">
            <h2 style="color:#f1f5f9">KCEX ARB MONITOR (0% FEE)</h2>
            <div style="background:#1e293b; padding:15px; border-radius:8px; border:1px solid #334155; margin-bottom:20px;">
                <p>Engine Status: <span style="color:${metrics.status.includes('Active') ? '#4ade80' : '#fb7185'}">${metrics.status}</span></p>
                <p>Proxy IP: <span style="color:#38bdf8">${metrics.proxyInUse}</span></p>
                <p>Total Profit: <span style="color:#4ade80; font-size:1.5em;">$${metrics.simulatedProfit.toFixed(6)}</span></p>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div style="background:#0f172a; padding:15px; border-radius:8px;">
                    <h3>Live Best ROI</h3>
                    ${metrics.liveAnalysis.map(a => `<div style="margin-bottom:5px;"><span style="color:#4ade80">${a.roi.toFixed(3)}%</span> | ${a.path}</div>`).join('')}
                </div>
                <div style="background:#0f172a; padding:15px; border-radius:8px;">
                    <h3>Log</h3>
                    ${metrics.history.map(h => `<div style="font-size:0.9em">${h.time}: <span style="color:#4ade80">${h.roi}</span></div>`).join('')}
                </div>
            </div>
            <script>setTimeout(() => location.reload(), 4000);</script>
        </body>
    `);
});

app.listen(port, () => { startScanner(); });
