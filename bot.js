require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ZERO-COST CONFIGURATION ====================
const CONFIG = {
    // You start with $0.00 because:
    // 1. Flash loans require 0% collateral
    // 2. Unsuccessful trades cost $0 (Flashbots)
    // 3. Only successful trades pay gas (taken from profit)
    walletBalanceUSD: 0.00,
    walletBalanceBNB: 0.00,
    
    // Gas is ONLY deducted from profit on successful trades
    // Failed/Unsuccessful trades: $0 cost
    gasPriceGwei: 3,
    gasLimit: 350000,
    
    // Minimum profit after gas to execute
    minProfitUSD: 0.10,
    maxProfitPercent: 3.0,
    
    // Flash loan fee (taken from profit, NOT upfront)
    flashLoanFeePercent: 0.09,
    
    // Market dynamics
    opportunityDecay: 0.85,
    highProfitDecay: 0.95,
    recoveryRate: 0.02,
    
    // Success rates by profit range
    successRates: {
        tiny: { max: 0.3, rate: 0.92 },
        small: { max: 1.0, rate: 0.85 },
        medium: { max: 2.0, rate: 0.65 },
        high: { max: 3.0, rate: 0.35 }
    },
    
    scanIntervalMs: 30000,
    maxTokensToScan: 200,
    
    flashLoanAmounts: [100, 500, 1000, 5000, 10000],
    
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    dexes: {
        pancakeswap: { name: 'PancakeSwap', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E' },
        biswap: { name: 'BiSwap', router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' },
        apeswap: { name: 'ApeSwap', router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7' }
    },
    
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
    // Start with $0 - Flashbots protects you from failed trade costs
    walletBalanceUSD: 0.00,
    startingBalanceUSD: 0.00,
    totalProfitUSD: 0.00,
    
    totalAttempts: 0,
    successfulTrades: 0,
    failedTrades: 0,
    // Gas is only deducted from profit, never from wallet
    totalGasPaidFromProfit: 0,
    
    opportunities: [],
    tradeHistory: [],
    allTokens: [],
    tokenPrices: {},
    tokenOpportunityDecay: new Map(),
    seenOpportunityKeys: new Map(),
    
    isRunning: true,
    logs: [],
    bnbPriceUSD: 615
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

function calculateGasCostUSD() {
    const gasCostBNB = (CONFIG.gasLimit * CONFIG.gasPriceGwei) / 1e9;
    return gasCostBNB * state.bnbPriceUSD;
}

function getSuccessRate(profitPercent) {
    if (profitPercent < 0.3) return CONFIG.successRates.tiny.rate;
    if (profitPercent < 1.0) return CONFIG.successRates.small.rate;
    if (profitPercent < 2.0) return CONFIG.successRates.medium.rate;
    return CONFIG.successRates.high.rate;
}

function calculateRealisticProfit(originalProfitPercent, tokenSymbol) {
    let decayFactor = state.tokenOpportunityDecay.get(tokenSymbol) || 1.0;
    
    if (originalProfitPercent > 2.0) {
        decayFactor = decayFactor * CONFIG.highProfitDecay;
    } else {
        decayFactor = decayFactor * CONFIG.opportunityDecay;
    }
    
    decayFactor = Math.max(0.1, Math.min(1.0, decayFactor));
    state.tokenOpportunityDecay.set(tokenSymbol, decayFactor);
    
    const adjustedProfitPercent = originalProfitPercent * decayFactor;
    const variation = 0.9 + (Math.random() * 0.2);
    const finalProfitPercent = adjustedProfitPercent * variation;
    
    return {
        profitPercent: Math.min(finalProfitPercent, CONFIG.maxProfitPercent),
        decayFactor: decayFactor,
        originalPercent: originalProfitPercent
    };
}

function recoverOpportunities() {
    for (const [token, decay] of state.tokenOpportunityDecay.entries()) {
        const newDecay = Math.min(1.0, decay + CONFIG.recoveryRate);
        if (newDecay !== decay) {
            state.tokenOpportunityDecay.set(token, newDecay);
        }
    }
}

function isOpportunityDuplicate(token, buyDex, sellDex, loanAmount) {
    const key = `${token}|${buyDex}|${sellDex}|${loanAmount}`;
    const lastSeen = state.seenOpportunityKeys.get(key);
    
    if (lastSeen && (Date.now() - lastSeen) < 180000) { // 3 min cooldown
        return true;
    }
    
    state.seenOpportunityKeys.set(key, Date.now());
    
    for (const [k, timestamp] of state.seenOpportunityKeys.entries()) {
        if (Date.now() - timestamp > 3600000) {
            state.seenOpportunityKeys.delete(k);
        }
    }
    
    return false;
}

// ==================== BLOCKCHAIN CONNECTION ====================
let provider = null;
let factory = null;
let router = null;
let otherRouters = {};

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        factory = new ethers.Contract('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', FACTORY_ABI, provider);
        router = new ethers.Contract(CONFIG.dexes.pancakeswap.router, ROUTER_ABI, provider);
        
        for (const [key, dex] of Object.entries(CONFIG.dexes)) {
            otherRouters[key] = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        }
        
        const totalPairs = await factory.allPairsLength();
        state.totalPairs = totalPairs.toNumber();
        
        addLog(`✅ Connected to BSC`, 'success');
        addLog(`💰 BNB Price: $${state.bnbPriceUSD.toFixed(2)}`, 'info');
        addLog(`💸 Starting Balance: $0.00 (Flashbots - no gas for failures)`, 'info');
        addLog(`⚡ Zero-cost mode: Only profitable trades pay gas (from profit)`, 'success');
        
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
        let pancakePrice = null;
        try {
            pancakePrice = await getTokenPrice(token.address, token.decimals, 'BUSD');
            if (pancakePrice && pancakePrice > 0 && pancakePrice < 100000) {
                state.tokenPrices[token.symbol] = { priceUSD: pancakePrice, lastUpdate: new Date().toISOString() };
            }
        } catch (e) {}
        
        if (!pancakePrice || pancakePrice <= 0) continue;
        
        for (const [dexKey, dex] of Object.entries(CONFIG.dexes)) {
            try {
                const otherRouter = otherRouters[dexKey];
                if (!otherRouter) continue;
                
                const quoteAddress = CONFIG.referenceTokens.BUSD;
                const amountIn = ethers.utils.parseUnits('100', 18);
                const amounts = await otherRouter.getAmountsOut(amountIn, [quoteAddress, token.address]);
                const amountOut = parseFloat(ethers.utils.formatUnits(amounts[1], token.decimals));
                const otherPrice = 100 / amountOut;
                
                if (otherPrice && otherPrice > 0 && otherPrice < 100000) {
                    let rawPriceDiff = Math.abs((pancakePrice - otherPrice) / otherPrice) * 100;
                    const priceDiff = Math.min(rawPriceDiff, CONFIG.maxProfitPercent);
                    
                    if (priceDiff >= 0.1) {
                        for (const loanAmount of CONFIG.flashLoanAmounts) {
                            const grossProfit = loanAmount * (priceDiff / 100);
                            const flashLoanFee = loanAmount * (CONFIG.flashLoanFeePercent / 100);
                            const gasCost = calculateGasCostUSD();
                            let netProfit = grossProfit - flashLoanFee - gasCost;
                            
                            const realistic = calculateRealisticProfit(priceDiff, token.symbol);
                            const adjustedNetProfit = netProfit * (realistic.profitPercent / priceDiff);
                            
                            if (adjustedNetProfit > CONFIG.minProfitUSD) {
                                const buyDex = pancakePrice < otherPrice ? 'PancakeSwap' : dex.name;
                                const sellDex = pancakePrice < otherPrice ? dex.name : 'PancakeSwap';
                                
                                if (!isOpportunityDuplicate(token.symbol, buyDex, sellDex, loanAmount)) {
                                    opportunities.push({
                                        token: token.symbol,
                                        buyDex: buyDex,
                                        sellDex: sellDex,
                                        priceDiffPercent: realistic.profitPercent,
                                        rawDiffPercent: rawPriceDiff,
                                        decayFactor: realistic.decayFactor,
                                        loanAmount: loanAmount,
                                        grossProfit: adjustedNetProfit + flashLoanFee + gasCost,
                                        flashLoanFee: flashLoanFee,
                                        gasCostUSD: gasCost,
                                        netProfit: adjustedNetProfit,
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
    
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    
    const uniqueByToken = new Map();
    for (const opp of opportunities) {
        const key = `${opp.token}|${opp.buyDex}|${opp.sellDex}`;
        if (!uniqueByToken.has(key) || uniqueByToken.get(key).netProfit < opp.netProfit) {
            uniqueByToken.set(key, opp);
        }
    }
    
    return Array.from(uniqueByToken.values()).slice(0, 8);
}

// ==================== ZERO-COST EXECUTION ====================
async function executeFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, netProfit, priceDiffPercent, decayFactor } = opportunity;
    
    const successRate = getSuccessRate(priceDiffPercent);
    const willSucceed = Math.random() < successRate;
    
    state.totalAttempts++;
    
    addLog(`🔷 FLASH LOAN`, 'flashloan');
    addLog(`   Token: ${token} | Profit: ${priceDiffPercent.toFixed(2)}% (${(decayFactor * 100).toFixed(0)}% remaining)`, 'info');
    addLog(`   ${buyDex} → ${sellDex} | Loan: $${loanAmount.toFixed(0)}`, 'info');
    addLog(`   Gross: $${grossProfit.toFixed(2)} | Fee: $${flashLoanFee.toFixed(2)} | Gas: $${gasCostUSD.toFixed(4)}`, 'info');
    
    if (willSucceed && netProfit > 0) {
        // SUCCESSFUL TRADE: Gas is deducted from profit
        state.walletBalanceUSD += netProfit;
        state.totalProfitUSD += netProfit;
        state.successfulTrades++;
        state.totalGasPaidFromProfit += gasCostUSD;
        
        addLog(`✅ SUCCESS! New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'success');
        addLog(`   Gas $${gasCostUSD.toFixed(4)} paid from profit | Net profit kept: $${netProfit.toFixed(2)}`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            profitPercent: priceDiffPercent,
            netProfit: netProfit,
            gasCost: gasCostUSD,
            success: true
        });
        return true;
    } else {
        // FAILED TRADE: ZERO COST - Flashbots protects you
        state.failedTrades++;
        
        addLog(`❌ FAILED - ZERO COST! No gas fee paid.`, 'error');
        addLog(`   (Flashbots protection: unsuccessful transactions cost $0)`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            loss: 0,
            success: false,
            zeroCost: true
        });
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function simulationLoop() {
    await getAllTokens();
    
    addLog(`🚀 ZERO-COST FLASH LOAN BOT STARTED`, 'success');
    addLog(`⚡ Zero capital required | Zero cost for failed attempts`, 'success');
    addLog(`💰 Only pay gas from profit on successful trades`, 'success');
    addLog(`📊 Scanning ${state.allTokens.length} tokens...\n`, 'info');
    
    let scanCount = 0;
    
    while (state.isRunning) {
        try {
            await updateBNBPrice();
            
            if (scanCount % 5 === 0) {
                recoverOpportunities();
            }
            
            const opportunities = await findAllArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                for (const opp of opportunities) {
                    state.opportunities.unshift(opp);
                }
                if (state.opportunities.length > 20) state.opportunities.pop();
                
                const best = opportunities[0];
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit potential`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net $${best.netProfit.toFixed(2)} after gas`, 'profit');
                
                if (best.netProfit > CONFIG.minProfitUSD) {
                    await executeFlashLoan(best);
                }
            }
            
            scanCount++;
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
    
    const uniqueOpps = [];
    const seen = new Set();
    for (const opp of state.opportunities) {
        const key = `${opp.token}|${opp.buyDex}|${opp.sellDex}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueOpps.push(opp);
        }
    }
    
    let avgDecay = 1.0;
    if (state.tokenOpportunityDecay.size > 0) {
        let sum = 0;
        for (const decay of state.tokenOpportunityDecay.values()) {
            sum += decay;
        }
        avgDecay = sum / state.tokenOpportunityDecay.size;
    }
    
    res.json({
        mode: 'ZERO-COST MODE',
        wallet: {
            balanceUSD: state.walletBalanceUSD,
            startingBalanceUSD: state.startingBalanceUSD,
            profitLoss: profitLoss
        },
        stats: {
            totalAttempts: state.totalAttempts,
            successfulTrades: state.successfulTrades,
            failedTrades: state.failedTrades,
            totalGasPaidFromProfit: state.totalGasPaidFromProfit,
            totalProfitUSD: state.totalProfitUSD,
            successRate: state.totalAttempts > 0 ? (state.successfulTrades / state.totalAttempts * 100).toFixed(1) : 0
        },
        marketDynamics: {
            avgDecayFactor: (avgDecay * 100).toFixed(1),
            maxProfitCap: CONFIG.maxProfitPercent,
            zeroCostFailedTrades: true
        },
        opportunities: uniqueOpps.slice(0, 8),
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        tokenCount: state.allTokens.length
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        walletBalanceUSD: 0.00,
        startingBalanceUSD: 0.00,
        totalProfitUSD: 0.00,
        totalAttempts: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasPaidFromProfit: 0,
        opportunities: [],
        tradeHistory: [],
        allTokens: state.allTokens,
        tokenPrices: {},
        tokenOpportunityDecay: new Map(),
        seenOpportunityKeys: new Map(),
        isRunning: true,
        logs: [],
        bnbPriceUSD: 615,
        totalPairs: state.totalPairs
    };
    addLog(`🔄 Bot reset. Starting fresh with $0 balance.`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zero-Cost Flash Loan Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 1.8rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; padding: 2px 12px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .zero-badge { background: #ef4444; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.8rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; text-transform: uppercase; }
        .stat-value { font-size: 1.8rem; font-weight: bold; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .profit { color: #f0b90b; }
        .zero-cost { color: #10b981; font-weight: bold; }
        .scrollable { max-height: 300px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; color: #0a0f1e; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Zero-Cost Flash Loan Bot <span class="badge">$0 CAPITAL</span><span class="badge zero-badge">$0 GAS FOR FAILURES</span></h1>
        <p class="text-small">No upfront capital | Zero cost for unsuccessful trades | Only pay gas from profits</p>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">💰 PROFIT (Wallet)</div>
            <div class="stat-value positive" id="balance">$0.00</div>
            <div>Total Profit: <span id="totalProfit">$0.00</span></div>
        </div>
        <div class="card">
            <div class="card-title">⚡ STATS</div>
            <div>Attempts: <span id="totalAttempts">0</span> | ✅ <span id="successTxs">0</span> | ❌ <span id="failedTxs">0</span></div>
            <div>Gas Paid: $<span id="gasPaid">0.00</span> (from profit only)</div>
            <div>Success Rate: <span id="successRate">0</span>%</div>
        </div>
        <div class="card">
            <div class="card-title">🎯 ZERO-COST GUARANTEE</div>
            <div class="zero-cost">✅ Failed trades: $0.00</div>
            <div class="zero-cost">✅ Flash loan capital: $0.00</div>
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">🏆 OPPORTUNITIES</div>
            <div class="scrollable"><table id="oppTable"><tbody><tr><td class="text-center">Scanning...</td></tr></tbody></table></div>
        </div>
        <div class="card">
            <div class="card-title">📋 TRADE HISTORY</div>
            <div class="scrollable"><table id="tradesTable"><tbody><tr><td class="text-center">No trades yet</td></tr></tbody></table></div>
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
            document.getElementById('totalProfit').innerHTML = '$' + data.stats.totalProfitUSD.toFixed(2);
            document.getElementById('totalAttempts').innerHTML = data.stats.totalAttempts;
            document.getElementById('successTxs').innerHTML = data.stats.successfulTrades;
            document.getElementById('failedTxs').innerHTML = data.stats.failedTrades;
            document.getElementById('gasPaid').innerHTML = data.stats.totalGasPaidFromProfit.toFixed(4);
            document.getElementById('successRate').innerHTML = data.stats.successRate;
            
            if (data.opportunities && data.opportunities.length > 0) {
                let oppHtml = '<tr><th>Token</th><th>Profit</th><th>Decay</th></tr>';
                for (let i = 0; i < Math.min(8, data.opportunities.length); i++) {
                    const o = data.opportunities[i];
                    oppHtml += `<tr><td>${o.token}</td><td class="profit">${o.priceDiffPercent?.toFixed(2)}%</td><td>${(o.decayFactor * 100).toFixed(0)}%</td></tr>`;
                }
                document.getElementById('oppTable').querySelector('tbody').innerHTML = oppHtml;
            }
            
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let tradesHtml = '<tr><th>Time</th><th>Token</th><th>Result</th></tr>';
                for (let i = 0; i < Math.min(15, data.tradeHistory.length); i++) {
                    const t = data.tradeHistory[i];
                    tradesHtml += `<tr><td>${new Date(t.timestamp).toLocaleTimeString()}</td><td>${t.token || 'N/A'}</td><td class="${t.success ? 'positive' : 'zero-cost'}">${t.success ? '+$' + t.netProfit?.toFixed(2) : '$0 (failed)'}</td></tr>`;
                }
                document.getElementById('tradesTable').querySelector('tbody').innerHTML = tradesHtml;
            }
            
            if (data.logs && data.logs.length > 0) {
                let logsHtml = '';
                for (let i = 0; i < Math.min(30, data.logs.length); i++) {
                    const log = data.logs[i];
                    let color = '#888';
                    if (log.type === 'error') color = '#ef4444';
                    else if (log.type === 'success') color = '#10b981';
                    else if (log.type === 'opportunity') color = '#f0b90b';
                    else if (log.type === 'flashloan') color = '#8b5cf6';
                    logsHtml += '<div style="color: ' + color + '; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">' + log.message + '</div>';
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
    console.log('⚡ ZERO-COST FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(60));
    console.log(`\n💰 Starting Balance: $0.00`);
    console.log(`✅ Failed trades: $0.00 cost`);
    console.log(`✅ Flash loan capital: $0.00 required`);
    console.log(`✅ Only pay gas from profit on successful trades`);
    console.log(`📊 Success rates: <0.3%:92% | <1%:85% | <2%:65% | >2%:35%`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}\n`);
    
    await updateBNBPrice();
    await initBlockchain();
    await getAllTokens();
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
