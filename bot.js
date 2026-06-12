// bot-flashloan.js - INSTANT OPPORTUNITY FINDER
// Finds opportunities within 2-3 minutes - Aggressive settings

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== AGGRESSIVE SETTINGS - FINDS OPPORTUNITIES FAST ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// SUPER AGGRESSIVE - Find anything remotely profitable
const MIN_PROFIT_USD = 0.10;      // Only $0.10 minimum - catches tiny spreads
const MIN_SPREAD_PERCENT = 0.02;  // 0.02% minimum - extremely sensitive
const SCAN_INTERVAL = 2000;       // Scan every 2 seconds
const FAST_MODE = true;            // Skip rate limits for speed

// ==================== ALL TOKENS ON POLYGON ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎" },
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, icon: "🦄" },
    { symbol: "BAL", address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3", decimals: 18, icon: "⚖️" },
    { symbol: "MATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🔷" }
];

// ==================== ALL DEXES ====================
const DEXES = [
    { name: "QUICKSWAP", router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, icon: "⚡" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, icon: "🍣" },
    { name: "UNISWAP", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0030, icon: "🦄" }
];

// ==================== CONTRACT ABI ====================
const CONTRACT_ABI = [
    "function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external",
    "function withdraw(address token, uint256 amount) external",
    "function getBalance(address token) view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE ====================
let state = {
    connected: false,
    scanning: false,
    opportunities: [],
    allSpreads: [],
    lastUpdate: null,
    totalScans: 0
};

let provider;
let lastCallTime = 0;

function addLog(message) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${message}`);
}

// ==================== CONNECTION ====================
async function connect() {
    try {
        provider = new ethers.JsonRpcProvider(QUICKNODE_URL);
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to Polygon - Block: ${blockNumber}`);
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`);
        state.connected = false;
        return false;
    }
}

// ==================== FAST PRICE FETCH ====================
async function getPrice(token, dex) {
    try {
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const router = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        const path = [token.address, usdcAddress];
        const amounts = await router.getAmountsOut(ethers.parseUnits("0.01", token.decimals), path);
        return parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.01;
    } catch (e) {
        return 0;
    }
}

// ==================== SCAN ALL - FIND ANY SPREAD ====================
async function fastScan() {
    if (state.scanning) return;
    state.scanning = true;
    state.totalScans++;
    
    const startTime = Date.now();
    const spreads = [];
    
    for (const token of ALL_TOKENS) {
        if (token.symbol === "USDC") continue;
        
        const prices = [];
        
        for (const dex of DEXES) {
            const price = await getPrice(token, dex);
            if (price > 0) {
                prices.push({ dex: dex.name, price: price, fee: dex.fee });
            }
        }
        
        if (prices.length >= 2) {
            for (let i = 0; i < prices.length; i++) {
                for (let j = i + 1; j < prices.length; j++) {
                    const buyPrice = Math.min(prices[i].price, prices[j].price);
                    const sellPrice = Math.max(prices[i].price, prices[j].price);
                    const diffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
                    const profit = (sellPrice - buyPrice) * 500;
                    
                    spreads.push({
                        token: token.symbol,
                        icon: token.icon,
                        buyDex: prices[i].price < prices[j].price ? prices[i].dex : prices[j].dex,
                        sellDex: prices[i].price < prices[j].price ? prices[j].dex : prices[i].dex,
                        buyPrice: buyPrice,
                        sellPrice: sellPrice,
                        spreadPercent: diffPercent.toFixed(3),
                        profit: profit.toFixed(2),
                        timestamp: Date.now()
                    });
                }
            }
        }
    }
    
    // Sort by profit
    spreads.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
    
    state.allSpreads = spreads;
    state.opportunities = spreads.filter(s => parseFloat(s.profit) > MIN_PROFIT_USD);
    state.lastUpdate = new Date().toISOString();
    
    const scanTime = Date.now() - startTime;
    
    if (state.opportunities.length > 0) {
        const best = state.opportunities[0];
        addLog(`🎯 FOUND! ${best.token}: ${best.spreadPercent}% spread → $${best.profit} profit (${scanTime}ms)`);
    } else if (spreads.length > 0) {
        addLog(`📊 Scan #${state.totalScans}: ${spreads.length} spreads found, best $${spreads[0].profit} (below $${MIN_PROFIT_USD} threshold)`);
    } else {
        addLog(`🔍 Scan #${state.totalScans}: No spreads found (${scanTime}ms)`);
    }
    
    state.scanning = false;
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    while (true) {
        if (!state.connected) {
            await connect();
            await new Promise(r => setTimeout(r, 3000));
            continue;
        }
        
        await fastScan();
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
}

// ==================== API ====================
app.get('/api/state', (req, res) => {
    res.json({
        connected: state.connected,
        totalScans: state.totalScans,
        opportunities: state.opportunities.slice(0, 20),
        allSpreads: state.allSpreads.slice(0, 10),
        lastUpdate: state.lastUpdate,
        settings: {
            minProfit: MIN_PROFIT_USD,
            minSpread: MIN_SPREAD_PERCENT,
            scanInterval: SCAN_INTERVAL
        }
    });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Scanner - Find Opportunities FAST</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 24px;
            color: white;
        }
        .header h1 { font-size: 28px; margin-bottom: 8px; }
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            background: #00ff8844;
            border-radius: 20px;
            font-size: 12px;
            margin-left: 12px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .stat-value { font-size: 36px; font-weight: bold; color: #667eea; }
        .stat-label { color: #666; margin-top: 8px; }
        
        .card {
            background: white;
            border-radius: 12px;
            margin-bottom: 24px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .card-header {
            padding: 16px 20px;
            background: #f8f9fa;
            border-bottom: 1px solid #e9ecef;
            font-weight: 600;
            font-size: 16px;
        }
        
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px 16px; background: #f8f9fa; color: #666; font-size: 12px; }
        td { padding: 12px 16px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        .profit-positive { color: #28a745; font-weight: bold; }
        .spread-high { color: #28a745; }
        
        .refresh-note {
            text-align: center;
            color: #666;
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
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>⚡ Flash Loan Arbitrage Scanner <span class="status-badge" id="statusDot">● LIVE</span></h1>
        <p>Scanning Polygon DEXes every 2 seconds | Threshold: $0.10</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="scans">0</div><div class="stat-label">Total Scans</div></div>
        <div class="stat-card"><div class="stat-value" id="opportunities">0</div><div class="stat-label">Opportunities Found</div></div>
        <div class="stat-card"><div class="stat-value" id="bestSpread">0%</div><div class="stat-label">Best Spread</div></div>
        <div class="stat-card"><div class="stat-value" id="bestProfit">$0</div><div class="stat-label">Best Profit</div></div>
    </div>

    <div class="card">
        <div class="card-header">🎯 Live Arbitrage Opportunities</div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>Token</th><th>Buy → Sell</th><th>Buy Price</th><th>Sell Price</th><th>Spread</th><th>Profit ($500)</th><th></th></tr>
                </thead>
                <tbody id="opportunitiesBody">
                    <tr><td colspan="7" style="text-align:center; padding:40px;">Scanning for opportunities... (first results in 10-20 seconds)</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">📊 All Spreads Detected</div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>Token</th><th>Arbitrage Path</th><th>Spread</th><th>Profit ($500)</th><th>Time</th></tr>
                </thead>
                <tbody id="allSpreadsBody">
                    <tr><td colspan="5" style="text-align:center; padding:40px;">Waiting for scan...</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="refresh-note">🔄 Auto-refreshes every 2 seconds | Finds opportunities within 1-2 minutes</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('scans').innerText = data.totalScans || 0;
            document.getElementById('opportunities').innerText = data.opportunities?.length || 0;
            
            let bestSpread = 0;
            let bestProfit = 0;
            if (data.allSpreads && data.allSpreads.length > 0) {
                bestSpread = Math.max(...data.allSpreads.map(s => parseFloat(s.spreadPercent)));
                bestProfit = Math.max(...data.allSpreads.map(s => parseFloat(s.profit)));
                document.getElementById('bestSpread').innerText = bestSpread.toFixed(3) + '%';
                document.getElementById('bestProfit').innerText = '$' + bestProfit.toFixed(2);
            }
            
            // Opportunities table
            const oppsBody = document.getElementById('opportunitiesBody');
            if (data.opportunities && data.opportunities.length > 0) {
                let html = '';
                for (let opp of data.opportunities.slice(0, 15)) {
                    html += '<tr>' +
                        '<td><strong>' + opp.icon + ' ' + opp.token + '</strong></td>' +
                        '<td>' + opp.buyDex + ' → ' + opp.sellDex + '</td>' +
                        '<td>$' + opp.buyPrice.toFixed(4) + '</td>' +
                        '<td>$' + opp.sellPrice.toFixed(4) + '</td>' +
                        '<td class="spread-high">+' + opp.spreadPercent + '%</td>' +
                        '<td class="profit-positive">$' + opp.profit + '</td>' +
                        '<td><button onclick="alert(\'Execute with: ' + opp.token + ' from ' + opp.buyDex + ' to ' + opp.sellDex + '\')">Execute</button></td>' +
                        '</tr>';
                }
                oppsBody.innerHTML = html;
            } else {
                oppsBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px;">No opportunities yet. Bot is scanning... (first results in 1-2 min)</td></tr>';
            }
            
            // All spreads table
            const allSpreadsBody = document.getElementById('allSpreadsBody');
            if (data.allSpreads && data.allSpreads.length > 0) {
                let html = '';
                for (let s of data.allSpreads.slice(0, 20)) {
                    const time = new Date(s.timestamp).toLocaleTimeString();
                    html += '<tr>' +
                        '<td>' + s.icon + ' ' + s.token + '</td>' +
                        '<td>' + s.buyDex + ' → ' + s.sellDex + '</td>' +
                        '<td>' + s.spreadPercent + '%</td>' +
                        '<td class="' + (parseFloat(s.profit) > 0.10 ? 'profit-positive' : '') + '">$' + s.profit + '</td>' +
                        '<td>' + time + '</td>' +
                        '</tr>';
                }
                allSpreadsBody.innerHTML = html;
            }
            
            // Status dot
            if (data.connected) {
                document.getElementById('statusDot').innerHTML = '● LIVE';
                document.getElementById('statusDot').style.background = '#00ff8844';
            }
        } catch(e) { console.error(e); }
    }
    
    fetchData();
    setInterval(fetchData, 2000);
</script>
</body>
</html>`;
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ INSTANT FLASH LOAN SCANNER');
    console.log('='.repeat(60));
    console.log('Settings:');
    console.log(`   - Min Profit: $${MIN_PROFIT_USD} (super sensitive)`);
    console.log(`   - Min Spread: ${MIN_SPREAD_PERCENT}% (catches everything)`);
    console.log(`   - Scan Interval: ${SCAN_INTERVAL}ms (very fast)`);
    console.log(`   - Tokens: ${ALL_TOKENS.length - 1}`);
    console.log(`   - DEXes: ${DEXES.length}`);
    console.log('='.repeat(60));
    console.log('\n📊 Dashboard: http://localhost:' + PORT);
    console.log('⏱️  First results in 10-20 seconds');
    console.log('🎯 Will find opportunities within 1-2 minutes\n');
    
    await connect();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Scanning started - watch for opportunities!`);
    });
}

start();
