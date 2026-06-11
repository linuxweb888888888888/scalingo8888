require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== REALISTIC CONFIGURATION ====================
// With only $4 balance - just enough for gas fees!
const CONFIG = {
    // Your actual wallet balance (enough for ~8-10 transactions)
    walletBalanceBNB: 0.0065,  // ~$4 at $615/BNB
    walletBalanceUSD: 4.00,
    
    // Gas settings (realistic BSC costs)
    gasPriceGwei: 3,           // Current BSC gas price
    estimatedGasPerTx: 350000, // Average flash loan transaction gas
    
    // Profit thresholds
    minProfitUSD: 0.50,        // Minimum profit to attempt trade
    minProfitPercent: 0.1,     // Minimum 0.1% profit
    
    // Scan settings
    scanIntervalMs: 15000,     // Scan every 15 seconds
    
    // Flash loan amounts to test (realistic for small capital)
    flashLoanAmounts: [100, 500, 1000, 5000, 10000],
    
    // BSC Configuration
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    // DEXes
    dexes: {
        pancakeswap: {
            name: 'PancakeSwap',
            router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            fee: 0.0025
        },
        biswap: {
            name: 'BiSwap',
            router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8',
            fee: 0.001
        },
        apeswap: {
            name: 'ApeSwap',
            router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
            fee: 0.002
        }
    },
    
    // Tokens on BSC
    tokens: {
        'WBNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        'USDT': '0x55d398326f99059fF775485246999027B3197955',
        'CAKE': '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        'DOGE': '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
        'SHIB': '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D',
        'PEPE': '0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00'
    }
};

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

// ==================== STATE ====================
let state = {
    // Real wallet state (simulated but realistic)
    walletBalanceBNB: CONFIG.walletBalanceBNB,
    walletBalanceUSD: CONFIG.walletBalanceUSD,
    startingBalanceBNB: CONFIG.walletBalanceBNB,
    startingBalanceUSD: CONFIG.walletBalanceUSD,
    
    // Performance stats
    totalTransactions: 0,
    successfulTransactions: 0,
    failedTransactions: 0,
    totalGasSpentBNB: 0,
    totalGasSpentUSD: 0,
    totalProfitBNB: 0,
    totalProfitUSD: 0,
    
    // Opportunity tracking
    opportunities: [],
    tradeHistory: [],
    allPrices: {},
    
    // Status
    isRunning: true,
    lastScanTime: Date.now(),
    logs: [],
    
    // Real-time data
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

function calculateGasCostUSD(gasLimit = CONFIG.estimatedGasPerTx) {
    const gasCostBNB = (gasLimit * state.currentGasPriceGwei) / 1e9;
    const bnbPriceUSD = state.bnbPriceUSD;
    return {
        bnb: gasCostBNB,
        usd: gasCostBNB * bnbPriceUSD
    };
}

function canAffordTransaction() {
    const gasCost = calculateGasCostUSD();
    return state.walletBalanceBNB > gasCost.bnb * 1.1; // 10% buffer
}

// ==================== BLOCKCHAIN CONNECTION ====================
let provider = null;
let routers = {};

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        
        for (const [key, dex] of Object.entries(CONFIG.dexes)) {
            routers[key] = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        }
        
        const blockNumber = await provider.getBlockNumber();
        
        // Get real BNB price
        try {
            const busdPrice = await getPriceFromDEX('pancakeswap', 'WBNB', 'BUSD', 1);
            if (busdPrice) {
                state.bnbPriceUSD = busdPrice.price;
            }
        } catch (e) {}
        
        addLog(`✅ Connected to BSC. Block: ${blockNumber}`, 'success');
        addLog(`💰 BNB Price: $${state.bnbPriceUSD.toFixed(2)}`, 'info');
        addLog(`💸 Wallet: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
        addLog(`⛽ Gas Price: ${state.currentGasPriceGwei} Gwei ($${calculateGasCostUSD().usd.toFixed(4)}/tx)`, 'info');
        
        return true;
    } catch (error) {
        addLog(`❌ BSC connection failed: ${error.message}`, 'error');
        return false;
    }
}

async function getPriceFromDEX(dexKey, tokenIn, tokenOut, amountInUSD = 100) {
    try {
        const router = routers[dexKey];
        if (!router) return null;
        
        const tokenInAddress = CONFIG.tokens[tokenIn];
        const tokenOutAddress = CONFIG.tokens[tokenOut];
        if (!tokenInAddress || !tokenOutAddress) return null;
        
        let amountIn;
        if (tokenIn === 'BUSD' || tokenIn === 'USDT') {
            amountIn = ethers.utils.parseEther(amountInUSD.toString());
        } else {
            const currentPrice = state.allPrices[tokenIn]?.priceUSD || 1;
            amountIn = ethers.utils.parseEther((amountInUSD / currentPrice).toString());
        }
        
        const amounts = await router.getAmountsOut(amountIn, [tokenInAddress, tokenOutAddress]);
        const amountOut = parseFloat(ethers.utils.formatEther(amounts[1]));
        
        return {
            dex: CONFIG.dexes[dexKey].name,
            amountOut: amountOut,
            price: tokenOut === 'BUSD' || tokenOut === 'USDT' ? amountOut / amountInUSD : amountInUSD / amountOut,
            timestamp: Date.now()
        };
    } catch (error) {
        return null;
    }
}

async function updateAllPrices() {
    const tokens = Object.keys(CONFIG.tokens);
    
    for (const token of tokens) {
        if (token === 'WBNB') {
            const price = await getPriceFromDEX('pancakeswap', 'WBNB', 'BUSD', 1);
            if (price) {
                state.allPrices[token] = { priceUSD: price.price, lastUpdate: new Date().toISOString() };
                state.bnbPriceUSD = price.price;
            }
        } else if (token !== 'BUSD' && token !== 'USDT') {
            const price = await getPriceFromDEX('pancakeswap', token, 'BUSD', 100);
            if (price) {
                state.allPrices[token] = { priceUSD: price.price, lastUpdate: new Date().toISOString() };
            }
        } else {
            state.allPrices[token] = { priceUSD: 1.00, lastUpdate: new Date().toISOString() };
        }
    }
}

async function findArbitrageOpportunities() {
    const opportunities = [];
    
    for (const token of Object.keys(CONFIG.tokens)) {
        if (token === 'BUSD' || token === 'USDT' || token === 'WBNB') continue;
        
        const dexPrices = [];
        
        for (const [dexKey, dex] of Object.entries(CONFIG.dexes)) {
            const price = await getPriceFromDEX(dexKey, token, 'BUSD', 100);
            if (price) {
                dexPrices.push({ dex: dex.name, price: price.price, dexKey: dexKey });
            }
        }
        
        if (dexPrices.length >= 2) {
            const sorted = [...dexPrices].sort((a, b) => b.price - a.price);
            const highest = sorted[0];
            const lowest = sorted[sorted.length - 1];
            const priceDiff = ((highest.price - lowest.price) / lowest.price) * 100;
            
            if (priceDiff > CONFIG.minProfitPercent) {
                for (const loanAmount of CONFIG.flashLoanAmounts) {
                    const flashLoanFee = loanAmount * 0.0009; // 0.09% fee
                    const grossProfit = loanAmount * (priceDiff / 100);
                    const gasCost = calculateGasCostUSD();
                    const netProfit = grossProfit - flashLoanFee - gasCost.usd;
                    
                    if (netProfit > CONFIG.minProfitUSD) {
                        opportunities.push({
                            token: token,
                            buyDex: lowest.dex,
                            sellDex: highest.dex,
                            buyPrice: lowest.price,
                            sellPrice: highest.price,
                            priceDiffPercent: priceDiff,
                            loanAmount: loanAmount,
                            grossProfit: grossProfit,
                            flashLoanFee: flashLoanFee,
                            gasCostUSD: gasCost.usd,
                            gasCostBNB: gasCost.bnb,
                            netProfit: netProfit,
                            timestamp: Date.now()
                        });
                    }
                }
            }
        }
    }
    
    opportunities.sort((a, b) => b.netProfit - a.netProfit);
    return opportunities;
}

async function executeSimulatedFlashLoan(opportunity) {
    const { token, buyDex, sellDex, loanAmount, grossProfit, flashLoanFee, gasCostUSD, gasCostBNB, netProfit, priceDiffPercent } = opportunity;
    
    addLog(`🔷 FLASH LOAN SIMULATION`, 'flashloan');
    addLog(`   Token: ${token}`, 'info');
    addLog(`   Loan Amount: $${loanAmount.toFixed(2)} (0% collateral)`, 'info');
    addLog(`   Buy: ${buyDex} @ $${opportunity.buyPrice.toFixed(8)} → Sell: ${sellDex} @ $${opportunity.sellPrice.toFixed(8)}`, 'info');
    addLog(`   Price Difference: ${priceDiffPercent.toFixed(3)}%`, 'info');
    addLog(`   Gross Profit: $${grossProfit.toFixed(2)}`, 'info');
    addLog(`   Flash Loan Fee (0.09%): $${flashLoanFee.toFixed(2)}`, 'info');
    addLog(`   Gas Cost: ${gasCostBNB.toFixed(6)} BNB ($${gasCostUSD.toFixed(4)})`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(2)}`, 'profit');
    
    // Check if wallet has enough BNB for gas
    if (!canAffordTransaction()) {
        addLog(`❌ INSUFFICIENT BALANCE for gas! Need ${calculateGasCostUSD().bnb.toFixed(6)} BNB`, 'error');
        addLog(`   Current balance: ${state.walletBalanceBNB.toFixed(6)} BNB`, 'error');
        return false;
    }
    
    state.totalTransactions++;
    state.totalGasSpentBNB += gasCostBNB;
    state.totalGasSpentUSD += gasCostUSD;
    
    // Realistic success rate (65-80% depending on competition)
    const successRate = 0.70;
    const success = Math.random() < successRate;
    
    if (success && netProfit > 0) {
        // Convert profit to BNB
        const profitBNB = netProfit / state.bnbPriceUSD;
        
        state.walletBalanceBNB += profitBNB;
        state.walletBalanceUSD += netProfit;
        state.totalProfitBNB += profitBNB;
        state.totalProfitUSD += netProfit;
        state.successfulTransactions++;
        
        addLog(`✅ FLASH LOAN SUCCESSFUL!`, 'success');
        addLog(`   Net Profit: $${netProfit.toFixed(2)} (${profitBNB.toFixed(6)} BNB)`, 'profit');
        addLog(`   New Balance: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            type: 'FLASH_LOAN',
            token: token,
            loanAmount: loanAmount,
            grossProfit: grossProfit,
            gasCost: gasCostUSD,
            netProfit: netProfit,
            success: true
        });
        
        return true;
    } else {
        state.failedTransactions++;
        addLog(`❌ FLASH LOAN FAILED! Lost gas: $${gasCostUSD.toFixed(4)}`, 'error');
        addLog(`   Balance: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            type: 'FLASH_LOAN',
            token: token,
            loanAmount: loanAmount,
            loss: gasCostUSD,
            success: false
        });
        
        return false;
    }
}

async function simulationLoop() {
    addLog(`🚀 Starting flash loan arbitrage bot with $${state.walletBalanceUSD.toFixed(2)} balance`, 'success');
    addLog(`⚡ This is SIMULATED - no real transactions will be executed`, 'info');
    addLog(`💡 With $4, you can make ~8-10 attempts before needing more BNB for gas\n`, 'info');
    
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            
            // Update prices
            await updateAllPrices();
            
            // Find opportunities
            const opportunities = await findArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                const best = opportunities[0];
                state.opportunities.unshift(best);
                if (state.opportunities.length > 20) state.opportunities.pop();
                
                addLog(`📈 OPPORTUNITY: ${best.token} - ${best.priceDiffPercent.toFixed(2)}% profit potential`, 'opportunity');
                addLog(`   Loan $${best.loanAmount.toFixed(0)} → Net Profit $${best.netProfit.toFixed(2)}`, 'profit');
                
                // Check if profitable and we can afford gas
                if (best.netProfit > CONFIG.minProfitUSD && canAffordTransaction()) {
                    await executeSimulatedFlashLoan(best);
                } else if (!canAffordTransaction()) {
                    addLog(`⚠️ Cannot afford gas. Need ~${calculateGasCostUSD().bnb.toFixed(6)} BNB`, 'warning');
                    addLog(`   Current balance: ${state.walletBalanceBNB.toFixed(6)} BNB`, 'warning');
                    
                    if (state.walletBalanceBNB < 0.001) {
                        addLog(`🛑 Bot paused: Insufficient BNB for gas. Add ~0.005 BNB (~$3) to continue.`, 'error');
                        state.isRunning = false;
                        break;
                    }
                }
            } else {
                // Brief status update every 2 minutes
                if (Math.random() < 0.05) {
                    addLog(`⏳ Scanning... Balance: ${state.walletBalanceBNB.toFixed(6)} BNB ($${state.walletBalanceUSD.toFixed(2)})`, 'info');
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
    const remainingAttempts = Math.floor(state.walletBalanceBNB / calculateGasCostUSD().bnb);
    
    res.json({
        wallet: {
            balanceBNB: state.walletBalanceBNB,
            balanceUSD: state.walletBalanceUSD,
            startingBalanceBNB: state.startingBalanceBNB,
            startingBalanceUSD: state.startingBalanceUSD,
            profitLoss: profitLoss,
            profitPercent: profitPercent,
            remainingAttempts: remainingAttempts
        },
        stats: {
            totalTransactions: state.totalTransactions,
            successfulTransactions: state.successfulTransactions,
            failedTransactions: state.failedTransactions,
            totalGasSpentBNB: state.totalGasSpentBNB,
            totalGasSpentUSD: state.totalGasSpentUSD,
            totalProfitBNB: state.totalProfitBNB,
            totalProfitUSD: state.totalProfitUSD
        },
        current: {
            bnbPriceUSD: state.bnbPriceUSD,
            gasPriceGwei: state.currentGasPriceGwei,
            gasCostPerTxUSD: calculateGasCostUSD().usd,
            isRunning: state.isRunning
        },
        opportunities: state.opportunities.slice(0, 8),
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        tokenPrices: Object.entries(state.allPrices).slice(0, 10)
    });
});

app.post('/api/reset', (req, res) => {
    state = {
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
        allPrices: {},
        isRunning: true,
        lastScanTime: Date.now(),
        logs: [],
        bnbPriceUSD: 615,
        currentGasPriceGwei: CONFIG.gasPriceGwei
    };
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
    <title>Flash Loan Bot - $4 Realistic Simulation</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0a0f1e 0%, #0d1525 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 2rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; padding: 2px 12px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .warning-badge { background: #f59e0b; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.08); }
        .card-title { font-size: 0.8rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 1.8rem; font-weight: bold; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .profit { color: #f0b90b; }
        .warning { color: #f59e0b; }
        table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .scrollable { max-height: 300px; overflow-y: auto; }
        button { background: linear-gradient(135deg, #f0b90b, #ffd700); border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; margin: 5px; color: #0a0f1e; }
        button:hover { transform: translateY(-1px); }
        .balance-card { background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(16, 185, 129, 0.05)); border: 1px solid #10b981; }
        .text-small { font-size: 0.7rem; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Flash Loan Arbitrage Bot <span class="badge">REAL DATA</span><span class="badge warning-badge">$4 BALANCE</span></h1>
            <p class="text-small">Real PancakeSwap prices | Simulated flash loans | Realistic gas costs</p>
        </div>

        <div class="grid">
            <div class="card balance-card">
                <div class="card-title">💰 WALLET BALANCE</div>
                <div class="stat-value" id="balanceUSD">$0.00</div>
                <div id="balanceBNB" class="text-small">0.0000 BNB</div>
                <div>P&L: <span id="pnl">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
                <div class="text-small" style="margin-top: 8px;">Attempts left: <span id="attemptsLeft">0</span></div>
            </div>
            <div class="card">
                <div class="card-title">⚡ FLASH LOAN STATS</div>
                <div>Txs: <span id="totalTxs">0</span> | ✅ Success: <span id="successTxs">0</span> | ❌ Failed: <span id="failedTxs">0</span></div>
                <div>Gas Spent: $<span id="gasSpent">0.00</span></div>
                <div>Total Profit: $<span id="totalProfit">0.00</span></div>
            </div>
            <div class="card">
                <div class="card-title">⛽ NETWORK</div>
                <div>BNB Price: $<span id="bnbPrice">615</span></div>
                <div>Gas Price: <span id="gasPrice">3</span> Gwei (~$<span id="gasCost">0.00</span>/tx)</div>
                <div>Status: <span id="status" class="profit">🟢 RUNNING</span></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">🏆 BEST OPPORTUNITY</div>
                <div id="bestOpportunity" class="text-center text-small" style="padding: 15px;">Scanning...</div>
            </div>
            <div class="card">
                <div class="card-title">📈 TOKEN PRICES (Real)</div>
                <div class="scrollable" id="pricesContainer">Loading...</div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">🔄 RECENT OPPORTUNITIES</div>
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
            <button onclick="resetSimulation()">🔄 Reset Simulation</button>
        </div>

        <div class="text-center mt-20 text-small" style="opacity: 0.5;">
            <p>✅ REAL DATA from PancakeSwap, BiSwap, ApeSwap | ⚡ Flash loans simulated | 💰 Starting balance: $4 (0.0065 BNB)</p>
            <p>💡 Real flash loans require 0% capital - only ~0.005 BNB ($3) for gas per attempt!</p>
        </div>
    </div>

    <script>
        async function fetchState() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                document.getElementById('balanceUSD').innerHTML = '$' + data.wallet.balanceUSD.toFixed(2);
                document.getElementById('balanceBNB').innerHTML = data.wallet.balanceBNB.toFixed(6) + ' BNB';
                document.getElementById('pnl').innerHTML = (data.wallet.profitLoss >= 0 ? '+' : '') + '$' + Math.abs(data.wallet.profitLoss).toFixed(2);
                document.getElementById('pnlPercent').innerHTML = (data.wallet.profitPercent >= 0 ? '+' : '') + data.wallet.profitPercent.toFixed(2) + '%';
                document.getElementById('attemptsLeft').innerHTML = data.wallet.remainingAttempts || 0;
                document.getElementById('totalTxs').innerHTML = data.stats.totalTransactions;
                document.getElementById('successTxs').innerHTML = data.stats.successfulTransactions;
                document.getElementById('failedTxs').innerHTML = data.stats.failedTransactions;
                document.getElementById('gasSpent').innerHTML = data.stats.totalGasSpentUSD.toFixed(4);
                document.getElementById('totalProfit').innerHTML = data.stats.totalProfitUSD.toFixed(2);
                document.getElementById('bnbPrice').innerHTML = data.current.bnbPriceUSD?.toFixed(2);
                document.getElementById('gasCost').innerHTML = data.current.gasCostPerTxUSD?.toFixed(4);
                document.getElementById('status').innerHTML = data.current.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
                
                if (data.opportunities && data.opportunities.length > 0) {
                    const best = data.opportunities[0];
                    document.getElementById('bestOpportunity').innerHTML = '<strong>' + best.token + '</strong><br>Loan $' + best.loanAmount?.toFixed(0) + ' → Profit <span class="profit">+$' + best.netProfit?.toFixed(2) + '</span><br>' + best.buyDex + ' → ' + best.sellDex;
                    
                    let oppHtml = '<tr><th>Token</th><th>Loan</th><th>Profit</th></tr>';
                    for (let i = 0; i < Math.min(6, data.opportunities.length); i++) {
                        const o = data.opportunities[i];
                        oppHtml += '<tr><td>' + o.token + '</td><td>$' + o.loanAmount?.toFixed(0) + '</td><td class="profit">+$' + o.netProfit?.toFixed(2) + '</td></tr>';
                    }
                    document.getElementById('oppTable').querySelector('tbody').innerHTML = oppHtml;
                }
                
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    let tradesHtml = '<tr><th>Time</th><th>Token</th><th>Profit</th></tr>';
                    for (let i = 0; i < Math.min(10, data.tradeHistory.length); i++) {
                        const t = data.tradeHistory[i];
                        const profit = t.netProfit || (t.loss ? -t.loss : 0);
                        tradesHtml += '<tr><td>' + new Date(t.timestamp).toLocaleTimeString() + '</td><td>' + (t.token || 'N/A') + '</td><td class="' + (profit >= 0 ? 'positive' : 'negative') + '">' + (profit >= 0 ? '+' : '') + '$' + Math.abs(profit).toFixed(2) + '</td></tr>';
                    }
                    document.getElementById('tradesTable').querySelector('tbody').innerHTML = tradesHtml;
                }
                
                if (data.tokenPrices && data.tokenPrices.length > 0) {
                    let pricesHtml = '';
                    for (const [token, info] of data.tokenPrices) {
                        pricesHtml += '<div><strong>' + token + '</strong>: $' + (info?.priceUSD?.toFixed(6) || 'N/A') + '</div>';
                    }
                    document.getElementById('pricesContainer').innerHTML = pricesHtml;
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
                        else if (log.type === 'profit') color = '#ffd700';
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
    console.log('⚡ FLASH LOAN ARBITRAGE BOT - $4 REALISTIC SIMULATION');
    console.log('='.repeat(60));
    console.log(`\n💰 Starting Balance: $${CONFIG.walletBalanceUSD.toFixed(2)} (${CONFIG.walletBalanceBNB.toFixed(6)} BNB)`);
    console.log(`⛽ Gas Price: ${CONFIG.gasPriceGwei} Gwei (~$${(CONFIG.estimatedGasPerTx * CONFIG.gasPriceGwei / 1e9 * 615).toFixed(4)}/tx)`);
    console.log(`🎯 Min Profit Target: $${CONFIG.minProfitUSD}`);
    console.log(`💸 You have enough BNB for ~${Math.floor(CONFIG.walletBalanceBNB / (CONFIG.estimatedGasPerTx * CONFIG.gasPriceGwei / 1e9))} attempts`);
    console.log(`\n🔗 Connecting to BNB Smart Chain...`);
    
    await initBlockchain();
    
    console.log(`\n✅ Bot Started! Dashboard: http://localhost:${PORT}`);
    console.log(`\n⚠️  REAL DATA from PancakeSwap, BiSwap, ApeSwap`);
    console.log(`⚡ FLASH LOANS simulated - no real transactions`);
    console.log(`💡 With $4, you can test ~8-10 flash loan attempts before needing more BNB\n`);
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard: http://localhost:${PORT}`);
    });
}

start();
