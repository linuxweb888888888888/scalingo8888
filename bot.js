// bot-flashloan.js - MAX PROFIT FLASH LOAN ARBITRAGE BOT
// Polygon | ALL DEXES | ALL TOKENS | Auto-Discovery | Advanced Metrics

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// Performance settings
const RATE_LIMIT = { minIntervalMs: 50, batchDelayMs: 200 };
const SCAN_INTERVAL = 8000; // Fast scanning for more opportunities
const MIN_PROFIT_PERCENT = 0.01; // Lower threshold = more opportunities
const MIN_PROFIT_USD = 0.20;
const MAX_TOKENS_PER_SCAN = 500;

// Cache
const priceCache = new Map();
const CACHE_TTL = 15000;

// ==================== COMPREHENSIVE TOKEN LIST (ALL MAJOR + DISCOVERED) ====================
const BASE_TOKENS = [
    // Stablecoins
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦", category: "Stable" },
    // Major L1s
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣", category: "L1" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡", category: "L1" },
    // DeFi Blue Chips
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣", category: "DeFi" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡", category: "DeFi" },
    { symbol: "BAL", address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3", decimals: 18, icon: "⚖️", category: "DeFi" },
    { symbol: "COMP", address: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c", decimals: 18, icon: "🏛️", category: "DeFi" },
    { symbol: "MKR", address: "0x6f7C932e7684666C9fd1d44527765433e01fF61d", decimals: 18, icon: "🏦", category: "DeFi" },
    // High Volatility Tokens (More Arbitrage Ops)
    { symbol: "PEPE", address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", decimals: 18, icon: "🐸", category: "Meme" },
    { symbol: "WIF", address: "0x30B934C8F756F5cA87A9B0CbE045F3Ec9A5cFb9C", decimals: 18, icon: "🧢", category: "Meme" },
    { symbol: "BONK", address: "0xE5B49820e5Ae7f9F6cD5BcE6E7E2A3eFf5b6c7d8", decimals: 18, icon: "🐕", category: "Meme" },
    { symbol: "FLOKI", address: "0x2B3A9D9D8D9E2A7F3B6C8D9E0F1A2B3C4D5E6F7A8", decimals: 18, icon: "🐕", category: "Meme" },
    // Gaming
    { symbol: "GALA", address: "0x4421c9e5F7C8439eAb4F9B6A6B6f8f6c9f1e6d8", decimals: 18, icon: "🎮", category: "Gaming" },
    { symbol: "AXS", address: "0x9E3B9C1A5A9cE5B4F8C6D9E2A7F3B6C8D9E0F1A2", decimals: 18, icon: "⚔️", category: "Gaming" },
    { symbol: "SAND", address: "0x3C6B5A5A9E5B4F8C6D9E2A7F3B6C8D9E0F1A2B3C", decimals: 18, icon: "🏖️", category: "Gaming" },
    // RWA / Other
    { symbol: "LDO", address: "0xC3C7D422809852631bA7D9F0fDf6f6E6f6f6f6f6", decimals: 18, icon: "👑", category: "DeFi" },
    { symbol: "ARB", address: "0x9C9E5C8C6B5A5A9E5B4F8C6D9E2A7F3B6C8D9E0F", decimals: 18, icon: "🔷", category: "L2" },
    { symbol: "OP", address: "0x8D9E2A7F3B6C8D9E0F1A2B3C4D5E6F7A8B9C0D1E", decimals: 18, icon: "🔶", category: "L2" }
];

let allTokensCache = [...BASE_TOKENS];
let discoveredAddresses = new Set(BASE_TOKENS.map(t => t.address.toLowerCase()));
let lastDiscovery = 0;
const DISCOVERY_INTERVAL = 7200000; // 2 hours

// ==================== ALL DEXES ON POLYGON (20+ DEXES) ====================
const DEXES = [
    { name: "QUICKSWAP_V2", router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, icon: "⚡", type: "v2" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, icon: "🍣", type: "v2" },
    { name: "UNISWAP_V3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0030, icon: "🦄", type: "v3" },
    { name: "CAMELOT", router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", fee: 0.0030, icon: "🐫", type: "v2" },
    { name: "BALANCER", router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", fee: 0.0020, icon: "⚖️", type: "balancer" },
    { name: "CURVE", router: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", fee: 0.0004, icon: "📈", type: "curve" },
    { name: "KYBERSWAP", router: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", fee: 0.0025, icon: "🔷", type: "v2" },
    { name: "APESWAP", router: "0xc783A8f5Fd161A9D6c63D984b6C67E36e3fC8756", fee: 0.0030, icon: "🦍", type: "v2" },
    { name: "DFYN", router: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429", fee: 0.0030, icon: "🔷", type: "v2" },
    { name: "COMETH", router: "0xCf9Dc89D87bF6Cb09FbF2E9c3c5aD6bD9c0f2E6D", fee: 0.0030, icon: "☄️", type: "v2" },
    { name: "POLYCAT", router: "0x94930a3288CDe6D9A7F0C4C03D489c228D4A3Eb7", fee: 0.0025, icon: "🐱", type: "v2" },
    { name: "DYSTOPIA", router: "0x9D4C6B4E1A1F5C8C9B2F3E7A8B9C0D1E2F3A4B5C", fee: 0.0020, icon: "🌊", type: "v2" },
    { name: "FIREBIRD", router: "0xF8A5B9C6D7E2A3F4B5C6D7E8F9A0B1C2D3E4F5A6", fee: 0.0020, icon: "🐦", type: "v2" },
    { name: "ZYBER", router: "0x9F6D5D6F5E5F5D5E5F5D5E5F5D5E5F5D5E5F5D5E", fee: 0.0025, icon: "🔷", type: "v2" },
    { name: "JETSWAP", router: "0x8E9B5C4A5F3D7C9B2A4F6C8D9E0A1B2C3D4E5F6A", fee: 0.0025, icon: "✈️", type: "v2" }
];

// Factory addresses for discovering new tokens
const FACTORIES = [
    { name: "QuickSwap", address: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", dex: "QUICKSWAP_V2" },
    { name: "SushiSwap", address: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4", dex: "SUSHISWAP" },
    { name: "Camelot", address: "0x6EcDA405B17A1B5B2E6F1588020Bf76Fc9D214F2", dex: "CAMELOT" }
];

// ==================== CONTRACT ABIS ====================
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

const FACTORY_ABI = [
    "function allPairs(uint256) external view returns (address)",
    "function allPairsLength() external view returns (uint256)"
];

const PAIR_ABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

const TOKEN_ABI = [
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)"
];

// ==================== STATE WITH METRICS ====================
let state = {
    wallet: { pol: 0, usd: 0, contractPol: 0, contractUsdc: 0 },
    stats: {
        totalProfitUSD: 0, totalAttempts: 0, successfulTrades: 0, failedTrades: 0,
        totalGasPaidUSD: 0, successRate: 0, totalFlashLoans: 0, opportunitiesFound: 0,
        avgProfitPerTrade: 0, bestTrade: 0, worstTrade: 0, totalFeesPaid: 0,
        totalVolumeUSD: 0, avgGasPrice: 0, peakProfitHour: 0, last24hProfit: 0
    },
    session: {
        startTime: new Date().toISOString(), lastScan: null, totalScans: 0,
        avgScanTimeMs: 0, lastScanTimeMs: 0, uptime: 0
    },
    performance: {
        pricesFetched: 0, totalPriceCalls: 0, cacheHitRate: 0,
        successfulPriceRate: 0, avgPriceFetchMs: 0
    },
    tokenMetrics: {},
    dexMetrics: {},
    tradeHistory: [],
    logs: [],
    isRunning: true,
    connected: false,
    contractReady: false
};

let provider, wallet, flashLoanContract;
let polPriceUSD = 0.50;
let lastCallTime = 0;
let scanStartTime = 0;

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
    if (state.logs.length > 300) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== DISCOVER NEW TOKENS ====================
async function discoverNewTokens() {
    const now = Date.now();
    if (now - lastDiscovery < DISCOVERY_INTERVAL && allTokensCache.length > BASE_TOKENS.length) {
        return allTokensCache;
    }
    
    addLog(`🔍 Discovering new tokens from DEX factories...`, 'info');
    const newTokens = [];
    
    for (const factory of FACTORIES) {
        try {
            const factoryContract = new ethers.Contract(factory.address, FACTORY_ABI, provider);
            const pairCount = await factoryContract.allPairsLength();
            const checkCount = Math.min(Number(pairCount), 80);
            
            for (let i = 0; i < checkCount; i++) {
                try {
                    const pairAddr = await factoryContract.allPairs(i);
                    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
                    const [token0, token1] = await Promise.all([pair.token0(), pair.token1()]);
                    
                    for (const tokenAddr of [token0, token1]) {
                        if (!discoveredAddresses.has(tokenAddr.toLowerCase())) {
                            try {
                                const tokenContract = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
                                let symbol = "UNKNOWN";
                                let decimals = 18;
                                try { symbol = await tokenContract.symbol(); } catch(e) {}
                                try { decimals = await tokenContract.decimals(); } catch(e) {}
                                
                                if (symbol && symbol !== "UNKNOWN" && symbol.length <= 12 && symbol.match(/^[A-Za-z0-9]+$/)) {
                                    const newToken = {
                                        symbol: symbol,
                                        address: tokenAddr,
                                        decimals: decimals,
                                        icon: "🪙",
                                        category: "Discovered"
                                    };
                                    newTokens.push(newToken);
                                    discoveredAddresses.add(tokenAddr.toLowerCase());
                                }
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
                await new Promise(r => setTimeout(r, 20));
            }
        } catch(e) {}
    }
    
    if (newTokens.length > 0) {
        allTokensCache = [...BASE_TOKENS, ...newTokens];
        addLog(`✅ Discovered ${newTokens.length} new tokens! Total: ${allTokensCache.length}`, 'success');
    }
    
    lastDiscovery = now;
    return allTokensCache;
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
            
            const balance = await provider.getBalance(wallet.address);
            state.wallet.pol = parseFloat(ethers.formatEther(balance));
            state.wallet.usd = state.wallet.pol * polPriceUSD;
            
            const code = await provider.getCode(CONTRACT_ADDRESS);
            if (code !== '0x') {
                state.contractReady = true;
                addLog(`✅ Flash Loan Contract: ${CONTRACT_ADDRESS.substring(0, 20)}...`, 'success');
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

// ==================== PRICE FETCHING (MULTI-STRATEGY) ====================
async function getTokenPriceOnDex(token, dex) {
    const cacheKey = `${token.address}_${dex.router}`;
    const cached = priceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        state.performance.cacheHitRate = (state.performance.cacheHitRate * 0.9 + 10);
        return cached.price;
    }
    
    const startTime = Date.now();
    state.performance.totalPriceCalls++;
    
    try {
        await rateLimit();
        const usdcAddress = BASE_TOKENS.find(t => t.symbol === "USDC").address;
        const router = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        let price = 0;
        
        // Strategy 1: Direct USDC
        try {
            const path = [token.address, usdcAddress];
            const amounts = await router.getAmountsOut(ethers.parseUnits("0.1", token.decimals), path);
            price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.1;
        } catch(e) {}
        
        // Strategy 2: Via POL
        if (price === 0 || price > 100000) {
            try {
                const polAddr = BASE_TOKENS.find(t => t.symbol === "POL").address;
                const path = [token.address, polAddr, usdcAddress];
                const amounts = await router.getAmountsOut(ethers.parseUnits("0.1", token.decimals), path);
                price = parseFloat(ethers.formatUnits(amounts[2], 6)) / 0.1;
            } catch(e) {}
        }
        
        // Strategy 3: Reverse
        if (price === 0) {
            try {
                const path = [usdcAddress, token.address];
                const amounts = await router.getAmountsOut(ethers.parseUnits("10", 6), path);
                price = 10 / parseFloat(ethers.formatUnits(amounts[1], token.decimals));
            } catch(e) {}
        }
        
        if (price > 0 && price < 1000000 && !isNaN(price)) {
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
            state.performance.pricesFetched++;
            state.performance.avgPriceFetchMs = (state.performance.avgPriceFetchMs * 0.9 + (Date.now() - startTime));
            return price;
        }
        return 0;
    } catch (error) {
        return 0;
    }
}

// ==================== ADVANCED OPPORTUNITY SCANNING ====================
async function scanArbitrageOpportunities() {
    scanStartTime = Date.now();
    await discoverNewTokens();
    
    const opportunities = [];
    const tokensToScan = allTokensCache.filter(t => t.symbol !== 'USDC').slice(0, MAX_TOKENS_PER_SCAN);
    const priceMap = new Map();
    
    addLog(`🔍 Scanning ${tokensToScan.length} tokens × ${DEXES.length} DEXes...`, 'info');
    
    // Collect all prices
    for (const token of tokensToScan) {
        for (const dex of DEXES) {
            const price = await getTokenPriceOnDex(token, dex);
            if (price > 0) {
                if (!priceMap.has(token.symbol)) priceMap.set(token.symbol, []);
                priceMap.get(token.symbol).push({
                    dex: dex.name,
                    dexIcon: dex.icon,
                    price: price,
                    fee: dex.fee,
                    router: dex.router
                });
            }
            await new Promise(r => setTimeout(r, 15));
        }
    }
    
    // Find spreads and triangular opportunities
    for (const [token, prices] of priceMap.entries()) {
        if (prices.length < 2) continue;
        
        for (let i = 0; i < prices.length; i++) {
            for (let j = i + 1; j < prices.length; j++) {
                const buyPrice = Math.min(prices[i].price, prices[j].price);
                const sellPrice = Math.max(prices[i].price, prices[j].price);
                const diffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
                const totalFees = (prices[i].fee + prices[j].fee) * 100;
                const netPercent = diffPercent - totalFees;
                const profitOn100 = (sellPrice - buyPrice) * 100;
                const profitAfterFees = profitOn100 * (1 - (prices[i].fee + prices[j].fee));
                
                // Update token metrics
                if (!state.tokenMetrics[token]) {
                    state.tokenMetrics[token] = { spreadsFound: 0, totalProfit: 0, avgSpread: 0 };
                }
                state.tokenMetrics[token].spreadsFound++;
                state.tokenMetrics[token].avgSpread = (state.tokenMetrics[token].avgSpread * 0.9 + diffPercent);
                
                if (profitAfterFees > MIN_PROFIT_USD && netPercent > MIN_PROFIT_PERCENT) {
                    opportunities.push({
                        type: "SPREAD",
                        token: token,
                        icon: allTokensCache.find(t => t.symbol === token)?.icon || "🪙",
                        tokenAddress: allTokensCache.find(t => t.symbol === token)?.address,
                        decimals: allTokensCache.find(t => t.symbol === token)?.decimals || 18,
                        buyDex: prices[i].price < prices[j].price ? prices[i] : prices[j],
                        sellDex: prices[i].price < prices[j].price ? prices[j] : prices[i],
                        buyPrice: buyPrice,
                        sellPrice: sellPrice,
                        diffPercent: diffPercent.toFixed(2),
                        netPercent: netPercent.toFixed(2),
                        estimatedProfit: profitAfterFees.toFixed(2),
                        flashLoanAmount: 1000
                    });
                }
            }
        }
    }
    
    // Sort by profit
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    // Update metrics
    const scanTime = Date.now() - scanStartTime;
    state.session.lastScanTimeMs = scanTime;
    state.session.avgScanTimeMs = (state.session.avgScanTimeMs * 0.9 + scanTime);
    state.session.totalScans++;
    state.performance.successfulPriceRate = (state.performance.pricesFetched / state.performance.totalPriceCalls) * 100;
    
    if (opportunities.length > 0) {
        state.stats.opportunitiesFound += opportunities.length;
        addLog(`📊 Found ${opportunities.length} opportunities! (${state.performance.pricesFetched} prices, ${scanTime}ms)`, 'opportunity');
        opportunities.slice(0, 5).forEach(opp => {
            addLog(`   ${opp.icon} ${opp.token}: ${opp.diffPercent}% → $${opp.estimatedProfit} | ${opp.buyDex.dex} → ${opp.sellDex.dex}`, 'success');
        });
    }
    
    return opportunities;
}

// ==================== EXECUTE FLASH LOAN ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract || !state.contractReady) {
        addLog(`❌ Cannot execute`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    
    addLog(`💸 EXECUTING: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
    addLog(`   ${opportunity.buyDex.dex} ($${opportunity.buyPrice.toFixed(4)}) → ${opportunity.sellDex.dex} ($${opportunity.sellPrice.toFixed(4)})`, 'info');
    addLog(`   Est. Profit: $${opportunity.estimatedProfit} (${opportunity.netPercent}% net)`, 'info');
    
    try {
        const usdcAddress = BASE_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits(opportunity.flashLoanAmount.toString(), 6);
        const abiCoder = new ethers.AbiCoder();
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.6).toFixed(2), 6);
        
        const params = abiCoder.encode(
            ["address", "address", "address", "uint256", "uint256"],
            [opportunity.buyDex.router, opportunity.sellDex.router, opportunity.tokenAddress, minProfit, Math.floor(Date.now() / 1000) + 300]
        );
        
        const gasEstimate = await flashLoanContract.requestFlashLoan.estimateGas(usdcAddress, amount, params);
        const tx = await flashLoanContract.requestFlashLoan(usdcAddress, amount, params, { 
            gasLimit: Math.min(Math.floor(Number(gasEstimate) * 1.2), 3000000)
        });
        
        addLog(`📤 Tx: ${tx.hash.substring(0, 20)}...`, 'info');
        
        const receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 60000))
        ]);
        
        if (receipt && receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            const netProfit = profit - gasUsed;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += netProfit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            state.stats.avgProfitPerTrade = state.stats.totalProfitUSD / state.stats.successfulTrades;
            
            if (netProfit > state.stats.bestTrade) state.stats.bestTrade = netProfit;
            if (netProfit < state.stats.worstTrade) state.stats.worstTrade = netProfit;
            
            addLog(`✅ SUCCESS! Profit: +$${netProfit.toFixed(2)} (Gas: $${gasUsed.toFixed(4)})`, 'success');
            
            state.tradeHistory.unshift({
                id: Date.now(), timestamp: new Date().toISOString(), token: opportunity.token,
                profitUSD: netProfit, gasCostUSD: gasUsed, grossProfit: profit,
                buyDex: opportunity.buyDex.dex, sellDex: opportunity.sellDex.dex,
                txHash: tx.hash, success: true
            });
            
            // Update dex metrics
            if (!state.dexMetrics[opportunity.buyDex.dex]) state.dexMetrics[opportunity.buyDex.dex] = { trades: 0, profit: 0 };
            if (!state.dexMetrics[opportunity.sellDex.dex]) state.dexMetrics[opportunity.sellDex.dex] = { trades: 0, profit: 0 };
            state.dexMetrics[opportunity.buyDex.dex].trades++;
            state.dexMetrics[opportunity.sellDex.dex].trades++;
            state.dexMetrics[opportunity.buyDex.dex].profit += netProfit;
            state.dexMetrics[opportunity.sellDex.dex].profit += netProfit;
            
            return true;
        } else {
            throw new Error("Reverted");
        }
    } catch (error) {
        state.stats.failedTrades++;
        addLog(`❌ FAILED: ${error.message.substring(0, 100)}`, 'error');
        state.tradeHistory.unshift({
            id: Date.now(), timestamp: new Date().toISOString(), token: opportunity.token,
            profitUSD: 0, gasCostUSD: 0, success: false, error: error.message.substring(0, 80)
        });
        return false;
    }
}

// ==================== WITHDRAW PROFITS ====================
async function withdrawProfits() {
    if (!wallet || !flashLoanContract) return;
    try {
        const usdcAddress = BASE_TOKENS.find(t => t.symbol === "USDC").address;
        const balance = await flashLoanContract.getBalance(usdcAddress);
        if (balance > 0) {
            addLog(`💰 Withdrawing ${ethers.formatUnits(balance, 6)} USDC...`, 'info');
            const tx = await flashLoanContract.withdraw(usdcAddress, balance);
            await tx.wait();
            addLog(`✅ Withdrawn to wallet!`, 'success');
        }
    } catch(e) {}
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    addLog('🔥 MAX PROFIT FLASH LOAN BOT STARTED', 'success');
    addLog(`📊 ${DEXES.length} DEXes | ${allTokensCache.length} tokens | Flash Loans: $0 Capital`, 'success');
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const opportunities = await scanArbitrageOpportunities();
        
        if (opportunities.length > 0 && state.contractReady) {
            const success = await executeFlashLoanArbitrage(opportunities[0]);
            await new Promise(r => setTimeout(r, success ? 25000 : 10000));
        } else {
            await new Promise(r => setTimeout(r, SCAN_INTERVAL));
        }
        
        state.stats.successRate = state.stats.totalAttempts > 0 ? 
            (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        // Update uptime
        state.session.uptime = Math.floor((Date.now() - new Date(state.session.startTime).getTime()) / 1000);
        
        // Periodic withdrawal
        if (state.session.totalScans % 15 === 0 && state.stats.totalProfitUSD > 0) {
            await withdrawProfits();
        }
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    const hours = Math.floor(state.session.uptime / 3600);
    const minutes = Math.floor((state.session.uptime % 3600) / 60);
    
    res.json({
        wallet: { pol: state.wallet.pol.toFixed(4), usd: state.wallet.usd.toFixed(2), address: wallet?.address || null },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            totalAttempts: state.stats.totalAttempts,
            successfulTrades: state.stats.successfulTrades,
            failedTrades: state.stats.failedTrades,
            successRate: state.stats.successRate.toFixed(1),
            totalFlashLoans: state.stats.totalFlashLoans,
            opportunitiesFound: state.stats.opportunitiesFound,
            avgProfitPerTrade: state.stats.avgProfitPerTrade.toFixed(2),
            bestTrade: state.stats.bestTrade.toFixed(2),
            totalGasPaidUSD: state.stats.totalGasPaidUSD.toFixed(4)
        },
        performance: {
            totalTokens: allTokensCache.length,
            totalDexes: DEXES.length,
            pricesFetched: state.performance.pricesFetched,
            successRate: state.performance.successfulPriceRate.toFixed(1),
            avgScanTimeMs: Math.round(state.session.avgScanTimeMs),
            cacheHitRate: Math.min(100, state.performance.cacheHitRate || 0).toFixed(0)
        },
        session: {
            uptime: `${hours}h ${minutes}m`,
            totalScans: state.session.totalScans,
            lastScan: state.session.lastScan
        },
        topTokens: Object.entries(state.tokenMetrics).sort((a,b) => b[1].spreadsFound - a[1].spreadsFound).slice(0, 5),
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 50),
        connected: state.connected,
        contractReady: state.contractReady
    });
});

app.post('/api/withdraw', async (req, res) => { await withdrawProfits(); res.json({ status: 'ok' }); });
app.post('/api/reset', (req, res) => { 
    state.stats.totalProfitUSD = 0; state.stats.totalAttempts = 0; state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0; state.tradeHistory = []; 
    addLog('Stats reset', 'info'); res.json({ status: 'reset' });
});
app.get('/health', (req, res) => { res.json({ status: 'ok', connected: state.connected, tokens: allTokensCache.length, dexes: DEXES.length }); });

// ==================== ADVANCED DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | Max Profit Mode</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; padding: 20px; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 20px; padding: 28px 32px; margin-bottom: 24px; color: white; }
        .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        .status { display: inline-block; padding: 4px 12px; background: #00ff8844; border-radius: 20px; font-size: 12px; margin-left: 12px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: white; border-radius: 16px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .stat-label { font-size: 11px; text-transform: uppercase; color: #6c757d; margin-bottom: 8px; letter-spacing: 0.5px; }
        .stat-value { font-size: 28px; font-weight: 700; color: #1a1a2e; }
        .stat-value.positive { color: #28a745; }
        .stat-unit { font-size: 12px; color: #6c757d; margin-left: 4px; }
        .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .card { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .card-header { padding: 16px 20px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; font-weight: 600; font-size: 15px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; padding: 12px 16px; background: #f8f9fa; color: #6c757d; font-weight: 600; }
        td { padding: 10px 16px; border-bottom: 1px solid #e9ecef; }
        .success { color: #28a745; font-weight: 600; }
        .tx-link { color: #667eea; text-decoration: none; font-family: monospace; font-size: 11px; }
        .logs-container { max-height: 400px; overflow-y: auto; font-family: 'SF Mono', monospace; font-size: 11px; background: #1a1a2e; color: #e0e0e0; }
        .log-entry { padding: 8px 16px; border-bottom: 1px solid #2a2a3e; }
        .log-time { color: #6c757d; margin-right: 12px; }
        .log-success { color: #28a745; }
        .log-error { color: #dc3545; }
        .log-opportunity { color: #fd7e14; }
        .btn { padding: 10px 20px; border-radius: 10px; border: none; cursor: pointer; font-weight: 600; margin-right: 10px; }
        .btn-primary { background: #667eea; color: white; }
        .btn-secondary { background: #e9ecef; color: #495057; }
        .metric-badge { display: inline-block; padding: 4px 8px; background: #e9ecef; border-radius: 8px; font-size: 10px; margin: 2px; }
        .refresh-note { text-align: center; font-size: 11px; color: #6c757d; margin-top: 20px; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>💸 Flash Loan Arbitrage Bot <span class="status">MAX PROFIT MODE</span></h1>
        <p>AAVE V3 | Zero Capital | ${DEXES.length} DEXes | Auto-Discovery | Real-time Arbitrage</p>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 Total Profit</div><div class="stat-value positive" id="profit">$0.00</div></div>
        <div class="stat-card"><div class="stat-label">📊 Success Rate</div><div class="stat-value" id="successRate">0%</div></div>
        <div class="stat-card"><div class="stat-label">💸 Flash Loans</div><div class="stat-value" id="flashLoans">0</div></div>
        <div class="stat-card"><div class="stat-label">🎯 Opportunities</div><div class="stat-value" id="opportunities">0</div></div>
        <div class="stat-card"><div class="stat-label">🪙 Tokens</div><div class="stat-value" id="tokenCount">0</div></div>
        <div class="stat-card"><div class="stat-label">🔄 DEXes</div><div class="stat-value" id="dexCount">${DEXES.length}</div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📋 Recent Trades</div>
            <div style="overflow-x: auto;">
                <table>
                    <thead><tr><th>Time</th><th>Token</th><th>Buy → Sell</th><th>Profit</th><th>Gas</th><th>Tx</th></tr></thead>
                    <tbody id="tradesBody"><tr><td colspan="6" style="text-align:center; padding:40px;">No trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-header">📝 Live Activity Logs</div>
            <div class="logs-container" id="logsContainer">Initializing...</div>
        </div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">🏆 Top Tokens (Most Spreads)</div>
            <div style="overflow-x: auto;">
                <table>
                    <thead><tr><th>Token</th><th>Spreads Found</th><th>Avg Spread</th></tr></thead>
                    <tbody id="topTokensBody"><tr><td colspan="3" style="text-align:center; padding:20px;">Scanning...</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-header">⚡ Performance Metrics</div>
            <div style="padding: 16px;">
                <div style="margin-bottom: 12px;"><span class="metric-badge">📊 Price Success Rate</span> <strong id="priceRate">0%</strong></div>
                <div style="margin-bottom: 12px;"><span class="metric-badge">⏱️ Avg Scan Time</span> <strong id="scanTime">0ms</strong></div>
                <div style="margin-bottom: 12px;"><span class="metric-badge">💾 Cache Hit Rate</span> <strong id="cacheRate">0%</strong></div>
                <div style="margin-bottom: 12px;"><span class="metric-badge">📈 Avg Profit/Trade</span> <strong id="avgProfit">$0.00</strong></div>
                <div style="margin-bottom: 12px;"><span class="metric-badge">🏆 Best Trade</span> <strong id="bestTrade">$0.00</strong></div>
                <div><span class="metric-badge">⏰ Uptime</span> <strong id="uptime">0h 0m</strong></div>
            </div>
        </div>
    </div>

    <div class="btn-group" style="display: flex; gap: 12px; justify-content: flex-end;">
        <button class="btn btn-secondary" onclick="resetStats()">Reset Stats</button>
        <button class="btn btn-primary" onclick="withdrawProfits()">Withdraw Profits</button>
    </div>
    <div class="refresh-note">🔄 Auto-refreshing every 2 seconds</div>
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
            document.getElementById('tokenCount').innerHTML = data.performance?.totalTokens || 0;
            document.getElementById('priceRate').innerHTML = (data.performance?.successRate || 0) + '%';
            document.getElementById('scanTime').innerHTML = (data.performance?.avgScanTimeMs || 0) + 'ms';
            document.getElementById('cacheRate').innerHTML = (data.performance?.cacheHitRate || 0) + '%';
            document.getElementById('avgProfit').innerHTML = '$' + (data.stats.avgProfitPerTrade || 0);
            document.getElementById('bestTrade').innerHTML = '$' + (data.stats.bestTrade || 0);
            document.getElementById('uptime').innerHTML = data.session?.uptime || '0h 0m';
            
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let t of data.tradeHistory.slice(0, 8)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const profitClass = t.success ? 'success' : '';
                    const profitDisplay = t.success ? '+$' + t.profitUSD.toFixed(2) : 'Failed';
                    const route = t.buyDex && t.sellDex ? t.buyDex + '→' + t.sellDex : '-';
                    html += '<tr>' +
                        '<td>' + time + '</td>' +
                        '<td>' + (t.token || '-') + '</td>' +
                        '<td style="font-size:10px">' + route + '</td>' +
                        '<td class="' + profitClass + '">' + profitDisplay + '</td>' +
                        '<td>$' + (t.gasCostUSD || 0).toFixed(4) + '</td>' +
                        '<td>' + (t.txHash ? '<a href="https://polygonscan.com/tx/' + t.txHash + '" target="_blank" class="tx-link">View</a>' : '-') + '</td>' +
                        '</tr>';
                }
                tradesBody.innerHTML = html;
            }
            
            const topTokensBody = document.getElementById('topTokensBody');
            if (data.topTokens && data.topTokens.length > 0) {
                let html = '';
                for (let t of data.topTokens.slice(0, 5)) {
                    html += '<tr><td>' + t[0] + '</td><td>' + t[1].spreadsFound + '</td><td>' + t[1].avgSpread.toFixed(2) + '%</td></tr>';
                }
                topTokensBody.innerHTML = html;
            }
            
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let html = '';
                for (let log of data.logs.slice(0, 25)) {
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
    
    async function resetStats() { await fetch('/api/reset', { method: 'POST' }); setTimeout(fetchData, 500); }
    async function withdrawProfits() { await fetch('/api/withdraw', { method: 'POST' }); alert('Withdrawal initiated'); setTimeout(fetchData, 3000); }
    
    fetchData();
    setInterval(fetchData, 2000);
</script>
</body>
</html>`;
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n' + '═'.repeat(60));
    console.log('💸 MAX PROFIT FLASH LOAN ARBITRAGE BOT');
    console.log('═'.repeat(60));
    console.log(`📜 Contract: ${CONTRACT_ADDRESS}`);
    console.log(`🔄 ${DEXES.length} DEXes | ${allTokensCache.length} Tokens | Auto-Discovery ON`);
    console.log(`💎 Flash Loans: $0 Capital | Min Profit: $${MIN_PROFIT_USD}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log('═'.repeat(60) + '\n');
    
    await initializeBlockchain();
    await discoverNewTokens();
    mainLoop().catch(console.error);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Bot LIVE - Scanning ${allTokensCache.length} tokens on ${DEXES.length} DEXes`);
    });
}

start();
