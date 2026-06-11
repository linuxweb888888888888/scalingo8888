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
    maxProfitPercent: 10,  // Cap at 10% to filter unrealistic opportunities
    
    // Scan settings
    scanIntervalMs: 30000,
    maxTokensToScan: 200,
    opportunityCooldownMs: 5 * 60 * 1000, // Don't repeat same opportunity for 5 minutes
    
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
    
    // Reference tokens
    referenceTokens: {
        'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        'USDT': '0x55d398326f99059fF775485246999027B3197955',
        'WBNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    }
};

const FACTORY_ABI = [
    'function allPairs(uint256) external view returns (address)',
    'function allPairsLength() external view returns (uint256)'
];

const PAIR_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)'
];

const TOKEN_ABI = [
    'function symbol() external view returns (string)',
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
    
    // Track seen opportunities to prevent duplicates
    seenOpportunityKeys: new Map(), // key -> timestamp
    
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

function canAffordTransaction() {
    const gasCost = calculateGasCostUSD();
    return state.walletBalanceUSD > gasCost.usd * 1.1;
}

// Check if an opportunity was recently seen (prevents duplicates)
function isOpportunityDuplicate(token, buyDex, sellDex, loanAmount) {
    const key = `${token}|${buyDex}|${sellDex}|${loanAmount}`;
    const lastSeen = state.seenOpportunityKeys.get(key);
    
    if (lastSeen && (Date.now() - lastSeen) < CONFIG.opportunityCooldownMs) {
        return true; // Still in cooldown
    }
    
    // Update the timestamp
    state.seenOpportunityKeys.set(key, Date.now());
    
    // Clean up old keys (older than 1 hour)
    for (const [k, timestamp] of state.seenOpportunityKeys.entries()) {
        if (Date.now() - timestamp > 60 * 60 * 1000) {
            state.seenOpportunityKeys.delete(k);
        }
    }
    
    return false;
}

// Validate if profit percentage is realistic
function isRealisticProfit(profitPercent, tokenSymbol) {
    // Major tokens have tighter spreads
    const majorTokens = ['WBNB', 'BUSD', 'USDT', 'USDC', 'ETH', 'BTCB'];
    const isMajor = majorTokens.includes(tokenSymbol);
    
    if (isMajor && profitPercent > 2) {
        return false; // Major tokens shouldn't have >2% arbitrage
    }
    
    if (profitPercent > CONFIG.maxProfitPercent) {
        return false; // Cap at configured maximum
    }
    
    if (profitPercent < CONFIG.minProfitPercent) {
        return false; // Below minimum threshold
    }
    
    return true;
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
        
        for (const [key, dex] of Object.entries(CONFIG.otherDexes)) {
            otherRouters[key] = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        }
        
        const totalPairs = await factory.allPairsLength();
        state.totalPairs = totalPairs.toNumber();
        addLog(`✅ Connected to BSC. Total pairs: ${state.totalPairs.toLocaleString()}`, 'success');
        
        await updateBNBPrice();
        addLog(`💰 BNB Price: $${state.bnbPriceUSD.toFixed(2)}`, 'info');
        addLog(`💸 Wallet: $${state.walletBalanceUSD.toFixed(2)} (simulated)`, 'info');
        addLog(`⛽ Gas: ~$${calculateGasCostUSD().usd.toFixed(4)}/tx`, 'info');
        
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
    } catch (error) {}
}

// ==================== GET ALL TOKENS ====================
async function getAllTokens() {
    const tokens = new Map();
    const maxPairs = Math.min(state.totalPairs, CONFIG.maxTokensToScan * 2);
    
    addLog(`🔍 Scanning PancakeSwap for tokens...`, 'info');
    
    for (let i = 0; i < maxPairs && tokens.size < CONFIG.maxTokensToScan; i++) {
        try {
            const pairAddress = await factory.allPairs(i);
            const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
            
            const token0Address = await pair.token0();
            const token1Address = await pair.token1();
            
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
                    
                    if (symbol && symbol.length > 1 && symbol.length < 20 && !symbol.includes('?') && !symbol.includes('...')) {
                        tokens.set(tokenAddress, { address: tokenAddress, symbol: symbol, decimals: decimals });
                    }
                }
            }
        } catch (error) {}
    }
    
    state.allTokens = Array.from(tokens.values());
    addLog(`✅ Found ${state.allTokens.length} tradable tokens`, 'success');
    return state.allTokens;
}

// ==================== GET TOKEN PRICE ====================
async function getTokenPrice(tokenAddress, decimals, quoteToken = 'BUSD') {
    try {
        const quoteAddress = CONFIG.referenceTokens[quoteToken];
        if (!quoteAddress) return null;
        
        const amountIn = ethers.utils.parseUnits('100', 18);
        const amounts = await router.getAmountsOut(amountIn, [quoteAddress, tokenAddress]);
        const amountOut = parseFloat(ethers.utils.formatUnits(amounts[1], decimals));
        
        if (amountOut > 0 && amountOut < 1000000) {
            return 100 / amountOut;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ==================== FIND ARBITRAGE OPPORTUNITIES ====================
async function findAllArbitrageOpportunities() {
    const opportunities = [];
    const tokensToCheck = state.allTokens.slice(0, CONFIG.maxTokensToScan);
    
    for (const token of tokensToCheck) {
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
        
        if (!pancakePrice || pancakePrice <= 0) continue;
        
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
                
                if (otherPrice && otherPrice > 0 && otherPrice < 100000) {
                    const priceDiff = Math.abs((pancakePrice - otherPrice) / otherPrice) * 100;
                    
                    // Validate realistic profit
                    if (isRealisticProfit(priceDiff, token.symbol) && priceDiff < 10) { // Cap at 10%
                        for (const loanAmount of CONFIG.flashLoanAmounts) {
                            const grossProfit = loanAmount * (priceDiff / 100);
                            const flashLoanFee = loanAmount * 0.0009;
                            const gasCost = calculateGasCostUSD();
                            const netProfit = grossProfit - flashLoanFee - gasCost.usd;
                            
                            if (netProfit > CONFIG.minProfitUSD && netProfit < loanAmount * 0.1) { // Cap profit at 10% of loan
                                const buyDex = pancakePrice < otherPrice ? 'PancakeSwap' : dex.name;
                                const sellDex = pancakePrice < otherPrice ? dex.name : 'PancakeSwap';
                                
                                // Check for duplicates before adding
                                if (!isOpportunityDuplicate(token.symbol, buyDex, sellDex, loanAmount)) {
                                    opportunities.push({
                                        token: token.symbol,
                                        buyDex: buyDex,
                                        sellDex: sellDex,
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
                }
            } catch (error) {}
        }
    }
    
    // Sort by net profit and remove duplicates by key
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    
    // Final deduplication by token + buyDex + sellDex
    const uniqueByToken = new Map();
    for (const opp of opportunities) {
        const key = `${opp.token}|${opp.buyDex}|${opp.sellDex}`;
        if (!uniqueByToken.has(key) || uniqueByToken.get(key).netProfit < opp.netProfit) {
            uniqueByToken.set(key, opp);
        }
    }
    
    return Array.from(uniqueByToken.values()).slice(0, 10);
}

// ==================== SIMULATE FLASH LOAN ====================
async function executeSimulatedFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, netProfit, priceDiffPercent } = opportunity;
    
    addLog(`🔷 FLASH LOAN SIMULATION`, 'flashloan');
    addLog(`   Token: ${token} | Loan: $${loanAmount.toFixed(0)}`, 'info');
    addLog(`   ${buyDex} → ${sellDex} | Diff: ${priceDiffPercent.toFixed(2)}%`, 'info');
    addLog(`   Gross: $${grossProfit.toFixed(2)} | Fee: $${flashLoanFee.toFixed(2)} | Gas: $${gasCostUSD.toFixed(4)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)}`, 'profit');
    
    if (!canAffordTransaction()) {
        addLog(`❌ Insufficient balance for gas!`, 'error');
        return false;
    }
    
    state.totalTransactions++;
    state.totalGasSpentUSD += gasCostUSD;
    
    // 75% success rate for realistic simulation
    const success = Math.random() < 0.75;
    
    if (success && netProfit > 0) {
        state.walletBalanceUSD += netProfit;
        state.totalProfitUSD += netProfit;
        state.successfulTransactions++;
        
        addLog(`✅ SUCCESS! New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'success');
        
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
        addLog(`❌ FAILED! Lost gas: $${gasCostUSD.toFixed(4)}`, 'error');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            loss: gasCostUSD,
            success: false
        });
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function simulationLoop() {
    await getAllTokens();
    
    addLog(`🚀 Starting arbitrage scanning`, 'success');
    addLog(`⚡ Scanning ${state.allTokens.length} tokens | Cooldown: ${CONFIG.opportunityCooldownMs/1000}s`, 'info');
    
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            await updateBNBPrice();
            
            const opportunities = await findAllArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                // Add to state with timestamp
                for (const opp of opportunities) {
                    state.opportunities.unshift(opp);
                }
                // Keep only last 20
                if (state.opportunities.length > 20) state.opportunities.pop();
                
                const best = opportunities[0];
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net $${best.netProfit.toFixed(2)}`, 'profit');
                
                if (best.netProfit > CONFIG.minProfitUSD && canAffordTransaction()) {
                    await executeSimulatedFlashLoan(best);
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
    
    // Get unique opportunities for display
    const uniqueOpps = [];
    const seen = new Set();
    for (const opp of state.opportunities) {
        const key = `${opp.token}|${opp.buyDex}|${opp.sellDex}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueOpps.push(opp);
        }
    }
    
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
            totalPairs: state.totalPairs
        },
        opportunities: uniqueOpps.slice(0, 8),
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
    state.seenOpportunityKeys.clear();
    state.isRunning = true;
    
    addLog(`🔄 Bot reset. Balance: $${CONFIG.walletBalanceUSD.toFixed(2)}`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Bot - No Duplicates</title>
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
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; color: #0a0f1e; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Flash Loan Arbitrage Bot <span class="badge">NO DUPLICATES</span></h1>
        <p class="text-small">Each opportunity appears once | 10% profit cap | 5-minute cooldown</p>
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
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">🏆 UNIQUE OPPORTUNITIES</div>
            <div class="scrollable">
                <table id="oppTable">
                    <thead><tr><th>Token</th><th>Profit</th><th>Diff%</th><th>DEX</th></tr></thead>
                    <tbody><tr><td class="text-center">Scanning...</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-title">📋 TRADE HISTORY</div>
            <div class="scrollable">
                <table id="tradesTable">
                    <thead><tr><th>Time</th><th>Token</th><th>Result</th></tr></thead>
                    <tbody><tr><td class="text-center">No trades yet</td></tr></tbody>
                </table>
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
            
            if (data.opportunities && data.opportunities.length > 0) {
                let oppHtml = '<tr><th>Token</th><th>Profit</th><th>Diff%</th><th>DEX</th></tr>';
                for (let i = 0; i < Math.min(8, data.opportunities.length); i++) {
                    const o = data.opportunities[i];
                    oppHtml += '<tr><td>' + o.token + '</td><td class="profit">+$' + o.netProfit?.toFixed(2) + '</td><td>' + o.priceDiffPercent?.toFixed(2) + '%</td><td>' + (o.buyDex?.substring(0,8) || 'DEX') + '</td></tr>';
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
    console.log('⚡ FLASH LOAN ARBITRAGE BOT - FIXED (No Duplicates)');
    console.log('='.repeat(60));
    console.log(`\n💰 Starting Balance: $${CONFIG.walletBalanceUSD.toFixed(2)} (simulated)`);
    console.log(`🔍 Max profit: ${CONFIG.maxProfitPercent}% | Cooldown: ${CONFIG.opportunityCooldownMs/1000}s`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}\n`);
    
    await initBlockchain();
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
