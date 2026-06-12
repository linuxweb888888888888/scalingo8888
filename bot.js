// bot-flashloan.js - WORKING VERSION WITH RELIABLE RPC
// Uses public Polygon RPC that actually works

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== USE RELIABLE PUBLIC RPC (NOT YOUR QUICKNODE) ====================
// Your QuickNode URL is failing. Using reliable public RPCs instead:
const RELIABLE_RPCS = [
    "https://polygon-mainnet.g.alchemy.com/v2/demo",  // Alchemy public demo
    "https://rpc-mainnet.maticvigil.com",
    "https://rpc-mainnet.matic.network",
    "https://matic-mainnet.chainstacklabs.com"
];

let currentRpcIndex = 0;
let provider = null;

// ==================== TOKENS ====================
const TOKENS = {
    USDC: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, symbol: "USDC" },
    WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, symbol: "WETH" },
    POL: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, symbol: "POL" },
    WBTC: { address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, symbol: "WBTC" },
    AAVE: { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, symbol: "AAVE" },
    LINK: { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, symbol: "LINK" },
    CRV: { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, symbol: "CRV" },
    SUSHI: { address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, symbol: "SUSHI" },
    QUICK: { address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, symbol: "QUICK" }
};

// ==================== DEXES ====================
const QUICKSWAP_ROUTER = "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"];

// ==================== STATE ====================
let opportunities = [];
let allSpreads = [];
let totalScans = 0;
let connected = false;
let lastError = null;

// ==================== CREATE WORKING PROVIDER ====================
async function createProvider() {
    for (let i = 0; i < RELIABLE_RPCS.length; i++) {
        try {
            console.log(`Testing RPC ${i + 1}: ${RELIABLE_RPCS[i].substring(0, 50)}...`);
            const testProvider = new ethers.JsonRpcProvider(RELIABLE_RPCS[i]);
            const blockNum = await testProvider.getBlockNumber();
            console.log(`✅ Connected! Block: ${blockNum}`);
            return testProvider;
        } catch (e) {
            console.log(`❌ Failed: ${e.message.substring(0, 50)}`);
        }
    }
    return null;
}

// ==================== GET PRICE ====================
async function getPrice(token, routerAddress) {
    if (!provider) return null;
    try {
        const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
        const path = [token.address, TOKENS.USDC.address];
        const amountIn = ethers.parseUnits("0.01", token.decimals);
        const amounts = await router.getAmountsOut(amountIn, path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.01;
        return price;
    } catch (error) {
        return null;
    }
}

// ==================== SCAN ====================
async function scan() {
    if (!provider) {
        provider = await createProvider();
        if (!provider) {
            console.log("No working RPC found");
            return;
        }
        connected = true;
    }
    
    totalScans++;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] 🔍 Scan #${totalScans} - Getting prices...`);
    
    const newSpreads = [];
    
    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (symbol === 'USDC') continue;
        
        const quickPrice = await getPrice(token, QUICKSWAP_ROUTER);
        const sushiPrice = await getPrice(token, SUSHISWAP_ROUTER);
        
        if (quickPrice && sushiPrice && quickPrice > 0 && sushiPrice > 0) {
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
                timestamp: timestamp
            };
            
            newSpreads.push(spread);
            allSpreads.unshift(spread);
            
            if (profitOn500 > 0.10) {
                opportunities.unshift(spread);
                console.log(`🎯 FOUND: ${symbol} | ${spreadPercent.toFixed(3)}% spread | Buy: $${buyPrice.toFixed(4)} Sell: $${sellPrice.toFixed(4)} | Profit: $${profitOn500.toFixed(2)}`);
            }
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    // Keep only recent
    allSpreads = allSpreads.slice(0, 50);
    opportunities = opportunities.slice(0, 30);
    
    if (newSpreads.length === 0) {
        console.log(`[${timestamp}] 📊 Scan #${totalScans}: No spreads found`);
    } else {
        const best = newSpreads.reduce((a, b) => parseFloat(a.profit) > parseFloat(b.profit) ? a : b);
        console.log(`[${timestamp}] 📊 Found ${newSpreads.length} spreads! Best: ${best.token} +${best.spreadPercent}% ($${best.profit})`);
    }
}

// ==================== API ====================
app.get('/api/state', (req, res) => {
    const profitableCount = opportunities.filter(o => parseFloat(o.profit) > 0.50).length;
    
    res.json({
        connected: connected,
        totalScans: totalScans,
        opportunitiesFound: opportunities.length,
        profitableCount: profitableCount,
        bestSpread: opportunities.length > 0 ? opportunities[0].spreadPercent : "0",
        bestProfit: opportunities.length > 0 ? opportunities[0].profit : "0",
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
    <title>Flash Loan Arbitrage - Live Scanner</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f0f2f5;
            padding: 24px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        
        .header {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 20px;
            padding: 24px 32px;
            margin-bottom: 24px;
            color: white;
        }
        .header h1 { font-size: 28px; }
        .status { display: inline-block; padding: 4px 12px; background: #ffc107; border-radius: 20px; font-size: 12px; margin-left: 12px; color: #1a1a2e; }
        .status.connected { background: #28a745; color: white; }
        
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
        .stat-label { font-size: 12px; color: #6c757d; margin-top: 8px; }
        
        .card {
            background: white;
            border-radius: 16px;
            margin-bottom: 24px;
            overflow: hidden;
            border: 1px solid #e1e4e8;
        }
        .card-header {
            padding: 16px 20px;
            background: #f8f9fa;
            border-bottom: 1px solid #e1e4e8;
            font-weight: 600;
        }
        
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px 16px; background: #f8f9fa; color: #6c757d; font-weight: 600; font-size: 12px; }
        td { padding: 12px 16px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        .profit-positive { color: #28a745; font-weight: 600; }
        
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
        
        .refresh-note { text-align: center; color: #6c757d; font-size: 12px; margin-top: 20px; }
        .connecting { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin-bottom: 20px; border-radius: 8px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>⚡ Flash Loan Arbitrage Scanner</h1>
        <p>Scanning QuickSwap + SushiSwap on Polygon | Real-time spreads</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="scans">0</div><div class="stat-label">Scans</div></div>
        <div class="stat-card"><div class="stat-value green" id="opportunities">0</div><div class="stat-label">Opportunities Found</div></div>
        <div class="stat-card"><div class="stat-value" id="profitable">0</div><div class="stat-label">Profitable (>$0.50)</div></div>
        <div class="stat-card"><div class="stat-value" id="bestSpread">0%</div><div class="stat-label">Best Spread</div></div>
        <div class="stat-card"><div class="stat-value green" id="bestProfit">$0</div><div class="stat-label">Best Profit</div></div>
    </div>

    <div id="statusBox" class="connecting">
        🔄 Connecting to Polygon blockchain... (this takes 10-20 seconds)
    </div>

    <div class="card">
        <div class="card-header">🎯 Live Arbitrage Opportunities</div>
        <div style="overflow-x: auto;">
            <table>
                <thead>
                    <tr><th>Token</th><th>Buy → Sell</th><th>Buy Price</th><th>Sell Price</th><th>Spread</th><th>Profit ($500)</th><th></th></tr>
                </thead>
                <tbody id="opportunitiesBody">
                    <tr><td colspan="7" style="text-align:center; padding:40px;">Connecting to blockchain... (30 seconds)</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="refresh-note">🔄 Auto-refreshes every 3 seconds | Real data from Polygon</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('scans').innerText = data.totalScans || 0;
            document.getElementById('opportunities').innerText = data.opportunitiesFound || 0;
            document.getElementById('profitable').innerText = data.profitableCount || 0;
            document.getElementById('bestSpread').innerHTML = data.bestSpread + '%';
            document.getElementById('bestProfit').innerHTML = '$' + data.bestProfit;
            
            if (data.connected) {
                document.getElementById('statusBox').innerHTML = '✅ Connected to Polygon! Scanning for opportunities...';
                document.getElementById('statusBox').style.background = '#d4edda';
                document.getElementById('statusBox').style.borderLeftColor = '#28a745';
            }
            
            const oppsBody = document.getElementById('opportunitiesBody');
            if (data.opportunities && data.opportunities.length > 0) {
                let html = '';
                for (let opp of data.opportunities.slice(0, 10)) {
                    const profitClass = parseFloat(opp.profit) > 0.50 ? 'profit-positive' : '';
                    html += '<tr>' +
                        '<td><strong>' + opp.token + '</strong></td>' +
                        '<td>' + opp.buyDex + ' → ' + opp.sellDex + '</td>' +
                        '<td>$' + opp.buyPrice.toFixed(4) + '</td>' +
                        '<td>$' + opp.sellPrice.toFixed(4) + '</td>' +
                        '<td style="color:#28a745">+' + opp.spreadPercent + '%</td>' +
                        '<td class="' + profitClass + '">$' + opp.profit + '</td>' +
                        '<td><button onclick="alert(\'Execute ' + opp.token + ' arbitrage\')">Execute</button></td>' +
                        '</tr>';
                }
                oppsBody.innerHTML = html;
            } else if (data.totalScans > 0) {
                oppsBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px;">No spreads found yet. Scanning continues...</td></tr>';
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

// ==================== MAIN LOOP ====================
async function mainLoop() {
    while (true) {
        await scan();
        await new Promise(r => setTimeout(r, 15000)); // Scan every 15 seconds
    }
}

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ FLASH LOAN ARBITRAGE SCANNER');
    console.log('='.repeat(60));
    console.log('Using public Polygon RPCs (your QuickNode was failing)');
    console.log('Tokens: WETH, POL, WBTC, AAVE, LINK, CRV, SUSHI, QUICK');
    console.log('DEXes: QuickSwap + SushiSwap');
    console.log('='.repeat(60));
    console.log('\n📊 Dashboard: http://localhost:' + PORT);
    console.log('⏱️  First results in 30-60 seconds\n');
    
    // Don't await - let it run in background
    mainLoop().catch(console.error);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Connecting to Polygon...`);
    });
}

start();
