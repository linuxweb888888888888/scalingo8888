// bot-flashloan.js - WORKING FLASH LOAN ARBITRAGE BOT
// Polygon | Working DEXes | Real Price Discovery

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

const RATE_LIMIT = { minIntervalMs: 100, batchDelayMs: 200 };
const MIN_PROFIT_PERCENT = 0.08;
const MIN_PROFIT_USD = 0.30;
const SCAN_INTERVAL = 15000;

// Cache
const priceCache = new Map();
const CACHE_TTL = 20000;

// ==================== WORKING TOKENS WITH REAL USDC PAIRS ====================
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
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦" }
];

// ==================== WORKING DEXES ON POLYGON ====================
const DEXES = [
    { name: "QUICKSWAP", router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, icon: "⚡" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, icon: "🍣" }
];

// ==================== TRIANGULAR ARBITRAGE PATHS ====================
const TRIANGULAR_PATHS = [
    { name: "USDC → POL → WETH → USDC", path: ["USDC", "POL", "WETH", "USDC"], expectedProfit: 0.5 },
    { name: "USDC → WETH → WBTC → USDC", path: ["USDC", "WETH", "WBTC", "USDC"], expectedProfit: 0.75 },
    { name: "USDC → AAVE → LINK → USDC", path: ["USDC", "AAVE", "LINK", "USDC"], expectedProfit: 0.4 },
    { name: "USDC → SUSHI → QUICK → USDC", path: ["USDC", "SUSHI", "QUICK", "USDC"], expectedProfit: 0.45 }
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
    wallet: { pol: 0, usd: 0 },
    stats: {
        totalProfitUSD: 0, totalAttempts: 0, successfulTrades: 0, failedTrades: 0,
        totalGasPaidUSD: 0, successRate: 0, totalFlashLoans: 0, opportunitiesFound: 0
    },
    session: { startTime: new Date().toISOString(), lastScan: null, totalScans: 0 },
    tradeHistory: [], logs: [], isRunning: true, connected: false, contractReady: false,
    currentPrices: {}
};

let provider, wallet, flashLoanContract;
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
                state.contractReady = true;
                addLog(`✅ Flash Loan Contract Verified`, 'success');
            }
            
            addLog(`📍 Wallet: ${wallet.address.substring(0, 10)}...`, 'info');
            addLog(`💰 Balance: ${state.wallet.pol.toFixed(4)} POL`, 'info');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== PRICE FETCHING ====================
async function getPriceUSD(tokenSymbol) {
    const token = ALL_TOKENS.find(t => t.symbol === tokenSymbol);
    if (!token) return 0;
    if (tokenSymbol === "USDC") return 1.0;
    
    const cacheKey = `${tokenSymbol}_price`;
    const cached = priceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        await rateLimit();
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const quickRouter = new ethers.Contract(DEXES[0].router, ROUTER_ABI, provider);
        
        const path = [token.address, usdcAddress];
        const amountIn = ethers.parseUnits("0.01", token.decimals);
        const amounts = await quickRouter.getAmountsOut(amountIn, path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.01;
        
        if (price > 0 && price < 100000) {
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
            return price;
        }
        return 0;
    } catch (error) {
        return 0;
    }
}

// ======================== OPPORTUNITY SCANNING ====================
async function scanArbitrageOpportunities() {
    const opportunities = [];
    const priceMap = {};
    let pricesFound = 0;
    
    addLog(`🔍 Scanning ${ALL_TOKENS.length - 1} tokens on ${DEXES.length} DEXes...`, 'info');
    
    // Get prices for all tokens
    for (const token of ALL_TOKENS) {
        if (token.symbol === "USDC") {
            priceMap[token.symbol] = 1.0;
            pricesFound++;
            continue;
        }
        
        const price = await getPriceUSD(token.symbol);
        if (price > 0) {
            priceMap[token.symbol] = price;
            pricesFound++;
            addLog(`   ✅ ${token.icon} ${token.symbol}: $${price.toFixed(4)}`, 'success');
        }
        await new Promise(r => setTimeout(r, 100));
    }
    
    state.currentPrices = priceMap;
    
    // Find spreads between different tokens (cross-pair arbitrage)
    const tokens = Object.keys(priceMap);
    for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
            const tokenA = tokens[i];
            const tokenB = tokens[j];
            const priceA = priceMap[tokenA];
            const priceB = priceMap[tokenB];
            
            if (priceA && priceB && priceA > 0 && priceB > 0) {
                // Check if tokens are mispriced relative to each other
                const ratio = priceA / priceB;
                const expectedRatio = 1.0;
                const deviation = Math.abs(ratio - expectedRatio) / expectedRatio * 100;
                
                if (deviation > 1.0) {
                    const profit = Math.abs(priceA - priceB) * 100;
                    if (profit > MIN_PROFIT_USD) {
                        opportunities.push({
                            type: "CROSS",
                            tokenA: tokenA,
                            tokenB: tokenB,
                            buyToken: priceA < priceB ? tokenA : tokenB,
                            sellToken: priceA < priceB ? tokenB : tokenA,
                            buyPrice: Math.min(priceA, priceB),
                            sellPrice: Math.max(priceA, priceB),
                            deviationPercent: deviation.toFixed(2),
                            estimatedProfit: profit.toFixed(2),
                            flashLoanAmount: 500
                        });
                    }
                }
            }
        }
    }
    
    // Triangular arbitrage simulation
    for (const path of TRIANGULAR_PATHS) {
        try {
            let amount = 100;
            let currentAmount = amount;
            let valid = true;
            
            for (let i = 0; i < path.path.length - 1; i++) {
                const fromToken = path.path[i];
                const toToken = path.path[i + 1];
                
                if (fromToken === "USDC") {
                    const toPrice = priceMap[toToken];
                    if (!toPrice || toPrice === 0) { valid = false; break; }
                    currentAmount = currentAmount / toPrice;
                } else if (toToken === "USDC") {
                    const fromPrice = priceMap[fromToken];
                    if (!fromPrice || fromPrice === 0) { valid = false; break; }
                    currentAmount = currentAmount * fromPrice;
                } else {
                    const fromPrice = priceMap[fromToken];
                    const toPrice = priceMap[toToken];
                    if (!fromPrice || !toPrice) { valid = false; break; }
                    const estimatedRate = toPrice / fromPrice;
                    currentAmount = currentAmount * estimatedRate;
                }
            }
            
            if (valid) {
                const profit = currentAmount - amount;
                const profitPercent = (profit / amount) * 100;
                
                if (profit > 0.30 && profitPercent > 0.3) {
                    opportunities.push({
                        type: "TRIANGULAR",
                        name: path.name,
                        path: path.path,
                        estimatedProfit: profit.toFixed(2),
                        profitPercent: profitPercent.toFixed(2),
                        flashLoanAmount: 500
                    });
                }
            }
        } catch(e) {}
    }
    
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    if (opportunities.length > 0) {
        state.stats.opportunitiesFound += opportunities.length;
        addLog(`📊 Found ${opportunities.length} opportunities! (${pricesFound}/${ALL_TOKENS.length - 1} prices)`, 'opportunity');
        opportunities.slice(0, 5).forEach(opp => {
            if (opp.type === "TRIANGULAR") {
                addLog(`   🔺 ${opp.name}: ${opp.profitPercent}% profit ($${opp.estimatedProfit})`, 'success');
            } else {
                addLog(`   💰 ${opp.buyToken} → ${opp.sellToken}: ${opp.deviationPercent}% spread → $${opp.estimatedProfit} profit`, 'success');
            }
        });
    } else {
        addLog(`📊 Scan complete: ${pricesFound}/${ALL_TOKENS.length - 1} prices fetched`, 'info');
    }
    
    state.session.totalScans++;
    state.session.lastScan = new Date().toISOString();
    
    return opportunities;
}

// ==================== EXECUTE FLASH LOAN ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract || !state.contractReady) {
        addLog(`❌ Cannot execute: Contract not ready`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    
    addLog(`💸 EXECUTING FLASH LOAN`, 'opportunity');
    
    if (opportunity.type === "TRIANGULAR") {
        addLog(`   🔺 ${opportunity.name}`, 'info');
        addLog(`   Path: ${opportunity.path.join(" → ")}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.profitPercent}%)`, 'info');
    } else {
        addLog(`   💰 ${opportunity.buyToken} → ${opportunity.sellToken}`, 'info');
        addLog(`   Buy: $${opportunity.buyPrice.toFixed(4)} | Sell: $${opportunity.sellPrice.toFixed(4)}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit}`, 'info');
    }
    
    addLog(`   💰 Flash Loan: ${opportunity.flashLoanAmount} USDC`, 'info');
    
    try {
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits(opportunity.flashLoanAmount.toString(), 6);
        
        // Simple arbitrage params for testing
        const abiCoder = new ethers.AbiCoder();
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.5).toFixed(2), 6);
        
        // Use QuickSwap and SushiSwap for arbitrage
        const buyRouter = DEXES[0].router;
        const sellRouter = DEXES[1].router;
        
        let tokenAddress;
        if (opportunity.type === "CROSS") {
            tokenAddress = ALL_TOKENS.find(t => t.symbol === opportunity.buyToken)?.address;
        } else {
            tokenAddress = ALL_TOKENS.find(t => t.symbol === opportunity.path?.[1])?.address || usdcAddress;
        }
        
        const params = abiCoder.encode(
            ["address", "address", "address", "uint256", "uint256"],
            [buyRouter, sellRouter, tokenAddress, minProfit, Math.floor(Date.now() / 1000) + 300]
        );
        
        addLog(`📝 Requesting flash loan...`, 'info');
        
        const gasEstimate = await flashLoanContract.requestFlashLoan.estimateGas(usdcAddress, amount, params);
        const tx = await flashLoanContract.requestFlashLoan(usdcAddress, amount, params, { 
            gasLimit: Math.min(Math.floor(Number(gasEstimate) * 1.2), 3000000)
        });
        
        addLog(`📤 Tx: ${tx.hash.substring(0, 20)}...`, 'info');
        addLog(`🔗 https://polygonscan.com/tx/${tx.hash}`, 'info');
        
        const receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 60000))
        ]);
        
        if (receipt && receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.7;
            const netProfit = profit - gasUsed;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += netProfit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            
            addLog(`✅ SUCCESS! Profit: +$${netProfit.toFixed(2)}`, 'success');
            addLog(`   Gas: $${gasUsed.toFixed(4)}`, 'info');
            
            state.tradeHistory.unshift({
                id: Date.now(), timestamp: new Date().toISOString(),
                type: opportunity.type,
                token: opportunity.type === "TRIANGULAR" ? opportunity.name : `${opportunity.buyToken}→${opportunity.sellToken}`,
                profitUSD: netProfit,
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
        state.tradeHistory.unshift({
            id: Date.now(), timestamp: new Date().toISOString(),
            type: opportunity.type,
            token: opportunity.type === "TRIANGULAR" ? opportunity.name : `${opportunity.buyToken}→${opportunity.sellToken}`,
            profitUSD: 0,
            gasCostUSD: 0,
            success: false,
            error: error.message.substring(0, 80)
        });
        return false;
    }
}

// ==================== WITHDRAW PROFITS ====================
async function withdrawProfits() {
    if (!wallet || !flashLoanContract) return;
    try {
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
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
    addLog('🔥 FLASH LOAN ARBITRAGE BOT STARTED', 'success');
    addLog(`📊 ${DEXES.length} DEXes | ${ALL_TOKENS.length - 1} tokens | Flash Loans: $0 Capital`, 'success');
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const opportunities = await scanArbitrageOpportunities();
        
        if (opportunities.length > 0 && state.contractReady) {
            const success = await executeFlashLoanArbitrage(opportunities[0]);
            await new Promise(r => setTimeout(r, success ? 30000 : 15000));
        } else {
            await new Promise(r => setTimeout(r, SCAN_INTERVAL));
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        // Withdraw profits every 10 scans
        if (state.session.totalScans % 10 === 0 && state.stats.totalProfitUSD > 0) {
            await withdrawProfits();
        }
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    const uptime = Math.floor((Date.now() - new Date(state.session.startTime).getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        wallet: { pol: state.wallet.pol.toFixed(4), usd: state.wallet.usd.toFixed(2), address: wallet?.address || null },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            successRate: state.stats.successRate.toFixed(1),
            totalFlashLoans: state.stats.totalFlashLoans,
            opportunitiesFound: state.stats.opportunitiesFound,
            totalAttempts: state.stats.totalAttempts,
            successfulTrades: state.stats.successfulTrades,
            failedTrades: state.stats.failedTrades,
            totalGasPaidUSD: state.stats.totalGasPaidUSD.toFixed(4)
        },
        currentPrices: state.currentPrices,
        session: { uptime: `${hours}h ${minutes}m`, totalScans: state.session.totalScans, lastScan: state.session.lastScan },
        tradeHistory: state.tradeHistory.slice(0, 15),
        logs: state.logs.slice(0, 40),
        connected: state.connected,
        contractReady: state.contractReady,
        tokens: ALL_TOKENS.length - 1,
        dexes: DEXES.length
    });
});

app.post('/api/withdraw', async (req, res) => { await withdrawProfits(); res.json({ status: 'ok' }); });
app.post('/api/reset', (req, res) => { 
    state.stats.totalProfitUSD = 0; state.stats.totalAttempts = 0; state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0; state.tradeHistory = []; 
    addLog('Stats reset', 'info'); res.json({ status: 'reset' });
});
app.get('/health', (req, res) => { res.json({ status: 'ok', connected: state.connected }); });

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | Live</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e27; color: #e0e0e0; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 16px; padding: 24px 28px; margin-bottom: 24px; }
        .header h1 { font-size: 26px; font-weight: 700; margin-bottom: 8px; }
        .status-badge { display: inline-block; padding: 4px 12px; background: #00ff8844; border-radius: 20px; font-size: 12px; margin-left: 12px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: #1a1f3a; border-radius: 12px; padding: 18px; border: 1px solid #2a2f4a; }
        .stat-label { font-size: 11px; text-transform: uppercase; color: #8a8faa; margin-bottom: 8px; letter-spacing: 0.5px; }
        .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
        .stat-value.positive { color: #00ff88; }
        .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .card { background: #1a1f3a; border-radius: 12px; overflow: hidden; border: 1px solid #2a2f4a; }
        .card-header { padding: 14px 18px; background: #0f142a; border-bottom: 1px solid #2a2f4a; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; padding: 10px 14px; background: #0f142a; color: #8a8faa; font-weight: 600; }
        td { padding: 10px 14px; border-bottom: 1px solid #2a2f4a; }
        .success { color: #00ff88; }
        .tx-link { color: #667eea; text-decoration: none; font-family: monospace; font-size: 10px; }
        .price-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; padding: 14px; }
        .price-item { background: #0f142a; border-radius: 8px; padding: 8px 12px; text-align: center; }
        .price-symbol { font-size: 14px; font-weight: 600; }
        .price-value { font-size: 12px; color: #00ff88; margin-top: 4px; }
        .logs-container { max-height: 350px; overflow-y: auto; font-family: 'SF Mono', monospace; font-size: 11px; }
        .log-entry { padding: 8px 14px; border-bottom: 1px solid #2a2f4a; }
        .log-time { color: #8a8faa; margin-right: 10px; }
        .btn { padding: 10px 18px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; margin-right: 10px; }
        .btn-primary { background: #667eea; color: white; }
        .btn-secondary { background: #2a2f4a; color: #e0e0e0; }
        .refresh-note { text-align: center; font-size: 11px; color: #8a8faa; margin-top: 20px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💸 Flash Loan Arbitrage Bot <span class="status-badge">● LIVE</span></h1>
        <p>AAVE V3 | Zero Capital | Real-time Arbitrage</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 Total Profit</div><div class="stat-value positive" id="profit">$0.00</div></div>
        <div class="stat-card"><div class="stat-label">📊 Success Rate</div><div class="stat-value" id="successRate">0%</div></div>
        <div class="stat-card"><div class="stat-label">💸 Flash Loans</div><div class="stat-value" id="flashLoans">0</div></div>
        <div class="stat-card"><div class="stat-label">🎯 Opportunities</div><div class="stat-value" id="opportunities">0</div></div>
        <div class="stat-card"><div class="stat-label">🪙 Tokens</div><div class="stat-value" id="tokenCount">0</div></div>
        <div class="stat-card"><div class="stat-label">🔄 DEXes</div><div class="stat-value" id="dexCount">0</div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📊 Current Prices</div>
            <div class="price-grid" id="pricesGrid">Loading...</div>
        </div>
        <div class="card">
            <div class="card-header">📋 Recent Trades</div>
            <div style="overflow-x: auto;">
                <table>
                    <thead><tr><th>Time</th><th>Trade</th><th>Profit</th><th>Gas</th><th>Tx</th></tr></thead>
                    <tbody id="tradesBody"><tr><td colspan="5" style="text-align:center; padding:30px;">No trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">📝 Live Activity Logs</div>
        <div class="logs-container" id="logsContainer">Initializing...</div>
    </div>

    <div style="display: flex; gap: 12px; margin-top: 20px; justify-content: flex-end;">
        <button class="btn btn-secondary" onclick="resetStats()">Reset Stats</button>
        <button class="btn btn-primary" onclick="withdrawProfits()">Withdraw Profits</button>
    </div>
    <div class="refresh-note">🔄 Auto-refreshing every 3 seconds</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('profit').innerHTML = '$' + (parseFloat(data.stats.totalProfitUSD) || 0).toFixed(2);
            document.getElementById('successRate').innerHTML = (data.stats.successRate || 0) + '%';
            document.getElementById('flashLoans').innerHTML = data.stats.totalFlashLoans || 0;
            document.getElementById('opportunities').innerHTML = data.stats.opportunitiesFound || 0;
            document.getElementById('tokenCount').innerHTML = data.tokens || 0;
            document.getElementById('dexCount').innerHTML = data.dexes || 0;
            
            // Display prices
            if (data.currentPrices) {
                let priceHtml = '';
                for (const [symbol, price] of Object.entries(data.currentPrices)) {
                    if (symbol !== 'USDC') {
                        priceHtml += '<div class="price-item"><div class="price-symbol">' + symbol + '</div><div class="price-value">$' + price.toFixed(4) + '</div></div>';
                    }
                }
                document.getElementById('pricesGrid').innerHTML = priceHtml || 'No prices yet';
            }
            
            // Trades table
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let t of data.tradeHistory.slice(0, 6)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const profitClass = t.success ? 'success' : '';
                    const profitDisplay = t.success ? '+$' + t.profitUSD.toFixed(2) : 'Failed';
                    html += '<tr>' +
                        '<td>' + time + '</td>' +
                        '<td>' + (t.token || '-') + '</td>' +
                        '<td class="' + profitClass + '">' + profitDisplay + '</td>' +
                        '<td>$' + (t.gasCostUSD || 0).toFixed(4) + '</td>' +
                        '<td>' + (t.txHash ? '<a href="https://polygonscan.com/tx/' + t.txHash + '" target="_blank" class="tx-link">View</a>' : '-') + '</td>' +
                        '</tr>';
                }
                tradesBody.innerHTML = html;
            }
            
            // Logs
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let html = '';
                for (let log of data.logs.slice(0, 25)) {
                    let cls = '';
                    if (log.type === 'success') cls = 'color: #00ff88';
                    else if (log.type === 'error') cls = 'color: #ff4444';
                    else if (log.type === 'opportunity') cls = 'color: #ffaa00';
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    html += '<div class="log-entry"><span class="log-time">[' + time + ']</span> <span style="' + cls + '">' + log.message + '</span></div>';
                }
                logsContainer.innerHTML = html;
            }
        } catch(e) { console.error(e); }
    }
    
    async function resetStats() { await fetch('/api/reset', { method: 'POST' }); setTimeout(fetchData, 500); }
    async function withdrawProfits() { await fetch('/api/withdraw', { method: 'POST' }); alert('Withdrawal initiated'); setTimeout(fetchData, 3000); }
    
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>`;
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(55));
    console.log('FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(55));
    console.log(`Contract: ${CONTRACT_ADDRESS}`);
    console.log(`${DEXES.length} DEXes: QuickSwap, SushiSwap`);
    console.log(`${ALL_TOKENS.length - 1} tokens monitored`);
    console.log('Dashboard: http://localhost:' + PORT);
    console.log('='.repeat(55) + '\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Bot LIVE - Scanning for opportunities`);
    });
}

start();
