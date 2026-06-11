require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== REALISTIC CONFIGURATION ====================
const CONFIG = {
    mode: 'SIMULATION',
    
    // Wallet balance
    walletBalanceBNB: 0.0065,
    walletBalanceUSD: 4.00,
    
    // Gas settings
    gasPriceGwei: 3,
    gasLimit: 350000,
    
    // Realistic thresholds
    minProfitUSD: 0.50,
    maxProfitPercent: 3.0,        // Realistic cap: 3% max profit
    
    // Market dynamics
    opportunityDecay: 0.85,        // Each trade reduces opportunity by 15%
    highProfitDecay: 0.95,         // High profit (>2%) decays even faster
    recoveryRate: 0.02,            // Slow recovery over time
    
    // Success rates by profit range
    successRates: {
        tiny: { max: 0.3, rate: 0.92 },     // <0.3% profit: 92% success
        small: { max: 1.0, rate: 0.85 },    // 0.3-1.0% profit: 85% success
        medium: { max: 2.0, rate: 0.65 },   // 1.0-2.0% profit: 65% success
        high: { max: 3.0, rate: 0.35 }      // 2.0-3.0% profit: 35% success
    },
    
    // Scan settings
    scanIntervalMs: 30000,
    maxTokensToScan: 200,
    opportunityCooldownMs: 3 * 60 * 1000,   // 3 minute cooldown
    
    // Flash loan amounts
    flashLoanAmounts: [100, 500, 1000, 5000, 10000],
    flashLoanFeePercent: 0.09,
    
    // BSC Configuration
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    // DEXes
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
    walletBalanceUSD: 4.00,
    startingBalanceUSD: 4.00,
    walletBalanceBNB: 0.0065,
    
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalGasSpentUSD: 0,
    totalProfitUSD: 0,
    
    opportunities: [],
    tradeHistory: [],
    allTokens: [],
    tokenPrices: {},
    tokenOpportunityDecay: new Map(),  // Track decay per token
    
    seenOpportunityKeys: new Map(),
    
    isRunning: true,
    lastScanTime: Date.now(),
    logs: [],
    bnbPriceUSD: 615
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message: message.substring(0, 200), type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

function calculateGasCostUSD() {
    const gasCostBNB = (CONFIG.gasLimit * CONFIG.gasPriceGwei) / 1e9;
    return { bnb: gasCostBNB, usd: gasCostBNB * state.bnbPriceUSD };
}

function getSuccessRate(profitPercent) {
    if (profitPercent < 0.3) return CONFIG.successRates.tiny.rate;
    if (profitPercent < 1.0) return CONFIG.successRates.small.rate;
    if (profitPercent < 2.0) return CONFIG.successRates.medium.rate;
    return CONFIG.successRates.high.rate;
}

function calculateRealisticProfit(originalProfitPercent, tokenSymbol, tradeCount) {
    // Get decay factor for this token
    let decayFactor = state.tokenOpportunityDecay.get(tokenSymbol) || 1.0;
    
    // High profit opportunities decay faster
    if (originalProfitPercent > 2.0) {
        decayFactor = decayFactor * CONFIG.highProfitDecay;
    } else {
        decayFactor = decayFactor * CONFIG.opportunityDecay;
    }
    
    // Ensure decay doesn't go below 0.1 (10% of original)
    decayFactor = Math.max(0.1, Math.min(1.0, decayFactor));
    
    // Store updated decay
    state.tokenOpportunityDecay.set(tokenSymbol, decayFactor);
    
    // Apply decay to profit
    const adjustedProfitPercent = originalProfitPercent * decayFactor;
    
    // Add small random variation (±10%)
    const variation = 0.9 + (Math.random() * 0.2);
    const finalProfitPercent = adjustedProfitPercent * variation;
    
    return {
        profitPercent: finalProfitPercent,
        decayFactor: decayFactor,
        originalPercent: originalProfitPercent
    };
}

function recoverOpportunities() {
    // Slowly recover decayed opportunities over time
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
    
    if (lastSeen && (Date.now() - lastSeen) < CONFIG.opportunityCooldownMs) {
        return true;
    }
    
    state.seenOpportunityKeys.set(key, Date.now());
    
    for (const [k, timestamp] of state.seenOpportunityKeys.entries()) {
        if (Date.now() - timestamp > 60 * 60 * 1000) {
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
        addLog(`✅ Connected to BSC. Total pairs: ${state.totalPairs.toLocaleString()}`, 'success');
        
        await updateBNBPrice();
        addLog(`💰 BNB Price: $${state.bnbPriceUSD.toFixed(2)}`, 'info');
        addLog(`💸 Starting Balance: $${state.walletBalanceUSD.toFixed(2)} (simulated)`, 'info');
        addLog(`🎯 Realistic profit cap: ${CONFIG.maxProfitPercent}%`, 'info');
        
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
    
    addLog(`🔍 Scanning for tokens on PancakeSwap...`, 'info');
    
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
                    
                    // Cap at realistic maximum
                    const priceDiff = Math.min(rawPriceDiff, CONFIG.maxProfitPercent);
                    
                    if (priceDiff >= 0.1) {
                        for (const loanAmount of CONFIG.flashLoanAmounts) {
                            const grossProfit = loanAmount * (priceDiff / 100);
                            const flashLoanFee = loanAmount * (CONFIG.flashLoanFeePercent / 100);
                            const gasCost = calculateGasCostUSD();
                            let netProfit = grossProfit - flashLoanFee - gasCost.usd;
                            
                            // Apply decay for this token (market impact)
                            const tradeCount = state.tradeHistory.filter(t => t.token === token.symbol).length;
                            const realistic = calculateRealisticProfit(priceDiff, token.symbol, tradeCount);
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
                                        grossProfit: adjustedNetProfit + flashLoanFee + gasCost.usd,
                                        flashLoanFee: flashLoanFee,
                                        gasCostUSD: gasCost.usd,
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

// ==================== EXECUTE FLASH LOAN ====================
async function executeFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, netProfit, priceDiffPercent, decayFactor } = opportunity;
    
    const successRate = getSuccessRate(priceDiffPercent);
    const willSucceed = Math.random() < successRate;
    
    addLog(`🔷 FLASH LOAN`, 'flashloan');
    addLog(`   Token: ${token} | Profit: ${priceDiffPercent.toFixed(2)}% (decay: ${(decayFactor * 100).toFixed(0)}%)`, 'info');
    addLog(`   ${buyDex} → ${sellDex} | Loan: $${loanAmount.toFixed(0)}`, 'info');
    addLog(`   Gross: $${grossProfit.toFixed(2)} | Fee: $${flashLoanFee.toFixed(2)} | Gas: $${gasCostUSD.toFixed(4)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)} | Success Rate: ${(successRate * 100).toFixed(0)}%`, 'profit');
    
    state.totalTrades++;
    state.totalGasSpentUSD += gasCostUSD;
    
    if (willSucceed && netProfit > 0) {
        state.walletBalanceUSD += netProfit;
        state.totalProfitUSD += netProfit;
        state.successfulTrades++;
        addLog(`✅ SUCCESS! New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'success');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            token: token,
            profitPercent: priceDiffPercent,
            netProfit: netProfit,
            decayFactor: decayFactor,
            success: true
        });
        return true;
    } else {
        state.failedTrades++;
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
    
    addLog(`🚀 Realistic arbitrage bot started`, 'success');
    addLog(`⚡ Scanning ${state.allTokens.length} tokens | Max profit: ${CONFIG.maxProfitPercent}%`, 'info');
    addLog(`📊 Success rates: <0.3%:92% | <1%:85% | <2%:65% | >2%:35%`, 'info');
    
    let scanCount = 0;
    
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            await updateBNBPrice();
            
            // Recover opportunities slowly over time
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
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit (${best.rawDiffPercent?.toFixed(2)}% raw, ${(best.decayFactor * 100).toFixed(0)}% remaining)`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net $${best.netProfit.toFixed(2)}`, 'profit');
                
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
    
    // Calculate average decay factor
    let avgDecay = 1.0;
    if (state.tokenOpportunityDecay.size > 0) {
        let sum = 0;
        for (const decay of state.tokenOpportunityDecay.values()) {
            sum += decay;
        }
        avgDecay = sum / state.tokenOpportunityDecay.size;
    }
    
    res.json({
        mode: 'REALISTIC SIMULATION',
        wallet: {
            balanceUSD: state.walletBalanceUSD,
            startingBalanceUSD: state.startingBalanceUSD,
            profitLoss: profitLoss,
            profitPercent: profitPercent
        },
        stats: {
            totalTrades: state.totalTrades,
            successfulTrades: state.successfulTrades,
            failedTrades: state.failedTrades,
            totalGasSpentUSD: state.totalGasSpentUSD,
            totalProfitUSD: state.totalProfitUSD,
            avgSuccessRate: (state.successfulTrades / (state.totalTrades || 1) * 100).toFixed(1)
        },
        marketDynamics: {
            avgDecayFactor: (avgDecay * 100).toFixed(1),
            maxProfitCap: CONFIG.maxProfitPercent,
            opportunityCooldown: CONFIG.opportunityCooldownMs / 1000
        },
        opportunities: uniqueOpps.slice(0, 8),
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        tokenCount: state.allTokens.length
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        walletBalanceUSD: 4.00,
        startingBalanceUSD: 4.00,
        walletBalanceBNB: 0.0065,
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasSpentUSD: 0,
        totalProfitUSD: 0,
        opportunities: [],
        tradeHistory: [],
        allTokens: state.allTokens,
        tokenPrices: {},
        tokenOpportunityDecay: new Map(),
        seenOpportunityKeys: new Map(),
        isRunning: true,
        lastScanTime: Date.now(),
        logs: [],
        bnbPriceUSD: 615,
        totalPairs: state.totalPairs
    };
    addLog(`🔄 Bot reset. Balance restored to $4.00`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Realistic Flash Loan Arbitrage Bot</title>
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
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; color: #0a0f1e; }
        .decay-bar { background: #334155; border-radius: 4px; height: 4px; width: 100%; margin-top: 4px; }
        .decay-fill { background: #f0b90b; border-radius: 4px; height: 100%; width: 0%; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Realistic Flash Loan Arbitrage Bot <span class="badge">MARKET DYNAMICS</span></h1>
        <p class="text-small">Realistic profit decay | Success rates based on profit % | No persistent 6% arbitrage</p>
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
            <div>Success Rate: <span id="successRate">0</span>%</div>
        </div>
        <div class="card">
            <div class="card-title">📊 MARKET DYNAMICS</div>
            <div>Max Profit Cap: <span id="maxProfit">3.0</span>%</div>
            <div>Opportunity Decay: <span id="avgDecay">100</span>%</div>
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">🏆 UNIQUE OPPORTUNITIES</div>
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
            document.getElementById('pnl').innerHTML = (data.wallet.profitLoss >= 0 ? '+' : '') + '$' + Math.abs(data.wallet.profitLoss).toFixed(2);
            document.getElementById('pnlPercent').innerHTML = (data.wallet.profitPercent >= 0 ? '+' : '') + data.wallet.profitPercent.toFixed(2) + '%';
            document.getElementById('totalTxs').innerHTML = data.stats.totalTrades;
            document.getElementById('successTxs').innerHTML = data.stats.successfulTrades;
            document.getElementById('failedTxs').innerHTML = data.stats.failedTrades;
            document.getElementById('gasSpent').innerHTML = data.stats.totalGasSpentUSD?.toFixed(4) || '0.00';
            document.getElementById('totalProfit').innerHTML = data.stats.totalProfitUSD?.toFixed(2) || '0.00';
            document.getElementById('successRate').innerHTML = data.stats.avgSuccessRate || '0';
            document.getElementById('avgDecay').innerHTML = data.marketDynamics?.avgDecayFactor || '100';
            document.getElementById('maxProfit').innerHTML = data.marketDynamics?.maxProfitCap || '3.0';
            
            if (data.opportunities && data.opportunities.length > 0) {
                let oppHtml = '<tr><th>Token</th><th>Profit</th><th>Decay</th></tr>';
                for (let i = 0; i < Math.min(8, data.opportunities.length); i++) {
                    const o = data.opportunities[i];
                    oppHtml += `<tr>
                        <td>${o.token}</td>
                        <td class="profit">${o.priceDiffPercent?.toFixed(2)}%</td>
                        <td>${(o.decayFactor * 100).toFixed(0)}%</td>
                    </tr>`;
                }
                document.getElementById('oppTable').querySelector('tbody').innerHTML = oppHtml;
            }
            
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let tradesHtml = '<tr><th>Time</th><th>Token</th><th>Result</th></tr>';
                for (let i = 0; i < Math.min(15, data.tradeHistory.length); i++) {
                    const t = data.tradeHistory[i];
                    tradesHtml += `<tr>
                        <td>${new Date(t.timestamp).toLocaleTimeString()}</td>
                        <td>${t.token || 'N/A'}</td>
                        <td class="${t.success ? 'positive' : 'negative'}">${t.success ? '+$' + t.netProfit?.toFixed(2) : '-$' + t.loss?.toFixed(4)}</td>
                    </tr>`;
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
    console.log('⚡ REALISTIC FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(60));
    console.log(`\n💰 Starting Balance: $4.00 (simulated)`);
    console.log(`🎯 Realistic profit cap: ${CONFIG.maxProfitPercent}%`);
    console.log(`📊 Success rates: <0.3%:92% | <1%:85% | <2%:65% | >2%:35%`);
    console.log(`🔄 Opportunity decay: ${CONFIG.opportunityDecay * 100}% per trade`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}\n`);
    
    await initBlockchain();
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
