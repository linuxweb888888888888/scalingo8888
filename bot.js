// Replace your current bot.js with this fixed version

// bot-flashloan.js - FIXED VERSION with better error handling

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// Rate limiting
const RATE_LIMIT = { minIntervalMs: 100, batchDelayMs: 500 };
const priceCache = new Map();
const CACHE_TTL = 20000;

// Debug data
let debugData = { lastScan: null, allPrices: [], spreads: [], topOpportunities: [] };

// ==================== TOKENS ON POLYGON ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎" },
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡" },
    { symbol: "CAKE", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍰" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈" }
];

// ==================== DEX CONFIGURATION (VERIFIED ROUTERS) ====================
const DEXES = [
    { 
        name: "QUICKSWAP", 
        router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921",
        factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
        fee: 0.0030, 
        icon: "⚡",
        active: true
    },
    { 
        name: "SUSHISWAP", 
        router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
        fee: 0.0030, 
        icon: "🍣",
        active: true
    }
];

// ==================== ABI ====================
const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)",
    "function getReserves() public view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

// ==================== STATE ====================
let state = {
    wallet: { pol: 0, usd: 0 },
    stats: {
        totalProfitUSD: 0, totalAttempts: 0, successfulTrades: 0, failedTrades: 0,
        totalGasPaidUSD: 0, successRate: 0, totalFlashLoans: 0, opportunitiesFound: 0
    },
    session: { startTime: new Date().toISOString(), lastScan: null, totalScans: 0 },
    tradeHistory: [], logs: [], isRunning: true, connected: false
};

let provider, wallet, flashLoanContract;
let polPriceUSD = 0.50;
let lastCallTime = 0;

function addLog(message, type) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 200) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== PRICE FETCHING WITH DEBUG LOGS ====================
async function getTokenPriceOnDex(tokenAddress, decimals, dexRouter, dexName) {
    const cacheKey = `${tokenAddress}_${dexRouter}`;
    const cached = priceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        const router = new ethers.Contract(dexRouter, ROUTER_ABI, provider);
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        
        // Try direct USDC pair first
        const path = [tokenAddress, usdcAddress];
        const amountIn = ethers.parseUnits("0.001", decimals); // Small amount to avoid large price impact
        
        const amounts = await router.getAmountsOut(amountIn, path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.001;
        
        if (price > 0 && price < 1000000) { // Sanity check
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
            return price;
        }
        return 0;
    } catch (error) {
        // Silent fail - pair might not exist
        return 0;
    }
}

// ==================== SCAN WITH DETAILED DEBUGGING ====================
async function scanAllTokensWithDebug() {
    const opportunities = [];
    const allPriceData = [];
    const spreads = [];
    const errors = [];
    
    addLog(`🔍 Scanning ${ALL_TOKENS.length} tokens on ${DEXES.length} DEXes...`, 'info');
    
    for (const token of ALL_TOKENS) {
        if (token.symbol === "USDC") continue;
        
        for (const dex of DEXES) {
            try {
                const price = await getTokenPriceOnDex(token.address, token.decimals, dex.router, dex.name);
                if (price > 0) {
                    allPriceData.push({
                        token: token.symbol,
                        tokenIcon: token.icon,
                        dex: dex.name,
                        dexIcon: dex.icon,
                        price: price,
                        fee: dex.fee,
                        timestamp: Date.now()
                    });
                    addLog(`  ✅ ${dex.icon} ${dex.name}: ${token.symbol} = $${price.toFixed(4)}`, 'info');
                } else {
                    // Price not available - pair might not exist
                }
            } catch (error) {
                errors.push(`${dex.name}/${token.symbol}: ${error.message.substring(0, 50)}`);
            }
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    // Group by token and find spreads
    const tokenGroups = {};
    for (const price of allPriceData) {
        if (!tokenGroups[price.token]) tokenGroups[price.token] = [];
        tokenGroups[price.token].push(price);
    }
    
    for (const [token, prices] of Object.entries(tokenGroups)) {
        if (prices.length >= 2) {
            for (let i = 0; i < prices.length; i++) {
                for (let j = i + 1; j < prices.length; j++) {
                    const buyPrice = Math.min(prices[i].price, prices[j].price);
                    const sellPrice = Math.max(prices[i].price, prices[j].price);
                    const priceDiff = sellPrice - buyPrice;
                    const percentDiff = (priceDiff / buyPrice) * 100;
                    const totalFees = (prices[i].fee + prices[j].fee) * 100;
                    const netSpread = percentDiff - totalFees;
                    const profitOn100 = priceDiff * 100;
                    
                    const spreadData = {
                        token: token,
                        tokenIcon: prices[0].tokenIcon,
                        buyDex: prices[i].price < prices[j].price ? prices[i].dex : prices[j].dex,
                        sellDex: prices[i].price < prices[j].price ? prices[j].dex : prices[i].dex,
                        buyDexIcon: prices[i].price < prices[j].price ? prices[i].dexIcon : prices[j].dexIcon,
                        sellDexIcon: prices[i].price < prices[j].price ? prices[j].dexIcon : prices[i].dexIcon,
                        buyPrice: buyPrice,
                        sellPrice: sellPrice,
                        rawSpreadPercent: percentDiff.toFixed(3),
                        netSpreadPercent: netSpread.toFixed(3),
                        profitOn100USD: profitOn100.toFixed(2),
                        isProfitable: netSpread > 0.05 && profitOn100 > 0.20
                    };
                    
                    spreads.push(spreadData);
                    
                    if (spreadData.isProfitable) {
                        opportunities.push(spreadData);
                        addLog(`💰 SPREAD: ${token} | ${spreadData.buyDex}($${buyPrice.toFixed(4)}) -> ${spreadData.sellDex}($${sellPrice.toFixed(4)}) | ${netSpread}% net | $${profitOn100.toFixed(2)} profit`, 'opportunity');
                    }
                }
            }
        }
    }
    
    spreads.sort((a, b) => parseFloat(b.profitOn100USD) - parseFloat(a.profitOn100USD));
    
    debugData = {
        lastScan: new Date().toISOString(),
        allPrices: allPriceData,
        spreads: spreads.slice(0, 20),
        topOpportunities: opportunities.slice(0, 10),
        errors: errors.slice(0, 10)
    };
    
    if (spreads.length === 0) {
        addLog(`📊 No spreads found. ${allPriceData.length} prices fetched from ${DEXes.length} DEXes.`, 'info');
        if (allPriceData.length === 0) {
            addLog(`⚠️ WARNING: No prices fetched! Check RPC connection and token addresses.`, 'error');
        }
    } else {
        addLog(`📊 Found ${spreads.length} spreads, ${opportunities.length} profitable`, 'success');
    }
    
    return { opportunities, spreads, allPriceData };
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    res.json({
        wallet: { pol: state.wallet.pol.toFixed(4), usd: state.wallet.usd.toFixed(2), address: wallet?.address || null },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            successRate: state.stats.successRate.toFixed(1),
            totalFlashLoans: state.stats.totalFlashLoans,
            opportunitiesFound: state.stats.opportunitiesFound
        },
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 50),
        connected: state.connected,
        debug: debugData
    });
});

app.get('/api/debug/spreads', (req, res) => {
    res.json({
        lastScan: debugData.lastScan,
        totalSpreads: debugData.spreads.length,
        profitableSpreads: debugData.spreads.filter(s => s.isProfitable).length,
        spreads: debugData.spreads,
        prices: debugData.allPrices,
        errors: debugData.errors
    });
});

app.post('/api/reset', (req, res) => {
    state.stats.totalProfitUSD = 0;
    state.stats.totalAttempts = 0;
    state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0;
    state.tradeHistory = [];
    addLog('Stats reset', 'info');
    res.json({ status: 'reset' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: state.connected, pricesCached: priceCache.size });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>Flash Loan Arbitrage Bot | Polygon</title>\n' +
'    <style>\n' +
'        * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'        body { font-family: monospace; background: #0a0a0a; color: #0f0; padding: 20px; }\n' +
'        .container { max-width: 1400px; margin: 0 auto; }\n' +
'        .header { background: #1a1a1a; border-radius: 8px; padding: 20px; margin-bottom: 20px; border: 1px solid #0f0; }\n' +
'        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }\n' +
'        .stat-card { background: #1a1a1a; border-radius: 8px; padding: 16px; border: 1px solid #333; }\n' +
'        .stat-value { font-size: 28px; font-weight: bold; color: #0f0; }\n' +
'        .section { background: #1a1a1a; border-radius: 8px; margin-bottom: 20px; border: 1px solid #333; }\n' +
'        .section-header { padding: 12px 16px; background: #0a0a0a; border-bottom: 1px solid #333; font-weight: bold; }\n' +
'        table { width: 100%; border-collapse: collapse; font-size: 12px; }\n' +
'        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }\n' +
'        th { color: #0f0; background: #0a0a0a; }\n' +
'        .profitable { background: #0f0a; border-left: 3px solid #0f0; }\n' +
'        .logs { max-height: 300px; overflow-y: auto; font-size: 11px; }\n' +
'        .log-entry { padding: 6px 12px; border-bottom: 1px solid #333; font-family: monospace; }\n' +
'        .refresh-btn { padding: 8px 16px; background: #0f0; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }\n' +
'        .error-text { color: #f00; }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="container">\n' +
'    <div class="header">\n' +
'        <h1>💰 Flash Loan Arbitrage Bot <span style="color:#0f0">● LIVE</span></h1>\n' +
'        <p>Polygon | QuickSwap + SushiSwap | Auto-refresh 3s</p>\n' +
'    </div>\n' +
'\n' +
'    <div class="stats-grid">\n' +
'        <div class="stat-card"><div class="stat-label">PROFIT</div><div class="stat-value" id="profit">$0.00</div></div>\n' +
'        <div class="stat-card"><div class="stat-label">OPPORTUNITIES</div><div class="stat-value" id="opps">0</div></div>\n' +
'        <div class="stat-card"><div class="stat-label">SPREADS</div><div class="stat-value" id="spreads">0</div></div>\n' +
'        <div class="stat-card"><div class="stat-label">PRICES</div><div class="stat-value" id="priceCount">0</div></div>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'        <div class="section-header">📊 Current Prices</div>\n' +
'        <table id="priceTable">\n' +
'            <thead><tr><th>Token</th><th>QuickSwap</th><th>SushiSwap</th><th>Spread</th><th>Profit on $100</th></thead>\n' +
'            <tbody id="priceBody"><tr><td colspan="5">Loading...</td></tr></tbody>\n' +
'        </table>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'        <div class="section-header">💰 Profitable Spreads</div>\n' +
'        <table id="spreadTable">\n' +
'            <thead><tr><th>Token</th><th>Buy on</th><th>Price</th><th>Sell on</th><th>Price</th><th>Net Spread</th><th>Profit</th></thead>\n' +
'            <tbody id="spreadBody"><tr><td colspan="7">No spreads found yet...</td></tr></tbody>\n' +
'        </table>\n' +
'    </div>\n' +
'\n' +
'    <div class="section">\n' +
'        <div class="section-header">📝 Activity Logs</div>\n' +
'        <div class="logs" id="logs"></div>\n' +
'    </div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'    async function fetchData() {\n' +
'        try {\n' +
'            const res = await fetch("/api/debug/spreads");\n' +
'            const data = await res.json();\n' +
'            \n' +
'            document.getElementById("spreads").innerHTML = data.totalSpreads || 0;\n' +
'            document.getElementById("priceCount").innerHTML = data.prices?.length || 0;\n' +
'            \n' +
'            // Price table\n' +
'            const pricesByToken = {};\n' +
'            if (data.prices) {\n' +
'                for (let p of data.prices) {\n' +
'                    if (!pricesByToken[p.token]) pricesByToken[p.token] = {};\n' +
'                    pricesByToken[p.token][p.dex] = p.price;\n' +
'                }\n' +
'            }\n' +
'            \n' +
'            const tokens = ["POL", "WETH", "WBTC", "CAKE", "AAVE", "LINK"];\n' +
'            let priceHtml = "";\n' +
'            for (let token of tokens) {\n' +
'                const quickPrice = pricesByToken[token]?.QUICKSWAP || 0;\n' +
'                const sushiPrice = pricesByToken[token]?.SUSHISWAP || 0;\n' +
'                let spread = "-";\n' +
'                let profit = "-";\n' +
'                if (quickPrice > 0 && sushiPrice > 0) {\n' +
'                    const diff = Math.abs(quickPrice - sushiPrice);\n' +
'                    const pct = (diff / Math.min(quickPrice, sushiPrice) * 100).toFixed(2);\n' +
'                    spread = pct + "%";\n' +
'                    profit = "$" + (diff * 100).toFixed(2);\n' +
'                }\n' +
'                priceHtml += "<tr>" +\n' +
'                    "<td>" + token + "</td>" +\n' +
'                    "<td>" + (quickPrice ? "$" + quickPrice.toFixed(4) : "-") + "</td>" +\n' +
'                    "<td>" + (sushiPrice ? "$" + sushiPrice.toFixed(4) : "-") + "</td>" +\n' +
'                    "<td>" + spread + "</td>" +\n' +
'                    "<td>" + profit + "</td>" +\n' +
'                    "</tr>";\n' +
'            }\n' +
'            document.getElementById("priceBody").innerHTML = priceHtml;\n' +
'            \n' +
'            // Spreads table\n' +
'            let spreadHtml = "";\n' +
'            if (data.spreads && data.spreads.length > 0) {\n' +
'                for (let s of data.spreads.slice(0, 10)) {\n' +
'                    const cls = s.isProfitable ? "profitable" : "";\n' +
'                    spreadHtml += "<tr class=\\"" + cls + "\\">" +\n' +
'                        "<td>" + s.tokenIcon + " " + s.token + "</td>" +\n' +
'                        "<td>" + s.buyDexIcon + " " + s.buyDex + "</td>" +\n' +
'                        "<td>$" + s.buyPrice.toFixed(4) + "</td>" +\n' +
'                        "<td>" + s.sellDexIcon + " " + s.sellDex + "</td>" +\n' +
'                        "<td>$" + s.sellPrice.toFixed(4) + "</td>" +\n' +
'                        "<td>" + s.netSpreadPercent + "%</td>" +\n' +
'                        "<td class=\\"profit-cell\\">$" + s.profitOn100USD + "</td>" +\n' +
'                        "</tr>";\n' +
'                }\n' +
'            } else {\n' +
'                spreadHtml = "<tr><td colspan=\\"7\\">No spreads found. Check if prices are loading above.</td></tr>";\n' +
'            }\n' +
'            document.getElementById("spreadBody").innerHTML = spreadHtml;\n' +
'            \n' +
'            // State data\n' +
'            const stateRes = await fetch("/api/state");\n' +
'            const stateData = await stateRes.json();\n' +
'            document.getElementById("profit").innerHTML = "$" + stateData.stats.totalProfitUSD;\n' +
'            document.getElementById("opps").innerHTML = stateData.stats.opportunitiesFound || 0;\n' +
'            \n' +
'            // Logs\n' +
'            let logsHtml = "";\n' +
'            if (stateData.logs && stateData.logs.length > 0) {\n' +
'                for (let log of stateData.logs.slice(0, 30)) {\n' +
'                    const time = new Date(log.timestamp).toLocaleTimeString();\n' +
'                    logsHtml += "<div class=\\"log-entry\\">[" + time + "] " + log.message + "</div>";\n' +
'                }\n' +
'            }\n' +
'            document.getElementById("logs").innerHTML = logsHtml;\n' +
'            \n' +
'            if (data.errors && data.errors.length > 0) {\n' +
'                console.log("Errors:", data.errors);\n' +
'            }\n' +
'        } catch(e) { console.error(e); }\n' +
'    }\n' +
'    \n' +
'    fetchData();\n' +
'    setInterval(fetchData, 3000);\n' +
'</script>\n' +
'</body>\n' +
'</html>';
    
    res.send(html);
});

// ==================== INITIALIZE ====================
async function initializeBlockchain() {
    try {
        provider = new ethers.JsonRpcProvider(QUICKNODE_URL);
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to Polygon (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here') {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            const balance = await provider.getBalance(wallet.address);
            state.wallet.pol = parseFloat(ethers.formatEther(balance));
            state.wallet.usd = state.wallet.pol * polPriceUSD;
            addLog(`💰 Wallet: ${wallet.address.substring(0, 10)}... Balance: ${state.wallet.pol.toFixed(4)} POL`, 'info');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

async function mainLoop() {
    addLog('🔥 Bot started - scanning for spreads...', 'success');
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const { opportunities, spreads } = await scanAllTokensWithDebug();
        state.stats.opportunitiesFound += opportunities.length;
        state.session.totalScans++;
        
        await new Promise(r => setTimeout(r, 15000));
    }
}

async function start() {
    console.log('\n========================================');
    console.log('FLASH LOAN ARBITRAGE BOT - POLYGON');
    console.log('========================================');
    console.log(`DEXes: ${DEXES.map(d => d.name).join(', ')}`);
    console.log(`Tokens: ${ALL_TOKENS.length - 1}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log('========================================\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
    });
}

start();
