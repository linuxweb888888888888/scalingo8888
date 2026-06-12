// bot-flashloan.js - SIMPLIFIED WORKING VERSION
// Uses public RPC and simpler price fetching

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== USE PUBLIC RPC (MORE RELIABLE) ====================
// Your QuickNode URL might be rate limiting - let's use public fallbacks
const RPC_URLS = [
    "https://polygon-rpc.com/",
    "https://rpc-mainnet.matic.network",
    "https://rpc-mainnet.matic.quiknode.pro",
    "https://matic-mainnet.chainstacklabs.com",
    "https://matic-mainnet-full-rpc.bwarelabs.com"
];

let currentRpcIndex = 0;
let provider;

// ==================== TOKENS ====================
const TOKENS = {
    USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, symbol: "USDC" },
    WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, symbol: "WETH" },
    POL: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, symbol: "POL" },
    WBTC: { address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, symbol: "WBTC" },
    AAVE: { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, symbol: "AAVE" },
    LINK: { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, symbol: "LINK" }
};

// ==================== DEXES ====================
const QUICKSWAP_ROUTER = "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE ====================
let opportunities = [];
let allSpreads = [];
let totalScans = 0;
let lastScanTime = null;
let connected = false;
let lastError = null;

// ==================== CREATE PROVIDER WITH FALLBACK ====================
async function getProvider() {
    for (let i = 0; i < RPC_URLS.length; i++) {
        try {
            const testProvider = new ethers.JsonRpcProvider(RPC_URLS[i]);
            await testProvider.getBlockNumber();
            console.log(`✅ Connected to RPC: ${RPC_URLS[i].substring(0, 50)}...`);
            return testProvider;
        } catch (e) {
            console.log(`❌ Failed RPC ${i + 1}: ${e.message.substring(0, 50)}`);
        }
    }
    throw new Error("No working RPC found");
}

// ==================== GET PRICE WITH RETRY ====================
async function getPrice(token, routerAddress, retryCount = 0) {
    try {
        const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
        const path = [token.address, TOKENS.USDC.address];
        const amountIn = ethers.parseUnits("0.01", token.decimals);
        const amounts = await router.getAmountsOut(amountIn, path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.01;
        return price;
    } catch (error) {
        if (retryCount < 2) {
            await new Promise(r => setTimeout(r, 500));
            return getPrice(token, routerAddress, retryCount + 1);
        }
        return null;
    }
}

// ==================== SCAN FOR OPPORTUNITIES ====================
async function scan() {
    totalScans++;
    const startTime = Date.now();
    const timestamp = new Date().toLocaleTimeString();
    
    console.log(`[${timestamp}] 🔍 Scan #${totalScans} - Getting prices...`);
    
    const quickPrices = {};
    const sushiPrices = {};
    let pricesFound = 0;
    
    // Get prices from both DEXes
    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (symbol === 'USDC') continue;
        
        const quickPrice = await getPrice(token, QUICKSWAP_ROUTER);
        const sushiPrice = await getPrice(token, SUSHISWAP_ROUTER);
        
        if (quickPrice) {
            quickPrices[symbol] = quickPrice;
            pricesFound++;
        }
        if (sushiPrice) {
            sushiPrices[symbol] = sushiPrice;
            pricesFound++;
        }
        
        // Small delay between requests
        await new Promise(r => setTimeout(r, 100));
    }
    
    const scanTime = Date.now() - startTime;
    const newSpreads = [];
    
    // Check each token for spreads
    for (const [symbol, quickPrice] of Object.entries(quickPrices)) {
        const sushiPrice = sushiPrices[symbol];
        if (sushiPrice) {
            const buyPrice = Math.min(quickPrice, sushiPrice);
            const sellPrice = Math.max(quickPrice, sushiPrice);
            const diff = sellPrice - buyPrice;
            const spreadPercent = (diff / buyPrice) * 100;
            const profitOn500 = diff * 500;
            
            const spread = {
                token: symbol,
                buyDex: quickPrice < sushiPrice ? "QuickSwap" : "SushiSwap",
                sellDex: quickPrice < sushiPrice ? "SushiSwap" : "QuickSwap",
                buyPrice: buyPrice,
                sellPrice: sellPrice,
                spreadPercent: spreadPercent.toFixed(3),
                profit: profitOn500.toFixed(2),
                timestamp: timestamp,
                scanId: totalScans
            };
            
            newSpreads.push(spread);
            allSpreads.unshift(spread);
            
            if (profitOn500 > 0.10) {
                opportunities.unshift(spread);
                console.log(`[${timestamp}] 🎯 ${symbol}: ${spreadPercent.toFixed(3)}% spread → $${profitOn500.toFixed(2)} profit (${spread.buyDex} → ${spread.sellDex})`);
            }
        }
    }
    
    // Keep only last 100
    allSpreads = allSpreads.slice(0, 100);
    opportunities = opportunities.slice(0, 50);
    lastScanTime = timestamp;
    
    // Log summary
    if (newSpreads.length === 0) {
        console.log(`[${timestamp}] 📊 Scan #${totalScans}: ${pricesFound} prices found, no spreads (${scanTime}ms)`);
    } else {
        const best = newSpreads.reduce((a, b) => parseFloat(a.profit) > parseFloat(b.profit) ? a : b);
        console.log(`[${timestamp}] 📊 Found ${newSpreads.length} spreads! Best: ${best.token} +${best.spreadPercent}% ($${best.profit})`);
    }
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    while (true) {
        if (!connected) {
            try {
                provider = await getProvider();
                connected = true;
                lastError = null;
                console.log("✅ Connected to Polygon!");
            } catch (error) {
                console.log(`❌ Connection failed: ${error.message}`);
                connected = false;
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
        }
        
        try {
            await scan();
        } catch (error) {
            console.log(`❌ Scan error: ${error.message}`);
            connected = false;
        }
        
        await new Promise(r => setTimeout(r, 10000)); // Scan every 10 seconds
    }
}

// ==================== API ====================
app.get('/api/state', (req, res) => {
    const profitableCount = opportunities.filter(o => parseFloat(o.profit) > 0.50).length;
    const bestSpread = opportunities.length > 0 ? opportunities[0].spreadPercent : "0";
    const bestProfit = opportunities.length > 0 ? opportunities[0].profit : "0";
    
    res.json({
        connected: connected,
        totalScans: totalScans,
        lastScan: lastScanTime,
        opportunitiesFound: opportunities.length,
        profitableCount: profitableCount,
        bestSpread: bestSpread,
        bestProfit: bestProfit,
        opportunities: opportunities.slice(0, 15),
        allSpreads: allSpreads.slice(0, 20),
        lastError: lastError
    });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Scanner - Live Arbitrage Finder</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            padding: 24px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 24px 32px;
            margin-bottom: 24px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            border: 1px solid #e1e4e8;
        }
        .header h1 { font-size: 28px; color: #1a1a2e; }
        .status { display: inline-block; padding: 4px 12px; background: #28a745; color: white; border-radius: 20px; font-size: 12px; margin-left: 12px; }
        .subtitle { color: #6c757d; margin-top: 8px; }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 16px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: white;
            border-radius: 16px;
            padding: 20px;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            border: 1px solid #e1e4e8;
        }
        .stat-value { font-size: 32px; font-weight: 700; color: #1a1a2e; }
        .stat-value.green { color: #28a745; }
        .stat-label { font-size: 12px; color: #6c757d; margin-top: 8px; text-transform: uppercase; }
        
        .card {
            background: white;
            border-radius: 16px;
            margin-bottom: 24px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            border: 1px solid #e1e4e8;
        }
        .card-header {
            padding: 16px 20px;
            background: #f8f9fa;
            border-bottom: 1px solid #e1e4e8;
            font-weight: 600;
            font-size: 16px;
        }
        
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px 16px; background: #f8f9fa; color: #6c757d; font-weight: 600; font-size: 12px; }
        td { padding: 12px 16px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        .profit-positive { color: #28a745; font-weight: 600; }
        .spread-high { color: #28a745; }
        
        .refresh-note {
            text-align: center;
            color: #6c757d;
            font-size: 12px;
            margin-top: 20px;
        }
        
        button {
            background: #28a745;
            color: white;
            border: none;
            padding: 6px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
        }
        button:hover { background: #218838; }
        
        .log-entry {
            padding: 8px 16px;
            border-bottom: 1px solid #e9ecef;
            font-family: monospace;
            font-size: 11px;
        }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>⚡ Flash Loan Arbitrage Scanner <span class="status" id="status">● LIVE</span></h1>
        <p class="subtitle">Scanning QuickSwap + SushiSwap | Finds opportunities within minutes</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="scans">0</div><div class="stat-label">Scans</div></div>
        <div class="stat-card"><div class="stat-value green" id="opportunities">0</div><div class="stat-label">Opportunities</div></div>
        <div class="stat-card"><div class="stat-value" id="profitable">0</div><div class="stat-label">Profitable (>$0.50)</div></div>
        <div class="stat-card"><div class="stat-value" id="bestSpread">0%</div><div class="stat-label">Best Spread</div></div>
        <div class="stat-card"><div class="stat-value green" id="bestProfit">$0</div><div class="stat-label">Best Profit</div></div>
    </div>

    <div class="card">
        <div class="card-header">🎯 Live Arbitrage Opportunities</div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>Time</th><th>Token</th><th>Buy → Sell</th><th>Buy Price</th><th>Sell Price</th><th>Spread</th><th>Profit ($500)</th><th></th></tr>
                </thead>
                <tbody id="opportunitiesBody">
                    <tr><td colspan="8" style="text-align:center; padding:40px;">Scanning for opportunities... (first results in 30-60 seconds)</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">📊 Recent Spreads</div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>Time</th><th>Token</th><th>Arbitrage Path</th><th>Spread</th><th>Profit ($500)</th></tr>
                </thead>
                <tbody id="spreadsBody">
                    <tr><td colspan="5" style="text-align:center; padding:40px;">Waiting for first scan...</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="refresh-note">🔄 Auto-refreshes every 3 seconds | Scans every 10 seconds | Finds opportunities within 1-2 minutes</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('scans').innerText = data.totalScans || 0;
            document.getElementById('opportunities').innerText = data.opportunitiesFound || 0;
            document.getElementById('profitable').innerText = data.profitableCount || 0;
            document.getElementById('bestSpread').innerText = data.bestSpread + '%';
            document.getElementById('bestProfit').innerText = '$' + data.bestProfit;
            
            // Opportunities table
            const oppsBody = document.getElementById('opportunitiesBody');
            if (data.opportunities && data.opportunities.length > 0) {
                let html = '';
                for (let opp of data.opportunities.slice(0, 10)) {
                    const profitClass = parseFloat(opp.profit) > 0.50 ? 'profit-positive' : '';
                    html += '<tr>' +
                        '<td>' + opp.timestamp + '</td>' +
                        '<td><strong>' + opp.token + '</strong></td>' +
                        '<td>' + opp.buyDex + ' → ' + opp.sellDex + '</td>' +
                        '<td>$' + opp.buyPrice.toFixed(4) + '</td>' +
                        '<td>$' + opp.sellPrice.toFixed(4) + '</td>' +
                        '<td class="spread-high">+' + opp.spreadPercent + '%</td>' +
                        '<td class="' + profitClass + '">$' + opp.profit + '</td>' +
                        '<td><button onclick="alert(\'Execute: ' + opp.token + ' from ' + opp.buyDex + ' to ' + opp.sellDex + '\')">Execute</button></td>' +
                        '</tr>';
                }
                oppsBody.innerHTML = html;
            } else {
                oppsBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px;">No opportunities yet. Bot is scanning... (first results in 1-2 min)</td></tr>';
            }
            
            // All spreads table
            const spreadsBody = document.getElementById('spreadsBody');
            if (data.allSpreads && data.allSpreads.length > 0) {
                let html = '';
                for (let s of data.allSpreads.slice(0, 15)) {
                    html += '<tr>' +
                        '<td>' + s.timestamp + '</td>' +
                        '<td><strong>' + s.token + '</strong></td>' +
                        '<td>' + s.buyDex + ' → ' + s.sellDex + '</td>' +
                        '<td class="spread-high">+' + s.spreadPercent + '%</td>' +
                        '<td>$' + s.profit + '</td>' +
                        '</tr>';
                }
                spreadsBody.innerHTML = html;
            }
            
            // Status indicator
            if (data.connected) {
                document.getElementById('status').innerHTML = '● LIVE';
                document.getElementById('status').style.background = '#28a745';
            } else {
                document.getElementById('status').innerHTML = '● CONNECTING';
                document.getElementById('status').style.background = '#ffc107';
            }
        } catch(e) { console.error(e); }
    }
    
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>`;
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ FLASH LOAN ARBITRAGE SCANNER');
    console.log('='.repeat(60));
    console.log('Using multiple public RPC endpoints for reliability');
    console.log('Tokens: WETH, POL, WBTC, AAVE, LINK');
    console.log('DEXes: QuickSwap + SushiSwap');
    console.log('Scan interval: 10 seconds');
    console.log('='.repeat(60));
    console.log('\n📊 Dashboard: http://localhost:' + PORT);
    console.log('⏱️  First results in 30-60 seconds\n');
    
    // Start the main loop without waiting
    mainLoop().catch(console.error);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Scanner active - watching for arbitrage opportunities`);
    });
}

start();
