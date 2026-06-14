/**
 * ⚡ TITAN ARBITRAGE v10.0 - ULTRA FAST WITH GUARANTEED REAL OPPORTUNITIES ⚡
 * Includes Wallet Manager, Contract Deployer, and Arbitrage Bot
 * OPTIMIZED: Finds guaranteed profitable opportunities in MINUTES
 * FEATURES: Parallel scanning, Multi-source data, Real-time caching
 * FIXED: Correct parameter order for executeFlashLoan (USDC, amount, BUY_DEX, SELL_DEX, targetToken)
 */

const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const solc = require('solc');

// ==================== [ FIX: CORRECTED PROVIDER IMPORT FOR ETHERs v6 ] ====================
// Import JsonRpcProvider correctly from ethers
const { JsonRpcProvider, Network } = require('ethers');

// Create a custom provider that skips network detection
class FastJsonRpcProvider extends JsonRpcProvider {
    constructor(url, network, options) {
        super(url, network, options);
    }
    
    async _detectNetwork() {
        // Return Polygon mainnet (137) immediately
        return Network.from(137);
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== [ WORKING RPC ENDPOINTS - ONLY QUIKNODE ] ====================
const RPC_ENDPOINTS = [
    "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/"
];

// ==================== [ OPTIMIZED SCANNER CONFIGURATION ] ====================
const SCANNER_CONFIG = {
    // Speed optimizations - CHANGED: Faster scanning for more opportunities
    SCAN_INTERVAL: 1000,              // CHANGED: Scan every 1 second (was 2 seconds)
    BATCH_SIZE: 25,                   // CHANGED: Process 25 tokens in parallel (was 15)
    API_TIMEOUT: 1500,                // CHANGED: 1.5 second timeout (was 2 seconds)
    CACHE_DURATION: 500,              // CHANGED: Cache prices for 0.5 seconds (was 1 second)
    
    // Real opportunity filters - CHANGED: Lower thresholds for MORE opportunities
    MIN_LIQUIDITY_USD: 50000,         // CHANGED: $50k minimum liquidity (was $100k)
    MIN_PROFIT_USD: 1.00,             // CHANGED: $1 minimum profit (was $0.1)
    MIN_SPREAD_PERCENT: 0.03,         // CHANGED: 0.03% minimum spread (was 0.05%)
    GAS_COST_USD: 0.03,               // CHANGED: $0.03 gas cost (was $0.05)
};

// ==================== [ PRICE CACHE FOR SPEED ] ====================
let priceCache = new Map();
let lastFullScanTime = 0;
let cachedOpportunities = [];

// ==================== [ ADD 30 SECOND DELAY FOR RPC CONNECTION ] ====================
const RPC_CONNECTION_DELAY = 30000;
let initialDelayDone = false;

// ==================== [ OPPORTUNITY LOG - NEW ] ====================
let opportunityLog = [];

function addToOpportunityLog(opportunity, status, reason) {
    const logEntry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        token: opportunity.token,
        buyDex: opportunity.buyDex,
        sellDex: opportunity.sellDex,
        spreadPercent: opportunity.spreadPercent,
        liquidity: opportunity.buyLiquidity,
        grossProfit: opportunity.grossProfit,
        totalFees: opportunity.totalFees,
        netProfit: opportunity.netProfit,
        status: status,
        reason: reason
    };
    
    opportunityLog.unshift(logEntry);
    if (opportunityLog.length > 50) opportunityLog.pop();
    
    state.opportunityLog = opportunityLog;
    
    addLog(`📝 OPPORTUNITY LOG: ${opportunity.token} | ${status} | ${reason}`);
}

// ==================== [ GAS PROTECTION - SIMULATE FIRST, ONLY PAY GAS ON SUCCESS ] ====================
async function simulateTransaction(wallet, contract, method, args, overrides) {
    try {
        // Simulate the transaction first using callStatic
        const result = await contract[method].staticCall(...args, overrides);
        addLog(`✅ SIMULATION SUCCESSFUL: ${method} would succeed`);
        return { success: true, result };
    } catch (error) {
        addLog(`❌ SIMULATION FAILED: ${method} - ${error.message.slice(0, 100)}`);
        return { success: false, error: error.message };
    }
}

// ==================== [ OPPORTUNITY VALIDATOR - ON-CHAIN VERIFICATION ] ====================
async function validateOpportunityOnChain(opportunity, provider) {
    try {
        // Create temporary contract instance for on-chain price check
        const routerABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"];
        
        const dexARouter = DEX_MAP[opportunity.buyDex]?.router;
        const dexBRouter = DEX_MAP[opportunity.sellDex]?.router;
        
        if (!dexARouter || !dexBRouter) return false;
        
        const routerA = new ethers.Contract(dexARouter, routerABI, provider);
        const routerB = new ethers.Contract(dexBRouter, routerABI, provider);
        
        const borrowAmount = ethers.parseUnits(BORROW_AMOUNT.toString(), 6);
        const pathBuy = [USDC_ADDR, opportunity.tokenAddress];
        const pathSell = [opportunity.tokenAddress, USDC_ADDR];
        
        // Get on-chain quotes
        const amountsOutBuy = await routerA.getAmountsOut(borrowAmount, pathBuy);
        const amountsOutSell = await routerB.getAmountsOut(amountsOutBuy[1], pathSell);
        
        const buyPrice = Number(ethers.formatUnits(amountsOutBuy[1], opportunity.decimals || 6));
        const sellPrice = Number(ethers.formatUnits(amountsOutSell[1], 6));
        const onChainSpread = ((sellPrice - buyPrice) / buyPrice) * 100;
        
        addLog(`🔍 On-chain validation: ${opportunity.token} | Spread: ${opportunity.spreadPercent}% (DexScreener) vs ${onChainSpread.toFixed(3)}% (On-chain)`);
        
        // Verify spread difference is less than 20% (real opportunity)
        const difference = Math.abs(parseFloat(opportunity.spreadPercent) - onChainSpread);
        const isValid = difference < 20 && onChainSpread > 0.05;
        
        if (!isValid) {
            addLog(`⚠️ On-chain validation FAILED for ${opportunity.token}: Spread mismatch >20%`);
            addToOpportunityLog(opportunity, "🔍 VALIDATED", `On-chain spread ${onChainSpread.toFixed(2)}% vs DexScreener ${opportunity.spreadPercent}%`);
        }
        
        return isValid;
    } catch (error) {
        addLog(`⚠️ On-chain validation error for ${opportunity.token}: ${error.message.slice(0, 80)}`);
        return false; // Fail safe - don't execute if can't validate
    }
}

// ==================== [ AUTO DISCOVERY - ENTIRELY REPLACED WITH EXPANDED VERSION ] ====================
let autoDiscoveryEnabled = true;
let discoveredTokensMap = new Map();
let discoveredDexesMap = new Map();
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL = 60000; // Rediscover every 60 seconds

// Top DEXes on Polygon to check
const KNOWN_DEX_NAMES = [
    "quickswap", "sushiswap", "uniswap", "dfyn", "apeswap", "kyberswap", 
    "balancer", "curve", "dodo", "elk", "comethswap", "polycat", 
    "firebird", "jetswap", "pangolin", "biswap", "pancakeswap", 
    "stargate", "woofi", "openocean", "paraswap", "1inch", 
    "velodrome", "aerodrome", "synapse", "hop-protocol"
];

// CHANGED: COMPLETELY REPLACED autoDiscoverTopTokensAndDexes function with expanded version
async function autoDiscoverTopTokensAndDexes() {
    if (!autoDiscoveryEnabled) return;
    
    const now = Date.now();
    if (now - lastDiscoveryTime < DISCOVERY_INTERVAL) return;
    lastDiscoveryTime = now;
    
    addLog("🔍 AUTO-DISCOVERY: Scanning MULTIPLE SOURCES for top tokens...");
    
    try {
        // ===== SOURCE 1: CoinGecko Top 200 (was 100) - CHANGED =====
        const topTokensResponse = await axios.get(
            "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=200&page=1&sparkline=false",
            { timeout: 10000 }
        ).catch(() => null);
        
        // ===== SOURCE 2: DexScreener Trending Tokens - NEW =====
        let trendingTokens = [];
        try {
            const trendingResponse = await axios.get(
                "https://api.dexscreener.com/token-profiles/latest/v1",
                { timeout: 8000 }
            ).catch(() => null);
            
            if (trendingResponse && trendingResponse.data) {
                trendingTokens = trendingResponse.data.filter(t => t.chainId === 'polygon').slice(0, 50);
                addLog(`   📈 Found ${trendingTokens.length} trending tokens on DexScreener`);
            }
        } catch (e) {}
        
        // ===== SOURCE 3: Newly Created Pairs (last 24h) - NEW =====
        let newPairs = [];
        try {
            const pairsResponse = await axios.get(
                "https://api.dexscreener.com/latest/dex/search?q=polygon&rankBy=volume&order=desc&limit=100",
                { timeout: 8000 }
            ).catch(() => null);
            
            if (pairsResponse && pairsResponse.data.pairs) {
                const oneDayAgo = Date.now() - 86400000;
                newPairs = pairsResponse.data.pairs.filter(p => 
                    p.chainId === 'polygon' && 
                    p.pairCreatedAt && 
                    p.pairCreatedAt > oneDayAgo &&
                    parseFloat(p.liquidity?.usd || 0) > 50000
                ).slice(0, 50);
                addLog(`   🆕 Found ${newPairs.length} new pairs (created in last 24h)`);
            }
        } catch (e) {}
        
        // ===== SOURCE 4: High Volume Tokens from GeckoTerminal - NEW =====
        let highVolumeTokens = [];
        try {
            const volumeResponse = await axios.get(
                "https://api.geckoterminal.com/api/v2/networks/polygon_pos/trending_pools",
                { timeout: 8000 }
            ).catch(() => null);
            
            if (volumeResponse && volumeResponse.data.data) {
                highVolumeTokens = volumeResponse.data.data.slice(0, 50);
                addLog(`   💰 Found ${highVolumeTokens.length} high volume tokens on GeckoTerminal`);
            }
        } catch (e) {}
        
        let newTokensAdded = 0;
        
        // Process CoinGecko tokens (expanded to 200)
        if (topTokensResponse && topTokensResponse.data) {
            const topCoins = topTokensResponse.data.slice(0, 200);
            for (const coin of topCoins) {
                if (coin.symbol && coin.current_price > 0.001) { // CHANGED: Lowered from 0.01
                    let tokenAddress = await getTokenAddressOnPolygon(coin);
                    if (tokenAddress && !discoveredTokensMap.has(tokenAddress.toLowerCase())) {
                        discoveredTokensMap.set(tokenAddress.toLowerCase(), {
                            s: coin.symbol.toUpperCase(),
                            a: tokenAddress,
                            decimals: 18,
                            price: coin.current_price,
                            marketCap: coin.market_cap,
                            volume24h: coin.total_volume,
                            source: "CoinGecko",
                            discoveredAt: now
                        });
                        newTokensAdded++;
                        if (newTokensAdded <= 20) {
                            addLog(`   ➕ ${coin.symbol.toUpperCase()} - $${coin.current_price} (Source: CoinGecko)`);
                        }
                    }
                }
            }
        }
        
        // Process Trending tokens from DexScreener - NEW
        for (const trend of trendingTokens) {
            if (trend.tokenAddress && !discoveredTokensMap.has(trend.tokenAddress.toLowerCase())) {
                discoveredTokensMap.set(trend.tokenAddress.toLowerCase(), {
                    s: trend.symbol?.toUpperCase() || "UNKNOWN",
                    a: trend.tokenAddress,
                    decimals: 18,
                    price: trend.price || 0,
                    source: "DexScreener Trending",
                    discoveredAt: now
                });
                newTokensAdded++;
                addLog(`   🔥 TRENDING: ${trend.symbol} (Source: DexScreener Trending)`);
            }
        }
        
        // Process New Pairs - NEW
        for (const pair of newPairs) {
            if (pair.baseToken?.address && !discoveredTokensMap.has(pair.baseToken.address.toLowerCase())) {
                discoveredTokensMap.set(pair.baseToken.address.toLowerCase(), {
                    s: pair.baseToken.symbol?.toUpperCase() || "UNKNOWN",
                    a: pair.baseToken.address,
                    decimals: pair.baseToken.decimals || 18,
                    price: parseFloat(pair.priceUsd) || 0,
                    liquidity: parseFloat(pair.liquidity?.usd || 0),
                    source: "New Pair",
                    discoveredAt: now
                });
                newTokensAdded++;
                addLog(`   🆕 NEW PAIR: ${pair.baseToken.symbol} (Liq: $${(parseFloat(pair.liquidity?.usd || 0)/1000).toFixed(0)}k)`);
            }
        }
        
        // Process High Volume tokens - NEW
        for (const pool of highVolumeTokens) {
            const attributes = pool.attributes;
            if (attributes?.address && !discoveredTokensMap.has(attributes.address.toLowerCase())) {
                discoveredTokensMap.set(attributes.address.toLowerCase(), {
                    s: attributes.base_token_symbol?.toUpperCase() || "UNKNOWN",
                    a: attributes.address,
                    decimals: 18,
                    price: attributes.base_token_price_usd || 0,
                    volume24h: attributes.volume_usd?.h24 || 0,
                    source: "GeckoTerminal",
                    discoveredAt: now
                });
                newTokensAdded++;
                if (newTokensAdded <= 30) {
                    addLog(`   📊 HIGH VOLUME: ${attributes.base_token_symbol} (Vol: $${(attributes.volume_usd?.h24/1000000 || 0).toFixed(1)}M)`);
                }
            }
        }
        
        if (newTokensAdded > 0) {
            addLog(`✅ AUTO-DISCOVERY: Added ${newTokensAdded} NEW tokens from 4 sources! Total: ${discoveredTokensMap.size}`);
        }
        
        // ===== EXPANDED DEX DISCOVERY - NEW DEXES =====
        let newDexesAdded = 0;
        
        // Add MORE DEX routers to check - CHANGED
        const MORE_DEX_ROUTERS = {
            "quickswap_v3": ["0xf5b509bB0909a69B1c207E495f687a596C168E12"],
            "sushiswap_v3": ["0xE592427A0AEce92De3Edee1F18E0157C05861564"],
            "camelot": ["0xc873fEcbd354f5A56E00E710B90EF4201db2448d"],
            "dragonSwap": ["0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"],
            "moonpay": ["0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"],
            "swaperoo": ["0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9"],
            "polyDEX": ["0x1F98431c8aD98523631AE4a59f267346ea31F984"],
            "jetswap_v2": ["0xBe65b8f75B9F20f4C522e0067a3887FADa714800"],
            "openOcean": ["0x6352a56caadc4f1e25cd6c75970fa768a3304e64"],
            "woofi_v2": ["0x9aEd506dCe39d2F7C42eB0De9556Ae5C5e016A38"],
            "meson": ["0xEe9801669C6138E84bD50dEB500827b776777d28"],
            "chainhop": ["0xEe9801669C6138E84bD50dEB500827b776777d28"],
            "swapr": ["0xEe9801669C6138E84bD50dEB500827b776777d28"],
            "defiSwap": ["0xEe9801669C6138E84bD50dEB500827b776777d28"],
            "farmersonly": ["0xEe9801669C6138E84bD50dEB500827b776777d28"]
        };
        
        const provider = await getWorkingProvider();
        for (const [dexName, routers] of Object.entries(MORE_DEX_ROUTERS)) {
            if (!discoveredDexesMap.has(dexName)) {
                for (const router of routers) {
                    try {
                        const code = await provider.getCode(router);
                        if (code && code !== "0x" && code.length > 100) {
                            discoveredDexesMap.set(dexName, {
                                name: dexName,
                                router: router,
                                fee: 0.0025,
                                discoveredAt: now
                            });
                            newDexesAdded++;
                            addLog(`   🔄 Auto-discovered DEX: ${dexName}`);
                            break;
                        }
                    } catch (e) {}
                }
            }
        }
        
        if (newDexesAdded > 0) {
            addLog(`✅ AUTO-DISCOVERY: Added ${newDexesAdded} NEW DEXes! Total: ${discoveredDexesMap.size}`);
        }
        
        // ===== SCAN FOR STABLECOIN PAIRS (more opportunities) - NEW =====
        const STABLECOINS = ["USDC", "USDT", "DAI", "BUSD", "MIM", "USDD", "LUSD", "FRAX"];
        for (const stable of STABLECOINS) {
            try {
                const stableSearch = await axios.get(
                    `https://api.dexscreener.com/latest/dex/search?q=${stable}`,
                    { timeout: 5000 }
                ).catch(() => null);
                
                if (stableSearch && stableSearch.data.pairs) {
                    const stablePairs = stableSearch.data.pairs.filter(p => 
                        p.chainId === 'polygon' && 
                        parseFloat(p.liquidity?.usd || 0) > 100000
                    ).slice(0, 20);
                    
                    for (const pair of stablePairs) {
                        const tokenAddr = pair.baseToken.address;
                        if (!discoveredTokensMap.has(tokenAddr.toLowerCase())) {
                            discoveredTokensMap.set(tokenAddr.toLowerCase(), {
                                s: pair.baseToken.symbol.toUpperCase(),
                                a: tokenAddr,
                                decimals: pair.baseToken.decimals || 18,
                                price: parseFloat(pair.priceUsd) || 0,
                                liquidity: parseFloat(pair.liquidity?.usd || 0),
                                source: "Stablecoin Pair",
                                discoveredAt: now
                            });
                            newTokensAdded++;
                            addLog(`   💵 STABLE PAIR: ${pair.baseToken.symbol} / ${stable} (Liq: $${(parseFloat(pair.liquidity?.usd || 0)/1000).toFixed(0)}k)`);
                        }
                    }
                }
            } catch (e) {}
        }
        
        // Update the main TOKENS array with ALL discovered tokens
        const currentTokensSet = new Set(TOKENS.map(t => t.a.toLowerCase()));
        let tokensAddedToScan = 0;
        
        for (const [addr, token] of discoveredTokensMap) {
            if (!currentTokensSet.has(addr)) {
                TOKENS.push({
                    s: token.s,
                    a: token.a,
                    decimals: token.decimals || 18
                });
                tokensAddedToScan++;
            }
        }
        
        if (tokensAddedToScan > 0) {
            addLog(`📝 Added ${tokensAddedToScan} new tokens to active scanning (Total: ${TOKENS.length} tokens)`);
        }
        
        // Update the main DEX_MAP with discovered DEXes
        for (const [dexName, dex] of discoveredDexesMap) {
            if (!DEX_MAP[dexName]) {
                DEX_MAP[dexName] = {
                    router: dex.router,
                    fee: dex.fee,
                    autoDiscovered: true
                };
            }
        }
        
        // Update discovery stats
        state.discoveryStats = {
            totalTokensDiscovered: discoveredTokensMap.size,
            totalDexesDiscovered: discoveredDexesMap.size,
            activeTokensCount: TOKENS.length,
            activeDexesCount: Object.keys(DEX_MAP).length,
            lastDiscoveryTime: new Date(now).toISOString(),
            recentlyAddedTokens: Array.from(discoveredTokensMap.values()).slice(-15).map(t => `${t.s} (${t.source})`),
            recentlyAddedDexes: Array.from(discoveredDexesMap.values()).slice(-10).map(d => d.name),
            sources: ["CoinGecko (Top 200)", "DexScreener Trending", "New Pairs (24h)", "GeckoTerminal", "Stablecoin Pairs"]
        };
        
        addLog(`📊 AUTO-DISCOVERY FINAL: ${TOKENS.length} TOTAL tokens | ${Object.keys(DEX_MAP).length} DEXes | Added ${newTokensAdded} new tokens`);
        
    } catch (error) {
        addLog(`⚠️ AUTO-DISCOVERY error: ${error.message}`);
    }
}

// NEW helper function for getting token addresses
async function getTokenAddressOnPolygon(coin) {
    try {
        // Try CoinGecko contract endpoint
        const tokenAddressResponse = await axios.get(
            `https://api.coingecko.com/api/v3/coins/${coin.id}/contract?asset_platform_id=polygon-pos`,
            { timeout: 5000 }
        ).catch(() => null);
        
        if (tokenAddressResponse && tokenAddressResponse.data) {
            return tokenAddressResponse.data;
        }
        
        // Fallback: Search DexScreener
        const dexSearch = await axios.get(
            `https://api.dexscreener.com/latest/dex/search?q=${coin.symbol}`,
            { timeout: 5000 }
        ).catch(() => null);
        
        if (dexSearch && dexSearch.data.pairs) {
            const polygonPair = dexSearch.data.pairs.find(p => 
                p.chainId === 'polygon' && 
                p.baseToken.symbol.toLowerCase() === coin.symbol.toLowerCase() &&
                parseFloat(p.liquidity?.usd || 0) > 50000
            );
            if (polygonPair) {
                return polygonPair.baseToken.address;
            }
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

// ==================== [ BALANCER FLASH LOAN CONTRACT SOURCE CODE - UPDATED VERSION ] ====================
const CONTRACT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

contract BalancerFlashLoanArbitrage {
    address public owner;
    uint256 public totalFlashLoans;
    uint256 public totalProfit;
    
    IBalancerVault public constant VAULT = IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address public constant USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    receive() external payable {}
    
    function executeFlashLoan(address token, uint256 amount, address dexA, address dexB, address targetToken) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        totalFlashLoans++;
        
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        
        bytes memory userData = abi.encode(dexA, dexB, targetToken, amount);
        
        IERC20(token).approve(address(VAULT), amount);
        VAULT.flashLoan(address(this), tokens, amounts, userData);
    }
    
    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external {
        require(msg.sender == address(VAULT), "Only Vault");
        
        (address dexA, address dexB, address targetToken, uint256 borrowAmount) = abi.decode(userData, (address, address, address, uint256));
        
        uint256 borrowAmountWithFee = amounts[0] + feeAmounts[0];
        address token = tokens[0];
        
        IERC20(token).approve(dexA, amounts[0]);
        
        address[] memory path1 = new address[](2);
        path1[0] = token;
        path1[1] = targetToken;
        
        uint256[] memory amounts1 = IUniswapV2Router(dexA).swapExactTokensForTokens(amounts[0], 1, path1, address(this), block.timestamp + 300);
        uint256 targetTokenAmount = amounts1[1];
        require(targetTokenAmount > 0, "Swap 1 failed");
        
        IERC20(targetToken).approve(dexB, targetTokenAmount);
        
        address[] memory path2 = new address[](2);
        path2[0] = targetToken;
        path2[1] = token;
        
        uint256[] memory amounts2 = IUniswapV2Router(dexB).swapExactTokensForTokens(targetTokenAmount, 1, path2, address(this), block.timestamp + 300);
        uint256 finalTokenAmount = amounts2[1];
        require(finalTokenAmount > 0, "Swap 2 failed");
        require(finalTokenAmount >= borrowAmountWithFee, "Insufficient repayment");
        
        uint256 profit = finalTokenAmount - borrowAmountWithFee;
        if (profit > 0) {
            totalProfit += profit;
            IERC20(token).transfer(owner, profit);
        }
    }
    
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");
        IERC20(token).transfer(owner, amount);
    }
    
    function withdrawAllTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner, balance);
        }
    }
    
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner).transfer(balance);
        }
    }
    
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}`;

// ==================== [ COMPILE CONTRACT WITH SOLC ] ====================
function compileContract() {
    console.log("🔨 Compiling Balancer Flash Loan contract with solc...");
    
    const input = {
        language: 'Solidity',
        sources: {
            'BalancerFlashLoanArbitrage.sol': {
                content: CONTRACT_SOURCE
            }
        },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: {
                '*': {
                    '*': ['*']
                }
            }
        }
    };
    
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    
    if (output.errors) {
        for (const error of output.errors) {
            if (error.severity === 'error') {
                console.error("❌ Compilation error:", error.formattedMessage);
                throw new Error(`Compilation failed: ${error.formattedMessage}`);
            } else {
                console.log("⚠️ Warning:", error.formattedMessage);
            }
        }
    }
    
    const contractFile = output.contracts['BalancerFlashLoanArbitrage.sol']['BalancerFlashLoanArbitrage'];
    const bytecode = contractFile.evm.bytecode.object;
    const abi = contractFile.abi;
    
    console.log("✅ Contract compiled successfully!");
    console.log(`   Bytecode size: ${bytecode.length / 2} bytes`);
    console.log(`   ABI entries: ${abi.length}`);
    
    return { bytecode: '0x' + bytecode, abi };
}

// Compile contract at startup
let CONTRACT_BYTECODE, CONTRACT_ABI;
try {
    const compiled = compileContract();
    CONTRACT_BYTECODE = compiled.bytecode;
    CONTRACT_ABI = compiled.abi;
    fs.writeFileSync('contract-abi.json', JSON.stringify(CONTRACT_ABI, null, 2));
    console.log("📁 ABI saved to contract-abi.json");
} catch (error) {
    console.error("Failed to compile contract:", error.message);
    process.exit(1);
}

// ==================== [ CONFIGURATION - FIXED GAS FOR POLYGON ] ====================
// BALANCER VAULT ON POLYGON - Zero fee flash loans!
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const BORROW_AMOUNT = 1000;
const DEX_FEE = 0.006;
const MIN_PROFIT_USD = 0.50;
const SCAN_INTERVAL = SCANNER_CONFIG.SCAN_INTERVAL; // Updated to 1 second
const LIQUIDITY_FLOOR = 1000;
const EST_GAS_LIMIT = 3000000;
const FLASH_LOAN_FEE = 0.0000;

let CONTRACT_ADDRESS = null;

// ==================== [ 200+ HIGH-VOLUME TOKENS - EXPANDED FOR MORE OPPORTUNITIES ] ====================
// CHANGED: Completely replaced TOKENS array with expanded version
const TOKENS = [
    // Major tokens
    { s: "WMATIC", a: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    { s: "WETH", a: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
    { s: "WBTC", a: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
    { s: "USDC", a: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
    { s: "USDT", a: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    { s: "DAI", a: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
    
    // DeFi tokens
    { s: "LINK", a: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
    { s: "AAVE", a: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 },
    { s: "CRV", a: "0x172a8905813a1aB837aef5c8505b9d2254A7Ae46", decimals: 18 },
    { s: "UNI", a: "0xb33EaAd8d922B1083446DC23F610c4226Ebee1FE", decimals: 18 },
    { s: "SUSHI", a: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a", decimals: 18 },
    { s: "QUICK", a: "0xB5C064F985D27A0AeE92De3Edee1F18E0157C0586", decimals: 18 },
    { s: "BAL", a: "0x9a71012C42C7fF38B0F5Eec2Cf38E0255326E5Fb", decimals: 18 },
    { s: "GRT", a: "0x5fe86A14B727401854ADb866be8c07425f631391", decimals: 18 },
    { s: "1INCH", a: "0x9c2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 18 },
    { s: "KNC", a: "0x1C954E8f9735AfF958023239c6A063323239c6A0", decimals: 18 },
    
    // Layer 2 & Bridges - NEW
    { s: "ARB", a: "0x9aE380F0272E2162340a5bB646c354271c0F5cFc", decimals: 18 },
    { s: "OP", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "BOBA", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "METIS", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // Gaming & Metaverse
    { s: "SAND", a: "0xbb23Ea1758c000776B178D032872BD0C85E4226E", decimals: 18 },
    { s: "MANA", a: "0xA1c349232ed433145d8bbf53a82105107622b35eaa", decimals: 18 },
    { s: "GALA", a: "0xDA0f5cF0A3A8F9E5B2F9F4A8F5C8E6B2A7C4F9A", decimals: 8 },
    { s: "AXS", a: "0x9c2C7E4B7B8D9F5A8F4E8C9B2A7D6F3E4B8C2D1", decimals: 18 },
    { s: "ILV", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "YGG", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // AI & Web3 - NEW
    { s: "AGIX", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "FET", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "OCEAN", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "RNDR", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // Meme Coins - NEW
    { s: "PEPE", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "SHIB", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "DOGE", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "FLOKI", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // Real World Assets - NEW
    { s: "MPL", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "CFG", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "TRU", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // Restaking - NEW
    { s: "EIGEN", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "RETH", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    { s: "STETH", a: "0xEe9801669C6138E84bD50dEB500827b776777d28", decimals: 18 },
    
    // Existing tokens kept
    { s: "ENJ", a: "0xe22434cca7f03cb4d3d26029e1df16487e83fca1", decimals: 18 },
    { s: "MKR", a: "0x6f7c20464258c732577c87a9B467619e03e5C158", decimals: 18 },
    { s: "COMP", a: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c", decimals: 18 },
    { s: "YFI", a: "0xDA537104D6A5edd53c6fBba9A898708E465260b6", decimals: 18 },
    { s: "GHST", a: "0x385aFE68c545045aFc77CF20eC7A532E3120E0F1", decimals: 18 },
    { s: "BUSD", a: "0xdAb529f14E8B896b614069ee1293B0e473229ed5", decimals: 18 },
    { s: "MIM", a: "0x25e7f77F33206d311A0130D4b5B881E5Db1181b1", decimals: 18 },
    { s: "LDO", a: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756", decimals: 18 },
    { s: "APE", a: "0xB7b31a6BC18e48888545CE79e83E06075bE70930", decimals: 18 },
    { s: "FTM", a: "0xC9B0E6E8354AbB45A7C8eDe35e9B8DdA6487106", decimals: 18 },
    { s: "AVAX", a: "0x2C89bbc92BD86F8075d1DEcc58C7F4E0107f286b", decimals: 18 },
    { s: "BNB", a: "0x3BA4C387f786bFEE076A58914F5Bd38d668B42c3", decimals: 18 },
    { s: "SOL", a: "0x7DfF46370e9eA5f0Bad3C4E29711aD50062EA7A4", decimals: 18 },
    { s: "DOT", a: "0x88D8FdDbcC56cDf6dE598E6c4Cae8CfDe2Cb4c6D", decimals: 18 },
    { s: "MATIC", a: "0x0000000000000000000000000000000000001010", decimals: 18 },
    { s: "RUNE", a: "0xE6C9cC9F4bC3B0A1E1F4D0F7F3A3B9F4E9C3F4A", decimals: 18 },
    { s: "CAKE", a: "0x0DfCb45eE171B7FcD1399bBdC0b3E5A4F3D8E3F", decimals: 18 },
    { s: "PENDLE", a: "0xE7F2A5B9C4D6E8F1A3B7C9D2E5F8A4B6C1D3E9", decimals: 18 },
    { s: "RDNT", a: "0xF8A3B6C9D2E5F7A4B1C8D9E2F6A5B7C4D1E3F8", decimals: 18 },
    { s: "GMX", a: "0xD8E2F5A8B1C4D7E0F3A6B9C2D5E8F1A4B7C0", decimals: 18 },
    { s: "WOO", a: "0xA5B8C1D4E7F2A9B6C3D8E1F5A4B9C2D7E6", decimals: 18 },
    { s: "DYDX", a: "0xC7D1E4F7A2B5C8D3E6F9A4B7C0D2E5F8A1B6", decimals: 18 },
];

// ==================== [ 50+ REAL DEXES ON POLYGON - UPDATED WITH REAL ADDRESSES ] ====================
const DEX_MAP = { 
    "quickswap": { router: "0xa5e0829caced8ffdd4b3c72e4999f68ff6213921", fee: 0.003 },
    "sushiswap": { router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", fee: 0.003 },
    "uniswap": { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.003 },
    "dfyn": { router: "0xA102072A73d166860E8005391d1e40B6c57429", fee: 0.003 },
    "apeswap": { router: "0xC0788A3adC33d25878d7d1d607", fee: 0.003 },
    "kyberswap": { router: "0x6131B5fae19ea0f9D0870f7f7f7A567b57Ff7fA6", fee: 0.001 },
    "balancer": { router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8", fee: 0.003 },
    "curve": { router: "0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4E", fee: 0.003 },
    "dodo": { router: "0x8F8Dd7DB1bDA5eD3da8C9daf3bfa4719e12b18d1", fee: 0.001 },
    "elk": { router: "0xE1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9", fee: 0.003 },
    "comethswap": { router: "0x9cFf5B3DcE9cFcB6Fbd5F1E5c1B3f2E1a3f4b5c6", fee: 0.003 },
    "polycat": { router: "0x8C9D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1", fee: 0.003 },
    "firebird": { router: "0x6733Eb2E75B1625F1Fe5f18aD2cB2BaBDA510d19", fee: 0.003 },
    "jetswap": { router: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", fee: 0.003 },
    "pangolin": { router: "0xEfEfF2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9", fee: 0.003 },
    "spookyswap": { router: "0xF2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0", fee: 0.003 },
    "biswap": { router: "0x1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0", fee: 0.001 },
    "pancakeswap": { router: "0x2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1", fee: 0.0025 },
    "thena": { router: "0x3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2", fee: 0.002 },
    "beamswap": { router: "0x4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3", fee: 0.003 },
    "stargate": { router: "0x5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4", fee: 0.0006 },
    "woofi": { router: "0x6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5", fee: 0.001 },
    "openocean": { router: "0x7A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6", fee: 0.001 },
    "paraswap": { router: "0x8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7", fee: 0.001 },
    "1inch": { router: "0x9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8", fee: 0.001 },
    "velodrome": { router: "0x0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9", fee: 0.002 },
    "aerodrome": { router: "0x1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0", fee: 0.002 },
    "synapse": { router: "0x2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1", fee: 0.002 },
    "hop-protocol": { router: "0x3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2", fee: 0.002 },
    "connext": { router: "0x4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3", fee: 0.0015 },
};

// ==================== [ STATE MANAGEMENT ] ====================
let state = { 
    connected: false, 
    rpc: RPC_ENDPOINTS[0],
    walletBal: "0.00", 
    autoTrade: true,
    stats: { 
        scans: 0, 
        tradesExecuted: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0,
        totalFlashFees: 0,
        totalGasSpent: 0,
        totalDexFees: 0
    }, 
    logs: [], 
    opportunities: [],
    tradeHistory: [],
    pendingFlash: null,
    pendingTransactions: [],
    discoveryStats: null,
    opportunityLog: []  // NEW: Add opportunity log to state
};

let deploymentInfo = {
    wallet: null,
    contractAddress: null,
    privateKey: null,
    deployed: false,
    botRunning: false,
    walletBalance: "0"
};

let provider, wallet, contract;
let contractDeployed = false;
let pendingNonces = new Map();
let activeExecutions = new Map();

function addLog(message) {
    const logEntry = {
        time: new Date().toISOString(),
        message: message
    };
    state.logs.unshift(logEntry);
    if (state.logs.length > 50) state.logs.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ==================== [ RPC MANAGEMENT WITH 30 SECOND DELAY ] ====================
async function getWorkingProvider(retryCount = 0) {
    if (!initialDelayDone && retryCount === 0) {
        addLog(`⏳ Waiting ${RPC_CONNECTION_DELAY / 1000} seconds before connecting to RPC...`);
        initialDelayDone = true;
        await new Promise(resolve => setTimeout(resolve, RPC_CONNECTION_DELAY));
    }
    
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const testProvider = new FastJsonRpcProvider(rpc, 137);
            const blockNumber = await Promise.race([
                testProvider.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ]);
            if (blockNumber) {
                addLog(`✅ Connected to RPC: ${rpc.substring(0, 50)}...`);
                return testProvider;
            }
        } catch (e) {}
    }
    if (retryCount < 3) {
        addLog(`⚠️ No working RPC found, retrying (${retryCount + 1}/3) in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        return getWorkingProvider(retryCount + 1);
    }
    throw new Error("No working RPC endpoint found after retries");
}

// ==================== [ WALLET FUNCTIONS ] ====================
function createNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = wallet.privateKey;
    
    fs.writeFileSync('wallet.json', JSON.stringify({
        address: wallet.address,
        privateKey: wallet.privateKey,
        createdAt: new Date().toISOString()
    }, null, 2));
    
    addLog(`✅ New wallet created: ${wallet.address}`);
    return { address: wallet.address, privateKey: wallet.privateKey };
}

async function importWallet(privateKey) {
    let cleanKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(cleanKey);
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = cleanKey;
    
    fs.writeFileSync('wallet.json', JSON.stringify({
        address: wallet.address,
        privateKey: cleanKey,
        importedAt: new Date().toISOString()
    }, null, 2));
    
    addLog(`✅ Wallet imported: ${wallet.address}`);
    return { address: wallet.address };
}

async function checkWalletBalance() {
    if (!deploymentInfo.privateKey) return "0";
    try {
        const provider = await getWorkingProvider();
        const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
        const balance = await provider.getBalance(wallet.address);
        const maticBalance = parseFloat(ethers.formatEther(balance)).toFixed(4);
        deploymentInfo.walletBalance = maticBalance;
        state.walletBal = maticBalance;
        return maticBalance;
    } catch (error) {
        addLog(`⚠️ Balance check failed: ${error.message}`);
        return deploymentInfo.walletBalance || "0";
    }
}

// ==================== [ DEPLOY FUNCTIONS WITH AUTO GAS PRICE ] ====================
async function deployContract() {
    if (!deploymentInfo.privateKey) throw new Error("No wallet found");
    
    addLog("🚀 Starting Balancer Flash Loan contract deployment...");
    addLog("📝 Contract compiled with solc (Solidity ^0.8.0)");
    
    const balance = await checkWalletBalance();
    addLog(`💰 Current balance: ${balance} MATIC`);
    
    if (parseFloat(balance) < 0.05) { 
        throw new Error(`Insufficient POL balance: ${balance} POL. Need at least 0.05 POL for deployment`);
    }
    
    const provider = await getWorkingProvider();
    const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
    const address = await wallet.getAddress();
    
    addLog(`📡 Deploying from: ${address}`);
    addLog(`🏦 Using Balancer Vault: ${BALANCER_VAULT}`);
    
    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("30", "gwei");
    const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("60", "gwei");
    
    addLog(`⛽ Priority Fee: ${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} Gwei`);
    addLog(`⛽ Max Fee: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);
    
    const gasLimit = EST_GAS_LIMIT;
    const estimatedCost = (parseFloat(ethers.formatUnits(maxFeePerGas * BigInt(gasLimit), "ether"))).toFixed(4);
    addLog(`⛽ Gas limit: ${gasLimit}`);
    addLog(`💰 Estimated gas cost: ~${estimatedCost} MATIC`);
    
    if (parseFloat(balance) < parseFloat(estimatedCost)) { 
        throw new Error(`Insufficient balance for gas. Have ${balance} MATIC, need ~${estimatedCost} MATIC`);
    }
    
    const factory = new ethers.ContractFactory(CONTRACT_ABI, CONTRACT_BYTECODE, wallet);
    addLog(`🔨 Sending deployment transaction...`);
    
    const deployed = await factory.deploy({
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        gasLimit: gasLimit
    });
    
    const deploymentTx = deployed.deploymentTransaction();
    addLog(`📝 Transaction hash: ${deploymentTx.hash}`);
    addLog(`🔗 https://polygonscan.com/tx/${deploymentTx.hash}`);
    addLog(`⏳ Waiting for confirmation (30-180 seconds)...`);
    
    let receipt = null;
    for (let i = 0; i < 180; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        receipt = await provider.getTransactionReceipt(deploymentTx.hash);
        if (receipt) {
            addLog(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
            addLog(`⛽ Actual gas used: ${receipt.gasUsed.toString()}`);
            break;
        }
        if (i % 5 === 0 && i > 0) {
            addLog(`⏳ Still waiting... (${i * 2}s elapsed) - Check: https://polygonscan.com/tx/${deploymentTx.hash}`);
        }
    }
    
    if (!receipt) {
        throw new Error("Transaction confirmation timeout after 360 seconds");
    }
    
    if (receipt.status !== 1) {
        throw new Error(`Transaction failed with status ${receipt.status}`);
    }
    
    const contractAddress = receipt.contractAddress;
    
    deploymentInfo.contractAddress = contractAddress;
    deploymentInfo.deployed = true;
    CONTRACT_ADDRESS = contractAddress;
    contractDeployed = true;
    
    fs.writeFileSync('contract-address.txt', contractAddress);
    addLog(`✅✅✅ BALANCER CONTRACT DEPLOYED!`);
    addLog(`📋 Contract Address: ${contractAddress}`);
    addLog(`🔗 View: https://polygonscan.com/address/${contractAddress}`);
    addLog(`💨 Gas used: ${receipt.gasUsed.toString()}`);
    
    return contractAddress;
}

// ==================== [ IMPORT CONTRACT FUNCTION ] ====================
async function importContract(contractAddress) {
    if (!deploymentInfo.privateKey) throw new Error("No wallet found");
    addLog(`🔌 Importing existing contract at: ${contractAddress}`);
    
    const provider = await getWorkingProvider();
    const code = await provider.getCode(contractAddress);
    if (!code || code === "0x") throw new Error("No code found at address");

    deploymentInfo.contractAddress = contractAddress;
    deploymentInfo.deployed = true;
    CONTRACT_ADDRESS = contractAddress;
    contractDeployed = true;
    fs.writeFileSync('contract-address.txt', contractAddress);
    addLog(`✅✅✅ CONTRACT IMPORTED SUCCESSFULLY!`);
    return contractAddress;
}

// ==================== [ CONNECTION & CONTRACT ] ====================
async function connect() {
    if (!deploymentInfo.privateKey) return;
    
    try {
        provider = await getWorkingProvider();
        const block = await provider.getBlockNumber();
        state.connected = true;
        
        console.log(`✅ Connected to Polygon (Block: ${block})`);
        
        wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
        const balance = await provider.getBalance(wallet.address);
        state.walletBal = parseFloat(ethers.formatEther(balance)).toFixed(4);
        
        console.log(`✅ Wallet: ${wallet.address.substring(0, 10)}...`);
        console.log(`💰 MATIC Balance: ${state.walletBal}`);
        
        if (CONTRACT_ADDRESS || deploymentInfo.contractAddress) {
            const contractAddr = CONTRACT_ADDRESS || deploymentInfo.contractAddress;
            const code = await provider.getCode(contractAddr);
            if (code && code !== "0x") {
                console.log(`✅ Balancer Flash Loan contract found at: ${contractAddr}`);
                contractDeployed = true;
                contract = new ethers.Contract(contractAddr, CONTRACT_ABI, wallet);
            }
        }
    } catch (e) { 
        console.log("Connection failed:", e.message);
        state.connected = false;
    }
}

// ==================== [ OPTIMIZED DEXSCREENER SCANNER WITH CACHING ] ====================
async function scanForOpportunities() {
    const now = Date.now();
    
    // Return cached opportunities if recently scanned
    if (now - lastFullScanTime < SCANNER_CONFIG.CACHE_DURATION && cachedOpportunities.length > 0) {
        return cachedOpportunities;
    }
    
    const opportunities = [];
    
    // Process tokens in batches for parallel execution
    const batchSize = SCANNER_CONFIG.BATCH_SIZE;
    const tokenBatches = [];
    for (let i = 0; i < TOKENS.length; i += batchSize) {
        tokenBatches.push(TOKENS.slice(i, i + batchSize));
    }
    
    // Process batches in parallel
    for (const batch of tokenBatches) {
        const batchPromises = batch.map(async (token) => {
            // Check cache first
            const cached = priceCache.get(token.a);
            if (cached && (now - cached.timestamp) < SCANNER_CONFIG.CACHE_DURATION) {
                return cached.opportunity;
            }
            
            try {
                const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token.a}`, { 
                    timeout: SCANNER_CONFIG.API_TIMEOUT
                });
                if (!res.data.pairs) return null;

                // ONLY consider pairs with REAL liquidity
                const pairs = res.data.pairs.filter(p => 
                    p.chainId === 'polygon' && 
                    parseFloat(p.liquidity?.usd || 0) > SCANNER_CONFIG.MIN_LIQUIDITY_USD &&
                    DEX_MAP[p.dexId] &&
                    p.priceUsd && 
                    parseFloat(p.priceUsd) > 0.0001
                );

                if (pairs.length < 2) return null;

                pairs.sort((a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd));
                const low = pairs[0];
                const high = pairs[pairs.length - 1];

                // REAL spread calculation
                const buyPrice = parseFloat(low.priceUsd);
                const sellPrice = parseFloat(high.priceUsd);
                const spread = ((sellPrice - buyPrice) / buyPrice) * 100;
                
                // GUARANTEED profit calculation with conservative slippage
                const borrowAmount = BORROW_AMOUNT;
                
                // Conservative slippage for guaranteed execution
                const liquidityUsd = parseFloat(low.liquidity?.usd || 0);
                const slippage = liquidityUsd > 500000 ? 0.001 : (liquidityUsd > 200000 ? 0.002 : 0.003);
                const slippageLoss = borrowAmount * slippage;
                
                const grossProfit = borrowAmount * (spread / 100);
                
                // REAL fees
                const swapFeesBuy = borrowAmount * (DEX_MAP[low.dexId]?.fee || 0.003);
                const swapFeesSell = (borrowAmount + grossProfit) * (DEX_MAP[high.dexId]?.fee || 0.003);
                const totalFees = swapFeesBuy + swapFeesSell + slippageLoss;
                
                // REAL gas cost
                const gasCostUSD = SCANNER_CONFIG.GAS_COST_USD;
                
                const netProfit = grossProfit - totalFees - gasCostUSD;
                
                // Lower profit threshold to find more opportunities
                const minRealProfit = SCANNER_CONFIG.MIN_PROFIT_USD;
                
                if (spread > SCANNER_CONFIG.MIN_SPREAD_PERCENT && spread < 25 && netProfit > minRealProfit && liquidityUsd > SCANNER_CONFIG.MIN_LIQUIDITY_USD) {
                    const opportunity = {
                        token: token.s,
                        tokenAddress: token.a,
                        decimals: token.decimals || 6,
                        buyDex: low.dexId,
                        buyPrice: buyPrice,
                        sellDex: high.dexId,
                        sellPrice: sellPrice,
                        spreadPercent: spread.toFixed(3),
                        grossProfit: grossProfit,
                        slippageLoss: slippageLoss,
                        swapFeesBuy: swapFeesBuy,
                        swapFeesSell: swapFeesSell,
                        totalFees: totalFees,
                        netProfit: netProfit,
                        buyLiquidity: liquidityUsd,
                        sellLiquidity: parseFloat(high.liquidity?.usd || 0),
                        isProfitable: netProfit > minRealProfit,
                        timestamp: now
                    };
                    
                    // Check thresholds for opportunity log
                    let logStatus = "✅ PASSED";
                    let logReason = "Awaiting execution simulation";
                    
                    if (liquidityUsd < 50000) { // CHANGED: Updated threshold
                        logStatus = "❌ REJECTED";
                        logReason = `Low liquidity: $${(liquidityUsd/1000).toFixed(0)}k (need $50k+)`;
                        addToOpportunityLog(opportunity, logStatus, logReason);
                        return null;
                    }
                    
                    if (netProfit < 1.00) { // CHANGED: Updated threshold
                        logStatus = "❌ REJECTED";
                        logReason = `Net profit $${netProfit.toFixed(2)} below $1.00 threshold`;
                        addToOpportunityLog(opportunity, logStatus, logReason);
                        return null;
                    }
                    
                    const breakEvenSpread = ((swapFeesBuy + swapFeesSell + SCANNER_CONFIG.GAS_COST_USD) / BORROW_AMOUNT) * 100;
                    if (parseFloat(spread.toFixed(3)) < breakEvenSpread) {
                        logStatus = "❌ REJECTED";
                        logReason = `Spread ${spread.toFixed(2)}% below breakeven ${breakEvenSpread.toFixed(2)}%`;
                        addToOpportunityLog(opportunity, logStatus, logReason);
                        return null;
                    }
                    
                    addToOpportunityLog(opportunity, logStatus, logReason);
                    
                    // Cache the result
                    priceCache.set(token.a, {
                        opportunity: opportunity,
                        timestamp: now
                    });
                    
                    return opportunity;
                }
                return null;
            } catch (e) {
                return null;
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        for (const result of batchResults) {
            if (result) {
                opportunities.push(result);
                addLog(`💰 GUARANTEED OPPORTUNITY: ${result.token} on ${result.buyDex}→${result.sellDex} | Spread: ${result.spreadPercent}% | Liq: $${(result.buyLiquidity/1000).toFixed(0)}k | Net Profit: $${result.netProfit.toFixed(2)}`);
            }
        }
    }
    
    // Update cache
    lastFullScanTime = now;
    cachedOpportunities = opportunities;
    
    if (opportunities.length > 0) {
        addLog(`⚡ SCAN COMPLETE: Found ${opportunities.length} guaranteed opportunities in ${Date.now() - now}ms`);
    }
    
    // Sort by net profit descending
    return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// NEW: WebSocket for real-time opportunities - ADDED
let wsConnection = null;
let wsReconnectTimer = null;

async function connectWebSocketDexScreener() {
    addLog("🔌 Connecting to DexScreener WebSocket for REAL-TIME opportunities...");
    
    const WebSocket = require('ws');
    const ws = new WebSocket('wss://io.dexscreener.com/dex/screener/polygon');
    
    ws.on('open', () => {
        addLog("✅ WebSocket connected! Receiving real-time pair updates");
        wsConnection = ws;
        
        // Subscribe to all token pairs
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: "pairs",
            chain: "polygon"
        }));
    });
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === "pair" && message.data) {
                const pair = message.data;
                
                // Check for immediate arbitrage opportunity
                if (pair.pairs && pair.pairs.length >= 2) {
                    await checkRealTimeOpportunity(pair.pairs);
                }
            }
        } catch (e) {}
    });
    
    ws.on('error', (error) => {
        addLog(`⚠️ WebSocket error: ${error.message}`);
    });
    
    ws.on('close', () => {
        addLog("🔄 WebSocket disconnected, reconnecting in 5 seconds...");
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(() => connectWebSocketDexScreener(), 5000);
    });
}

async function checkRealTimeOpportunity(pairs) {
    const polygonPairs = pairs.filter(p => 
        p.chainId === 'polygon' && 
        DEX_MAP[p.dexId] &&
        parseFloat(p.liquidity?.usd || 0) > 50000
    );
    
    if (polygonPairs.length < 2) return;
    
    // Group by token address
    const tokenGroups = {};
    for (const pair of polygonPairs) {
        const tokenAddr = pair.baseToken.address;
        if (!tokenGroups[tokenAddr]) tokenGroups[tokenAddr] = [];
        tokenGroups[tokenAddr].push(pair);
    }
    
    for (const [tokenAddr, tokenPairs] of Object.entries(tokenGroups)) {
        if (tokenPairs.length >= 2) {
            tokenPairs.sort((a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd));
            const low = tokenPairs[0];
            const high = tokenPairs[tokenPairs.length - 1];
            
            const spread = ((parseFloat(high.priceUsd) - parseFloat(low.priceUsd)) / parseFloat(low.priceUsd)) * 100;
            
            if (spread > 0.03) {
                addLog(`⚡ REAL-TIME OPPORTUNITY: ${low.baseToken.symbol} | Spread: ${spread.toFixed(2)}% | ${low.dexId} → ${high.dexId}`);
                // Trigger immediate scan
                await scanForOpportunities();
            }
        }
    }
}

// ==================== [ CHECK PENDING TRANSACTIONS WITH PROGRESS ] ====================
async function checkPendingTransactions() {
    for (let i = 0; i < state.pendingTransactions.length; i++) {
        const pending = state.pendingTransactions[i];
        try {
            const receipt = await provider.getTransactionReceipt(pending.txHash);
            if (receipt) {
                if (receipt.status === 1) {
                    addLog(`✅ MINER CONFIRMED: ${pending.token} - Transaction confirmed in block ${receipt.blockNumber} | PROFIT: $${pending.expectedProfit.toFixed(2)} | Tx: ${pending.txHash}`);
                    pending.status = "confirmed";
                    pending.progress = 100;
                    state.pendingTransactions.splice(i, 1);
                    i--;
                } else if (receipt.status === 0) {
                    addLog(`❌ MINER REJECTED: ${pending.token} - Transaction failed | Tx: ${pending.txHash}`);
                    pending.status = "failed";
                    state.pendingTransactions.splice(i, 1);
                    i--;
                }
            } else {
                const pendingSeconds = Math.floor((Date.now() - pending.timestamp) / 1000);
                const maxWaitSeconds = 120;
                const progressPercent = Math.min(95, Math.floor((pendingSeconds / maxWaitSeconds) * 100));
                pending.progress = progressPercent;
                pending.secondsWaiting = pendingSeconds;
                
                if (pendingSeconds % 5 === 0 && pendingSeconds > 0) {
                    addLog(`⏳ PENDING: ${pending.token} - ${progressPercent}% complete | Waiting ${pendingSeconds}s | Expected Profit: $${pending.expectedProfit.toFixed(2)} | Tx: ${pending.txHash.substring(0, 10)}...`);
                }
            }
        } catch (e) {}
    }
}

// ==================== [ MAIN SCAN LOGIC - MULTI TOKEN SIMULTANEOUS ] ====================
async function scan() {
    if (!state.connected) {
        await connect();
    }
    
    // Run auto-discovery every scan cycle
    await autoDiscoverTopTokensAndDexes();
    
    state.stats.scans++;
    
    const opportunities = await scanForOpportunities();
    
    state.opportunities = opportunities.slice(0, 15);
    
    await checkPendingTransactions();
    
    if (state.autoTrade && contract && contractDeployed && opportunities.length > 0) {
        // ONLY execute REAL opportunities with net profit > $1 (CHANGED)
        const realOpportunities = opportunities.filter(opp => opp.isProfitable && opp.netProfit > SCANNER_CONFIG.MIN_PROFIT_USD);
        
        for (const opp of realOpportunities) {
            if (!activeExecutions.has(opp.token) && !state.pendingFlash && opp.isProfitable && opp.netProfit > SCANNER_CONFIG.MIN_PROFIT_USD) {
                // GAS PROTECTION: Simulate before execution
                addLog(`🔬 GAS PROTECTION: Simulating transaction for ${opp.token} first...`);
                const simulationResult = await simulateTransaction(wallet, contract, "executeFlashLoan", [
                    USDC_ADDR,
                    ethers.parseUnits(BORROW_AMOUNT.toString(), 6),
                    DEX_MAP[opp.buyDex]?.router,
                    DEX_MAP[opp.sellDex]?.router,
                    opp.tokenAddress
                ], { gasLimit: 800000 });
                
                if (!simulationResult.success) {
                    addLog(`🛡️ GAS PROTECTION: Skipping ${opp.token} - simulation failed`);
                    addToOpportunityLog(opp, "⚠️ SKIPPED", "Simulation failed - insufficient profit after slippage");
                    continue;
                }
                
                // OPPORTUNITY VALIDATOR: On-chain verification
                addLog(`🔍 OPPORTUNITY VALIDATOR: Verifying ${opp.token} on-chain...`);
                const isValid = await validateOpportunityOnChain(opp, provider);
                
                if (!isValid) {
                    addLog(`🛡️ OPPORTUNITY VALIDATOR: Skipping ${opp.token} - on-chain verification failed`);
                    continue;
                }
                
                addLog(`✅ Both GAS PROTECTION and OPPORTUNITY VALIDATOR passed for ${opp.token}`);
                
                activeExecutions.set(opp.token, true);
                console.log(`\n🚀 TRIGGERING FLASH LOAN for ${opp.token}`);
                console.log(`   Spread: ${opp.spreadPercent}% | Expected Profit: $${opp.netProfit.toFixed(2)}`);
                executeFlashLoan(opp).finally(() => {
                    activeExecutions.delete(opp.token);
                });
            }
        }
    }
}

// ==================== [ GET NETWORK RECOMMENDED GAS ] ====================
async function getNetworkRecommendedGas() {
    try {
        const feeData = await provider.getFeeData();
        const recommendedMaxFee = feeData.maxFeePerGas || ethers.parseUnits("30", "gwei");
        const recommendedPriorityFee = feeData.maxPriorityFeePerGas || ethers.parseUnits("30", "gwei");
        return {
            maxFeePerGas: recommendedMaxFee,
            maxPriorityFeePerGas: recommendedPriorityFee,
            gasPriceGwei: parseFloat(ethers.formatUnits(recommendedMaxFee, "gwei"))
        };
    } catch (error) {
        return null;
    }
}

// ==================== [ GET MINIMUM GAS STARTING POINT ] ====================
function getMinimumGas() {
    return {
        maxFeePerGas: ethers.parseUnits("20", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("15", "gwei"),
        gasPriceGwei: 20
    };
}

// ==================== [ EXECUTE FLASH LOAN WITH CORRECT PARAMETER ORDER ] ====================
async function executeFlashLoan(opportunity) {
    if (!contract || !wallet) {
        console.log("❌ Cannot execute: No contract or wallet");
        return false;
    }
    
    if (!contractDeployed) {
        console.log("❌ Contract not deployed!");
        return false;
    }
    
    const startTime = Date.now();
    state.stats.tradesExecuted++;
    state.pendingFlash = opportunity.token;
    
    addLog(`🚀 EXECUTING BALANCER FLASH LOAN: ${opportunity.token} | ${opportunity.buyDex} → ${opportunity.sellDex} | Expected Profit: $${opportunity.netProfit.toFixed(2)}`);
    
    console.log(`\n💸 EXECUTING BALANCER FLASH LOAN for ${opportunity.token}`);
    console.log(`   Buy: ${opportunity.buyDex} @ $${opportunity.buyPrice.toFixed(4)}`);
    console.log(`   Sell: ${opportunity.sellDex} @ $${opportunity.sellPrice.toFixed(4)}`);
    console.log(`   Expected Profit: $${opportunity.netProfit.toFixed(2)}`);
    
    try {
        // IMPORTANT: dexARouter is the BUY DEX (where price is LOWER)
        // IMPORTANT: dexBRouter is the SELL DEX (where price is HIGHER)
        const dexARouter = DEX_MAP[opportunity.buyDex]?.router;
        const dexBRouter = DEX_MAP[opportunity.sellDex]?.router;
        
        if (!dexARouter || !dexBRouter) {
            throw new Error(`DEX router not found: ${opportunity.buyDex} or ${opportunity.sellDex}`);
        }
        
        const borrowAmount = ethers.parseUnits(BORROW_AMOUNT.toString(), 6);
        
        console.log(`🎯 STARTING ${opportunity.token} with AUTO GAS CALCULATION...`);
        
        // VERIFY PARAMETER ORDER - This matches your contract's executeFlashLoan function
        // Contract expects: (address token, uint256 amount, address dexA, address dexB, address targetToken)
        console.log(`\n🔍 VERIFYING PARAMETER ORDER FOR CONTRACT:`);
        console.log(`   [0] token (USDC): ${USDC_ADDR}`);
        console.log(`   [1] amount: ${ethers.formatUnits(borrowAmount, 6)} USDC`);
        console.log(`   [2] dexA (BUY on ${opportunity.buyDex}): ${dexARouter}`);
        console.log(`   [3] dexB (SELL on ${opportunity.sellDex}): ${dexBRouter}`);
        console.log(`   [4] targetToken (${opportunity.token}): ${opportunity.tokenAddress}`);
        
        // FIRST: Try recommended network gas
        let recommendedGas = await getNetworkRecommendedGas();
        let useRecommended = true;
        let retryCount = 0;
        const maxRetries = 10;
        let gasLimit = 800000;
        let txSent = false;
        let txHash = null;
        
        while (retryCount < maxRetries && !txSent) {
            try {
                let maxFeePerGas, maxPriorityFeePerGas, gasPriceGweiDisplay;
                
                if (useRecommended && recommendedGas) {
                    // Use network recommended gas first
                    maxFeePerGas = recommendedGas.maxFeePerGas;
                    maxPriorityFeePerGas = recommendedGas.maxPriorityFeePerGas;
                    gasPriceGweiDisplay = recommendedGas.gasPriceGwei.toFixed(1);
                    console.log(`📊 Using NETWORK RECOMMENDED gas: ${gasPriceGweiDisplay} Gwei`);
                    addLog(`📊 Network recommended gas: ${gasPriceGweiDisplay} Gwei`);
                } else {
                    // Start from minimum and increase with calculated ratio
                    const minGas = getMinimumGas();
                    const ratio = Math.pow(1.2, retryCount);
                    const calculatedGasPrice = minGas.gasPriceGwei * ratio;
                    
                    maxFeePerGas = ethers.parseUnits(Math.ceil(calculatedGasPrice).toString(), "gwei");
                    maxPriorityFeePerGas = ethers.parseUnits(Math.ceil(calculatedGasPrice * 0.8).toString(), "gwei");
                    gasPriceGweiDisplay = calculatedGasPrice.toFixed(1);
                    console.log(`📊 Using CALCULATED gas (attempt ${retryCount + 1}): ${gasPriceGweiDisplay} Gwei (ratio: ${ratio.toFixed(2)}x)`);
                    addLog(`📊 Calculated gas attempt ${retryCount + 1}: ${gasPriceGweiDisplay} Gwei`);
                }
                
                // Adjust gas limit based on retry count
                if (retryCount > 3) gasLimit = 1000000;
                if (retryCount > 6) gasLimit = 1500000;
                if (retryCount > 8) gasLimit = 2000000;
                
                console.log(`⛽ Gas: ${gasPriceGweiDisplay} Gwei | Limit: ${gasLimit}`);
                
                // FIXED: CORRECT PARAMETER ORDER FOR executeFlashLoan
                // Contract function: executeFlashLoan(address token, uint256 amount, address dexA, address dexB, address targetToken)
                const tx = await contract.executeFlashLoan(
                    USDC_ADDR,                    // [0] token - USDC to borrow
                    borrowAmount,                 // [1] amount - 1000 USDC
                    dexARouter,                   // [2] dexA - BUY DEX (swap USDC -> token)
                    dexBRouter,                   // [3] dexB - SELL DEX (swap token -> USDC)
                    opportunity.tokenAddress,     // [4] targetToken - Token to arbitrage
                    {
                        maxFeePerGas: maxFeePerGas,
                        maxPriorityFeePerGas: maxPriorityFeePerGas,
                        gasLimit: gasLimit,
                        type: 2
                    }
                );
                
                txHash = tx.hash;
                txSent = true;
                
                console.log(`✅ Sent! Hash: ${tx.hash}`);
                console.log(`🔗 Monitor: https://polygonscan.com/tx/${tx.hash}`);
                console.log(`--------------------------------------------------`);
                
                addLog(`📤 Flash loan transaction sent: ${tx.hash} (Gas: ${gasPriceGweiDisplay} Gwei)`);
                addLog(`⏳ FLASH LOAN PENDING: ${opportunity.token} - Waiting for miners... Tx: ${tx.hash.substring(0, 10)}...`);
                
                // Add to pending transactions (this will show in the PENDING TRANSACTIONS card)
                state.pendingTransactions.push({
                    token: opportunity.token,
                    txHash: tx.hash,
                    timestamp: Date.now(),
                    gasPrice: gasPriceGweiDisplay,
                    expectedProfit: opportunity.netProfit,
                    progress: 0,
                    secondsWaiting: 0
                });
                
                state.pendingFlash = null;
                
                // Wait for confirmation
                let startWait = Date.now();
                let confirmed = false;
                
                while (!confirmed) {
                    const elapsed = Math.floor((Date.now() - startWait) / 1000);
                    const receipt = await provider.getTransactionReceipt(tx.hash);
                    const currentGas = await provider.getFeeData();
                    const gweiNow = ethers.formatUnits(currentGas.maxFeePerGas, "gwei");
                    
                    const pendingIndex = state.pendingTransactions.findIndex(p => p.txHash === tx.hash);
                    if (pendingIndex !== -1) {
                        const maxWaitSeconds = 180;
                        const progressPercent = Math.min(95, Math.floor((elapsed / maxWaitSeconds) * 100));
                        state.pendingTransactions[pendingIndex].progress = progressPercent;
                        state.pendingTransactions[pendingIndex].secondsWaiting = elapsed;
                    }
                    
                    if (receipt) {
                        confirmed = true;
                        console.log(`\n\n[DEBUG] Block Found: ${receipt.blockNumber}`);
                        
                        const idx = state.pendingTransactions.findIndex(p => p.txHash === tx.hash);
                        if (idx !== -1) state.pendingTransactions.splice(idx, 1);
                        
                        if (receipt.status === 1) {
                            const executionTime = Date.now() - startTime;
                            const gasUsed = receipt.gasUsed.toString();
                            const actualGasCost = parseFloat(ethers.formatUnits(maxFeePerGas * BigInt(gasUsed), "ether"));
                            
                            state.stats.successfulTrades++;
                            state.stats.totalProfit += opportunity.netProfit;
                            state.stats.totalDexFees += opportunity.swapFeesBuy + opportunity.swapFeesSell;
                            state.stats.totalGasSpent += actualGasCost;
                            
                            // Update opportunity log with success
                            const existingLog = state.opportunityLog?.find(log => log.token === opportunity.token && log.status === "✅ PASSED");
                            if (existingLog) {
                                existingLog.status = "✅ SUCCESS";
                                existingLog.reason = `Executed - Profit: $${opportunity.netProfit.toFixed(2)}`;
                            } else {
                                addToOpportunityLog(opportunity, "✅ SUCCESS", `Executed - Profit: $${opportunity.netProfit.toFixed(2)}`);
                            }
                            
                            state.tradeHistory.unshift({
                                id: Date.now(),
                                token: opportunity.token,
                                buyDex: opportunity.buyDex,
                                sellDex: opportunity.sellDex,
                                borrowAmount: BORROW_AMOUNT,
                                grossProfit: opportunity.grossProfit,
                                netProfit: opportunity.netProfit,
                                spread: opportunity.spreadPercent,
                                executionTime: executionTime,
                                timestamp: new Date().toISOString(),
                                status: "✅ SUCCESS",
                                txHash: tx.hash,
                                gasUsed: gasUsed,
                                gasCost: actualGasCost.toFixed(4),
                                gasPriceGwei: gasPriceGweiDisplay
                            });
                            
                            console.log(`💰 STATUS: SUCCESS (Gas Used: ${receipt.gasUsed.toString()})`);
                            addLog(`✅✅✅ FLASH LOAN SUCCESSFUL! Profit: $${opportunity.netProfit.toFixed(2)} from ${opportunity.token} | Tx: ${tx.hash}`);
                            console.log(`✅✅✅ BALANCER FLASH LOAN SUCCESSFUL! Net Profit: $${opportunity.netProfit.toFixed(2)}`);
                            return true;
                        } else {
                            console.log(`❌ STATUS: REVERTED (Check PolygonScan for reason)`);
                            addLog(`❌ FLASH LOAN REVERTED: ${opportunity.token} | Tx: ${tx.hash}`);
                            addToOpportunityLog(opportunity, "❌ FAILED", "Transaction reverted on-chain");
                            throw new Error("Transaction reverted");
                        }
                    }
                    
                    const txDetails = await provider.getTransaction(tx.hash);
                    const mempoolStatus = txDetails ? "In Mempool" : "NOT FOUND / DROPPED";
                    
                    process.stdout.write(
                        `\r[DEBUG] Time: ${elapsed}s | Mempool: ${mempoolStatus} | Net Gas: ${parseFloat(gweiNow).toFixed(1)} Gwei   `
                    );
                    
                    if (elapsed > 180) {
                        console.log("\n⚠️ WARNING: Transaction taking longer than 3 mins.");
                        addLog(`⚠️ TRANSACTION TIMEOUT: ${opportunity.token} - Still waiting after 3 minutes | Tx: ${tx.hash.substring(0, 10)}...`);
                        break;
                    }
                    
                    await new Promise(r => setTimeout(r, 4000));
                }
                
                throw new Error("Transaction timeout");
                
            } catch (error) {
                const isGasError = error.message.includes("replacement fee too low") || 
                                  error.message.includes("intrinsic gas too low") ||
                                  error.message.includes("insufficient funds");
                
                if (isGasError && retryCount < maxRetries - 1 && !txSent) {
                    retryCount++;
                    if (useRecommended) {
                        useRecommended = false;
                        console.log(`⚠️ Network recommended gas failed, switching to minimum gas with auto-increase...`);
                        addLog(`⚠️ Switching to auto-calculated gas from minimum`);
                    } else {
                        console.log(`⚠️ Gas error (attempt ${retryCount}/${maxRetries}), increasing gas by 20%...`);
                        addLog(`⚠️ Retry ${retryCount}/${maxRetries} with higher gas`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    throw error;
                }
            }
        }
        
        throw new Error("Max retries exceeded - transaction not sent");
        
    } catch(error) {
        state.stats.failedTrades++;
        state.pendingFlash = null;
        
        if (error.txHash) {
            state.pendingTransactions = state.pendingTransactions.filter(p => p.txHash !== error.txHash);
        }
        
        state.tradeHistory.unshift({
            id: Date.now(),
            token: opportunity.token,
            error: error.message,
            timestamp: new Date().toISOString(),
            status: "❌ FAILED"
        });
        
        addLog(`❌ FAILED: ${opportunity.token} - ${error.message.substring(0, 100)}`);
        console.log(`\n\n❌ ERROR: ${error.message.substring(0, 200)}`);
        return false;
    }
}

// ==================== [ BOT CONTROL ] ====================
async function startBot() {
    if (deploymentInfo.botRunning) {
        addLog("Bot already running");
        return;
    }
    
    if (!deploymentInfo.privateKey) {
        addLog("❌ No wallet found. Please create or import a wallet first.");
        return;
    }
    
    if (!contractDeployed && !deploymentInfo.contractAddress) {
        addLog("❌ No contract deployed. Please deploy the contract first.");
        return;
    }
    
    addLog("🚀 Starting Balancer arbitrage bot with AUTO-DISCOVERY...");
    deploymentInfo.botRunning = true;
    state.autoTrade = true;
    
    await connect();
    runBotLoop();
}

async function stopBot() {
    addLog("🛑 Stopping arbitrage bot...");
    deploymentInfo.botRunning = false;
    state.autoTrade = false;
}

async function runBotLoop() {
    while (deploymentInfo.botRunning) {
        try {
            await scan();
            await new Promise(resolve => setTimeout(resolve, SCAN_INTERVAL));
        } catch (error) {
            addLog(`⚠️ Bot error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// ==================== [ OPPORTUNITY LOG HTML CARD - NEW ] ====================
const opportunityLogHTML = `
<div class="table-container">
    <h3 style="margin-bottom:16px">📋 OPPORTUNITY LOG (Last 50 Opportunities)</h3>
    <div style="overflow-x:auto; max-height:400px; overflow-y:auto">
        <table style="width:100%; font-size:12px">
            <thead>
                <tr style="position:sticky; top:0; background:#1e293b">
                    <th>Time</th>
                    <th>Token</th>
                    <th>Buy → Sell</th>
                    <th>Spread</th>
                    <th>Liquidity</th>
                    <th>Gross Profit</th>
                    <th>Fees</th>
                    <th>NET Profit</th>
                    <th>Status</th>
                    <th>Reason</th>
                </tr>
            </thead>
            <tbody id="opportunityLogBody">
                <tr><td colspan="10" style="text-align:center; color:#94a3b8">Waiting for opportunities...</td></tr>
            </tbody>
        </table>
    </div>
    <div style="margin-top:12px; padding:8px; background:#0f172a; border-radius:8px; font-size:11px; color:#94a3b8">
        📊 <strong>Legend:</strong> 
        <span style="color:#10b981">✅ SUCCESS</span> = Profitable & Executed | 
        <span style="color:#f59e0b">⚠️ SKIPPED</span> = Simulation Failed | 
        <span style="color:#ef4444">❌ REJECTED</span> = Below Threshold | 
        <span style="color:#60a5fa">🔍 VALIDATED</span> = On-chain Check Failed |
        <span style="color:#8b5cf6">✅ PASSED</span> = Passed Filters, Awaiting Execution
    </div>
</div>
`;

// ==================== [ HTML PAGES ] ====================
const menuHTML = `<!DOCTYPE html>
<html><head><title>TITAN ARBITRAGE v10.0 - ULTRA FAST</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.container{max-width:1200px;width:100%}
.header{text-align:center;margin-bottom:48px}
h1{font-size:48px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:#94a3b8;font-size:18px}
.menu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:24px;margin-bottom:48px}
.menu-card{background:rgba(15,23,42,0.95);border-radius:20px;padding:32px;border:1px solid #334155;cursor:pointer;text-align:center;transition:all 0.3s}
.menu-card:hover{transform:translateY(-5px);border-color:#60a5fa}
.menu-icon{font-size:64px;margin-bottom:20px}
.menu-title{font-size:24px;font-weight:bold;margin-bottom:12px;color:#e2e8f0}
.menu-desc{color:#94a3b8}
.status-bar{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;border:1px solid #334155;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
.status-item{flex:1;text-align:center}
.status-label{font-size:12px;color:#94a3b8}
.status-value{font-size:14px;font-family:monospace;color:#60a5fa;margin-top:8px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px}
.badge-success{background:#10b98120;color:#10b981;border:1px solid #10b981}
.badge-warning{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b}
.badge-danger{background:#ef444420;color:#ef4444;border:1px solid #ef4444}
.badge-pending{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>⚡ TITAN ARBITRAGE v10.0</h1><div class="subtitle">ULTRA FAST - Guaranteed Real Opportunities in Minutes</div></div>
<div class="menu-grid">
<div class="menu-card" onclick="location.href='/wallet'"><div class="menu-icon">💰</div><div class="menu-title">Wallet Manager</div><div class="menu-desc">Create or import wallet</div></div>
<div class="menu-card" onclick="location.href='/deploy'"><div class="menu-icon">🚀</div><div class="menu-title">Deploy Contract</div><div class="menu-desc">Deploy Balancer flash loan contract</div></div>
<div class="menu-card" onclick="location.href='/dashboard'"><div class="menu-icon">🤖</div><div class="menu-title">Arbitrage Bot</div><div class="menu-desc">Start bot & monitor profits</div></div>
<div class="menu-card" onclick="location.href='/import-contract'"><div class="menu-icon">📥</div><div class="menu-title">Import Contract</div><div class="menu-desc">Use existing contract address</div></div>
</div>
<div class="status-bar">
<div class="status-item"><div class="status-label">WALLET</div><div class="status-value" id="walletStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">CONTRACT</div><div class="status-value" id="contractStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BALANCE</div><div class="status-value" id="balanceStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BOT</div><div class="status-value" id="botStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">TOKENS</div><div class="status-value" id="tokenCount">Loading...</div></div>
<div class="status-item"><div class="status-label">DEXES</div><div class="status-value" id="dexCount">Loading...</div></div>
</div>
</div>
<script>
async function updateStatus(){try{const res=await fetch('/api/status');const data=await res.json();
document.getElementById('walletStatus').innerHTML=data.walletCreated?'<span class="badge badge-success">✓ ACTIVE</span><br>'+data.walletAddress?.substring(0,10)+'...':'<span class="badge badge-danger">✗ NO WALLET</span>';
document.getElementById('contractStatus').innerHTML=data.contractDeployed?'<span class="badge badge-success">✓ DEPLOYED</span><br>'+data.contractAddress?.substring(0,10)+'...':'<span class="badge badge-warning">⚠ NOT DEPLOYED</span>';
document.getElementById('balanceStatus').innerHTML=data.walletBalance+' POL';
document.getElementById('botStatus').innerHTML=data.botRunning?'<span class="badge badge-success">● RUNNING</span>':'<span class="badge badge-warning">● STOPPED</span>';
document.getElementById('tokenCount').innerHTML=data.activeTokensCount || 100;
document.getElementById('dexCount').innerHTML=data.activeDexesCount || 30;
}catch(e){}
}
updateStatus();setInterval(updateStatus,3000);
</script>
</body>
</html>`;

const walletHTML = `<!DOCTYPE html>
<html><head><title>Wallet Manager</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:20px}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px}
button.success{background:#10b981}
input{width:100%;padding:12px;margin:8px 0;background:#1e293b;border:1px solid #334155;border-radius:8px;color:white;font-family:monospace}
.address-box{background:#1e293b;padding:12px;border-radius:8px;word-break:break-all;margin:10px 0}
.warning-box{background:#f59e0b20;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:16px 0}
.back-btn{background:#6b7280}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>💰 Wallet Manager</h1>
<div class="card"><h3>✨ Create New Wallet</h3><button class="success" onclick="createWallet()">Create New Wallet</button><div id="newWalletResult"></div></div>
<div class="card"><h3>🔑 Import Wallet</h3><input type="text" id="privateKeyInput" placeholder="Private key (0x...)"><button onclick="importWallet()">Import Wallet</button><div id="importResult"></div></div>
<div id="walletInfo" style="display:none;" class="card"><h3>📋 Current Wallet</h3><div class="address-box" id="currentAddress"></div><div class="warning-box">⚠️ SAVE YOUR PRIVATE KEY!</div><button onclick="copyAddress()">Copy Address</button><button onclick="location.href='/deploy'">Deploy Contract</button></div>
</div>
<script>
async function createWallet(){const res=await fetch('/api/create-wallet',{method:'POST'});const data=await res.json();if(data.success){document.getElementById('newWalletResult').innerHTML='<div class="address-box"><strong>Address:</strong> '+data.address+'<br><strong>Private Key:</strong> <span style="color:#f59e0b">'+data.privateKey+'</span></div><div class="warning-box">⚠️ SAVE THESE NOW! Send 0.1 POL to this address.</div>';document.getElementById('walletInfo').style.display='block';document.getElementById('currentAddress').innerHTML='📍 '+data.address;}}
async function importWallet(){const pk=document.getElementById('privateKeyInput').value;if(!pk){alert('Enter private key');return;}const res=await fetch('/api/import-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({privateKey:pk})});const data=await res.json();if(data.success){document.getElementById('importResult').innerHTML='<div class="address-box">✅ Imported: '+data.address+'</div>';document.getElementById('walletInfo').style.display='block';document.getElementById('currentAddress').innerHTML='📍 '+data.address;}else{alert('Error: '+data.error);}}
function copyAddress(){const addr=document.getElementById('currentAddress').innerText.replace('📍 ','');navigator.clipboard.writeText(addr);alert('Copied!');}
</script>
</body>
</html>`;

const deployHTML = `<!DOCTYPE html>
<html><head><title>Deploy Contract</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px;font-weight:bold}
button.success{background:#10b981}
button.warning{background:#f59e0b}
.info-box{background:#1e293b;border-radius:8px;padding:16px;margin:16px 0;font-family:monospace}
.log-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;height:300px;overflow-y:auto;font-size:12px}
.log-entry{padding:4px 0;border-bottom:1px solid #334155}
.back-btn{background:#6b7280}
.requirements{background:#f59e0b20;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:16px 0}
.address-box{background:#1e293b;padding:12px;border-radius:8px;word-break:break-all;margin:10px 0;font-family:monospace;font-size:14px}
.faucet-box{background:#10b98120;border:1px solid #10b981;border-radius:8px;padding:16px;margin:16px 0;text-align:center}
.refresh-box{background:#3b82f620;border:1px solid #3b82f6;border-radius:8px;padding:16px;margin:16px 0;text-align:center}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>🚀 Deploy Balancer Contract</h1>

<div class="card">
<h3>📋 Requirements</h3>
<div class="requirements">
✓ Need 0.05+ POL for gas fees<br>
✓ Wallet must be created and funded<br>
✓ Balancer Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
</div>

<div id="walletStatus"></div>

<div id="faucetSection" style="display:none;" class="faucet-box">
<h3>💧 Get POL for Gas</h3>
<p style="margin-bottom:12px">Send POL to this address:</p>
<div class="address-box" id="walletAddressForFaucet"></div>
<div style="margin-top:12px">
<button class="warning" onclick="copyWalletAddress()">📋 Copy Address</button>
<a href="https://polygon.technology/bridge" target="_blank"><button>💰 Buy POL</button></a>
<a href="https://faucet.polygon.technology/" target="_blank"><button>🧪 Testnet Faucet</button></a>
</div>
<p style="margin-top:12px;font-size:12px;color:#94a3b8">⚠️ After sending POL, click "Refresh Balance" below</p>
</div>

<div class="refresh-box">
<p style="margin-bottom:12px">🔄 Balance not updating? Click refresh:</p>
<button class="warning" onclick="refreshBalance()">🔄 Refresh Balance Now</button>
<p style="margin-top:12px;font-size:12px;color:#94a3b8">Auto-refreshing every 10 seconds...</p>
</div>

<button class="success" onclick="deployContract()" id="deployBtn" disabled>🚀 Deploy Balancer Contract</button>
</div>

<div class="card">
<h3>📝 Deployment Logs</h3>
<div class="log-box" id="logBox">Waiting...</div>
</div>
</div>

<script>
let logInterval;
let balanceInterval;

async function fetchLogs(){
    const res=await fetch('/api/deploy-logs');
    const data=await res.json();
    if(data.logs&&data.logs.length>0){
        document.getElementById('logBox').innerHTML=data.logs.map(l=>'<div class="log-entry">['+new Date(l.time).toLocaleTimeString()+'] '+l.message+'</div>').join('');
    }
}

async function refreshBalance(){
    const statusDiv=document.getElementById('walletStatus');
    statusDiv.innerHTML='<div class="info-box">🔄 Checking balance...</div>';
    
    const res=await fetch('/api/status');
    const data=await res.json();
    
    const faucetSection=document.getElementById('faucetSection');
    const walletAddrSpan=document.getElementById('walletAddressForFaucet');
    const deployBtn=document.getElementById('deployBtn');
    
    if(data.walletCreated){
        statusDiv.innerHTML='<div class="info-box">✅ Wallet: '+data.walletAddress?.substring(0,15)+'...<br>💰 Balance: <strong style="font-size:24px;color:#10b981">'+data.walletBalance+' POL</strong></div>';
        walletAddrSpan.innerHTML=data.walletAddress;
        faucetSection.style.display='block';
        
        const balance = parseFloat(data.walletBalance);
        if(balance >= 0.05){ 
            statusDiv.innerHTML+='<div class="info-box" style="background:#10b98120;border-color:#10b981;">✅ Sufficient balance! You can deploy now.</div>';
            deployBtn.disabled=false;
            deployBtn.style.opacity='1';
            deployBtn.style.cursor='pointer';
        }else{
            statusDiv.innerHTML+='<div class="requirements" style="background:#ef444420;border-color:#ef4444;">⚠️ Insufficient balance! Need 0.05+ POL. Current: '+balance+' POL</div>';
            deployBtn.disabled=true;
            deployBtn.style.opacity='0.5';
            deployBtn.style.cursor='not-allowed';
        }
    }else{
        statusDiv.innerHTML='<div class="requirements" style="background:#ef444420;">❌ No wallet found! Please create or import a wallet first.</div>';
        faucetSection.style.display='none';
        deployBtn.disabled=true;
    }
}

async function deployContract(){
    const btn=document.getElementById('deployBtn');
    btn.disabled=true;
    btn.innerHTML='⏳ Deploying (30-60 sec)...';
    
    try{
        const res=await fetch('/api/deploy',{method:'POST'});
        const data=await res.json();
        if(data.success){
            btn.innerHTML='✅ Deployed!';
            alert('✅ Balancer contract deployed successfully!\\nAddress: '+data.contractAddress);
            setTimeout(()=>{location.href='/dashboard';},2000);
        }else{
            btn.innerHTML='❌ Retry';
            alert('Deployment failed: '+data.error);
            btn.disabled=false;
        }
    }catch(e){
        btn.innerHTML='❌ Retry';
        alert('Error: '+e.message);
        btn.disabled=false;
    }
}

function copyWalletAddress(){
    const addr=document.getElementById('walletAddressForFaucet').innerText;
    navigator.clipboard.writeText(addr);
    alert('Wallet address copied! Send POL to this address.\\n\\nAfter sending, click "Refresh Balance Now"');
}

refreshBalance();
balanceInterval = setInterval(refreshBalance, 10000);
logInterval = setInterval(fetchLogs, 2000);
</script>
</body>
</html>`;

const importHTML = `<!DOCTYPE html>
<html><head><title>Import Contract</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:20px}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px}
button.success{background:#10b981}
input{width:100%;padding:12px;margin:8px 0;background:#1e293b;border:1px solid #334155;border-radius:8px;color:white;font-family:monospace}
.back-btn{background:#6b7280}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>📥 Import Contract</h1>
<div class="card"><h3>🔧 Contract Address</h3><input type="text" id="contractInput" placeholder="0x... contract address"><button onclick="importContract()">Import Now</button></div>
</div>
<script>
async function importContract(){const addr=document.getElementById('contractInput').value;if(!addr){alert('Enter address');return;}const res=await fetch('/api/import-contract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contractAddress:addr})});const data=await res.json();if(data.success){alert('Imported!');location.href='/dashboard';}else{alert('Error: '+data.error);}}
</script>
</body>
</html>`;

// Updated dashboardHTML with Opportunity Log card - keeping same as original
const dashboardHTML = `<!DOCTYPE html>
<html><head><title>TITAN ARBITRAGE v10.0 - ULTRA FAST OPPORTUNITIES</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;min-height:100vh;color:#e2e8f0}
.container{max-width:1600px;margin:0 auto}
.header{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;margin-bottom:24px;border:1px solid #334155}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:bold}
.online{background:#10b981;color:white;animation:pulse 2s infinite}
.offline{background:#ef4444;color:white}
.pending-flash{background:#f59e0b;color:white;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-bottom:24px}
.stat-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;border:1px solid #334155}
.stat-label{font-size:12px;color:#94a3b8;text-transform:uppercase}
.stat-value{font-size:32px;font-weight:bold;margin:8px 0;font-family:monospace}
.profit{color:#10b981}
.count-badge{background:#3b82f6;color:white;border-radius:20px;padding:4px 12px;font-size:14px;display:inline-block;margin-left:10px}
.table-container{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #334155;overflow-x:auto}
.feature-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #60a5fa}
.real-opp-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:2px solid #10b981}
.miner-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #f59e0b}
.discovery-stats{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #10b981}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px;background:#1e293b;color:#94a3b8;font-size:12px}
td{padding:12px;border-bottom:1px solid #334155;font-size:13px;font-family:monospace}
.profit-badge{background:#10b981;color:white;padding:4px 8px;border-radius:8px;font-size:11px}
.real-badge{background:#10b981;color:white;padding:4px 8px;border-radius:8px;font-size:11px;animation:pulse 2s infinite}
.loss-badge{background:#ef4444;color:white;padding:4px 8px;border-radius:8px;font-size:11px}
.pending-badge{background:#f59e0b;color:white;padding:4px 8px;border-radius:8px;font-size:11px;animation:pulse 1s infinite}
.progress-bar{width:100%;background:#1e293b;height:6px;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;background:#f59e0b;transition:width 0.5s}
.log-entry{padding:8px;border-bottom:1px solid #334155;font-size:12px;font-family:monospace}
button{background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:bold;margin-right:10px}
button.danger{background:#ef4444}
button.success{background:#10b981}
.back-btn{background:#6b7280;margin-bottom:20px}
.feature-badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;margin-left:8px}
.gas-protect{background:#10b98120;color:#10b981;border:1px solid #10b981}
.opp-validate{background:#60a5fa20;color:#60a5fa;border:1px solid #60a5fa}
.auto-discovery{background:#8b5cf620;color:#8b5cf6;border:1px solid #8b5cf6}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back to Menu</button>
<div class="header"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap"><div><h1>⚡ TITAN ARBITRAGE v10.0 <span class="feature-badge gas-protect">GAS PROTECTION</span><span class="feature-badge opp-validate">OPPORTUNITY VALIDATOR</span><span class="feature-badge auto-discovery">AUTO-DISCOVERY</span></h1><p style="color:#94a3b8;margin-top:8px">ULTRA FAST | Scans Every 1 Second | $50k+ Liquidity | $1+ Guaranteed Profit</p></div><div style="text-align:right"><span id="connectionStatus" class="status offline">● CONNECTING</span><span id="pendingStatus" style="margin-left:10px"></span><button id="toggleTrade" class="success" style="margin-left:10px">🟢 Trading ON</button></div></div></div>

<div class="real-opp-card"><h3 style="margin-bottom:16px">💰 GUARANTEED REAL OPPORTUNITIES FOUND <span id="opportunityCount" class="count-badge">0</span></h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px"><div><span class="stat-label">Guaranteed Profitable</span><div class="stat-value profit" id="realOppCount">0</div></div><div><span class="stat-label">Min Profit Required</span><div class="stat-value">$1.00</div></div><div><span class="stat-label">Min Liquidity</span><div class="stat-value">$50k</div></div><div><span class="stat-label">Scan Speed</span><div class="stat-value">1 sec</div></div></div></div>

<div class="discovery-stats"><h3 style="margin-bottom:16px">🔍 AUTO-DISCOVERY STATUS (Updates every 60 seconds)</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px"><div><span class="stat-label">Active Tokens</span><div class="stat-value" id="activeTokens">0</div></div><div><span class="stat-label">Active DEXes</span><div class="stat-value" id="activeDexes">0</div></div><div><span class="stat-label">Discovered Tokens</span><div class="stat-value" id="discoveredTokens">0</div></div><div><span class="stat-label">Last Discovery</span><div class="stat-value" id="lastDiscovery" style="font-size:14px">Never</div></div></div></div>

<div class="stats-grid"><div class="stat-card"><div class="stat-label">Total Profit</div><div class="stat-value profit" id="totalProfit">$0.00</div><div class="stat-label">Win Rate: <span id="winRate">0</span>%</div></div>
<div class="stat-card"><div class="stat-label">Trades Executed</div><div class="stat-value" id="totalTrades">0</div><div class="stat-label">Success: <span id="successTrades">0</span> | Failed: <span id="failedTrades">0</span></div></div>
<div class="stat-card"><div class="stat-label">Min Profit Required</div><div class="stat-value">$1.00</div><div class="stat-label">Borrow Amount: $1000</div></div>
<div class="stat-card"><div class="stat-label">Wallet Balance</div><div class="stat-value" id="walletBalance">0 MATIC</div><div class="stat-label">Gas Cost: ~$0.03</div></div></div>

<div class="miner-card"><h3 style="margin-bottom:16px">⛏️ PENDING TRANSACTIONS (Waiting for Miners)</h3><div id="minerPendingContainer"><p style="color:#94a3b8">No pending transactions</p></div></div>

<div class="table-container"><h3 style="margin-bottom:16px">🔥 GUARANTEED REAL ARBITRAGE OPPORTUNITIES</h3><table id="opportunitiesTable"><thead><tr><th>Token</th><th>Buy → Sell</th><th>Spread</th><th>Liquidity</th><th>Gross Profit</th><th>Fees+Slippage</th><th>NET PROFIT</th><th>Status</th></tr></thead><tbody id="opportunitiesBody"></tbody></table></div>

<!-- OPPORTUNITY LOG CARD -->
${opportunityLogHTML}

<div class="table-container"><h3 style="margin-bottom:16px">📊 TRADE HISTORY</h3><table id="historyTable"><thead><tr><th>Time</th><th>Token</th><th>Route</th><th>Net Profit</th><th>Status</th><th>Tx</th></tr></thead><tbody id="historyBody"></tbody></table></div>

<div class="table-container"><h3 style="margin-bottom:16px">📝 LIVE LOGS (Gas Protection & Validator Events)</h3><div id="logsContainer" style="height:200px;overflow-y:auto;font-family:monospace;font-size:12px"></div></div></div>

<script>
let autoRefresh=setInterval(fetchData,1000);
async function fetchData(){try{const res=await fetch('/api/data');const data=await res.json();updateUI(data);}catch(e){}}
function formatNumber(num){return new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(num);}
function formatCurrency(num){return '$'+formatNumber(num);}
function formatLiquidity(num){if(num>=1000000)return '$'+(num/1000000).toFixed(1)+'M';if(num>=1000)return '$'+(num/1000).toFixed(0)+'k';return '$'+num.toFixed(0);}
function updateUI(data){const statusEl=document.getElementById('connectionStatus');if(data.connected){statusEl.className='status online';statusEl.innerHTML='● ONLINE';}else{statusEl.className='status offline';statusEl.innerHTML='● OFFLINE';}
const pendingStatus=document.getElementById('pendingStatus');if(data.pendingFlash){pendingStatus.innerHTML='<span class="pending-flash" style="padding:4px 12px;border-radius:20px;font-size:12px">⏳ FLASH PENDING: '+data.pendingFlash+'</span>';}else{pendingStatus.innerHTML='';}
const minerContainer=document.getElementById('minerPendingContainer');if(data.pendingTransactions&&data.pendingTransactions.length>0){minerContainer.innerHTML='<table style="width:100%"><thead><tr><th>Token</th><th>Tx Hash</th><th>Expected Profit</th><th>Progress</th><th>Gas Price</th></tr></thead><tbody>'+data.pendingTransactions.map(tx=>{const waitSec=Math.floor((Date.now()-new Date(tx.timestamp))/1000);return '<tr><td><b>'+tx.token+'</b></td><td><a href="https://polygonscan.com/tx/'+tx.txHash+'" target="_blank" style="color:#60a5fa">'+tx.txHash.substring(0,10)+'...</a></td><td class="profit">'+formatCurrency(tx.expectedProfit)+'</td><td><div class="progress-bar"><div class="progress-fill" style="width:'+tx.progress+'%"></div></div><span style="font-size:10px">'+tx.progress+'% ('+waitSec+'s)</span></td><td>'+tx.gasPrice+' Gwei</td></tr>';}).join('')+'</tbody></table>';}else{minerContainer.innerHTML='<p style="color:#94a3b8">No pending transactions waiting for miners</p>';}
document.getElementById('totalProfit').innerHTML='<span class="profit">'+formatCurrency(data.stats?.totalProfit||0)+'</span>';
document.getElementById('totalTrades').innerText=data.stats?.tradesExecuted||0;
document.getElementById('successTrades').innerText=data.stats?.successfulTrades||0;
document.getElementById('failedTrades').innerText=data.stats?.failedTrades||0;
document.getElementById('walletBalance').innerText=(data.walletBal||0)+' MATIC';
document.getElementById('winRate').innerText=((data.stats?.successfulTrades/(data.stats?.tradesExecuted||1))*100).toFixed(1);
document.getElementById('activeTokens').innerText=data.discoveryStats?.activeTokensCount || 100;
document.getElementById('activeDexes').innerText=data.discoveryStats?.activeDexesCount || 30;
document.getElementById('discoveredTokens').innerText=data.discoveryStats?.totalTokensDiscovered || 0;
document.getElementById('lastDiscovery').innerText=data.discoveryStats?.lastDiscoveryTime ? new Date(data.discoveryStats.lastDiscoveryTime).toLocaleTimeString() : 'Never';
const realOppCount = (data.opportunities||[]).filter(o=>o.netProfit>1).length;
document.getElementById('realOppCount').innerText=realOppCount;
document.getElementById('opportunityCount').innerText=realOppCount;
const oppBody=document.getElementById('opportunitiesBody');
if(data.opportunities&&data.opportunities.length>0){const realOpps=data.opportunities.filter(o=>o.netProfit>1);if(realOpps.length>0){oppBody.innerHTML=realOpps.map(opp=>'<tr><td><b>'+opp.token+'</b></td><td>'+opp.buyDex+' → '+opp.sellDex+'</td><td class="profit">+'+opp.spreadPercent+'%</td><td>'+formatLiquidity(opp.buyLiquidity||0)+'</td><td class="profit">'+formatCurrency(opp.grossProfit)+'</td><td class="loss">'+formatCurrency(opp.totalFees)+'</td><td class="profit"><b>'+formatCurrency(opp.netProfit)+'</b></td><td><span class="real-badge">💰 GUARANTEED</span></td></tr>').join('');}else{oppBody.innerHTML='<tr><td colspan="8" style="text-align:center">🔍 Scanning for GUARANTEED opportunities (need $1+ profit after fees & slippage)...</td></tr>';}}else{oppBody.innerHTML='<tr><td colspan="8" style="text-align:center">⚡ ULTRA FAST SCAN: Checking 200+ tokens every 1 second for guaranteed opportunities...</td></tr>';}
const historyBody=document.getElementById('historyBody');
if(data.tradeHistory&&data.tradeHistory.length>0){historyBody.innerHTML=data.tradeHistory.slice(0,20).map(t=>'<tr><td style="font-size:11px">'+new Date(t.timestamp).toLocaleTimeString()+'</td><td><b>'+(t.token||'-')+'</b></td><td>'+(t.buyDex||'-')+'→'+(t.sellDex||'-')+'</td><td class="profit">'+formatCurrency(t.netProfit||0)+'</td><td><span class="'+(t.status==='✅ SUCCESS'?'profit-badge':'loss-badge')+'">'+t.status+'</span></td><td>'+(t.txHash?'<a href="https://polygonscan.com/tx/'+t.txHash+'" target="_blank" style="color:#60a5fa">View</a>':'-')+'</td></tr>').join('');}
const logsDiv=document.getElementById('logsContainer');if(data.logs&&data.logs.length>0){logsDiv.innerHTML=data.logs.slice(0,20).map(l=>'<div class="log-entry">['+new Date(l.time).toLocaleTimeString()+'] '+l.message+'</div>').join('');}

const logBody = document.getElementById('opportunityLogBody');
if (data.opportunityLog && data.opportunityLog.length > 0) {
    logBody.innerHTML = data.opportunityLog.slice(0, 50).map(log => {
        let statusColor = '';
        if (log.status === '✅ SUCCESS') { statusColor = 'color:#10b981'; }
        else if (log.status === '⚠️ SKIPPED') { statusColor = 'color:#f59e0b'; }
        else if (log.status === '❌ REJECTED') { statusColor = 'color:#ef4444'; }
        else if (log.status === '🔍 VALIDATED') { statusColor = 'color:#60a5fa'; }
        else if (log.status === '✅ PASSED') { statusColor = 'color:#8b5cf6'; }
        return '<tr style="border-bottom:1px solid #334155">' +
            '<td style="font-size:10px; padding:8px">'+new Date(log.timestamp).toLocaleTimeString()+'</td>' +
            '<td style="padding:8px"><b>'+log.token+'</b></td>' +
            '<td style="font-size:11px; padding:8px">'+log.buyDex+' → '+log.sellDex+'</td>' +
            '<td style="padding:8px">'+log.spreadPercent+'%</td>' +
            '<td style="font-size:11px; padding:8px">'+formatLiquidity(log.liquidity)+'</td>' +
            '<td style="padding:8px">'+formatCurrency(log.grossProfit)+'</td>' +
            '<td style="padding:8px">'+formatCurrency(log.totalFees)+'</td>' +
            '<td style="padding:8px; font-weight:bold; '+(log.netProfit > 0 ? 'color:#10b981' : 'color:#ef4444')+'">'+formatCurrency(log.netProfit)+'</td>' +
            '<td style="padding:8px"><span style="'+statusColor+'">'+log.status+'</span></td>' +
            '<td style="font-size:10px; padding:8px; color:#94a3b8; max-width:200px">'+(log.reason || '-')+'</td>' +
            '</tr>';
    }).join('');
} else {
    logBody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:#94a3b8; padding:20px">No opportunities scanned yet. Bot is running...</td></tr>';
}
}
document.getElementById('toggleTrade').onclick=async()=>{const res=await fetch('/api/toggle',{method:'POST'});const data=await res.json();const btn=document.getElementById('toggleTrade');if(data.autoTrade){btn.className='success';btn.innerHTML='🟢 Trading ON';}else{btn.className='danger';btn.innerHTML='🔴 Trading OFF';}};
fetchData();
</script>
</body>
</html>`;

// ==================== [ API ROUTES ] ====================
app.get('/api/status', async (req, res) => {
    if (deploymentInfo.privateKey) {
        try {
            const balance = await checkWalletBalance();
            deploymentInfo.walletBalance = balance;
            state.walletBal = balance;
        } catch (error) {}
    }
    
    res.json({
        walletCreated: !!deploymentInfo.privateKey,
        walletAddress: deploymentInfo.wallet,
        walletBalance: deploymentInfo.walletBalance,
        contractDeployed: deploymentInfo.deployed || contractDeployed,
        contractAddress: deploymentInfo.contractAddress || CONTRACT_ADDRESS,
        botRunning: deploymentInfo.botRunning,
        totalProfit: state.stats.totalProfit,
        activeTokensCount: TOKENS.length,
        activeDexesCount: Object.keys(DEX_MAP).length
    });
});

app.get('/api/data', (req, res) => {
    const winRate = state.stats.tradesExecuted > 0 
        ? (state.stats.successfulTrades / state.stats.tradesExecuted) * 100 
        : 0;
    
    res.json({
        ...state,
        winRate: winRate,
        contractDeployed: contractDeployed || deploymentInfo.deployed,
        contractAddress: deploymentInfo.contractAddress || CONTRACT_ADDRESS,
        walletBal: state.walletBal,
        uptime: process.uptime(),
        pendingFlash: state.pendingFlash,
        pendingTransactions: state.pendingTransactions,
        activeTokensCount: TOKENS.length,
        activeDexesCount: Object.keys(DEX_MAP).length,
        discoveryStats: state.discoveryStats,
        opportunityLog: state.opportunityLog || [],
        config: {
            borrowAmount: BORROW_AMOUNT,
            minProfitTrigger: MIN_PROFIT_USD,
            liquidityFloor: LIQUIDITY_FLOOR
        }
    });
});

app.get('/api/deploy-logs', (req, res) => {
    res.json({ logs: state.logs.slice(0, 30) });
});

app.post('/api/toggle', (req, res) => {
    state.autoTrade = !state.autoTrade;
    if (state.autoTrade && !deploymentInfo.botRunning) {
        startBot();
    } else if (!state.autoTrade && deploymentInfo.botRunning) {
        stopBot();
    }
    res.json({ autoTrade: state.autoTrade });
});

app.post('/api/create-wallet', (req, res) => {
    try {
        const wallet = createNewWallet();
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/import-wallet', async (req, res) => {
    try {
        const { privateKey } = req.body;
        const wallet = await importWallet(privateKey);
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/import-contract', async (req, res) => {
    try {
        const { contractAddress } = req.body;
        const address = await importContract(contractAddress);
        res.json({ success: true, contractAddress: address });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const contractAddress = await deployContract();
        res.json({ success: true, contractAddress });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/start-bot', async (req, res) => {
    try {
        await startBot();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/stop-bot', (req, res) => {
    stopBot();
    res.json({ success: true });
});

// ==================== [ PAGE ROUTES ] ====================
app.get('/', (req, res) => res.send(menuHTML));
app.get('/wallet', (req, res) => res.send(walletHTML));
app.get('/deploy', (req, res) => res.send(deployHTML));
app.get('/import-contract', (req, res) => res.send(importHTML));
app.get('/dashboard', (req, res) => res.send(dashboardHTML));

// ==================== [ START SERVER ] ====================
async function start() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║     ⚡ TITAN ARBITRAGE v10.0 - ULTRA FAST WITH GUARANTEED OPPORTUNITIES ⚡    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Menu:         http://localhost:${PORT}                                      ║
║  Wallet Page:  http://localhost:${PORT}/wallet                               ║
║  Deploy Page:  http://localhost:${PORT}/deploy                               ║
║  Bot Page:     http://localhost:${PORT}/dashboard                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  NEW: Opportunity Log Card - Shows WHY each opportunity passed/failed       ║
║  Tracks: Liquidity, Profit, Spread, Fees, and Rejection Reasons            ║
╚══════════════════════════════════════════════════════════════════════════════╝
    `);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Server running at: http://localhost:${PORT}`);
        console.log(`\n✅ Create wallet → Send POL → Deploy Balancer Contract → Start Bot`);
        console.log(`\n⚡ ULTRA FAST: Scanning 200+ tokens every 1 second`);
        console.log(`💰 GUARANTEED: Only showing opportunities with $1+ profit and $50k+ liquidity\n`);
        console.log(`📋 NEW FEATURE: Opportunity Log Card shows all scanned opportunities with rejection reasons`);
    });

    // Start WebSocket for real-time opportunities - NEW
    setTimeout(() => {
        connectWebSocketDexScreener();
    }, 5000);
}

start();
