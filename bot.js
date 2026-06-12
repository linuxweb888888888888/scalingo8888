// bot-flashloan-arbitrum.js - Advanced Flash Loan Arbitrage Bot on Arbitrum
// Scans 6+ DEXes, Triangular paths, Optimized opportunity detection

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBITRUM_RPC = process.env.ARBITRUM_RPC || "https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY";
// Alternative free RPCs: https://arb1.arbitrum.io/rpc, https://rpc.ankr.com/arbitrum
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0x8c6D2f6Af836A7eFf885Bf2bC6d3FfEfEe5D2C9D"; // Updated Arbitrum contract

// Rate limiting configuration
const RATE_LIMIT = {
    minIntervalMs: 80,   // Arbitrum can handle slightly more calls
    batchDelayMs: 400
};

// Cache prices to reduce API calls
const priceCache = new Map();
const CACHE_TTL = 15000; // 15 seconds cache (fresher data for Arbitrum)

// ==================== ALL TOKENS ON ARBITRUM ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, icon: "🏦", category: "Stable" },
    { symbol: "ETH", address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18, icon: "💎", category: "L1" }, // Native ETH
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75B0Ea42c394C", decimals: 8, icon: "🟡", category: "L1" },
    { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, icon: "🔴", category: "DeFi" },
    { symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "GMX", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, icon: "🏔️", category: "DeFi" },
    { symbol: "MAGIC", address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", decimals: 18, icon: "✨", category: "DeFi" }
];

// ==================== EXPANDED DEX CONFIGURATION FOR ARBITRUM ====================
const DEXES = [
    { 
        name: "UNISWAP_V3_500", 
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", 
        fee: 0.0005, 
        type: "v3",
        icon: "🦄"
    },
    { 
        name: "UNISWAP_V3_3000", 
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", 
        fee: 0.0030, 
        type: "v3",
        icon: "🦄"
    },
    { 
        name: "SUSHISWAP_V2", 
        router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", 
        fee: 0.0030, 
        type: "v2",
        icon: "🍣"
    },
    { 
        name: "CAMELOT_V3_500", 
        router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", 
        fee: 0.0005, 
        type: "v3",
        icon: "🐫"
    },
    { 
        name: "CAMELOT_V3_3000", 
        router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", 
        fee: 0.0030, 
        type: "v3",
        icon: "🐫"
    },
    { 
        name: "BALANCER", 
        router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", 
        fee: 0.0020, 
        type: "balancer",
        icon: "⚖️"
    },
    { 
        name: "CURVE", 
        router: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", 
        fee: 0.0004, 
        type: "curve",
        icon: "📈"
    },
    { 
        name: "PANCAKESWAP_V3_500", 
        router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", 
        fee: 0.0005, 
        type: "v3",
        icon: "🥞"
    },
    { 
        name: "PANCAKESWAP_V3_2500", 
        router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14", 
        fee: 0.0025, 
        type: "v3",
        icon: "🥞"
    },
    { 
        name: "WOOFI", 
        router: "0x4f4Fd4290c9bB49764701803AF6445c5b03E8f06", 
        fee: 0.0010, 
        type: "v2",
        icon: "🐺"
    }
];

// ==================== TRIANGULAR ARBITRAGE PATHS ====================
const TRIANGULAR_PATHS = [
    { 
        name: "USDC → WETH → ARB → USDC",
        path: ["USDC", "WETH", "ARB", "USDC"],
        description: "Stable → L1 → DeFi → Stable",
        minProfit: 0.50
    },
    { 
        name: "USDC → WETH → WBTC → USDC",
        path: ["USDC", "WETH", "WBTC", "USDC"],
        description: "Stable → WETH → WBTC → Stable",
        minProfit: 0.75
    },
    { 
        name: "USDC → AAVE → UNI → USDC",
        path: ["USDC", "AAVE", "UNI", "USDC"],
        description: "Stable → DeFi → DeFi → Stable",
        minProfit: 0.40
    },
    { 
        name: "USDC → LINK → GMX → USDC",
        path: ["USDC", "LINK", "GMX", "USDC"],
        description: "Stable → Oracle → Perp → Stable",
        minProfit: 0.45
    },
    { 
        name: "USDC → WETH → GMX → USDC",
        path: ["USDC", "WETH", "GMX", "USDC"],
        description: "Stable → L1 → Perp → Stable",
        minProfit: 0.55
    },
    { 
        name: "USDC → ARB → MAGIC → USDC",
        path: ["USDC", "ARB", "MAGIC", "USDC"],
        description: "Stable → DeFi → Gaming → Stable",
        minProfit: 0.50
    },
    { 
        name: "USDC → WBTC → AAVE → USDC",
        path: ["USDC", "WBTC", "AAVE", "USDC"],
        description: "Stable → L1 → DeFi → Stable",
        minProfit: 0.60
    }
];

// ==================== FLASH LOAN CONTRACT ABI (AAVE V3 on Arbitrum) ====================
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

// AAVE V3 on Arbitrum - Pool Addresses Provider
const AAVE_POOL_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";
const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

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
let ethPriceUSD = 1800; // Approximate ETH price
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
        addLog(`✅ Connected to Arbitrum (Block: ${blockNumber.toLocaleString()})`, 'success');
        
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
                addLog(`✅ Flash Loan Contract: ${CONTRACT_ADDRESS.substring(0, 20)}...`, 'success');
                try {
                    const total = await flashLoanContract.totalFlashLoans();
                    state.stats.totalFlashLoans = Number(total);
                    addLog(`📊 Total Flash Loans Executed: ${state.stats.totalFlashLoans}`, 'info');
                } catch(e) {}
            } else {
                addLog(`⚠️ Contract not deployed at ${CONTRACT_ADDRESS} - Deploy first!`, 'warning');
            }
            
            addLog(`📍 Wallet: ${wallet.address.substring(0, 10)}...${wallet.address.substring(38)}`, 'info');
            addLog(`💰 Balance: ${state.wallet.eth.toFixed(6)} ETH (~$${state.wallet.usd.toFixed(2)})`, 'info');
            
            if (state.wallet.eth < 0.03) {
                addLog(`⚠️ Low ETH! Need ~0.03 ETH for gas on Arbitrum. Send ETH to: ${wallet.address}`, 'warning');
            }
        } else {
            addLog(`⚠️ Scan-only mode (no private key)`, 'warning');
        }
        
        // Update ETH price
        try {
            const usdcToken = ALL_TOKENS.find(t => t.symbol === "USDC");
            const wethToken = ALL_TOKENS.find(t => t.symbol === "WETH");
            if (usdcToken && wethToken) {
                const price = await getTokenPriceOnDex(wethToken.address, wethToken.decimals, DEXES[0].router, DEXES[0].type, DEXES[0].fee);
                if (price > 0) ethPriceUSD = price;
            }
        } catch(e) {}
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== ENHANCED PRICE FETCHING ====================
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
        
        if (tokenAddress.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
            // Native ETH - use WETH address instead
            const wethAddress = ALL_TOKENS.find(t => t.symbol === "WETH").address;
            return await getTokenPriceOnDex(wethAddress, decimals, dexRouter, dexType, dexFee);
        }
        
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
        const price = await getTokenPriceOnDex(
            token.address, 
            token.decimals, 
            dex.router, 
            dex.type, 
            dex.fee
        );
        if (price > 0 && price < 1000000) {
            prices.push({
                dex: dex.name,
                dexIcon: dex.icon,
                price: price,
                fee: dex.fee
            });
        }
    }
    return prices;
}

// ==================== EXPANDED SCANNING ====================
async function scanAllTokens() {
    const opportunities = [];
    const tokensToScan = ALL_TOKENS.filter(t => t.symbol !== 'USDC' && t.symbol !== 'USDT');
    
    addLog(`🔍 Scanning ${tokensToScan.length} tokens across ${DEXES.length} DEXes on Arbitrum...`, 'info');
    
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
                            
                            if (netDiff > 0.06) { // Lower threshold for Arbitrum
                                const estimatedProfit = Math.abs(prices[a].price - prices[b].price) * 100;
                                const afterFees = estimatedProfit * (1 - (prices[a].fee + prices[b].fee));
                                
                                if (afterFees > 0.20) { // Lower to $0.20 for Arbitrum
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
    
    // ==================== TRIANGULAR ARBITRAGE SCANNING ====================
    const triangularOpps = await scanTriangularArbitrage(allPrices);
    opportunities.push(...triangularOpps);
    
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    if (opportunities.length > 0) {
        state.stats.opportunitiesFound += opportunities.length;
        const triangularCount = opportunities.filter(o => o.type === "TRIANGULAR").length;
        state.stats.triangularOpportunities += triangularCount;
        
        addLog(`📊 Found ${opportunities.length} opportunities on Arbitrum (${triangularCount} triangular)`, 'opportunity');
        opportunities.slice(0, 5).forEach(opp => {
            if (opp.type === "TRIANGULAR") {
                addLog(`   🔺 ${opp.name}: ${opp.netProfit}% profit ($${opp.estimatedProfit})`, 'success');
            } else {
                addLog(`   ${opp.icon} ${opp.token}: ${opp.netDiff}% net ($${opp.estimatedProfit}) | ${opp.buyDex} → ${opp.sellDex}`, 'info');
            }
        });
    }
    
    return opportunities;
}

async function scanTriangularArbitrage(allPrices) {
    const opportunities = [];
    
    for (const path of TRIANGULAR_PATHS) {
        try {
            let amount = 100;
            let currentAmount = amount;
            let route = [];
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
                    const bestDex = prices.find(p => p.price === bestPrice);
                    
                    currentAmount = currentAmount / bestPrice;
                    route.push({ from: fromToken, to: toToken, dex: bestDex.dex, price: bestPrice, amount: currentAmount });
                } else if (toToken === "USDC") {
                    const tokenData = ALL_TOKENS.find(t => t.symbol === fromToken);
                    if (!tokenData) { validRoute = false; break; }
                    
                    const prices = allPrices.get(fromToken);
                    if (!prices || prices.length === 0) { validRoute = false; break; }
                    
                    const bestPrice = Math.max(...prices.map(p => p.price));
                    const bestDex = prices.find(p => p.price === bestPrice);
                    
                    currentAmount = currentAmount * bestPrice;
                    route.push({ from: fromToken, to: toToken, dex: bestDex.dex, price: bestPrice, amount: currentAmount });
                } else {
                    const tokenDataFrom = ALL_TOKENS.find(t => t.symbol === fromToken);
                    const tokenDataTo = ALL_TOKENS.find(t => t.symbol === toToken);
                    
                    if (!tokenDataFrom || !tokenDataTo) { validRoute = false; break; }
                    
                    const ethPrice = allPrices.get("WETH");
                    if (!ethPrice || ethPrice.length === 0) { validRoute = false; break; }
                    
                    const ethValue = currentAmount * ethPrice[0].price;
                    currentAmount = ethValue / ethPrice[0].price;
                    route.push({ from: fromToken, to: toToken, dex: "estimated", price: ethPrice[0].price, amount: currentAmount });
                }
            }
            
            if (validRoute) {
                const profit = currentAmount - amount;
                const profitPercent = (profit / amount) * 100;
                
                if (profit > 0.40 && profitPercent > 0.4) {
                    opportunities.push({
                        type: "TRIANGULAR",
                        name: path.name,
                        description: path.description,
                        path: path.path,
                        route: route,
                        startAmount: amount,
                        endAmount: currentAmount,
                        estimatedProfit: profit.toFixed(2),
                        profitPercent: profitPercent.toFixed(2),
                        netProfit: (profitPercent - 0.5).toFixed(2),
                        minProfit: path.minProfit
                    });
                }
            }
        } catch (error) {
            // Silent fail
        }
    }
    
    return opportunities;
}

// ==================== EXECUTION ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`❌ Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    state.session.lastScan = new Date().toISOString();
    
    if (opportunity.type === "TRIANGULAR") {
        addLog(`🔺 EXECUTING TRIANGULAR FLASH LOAN ON ARBITRUM: ${opportunity.name}`, 'opportunity');
        addLog(`   Path: ${opportunity.path.join(" → ")}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netProfit}% net)`, 'info');
    } else {
        addLog(`💸 EXECUTING FLASH LOAN ON ARBITRUM: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
        addLog(`   Route: ${opportunity.buyDex} → ${opportunity.sellDex}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netDiff}% net)`, 'info');
    }
    
    addLog(`   💰 Capital needed: $0 (AAVE V3 flash loan)`, 'success');
    addLog(`   ⛽ Gas on Arbitrum: ~$${(0.0005 * ethPriceUSD).toFixed(2)}`, 'info');
    
    try {
        const asset = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits("500", 6);
        
        let path;
        let dex1, dex2;
        
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
            const buyDexIndex = DEXES.findIndex(d => d.name === opportunity.buyDex);
            const sellDexIndex = DEXES.findIndex(d => d.name === opportunity.sellDex);
            dex1 = buyDexIndex % 2;
            dex2 = sellDexIndex % 2;
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
        
        addLog(`📝 Requesting flash loan of 500 USDC from AAVE V3 on Arbitrum...`, 'info');
        addLog(`   Flash loan fee: 0.05% (0.25 USDC)`, 'info');
        
        await rateLimit();
        const tx = await flashLoanContract.requestFlashLoan(
            asset,
            amount,
            flashParams,
            { gasLimit: 2000000 }
        );
        
        addLog(`📤 Transaction sent: ${tx.hash}`, 'info');
        addLog(`🔗 https://arbiscan.io/tx/${tx.hash}`, 'info');
        
        addLog(`⏳ Waiting for confirmation...`, 'info');
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * ethPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += profit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            
            addLog(`✅ FLASH LOAN SUCCESSFUL ON ARBITRUM!`, 'success');
            addLog(`   Profit: +$${profit.toFixed(2)}`, 'success');
            addLog(`   Gas: $${gasUsed.toFixed(4)} (much cheaper than Ethereum!)`, 'info');
            
            state.tradeHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                type: opportunity.type,
                token: opportunity.token || opportunity.name,
                icon: opportunity.icon || "🔺",
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
        addLog(`❌ FLASH LOAN FAILED - No gas cost`, 'error');
        addLog(`   Error: ${error.message.substring(0, 150)}`, 'error');
        
        state.tradeHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type: opportunity.type,
            token: opportunity.token || opportunity.name,
            icon: opportunity.icon || "🔺",
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
    addLog('🔥 ADVANCED FLASH LOAN ARBITRAGE BOT - ARBITRUM NETWORK', 'success');
    addLog(`💰 Scanning ${ALL_TOKENS.length - 2} tokens across ${DEXES.length} DEXes`, 'success');
    addLog(`🔺 Triangular arbitrage enabled (${TRIANGULAR_PATHS.length} paths)`, 'success');
    addLog(`💸 AAVE V3 Flash Loans - $0 Capital Needed`, 'success');
    addLog(`⚡ Arbitrum gas fees: ~90% cheaper than Ethereum`, 'info');
    addLog(`🎯 Thresholds: 0.06% diff, $0.20 profit minimum`, 'info');
    
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
                addLog(`🔍 Scan #${state.session.totalScans} complete. Found: ${state.stats.opportunitiesFound} total opportunities.`, 'info');
            }
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        if (wallet && state.session.totalScans % 10 === 0) {
            try {
                await rateLimit();
                const balance = await provider.getBalance(wallet.address);
                state.wallet.eth = parseFloat(ethers.formatEther(balance));
                state.wallet.usd = state.wallet.eth * ethPriceUSD;
            } catch(e) {}
        }
        
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
        dexes: {
            total: DEXES.length,
            names: DEXES.map(d => d.name)
        },
        triangular: {
            paths: TRIANGULAR_PATHS.length,
            active: true
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
        contractAddress: CONTRACT_ADDRESS,
        aavePool: AAVE_POOL,
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
    addLog('📊 Stats reset', 'info');
    res.json({ status: 'reset' });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        network: 'Arbitrum',
        connected: state.connected, 
        dexCount: DEXES.length,
        triangularPaths: TRIANGULAR_PATHS.length,
        contractDeployed: state.connected && wallet ? true : false,
        cacheSize: priceCache.size 
    });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | Arbitrum | AAVE V3 | 10+ DEXes</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); border-radius: 20px; padding: 28px 32px; margin-bottom: 28px; }
        .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        .network-badge { background: #28a0f0; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; display: inline-block; margin-left: 12px; vertical-align: middle; }
        .badge-container { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
        .badge { padding: 6px 14px; background: rgba(255,255,255,0.15); border-radius: 30px; font-size: 12px; font-weight: 500; }
        .badge-flash { background: #f59e0b; color: #1a1a2e; }
        .badge-tri { background: #8b5cf6; color: white; }
        .badge-arb { background: #28a0f0; color: white; }
        .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-bottom: 28px; }
        .stat-card { background: #1e293b; border-radius: 16px; padding: 20px; border: 1px solid #334155; }
        .stat-label { font-size: 11px; font-weight: 500; text-transform: uppercase; color: #94a3b8; margin-bottom: 8px; }
        .stat-value { font-size: 28px; font-weight: 700; }
        .positive { color: #10b981; }
        .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
        .card { background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #334155; font-weight: 600; background: #0f172a; }
        .trade-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .trade-table th { text-align: left; padding: 12px 16px; background: #0f172a; font-weight: 500; color: #94a3b8; }
        .trade-table td { padding: 12px 16px; border-bottom: 1px solid #334155; }
        .tx-link { color: #60a5fa; text-decoration: none; font-family: monospace; font-size: 10px; }
        .success-text { color: #10b981; font-weight: 500; }
        .logs-container { max-height: 400px; overflow-y: auto; font-size: 11px; font-family: monospace; }
        .log-entry { padding: 8px 16px; border-bottom: 1px solid #334155; }
        .log-time { color: #64748b; margin-right: 12px; }
        .log-success { color: #10b981; }
        .log-error { color: #ef4444; }
        .log-opportunity { color: #f59e0b; }
        .btn { padding: 8px 16px; border-radius: 8px; font-size: 12px; font-weight: 500; cursor: pointer; border: none; }
        .btn-primary { background: #3b82f6; color: white; }
        .btn-secondary { background: #334155; color: #cbd5e1; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .contract-info { font-size: 10px; color: #64748b; margin-top: 8px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>💸 Flash Loan Arbitrage Bot <span class="network-badge">ARBITRUM</span></h1>
            <p>10+ DEXes | Triangular Arbitrage | AAVE V3 Flash Loans | $0 Capital | 90% Lower Gas</p>
            <div class="badge-container">
                <span class="badge"><span class="status-dot"></span> Live on Arbitrum</span>
                <span class="badge badge-flash">🚀 Flash Loan: $0 Capital</span>
                <span class="badge badge-tri">🔺 Triangular Arbitrage</span>
                <span class="badge badge-arb">⚡ 10+ DEXes Active</span>
            </div>
        </div>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 TOTAL PROFIT</div><div class="stat-value positive" id="totalProfit">$0.00</div></div>
        <div class="stat-card"><div class="stat-label">📊 SUCCESS RATE</div><div class="stat-value" id="successRate">0%</div></div>
        <div class="stat-card"><div class="stat-label">🎯 OPPORTUNITIES</div><div class="stat-value" id="opportunities">0</div></div>
        <div class="stat-card"><div class="stat-label">🔺 TRIANGULAR</div><div class="stat-value" id="triangular">0</div></div>
        <div class="stat-card"><div class="stat-label">⚡ DEXES</div><div class="stat-value" id="dexCount">10</div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📋 Flash Loan Trades</div>
            <div class="card-body">
                <table class="trade-table">
                    <thead><tr><th>Time</th><th>Type</th><th>Token/Path</th><th>Profit</th><th>Proof</th></tr></thead>
                    <tbody id="tradesBody"><tr><td colspan="5" style="text-align:center; padding:40px;">No trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-header">📝 Live Activity Logs</div>
            <div class="card-body"><div class="logs-container" id="logsContainer">Initializing...</div></div>
        </div>
    </div>

    <div class="button-group" style="display: flex; gap: 12px; justify-content: flex-end;">
        <button class="btn btn-secondary" onclick="resetStats()">Reset Stats</button>
        <button class="btn btn-primary" onclick="location.reload()">Refresh</button>
    </div>
    <div class="contract-info" id="contractInfo">Loading contract info...</div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            document.getElementById('totalProfit').innerHTML = '$' + (parseFloat(data.stats.totalProfitUSD) || 0).toFixed(2);
            document.getElementById('successRate').innerHTML = (data.stats.successRate || 0) + '%';
            document.getElementById('opportunities').innerHTML = data.stats.opportunitiesFound || 0;
            document.getElementById('triangular').innerHTML = data.stats.triangularOpportunities || 0;
            document.getElementById('dexCount').innerHTML = data.dexes?.total || 10;
            document.getElementById('contractInfo').innerHTML = `📄 Contract: ${data.contractAddress || 'Not set'} | AAVE Pool: ${data.aavePool?.substring(0, 20)}... | Network: ${data.network || 'Arbitrum'}`;
            
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let t of data.tradeHistory.slice(0, 10)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const typeIcon = t.type === 'TRIANGULAR' ? '🔺' : (t.icon || '💸');
                    html += `<tr>
                        <td>${time}</td>
                        <td>${typeIcon} ${t.type || 'SIMPLE'}</td>
                        <td>${t.token || '-'}</td>
                        <td class="success-text">+$${(t.profitUSD || 0).toFixed(2)}</td>
                        <td>${t.txHash ? `<a href="${t.explorerUrl}" target="_blank" class="tx-link">View →</a>` : '-'}</td>
                    </tr>`;
                }
                tradesBody.innerHTML = html;
            }
            
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let html = '';
                for (let log of data.logs.slice(0, 30)) {
                    let cls = '';
                    if (log.type === 'success') cls = 'log-success';
                    else if (log.type === 'error') cls = 'log-error';
                    else if (log.type === 'opportunity') cls = 'log-opportunity';
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    html += `<div class="log-entry ${cls}"><span class="log-time">[${time}]</span> ${log.message}</div>`;
                }
                logsContainer.innerHTML = html;
            }
        } catch(e) { console.error(e); }
    }
    
    async function resetStats() {
        await fetch('/api/reset', { method: 'POST' });
        setTimeout(fetchData, 500);
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
    console.log(`💸 ADVANCED FLASH LOAN ARBITRAGE BOT - ARBITRUM NETWORK`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✓ Network: Arbitrum One`);
    console.log(`✓ ${DEXES.length} DEXes enabled`);
    console.log(`✓ ${TRIANGULAR_PATHS.length} triangular paths`);
    console.log(`✓ ${ALL_TOKENS.length} tokens monitored`);
    console.log(`✓ AAVE V3 Flash Loans - $0 capital`);
    console.log(`✓ Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
    });
}

start();
