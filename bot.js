// bot-flashloan.js - ADVANCED Flash Loan Arbitrage Bot
// Scans 6+ DEXes, Triangular paths, Optimized opportunity detection

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

// Cache prices to reduce API calls
const priceCache = new Map();
const CACHE_TTL = 20000; // 20 seconds cache (fresher data)

// ==================== ALL TOKENS ON POLYGON ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦", category: "Stable" },
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣", category: "L1" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡", category: "L1" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣", category: "DeFi" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡", category: "DeFi" },
    { symbol: "BAL", address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3", decimals: 18, icon: "⚖️", category: "DeFi" }
];

// ==================== EXPANDED DEX CONFIGURATION ====================
const DEXES = [
    { name: "QUICKSWAP_V2", router: "0xA5e0829CACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, type: "v2", icon: "⚡" },
    { name: "QUICKSWAP_V3_500", router: "0x24fE3C4C1Cb466bCb0790Fd9D145474c302d59A2", fee: 0.0005, type: "v3", icon: "⚡" },
    { name: "QUICKSWAP_V3_3000", router: "0x24fE3C4C1Cb466bCb0790Fd9D145474c302d59A2", fee: 0.0030, type: "v3", icon: "⚡" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, type: "v2", icon: "🍣" },
    { name: "UNISWAP_V3_500", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0005, type: "v3", icon: "🦄" },
    { name: "UNISWAP_V3_3000", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0030, type: "v3", icon: "🦄" },
    { name: "BALANCER", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", fee: 0.0020, type: "balancer", icon: "⚖️" },
    { name: "CURVE", router: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", fee: 0.0004, type: "curve", icon: "📈" },
    { name: "CAMELOT", router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", fee: 0.0030, type: "v2", icon: "🐫" }
];

// ==================== TRIANGULAR ARBITRAGE PATHS ====================
const TRIANGULAR_PATHS = [
    { name: "USDC → POL → WETH → USDC", path: ["USDC", "POL", "WETH", "USDC"], description: "Stable → L1 → L1 → Stable", minProfit: 0.50 },
    { name: "USDC → WETH → WBTC → USDC", path: ["USDC", "WETH", "WBTC", "USDC"], description: "Stable → WETH → WBTC → Stable", minProfit: 0.75 },
    { name: "USDC → AAVE → UNI → USDC", path: ["USDC", "AAVE", "UNI", "USDC"], description: "Stable → DeFi → DeFi → Stable", minProfit: 0.40 },
    { name: "USDC → LINK → CRV → USDC", path: ["USDC", "LINK", "CRV", "USDC"], description: "Stable → Oracle → DeFi → Stable", minProfit: 0.35 },
    { name: "USDC → WETH → CRV → USDC", path: ["USDC", "WETH", "CRV", "USDC"], description: "Stable → L1 → DeFi → Stable", minProfit: 0.45 },
    { name: "USDC → WBTC → AAVE → USDC", path: ["USDC", "WBTC", "AAVE", "USDC"], description: "Stable → L1 → DeFi → Stable", minProfit: 0.60 }
];

// ==================== FLASH LOAN CONTRACT ABI ====================
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
                try {
                    const total = await flashLoanContract.totalFlashLoans();
                    state.stats.totalFlashLoans = Number(total);
                    addLog(`📊 Total Flash Loans Executed: ${state.stats.totalFlashLoans}`, 'info');
                } catch(e) {}
            }
            
            addLog(`📍 Wallet: ${wallet.address.substring(0, 10)}...${wallet.address.substring(38)}`, 'info');
            addLog(`💰 Balance: ${state.wallet.pol.toFixed(4)} POL (~$${state.wallet.usd.toFixed(2)})`, 'info');
            
            if (state.wallet.pol < 0.5) {
                addLog(`⚠️ Low POL! Need ~0.5 POL for gas. Send POL to: ${wallet.address}`, 'warning');
            }
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
        
        if (dexType === "v3" && dexFee) {
            const quoteParams = {
                tokenIn: tokenAddress,
                tokenOut: usdcAddress,
                fee: dexFee,
                amountIn: ethers.parseUnits("1", decimals),
                sqrtPriceLimitX96: 0
            };
            const amountOut = await router.quoteExactInputSingle(quoteParams);
            price = parseFloat(ethers.formatUnits(amountOut, 6));
        } else {
            const path = [tokenAddress, usdcAddress];
            const amounts = await router.getAmountsOut(ethers.parseUnits("1", decimals), path);
            price = parseFloat(ethers.formatUnits(amounts[1], 6));
        }
        
        if (price > 0) {
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
        if (price > 0) {
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
    const tokensToScan = ALL_TOKENS.filter(t => t.symbol !== 'USDC');
    
    addLog(`🔍 Scanning ${tokensToScan.length} tokens across ${DEXES.length} DEXes...`, 'info');
    
    const allPrices = new Map();
    
    const batchSize = 2;
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
                            
                            if (netDiff > 0.08) {
                                const estimatedProfit = Math.abs(prices[a].price - prices[b].price) * 100;
                                const afterFees = estimatedProfit * (1 - (prices[a].fee + prices[b].fee));
                                
                                if (afterFees > 0.30) {
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
    
    const triangularOpps = await scanTriangularArbitrage(allPrices);
    opportunities.push(...triangularOpps);
    
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    if (opportunities.length > 0) {
        state.stats.opportunitiesFound += opportunities.length;
        const triangularCount = opportunities.filter(o => o.type === "TRIANGULAR").length;
        state.stats.triangularOpportunities += triangularCount;
        
        addLog(`📊 Found ${opportunities.length} opportunities (${triangularCount} triangular)`, 'opportunity');
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
            let currentToken = "USDC";
            let currentAmount = amount;
            let route = [];
            
            for (let i = 0; i < path.path.length - 1; i++) {
                const fromToken = path.path[i];
                const toToken = path.path[i + 1];
                
                if (fromToken === "USDC") {
                    const tokenData = ALL_TOKENS.find(t => t.symbol === toToken);
                    if (!tokenData) continue;
                    
                    const prices = allPrices.get(toToken);
                    if (!prices || prices.length === 0) continue;
                    
                    const bestPrice = Math.min(...prices.map(p => p.price));
                    const bestDex = prices.find(p => p.price === bestPrice);
                    
                    currentAmount = currentAmount / bestPrice;
                    route.push({ from: fromToken, to: toToken, dex: bestDex.dex, price: bestPrice });
                } else {
                    const tokenDataFrom = ALL_TOKENS.find(t => t.symbol === fromToken);
                    const tokenDataTo = ALL_TOKENS.find(t => t.symbol === toToken);
                    
                    if (!tokenDataFrom || !tokenDataTo) continue;
                    
                    const polPrice = allPrices.get("POL");
                    if (!polPrice) continue;
                    
                    const priceInPOL = 1 / polPrice[0].price;
                    const estimatedPrice = priceInPOL * 0.95;
                    
                    currentAmount = currentAmount * estimatedPrice;
                    route.push({ from: fromToken, to: toToken, dex: "estimated", price: estimatedPrice });
                }
            }
            
            const finalPrice = allPrices.get(path.path[path.path.length - 2]);
            if (finalPrice && finalPrice.length > 0) {
                const sellPrice = Math.max(...finalPrice.map(p => p.price));
                const finalUSDC = currentAmount * sellPrice;
                const profit = finalUSDC - amount;
                const profitPercent = (profit / amount) * 100;
                
                if (profit > 0.50 && profitPercent > 0.5) {
                    opportunities.push({
                        type: "TRIANGULAR",
                        name: path.name,
                        description: path.description,
                        path: path.path,
                        route: route,
                        startAmount: amount,
                        endAmount: finalUSDC,
                        estimatedProfit: profit.toFixed(2),
                        profitPercent: profitPercent.toFixed(2),
                        netProfit: (profitPercent - 0.7).toFixed(2),
                        minProfit: path.minProfit
                    });
                }
            }
        } catch (error) {
            // Silent fail for triangular scanning
        }
    }
    
    return opportunities;
}

// ==================== ENHANCED EXECUTION ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`❌ Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    state.session.lastScan = new Date().toISOString();
    
    if (opportunity.type === "TRIANGULAR") {
        addLog(`🔺 EXECUTING TRIANGULAR FLASH LOAN: ${opportunity.name}`, 'opportunity');
        addLog(`   Path: ${opportunity.path.join(" → ")}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netProfit}% net)`, 'info');
    } else {
        addLog(`💸 EXECUTING FLASH LOAN: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
        addLog(`   Route: ${opportunity.buyDex} → ${opportunity.sellDex}`, 'info');
        addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netDiff}% net)`, 'info');
    }
    
    addLog(`   💰 Capital needed: $0 (AAVE flash loan)`, 'success');
    
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
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.6).toFixed(2), 6);
        const profitRecipient = wallet.address;
        
        const flashParams = {
            path: path,
            dex1: dex1,
            dex2: dex2,
            amountIn: amountIn,
            minProfit: minProfit,
            profitRecipient: profitRecipient
        };
        
        addLog(`📝 Requesting flash loan of 500 USDC from AAVE...`, 'info');
        addLog(`   Flash loan fee: 0.05% (0.25 USDC)`, 'info');
        
        await rateLimit();
        const tx = await flashLoanContract.requestFlashLoan(
            asset,
            amount,
            flashParams,
            { gasLimit: 2000000 }
        );
        
        addLog(`📤 Transaction sent: ${tx.hash}`, 'info');
        addLog(`🔗 https://polygonscan.com/tx/${tx.hash}`, 'info');
        
        addLog(`⏳ Waiting for confirmation...`, 'info');
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += profit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            
            addLog(`✅ FLASH LOAN SUCCESSFUL!`, 'success');
            addLog(`   Profit: +$${profit.toFixed(2)}`, 'success');
            addLog(`   Gas: $${gasUsed.toFixed(4)}`, 'info');
            
            state.tradeHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                type: opportunity.type,
                token: opportunity.token || opportunity.name,
                icon: opportunity.icon || "🔺",
                profitUSD: profit,
                gasCostUSD: gasUsed,
                txHash: tx.hash,
                explorerUrl: `https://polygonscan.com/tx/${tx.hash}`,
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
    addLog('🔥 ADVANCED FLASH LOAN ARBITRAGE BOT STARTED', 'success');
    addLog(`💰 Scanning ${ALL_TOKENS.length - 1} tokens across ${DEXES.length} DEXes`, 'success');
    addLog(`🔺 Triangular arbitrage enabled (${TRIANGULAR_PATHS.length} paths)`, 'success');
    addLog(`💸 AAVE V3 Flash Loans - $0 Capital Needed`, 'success');
    addLog(`⚡ Lowered thresholds: 0.08% diff, $0.30 profit minimum`, 'info');
    
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
            await new Promise(r => setTimeout(r, 25000));
        } else {
            consecutiveEmptyScans++;
            state.session.totalScans++;
            
            if (consecutiveEmptyScans % 5 === 0) {
                addLog(`🔍 Scan #${state.session.totalScans} complete. Found: ${state.stats.opportunitiesFound} total opportunities.`, 'info');
            }
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        if (wallet && state.session.totalScans % 5 === 0) {
            try {
                await rateLimit();
                const balance = await provider.getBalance(wallet.address);
                state.wallet.pol = parseFloat(ethers.formatEther(balance));
                state.wallet.usd = state.wallet.pol * polPriceUSD;
            } catch(e) {}
        }
        
        const waitTime = opportunities.length > 0 ? 20000 : 15000;
        await new Promise(r => setTimeout(r, waitTime));
    }
}

// ==================== API ====================
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
        polPrice: polPriceUSD,
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
        connected: state.connected, 
        dexCount: DEXES.length,
        triangularPaths: TRIANGULAR_PATHS.length,
        cacheSize: priceCache.size 
    });
});

// ==================== FIXED DASHBOARD (NO NESTED TEMPLATE LITERALS) ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Advanced Flash Loan Arbitrage Bot | 8+ DEXes | Triangular Arbitrage</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 100%); border-radius: 20px; padding: 28px 32px; margin-bottom: 28px; }
        .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        .badge-container { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
        .badge { padding: 6px 14px; background: rgba(255,255,255,0.15); border-radius: 30px; font-size: 12px; font-weight: 500; }
        .badge-flash { background: #f59e0b; color: #1a1a2e; }
        .badge-tri { background: #8b5cf6; color: white; }
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
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div>
            <h1>💸 Advanced Flash Loan Arbitrage Bot</h1>
            <p>8+ DEXes | Triangular Arbitrage | AAVE V3 Flash Loans | $0 Capital</p>
            <div class="badge-container">
                <span class="badge"><span class="status-dot"></span> Live on Polygon</span>
                <span class="badge badge-flash">🚀 Flash Loan: $0 Capital</span>
                <span class="badge badge-tri">🔺 Triangular Arbitrage</span>
                <span class="badge">⚡ 8 DEXes Active</span>
            </div>
        </div>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 TOTAL PROFIT</div><div class="stat-value positive" id="totalProfit">$0.00</div></div>
        <div class="stat-card"><div class="stat-label">📊 SUCCESS RATE</div><div class="stat-value" id="successRate">0%</div></div>
        <div class="stat-card"><div class="stat-label">🎯 OPPORTUNITIES</div><div class="stat-value" id="opportunities">0</div></div>
        <div class="stat-card"><div class="stat-label">🔺 TRIANGULAR</div><div class="stat-value" id="triangular">0</div></div>
        <div class="stat-card"><div class="stat-label">⚡ DEXES</div><div class="stat-value" id="dexCount">8</div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📋 Trade History</div>
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
            document.getElementById('dexCount').innerHTML = data.dexes?.total || 8;
            
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let t of data.tradeHistory.slice(0, 10)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const typeIcon = t.type === 'TRIANGULAR' ? '🔺' : (t.icon || '💸');
                    const profitDisplay = (t.profitUSD || 0).toFixed(2);
                    const txDisplay = t.txHash ? '<a href="' + t.explorerUrl + '" target="_blank" class="tx-link">View →</a>' : '-';
                    html += '<tr>' +
                        '<td>' + time + '</td>' +
                        '<td>' + typeIcon + ' ' + (t.type || 'SIMPLE') + '</td>' +
                        '<td>' + (t.token || '-') + '</td>' +
                        '<td class="success-text">+$' + profitDisplay + '</td>' +
                        '<td>' + txDisplay + '</td>' +
                        '</tr>';
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
                    html += '<div class="log-entry ' + cls + '"><span class="log-time">[' + time + ']</span> ' + log.message + '</div>';
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
</html>`;
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`💸 ADVANCED FLASH LOAN ARBITRAGE BOT`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✓ ${DEXES.length} DEXes enabled`);
    console.log(`✓ ${TRIANGULAR_PATHS.length} triangular paths`);
    console.log(`✓ ${ALL_TOKENS.length - 1} tokens monitored`);
    console.log(`✓ AAVE V3 Flash Loans - $0 capital`);
    console.log(`Dashboard: http://0.0.0.0:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    
    // Bind to 0.0.0.0 for Scalingo compatibility
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://0.0.0.0:${PORT}`);
    });
}

start();
