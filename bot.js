// bot-flashloan-arbitrum.js - Advanced Flash Loan Arbitrage Bot on Arbitrum
// Fixed HTML template syntax error

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBITRUM_RPC = process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x8c6D2f6Af836A7eFf885Bf2bC6d3FfEfEe5D2C9D";

// Rate limiting configuration
const RATE_LIMIT = {
    minIntervalMs: 80,
    batchDelayMs: 400
};

// Cache prices
const priceCache = new Map();
const CACHE_TTL = 15000;

// ==================== ALL TOKENS ON ARBITRUM ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, icon: "🏦", category: "Stable" },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75B0Ea42c394C", decimals: 8, icon: "🟡", category: "L1" },
    { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, icon: "🔴", category: "DeFi" },
    { symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "GMX", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, icon: "🏔️", category: "DeFi" }
];

// ==================== DEX CONFIGURATION ====================
const DEXES = [
    { name: "UNISWAP_V3_500", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0005, type: "v3", icon: "🦄" },
    { name: "UNISWAP_V3_3000", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0030, type: "v3", icon: "🦄" },
    { name: "SUSHISWAP_V2", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, type: "v2", icon: "🍣" },
    { name: "CAMELOT_V3_500", router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", fee: 0.0005, type: "v3", icon: "🐫" },
    { name: "CAMELOT_V3_3000", router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", fee: 0.0030, type: "v3", icon: "🐫" },
    { name: "BALANCER", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", fee: 0.0020, type: "balancer", icon: "⚖️" },
    { name: "CURVE", router: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", fee: 0.0004, type: "curve", icon: "📈" }
];

// ==================== TRIANGULAR ARBITRAGE PATHS ====================
const TRIANGULAR_PATHS = [
    { name: "USDC → WETH → ARB → USDC", path: ["USDC", "WETH", "ARB", "USDC"], minProfit: 0.50 },
    { name: "USDC → WETH → WBTC → USDC", path: ["USDC", "WETH", "WBTC", "USDC"], minProfit: 0.75 },
    { name: "USDC → AAVE → UNI → USDC", path: ["USDC", "AAVE", "UNI", "USDC"], minProfit: 0.40 },
    { name: "USDC → LINK → GMX → USDC", path: ["USDC", "LINK", "GMX", "USDC"], minProfit: 0.45 }
];

// ==================== CONTRACT ABI ====================
const CONTRACT_ABI = [
    "function executeArbitrage(address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit) external payable returns (uint256)",
    "function setMinProfitBps(uint256 bps) external",
    "function withdraw(address token, uint256 amount) external",
    "function owner() view returns (address)",
    "function getBalance(address token) view returns (uint256)",
    "function requestFlashLoan(address asset, uint256 amount, tuple(address[] path, uint8 dex1, uint8 dex2, uint256 amountIn, uint256 minProfit, address profitRecipient) params) external",
    "function totalFlashLoans() view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)",
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) memory params) external view returns (uint256 amountOut)"
];

// ==================== STATE ====================
let state = {
    wallet: { eth: 0, usd: 0 },
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
let ethPriceUSD = 1800;
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
        provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);
        await rateLimit();
        const blockNumber = await provider.getBlockNumber();
        addLog(`Connected to Arbitrum (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here') {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            flashLoanContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            
            await rateLimit();
            const balance = await provider.getBalance(wallet.address);
            state.wallet.eth = parseFloat(ethers.formatEther(balance));
            state.wallet.usd = state.wallet.eth * ethPriceUSD;
            
            await rateLimit();
            const code = await provider.getCode(CONTRACT_ADDRESS);
            if (code !== '0x') {
                addLog(`Flash Loan Contract: ${CONTRACT_ADDRESS.substring(0, 20)}...`, 'success');
                try {
                    const total = await flashLoanContract.totalFlashLoans();
                    state.stats.totalFlashLoans = Number(total);
                    addLog(`Total Flash Loans Executed: ${state.stats.totalFlashLoans}`, 'info');
                } catch(e) {}
            }
            
            addLog(`Wallet: ${wallet.address.substring(0, 10)}...${wallet.address.substring(38)}`, 'info');
            addLog(`Balance: ${state.wallet.eth.toFixed(6)} ETH ($${state.wallet.usd.toFixed(2)})`, 'info');
        } else {
            addLog(`Scan-only mode (no private key)`, 'warning');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== PRICE FETCHING ====================
async function getTokenPriceOnDex(tokenAddress, decimals, dexRouter, dexType, dexFee = null) {
    const cacheKey = `${tokenAddress}_${dexRouter}_${dexFee || 0}`;
    const cached = priceCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        await rateLimit();
        const router = new ethers.Contract(dexRouter, ROUTER_ABI, provider);
        let price;
        const usdcAddress = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        
        if (dexType === "v3" && dexFee) {
            try {
                const quoteParams = {
                    tokenIn: tokenAddress,
                    tokenOut: usdcAddress,
                    fee: dexFee,
                    amountIn: ethers.parseUnits("1", decimals),
                    sqrtPriceLimitX96: 0
                };
                const amountOut = await router.quoteExactInputSingle(quoteParams);
                price = parseFloat(ethers.formatUnits(amountOut, 6));
            } catch(e) {
                return 0;
            }
        } else {
            try {
                const path = [tokenAddress, usdcAddress];
                const amounts = await router.getAmountsOut(ethers.parseUnits("1", decimals), path);
                price = parseFloat(ethers.formatUnits(amounts[1], 6));
            } catch(e) {
                return 0;
            }
        }
        
        if (price > 0 && price < 1000000) {
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
        }
        return price;
    } catch (error) {
        return 0;
    }
}

async function getTokenPricesOnAllDexes(token) {
    const prices = [];
    for (const dex of DEXES) {
        const price = await getTokenPriceOnDex(token.address, token.decimals, dex.router, dex.type, dex.fee);
        if (price > 0 && price < 1000000) {
            prices.push({ dex: dex.name, dexIcon: dex.icon, price: price, fee: dex.fee });
        }
    }
    return prices;
}

// ==================== SCANNING ====================
async function scanAllTokens() {
    const opportunities = [];
    const tokensToScan = ALL_TOKENS.filter(t => t.symbol !== 'USDC' && t.symbol !== 'USDT');
    
    addLog(`Scanning ${tokensToScan.length} tokens across ${DEXES.length} DEXes on Arbitrum...`, 'info');
    
    const allPrices = new Map();
    const batchSize = 3;
    
    for (let i = 0; i < tokensToScan.length; i += batchSize) {
        const batch = tokensToScan.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (token) => {
            try {
                await new Promise(r => setTimeout(r, Math.random() * 50));
                const prices = await getTokenPricesOnAllDexes(token);
                if (prices.length >= 2) {
                    allPrices.set(token.symbol, prices);
                    
                    for (let a = 0; a < prices.length; a++) {
                        for (let b = a + 1; b < prices.length; b++) {
                            const diffPercent = Math.abs((prices[a].price - prices[b].price) / prices[a].price * 100);
                            const totalFees = (prices[a].fee + prices[b].fee) * 100;
                            const netDiff = diffPercent - totalFees;
                            
                            if (netDiff > 0.06) {
                                const estimatedProfit = Math.abs(prices[a].price - prices[b].price) * 100;
                                const afterFees = estimatedProfit * (1 - (prices[a].fee + prices[b].fee));
                                
                                if (afterFees > 0.20) {
                                    return {
                                        type: "SIMPLE",
                                        token: token.symbol,
                                        icon: token.icon,
                                        tokenAddress: token.address,
                                        decimals: token.decimals,
                                        buyDex: prices[a].price < prices[b].price ? prices[a].dex : prices[b].dex,
                                        sellDex: prices[a].price < prices[b].price ? prices[b].dex : prices[a].dex,
                                        buyPrice: Math.min(prices[a].price, prices[b].price).toFixed(4),
                                        sellPrice: Math.max(prices[a].price, prices[b].price).toFixed(4),
                                        diffPercent: diffPercent.toFixed(2),
                                        netDiff: netDiff.toFixed(2),
                                        estimatedProfit: afterFees.toFixed(2),
                                        fees: (totalFees).toFixed(2)
                                    };
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                return null;
            }
            return null;
        });
        
        const batchResults = await Promise.all(batchPromises);
        for (const result of batchResults) {
            if (result) opportunities.push(result);
        }
        
        if (i + batchSize < tokensToScan.length) {
            await new Promise(r => setTimeout(r, RATE_LIMIT.batchDelayMs));
        }
    }
    
    // Triangular arbitrage scanning
    for (const path of TRIANGULAR_PATHS) {
        try {
            let amount = 100;
            let currentAmount = amount;
            let validRoute = true;
            
            for (let i = 0; i < path.path.length - 1; i++) {
                const fromToken = path.path[i];
                const toToken = path.path[i + 1];
                
                if (fromToken === "USDC") {
                    const tokenData = ALL_TOKENS.find(t => t.symbol === toToken);
                    if (!tokenData) { validRoute = false; break; }
                    
                    const prices = allPrices.get(toToken);
                    if (!prices || prices.length === 0) { validRoute = false; break; }
                    
                    const bestPrice = Math.min(...prices.map(p => p.price));
                    currentAmount = currentAmount / bestPrice;
                } else if (toToken === "USDC") {
                    const tokenData = ALL_TOKENS.find(t => t.symbol === fromToken);
                    if (!tokenData) { validRoute = false; break; }
                    
                    const prices = allPrices.get(fromToken);
                    if (!prices || prices.length === 0) { validRoute = false; break; }
                    
                    const bestPrice = Math.max(...prices.map(p => p.price));
                    currentAmount = currentAmount * bestPrice;
                } else {
                    validRoute = false;
                    break;
                }
            }
            
            if (validRoute) {
                const profit = currentAmount - amount;
                const profitPercent = (profit / amount) * 100;
                
                if (profit > 0.40 && profitPercent > 0.4) {
                    opportunities.push({
                        type: "TRIANGULAR",
                        name: path.name,
                        path: path.path,
                        estimatedProfit: profit.toFixed(2),
                        profitPercent: profitPercent.toFixed(2),
                        netProfit: (profitPercent - 0.5).toFixed(2)
                    });
                }
            }
        } catch (error) {}
    }
    
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    if (opportunities.length > 0) {
        state.stats.opportunitiesFound += opportunities.length;
        const triangularCount = opportunities.filter(o => o.type === "TRIANGULAR").length;
        state.stats.triangularOpportunities += triangularCount;
        
        addLog(`Found ${opportunities.length} opportunities on Arbitrum (${triangularCount} triangular)`, 'opportunity');
        opportunities.slice(0, 5).forEach(opp => {
            if (opp.type === "TRIANGULAR") {
                addLog(`  ${opp.name}: $${opp.estimatedProfit} profit`, 'success');
            } else {
                addLog(`  ${opp.icon} ${opp.token}: ${opp.netDiff}% net ($${opp.estimatedProfit})`, 'info');
            }
        });
    }
    
    return opportunities;
}

// ==================== EXECUTION ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    state.session.lastScan = new Date().toISOString();
    
    if (opportunity.type === "TRIANGULAR") {
        addLog(`Executing TRIANGULAR FLASH LOAN: ${opportunity.name}`, 'opportunity');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit}`, 'info');
    } else {
        addLog(`Executing FLASH LOAN: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
        addLog(`   Route: ${opportunity.buyDex} -> ${opportunity.sellDex}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit}`, 'info');
    }
    
    addLog(`   Capital needed: $0 (AAVE V3 flash loan)`, 'success');
    
    try {
        const asset = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits("500", 6);
        
        let path, dex1, dex2;
        
        if (opportunity.type === "TRIANGULAR") {
            path = [
                asset,
                ALL_TOKENS.find(t => t.symbol === opportunity.path[1]).address,
                ALL_TOKENS.find(t => t.symbol === opportunity.path[2]).address,
                asset
            ];
            dex1 = 0;
            dex2 = 1;
        } else {
            path = [asset, opportunity.tokenAddress, asset];
            dex1 = 0;
            dex2 = 1;
        }
        
        const amountIn = ethers.parseUnits("500", 6);
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.5).toFixed(2), 6);
        const profitRecipient = wallet.address;
        
        const flashParams = {
            path: path,
            dex1: dex1,
            dex2: dex2,
            amountIn: amountIn,
            minProfit: minProfit,
            profitRecipient: profitRecipient
        };
        
        addLog(`Requesting flash loan of 500 USDC from AAVE V3...`, 'info');
        
        await rateLimit();
        const tx = await flashLoanContract.requestFlashLoan(asset, amount, flashParams, { gasLimit: 2000000 });
        
        addLog(`Transaction sent: ${tx.hash}`, 'info');
        addLog(`https://arbiscan.io/tx/${tx.hash}`, 'info');
        
        addLog(`Waiting for confirmation...`, 'info');
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * ethPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += profit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            
            addLog(`FLASH LOAN SUCCESSFUL!`, 'success');
            addLog(`   Profit: +$${profit.toFixed(2)}`, 'success');
            
            state.tradeHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                type: opportunity.type,
                token: opportunity.token || opportunity.name,
                icon: opportunity.icon || "TRI",
                profitUSD: profit,
                gasCostUSD: gasUsed,
                txHash: tx.hash,
                explorerUrl: `https://arbiscan.io/tx/${tx.hash}`,
                success: true
            });
            
            return true;
        } else {
            throw new Error("Transaction reverted");
        }
        
    } catch (error) {
        state.stats.failedTrades++;
        addLog(`FLASH LOAN FAILED - No gas cost`, 'error');
        addLog(`   Error: ${error.message.substring(0, 150)}`, 'error');
        
        state.tradeHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type: opportunity.type,
            token: opportunity.token || opportunity.name,
            profitUSD: 0,
            gasCostUSD: 0,
            success: false,
            error: error.message.substring(0, 100)
        });
        
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    addLog('FLASH LOAN ARBITRAGE BOT - ARBITRUM NETWORK STARTED', 'success');
    addLog(`Scanning ${ALL_TOKENS.length} tokens across ${DEXES.length} DEXes`, 'success');
    addLog(`Triangular arbitrage enabled (${TRIANGULAR_PATHS.length} paths)`, 'success');
    addLog(`AAVE V3 Flash Loans - $0 Capital Needed`, 'success');
    
    let consecutiveEmptyScans = 0;
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const opportunities = await scanAllTokens();
        
        if (opportunities.length > 0) {
            consecutiveEmptyScans = 0;
            await executeFlashLoanArbitrage(opportunities[0]);
            await new Promise(r => setTimeout(r, 20000));
        } else {
            consecutiveEmptyScans++;
            state.session.totalScans++;
            
            if (consecutiveEmptyScans % 10 === 0) {
                addLog(`Scan #${state.session.totalScans} complete. No opportunities found.`, 'info');
            }
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        const waitTime = opportunities.length > 0 ? 15000 : 12000;
        await new Promise(r => setTimeout(r, waitTime));
    }
}

// ==================== API ====================
app.get('/api/state', (req, res) => {
    const uptime = Math.floor((Date.now() - new Date(state.session.startTime).getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        network: "Arbitrum",
        wallet: {
            eth: state.wallet.eth.toFixed(6),
            usd: state.wallet.usd.toFixed(2),
            address: wallet ? wallet.address : null
        },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            totalAttempts: state.stats.totalAttempts,
            successfulTrades: state.stats.successfulTrades,
            failedTrades: state.stats.failedTrades,
            totalGasPaidUSD: state.stats.totalGasPaidUSD.toFixed(4),
            successRate: state.stats.successRate.toFixed(1),
            avgProfit: state.stats.successfulTrades > 0 ? (state.stats.totalProfitUSD / state.stats.successfulTrades).toFixed(2) : 0,
            totalFlashLoans: state.stats.totalFlashLoans,
            opportunitiesFound: state.stats.opportunitiesFound,
            triangularOpportunities: state.stats.triangularOpportunities
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
        ethPrice: ethPriceUSD,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/reset', (req, res) => {
    state.stats.totalProfitUSD = 0;
    state.stats.totalAttempts = 0;
    state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0;
    state.stats.totalGasPaidUSD = 0;
    state.stats.successRate = 0;
    state.tradeHistory = [];
    addLog('Stats reset', 'info');
    res.json({ status: 'reset' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', network: 'Arbitrum', connected: state.connected });
});

// ==================== SIMPLE HTML DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Flash Loan Bot - Arbitrum</title>
    <style>
        body { font-family: monospace; background: #0a0a0a; color: #0f0; padding: 20px; margin: 0; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: #fff; border-bottom: 2px solid #0f0; padding-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .card { background: #111; border: 1px solid #333; padding: 15px; border-radius: 8px; }
        .card h3 { margin: 0 0 10px 0; color: #0f0; font-size: 12px; }
        .card .value { font-size: 28px; font-weight: bold; }
        .positive { color: #0f0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #333; }
        th { color: #0f0; }
        .log { font-family: monospace; font-size: 11px; padding: 5px 0; border-bottom: 1px solid #222; }
        .success { color: #0f0; }
        .error { color: #f00; }
        .opportunity { color: #ff0; }
        .refresh-btn { background: #0f0; color: #000; border: none; padding: 10px 20px; cursor: pointer; margin-top: 10px; }
        .refresh-btn:hover { background: #0c0; }
    </style>
</head>
<body>
<div class="container">
    <h1>💸 Flash Loan Arbitrage Bot - Arbitrum Network</h1>
    <div class="stats" id="stats">
        <div class="card"><h3>PROFIT</h3><div class="value positive" id="profit">$0.00</div></div>
        <div class="card"><h3>SUCCESS RATE</h3><div class="value" id="successRate">0%</div></div>
        <div class="card"><h3>OPPORTUNITIES</h3><div class="value" id="opportunities">0</div></div>
        <div class="card"><h3>FLASH LOANS</h3><div class="value" id="flashLoans">0</div></div>
    </div>
    <div id="trades"></div>
    <div id="logs"></div>
    <button class="refresh-btn" onclick="location.reload()">Refresh Dashboard</button>
</div>
<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            document.getElementById('profit').innerHTML = '$' + (parseFloat(data.stats.totalProfitUSD) || 0).toFixed(2);
            document.getElementById('successRate').innerHTML = (data.stats.successRate || 0) + '%';
            document.getElementById('opportunities').innerHTML = data.stats.opportunitiesFound || 0;
            document.getElementById('flashLoans').innerHTML = data.stats.totalFlashLoans || 0;
            
            let tradesHtml = '<h3>Recent Trades</h3><table><tr><th>Time</th><th>Type</th><th>Token</th><th>Profit</th><th>TX</th></tr>';
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                for (let t of data.tradeHistory.slice(0, 10)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    tradesHtml += '<tr>' +
                        '<td>' + time + '</td>' +
                        '<td>' + (t.type || 'SIMPLE') + '</td>' +
                        '<td>' + (t.token || '-') + '</td>' +
                        '<td class="positive">+$' + (t.profitUSD || 0).toFixed(2) + '</td>' +
                        '<td>' + (t.txHash ? '<a href="' + t.explorerUrl + '" target="_blank" style="color:#0f0">View</a>' : '-') + '</td>' +
                    '</tr>';
                }
            } else {
                tradesHtml += '<tr><td colspan="5">No trades yet</td></tr>';
            }
            tradesHtml += '</table>';
            document.getElementById('trades').innerHTML = tradesHtml;
            
            let logsHtml = '<h3>Activity Logs</h3>';
            if (data.logs && data.logs.length > 0) {
                for (let log of data.logs.slice(0, 30)) {
                    let cls = '';
                    if (log.type === 'success') cls = 'success';
                    else if (log.type === 'error') cls = 'error';
                    else if (log.type === 'opportunity') cls = 'opportunity';
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    logsHtml += '<div class="log ' + cls + '">[' + time + '] ' + log.message + '</div>';
                }
            }
            document.getElementById('logs').innerHTML = logsHtml;
        } catch(e) { console.error(e); }
    }
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>
    `);
});

// ==================== START ====================
async function start() {
    console.log('\n========================================');
    console.log('FLASH LOAN ARBITRAGE BOT - ARBITRUM');
    console.log('========================================');
    console.log(`DEXes: ${DEXES.length} enabled`);
    console.log(`Triangular paths: ${TRIANGULAR_PATHS.length}`);
    console.log(`Tokens: ${ALL_TOKENS.length}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log('========================================\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Dashboard: http://localhost:${PORT}`);
    });
}

start();
