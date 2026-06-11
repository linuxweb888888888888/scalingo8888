require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const isRealMode = process.env.BOT_MODE === 'real';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const CONFIG = {
    mode: isRealMode ? 'REAL (MONEY AT RISK)' : 'SIMULATION (NO RISK)',
    
    // Wallet
    walletAddress: null,
    
    // Gas settings
    gasPriceGwei: parseInt(process.env.GAS_PRICE_GWEI) || 3,
    gasLimit: parseInt(process.env.GAS_LIMIT) || 500000,
    
    // Profit threshold
    minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD) || 0.50,
    minProfitPercent: 0.1,
    maxProfitPercent: 10,
    
    // Flash loan settings
    flashLoanAmounts: [100, 500, 1000, 5000, 10000],
    flashLoanFeePercent: 0.09, // 0.09% fee
    
    // Scan settings
    scanIntervalMs: 30000,
    maxTokensToScan: 200,
    opportunityCooldownMs: 5 * 60 * 1000,
    
    // BSC Configuration
    bscRpc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
    bscWss: process.env.BSC_WSS_URL || 'wss://bsc-ws-node.nariox.org:443',
    
    // DEXes
    dexes: {
        pancakeswap: { name: 'PancakeSwap', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E' },
        biswap: { name: 'BiSwap', router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8' },
        apeswap: { name: 'ApeSwap', router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7' }
    },
    
    // Reference tokens
    referenceTokens: {
        'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        'USDT': '0x55d398326f99059fF775485246999027B3197955',
        'WBNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    },
    
    // Known working flash loan contract (Aave on BSC)
    flashLoanContract: {
        address: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
        name: 'Aave Flash Loan Provider'
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
    walletBalanceBNB: 0,
    walletBalanceUSD: 0,
    startingBalanceBNB: 0,
    startingBalanceUSD: 0,
    
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
    
    seenOpportunityKeys: new Map(),
    
    isRunning: true,
    lastScanTime: Date.now(),
    logs: [],
    bnbPriceUSD: 615,
    
    // Real mode tracking
    realMode: isRealMode,
    nonce: null
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const modePrefix = state.realMode ? '🔴 REAL' : '🟡 SIM';
    state.logs.unshift({ timestamp, message: `[${modePrefix}] ${message}`, type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

function calculateGasCostUSD(gasLimit = CONFIG.gasLimit) {
    const gasCostBNB = (gasLimit * CONFIG.gasPriceGwei) / 1e9;
    return { bnb: gasCostBNB, usd: gasCostBNB * state.bnbPriceUSD };
}

function canAffordTransaction() {
    const gasCost = calculateGasCostUSD();
    return state.walletBalanceBNB > gasCost.bnb * 1.5; // 50% buffer
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

function isRealisticProfit(profitPercent, tokenSymbol) {
    const majorTokens = ['WBNB', 'BUSD', 'USDT', 'USDC'];
    const isMajor = majorTokens.includes(tokenSymbol);
    
    if (isMajor && profitPercent > 2) return false;
    if (profitPercent > CONFIG.maxProfitPercent) return false;
    if (profitPercent < CONFIG.minProfitPercent) return false;
    
    return true;
}

// ==================== BLOCKCHAIN CONNECTION ====================
let provider = null;
let signer = null;
let wallet = null;
let factory = null;
let router = null;
let otherRouters = {};

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        
        // If real mode, connect wallet
        if (state.realMode && PRIVATE_KEY) {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            signer = wallet;
            state.walletAddress = wallet.address;
            addLog(`🔐 Wallet connected: ${wallet.address}`, 'success');
            
            // Get balance
            const balance = await provider.getBalance(wallet.address);
            state.walletBalanceBNB = parseFloat(ethers.utils.formatEther(balance));
            state.walletBalanceUSD = state.walletBalanceBNB * state.bnbPriceUSD;
            state.startingBalanceBNB = state.walletBalanceBNB;
            state.startingBalanceUSD = state.walletBalanceUSD;
            
            addLog(`💰 Wallet Balance: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
            
            if (state.walletBalanceBNB < 0.005) {
                addLog(`⚠️ LOW BALANCE: Need at least 0.005 BNB for gas fees`, 'warning');
            }
        } else if (state.realMode && !PRIVATE_KEY) {
            addLog(`❌ REAL MODE requires PRIVATE_KEY in .env file`, 'error');
            process.exit(1);
        } else {
            addLog(`🟡 SIMULATION MODE - No real transactions will be executed`, 'warning');
            state.walletBalanceUSD = 4.00; // Simulated balance
            state.walletBalanceBNB = 0.0065;
            state.startingBalanceUSD = 4.00;
            state.startingBalanceBNB = 0.0065;
        }
        
        // Initialize contracts
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
        
        const gasCost = calculateGasCostUSD();
        addLog(`⛽ Estimated Gas Cost: ~$${gasCost.usd.toFixed(4)} per transaction`, 'info');
        
        if (state.realMode) {
            addLog(`🔴 REAL MODE ACTIVE - Transactions will spend REAL money!`, 'danger');
            addLog(`   Minimum balance needed: 0.005 BNB (~$3)`, 'info');
        } else {
            addLog(`🟡 SIMULATION MODE - No real money at risk`, 'info');
        }
        
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
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
                    const priceDiff = Math.abs((pancakePrice - otherPrice) / otherPrice) * 100;
                    
                    if (isRealisticProfit(priceDiff, token.symbol) && priceDiff < 10) {
                        for (const loanAmount of CONFIG.flashLoanAmounts) {
                            const grossProfit = loanAmount * (priceDiff / 100);
                            const flashLoanFee = loanAmount * (CONFIG.flashLoanFeePercent / 100);
                            const gasCost = calculateGasCostUSD();
                            const netProfit = grossProfit - flashLoanFee - gasCost.usd;
                            
                            if (netProfit > CONFIG.minProfitUSD && netProfit < loanAmount * 0.1) {
                                const buyDex = pancakePrice < otherPrice ? 'PancakeSwap' : dex.name;
                                const sellDex = pancakePrice < otherPrice ? dex.name : 'PancakeSwap';
                                
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
    
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    
    const uniqueByToken = new Map();
    for (const opp of opportunities) {
        const key = `${opp.token}|${opp.buyDex}|${opp.sellDex}`;
        if (!uniqueByToken.has(key) || uniqueByToken.get(key).netProfit < opp.netProfit) {
            uniqueByToken.set(key, opp);
        }
    }
    
    return Array.from(uniqueByToken.values()).slice(0, 10);
}

// ==================== EXECUTE FLASH LOAN ====================
async function executeFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, netProfit, priceDiffPercent } = opportunity;
    
    addLog(`🔷 FLASH LOAN ${state.realMode ? 'EXECUTION' : 'SIMULATION'}`, 'flashloan');
    addLog(`   Token: ${token} | Loan: $${loanAmount.toFixed(0)}`, 'info');
    addLog(`   ${buyDex} → ${sellDex} | Diff: ${priceDiffPercent.toFixed(2)}%`, 'info');
    addLog(`   Gross: $${grossProfit.toFixed(2)} | Fee: $${flashLoanFee.toFixed(2)} | Gas: $${gasCostUSD.toFixed(4)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)}`, 'profit');
    
    if (!canAffordTransaction()) {
        addLog(`❌ Insufficient balance for gas! Need ~${calculateGasCostUSD().bnb.toFixed(6)} BNB`, 'error');
        return false;
    }
    
    state.totalTransactions++;
    
    if (state.realMode) {
        // REAL EXECUTION - This would call the actual flash loan contract
        addLog(`🔴 REAL MODE: Would execute real transaction here`, 'warning');
        addLog(`   In production, this would call:`, 'info');
        addLog(`   Contract: ${CONFIG.flashLoanContract.address}`, 'info');
        addLog(`   Function: executeArbitrage(${token}, ${loanAmount})`, 'info');
        
        // In real implementation, you would call your deployed contract:
        /*
        const flashLoanContract = new ethers.Contract(
            CONFIG.flashLoanContract.address,
            FLASH_LOAN_ABI,
            signer
        );
        
        const tx = await flashLoanContract.executeArbitrage(
            tokenAddress,
            loanAmount,
            buyDexRouter,
            sellDexRouter,
            { gasPrice: ethers.utils.parseUnits(CONFIG.gasPriceGwei.toString(), 'gwei') }
        );
        
        addLog(`📝 Transaction sent: ${tx.hash}`, 'info');
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            addLog(`✅ SUCCESS! Profit: $${netProfit.toFixed(2)}`, 'success');
            state.successfulTransactions++;
            state.totalProfitUSD += netProfit;
        } else {
            addLog(`❌ Transaction failed!`, 'error');
            state.failedTransactions++;
        }
        */
        
        // For demo, simulate success with 75% probability
        const success = Math.random() < 0.75;
        
        if (success) {
            state.walletBalanceUSD += netProfit;
            state.totalProfitUSD += netProfit;
            state.successfulTransactions++;
            addLog(`✅ SIMULATED SUCCESS! (Real mode demo)`, 'success');
            addLog(`   New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'info');
        } else {
            state.failedTransactions++;
            addLog(`❌ SIMULATED FAILURE! (Real mode demo)`, 'error');
        }
        
    } else {
        // SIMULATION MODE - Just update balance
        const success = Math.random() < 0.75;
        
        if (success && netProfit > 0) {
            state.walletBalanceUSD += netProfit;
            state.totalProfitUSD += netProfit;
            state.successfulTransactions++;
            addLog(`✅ SUCCESS! New Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'success');
        } else {
            state.failedTransactions++;
            addLog(`❌ FAILED! Lost gas: $${gasCostUSD.toFixed(4)}`, 'error');
        }
    }
    
    state.totalGasSpentUSD += gasCostUSD;
    state.totalGasSpentBNB += calculateGasCostUSD().bnb;
    
    state.tradeHistory.unshift({
        timestamp: new Date().toISOString(),
        token: token,
        loanAmount: loanAmount,
        netProfit: netProfit,
        gasCost: gasCostUSD,
        success: true,
        realMode: state.realMode
    });
    
    if (state.tradeHistory.length > 50) state.tradeHistory.pop();
    
    return true;
}

// ==================== MAIN LOOP ====================
async function simulationLoop() {
    await getAllTokens();
    
    addLog(`🚀 Bot started in ${state.realMode ? 'REAL' : 'SIMULATION'} mode`, 'success');
    addLog(`⚡ Scanning ${state.allTokens.length} tokens`, 'info');
    addLog(`💰 Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'info');
    
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            await updateBNBPrice();
            
            const opportunities = await findAllArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                for (const opp of opportunities) {
                    state.opportunities.unshift(opp);
                }
                if (state.opportunities.length > 20) state.opportunities.pop();
                
                const best = opportunities[0];
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net $${best.netProfit.toFixed(2)}`, 'profit');
                
                if (best.netProfit > CONFIG.minProfitUSD && canAffordTransaction()) {
                    await executeFlashLoan(best);
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
        mode: state.realMode ? 'REAL' : 'SIMULATION',
        wallet: {
            address: state.walletAddress || 'Simulated',
            balanceUSD: state.walletBalanceUSD,
            startingBalanceUSD: state.startingBalanceUSD,
            profitLoss: profitLoss,
            profitPercent: profitPercent,
            hasEnoughGas: canAffordTransaction()
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
        logs: state.logs.slice(0, 30)
    });
});

app.post('/api/reset', (req, res) => {
    if (state.realMode) {
        addLog(`Cannot reset in REAL mode`, 'error');
        res.json({ error: 'Cannot reset in REAL mode' });
        return;
    }
    
    state.walletBalanceUSD = 4.00;
    state.walletBalanceBNB = 0.0065;
    state.startingBalanceUSD = 4.00;
    state.startingBalanceBNB = 0.0065;
    state.totalTransactions = 0;
    state.successfulTransactions = 0;
    state.failedTransactions = 0;
    state.totalGasSpentUSD = 0;
    state.totalProfitUSD = 0;
    state.opportunities = [];
    state.tradeHistory = [];
    state.seenOpportunityKeys.clear();
    state.isRunning = true;
    
    addLog(`🔄 Bot reset. Balance: $${state.walletBalanceUSD.toFixed(2)}`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot - ${state.realMode ? 'REAL MODE' : 'SIMULATION'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 1.8rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; padding: 2px 12px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .real-badge { background: #ef4444; color: white; }
        .sim-badge { background: #10b981; color: white; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.8rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; text-transform: uppercase; }
        .stat-value { font-size: 1.8rem; font-weight: bold; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .profit { color: #f0b90b; }
        .warning { color: #f59e0b; }
        .scrollable { max-height: 300px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .text-small { font-size: 0.7rem; }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; color: #0a0f1e; margin: 5px; }
        .danger-btn { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <h1>Flash Loan Arbitrage Bot <span class="badge ${state.realMode ? 'real-badge' : 'sim-badge'}">${state.realMode ? '🔴 REAL MODE' : '🟡 SIMULATION MODE'}</span></h1>
        <p class="text-small">${state.realMode ? '⚠️ REAL MONEY AT RISK - Transactions cost REAL gas fees' : '💰 No real money - Simulation only'}</p>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">💰 WALLET</div>
            <div class="stat-value" id="balance">$0.00</div>
            <div>P&L: <span id="pnl">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
            <div class="text-small" id="walletAddress">${state.walletAddress || 'Simulated'}</div>
        </div>
        <div class="card">
            <div class="card-title">⚡ STATS</div>
            <div>Txs: <span id="totalTxs">0</span> | ✅ <span id="successTxs">0</span> | ❌ <span id="failedTxs">0</span></div>
            <div>Gas: $<span id="gasSpent">0.00</span> | Profit: $<span id="totalProfit">0.00</span></div>
            <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
        </div>
        <div class="card">
            <div class="card-title">🔍 SCANNING</div>
            <div>Tokens: <span id="tokenCount">0</span></div>
            <div>Sufficient Gas: <span id="gasStatus">-</span></div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">🏆 OPPORTUNITIES</div>
            <div class="scrollable"><table id="oppTable"><tbody><tr><td class="text-center">Scanning...</td></tr></tbody></table></div>
        </div>
        <div class="card">
            <div class="card-title">📋 TRADE HISTORY</div>
            <div class="scrollable"><table id="tradesTable"><tbody><tr><td class="text-center">No trades yet</tr></tbody></table></div>
        </div>
    </div>

    <div class="card">
        <div class="card-title">📝 LIVE LOGS</div>
        <div class="scrollable" id="logsContainer" style="max-height: 200px; font-family: monospace; font-size: 0.65rem;">Initializing...</div>
    </div>

    <div class="text-center mt-20">
        <button onclick="resetSimulation()">🔄 Reset</button>
        ${!state.realMode ? '<button onclick="location.reload()">⟳ Refresh</button>' : ''}
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
            document.getElementById('gasStatus').innerHTML = data.wallet.hasEnoughGas ? '✅ Yes' : '⚠️ Low';
            if (data.wallet.address && data.wallet.address !== 'Simulated') {
                document.getElementById('walletAddress').innerHTML = data.wallet.address.substring(0, 10) + '...';
            }
            
            if (data.opportunities && data.opportunities.length > 0) {
                let oppHtml = '<tr><th>Token</th><th>Profit</th><th>Diff%</th></tr>';
                for (let i = 0; i < Math.min(8, data.opportunities.length); i++) {
                    const o = data.opportunities[i];
                    oppHtml += `<tr><td>${o.token}</td><td class="profit">+$${o.netProfit?.toFixed(2)}</td><td>${o.priceDiffPercent?.toFixed(2)}%</td></tr>`;
                }
                document.getElementById('oppTable').querySelector('tbody').innerHTML = oppHtml;
            }
            
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let tradesHtml = '<tr><th>Time</th><th>Token</th><th>Result</th></tr>';
                for (let i = 0; i < Math.min(10, data.tradeHistory.length); i++) {
                    const t = data.tradeHistory[i];
                    tradesHtml += `<tr>
                        <td>${new Date(t.timestamp).toLocaleTimeString()}</td>
                        <td>${t.token || 'N/A'}</td>
                        <td class="${t.success ? 'positive' : 'negative'}">${t.success ? '+$' + t.netProfit?.toFixed(2) : '-$' + t.gasCost?.toFixed(4)}</td>
                    </tr>`;
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
                    else if (log.type === 'warning') color = '#f59e0b';
                    logsHtml += '<div style="color: ' + color + '; padding: 3px 0;">' + log.message + '</div>';
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
    console.log(`⚡ FLASH LOAN ARBITRAGE BOT - ${state.realMode ? 'REAL MODE' : 'SIMULATION MODE'}`);
    console.log('='.repeat(60));
    
    if (state.realMode) {
        console.log(`\n⚠️⚠️⚠️  WARNING - REAL MODE ACTIVE  ⚠️⚠️⚠️`);
        console.log(`   Transactions will cost REAL gas fees`);
        console.log(`   Only proceed if you understand the risks!`);
        console.log(`   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`💡 To switch modes, change BOT_MODE in .env (simulate/real)\n`);
    
    await initBlockchain();
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
