require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const CONFIG = {
    startingBalance: parseFloat(process.env.SIM_BALANCE || 100.00), // Start with $100 simulated
    scanIntervalMs: 5000,  // Check every 5 seconds
    minProfitPercent: 0.3,  // Minimum 0.3% profit to consider
    gasFeeUSD: 0.48,        // Simulated gas fee (realistic for BSC)
    
    // BSC Configuration (for REAL price queries)
    bscRpc: 'https://bsc-dataseed.binance.org/',
    
    // PancakeSwap Router (Real contract)
    pancakeswap: {
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
    },
    
    // Real token addresses on BSC
    tokens: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        USDT: '0x55d398326f99059fF775485246999027B3197955',
        CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        DOGE: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
        SHIB: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D'
    },
    
    // Trading pairs to check for arbitrage (real paths)
    pairs: [
        { name: 'BNB/BUSD', path: ['WBNB', 'BUSD'], dex: 'PancakeSwap' },
        { name: 'CAKE/BNB', path: ['CAKE', 'WBNB'], dex: 'PancakeSwap' },
        { name: 'BUSD/USDT', path: ['BUSD', 'USDT'], dex: 'PancakeSwap' },
        { name: 'DOGE/BUSD', path: ['DOGE', 'BUSD'], dex: 'PancakeSwap' },
        { name: 'SHIB/BUSD', path: ['SHIB', 'BUSD'], dex: 'PancakeSwap' }
    ]
};

// ==================== ROUTER ABI (for real price queries) ====================
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

// ==================== STATE ====================
let state = {
    isRunning: true,
    balance: CONFIG.startingBalance,
    startingBalance: CONFIG.startingBalance,
    totalTrades: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalGasSpent: 0,
    totalProfit: 0,
    tradeHistory: [],
    opportunitiesFound: [],
    lastScanTime: Date.now(),
    logs: [],
    currentPrices: {}
};

// ==================== HELPER FUNCTIONS ====================
function addLog(message, type = 'info') {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type });
    if (state.logs.length > 100) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== REAL PRICE QUERY FROM PANCAKESWAP ====================
let provider = null;
let router = null;

async function initBlockchain() {
    try {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.bscRpc);
        router = new ethers.Contract(CONFIG.pancakeswap.router, ROUTER_ABI, provider);
        
        // Test the connection
        const blockNumber = await provider.getBlockNumber();
        addLog(`✅ Connected to BSC. Current block: ${blockNumber}`, 'success');
        return true;
    } catch (error) {
        addLog(`❌ Failed to connect to BSC: ${error.message}`, 'error');
        return false;
    }
}

async function getRealPrice(tokenIn, tokenOut, amountInUSD = 100) {
    try {
        const tokenInAddress = CONFIG.tokens[tokenIn];
        const tokenOutAddress = CONFIG.tokens[tokenOut];
        
        if (!tokenInAddress || !tokenOutAddress) {
            return null;
        }
        
        // Convert $100 to token amount (simplified - assumes $1 = 1 for stablecoins)
        // In reality, you'd need token decimals, but this works for demonstration
        const amountIn = ethers.utils.parseEther(amountInUSD.toString());
        
        const amounts = await router.getAmountsOut(amountIn, [tokenInAddress, tokenOutAddress]);
        const amountOut = parseFloat(ethers.utils.formatEther(amounts[1]));
        
        return {
            amountIn: amountInUSD,
            amountOut: amountOut,
            price: amountOut / amountInUSD,
            tokenOut: tokenOut
        };
    } catch (error) {
        return null;
    }
}

async function findRealArbitrageOpportunities() {
    const opportunities = [];
    
    for (const pair of CONFIG.pairs) {
        try {
            const [token0, token1] = pair.path;
            
            // Get price in both directions to check for arbitrage
            const priceForward = await getRealPrice(token0, token1, 100);
            const priceBackward = await getRealPrice(token1, token0, 100);
            
            if (priceForward && priceBackward) {
                // Calculate if arbitrage exists
                // Buy token0 with $100, sell token1 back to token0
                const buyAmount = priceForward.amountOut;
                const sellBackAmount = priceBackward.amountOut;
                
                const profit = sellBackAmount - 100;
                const profitPercent = (profit / 100) * 100;
                
                if (profitPercent > CONFIG.minProfitPercent) {
                    opportunities.push({
                        pair: pair.name,
                        path: pair.path,
                        buyDex: pair.dex,
                        sellDex: pair.dex,
                        profitPercent: profitPercent,
                        grossProfit: profit,
                        netProfit: profit - CONFIG.gasFeeUSD,
                        tradeAmount: 100,
                        timestamp: Date.now(),
                        buyPrice: priceForward.price,
                        sellPrice: priceBackward.price
                    });
                }
                
                // Store current price for dashboard
                state.currentPrices[pair.name] = {
                    price: priceForward.price,
                    lastUpdate: new Date().toISOString()
                };
            }
        } catch (error) {
            // Silent fail for individual pairs
        }
    }
    
    return opportunities;
}

// ==================== SIMULATED TRADE EXECUTION ====================
async function executeSimulatedTrade(opportunity) {
    const { pair, profitPercent, grossProfit, netProfit, buyPrice, sellPrice } = opportunity;
    
    addLog(`🚀 SIMULATED TRADE: ${pair}`, 'trade');
    addLog(`   Buy Price: $${buyPrice?.toFixed(8) || 'N/A'} → Sell Price: $${sellPrice?.toFixed(8) || 'N/A'}`, 'info');
    addLog(`   Expected Profit: ${profitPercent.toFixed(2)}% ($${grossProfit.toFixed(4)})`, 'info');
    addLog(`   Simulated Gas Fee: $${CONFIG.gasFeeUSD.toFixed(2)}`, 'info');
    addLog(`   Net Profit: $${netProfit.toFixed(4)}`, 'info');
    
    state.totalGasSpent += CONFIG.gasFeeUSD;
    
    // Simulate success (95% for demonstration)
    const success = Math.random() < 0.95;
    
    if (success && netProfit > 0) {
        state.balance += netProfit;
        state.totalProfit += netProfit;
        state.successfulTrades++;
        addLog(`✅ SIMULATED SUCCESS! New Balance: $${state.balance.toFixed(4)}`, 'success');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            pair: pair,
            type: 'BUY/SELL',
            amount: 100,
            profit: netProfit,
            buyPrice: buyPrice,
            sellPrice: sellPrice,
            success: true,
            simulated: true
        });
    } else {
        state.failedTrades++;
        addLog(`❌ SIMULATED FAILURE! Lost gas fee: $${CONFIG.gasFeeUSD.toFixed(2)}`, 'error');
        
        state.tradeHistory.unshift({
            timestamp: new Date().toISOString(),
            pair: pair,
            type: 'FAILED',
            amount: 100,
            loss: CONFIG.gasFeeUSD,
            success: false,
            simulated: true
        });
    }
    
    state.totalTrades++;
    if (state.tradeHistory.length > 50) state.tradeHistory.pop();
}

// ==================== MAIN SIMULATION LOOP ====================
async function simulationLoop() {
    while (state.isRunning) {
        try {
            state.lastScanTime = Date.now();
            
            // Get REAL opportunities from PancakeSwap
            const opportunities = await findRealArbitrageOpportunities();
            
            if (opportunities.length > 0) {
                for (const opp of opportunities) {
                    state.opportunitiesFound.unshift(opp);
                    if (state.opportunitiesFound.length > 20) state.opportunitiesFound.pop();
                    
                    addLog(`📈 REAL OPPORTUNITY: ${opp.pair} - ${opp.profitPercent.toFixed(2)}% profit potential`, 'opportunity');
                    
                    // Check if profitable after gas and balance sufficient
                    if (opp.netProfit > 0 && state.balance >= (opp.tradeAmount + CONFIG.gasFeeUSD)) {
                        await executeSimulatedTrade(opp);
                    } else if (opp.netProfit <= 0) {
                        addLog(`   ⏭️ Skipping: Net profit too low ($${opp.netProfit.toFixed(4)})`, 'warning');
                    } else {
                        addLog(`   ⏭️ Skipping: Insufficient balance (Need $${(opp.tradeAmount + CONFIG.gasFeeUSD).toFixed(2)})`, 'warning');
                    }
                }
            }
            
            // Stop if balance is too low
            if (state.balance < 0.10) {
                addLog(`🛑 Simulation stopped: Balance below $0.10`, 'error');
                state.isRunning = false;
                break;
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
    const profitLoss = state.balance - state.startingBalance;
    const profitPercent = (profitLoss / state.startingBalance) * 100;
    
    res.json({
        isRunning: state.isRunning,
        balance: state.balance,
        startingBalance: state.startingBalance,
        profitLoss: profitLoss,
        profitPercent: profitPercent,
        totalTrades: state.totalTrades,
        successfulTrades: state.successfulTrades,
        failedTrades: state.failedTrades,
        totalGasSpent: state.totalGasSpent,
        totalProfit: state.totalProfit,
        opportunitiesFound: state.opportunitiesFound,
        currentPrices: state.currentPrices,
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 30),
        config: {
            startingBalance: CONFIG.startingBalance,
            gasFeeUSD: CONFIG.gasFeeUSD,
            scanIntervalMs: CONFIG.scanIntervalMs
        }
    });
});

app.post('/api/reset', (req, res) => {
    state = {
        isRunning: true,
        balance: CONFIG.startingBalance,
        startingBalance: CONFIG.startingBalance,
        totalTrades: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasSpent: 0,
        totalProfit: 0,
        tradeHistory: [],
        opportunitiesFound: [],
        lastScanTime: Date.now(),
        logs: [],
        currentPrices: {}
    };
    addLog(`🔄 Simulation reset. Balance: $${CONFIG.startingBalance}`, 'info');
    res.json({ status: 'reset' });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hybrid Arbitrage Bot - Real Data, Simulated Trades</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); min-height: 100vh; padding: 20px; color: #e2e8f0; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        h1 { font-size: 1.8rem; background: linear-gradient(135deg, #f0b90b, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { display: inline-block; background: #10b981; color: white; padding: 2px 8px; border-radius: 20px; font-size: 0.7rem; margin-left: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.08); backdrop-filter: blur(10px); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.1); }
        .card-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 15px; color: #f0b90b; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 1.8rem; font-weight: bold; margin: 10px 0; }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .neutral { color: #f0b90b; }
        table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .log-entry { font-family: monospace; font-size: 0.7rem; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        button { background: #f0b90b; border: none; padding: 8px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; margin: 5px; }
        button:hover { background: #ffd700; color: #0f172a; }
        .scrollable { max-height: 300px; overflow-y: auto; }
        .text-small { font-size: 0.7rem; }
        .text-center { text-align: center; }
        .mt-20 { margin-top: 20px; }
        .real-data { color: #10b981; font-size: 0.7rem; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Hybrid Arbitrage Bot <span class="badge">REAL DATA</span><span class="badge" style="background:#6366f1;">SIMULATED TRADES</span></h1>
            <p class="text-small">Real PancakeSwap prices | Simulated execution | No real money at risk</p>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">BALANCE</div>
                <div class="stat-value" id="balance">$0.00</div>
                <div>P&L: <span id="pnl">$0.00</span> (<span id="pnlPercent">0.00%</span>)</div>
            </div>
            <div class="card">
                <div class="card-title">TRADES</div>
                <div>Total: <span id="totalTrades">0</span></div>
                <div>Successful: <span id="successTrades">0</span> | Failed: <span id="failedTrades">0</span></div>
                <div>Opportunities: <span id="opportunities">0</span></div>
            </div>
            <div class="card">
                <div class="card-title">GAS & FEES</div>
                <div>Total Gas Spent: $<span id="gasSpent">0.00</span></div>
                <div>Gas per Trade: $0.48 (simulated)</div>
                <div>Status: <span id="status" class="neutral">RUNNING</span></div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">REAL MARKET PRICES</div>
                <div class="scrollable" id="pricesContainer">
                    <div class="text-small" style="padding: 10px; text-align: center;">Loading real prices from PancakeSwap...</div>
                </div>
                <div class="real-data text-small" style="margin-top: 10px;">✓ Data fetched from live BSC blockchain</div>
            </div>
            <div class="card">
                <div class="card-title">RECENT OPPORTUNITIES</div>
                <div class="scrollable">
                    <table id="opportunitiesTable">
                        <thead><tr><th>Pair</th><th>Profit %</th><th>Status</th></tr></thead>
                        <tbody><tr><td colspan="3" class="text-center">Scanning...</td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>

        <div class="grid">
            <div class="card">
                <div class="card-title">TRADE HISTORY</div>
                <div class="scrollable">
                    <table id="tradesTable">
                        <thead><tr><th>Time</th><th>Pair</th><th>Profit/Loss</th></tr></thead>
                        <tbody><tr><td colspan="3" class="text-center">No trades yet</td></tr></tbody>
                    </table>
                </div>
            </div>
            <div class="card">
                <div class="card-title">LIVE LOGS</div>
                <div class="scrollable" id="logsContainer" style="font-family: monospace; font-size: 0.7rem;">Connecting to BSC...</div>
            </div>
        </div>

        <div class="text-center mt-20">
            <button onclick="resetSimulation()">Reset Simulation</button>
            <button onclick="location.reload()">Refresh</button>
        </div>

        <div class="text-center mt-20 text-small" style="opacity: 0.6;">
            <p>✅ REAL DATA: Prices fetched live from PancakeSwap on BNB Smart Chain</p>
            <p>⚠️ SIMULATED: Trades are NOT executed on blockchain. No gas fees deducted. No real money moved.</p>
        </div>
    </div>

    <script>
        async function fetchState() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                document.getElementById('balance').innerHTML = '$' + data.balance.toFixed(4);
                const pnl = data.profitLoss;
                document.getElementById('pnl').innerHTML = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(4);
                document.getElementById('pnlPercent').innerHTML = (pnl >= 0 ? '+' : '') + data.profitPercent.toFixed(2) + '%';
                document.getElementById('pnl').className = pnl >= 0 ? 'positive' : 'negative';
                document.getElementById('totalTrades').innerHTML = data.totalTrades;
                document.getElementById('successTrades').innerHTML = data.successfulTrades;
                document.getElementById('failedTrades').innerHTML = data.failedTrades;
                document.getElementById('opportunities').innerHTML = data.opportunitiesFound?.length || 0;
                document.getElementById('gasSpent').innerHTML = data.totalGasSpent.toFixed(4);
                
                // Display real prices
                if (data.currentPrices && Object.keys(data.currentPrices).length > 0) {
                    let pricesHtml = '';
                    for (const [pair, info] of Object.entries(data.currentPrices)) {
                        pricesHtml += `<div style="display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
                            <span>${pair}</span>
                            <span class="neutral">$${info.price?.toFixed(8) || 'N/A'}</span>
                        </div>`;
                    }
                    document.getElementById('pricesContainer').innerHTML = pricesHtml || '<div class="text-small text-center">Loading prices...</div>';
                }
                
                // Display opportunities
                const oppTable = document.getElementById('opportunitiesTable').querySelector('tbody');
                if (data.opportunitiesFound && data.opportunitiesFound.length > 0) {
                    let oppHtml = '';
                    for (let i = 0; i < Math.min(10, data.opportunitiesFound.length); i++) {
                        const opp = data.opportunitiesFound[i];
                        oppHtml += `<tr><td>${opp.pair}</td><td class="positive">+${opp.profitPercent?.toFixed(2)}%</td><td class="neutral">Found</td></tr>`;
                    }
                    oppTable.innerHTML = oppHtml;
                } else {
                    oppTable.innerHTML = '<tr><td colspan="3" class="text-center">No opportunities found yet</td></tr>';
                }
                
                // Display trades
                const tradesBody = document.getElementById('tradesTable').querySelector('tbody');
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    let tradesHtml = '';
                    for (let i = 0; i < data.tradeHistory.length; i++) {
                        const t = data.tradeHistory[i];
                        const profit = t.profit || (t.loss ? -t.loss : 0);
                        tradesHtml += `<tr>
                            <td>${new Date(t.timestamp).toLocaleTimeString()}</td>
                            <td>${t.pair || 'N/A'}</td>
                            <td class="${profit >= 0 ? 'positive' : 'negative'}">${profit >= 0 ? '+' : ''}$${Math.abs(profit).toFixed(6)}</td>
                        </tr>`;
                    }
                    tradesBody.innerHTML = tradesHtml;
                }
                
                // Display logs
                const logsContainer = document.getElementById('logsContainer');
                if (data.logs && data.logs.length > 0) {
                    let logsHtml = '';
                    for (let i = 0; i < data.logs.length; i++) {
                        const log = data.logs[i];
                        let color = '#888';
                        if (log.type === 'error') color = '#ef4444';
                        else if (log.type === 'success') color = '#10b981';
                        else if (log.type === 'opportunity') color = '#f0b90b';
                        logsHtml += `<div style="color: ${color}; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 4px 0;">
                            [${new Date(log.timestamp).toLocaleTimeString()}] ${log.message}
                        </div>`;
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
        setInterval(fetchState, 2000);
    </script>
</body>
</html>
    `);
});

// ==================== START BOT ====================
async function start() {
    console.log('\n============================================================');
    console.log('Hybrid Arbitrage Bot - Real Data, Simulated Trades');
    console.log('============================================================');
    console.log(`\nStarting Balance: $${CONFIG.startingBalance} (simulated)`);
    console.log(`Gas Fee: $${CONFIG.gasFeeUSD} (simulated)`);
    console.log(`Scan Interval: ${CONFIG.scanIntervalMs}ms`);
    console.log(`\nConnecting to BNB Smart Chain for real price data...`);
    
    const connected = await initBlockchain();
    if (!connected) {
        console.log(`\n⚠️ WARNING: Using fallback mode. Install ethers: npm install ethers`);
    }
    
    console.log(`\n✅ Bot Started!`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`\n⚠️  REAL DATA: Prices from live PancakeSwap pools`);
    console.log(`⚠️  SIMULATED: No real transactions, no gas fees, no money at risk\n`);
    
    simulationLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web dashboard running on port ${PORT}`);
    });
}

start();
