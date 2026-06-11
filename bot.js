require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');

// ==================== CONFIGURATION ====================
const CONFIG = {
    // BNB Chain RPC (free public endpoints)
    rpcUrl: 'https://bsc-dataseed.binance.org/',
    wsUrl: 'wss://bsc-ws-node.nariox.org:443',
    
    // PancakeSwap Contracts
    pancakeswap: {
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        name: 'PancakeSwap'
    },
    
    // Token Addresses on BSC
    tokens: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        USDT: '0x55d398326f99059fF775485246999027B3197955',
        CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        DOGE: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
        SHIB: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D'
    },
    
    // Trading pairs to monitor (path: token0 -> token1 -> token0)
    pairs: [
        { name: 'BNB-BUSD-BNB', path: ['WBNB', 'BUSD', 'WBNB'], minProfit: 0.003 },
        { name: 'BNB-USDT-BNB', path: ['WBNB', 'USDT', 'WBNB'], minProfit: 0.003 },
        { name: 'CAKE-BNB-CAKE', path: ['CAKE', 'WBNB', 'CAKE'], minProfit: 0.005 },
        { name: 'DOGE-BUSD-DOGE', path: ['DOGE', 'BUSD', 'DOGE'], minProfit: 5 },
        { name: 'SHIB-BUSD-SHIB', path: ['SHIB', 'BUSD', 'SHIB'], minProfit: 100000 }
    ],
    
    // Bot Settings
    scanIntervalMs: 2000,      // Check every 2 seconds
    gasPriceGwei: 3,           // Gas price for transactions
    gasLimit: 500000,          // Gas limit
    slippageTolerance: 0.5,    // 0.5% slippage
    minProfitBNB: 0.002,       // Minimum profit in BNB to execute (about $0.60)
    
    // Flash Loan Settings (Aave on BSC)
    aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    
    // File logging
    logFile: 'arbitrage.log'
};

// ==================== ABIs ====================
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

const TOKEN_ABI = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function balanceOf(address) view returns (uint)',
    'function approve(address spender, uint amount) returns (bool)'
];

// ==================== STATE ====================
let provider;
let wallet;
let router;
let isRunning = true;
let opportunitiesFound = 0;
let tradesExecuted = 0;
let totalProfitBNB = 0;
let lastScanTime = Date.now();

// ==================== INITIALIZATION ====================
async function init() {
    console.log('\n' + '='.repeat(60));
    console.log('🥞 PANCAKESWAP ARBITRAGE BOT');
    console.log('='.repeat(60));
    
    // Check for private key
    if (!process.env.PRIVATE_KEY) {
        console.error('\n❌ ERROR: Missing PRIVATE_KEY in .env file!');
        console.error('   Create a .env file with: PRIVATE_KEY=your_wallet_private_key\n');
        process.exit(1);
    }
    
    // Connect to BSC
    provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    router = new ethers.Contract(CONFIG.pancakeswap.router, ROUTER_ABI, wallet);
    
    const balance = await provider.getBalance(wallet.address);
    const balanceBNB = ethers.utils.formatEther(balance);
    
    console.log(`\n✅ Bot Initialized`);
    console.log(`📡 Network: BNB Smart Chain`);
    console.log(`👛 Wallet: ${wallet.address}`);
    console.log(`💰 Balance: ${balanceBNB} BNB ($${(parseFloat(balanceBNB) * 580).toFixed(2)})`);
    console.log(`⏱️  Scan Interval: ${CONFIG.scanIntervalMs}ms`);
    console.log(`🎯 Min Profit: ${CONFIG.minProfitBNB} BNB`);
    console.log(`\n🔍 Scanning for arbitrage opportunities...\n`);
    
    // Log initial balance to file
    logToFile(`Bot started | Balance: ${balanceBNB} BNB | Wallet: ${wallet.address}`);
    
    return true;
}

// ==================== HELPER FUNCTIONS ====================
function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(CONFIG.logFile, `${timestamp} - ${message}\n`);
}

async function getTokenDecimals(tokenAddress) {
    const token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
    try {
        return await token.decimals();
    } catch (e) {
        return 18;
    }
}

function formatAmount(amount, decimals) {
    return ethers.utils.formatUnits(amount, decimals);
}

// ==================== CORE ARBITRAGE LOGIC ====================

async function getPriceQuote(amountIn, pathAddresses) {
    try {
        const amounts = await router.getAmountsOut(amountIn, pathAddresses);
        return amounts;
    } catch (error) {
        return null;
    }
}

async function checkTriangleArbitrage(path, amountInBNB = 0.01) {
    try {
        // Convert path names to addresses
        const pathAddresses = path.map(token => CONFIG.tokens[token]);
        
        // Amount in (in wei)
        const amountIn = ethers.utils.parseEther(amountInBNB.toString());
        
        // Get quote for the triangle
        const quote = await getPriceQuote(amountIn, pathAddresses);
        
        if (!quote || quote.length < 3) return null;
        
        const amountOut = quote[quote.length - 1];
        
        // Calculate profit
        const profit = amountOut.sub(amountIn);
        const profitBNB = parseFloat(ethers.utils.formatEther(profit));
        
        // Calculate percentage gain
        const percentGain = (profitBNB / amountInBNB) * 100;
        
        return {
            profit: profit,
            profitBNB: profitBNB,
            percentGain: percentGain,
            amountIn: amountIn,
            amountOut: amountOut,
            path: path
        };
    } catch (error) {
        return null;
    }
}

async function executeArbitrage(opportunity) {
    const { path, amountIn, amountOut, profitBNB } = opportunity;
    
    console.log(`\n🚀 EXECUTING ARBITRAGE!`);
    console.log(`   Path: ${path.join(' → ')}`);
    console.log(`   Expected Profit: ${profitBNB.toFixed(6)} BNB ($${(profitBNB * 580).toFixed(2)})`);
    
    const pathAddresses = path.map(token => CONFIG.tokens[token]);
    const amountOutMin = amountOut.mul(100 - CONFIG.slippageTolerance).div(100);
    const deadline = Math.floor(Date.now() / 1000) + 120;
    
    try {
        // Estimate gas
        const gasPrice = ethers.utils.parseUnits(CONFIG.gasPriceGwei.toString(), 'gwei');
        
        // Execute the swap
        const tx = await router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            pathAddresses,
            wallet.address,
            deadline,
            { gasPrice: gasPrice, gasLimit: CONFIG.gasLimit }
        );
        
        console.log(`   📝 Transaction sent: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            tradesExecuted++;
            totalProfitBNB += profitBNB;
            
            console.log(`   ✅ SUCCESS! Transaction confirmed in block ${receipt.blockNumber}`);
            console.log(`   💰 Profit: ${profitBNB.toFixed(6)} BNB`);
            
            logToFile(`TRADE EXECUTED | Path: ${path.join('-')} | Profit: ${profitBNB.toFixed(6)} BNB | Tx: ${tx.hash}`);
            
            return true;
        } else {
            console.log(`   ❌ Transaction failed`);
            logToFile(`TRADE FAILED | Path: ${path.join('-')} | Tx: ${tx.hash}`);
            return false;
        }
    } catch (error) {
        console.log(`   ❌ Error: ${error.message.slice(0, 100)}`);
        return false;
    }
}

async function checkAndExecuteFlashLoanArbitrage() {
    // Flash loan requires a smart contract deployment
    // This is a simplified check for triangle arbitrage without flash loans
    
    for (const pair of CONFIG.pairs) {
        try {
            // Check arbitrage with small amount first (0.01 BNB)
            const opportunity = await checkTriangleArbitrage(pair.path, 0.01);
            
            if (opportunity && opportunity.profitBNB > pair.minProfit) {
                opportunitiesFound++;
                
                console.log(`\n📈 OPPORTUNITY FOUND!`);
                console.log(`   Pair: ${pair.name}`);
                console.log(`   Profit: ${opportunity.profitBNB.toFixed(6)} BNB (${opportunity.percentGain.toFixed(3)}%)`);
                
                // Scale up to use available balance
                const balance = await provider.getBalance(wallet.address);
                const maxAmount = balance.div(2); // Use 50% of balance max
                const maxAmountBNB = parseFloat(ethers.utils.formatEther(maxAmount));
                
                if (maxAmountBNB > 0.05) { // Minimum 0.05 BNB to trade
                    const scaledOpportunity = await checkTriangleArbitrage(pair.path, Math.min(0.5, maxAmountBNB));
                    
                    if (scaledOpportunity && scaledOpportunity.profitBNB > CONFIG.minProfitBNB) {
                        await executeArbitrage(scaledOpportunity);
                    }
                }
            }
        } catch (error) {
            // Silent fail for individual pair checks
        }
    }
}

// ==================== MULTI-DEX ARBITRAGE ====================

async function checkCrossDEXArbitrage() {
    // Compare prices between PancakeSwap and other DEXes
    const amountIn = ethers.utils.parseEther('0.1'); // 0.1 BNB test amount
    
    const dexes = [
        { name: 'PancakeSwap', router: CONFIG.pancakeswap.router },
        { name: 'BiSwap', router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' },
        { name: 'ApeSwap', router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7' }
    ];
    
    const tokenPairs = [
        { base: 'WBNB', quote: 'BUSD', baseAddress: CONFIG.tokens.WBNB, quoteAddress: CONFIG.tokens.BUSD },
        { base: 'WBNB', quote: 'USDT', baseAddress: CONFIG.tokens.WBNB, quoteAddress: CONFIG.tokens.USDT },
        { base: 'CAKE', quote: 'WBNB', baseAddress: CONFIG.tokens.CAKE, quoteAddress: CONFIG.tokens.WBNB }
    ];
    
    for (const pair of tokenPairs) {
        const prices = {};
        
        for (const dex of dexes) {
            try {
                const tempRouter = new ethers.Contract(dex.router, ROUTER_ABI, provider);
                const amounts = await tempRouter.getAmountsOut(amountIn, [pair.baseAddress, pair.quoteAddress]);
                prices[dex.name] = amounts[1];
            } catch (e) {}
        }
        
        // Find price differences
        const dexNames = Object.keys(prices);
        for (let i = 0; i < dexNames.length; i++) {
            for (let j = i + 1; j < dexNames.length; j++) {
                const priceDiff = Math.abs(prices[dexNames[i]].sub(prices[dexNames[j]]).toNumber());
                const diffPercent = (priceDiff / prices[dexNames[i]].toNumber()) * 100;
                
                if (diffPercent > 0.5) { // 0.5% price difference
                    console.log(`\n📊 Cross-DEX Opportunity: ${pair.base}/${pair.quote}`);
                    console.log(`   ${dexNames[i]}: ${ethers.utils.formatEther(prices[dexNames[i]])}`);
                    console.log(`   ${dexNames[j]}: ${ethers.utils.formatEther(prices[dexNames[j]])}`);
                    console.log(`   Difference: ${diffPercent.toFixed(2)}%`);
                }
            }
        }
    }
}

// ==================== REAL-TIME MEMPOOL MONITORING ====================

async function monitorMempool() {
    console.log(`\n👁️  Monitoring mempool for large swaps...`);
    
    // Connect via WebSocket for real-time events
    const wsProvider = new ethers.providers.WebSocketProvider(CONFIG.wsUrl);
    
    wsProvider.on('pending', async (txHash) => {
        try {
            const tx = await wsProvider.getTransaction(txHash);
            if (tx && tx.to === CONFIG.pancakeswap.router) {
                // Large swap detected, check for front-running opportunity
                const value = parseFloat(ethers.utils.formatEther(tx.value || 0));
                if (value > 1.0) { // Swap over 1 BNB
                    console.log(`\n🔍 Large swap detected: ${txHash.slice(0, 10)}... (${value.toFixed(2)} BNB)`);
                    
                    // Check if we can front-run
                    // This would require a faster RPC and custom implementation
                }
            }
        } catch (e) {}
    });
    
    return wsProvider;
}

// ==================== REPORTING ====================

function printStatus() {
    const runtime = Math.floor((Date.now() - lastScanTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    const seconds = runtime % 60;
    
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📊 BOT STATUS - ${new Date().toLocaleTimeString()}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`⏱️  Runtime: ${hours}h ${minutes}m ${seconds}s`);
    console.log(`🔍 Opportunities Found: ${opportunitiesFound}`);
    console.log(`✅ Trades Executed: ${tradesExecuted}`);
    console.log(`💰 Total Profit: ${totalProfitBNB.toFixed(6)} BNB ($${(totalProfitBNB * 580).toFixed(2)})`);
    console.log(`${'─'.repeat(60)}`);
}

// ==================== MAIN LOOP ====================

async function mainLoop() {
    let scanCount = 0;
    let wsProvider = null;
    
    try {
        wsProvider = await monitorMempool();
    } catch (e) {
        console.log(`⚠️ WebSocket not available, using polling only`);
    }
    
    while (isRunning) {
        try {
            scanCount++;
            
            // Check triangle arbitrage every scan
            await checkAndExecuteFlashLoanArbitrage();
            
            // Check cross-DEX arbitrage every 5 scans
            if (scanCount % 5 === 0) {
                await checkCrossDEXArbitrage();
            }
            
            // Print status every 30 scans (~1 minute)
            if (scanCount % 30 === 0) {
                printStatus();
            }
            
        } catch (error) {
            console.error(`Loop error: ${error.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
    }
    
    if (wsProvider) {
        wsProvider.destroy();
    }
}

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGINT', async () => {
    console.log(`\n\n🛑 Shutting down bot...`);
    console.log(`📊 Final Stats:`);
    console.log(`   Opportunities Found: ${opportunitiesFound}`);
    console.log(`   Trades Executed: ${tradesExecuted}`);
    console.log(`   Total Profit: ${totalProfitBNB.toFixed(6)} BNB`);
    
    logToFile(`Bot shutdown | Profit: ${totalProfitBNB.toFixed(6)} BNB | Trades: ${tradesExecuted}`);
    
    isRunning = false;
    process.exit(0);
});

// ==================== START BOT ====================

async function start() {
    await init();
    
    // Check wallet balance
    const balance = await provider.getBalance(wallet.address);
    const balanceBNB = parseFloat(ethers.utils.formatEther(balance));
    
    if (balanceBNB < 0.05) {
        console.log(`\n⚠️  WARNING: Low balance (${balanceBNB.toFixed(4)} BNB)`);
        console.log(`   Minimum recommended: 0.1 BNB for gas fees\n`);
    }
    
    // Start the main loop
    await mainLoop();
}

start().catch(console.error);
