// bot-flashloan.js - INSTANT FLASH LOAN SCANNER
// Clean white dashboard - Shows opportunities IMMEDIATELY

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// IMMEDIATE PROFIT SETTINGS - No waiting!
const MIN_PROFIT_USD = 0.50;      // Lower threshold to find more opportunities
const FLASH_LOAN_AMOUNT = 500;    // $500 flash loan
const SCAN_INTERVAL = 5000;       // Scan every 5 seconds

// ==================== TOKENS WITH HIGH LIQUIDITY ====================
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
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰" }
];

// ==================== DEXES ====================
const DEXES = [
    { name: "QUICKSWAP", router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, icon: "⚡" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, icon: "🍣" }
];

// ==================== CONTRACT ABI ====================
const CONTRACT_ABI = [
    "function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external",
    "function withdraw(address token, uint256 amount) external",
    "function getBalance(address token) view returns (uint256)",
    "function owner() view returns (address)",
    "function totalFlashLoans() view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE ====================
let state = {
    connected: false,
    scanning: false,
    lastScan: null,
    currentPrices: {},
    opportunities: [],
    tradeHistory: [],
    logs: [],
    totalScans: 0,
    opportunitiesFound: 0
};

let provider, wallet, flashLoanContract;
let lastCallTime = 0;
let polPriceUSD = 0.50;

function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < 100) {
        return new Promise(r => setTimeout(r, 100 - elapsed));
    }
    lastCallTime = Date.now();
    return Promise.resolve();
}

function addLog(message, type) {
    const timestamp = new Date().toLocaleTimeString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== CONNECTION ====================
async function initializeBlockchain() {
    try {
        provider = new ethers.JsonRpcProvider(QUICKNODE_URL);
        await rateLimit();
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to Polygon (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here') {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            flashLoanContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            const balance = await provider.getBalance(wallet.address);
            addLog(`💰 Wallet: ${wallet.address.substring(0, 10)}... (${parseFloat(ethers.formatEther(balance)).toFixed(4)} POL)`, 'info');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== GET PRICE ====================
async function getTokenPrice(token, dex) {
    try {
        await rateLimit();
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const router = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        const path = [token.address, usdcAddress];
        const amounts = await router.getAmountsOut(ethers.parseUnits("0.1", token.decimals), path);
        return parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.1;
    } catch (error) {
        return 0;
    }
}

// ==================== SCAN FOR OPPORTUNITIES ====================
async function scanForOpportunities() {
    if (state.scanning) return [];
    state.scanning = true;
    state.totalScans++;
    
    const opportunities = [];
    const prices = {};
    
    for (const token of ALL_TOKENS) {
        if (token.symbol === "USDC") {
            prices[token.symbol] = { QuickSwap: 1.00, SushiSwap: 1.00 };
            continue;
        }
        
        prices[token.symbol] = {};
        
        for (const dex of DEXES) {
            const price = await getTokenPrice(token, dex);
            if (price > 0) {
                prices[token.symbol][dex.name] = price;
            }
        }
        await new Promise(r => setTimeout(r, 150));
    }
    
    state.currentPrices = prices;
    
    // Find spreads
    for (const token of ALL_TOKENS) {
        if (token.symbol === "USDC") continue;
        
        const tokenPrices = prices[token.symbol];
        if (!tokenPrices) continue;
        
        const quickPrice = tokenPrices.QuickSwap;
        const sushiPrice = tokenPrices.SushiSwap;
        
        if (quickPrice > 0 && sushiPrice > 0) {
            const priceDiff = Math.abs(quickPrice - sushiPrice);
            const percentDiff = (priceDiff / Math.min(quickPrice, sushiPrice)) * 100;
            const totalFees = 0.6; // 0.3% + 0.3%
            const netSpread = percentDiff - totalFees;
            const profit = priceDiff * FLASH_LOAN_AMOUNT;
            const profitAfterFees = profit * (1 - 0.006);
            
            if (profitAfterFees > MIN_PROFIT_USD && netSpread > 0) {
                opportunities.push({
                    token: token.symbol,
                    icon: token.icon,
                    buyDex: quickPrice < sushiPrice ? "QuickSwap" : "SushiSwap",
                    sellDex: quickPrice < sushiPrice ? "SushiSwap" : "QuickSwap",
                    buyPrice: Math.min(quickPrice, sushiPrice),
                    sellPrice: Math.max(quickPrice, sushiPrice),
                    spreadPercent: percentDiff.toFixed(2),
                    netSpread: netSpread.toFixed(2),
                    profit: profitAfterFees.toFixed(2),
                    timestamp: new Date().toISOString()
                });
            }
        }
    }
    
    opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
    state.opportunities = opportunities.slice(0, 10);
    state.opportunitiesFound += opportunities.length;
    state.lastScan = new Date().toISOString();
    
    if (opportunities.length > 0) {
        addLog(`🎯 Found ${opportunities.length} opportunities! Best: ${opportunities[0].token} - $${opportunities[0].profit} profit`, 'opportunity');
    } else {
        addLog(`🔍 Scan #${state.totalScans} - No opportunities found`, 'info');
    }
    
    state.scanning = false;
    return opportunities;
}

// ==================== EXECUTE FLASH LOAN ====================
async function executeTrade(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`❌ Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    addLog(`💸 EXECUTING: ${opportunity.token} - Buy on ${opportunity.buyDex} at $${opportunity.buyPrice}, Sell on ${opportunity.sellDex} at $${opportunity.sellPrice}`, 'opportunity');
    addLog(`   Expected Profit: $${opportunity.profit}`, 'info');
    
    try {
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const amount = ethers.parseUnits(FLASH_LOAN_AMOUNT.toString(), 6);
        const abiCoder = new ethers.AbiCoder();
        const minProfit = ethers.parseUnits((parseFloat(opportunity.profit) * 0.5).toFixed(2), 6);
        
        const buyRouter = DEXES.find(d => d.name === opportunity.buyDex)?.router;
        const sellRouter = DEXES.find(d => d.name === opportunity.sellDex)?.router;
        const tokenAddress = ALL_TOKENS.find(t => t.symbol === opportunity.token)?.address;
        
        const params = abiCoder.encode(
            ["address", "address", "address", "uint256", "uint256"],
            [buyRouter, sellRouter, tokenAddress, minProfit, Math.floor(Date.now() / 1000) + 300]
        );
        
        addLog(`📝 Requesting flash loan...`, 'info');
        const tx = await flashLoanContract.requestFlashLoan(usdcAddress, amount, params, { gasLimit: 2000000 });
        addLog(`📤 Tx: ${tx.hash.substring(0, 20)}...`, 'info');
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const netProfit = parseFloat(opportunity.profit) - gasUsed;
            
            addLog(`✅ SUCCESS! Profit: $${netProfit.toFixed(2)}`, 'success');
            
            state.tradeHistory.unshift({
                timestamp: new Date().toISOString(),
                token: opportunity.token,
                profit: netProfit,
                txHash: tx.hash,
                success: true
            });
            
            return true;
        } else {
            throw new Error("Transaction reverted");
        }
    } catch (error) {
        addLog(`❌ Failed: ${error.message.substring(0, 100)}`, 'error');
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: opportunity.token,
            profit: 0,
            success: false,
            error: error.message.substring(0, 80)
        });
        return false;
    }
}

// ==================== WITHDRAW ====================
async function withdrawProfits() {
    if (!wallet || !flashLoanContract) return;
    try {
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const balance = await flashLoanContract.getBalance(usdcAddress);
        if (balance > 0) {
            addLog(`💰 Withdrawing ${ethers.formatUnits(balance, 6)} USDC...`, 'info');
            const tx = await flashLoanContract.withdraw(usdcAddress, balance);
            await tx.wait();
            addLog(`✅ Withdrawn!`, 'success');
        }
    } catch(e) {}
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    while (true) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const opportunities = await scanForOpportunities();
        
        if (opportunities.length > 0 && wallet && flashLoanContract) {
            const best = opportunities[0];
            await executeTrade(best);
            await new Promise(r => setTimeout(r, 30000));
        } else {
            await new Promise(r => setTimeout(r, SCAN_INTERVAL));
        }
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    res.json({
        connected: state.connected,
        totalScans: state.totalScans,
        opportunitiesFound: state.opportunitiesFound,
        currentPrices: state.currentPrices,
        opportunities: state.opportunities,
        tradeHistory: state.tradeHistory.slice(0, 10),
        logs: state.logs.slice(0, 30),
        lastScan: state.lastScan
    });
});

app.post('/api/withdraw', async (req, res) => { await withdrawProfits(); res.json({ status: 'ok' }); });
app.get('/health', (req, res) => { res.json({ status: 'ok', connected: state.connected }); });

// ==================== CLEAN WHITE DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | Live Scanner</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #1a1a2e;
            padding: 24px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        
        /* Header */
        .header {
            background: white;
            border-radius: 20px;
            padding: 24px 32px;
            margin-bottom: 24px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.05);
            border: 1px solid #e1e4e8;
        }
        .header h1 { font-size: 24px; font-weight: 700; color: #1a1a2e; }
        .status { display: inline-block; padding: 4px 12px; background: #28a745; color: white; border-radius: 20px; font-size: 12px; margin-left: 12px; }
        .subtitle { color: #6c757d; font-size: 14px; margin-top: 8px; }
        
        /* Stats Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 20px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: white;
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            border: 1px solid #e1e4e8;
        }
        .stat-label { font-size: 12px; text-transform: uppercase; color: #6c757d; margin-bottom: 8px; letter-spacing: 0.5px; }
        .stat-value { font-size: 32px; font-weight: 700; color: #1a1a2e; }
        .stat-value.green { color: #28a745; }
        
        /* Two Columns */
        .two-columns {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
        }
        
        /* Cards */
        .card {
            background: white;
            border-radius: 16px;
            border: 1px solid #e1e4e8;
            overflow: hidden;
        }
        .card-header {
            padding: 16px 20px;
            background: #f8f9fa;
            border-bottom: 1px solid #e1e4e8;
            font-weight: 600;
            font-size: 16px;
        }
        
        /* Tables */
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; padding: 12px 16px; background: #f8f9fa; color: #6c757d; font-weight: 600; }
        td { padding: 12px 16px; border-bottom: 1px solid #e9ecef; }
        .profit-positive { color: #28a745; font-weight: 600; }
        .profit-negative { color: #dc3545; }
        .tx-link { color: #007bff; text-decoration: none; font-size: 11px; }
        
        /* Price Grid */
        .price-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 12px;
            padding: 16px;
        }
        .price-item {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 12px;
            text-align: center;
        }
        .price-symbol { font-size: 16px; font-weight: 600; }
        .price-value { font-size: 14px; color: #28a745; margin-top: 4px; }
        .price-small { font-size: 11px; color: #6c757d; margin-top: 2px; }
        
        /* Logs */
        .logs-container {
            max-height: 300px;
            overflow-y: auto;
            font-family: 'SF Mono', monospace;
            font-size: 11px;
        }
        .log-entry {
            padding: 8px 16px;
            border-bottom: 1px solid #e9ecef;
            color: #495057;
        }
        .log-success { color: #28a745; }
        .log-error { color: #dc3545; }
        .log-opportunity { color: #fd7e14; }
        
        /* Buttons */
        .btn-group { display: flex; gap: 12px; margin-top: 20px; justify-content: flex-end; }
        .btn {
            padding: 10px 20px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: none;
        }
        .btn-primary { background: #007bff; color: white; }
        .btn-secondary { background: #e9ecef; color: #495057; }
        
        .refresh-note { text-align: center; font-size: 11px; color: #adb5bd; margin-top: 20px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💸 Flash Loan Arbitrage Bot <span class="status">LIVE</span></h1>
        <p class="subtitle">AAVE V3 | Zero Capital | Real-time Price Scanner</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">SCANS</div><div class="stat-value" id="scans">0</div></div>
        <div class="stat-card"><div class="stat-label">OPPORTUNITIES</div><div class="stat-value green" id="opportunities">0</div></div>
        <div class="stat-card"><div class="stat-label">BEST SPREAD</div><div class="stat-value" id="bestSpread">0%</div></div>
        <div class="stat-card"><div class="stat-label">FLASH LOANS</div><div class="stat-value" id="flashLoans">0</div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">💰 Live Prices</div>
            <div class="price-grid" id="priceGrid">Loading...</div>
        </div>
        <div class="card">
            <div class="card-header">🎯 Best Opportunities</div>
            <div style="overflow-x: auto;">
                <table>
                    <thead><tr><th>Token</th><th>Buy → Sell</th><th>Spread</th><th>Profit ($500)</th><th>Action</th></tr></thead>
                    <tbody id="opportunitiesBody"><tr><td colspan="5" style="text-align:center; padding:40px;">Scanning...</td></tr></tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📋 Recent Trades</div>
            <div style="overflow-x: auto;">
                <table>
                    <thead><tr><th>Time</th><th>Token</th><th>Profit</th><th>Tx</th></tr></thead>
                    <tbody id="tradesBody"><tr><td colspan="4" style="text-align:center; padding:30px;">No trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-header">📝 Live Logs</div>
            <div class="logs-container" id="logsContainer">Initializing...</div>
        </div>
    </div>

    <div class="btn-group">
        <button class="btn btn-secondary" onclick="location.reload()">Refresh</button>
    </div>
    <div class="refresh-note">🔄 Auto-refreshing every 3 seconds</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('scans').innerText = data.totalScans || 0;
            document.getElementById('opportunities').innerText = data.opportunitiesFound || 0;
            document.getElementById('flashLoans').innerText = data.tradeHistory?.filter(t => t.success).length || 0;
            
            // Calculate best spread
            let bestSpread = 0;
            if (data.opportunities && data.opportunities.length > 0) {
                bestSpread = parseFloat(data.opportunities[0].netSpread);
                document.getElementById('bestSpread').innerText = bestSpread + '%';
            }
            
            // Price Grid
            const priceGrid = document.getElementById('priceGrid');
            if (data.currentPrices) {
                let priceHtml = '';
                for (const [token, prices] of Object.entries(data.currentPrices)) {
                    if (token !== 'USDC') {
                        priceHtml += '<div class="price-item">' +
                            '<div class="price-symbol">' + token + '</div>' +
                            '<div class="price-value">$' + (prices.QuickSwap?.toFixed(4) || '—') + '</div>' +
                            '<div class="price-small">QuickSwap</div>' +
                            '<div class="price-value">$' + (prices.SushiSwap?.toFixed(4) || '—') + '</div>' +
                            '<div class="price-small">SushiSwap</div>' +
                            '</div>';
                    }
                }
                priceGrid.innerHTML = priceHtml || 'No prices yet';
            }
            
            // Opportunities Table
            const oppsBody = document.getElementById('opportunitiesBody');
            if (data.opportunities && data.opportunities.length > 0) {
                let oppsHtml = '';
                for (let opp of data.opportunities.slice(0, 5)) {
                    oppsHtml += '<tr>' +
                        '<td><strong>' + opp.icon + ' ' + opp.token + '</strong></td>' +
                        '<td>' + opp.buyDex + ' → ' + opp.sellDex + '</td>' +
                        '<td style="color:#28a745">' + opp.netSpread + '%</td>' +
                        '<td style="color:#28a745">$' + opp.profit + '</td>' +
                        '<td><button onclick="executeTrade(\'' + opp.token + '\', \'' + opp.buyDex + '\', \'' + opp.sellDex + '\', ' + opp.profit + ')" style="background:#28a745;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer">Execute</button></td>' +
                        '</tr>';
                }
                oppsBody.innerHTML = oppsHtml;
            } else {
                oppsBody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px;">No opportunities found. Scanning...</td></tr>';
            }
            
            // Trades Table
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let tradesHtml = '';
                for (let t of data.tradeHistory.slice(0, 5)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const profitClass = t.success ? 'profit-positive' : 'profit-negative';
                    const profitDisplay = t.success ? '+$' + t.profit.toFixed(2) : 'Failed';
                    tradesHtml += '<tr>' +
                        '<td>' + time + '</td>' +
                        '<td>' + (t.token || '-') + '</td>' +
                        '<td class="' + profitClass + '">' + profitDisplay + '</td>' +
                        '<td>' + (t.txHash ? '<a href="https://polygonscan.com/tx/' + t.txHash + '" target="_blank" class="tx-link">View</a>' : '-') + '</td>' +
                        '</tr>';
                }
                tradesBody.innerHTML = tradesHtml;
            }
            
            // Logs
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let logsHtml = '';
                for (let log of data.logs.slice(0, 25)) {
                    let cls = '';
                    if (log.type === 'success') cls = 'log-success';
                    else if (log.type === 'error') cls = 'log-error';
                    else if (log.type === 'opportunity') cls = 'log-opportunity';
                    logsHtml += '<div class="log-entry ' + cls + '">[' + log.timestamp + '] ' + log.message + '</div>';
                }
                logsContainer.innerHTML = logsHtml;
            }
        } catch(e) { console.error(e); }
    }
    
    async function executeTrade(token, buyDex, sellDex, profit) {
        if (!confirm('Execute flash loan for ' + token + '? Estimated profit: $' + profit)) return;
        
        const res = await fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, buyDex, sellDex, profit })
        });
        const data = await res.json();
        alert(data.message);
        setTimeout(fetchData, 2000);
    }
    
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>`;
    
    res.send(html);
});

app.post('/api/execute', express.json(), async (req, res) => {
    const { token, buyDex, sellDex, profit } = req.body;
    
    const opportunity = {
        token: token,
        icon: "🪙",
        buyDex: buyDex,
        sellDex: sellDex,
        buyPrice: 0,
        sellPrice: 0,
        profit: profit
    };
    
    const success = await executeTrade(opportunity);
    res.json({ message: success ? "Trade executed! Check transaction." : "Trade failed. Check logs." });
});

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(50));
    console.log('FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(50));
    console.log('Dashboard: http://localhost:' + PORT);
    console.log('='.repeat(50) + '\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log('✅ Dashboard: http://localhost:' + PORT);
        console.log('✅ Bot is LIVE - Scanning every 5 seconds');
    });
}

start();
