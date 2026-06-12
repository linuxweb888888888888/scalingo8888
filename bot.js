// bot-flashloan.js - ADVANCED Flash Loan Arbitrage Bot WITH DEBUG DASHBOARD
// Shows real-time spreads, prices, and opportunities

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// Rate limiting configuration
const RATE_LIMIT = {
    minIntervalMs: 100,
    batchDelayMs: 500
};

// Cache prices
const priceCache = new Map();
const CACHE_TTL = 20000;

// Debug data storage
let debugData = {
    lastScan: null,
    allPrices: [],
    spreads: [],
    topOpportunities: [],
    dexPerformance: {},
    tokenSpreads: {}
};

// ==================== ALL TOKENS ON POLYGON ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦", category: "Stable" },
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣", category: "L1" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡", category: "L1" },
    { symbol: "CAKE", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍰", category: "DeFi" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡", category: "DeFi" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣", category: "DeFi" }
];

// ==================== DEX CONFIGURATION ====================
const DEXES = [
    { 
        name: "PANCAKESWAP", 
        router: "0x6785E09eB2AcEcA0A293A48Cb7296280171fF25F",
        fee: 0.0025, 
        type: "v2",
        icon: "🥞",
        color: "#F0B90B"
    },
    { 
        name: "QUICKSWAP", 
        router: "0xA5e0829CACEd8fFdd4B3C72e4999f68ff6213921", 
        fee: 0.0030, 
        type: "v2",
        icon: "⚡",
        color: "#0052FF"
    },
    { 
        name: "SUSHISWAP", 
        router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", 
        fee: 0.0030, 
        type: "v2",
        icon: "🍣",
        color: "#FF4B4B"
    }
];

// ==================== TRIANGULAR ARBITRAGE PATHS ====================
const TRIANGULAR_PATHS = [
    { name: "USDC → POL → CAKE → USDC", path: ["USDC", "POL", "CAKE", "USDC"], minProfit: 0.50 },
    { name: "USDC → WETH → CAKE → USDC", path: ["USDC", "WETH", "CAKE", "USDC"], minProfit: 0.50 },
    { name: "USDC → POL → WETH → USDC", path: ["USDC", "POL", "WETH", "USDC"], minProfit: 0.50 },
    { name: "USDC → WETH → WBTC → USDC", path: ["USDC", "WETH", "WBTC", "USDC"], minProfit: 0.75 },
    { name: "USDC → CAKE → QUICK → USDC", path: ["USDC", "CAKE", "QUICK", "USDC"], minProfit: 0.40 }
];

// ==================== CONTRACT ABI ====================
const CONTRACT_ABI = [
    "function executeArbitrage(address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit) external payable returns (uint256)",
    "function setMinProfitBps(uint256 bps) external",
    "function withdraw(address token, uint256 amount) external",
    "function getBalance(address token) view returns (uint256)",
    "function requestFlashLoan(address asset, uint256 amount, tuple(address[] path, uint8 dex1, uint8 dex2, uint256 amountIn, uint256 minProfit, address profitRecipient) params) external",
    "function totalFlashLoans() view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE ====================
let state = {
    wallet: { pol: 0, usd: 0 },
    stats: {
        totalProfitUSD: 0,
        totalAttempts: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasPaidUSD: 0,
        successRate: 0,
        totalFlashLoans: 0,
        opportunitiesFound: 0,
        triangularOpportunities: 0
    },
    session: {
        startTime: new Date().toISOString(),
        lastScan: null,
        totalScans: 0
    },
    tradeHistory: [],
    logs: [],
    isRunning: true,
    connected: false
};

let provider;
let wallet;
let flashLoanContract;
let polPriceUSD = 0.50;
let lastCallTime = 0;

function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < RATE_LIMIT.minIntervalMs) {
        return new Promise(r => setTimeout(r, RATE_LIMIT.minIntervalMs - elapsed));
    }
    lastCallTime = Date.now();
    return Promise.resolve();
}

function addLog(message, type) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 200) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== BLOCKCHAIN CONNECTION ====================
async function initializeBlockchain() {
    try {
        provider = new ethers.JsonRpcProvider(QUICKNODE_URL);
        await rateLimit();
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to Polygon (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here') {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            flashLoanContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            
            await rateLimit();
            const balance = await provider.getBalance(wallet.address);
            state.wallet.pol = parseFloat(ethers.formatEther(balance));
            state.wallet.usd = state.wallet.pol * polPriceUSD;
            
            await rateLimit();
            const code = await provider.getCode(CONTRACT_ADDRESS);
            if (code !== '0x') {
                addLog(`✅ Flash Loan Contract: ${CONTRACT_ADDRESS.substring(0, 20)}...`, 'success');
            }
            
            addLog(`📍 Wallet: ${wallet.address.substring(0, 10)}...`, 'info');
            addLog(`💰 Balance: ${state.wallet.pol.toFixed(4)} POL (~$${state.wallet.usd.toFixed(2)})`, 'info');
        } else {
            addLog(`⚠️ Scan-only mode (no private key)`, 'warning');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== PRICE FETCHING WITH DEBUG ====================
async function getTokenPriceOnDex(tokenAddress, decimals, dexRouter, dexName) {
    const cacheKey = `${tokenAddress}_${dexRouter}`;
    const cached = priceCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        await rateLimit();
        const router = new ethers.Contract(dexRouter, ROUTER_ABI, provider);
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const path = [tokenAddress, usdcAddress];
        const amounts = await router.getAmountsOut(ethers.parseUnits("1", decimals), path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6));
        
        if (price > 0) {
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
        }
        return price;
    } catch (error) {
        return 0;
    }
}

// ==================== ENHANCED SCAN WITH DEBUG DATA ====================
async function scanAllTokensWithDebug() {
    const opportunities = [];
    const tokensToScan = ALL_TOKENS.filter(t => t.symbol !== 'USDC');
    const allPriceData = [];
    const spreads = [];
    
    addLog(`🔍 DEBUG SCAN: ${tokensToScan.length} tokens × ${DEXES.length} DEXes = ${tokensToScan.length * DEXES.length} price checks`, 'info');
    
    // Collect all prices
    for (const token of tokensToScan) {
        for (const dex of DEXES) {
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
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }
    
    // Find spreads between DEXes for same token
    const tokenGroups = {};
    for (const price of allPriceData) {
        if (!tokenGroups[price.token]) tokenGroups[price.token] = [];
        tokenGroups[price.token].push(price);
    }
    
    for (const [token, prices] of Object.entries(tokenGroups)) {
        if (prices.length >= 2) {
            for (let i = 0; i < prices.length; i++) {
                for (let j = i + 1; j < prices.length; j++) {
                    const priceDiff = Math.abs(prices[i].price - prices[j].price);
                    const percentDiff = (priceDiff / Math.min(prices[i].price, prices[j].price)) * 100;
                    const totalFees = (prices[i].fee + prices[j].fee) * 100;
                    const netSpread = percentDiff - totalFees;
                    const profitOn100 = priceDiff * 100;
                    const profitAfterFees = profitOn100 * (1 - (prices[i].fee + prices[j].fee));
                    
                    const spreadData = {
                        token: token,
                        tokenIcon: prices[0].tokenIcon,
                        buyDex: prices[i].price < prices[j].price ? prices[i].dex : prices[j].dex,
                        sellDex: prices[i].price < prices[j].price ? prices[j].dex : prices[i].dex,
                        buyDexIcon: prices[i].price < prices[j].price ? prices[i].dexIcon : prices[j].dexIcon,
                        sellDexIcon: prices[i].price < prices[j].price ? prices[j].dexIcon : prices[i].dexIcon,
                        buyPrice: Math.min(prices[i].price, prices[j].price),
                        sellPrice: Math.max(prices[i].price, prices[j].price),
                        rawSpreadPercent: percentDiff.toFixed(3),
                        netSpreadPercent: netSpread.toFixed(3),
                        totalFees: (totalFees).toFixed(2),
                        profitOn100USD: profitAfterFees.toFixed(2),
                        isProfitable: netSpread > 0.08 && profitAfterFees > 0.30
                    };
                    
                    spreads.push(spreadData);
                    
                    if (spreadData.isProfitable) {
                        opportunities.push({
                            type: "SIMPLE",
                            token: token,
                            icon: prices[0].tokenIcon,
                            tokenAddress: ALL_TOKENS.find(t => t.symbol === token).address,
                            decimals: ALL_TOKENS.find(t => t.symbol === token).decimals,
                            buyDex: spreadData.buyDex,
                            sellDex: spreadData.sellDex,
                            buyPrice: spreadData.buyPrice.toFixed(4),
                            sellPrice: spreadData.sellPrice.toFixed(4),
                            diffPercent: spreadData.rawSpreadPercent,
                            netDiff: spreadData.netSpreadPercent,
                            estimatedProfit: spreadData.profitOn100USD,
                            fees: spreadData.totalFees
                        });
                    }
                }
            }
        }
    }
    
    // Sort spreads by profit
    spreads.sort((a, b) => parseFloat(b.profitOn100USD) - parseFloat(a.profitOn100USD));
    
    // Update debug data
    debugData = {
        lastScan: new Date().toISOString(),
        allPrices: allPriceData.slice(0, 100),
        spreads: spreads.slice(0, 20),
        topOpportunities: opportunities.slice(0, 10),
        tokenSpreads: spreads.reduce((acc, s) => {
            if (!acc[s.token]) acc[s.token] = [];
            acc[s.token].push(s);
            return acc;
        }, {}),
        dexPerformance: calculateDexPerformance(allPriceData)
    };
    
    // Log debug summary
    if (spreads.length > 0) {
        addLog(`📊 DEBUG: Found ${spreads.length} spreads, ${opportunities.length} profitable (net >0.08%)`, 'info');
        const bestSpread = spreads[0];
        if (bestSpread) {
            addLog(`   🏆 BEST: ${bestSpread.token} | ${bestSpread.buyDex}($${bestSpread.buyPrice}) → ${bestSpread.sellDex}($${bestSpread.sellPrice}) | ${bestSpread.netSpreadPercent}% net | $${bestSpread.profitOn100USD} profit`, 'opportunity');
        }
    } else {
        addLog(`📊 DEBUG: No spreads found in this scan`, 'info');
    }
    
    return { opportunities, spreads, allPriceData };
}

function calculateDexPerformance(priceData) {
    const performance = {};
    for (const dex of DEXES) {
        performance[dex.name] = {
            avgPrice: 0,
            priceCount: 0,
            icon: dex.icon
        };
    }
    
    for (const data of priceData) {
        if (performance[data.dex]) {
            performance[data.dex].avgPrice += data.price;
            performance[data.dex].priceCount++;
        }
    }
    
    for (const dex of DEXES) {
        if (performance[dex.name].priceCount > 0) {
            performance[dex.name].avgPrice /= performance[dex.name].priceCount;
        }
    }
    
    return performance;
}

// ==================== EXECUTION ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`❌ Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    
    addLog(`💸 EXECUTING: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
    addLog(`   Route: ${opportunity.buyDex} → ${opportunity.sellDex}`, 'info');
    addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netDiff}% net)`, 'info');
    
    try {
        const asset = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits("500", 6);
        const path = [asset, opportunity.tokenAddress, asset];
        const dex1 = DEXES.findIndex(d => d.name === opportunity.buyDex) % DEXES.length;
        const dex2 = DEXES.findIndex(d => d.name === opportunity.sellDex) % DEXES.length;
        const amountIn = ethers.parseUnits("500", 6);
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.6).toFixed(2), 6);
        const profitRecipient = wallet.address;
        
        const flashParams = { path, dex1, dex2, amountIn, minProfit, profitRecipient };
        
        addLog(`📝 Requesting flash loan...`, 'info');
        const tx = await flashLoanContract.requestFlashLoan(asset, amount, flashParams, { gasLimit: 2000000 });
        addLog(`📤 TX: ${tx.hash}`, 'info');
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += profit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            
            addLog(`✅ SUCCESS! Profit: +$${profit.toFixed(2)}`, 'success');
            
            state.tradeHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                token: opportunity.token,
                profitUSD: profit,
                gasCostUSD: gasUsed,
                txHash: tx.hash,
                success: true
            });
            
            return true;
        } else {
            throw new Error("Transaction reverted");
        }
        
    } catch (error) {
        state.stats.failedTrades++;
        addLog(`❌ FAILED: ${error.message.substring(0, 100)}`, 'error');
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    addLog('🔥 FLASH LOAN ARBITRAGE BOT WITH DEBUG DASHBOARD STARTED', 'success');
    addLog(`🔍 Debug mode: Showing real-time spreads across ${DEXES.length} DEXes`, 'info');
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const { opportunities, spreads } = await scanAllTokensWithDebug();
        
        if (opportunities.length > 0 && wallet) {
            await executeFlashLoanArbitrage(opportunities[0]);
            await new Promise(r => setTimeout(r, 25000));
        } else {
            state.session.totalScans++;
            if (state.session.totalScans % 3 === 0) {
                addLog(`🔍 Scan #${state.session.totalScans} complete. Found ${spreads.length} spreads, ${opportunities.length} profitable.`, 'info');
            }
            await new Promise(r => setTimeout(r, 10000));
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        state.stats.opportunitiesFound += opportunities.length;
    }
}

// ==================== DEBUG API ENDPOINTS ====================
app.get('/api/debug/spreads', (req, res) => {
    res.json({
        lastScan: debugData.lastScan,
        totalSpreads: debugData.spreads.length,
        profitableSpreads: debugData.spreads.filter(s => s.isProfitable).length,
        spreads: debugData.spreads,
        topOpportunities: debugData.topOpportunities
    });
});

app.get('/api/debug/prices', (req, res) => {
    res.json({
        lastScan: debugData.lastScan,
        prices: debugData.allPrices,
        dexPerformance: debugData.dexPerformance
    });
});

app.get('/api/debug/token/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    res.json({
        token: symbol,
        spreads: debugData.tokenSpreads[symbol] || [],
        allPrices: debugData.allPrices.filter(p => p.token === symbol)
    });
});

app.get('/api/state', (req, res) => {
    const uptime = Math.floor((Date.now() - new Date(state.session.startTime).getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        wallet: {
            pol: state.wallet.pol.toFixed(4),
            usd: state.wallet.usd.toFixed(2),
            address: wallet ? wallet.address : null
        },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            totalAttempts: state.stats.totalAttempts,
            successfulTrades: state.stats.successfulTrades,
            failedTrades: state.stats.failedTrades,
            successRate: state.stats.successRate.toFixed(1),
            totalFlashLoans: state.stats.totalFlashLoans,
            opportunitiesFound: state.stats.opportunitiesFound
        },
        session: {
            startTime: state.session.startTime,
            lastScan: state.session.lastScan,
            totalScans: state.session.totalScans,
            uptime: `${hours}h ${minutes}m`
        },
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 50),
        connected: state.connected,
        debug: {
            lastDebugScan: debugData.lastScan,
            spreadsFound: debugData.spreads.length
        }
    });
});

app.post('/api/reset', (req, res) => {
    state.stats.totalProfitUSD = 0;
    state.stats.totalAttempts = 0;
    state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0;
    state.tradeHistory = [];
    addLog('📊 Stats reset', 'info');
    res.json({ status: 'reset' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: state.connected });
});

// ==================== DEBUG DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | Debug Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #0f0f1a; color: #e0e0e0; padding: 20px; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border-radius: 16px; padding: 24px; margin-bottom: 24px; }
        .header h1 { font-size: 28px; margin-bottom: 8px; }
        .badge { display: inline-block; padding: 4px 12px; background: #00ff8844; border-radius: 20px; font-size: 12px; color: #00ff88; margin-left: 12px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: #1a1a2e; border-radius: 12px; padding: 16px; border: 1px solid #2a2a3e; }
        .stat-label { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; }
        .stat-value { font-size: 24px; font-weight: 700; }
        .positive { color: #00ff88; }
        .section { background: #1a1a2e; border-radius: 12px; margin-bottom: 24px; overflow: hidden; }
        .section-header { padding: 16px 20px; background: #0f0f1a; border-bottom: 1px solid #2a2a3e; font-weight: 600; font-size: 16px; }
        .spread-table, .price-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .spread-table th, .price-table th { text-align: left; padding: 12px 16px; background: #0f0f1a; color: #888; font-weight: 500; }
        .spread-table td, .price-table td { padding: 10px 16px; border-bottom: 1px solid #2a2a3e; }
        .profitable { background: #00ff8810; border-left: 3px solid #00ff88; }
        .token-icon { font-size: 16px; margin-right: 6px; }
        .dex-badge { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #2a2a3e; border-radius: 8px; font-size: 11px; }
        .profit-cell { color: #00ff88; font-weight: 600; }
        .logs-container { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 11px; }
        .log-entry { padding: 8px 16px; border-bottom: 1px solid #2a2a3e; }
        .log-time { color: #666; margin-right: 12px; }
        .refresh-btn { padding: 8px 16px; background: #3b82f6; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 500; margin-bottom: 16px; }
        .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .auto-refresh { font-size: 12px; color: #888; margin-top: 8px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>🔍 Flash Loan Arbitrage Bot <span class="badge">DEBUG MODE</span></h1>
        <p>Real-time spread detection | Multi-DEX price comparison | PancakeSwap + QuickSwap + SushiSwap</p>
        <div class="auto-refresh">🔄 Auto-refreshing every 3 seconds</div>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 TOTAL PROFIT</div><div class="stat-value positive" id="totalProfit">$0.00</div></div>
        <div class="stat-card"><div class="stat-label">📊 SUCCESS RATE</div><div class="stat-value" id="successRate">0%</div></div>
        <div class="stat-card"><div class="stat-label">🔍 SPREADS FOUND</div><div class="stat-value" id="spreadsFound">0</div></div>
        <div class="stat-card"><div class="stat-label">💸 FLASH LOANS</div><div class="stat-value" id="flashLoans">0</div></div>
    </div>

    <div class="section">
        <div class="section-header">🏆 TOP SPREADS (Most Profitable Arbitrage Opportunities)</div>
        <table class="spread-table">
            <thead>
                <tr><th>Token</th><th>Buy → Sell</th><th>Buy Price</th><th>Sell Price</th><th>Raw Spread</th><th>Net (after fees)</th><th>Profit on $100</th><th>Status</th></tr>
            </thead>
            <tbody id="spreadsBody">
                <tr><td colspan="8" style="text-align:center; padding:40px;">Scanning for spreads...</td></tr>
            </tbody>
        </table>
    </div>

    <div class="two-columns">
        <div class="section">
            <div class="section-header">💰 Current Prices Across DEXes</div>
            <table class="price-table">
                <thead><tr><th>Token</th><th>🥞 PancakeSwap</th><th>⚡ QuickSwap</th><th>🍣 SushiSwap</th></tr></thead>
                <tbody id="pricesBody">
                    <tr><td colspan="4" style="text-align:center; padding:40px;">Loading prices...</td></tr>
                </tbody>
            </table>
        </div>
        <div class="section">
            <div class="section-header">📝 Live Activity Logs</div>
            <div class="logs-container" id="logsContainer">Initializing...</div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">📋 Recent Trades</div>
        <table class="spread-table">
            <thead><tr><th>Time</th><th>Token</th><th>Profit</th><th>Gas</th><th>Status</th><th>Tx</th></tr></thead>
            <tbody id="tradesBody">
                <tr><td colspan="6" style="text-align:center; padding:40px;">No trades yet</td></tr>
            </tbody>
        </table>
    </div>
</div>

<script>
    async function fetchData() {
        try {
            // Fetch debug spreads
            const debugRes = await fetch('/api/debug/spreads');
            const debugData = await debugRes.json();
            
            document.getElementById('spreadsFound').innerHTML = debugData.spreads?.length || 0;
            
            const spreadsBody = document.getElementById('spreadsBody');
            if (debugData.spreads && debugData.spreads.length > 0) {
                let html = '';
                for (let s of debugData.spreads.slice(0, 15)) {
                    const profitClass = s.isProfitable ? 'profitable' : '';
                    const statusBadge = s.isProfitable ? '✅ PROFITABLE' : '⚠️ Below threshold';
                    const statusColor = s.isProfitable ? '#00ff88' : '#888';
                    html += `<tr class="${profitClass}">
                        <td><span class="token-icon">${s.tokenIcon || '🪙'}</span> ${s.token}</td>
                        <td><span class="dex-badge">${s.buyDexIcon} ${s.buyDex}</span> → <span class="dex-badge">${s.sellDexIcon} ${s.sellDex}</span></td>
                        <td>$${s.buyPrice.toFixed(4)}</td>
                        <td>$${s.sellPrice.toFixed(4)}</td>
                        <td>${s.rawSpreadPercent}%</td>
                        <td style="color: ${parseFloat(s.netSpreadPercent) > 0 ? '#00ff88' : '#ff4444'}">${s.netSpreadPercent}%</td>
                        <td class="profit-cell">$${s.profitOn100USD}</td>
                        <td style="color: ${statusColor}">${statusBadge}</td>
                    </tr>`;
                }
                spreadsBody.innerHTML = html;
            } else {
                spreadsBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px;">No spreads found. Waiting for next scan...</td></tr>';
            }
            
            // Fetch prices
            const pricesRes = await fetch('/api/debug/prices');
            const pricesData = await pricesRes.json();
            
            const pricesByToken = {};
            if (pricesData.prices) {
                for (let p of pricesData.prices) {
                    if (!pricesByToken[p.token]) pricesByToken[p.token] = {};
                    pricesByToken[p.token][p.dex] = { price: p.price, icon: p.dexIcon };
                }
            }
            
            const pricesBody = document.getElementById('pricesBody');
            const tokens = ['POL', 'WETH', 'CAKE', 'WBTC', 'AAVE', 'LINK', 'CRV'];
            let pricesHtml = '';
            for (let token of tokens) {
                const tokenData = pricesByToken[token] || {};
                pricesHtml += `<tr>
                    <td><span class="token-icon">${token === 'POL' ? '🟣' : token === 'WETH' ? '💎' : token === 'CAKE' ? '🍰' : token === 'WBTC' ? '🟡' : '🪙'}</span> ${token}</td>
                    <td>${tokenData['PANCAKESWAP'] ? '$' + tokenData['PANCAKESWAP'].price.toFixed(4) : '—'}</td>
                    <td>${tokenData['QUICKSWAP'] ? '$' + tokenData['QUICKSWAP'].price.toFixed(4) : '—'}</td>
                    <td>${tokenData['SUSHISWAP'] ? '$' + tokenData['SUSHISWAP'].price.toFixed(4) : '—'}</td>
                </tr>`;
            }
            pricesBody.innerHTML = pricesHtml;
            
            // Fetch state
            const stateRes = await fetch('/api/state');
            const stateData = await stateRes.json();
            
            document.getElementById('totalProfit').innerHTML = '$' + (parseFloat(stateData.stats.totalProfitUSD) || 0).toFixed(2);
            document.getElementById('successRate').innerHTML = (stateData.stats.successRate || 0) + '%';
            document.getElementById('flashLoans').innerHTML = stateData.stats.totalFlashLoans || 0;
            
            // Logs
            const logsContainer = document.getElementById('logsContainer');
            if (stateData.logs && stateData.logs.length > 0) {
                let logsHtml = '';
                for (let log of stateData.logs.slice(0, 20)) {
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    logsHtml += '<div class="log-entry"><span class="log-time">[' + time + ']</span> ' + log.message + '</div>';
                }
                logsContainer.innerHTML = logsHtml;
            }
            
            // Trades
            const tradesBody = document.getElementById('tradesBody');
            if (stateData.tradeHistory && stateData.tradeHistory.length > 0) {
                let tradesHtml = '';
                for (let t of stateData.tradeHistory.slice(0, 10)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const profitColor = t.success ? '#00ff88' : '#ff4444';
                    const profitDisplay = t.success ? '+$' + t.profitUSD.toFixed(2) : 'Failed';
                    tradesHtml += `<tr>
                        <td>${time}</td>
                        <td>${t.token || '-'}</td>
                        <td style="color: ${profitColor}">${profitDisplay}</td>
                        <td>$${(t.gasCostUSD || 0).toFixed(4)}</td>
                        <td style="color: ${t.success ? '#00ff88' : '#ff4444'}">${t.success ? '✅ Success' : '❌ Failed'}</td>
                        <td>${t.txHash ? '<a href="https://polygonscan.com/tx/' + t.txHash + '" target="_blank" style="color:#60a5fa;">View →</a>' : '-'}</td>
                    </tr>`;
                }
                tradesBody.innerHTML = tradesHtml;
            }
            
        } catch(e) { console.error(e); }
    }
    
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>`);
});

// ==================== START ====================
async function start() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`🔍 FLASH LOAN ARBITRAGE BOT - DEBUG DASHBOARD`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✓ Debug mode: Showing real-time spreads`);
    console.log(`✓ ${DEXES.length} DEXes: ${DEXES.map(d => d.name).join(', ')}`);
    console.log(`✓ ${ALL_TOKENS.length - 1} tokens monitored`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Debug Dashboard: http://localhost:${PORT}`);
        console.log(`🔍 API endpoints:`);
        console.log(`   - /api/debug/spreads - View all spreads`);
        console.log(`   - /api/debug/prices - View all prices`);
        console.log(`   - /api/debug/token/:symbol - View token-specific data`);
    });
}

start();
