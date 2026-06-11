require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
    // Wallet balance (simulated)
    walletBalanceBNB: 0.0065,
    walletBalanceUSD: 4.00,
    
    // Gas settings
    gasPriceGwei: 3,
    estimatedGasPerTx: 350000,
    
    // Profit thresholds
    minProfitUSD: 0.50,
    minProfitPercent: 0.1,
    
    // Scan settings
    scanIntervalMs: 30000,  // Scan every 30 seconds
    maxTokensToScan: 200,   // Max tokens to scan per cycle
    
    // Flash loan amounts
    flashLoanAmounts: [100, 500, 1000, 5000, 10000],
    
    // BSC Configuration
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    // PancakeSwap Contracts
    pancakeswap: {
        factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E'
    },
    
    // Other DEXes for arbitrage comparison
    otherDexes: {
        biswap: { name: 'BiSwap', router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' },
        apeswap: { name: 'ApeSwap', router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7' }
    },
    
    // Reference tokens (for price quotes)
    referenceTokens: {
        'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        'USDT': '0x55d398326f99059fF775485246999027B3197955',
        'WBNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    }
};

const FACTORY_ABI = [
    'function allPairs(uint256) external view returns (address)',
    'function allPairsLength() external view returns (uint256)',
    'function getPair(address tokenA, address tokenB) external view returns (address)'
];

const PAIR_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const TOKEN_ABI = [
    'function symbol() external view returns (string)',
    'function name() external view returns (string)',
    'function decimals() external view returns (uint8)'
];

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

// ==================== STATE ====================
let state = {
    walletBalanceBNB: CONFIG.walletBalanceBNB,
    walletBalanceUSD: CONFIG.walletBalanceUSD,
    startingBalanceBNB: CONFIG.walletBalanceBNB,
    startingBalanceUSD: CONFIG.walletBalanceUSD,
    
    totalTransactions: 0,
    successfulTransactions: 0,
    failedTransactions: 0,
    totalGasSpentBNB: 0,
    totalGasSpentUSD: 0,
    totalProfitBNB: 0,
    totalProfitUSD: 0,
    
    opportunities: [],
    tradeHistory: [],
    allTokens: [],
    tokenPrices: {},
    scannedTokens: 0,
    totalPairs: 0,
    
    isRunning: true,
    lastScanTime: Date.now(),
    logs: [],
    bnbPriceUSD: 615,
    currentGasPriceGwei: CONFIG.gasPriceGwei
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

function calculateGasCostUSD() {
    const gasCostBNB = (CONFIG.estimatedGasPerTx * state.currentGasPriceGwei) / 1e9;
    return { bnb: gasCostBNB, usd: gasCostBNB * state.bnbPriceUSD };
}

// ==================== BLOCKCHAIN CONNECTION ====================
let provider = null;
let factory = null;
let router = null;
let otherRouters = {};

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        factory = new ethers.Contract(CONFIG.pancakeswap.factory, FACTORY_ABI, provider);
        router = new ethers.Contract(CONFIG.pancakeswap.router, ROUTER_ABI, provider);
        
        // Initialize other DEX routers
        for (const [key, dex] of Object.entries(CONFIG.otherDexes)) {
            otherRouters[key] = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        }
        
        // Get total number of pairs
        const totalPairs = await factory.allPairsLength();
        state.totalPairs = totalPairs.toNumber();
        addLog(`✅ Connected to BSC. Total pairs on PancakeSwap: ${state.totalPairs.toLocaleString()}`, 'success');
        
        // Get BNB price
        await updateBNBPrice();
        
        addLog(`💰 BNB Price: $${state.bnbPriceUSD.toFixed(2)}`, 'info');
        addLog(`💸 Wallet: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
        
        return true;
    } catch (error) {
        addLog(`❌ BSC connection failed: ${error.message}`, 'error');
        return false;
    }
}

async function updateBNBPrice() {
    try {
        const busdAddress = CONFIG.referenceTokens.BUSD;
        const wbnbAddress = CONFIG.referenceTokens.WBNB;
        const amountIn = ethers.utils.parseEther('1');
        const amounts = await router.getAmountsOut(amountIn, [wbnbAddress, busdAddress]);
        state.bnbPriceUSD = parseFloat(ethers.utils.formatEther(amounts[1]));
    } catch (error) {
        // Keep existing price
    }
}

// ==================== GET ALL TOKENS FROM PANCAKESWAP ====================
async function getAllTokens() {
    const tokens = new Map(); // Use Map to avoid duplicates
    const batchSize = 50;
    let scanned = 0;
    
    addLog(`🔍 Scanning PancakeSwap for all tokens...`, 'info');
    
    // Limit to max tokens for performance
    const maxPairs = Math.min(state.totalPairs, CONFIG.maxTokensToScan * 2);
    
    for (let i = 0; i < maxPairs && scanned < CONFIG.maxTokensToScan; i++) {
        try {
            const pairAddress = await factory.allPairs(i);
            const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
            
            const token0Address = await pair.token0();
            const token1Address = await pair.token1();
            
            // Only include pairs with BUSD, USDT, or WBNB as one side (for pricing)
            const isBUSD = token0Address === CONFIG.referenceTokens.BUSD || token1Address === CONFIG.referenceTokens.BUSD;
            const isUSDT = token0Address === CONFIG.referenceTokens.USDT || token1Address === CONFIG.referenceTokens.USDT;
            const isWBNB = token0Address === CONFIG.referenceTokens.WBNB || token1Address === CONFIG.referenceTokens.WBNB;
            
            if (isBUSD || isUSDT || isWBNB) {
                const tokenAddress = token0Address === CONFIG.referenceTokens.BUSD || 
                                    token0Address === CONFIG.referenceTokens.USDT || 
                                    token0Address === CONFIG.referenceTokens.WBNB ? token1Address : token0Address;
                
                if (!tokens.has(tokenAddress)) {
                    const tokenContract = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
                    let symbol = 'Unknown';
                    let decimals = 18;
                    
                    try {
                        symbol = await tokenContract.symbol();
                        decimals = await tokenContract.decimals();
                    } catch (e) {}
                    
                    // Skip if symbol is too short or looks like a scam
                    if (symbol && symbol.length > 1 && symbol.length < 20 && !symbol.includes('???') && !symbol.includes('...')) {
                        tokens.set(tokenAddress, { address: tokenAddress, symbol: symbol, decimals: decimals });
                        scanned++;
                    }
                }
            }
        } catch (error) {
            // Silent fail for individual pairs
        }
        
        // Progress update every 50 pairs
        if (i % 50 === 0 && i > 0) {
            addLog(`   Scanned ${i}/${maxPairs} pairs, found ${tokens.size} unique tokens...`, 'info');
        }
    }
    
    const tokenList = Array.from(tokens.values());
    state.allTokens = tokenList;
    addLog(`✅ Found ${tokenList.length} tradable tokens on PancakeSwap`, 'success');
    
    return tokenList;
}

// ==================== GET TOKEN PRICE ====================
async function getTokenPrice(tokenAddress, decimals, quoteToken = 'BUSD') {
    try {
        const quoteAddress = CONFIG.referenceTokens[quoteToken];
        if (!quoteAddress) return null;
        
        const amountIn = ethers.utils.parseUnits('100', 18); // $100 worth
        const amounts = await router.getAmountsOut(amountIn, [quoteAddress, tokenAddress]);
        const amountOut = parseFloat(ethers.utils.formatUnits(amounts[1], decimals));
        
        if (amountOut > 0) {
            return 100 / amountOut; // Price in USD
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ==================== FIND ARBITRAGE OPPORTUNITIES ACROSS ALL TOKENS ====================
async function findAllArbitrageOpportunities() {
    const opportunities = [];
    const tokensToCheck = state.allTokens.slice(0, CONFIG.maxTokensToScan);
    
    addLog(`🔍 Scanning ${tokensToCheck.length} tokens for arbitrage opportunities...`, 'info');
    
    let checked = 0;
    for (const token of tokensToCheck) {
        checked++;
        
        // Get price on PancakeSwap
        let pancakePrice = null;
        try {
            pancakePrice = await getTokenPrice(token.address, token.decimals, 'BUSD');
            if (pancakePrice && pancakePrice > 0 && pancakePrice < 100000) {
                state.tokenPrices[token.symbol] = {
                    priceUSD: pancakePrice,
                    lastUpdate: new Date().toISOString()
                };
            }
        } catch (e) {}
        
        // Compare with other DEXes
        for (const [dexKey, dex] of Object.entries(CONFIG.otherDexes)) {
            try {
                const otherRouter = otherRouters[dexKey];
                if (!otherRouter) continue;
                
                const quoteAddress = CONFIG.referenceTokens.BUSD;
                const amountIn = ethers.utils.parseUnits('100', 18);
                const amounts = await otherRouter.getAmountsOut(amountIn, [quoteAddress, token.address]);
                const amountOut = parseFloat(ethers.utils.formatUnits(amounts[1], token.decimals));
                const otherPrice = 100 / amountOut;
                
                if (pancakePrice && otherPrice && pancakePrice > 0 && otherPrice > 0) {
                    const priceDiff = Math.abs((pancakePrice - otherPrice) / otherPrice) * 100;
                    
                    if (priceDiff > CONFIG.minProfitPercent && priceDiff < 100) { // Sanity check: less than 100% diff
                        for (const loanAmount of CONFIG.flashLoanAmounts) {
                            const grossProfit = loanAmount * (priceDiff / 100);
                            const flashLoanFee = loanAmount * 0.0009;
                            const gasCost = calculateGasCostUSD();
                            const netProfit = grossProfit - flashLoanFee - gasCost.usd;
                            
                            if (netProfit > CONFIG.minProfitUSD && netProfit < loanAmount * 0.5) { // Sanity check
                                opportunities.push({
                                    token: token.symbol,
                                    buyDex: pancakePrice < otherPrice ? 'PancakeSwap' : dex.name,
                                    sellDex: pancakePrice < otherPrice ? dex.name : 'PancakeSwap',
                                    buyPrice: Math.min(pancakePrice, otherPrice),
                                    sellPrice: Math.max(pancakePrice, otherPrice),
                                    priceDiffPercent: priceDiff,
                                    loanAmount: loanAmount,
                                    grossProfit: grossProfit,
                                    flashLoanFee: flashLoanFee,
                                    gasCostUSD: gasCost.usd,
                                    netProfit: netProfit,
                                    timestamp: Date.now()
                                });
                            }
                        }
                    }
                }
            } catch (error) {}
        }
        
        // Progress update
        if (checked % 20 === 0) {
            addLog(`   Scanned ${checked}/${tokensToCheck.length} tokens...`, 'info');
        }
    }
    
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    return opportunities.slice(0, 10); // Return top 10
}

// ==================== SIMULATE FLASH LOAN EXECUTION ====================
async function executeSimulatedFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, netProfit, priceDiffPercent } = opportunity;
    
    addLog(`🔷 FLASH LOAN SIMULATION`, 'flashloan');
    addLog(`   Token: ${token}`, 'info');
    addLog(`   Loan Amount: $${loanAmount.toFixed(2)} (0% collateral)`, 'info');
    addLog(`   Buy on: ${buyDex} → Sell on: ${sellDex}`, 'info');
    addLog(`   Price Difference: ${priceDiffPercent.toFixed(3)}%`, 'info');
    addLog(`   Gross Profit: $${grossProfit.toFixed(2)}`, 'info');
    addLog(`   Flash Loan Fee (0.09%): $${flashLoanFee.toFixed(2)}`, 'info');
    addLog(`   Gas Cost: $${gasCostUSD.toFixed(4)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)}`, 'profit');
    
    if (!canAffordTransaction()) {
        addLog(`❌ INSUFFICIENT BALANCE for gas!`, 'error');
        return false;
    }
    
    state.totalTransactions++;
    state.totalGasSpentUSD += gasCostUSD;
    
    // 70% success rate for simulation
    const success = Math.random() < 0.7;
    
    if (success && netProfit > 0) {
        state.walletBalanceUSD += netProfit;
        state.totalProfitUSD += netProfit;
        state.successfulTransactions++;
        
        addLog(`✅ FLASH LOAN SUCCESSFUL! Net Profit: $${netProfit.toFixed(2)}`, 'success');
        addLog(`   New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            loanAmount: loanAmount,
            netProfit: netProfit,
            success: true
        });
        return true;
    } else {
        state.failedTransactions++;
        addLog(`❌ FLASH LOAN FAILED! Lost gas: $${gasCostUSD.toFixed(4)}`, 'error');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            loss: gasCostUSD,
            success: false
        });
        return false;
    }
}

function canAffordTransaction() {
    const gasCost = calculateGasCostUSD();
    return state.walletBalanceUSD > gasCost.usd * 1.1;
}

// ==================== MAIN SIMULATION LOOP ====================
async function simulationLoop() {
    // First, get all tokens from PancakeSwap
    await getAllTokens();
    
    addLog(`🚀 Starting arbitrage scanning with ${state.walletBalanceUSD.toFixed(2)} balance`, 'success');
    addLog(`⚡ Scanning ${state.allTokens.length} tokens for opportunities...`, 'info');
    
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            await updateBNBPrice();
            
            const opportunities = await findAllArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                const best = opportunities[0];
                state.opportunities.unshift(best);
                if (state.opportunities.length > 20) state.opportunities.pop();
                
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit potential`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net Profit $${best.netProfit.toFixed(2)}`, 'profit');
                
                if (best.netProfit > CONFIG.minProfitUSD && canAffordTransaction()) {
                    await executeSimulatedFlashLoan(best);
                }
            } else {
                if (Math.random() < 0.1) {
                    addLog(`⏳ Scanning ${state.allTokens.length} tokens... No opportunities found`, 'info');
                }
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
    const profitLoss = state.walletBalanceUSD - state.startingBalanceUSD;
    const profitPercent = (profitLoss / state.startingBalanceUSD) * 100;
    
    res.json({
        wallet: {
            balanceUSD: state.walletBalanceUSD,
            startingBalanceUSD: state.startingBalanceUSD,
            profitLoss: profitLoss,
            profitPercent: profitPercent
        },
        stats: {
            totalTransactions: state.totalTransactions,
            successfulTransactions: state.successfulTransactions,
            failedTransactions: state.failedTransactions,
            totalGasSpentUSD: state.totalGasSpentUSD,
            totalProfitUSD: state.totalProfitUSD
        },
        scanning: {
            totalTokens: state.allTokens.length,
            scannedTokens: state.scannedTokens,
            totalPairs: state.totalPairs
        },
        opportunities: state.opportunities.slice(0, 8),
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        tokenCount: state.allTokens.length
    });
});

app.post('/api/reset', (req, res) => {
    state.walletBalanceUSD = CONFIG.walletBalanceUSD;
    state.walletBalanceBNB = CONFIG.walletBalanceBNB;
    state.totalTransactions = 0;
    state.successfulTransactions = 0;
    state.failedTransactions = 0;
    state.totalGasSpentUSD = 0;
    state.totalProfitUSD = 0;
    state.opportunities = [];
    state.tradeHistory = [];
    state.isRunning = true;
    
    addLog(`🔄 Bot reset. Balance restored to $${CONFIG.walletBalanceUSD.toFixed(2)}`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Bot - ALL PancakeSwap Coins</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 1.8rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; padding: 2px 12px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.8rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; text-transform: uppercase; }
        .stat-value { font-size: 1.8rem; font-weight: bold; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .profit { color: #f0b90b; }
        .scrollable { max-height: 300px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin: 5px; color: #0a0f1e; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Flash Loan Arbitrage Bot <span class="badge">ALL PANCAKESWAP TOKENS</span></h1>
        <p class="text-small">Scanning ALL tokens on PancakeSwap | Real data | Simulated execution</p>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">💰 WALLET</div>
            <div class="stat-value" id="balance">$0.00</div>
            <div>P&L: <span id="pnl">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
        </div>
        <div class="card">
            <div class="card-title">⚡ STATS</div>
            <div>Txs: <span id="totalTxs">0</span> | ✅ <span id="successTxs">0</span> | ❌ <span id="failedTxs">0</span></div>
            <div>Gas: $<span id="gasSpent">0.00</span> | Profit: $<span id="totalProfit">0.00</span></div>
        </div>
        <div class="card">
            <div class="card-title">🔍 SCANNING</div>
            <div>Tokens: <span id="tokenCount">0</span></div>
            <div>Pairs: <span id="pairCount">0</span></div>
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">🏆 TOP OPPORTUNITIES</div>
            <div class="scrollable">
                <table id="oppTable"><tbody><tr><td class="text-center">Scanning...</td></tr></tbody></table>
            </div>
        </div>
        <div class="card">
            <div class="card-title">📋 TRADE HISTORY</div>
            <div class="scrollable">
                <table id="tradesTable"><tbody><tr><td class="text-center">No trades yet</td></tr></tbody></table>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">📝 LIVE LOGS</div>
        <div class="scrollable" id="logsContainer" style="max-height: 200px; font-family: monospace; font-size: 0.65rem;">Initializing...</div>
    </div>

    <div class="text-center mt-20">
        <button onclick="resetSimulation()">🔄 Reset</button>
    </div>
</div>

<script>
    async function fetchState() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            
            document.getElementById('balance').innerHTML = '$' + data.wallet.balanceUSD.toFixed(2);
            document.getElementById('pnl').innerHTML = (data.wallet.profitLoss >= 0 ? '+' : '') + '$' + Math.abs(data.wallet.profitLoss).toFixed(2);
            document.getElementById('pnlPercent').innerHTML = (data.wallet.profitPercent >= 0 ? '+' : '') + data.wallet.profitPercent.toFixed(2) + '%';
            document.getElementById('totalTxs').innerHTML = data.stats.totalTransactions;
            document.getElementById('successTxs').innerHTML = data.stats.successfulTransactions;
            document.getElementById('failedTxs').innerHTML = data.stats.failedTransactions;
            document.getElementById('gasSpent').innerHTML = data.stats.totalGasSpentUSD.toFixed(4);
            document.getElementById('totalProfit').innerHTML = data.stats.totalProfitUSD.toFixed(2);
            document.getElementById('tokenCount').innerHTML = data.scanning.totalTokens || 0;
            document.getElementById('pairCount').innerHTML = data.scanning.totalPairs || 0;
            
            if (data.opportunities && data.opportunities.length > 0) {
                let oppHtml = '<tr><th>Token</th><th>Profit</th><th>Diff%</th></tr>';
                for (let i = 0; i < Math.min(8, data.opportunities.length); i++) {
                    const o = data.opportunities[i];
                    oppHtml += '<tr><td>' + o.token + '</td><td class="profit">+$' + o.netProfit?.toFixed(2) + '</td><td>' + o.priceDiffPercent?.toFixed(2) + '%</td></tr>';
                }
                document.getElementById('oppTable').querySelector('tbody').innerHTML = oppHtml;
            }
            
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let tradesHtml = '<tr><th>Time</th><th>Token</th><th>Result</th></tr>';
                for (let i = 0; i < Math.min(10, data.tradeHistory.length); i++) {
                    const t = data.tradeHistory[i];
                    tradesHtml += '<tr><td>' + new Date(t.timestamp).toLocaleTimeString() + '</td><td>' + (t.token || 'N/A') + '</td><td class="' + (t.success ? 'positive' : 'negative') + '">' + (t.success ? '+$' + t.netProfit?.toFixed(2) : '-$' + t.loss?.toFixed(2)) + '</td></tr>';
                }
                document.getElementById('tradesTable').querySelector('tbody').innerHTML = tradesHtml;
            }
            
            if (data.logs && data.logs.length > 0) {
                let logsHtml = '';
                for (let i = 0; i < Math.min(25, data.logs.length); i++) {
                    const log = data.logs[i];
                    let color = '#888';
                    if (log.type === 'error') color = '#ef4444';
                    else if (log.type === 'success') color = '#10b981';
                    else if (log.type === 'opportunity') color = '#f0b90b';
                    else if (log.type === 'flashloan') color = '#8b5cf6';
                    logsHtml += '<div style="color: ' + color + '; padding: 3px 0;">[' + new Date(log.timestamp).toLocaleTimeString() + '] ' + log.message + '</div>';
                }
                document.getElementById('logsContainer').innerHTML = logsHtml;
            }
        } catch(e) { console.error(e); }
    }
    
    async function resetSimulation() {
        await fetch('/api/reset', { method: 'POST' });
        setTimeout(fetchState, 500);
    }
    
    fetchState();
    setInterval(fetchState, 2000);
</script>
</body>
</html>`;
    res.send(html);
});

// ==================== START BOT ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('⚡ FLASH LOAN ARBITRAGE BOT - ALL PANCAKESWAP TOKENS');
    console.log('='.repeat(60));
    console.log(`\n💰 Starting Balance: $${CONFIG.walletBalanceUSD.toFixed(2)}`);
    console.log(`🔍 Scanning ALL tokens on PancakeSwap...`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}\n`);
    
    await initBlockchain();
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
