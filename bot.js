require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
    startingBalance: parseFloat(process.env.SIM_BALANCE || 100.00),
    scanIntervalMs: 10000,
    minProfitPercent: 0.3,
    minProfitUSD: 5.00,
    gasPriceGwei: 3,
    
    // Flash Loan Providers
    flashLoanProviders: {
        balancer: {
            name: 'Balancer',
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            fee: 0.0005, // 0.05% fee
            availableOnBSC: true
        },
        aave: {
            name: 'Aave V3',
            pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
            fee: 0.0009, // 0.09% fee
            availableOnBSC: false
        },
        pancakeswap: {
            name: 'PancakeSwap Flash Swaps',
            router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            fee: 0.0025, // 0.25% fee
            availableOnBSC: true
        }
    },
    
    // BSC Configuration
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    // DEX Routers for Arbitrage
    dexes: {
        pancakeswap: {
            name: 'PancakeSwap',
            router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
            fee: 0.0025
        },
        biswap: {
            name: 'BiSwap',
            router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
            factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
            fee: 0.001
        },
        apeswap: {
            name: 'ApeSwap',
            router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
            factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
            fee: 0.002
        }
    },
    
    // Tokens on BSC
    tokens: {
        'WBNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        'USDT': '0x55d398326f99059fF775485246999027B3197955',
        'USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        'CAKE': '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        'DOGE': '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
        'SHIB': '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D',
        'PEPE': '0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00',
        'FLOKI': '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E'
    },
    
    // Flash Loan amounts to test (in USD)
    flashLoanAmounts: [1000, 5000, 10000, 50000, 100000]
};

// ==================== ROUTER ABI ====================
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts)'
];

// ==================== STATE ====================
let state = {
    isRunning: true,
    simulationBalance: CONFIG.startingBalance,
    startingBalance: CONFIG.startingBalance,
    totalSimulatedTrades: 0,
    successfulSimulatedTrades: 0,
    failedSimulatedTrades: 0,
    totalSimulatedGasSpent: 0,
    totalSimulatedProfit: 0,
    tradeHistory: [],
    flashLoanOpportunities: [],
    allPrices: {},
    tokenList: Object.keys(CONFIG.tokens),
    lastScanTime: Date.now(),
    logs: [],
    bestOpportunity: null
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// Calculate estimated gas cost in USD
function calculateGasCostUSD(gasLimit = 500000) {
    const gasCostBNB = (gasLimit * CONFIG.gasPriceGwei) / 1e9;
    const bnbPriceUSD = state.allPrices['WBNB']?.priceUSD || 580;
    return gasCostBNB * bnbPriceUSD;
}

// ==================== BLOCKCHAIN CONNECTION ====================
let provider = null;
let routers = {};

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        
        // Initialize routers
        for (const [key, dex] of Object.entries(CONFIG.dexes)) {
            routers[key] = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        }
        
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to BSC. Block: ${blockNumber}`, 'success');
        return true;
    } catch (error) {
        addLog(`❌ BSC connection failed: ${error.message}`, 'error');
        return false;
    }
}

// Get real price from a specific DEX
async function getPriceFromDEX(dexKey, tokenIn, tokenOut, amountInUSD = 100) {
    try {
        const router = routers[dexKey];
        if (!router) return null;
        
        const tokenInAddress = CONFIG.tokens[tokenIn];
        const tokenOutAddress = CONFIG.tokens[tokenOut];
        
        if (!tokenInAddress || !tokenOutAddress) return null;
        
        // Assume stablecoin price is $1 for BUSD/USDT
        let amountIn;
        if (tokenIn === 'BUSD' || tokenIn === 'USDT') {
            amountIn = ethers.utils.parseEther(amountInUSD.toString());
        } else {
            // For non-stablecoins, use the current price
            const currentPrice = state.allPrices[tokenIn]?.priceUSD || 1;
            amountIn = ethers.utils.parseEther((amountInUSD / currentPrice).toString());
        }
        
        const amounts = await router.getAmountsOut(amountIn, [tokenInAddress, tokenOutAddress]);
        const amountOut = parseFloat(ethers.utils.formatEther(amounts[1]));
        
        return {
            dex: CONFIG.dexes[dexKey].name,
            amountIn: amountInUSD,
            amountOut: amountOut,
            price: tokenOut === 'BUSD' || tokenOut === 'USDT' ? amountOut / amountInUSD : amountInUSD / amountOut,
            timestamp: Date.now()
        };
    } catch (error) {
        return null;
    }
}

// Update all token prices from PancakeSwap
async function updateAllPrices() {
    for (const token of state.tokenList) {
        if (token === 'WBNB') {
            // Get BNB price in BUSD
            const price = await getPriceFromDEX('pancakeswap', 'WBNB', 'BUSD', 1);
            if (price) {
                state.allPrices[token] = {
                    priceUSD: price.price,
                    lastUpdate: new Date().toISOString()
                };
            }
        } else if (token !== 'BUSD' && token !== 'USDT') {
            const price = await getPriceFromDEX('pancakeswap', token, 'BUSD', 100);
            if (price) {
                state.allPrices[token] = {
                    priceUSD: price.price,
                    lastUpdate: new Date().toISOString()
                };
            }
        } else {
            state.allPrices[token] = {
                priceUSD: 1.00,
                lastUpdate: new Date().toISOString()
            };
        }
    }
}

// Find flash loan arbitrage opportunities
async function findFlashLoanOpportunities() {
    const opportunities = [];
    
    // Check each token for arbitrage between different DEXes
    for (const token of state.tokenList) {
        if (token === 'BUSD' || token === 'USDT' || token === 'WBNB') continue;
        
        const dexPrices = [];
        
        // Get price from each DEX
        for (const [dexKey, dex] of Object.entries(CONFIG.dexes)) {
            const price = await getPriceFromDEX(dexKey, token, 'BUSD', 100);
            if (price) {
                dexPrices.push({
                    dex: dex.name,
                    price: price.price,
                    amountOut: price.amountOut
                });
            }
        }
        
        // Find highest and lowest prices
        if (dexPrices.length >= 2) {
            const sorted = [...dexPrices].sort((a, b) => b.price - a.price);
            const highest = sorted[0];
            const lowest = sorted[sorted.length - 1];
            const priceDiff = ((highest.price - lowest.price) / lowest.price) * 100;
            
            if (priceDiff > CONFIG.minProfitPercent) {
                // Calculate profit for different flash loan amounts
                for (const loanAmount of CONFIG.flashLoanAmounts) {
                    const flashLoanFee = 0.0005; // 0.05% typical flash loan fee
                    const buyAmount = loanAmount;
                    const sellAmount = (loanAmount / lowest.price) * highest.price;
                    const grossProfit = sellAmount - buyAmount;
                    const flashFee = buyAmount * flashLoanFee;
                    const gasCost = calculateGasCostUSD();
                    const netProfit = grossProfit - flashFee - gasCost;
                    
                    if (netProfit > CONFIG.minProfitUSD) {
                        opportunities.push({
                            type: 'CROSS_DEX',
                            token: token,
                            buyDex: lowest.dex,
                            sellDex: highest.dex,
                            buyPrice: lowest.price,
                            sellPrice: highest.price,
                            priceDiffPercent: priceDiff,
                            loanAmount: loanAmount,
                            grossProfit: grossProfit,
                            flashLoanFee: flashFee,
                            gasCost: gasCost,
                            netProfit: netProfit,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        }
    }
    
    // Check triangular arbitrage (BNB -> Token -> BNB)
    for (const token of state.tokenList) {
        if (token === 'BUSD' || token === 'USDT' || token === 'WBNB') continue;
        
        const bnbPrice = await getPriceFromDEX('pancakeswap', 'WBNB', 'BUSD', 100);
        const tokenPrice = await getPriceFromDEX('pancakeswap', token, 'BUSD', 100);
        const tokenToBnb = await getPriceFromDEX('pancakeswap', token, 'WBNB', 100);
        
        if (bnbPrice && tokenPrice && tokenToBnb) {
            // Path: BNB -> BUSD -> Token -> BNB
            const bnbToBusd = 100; // Start with $100 worth of BNB
            const busdToToken = bnbToBusd;
            const tokenAmount = busdToToken / tokenPrice.price;
            const bnbBack = tokenAmount * (tokenToBnb.price || (1 / bnbPrice.price));
            const grossProfit = bnbBack - 1;
            const profitPercent = grossProfit * 100;
            
            if (profitPercent > CONFIG.minProfitPercent) {
                for (const loanAmount of CONFIG.flashLoanAmounts) {
                    const scaledGrossProfit = (loanAmount / 100) * grossProfit;
                    const flashFee = loanAmount * 0.0005;
                    const gasCost = calculateGasCostUSD();
                    const netProfit = scaledGrossProfit - flashFee - gasCost;
                    
                    if (netProfit > CONFIG.minProfitUSD) {
                        opportunities.push({
                            type: 'TRIANGULAR',
                            token: token,
                            path: 'WBNB → BUSD → ' + token + ' → WBNB',
                            profitPercent: profitPercent,
                            loanAmount: loanAmount,
                            grossProfit: scaledGrossProfit,
                            flashLoanFee: flashFee,
                            gasCost: gasCost,
                            netProfit: netProfit,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        }
    }
    
    // Sort by net profit
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    return opportunities;
}

// Simulate flash loan execution
async function simulateFlashLoanExecution(opportunity) {
    const { type, token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCost, netProfit } = opportunity;
    
    addLog(`🔷 FLASH LOAN SIMULATION`, 'flashloan');
    addLog(`   Type: ${type}`, 'info');
    addLog(`   Token: ${token}`, 'info');
    addLog(`   Borrow Amount: $${loanAmount.toFixed(2)} (0% collateral)`, 'info');
    addLog(`   Buy on: ${buyDex || 'PancakeSwap'}`, 'info');
    addLog(`   Sell on: ${sellDex || 'PancakeSwap'}`, 'info');
    addLog(`   Gross Profit: $${grossProfit.toFixed(2)}`, 'info');
    addLog(`   Flash Loan Fee (0.05%): $${flashLoanFee.toFixed(2)}`, 'info');
    addLog(`   Estimated Gas Cost: $${gasCost.toFixed(2)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)}`, 'profit');
    
    state.totalSimulatedGasSpent += gasCost;
    state.totalSimulatedTrades++;
    
    // Simulate success (randomized but realistic - 70% success rate for flash loans)
    const success = Math.random() < 0.7;
    
    if (success && netProfit > 0) {
        state.simulationBalance += netProfit;
        state.totalSimulatedProfit += netProfit;
        state.successfulSimulatedTrades++;
        addLog(`✅ SIMULATED SUCCESS! Profit: $${netProfit.toFixed(2)}`, 'success');
        addLog(`   New Simulated Balance: $${state.simulationBalance.toFixed(2)}`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            type: type,
            token: token,
            loanAmount: loanAmount,
            profit: netProfit,
            grossProfit: grossProfit,
            gasCost: gasCost,
            success: true
        });
    } else {
        state.failedSimulatedTrades++;
        addLog(`❌ SIMULATED FAILURE! Lost gas: $${gasCost.toFixed(2)}`, 'error');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            type: type,
            token: token,
            loanAmount: loanAmount,
            loss: gasCost,
            success: false
        });
    }
    
    if (state.tradeHistory.length > 50) state.tradeHistory.pop();
}

// ==================== MAIN SIMULATION LOOP ====================
async function simulationLoop() {
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            addLog(`🔍 Scanning for flash loan arbitrage opportunities...`, 'info');
            
            // Update real prices
            await updateAllPrices();
            
            // Find opportunities
            const opportunities = await findFlashLoanOpportunities();
            
            if (opportunities.length > 0) {
                const best = opportunities[0];
                state.bestOpportunity = best;
                state.flashLoanOpportunities.unshift(best);
                if (state.flashLoanOpportunities.length > 20) state.flashLoanOpportunities.pop();
                
                addLog(`📈 FLASH LOAN OPPORTUNITY FOUND!`, 'opportunity');
                addLog(`   Token: ${best.token}`, 'opportunity');
                addLog(`   Loan Amount: $${best.loanAmount.toFixed(2)}`, 'opportunity');
                addLog(`   Expected Net Profit: $${best.netProfit.toFixed(2)}`, 'profit');
                
                // Execute simulation if profitable
                if (best.netProfit > CONFIG.minProfitUSD) {
                    await simulateFlashLoanExecution(best);
                }
            } else {
                addLog(`   No profitable flash loan opportunities found`, 'info');
            }
            
            await new Promise(resolve => setTimeout(resolve, CONFIG.scanIntervalMs));
        } catch (error) {
            addLog(`Error: ${error.message}`, 'error');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// ==================== EXPRESS API ====================
app.get('/api/state', (req, res) => {
    const profitLoss = state.simulationBalance - state.startingBalance;
    const profitPercent = (profitLoss / state.startingBalance) * 100;
    
    const topTokens = Object.entries(state.allPrices)
        .filter(([_, v]) => v?.priceUSD)
        .sort((a, b) => (b[1]?.priceUSD || 0) - (a[1]?.priceUSD || 0))
        .slice(0, 10);
    
    res.json({
        isRunning: state.isRunning,
        simulationBalance: state.simulationBalance,
        startingBalance: state.startingBalance,
        profitLoss: profitLoss,
        profitPercent: profitPercent,
        totalSimulatedTrades: state.totalSimulatedTrades,
        successfulSimulatedTrades: state.successfulSimulatedTrades,
        failedSimulatedTrades: state.failedSimulatedTrades,
        totalSimulatedGasSpent: state.totalSimulatedGasSpent,
        totalSimulatedProfit: state.totalSimulatedProfit,
        flashLoanOpportunities: state.flashLoanOpportunities.slice(0, 5),
        bestOpportunity: state.bestOpportunity,
        allPrices: Object.fromEntries(topTokens),
        tokenCount: state.tokenList.length,
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        config: {
            gasPriceGwei: CONFIG.gasPriceGwei,
            minProfitUSD: CONFIG.minProfitUSD,
            flashLoanAmounts: CONFIG.flashLoanAmounts
        }
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        isRunning: true,
        simulationBalance: CONFIG.startingBalance,
        startingBalance: CONFIG.startingBalance,
        totalSimulatedTrades: 0,
        successfulSimulatedTrades: 0,
        failedSimulatedTrades: 0,
        totalSimulatedGasSpent: 0,
        totalSimulatedProfit: 0,
        tradeHistory: [],
        flashLoanOpportunities: [],
        allPrices: {},
        tokenList: Object.keys(CONFIG.tokens),
        lastScanTime: Date.now(),
        logs: [],
        bestOpportunity: null
    };
    addLog(`🔄 Simulation reset. Balance: $${CONFIG.startingBalance}`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot - Real Data Simulation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 1.8rem; background: linear-gradient(135deg, #00d4ff, #0099ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .flash-badge { background: #8b5cf6; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.85rem; font-weight: 600; margin-bottom: 15px; color: #00d4ff; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 1.8rem; font-weight: bold; margin: 10px 0; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .profit { color: #f0b90b; }
        .token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; max-height: 320px; overflow-y: auto; }
        .token-item { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 10px; text-align: center; font-size: 0.7rem; }
        .token-price { color: #00d4ff; font-weight: bold; font-size: 0.9rem; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .scrollable { max-height: 350px; overflow-y: auto; }
        button { background: linear-gradient(135deg, #00d4ff, #0099ff); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin: 5px; color: white; }
        button:hover { transform: translateY(-1px); }
        .opportunity-card { background: rgba(139, 92, 246, 0.1); border: 1px solid #8b5cf6; border-radius: 12px; padding: 15px; margin-bottom: 15px; }
        .text-small { font-size: 0.7rem; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Flash Loan Arbitrage Bot <span class="badge">REAL DATA</span><span class="badge flash-badge">FLASH LOAN</span></h1>
            <p class="text-small">Real PancakeSwap prices | Simulated flash loans | Zero capital needed (except gas)</p>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">💰 SIMULATED BALANCE</div>
                <div class="stat-value" id="balance">$0.00</div>
                <div>P&L: <span id="pnl">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
                <div class="text-small" style="margin-top: 10px;">Starting balance is SIMULATED - no real money used</div>
            </div>
            <div class="card">
                <div class="card-title">⚡ FLASH LOAN STATS</div>
                <div>Total Loans: <span id="totalTrades">0</span></div>
                <div>✅ Successful: <span id="successTrades">0</span> | ❌ Failed: <span id="failedTrades">0</span></div>
                <div>Total Gas Spent: $<span id="gasSpent">0.00</span></div>
            </div>
            <div class="card">
                <div class="card-title">⛽ GAS & FEES</div>
                <div>Gas Price: <span id="gasPrice">3</span> Gwei</div>
                <div>Min Profit Target: $<span id="minProfit">5.00</span></div>
                <div>Status: <span id="status" class="profit">🟢 ACTIVE</span></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">🏆 BEST FLASH LOAN OPPORTUNITY</div>
                <div id="bestOpportunity" class="opportunity-card text-center">
                    <div class="text-small">Scanning for opportunities...</div>
                </div>
            </div>
            <div class="card">
                <div class="card-title">📈 TOKEN PRICES (Real from PancakeSwap)</div>
                <div class="token-grid" id="pricesContainer">Loading real prices...</div>
                <div class="text-small" style="margin-top: 10px; color: #10b981;">✓ Live data from BSC blockchain</div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">🔄 RECENT OPPORTUNITIES</div>
                <div class="scrollable">
                    <table id="opportunitiesTable">
                        <thead><tr><th>Token</th><th>Loan Amt</th><th>Net Profit</th><th>Status</th></tr></thead>
                        <tbody><tr><td colspan="4" class="text-center">Scanning...</td></tr></tbody>
                    </table>
                </div>
            </div>
            <div class="card">
                <div class="card-title">📋 TRADE HISTORY</div>
                <div class="scrollable">
                    <table id="tradesTable">
                        <thead><tr><th>Time</th><th>Token</th><th>Profit/Loss</th></tr></thead>
                        <tbody><tr><td colspan="3" class="text-center">No trades yet</td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">📝 LIVE LOGS</div>
            <div class="scrollable" id="logsContainer" style="font-family: monospace; font-size: 0.65rem; max-height: 200px;">Initializing...</div>
        </div>

        <div class="text-center mt-20">
            <button onclick="resetSimulation()">🔄 Reset Simulation</button>
        </div>

        <div class="text-center mt-20 text-small" style="opacity: 0.6;">
            <p>✅ REAL DATA: Prices fetched live from PancakeSwap, BiSwap, and ApeSwap on BNB Smart Chain</p>
            <p>⚡ FLASH LOANS: Simulated - No actual loans taken, no real money at risk</p>
            <p>💡 In production, this bot would use Balancer/Aave flash loans requiring only ~0.05 BNB for gas</p>
        </div>
    </div>

    <script>
        async function fetchState() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                document.getElementById('balance').innerHTML = '$' + data.simulationBalance.toFixed(2);
                const pnl = data.profitLoss;
                document.getElementById('pnl').innerHTML = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2);
                document.getElementById('pnlPercent').innerHTML = (pnl >= 0 ? '+' : '') + data.profitPercent.toFixed(2) + '%';
                document.getElementById('totalTrades').innerHTML = data.totalSimulatedTrades;
                document.getElementById('successTrades').innerHTML = data.successfulSimulatedTrades;
                document.getElementById('failedTrades').innerHTML = data.failedSimulatedTrades;
                document.getElementById('gasSpent').innerHTML = data.totalSimulatedGasSpent?.toFixed(2) || '0.00';
                
                if (data.bestOpportunity) {
                    const opp = data.bestOpportunity;
                    document.getElementById('bestOpportunity').innerHTML = '<div><strong>' + opp.token + '</strong></div>' +
                        '<div>Loan: $' + opp.loanAmount?.toFixed(0) + ' | Net Profit: <span class="profit">+$' + opp.netProfit?.toFixed(2) + '</span></div>' +
                        '<div class="text-small">Buy: ' + (opp.buyDex || 'DEX') + ' → Sell: ' + (opp.sellDex || 'DEX') + '</div>';
                }
                
                if (data.allPrices && Object.keys(data.allPrices).length > 0) {
                    let pricesHtml = '';
                    for (const [token, info] of Object.entries(data.allPrices)) {
                        pricesHtml += '<div class="token-item"><div>' + token + '</div><div class="token-price">$' + (info.priceUSD?.toFixed(6) || 'N/A') + '</div></div>';
                    }
                    document.getElementById('pricesContainer').innerHTML = pricesHtml;
                }
                
                const oppTable = document.getElementById('opportunitiesTable').querySelector('tbody');
                if (data.flashLoanOpportunities && data.flashLoanOpportunities.length > 0) {
                    let oppHtml = '';
                    for (let i = 0; i < Math.min(8, data.flashLoanOpportunities.length); i++) {
                        const opp = data.flashLoanOpportunities[i];
                        oppHtml += '<tr><td>' + opp.token + '</td><td>$' + opp.loanAmount?.toFixed(0) + '</td><td class="profit">+$' + opp.netProfit?.toFixed(2) + '</td><td>🔍 Found</td></tr>';
                    }
                    oppTable.innerHTML = oppHtml;
                }
                
                const tradesBody = document.getElementById('tradesTable').querySelector('tbody');
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    let tradesHtml = '';
                    for (let i = 0; i < data.tradeHistory.length; i++) {
                        const t = data.tradeHistory[i];
                        const profit = t.profit || (t.loss ? -t.loss : 0);
                        tradesHtml += '<tr><td>' + new Date(t.timestamp).toLocaleTimeString() + '</td><td>' + (t.token || 'N/A') + '</td><td class="' + (profit >= 0 ? 'positive' : 'negative') + '">' + (profit >= 0 ? '+' : '') + '$' + Math.abs(profit).toFixed(2) + '</td></tr>';
                    }
                    tradesBody.innerHTML = tradesHtml;
                }
                
                const logsContainer = document.getElementById('logsContainer');
                if (data.logs && data.logs.length > 0) {
                    let logsHtml = '';
                    for (let i = 0; i < Math.min(30, data.logs.length); i++) {
                        const log = data.logs[i];
                        let color = '#888';
                        if (log.type === 'error') color = '#ef4444';
                        else if (log.type === 'success') color = '#10b981';
                        else if (log.type === 'opportunity') color = '#f0b90b';
                        else if (log.type === 'flashloan') color = '#8b5cf6';
                        else if (log.type === 'profit') color = '#00d4ff';
                        logsHtml += '<div style="color: ' + color + '; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0;">[' + new Date(log.timestamp).toLocaleTimeString() + '] ' + log.message + '</div>';
                    }
                    logsContainer.innerHTML = logsHtml;
                }
            } catch(e) { console.error(e); }
        }
        
        async function resetSimulation() {
            await fetch('/api/reset', { method: 'POST' });
            setTimeout(fetchState, 500);
        }
        
        fetchState();
        setInterval(fetchState, 3000);
    </script>
</body>
</html>`;
    res.send(html);
});

// ==================== START BOT ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ FLASH LOAN ARBITRAGE BOT - Real Data Simulation');
    console.log('='.repeat(60));
    console.log(`\n💰 Simulated Balance: $${CONFIG.startingBalance}`);
    console.log(`🔍 Scanning for flash loan opportunities...`);
    console.log(`⛽ Gas Price: ${CONFIG.gasPriceGwei} Gwei`);
    console.log(`🎯 Min Profit Target: $${CONFIG.minProfitUSD}`);
    console.log(`💸 Testing loan amounts: $${CONFIG.flashLoanAmounts.join(', $')}`);
    console.log(`\n🔗 Connecting to BNB Smart Chain...`);
    
    await initBlockchain();
    
    console.log(`\n✅ Bot Started!`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`\n⚠️  REAL DATA: Prices from live PancakeSwap, BiSwap, ApeSwap`);
    console.log(`⚡ FLASH LOANS: Simulated execution (no real loans taken)`);
    console.log(`💡 No wallet, no private key, no real money at risk!\n`);
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard running on port ${PORT}`);
    });
}

start();
