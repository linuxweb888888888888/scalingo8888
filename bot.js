// bot-flashloan.js - PROFITABLE FLASH LOAN ARBITRAGE BOT
// Realistic strategy: Dry-run logging, data collection, orderbook arbitrage

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487";

// IMPORTANT: SET TO TRUE FOR FIRST 24 HOURS
const DRY_RUN_MODE = true;  // Set to false only after 24 hours of data collection
const LOG_SPREADS_TO_FILE = true;

// Profit thresholds (start conservative)
const MIN_PROFIT_USD = 2.00;      // Start at $2 minimum
const MIN_SPREAD_PERCENT = 0.6;   // 0.6% minimum spread
const FLASH_LOAN_AMOUNT = 500;    // Start small: $500

// Best times to trade (UTC)
const OPTIMAL_HOURS = [2, 3, 4, 5, 6]; // 2-6 AM UTC

// Rate limiting
const RATE_LIMIT = { minIntervalMs: 100, batchDelayMs: 200 };
const CACHE_TTL = 15000;

// Cache
const priceCache = new Map();
let spreadLog = [];
let hourlyStats = {};

// ==================== FOCUS ON LESS COMPETITIVE TOKENS ====================
const TARGET_TOKENS = [
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣", priority: "HIGH" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡", priority: "HIGH" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎", priority: "MEDIUM" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡", priority: "MEDIUM" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦", priority: "MEDIUM" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈", priority: "HIGH" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣", priority: "HIGH" }
];

// ==================== WORKING DEXES ====================
const DEXES = [
    { name: "QUICKSWAP", router: "0xa5E0829cACEd8fFdd4B3C72e4999f68ff6213921", fee: 0.0030, icon: "⚡" },
    { name: "SUSHISWAP", router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", fee: 0.0030, icon: "🍣" },
    { name: "UNISWAP_V3", router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.0030, icon: "🦄" }
];

// ==================== CONTRACT ABI ====================
const CONTRACT_ABI = [
    "function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external",
    "function withdraw(address token, uint256 amount) external",
    "function getBalance(address token) view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE WITH STATS ====================
let state = {
    wallet: { pol: 0, usd: 0 },
    stats: {
        totalSpreadsFound: 0,
        profitableSpreads: 0,
        averageSpread: 0,
        bestSpread: 0,
        totalOpportunities: 0,
        dryRun: DRY_RUN_MODE
    },
    session: { startTime: new Date().toISOString(), totalScans: 0 },
    tradeHistory: [],
    logs: [],
    hourlyData: {}
};

let provider, wallet, flashLoanContract;
let polPriceUSD = 0.50;
let lastCallTime = 0;

function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < RATE_LIMIT.minIntervalMs) {
        return new Promise(r => setTimeout(r, RATE_LIMIT.minIntervalMs - elapsed));
    }
    lastCallTime = Date.now();
    return Promise.resolve();
}

function addLog(message, type) {
    const timestamp = new Date().toISOString();
    state.logs.unshift({ timestamp, message, type: type || 'info' });
    if (state.logs.length > 200) state.logs.pop();
    console.log(`[${timestamp}] ${message}`);
}

// ==================== BLOCKCHAIN CONNECTION ====================
async function initializeBlockchain() {
    try {
        provider = new ethers.JsonRpcProvider(QUICKNODE_URL);
        await rateLimit();
        const blockNumber = await provider.getBlockNumber();
        addLog(`Connected to Polygon (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here' && !DRY_RUN_MODE) {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            flashLoanContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            const balance = await provider.getBalance(wallet.address);
            state.wallet.pol = parseFloat(ethers.formatEther(balance));
            addLog(`Wallet: ${wallet.address.substring(0, 10)}... Balance: ${state.wallet.pol.toFixed(4)} POL`, 'info');
        } else if (DRY_RUN_MODE) {
            addLog(`DRY RUN MODE - Logging spreads only, no transactions`, 'warning');
            addLog(`Will collect data for 24 hours before enabling real trades`, 'info');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== PRICE FETCHING ====================
async function getTokenPriceOnDex(token, dex) {
    const cacheKey = token.address + "_" + dex.name;
    const cached = priceCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        await rateLimit();
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const router = new ethers.Contract(dex.router, ROUTER_ABI, provider);
        const path = [token.address, usdcAddress];
        const amounts = await router.getAmountsOut(ethers.parseUnits("0.1", token.decimals), path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6)) / 0.1;
        
        if (price > 0 && price < 100000) {
            priceCache.set(cacheKey, { price, timestamp: Date.now() });
            return price;
        }
        return 0;
    } catch (error) {
        return 0;
    }
}

// ==================== SCAN WITH DETAILED LOGGING ====================
async function scanAndLogSpreads() {
    const currentHour = new Date().getUTCHours();
    const isOptimalHour = OPTIMAL_HOURS.includes(currentHour);
    const spreads = [];
    
    addLog(`SCAN #${state.session.totalScans + 1} - Hour: ${currentHour} UTC ${isOptimalHour ? '(OPTIMAL TIME)' : ''}`, 'info');
    
    for (const token of TARGET_TOKENS) {
        const prices = [];
        
        for (const dex of DEXES) {
            const price = await getTokenPriceOnDex(token, dex);
            if (price > 0) {
                prices.push({ dex: dex.name, dexIcon: dex.icon, price: price, fee: dex.fee });
            }
            await new Promise(r => setTimeout(r, 50));
        }
        
        if (prices.length >= 2) {
            for (let i = 0; i < prices.length; i++) {
                for (let j = i + 1; j < prices.length; j++) {
                    const buyPrice = Math.min(prices[i].price, prices[j].price);
                    const sellPrice = Math.max(prices[i].price, prices[j].price);
                    const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;
                    const totalFees = (prices[i].fee + prices[j].fee) * 100;
                    const netSpread = spreadPercent - totalFees;
                    const profitOn500 = (sellPrice - buyPrice) * FLASH_LOAN_AMOUNT;
                    const profitAfterFees = profitOn500 * (1 - (prices[i].fee + prices[j].fee));
                    
                    const spreadData = {
                        timestamp: new Date().toISOString(),
                        hour: currentHour,
                        token: token.symbol,
                        priority: token.priority,
                        buyDex: prices[i].price < prices[j].price ? prices[i].dex : prices[j].dex,
                        sellDex: prices[i].price < prices[j].price ? prices[j].dex : prices[i].dex,
                        buyPrice: buyPrice,
                        sellPrice: sellPrice,
                        spreadPercent: spreadPercent.toFixed(2),
                        netSpread: netSpread.toFixed(2),
                        profitOn500: profitAfterFees.toFixed(2),
                        isProfitable: profitAfterFees >= MIN_PROFIT_USD && netSpread >= MIN_SPREAD_PERCENT,
                        isOptimalHour: isOptimalHour
                    };
                    
                    spreads.push(spreadData);
                    
                    if (spreadData.isProfitable) {
                        state.stats.profitableSpreads++;
                        addLog(`PROFITABLE: ${token.symbol} | ${spreadData.buyDex}->${spreadData.sellDex} | ${spreadData.netSpread}% net | $${spreadData.profitOn500} profit`, 'opportunity');
                        
                        if (LOG_SPREADS_TO_FILE) {
                            spreadLog.push(spreadData);
                        }
                        
                        if (!hourlyStats[currentHour]) {
                            hourlyStats[currentHour] = { count: 0, totalProfit: 0, avgSpread: 0 };
                        }
                        hourlyStats[currentHour].count++;
                        hourlyStats[currentHour].totalProfit += parseFloat(spreadData.profitOn500);
                        hourlyStats[currentHour].avgSpread = (hourlyStats[currentHour].avgSpread + parseFloat(spreadData.netSpread)) / 2;
                    }
                }
            }
        }
    }
    
    state.stats.totalSpreadsFound += spreads.length;
    if (spreads.length > 0) {
        let sum = 0;
        for (let s of spreads) sum += parseFloat(s.netSpread);
        state.stats.averageSpread = (sum / spreads.length).toFixed(2);
        let best = 0;
        for (let s of spreads) best = Math.max(best, parseFloat(s.netSpread));
        if (best > state.stats.bestSpread) state.stats.bestSpread = best;
    }
    
    state.stats.totalOpportunities = state.stats.profitableSpreads;
    state.session.totalScans++;
    
    if (state.session.totalScans % 10 === 0 && LOG_SPREADS_TO_FILE) {
        fs.writeFileSync('spreads_log.json', JSON.stringify({
            spreads: spreadLog.slice(-1000),
            hourlyStats: hourlyStats,
            summary: state.stats
        }, null, 2));
        addLog(`Saved spread data to spreads_log.json`, 'info');
    }
    
    addLog(`SCAN SUMMARY: ${spreads.length} spreads, ${state.stats.profitableSpreads} profitable (min $${MIN_PROFIT_USD})`, 'info');
    
    if (state.stats.profitableSpreads > 0 && !DRY_RUN_MODE && isOptimalHour) {
        addLog(`${state.stats.profitableSpreads} profitable opportunities found! Ready to execute!`, 'success');
    }
    
    return spreads.filter(s => s.isProfitable);
}

// ==================== EXECUTE ONLY AFTER 24 HOURS ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (DRY_RUN_MODE) {
        addLog(`DRY RUN: Would execute ${opportunity.token} trade with $${opportunity.profitOn500} profit`, 'info');
        return false;
    }
    
    const currentHour = new Date().getUTCHours();
    if (!OPTIMAL_HOURS.includes(currentHour)) {
        addLog(`Skipping execution - not optimal hour (${currentHour} UTC). Best hours: 2-6 AM UTC`, 'info');
        return false;
    }
    
    if (!wallet || !flashLoanContract) {
        addLog(`Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    addLog(`EXECUTING: ${opportunity.token} | ${opportunity.buyDex}->${opportunity.sellDex} | Est: $${opportunity.profitOn500}`, 'opportunity');
    
    try {
        const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const amount = ethers.parseUnits(FLASH_LOAN_AMOUNT.toString(), 6);
        const abiCoder = new ethers.AbiCoder();
        const minProfit = ethers.parseUnits((parseFloat(opportunity.profitOn500) * 0.7).toFixed(2), 6);
        
        const buyRouter = DEXES.find(d => d.name === opportunity.buyDex)?.router;
        const sellRouter = DEXES.find(d => d.name === opportunity.sellDex)?.router;
        const tokenAddress = TARGET_TOKENS.find(t => t.symbol === opportunity.token)?.address;
        
        const params = abiCoder.encode(
            ["address", "address", "address", "uint256", "uint256"],
            [buyRouter, sellRouter, tokenAddress, minProfit, Math.floor(Date.now() / 1000) + 300]
        );
        
        const tx = await flashLoanContract.requestFlashLoan(usdcAddress, amount, params, { gasLimit: 2000000 });
        addLog(`Tx: ${tx.hash.substring(0, 20)}...`, 'info');
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const netProfit = parseFloat(opportunity.profitOn500) - gasUsed;
            
            addLog(`SUCCESS! Net Profit: $${netProfit.toFixed(2)}`, 'success');
            
            state.tradeHistory.unshift({
                timestamp: new Date().toISOString(),
                token: opportunity.token,
                profit: netProfit,
                txHash: tx.hash,
                success: true
            });
            
            return true;
        }
    } catch (error) {
        addLog(`Failed: ${error.message.substring(0, 100)}`, 'error');
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    const startTime = Date.now();
    
    addLog('PROFITABLE FLASH LOAN BOT STARTED', 'success');
    addLog(`Strategy: Focus on POL/QUICK/CRV (less competition)`, 'info');
    addLog(`Optimal trading hours: 2-6 AM UTC`, 'info');
    addLog(`Minimum profit target: $${MIN_PROFIT_USD} (${MIN_SPREAD_PERCENT}% spread)`, 'info');
    addLog(`DRY RUN MODE: ${DRY_RUN_MODE ? 'ON - Collecting data for 24 hours' : 'OFF - Executing trades'}`, 'warning');
    addLog(`Will save data to spreads_log.json`, 'info');
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        const profitableSpreads = await scanAndLogSpreads();
        
        const hoursElapsed = (Date.now() - startTime) / 3600000;
        
        if (!DRY_RUN_MODE && hoursElapsed > 24 && profitableSpreads.length > 0) {
            for (const spread of profitableSpreads.slice(0, 1)) {
                await executeFlashLoanArbitrage(spread);
                await new Promise(r => setTimeout(r, 30000));
            }
        } else if (DRY_RUN_MODE && hoursElapsed > 24) {
            addLog(`24 HOURS COMPLETE! Check spreads_log.json for analysis`, 'success');
            addLog(`Run with DRY_RUN_MODE = false to start real trading`, 'info');
        }
        
        await new Promise(r => setTimeout(r, 15000));
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/state', (req, res) => {
    const elapsed = (Date.now() - new Date(state.session.startTime).getTime()) / 3600000;
    res.json({
        mode: DRY_RUN_MODE ? "DRY RUN - Data Collection" : "LIVE - Trading",
        elapsedHours: elapsed.toFixed(1),
        stats: state.stats,
        hourlyStats: hourlyStats,
        optimalHours: OPTIMAL_HOURS,
        minProfit: MIN_PROFIT_USD,
        trades: state.tradeHistory.slice(0, 10),
        logs: state.logs.slice(0, 30)
    });
});

app.get('/api/analysis', (req, res) => {
    try {
        const data = fs.readFileSync('spreads_log.json', 'utf8');
        res.json(JSON.parse(data));
    } catch(e) {
        res.json({ error: "No data yet. Let bot run for a few hours." });
    }
});

app.post('/api/enable', (req, res) => {
    addLog(`To enable trading, set DRY_RUN_MODE = false and restart`, 'warning');
    res.json({ message: "Edit bot.js: set DRY_RUN_MODE = false" });
});

app.get('/', (req, res) => {
    const html = '<!DOCTYPE html>\n' +
'<html>\n' +
'<head>\n' +
'    <title>Flash Loan Bot - Data Collection Mode</title>\n' +
'    <style>\n' +
'        body { font-family: monospace; background: #0a0a0a; color: #0f0; padding: 20px; }\n' +
'        .container { max-width: 1200px; margin: 0 auto; }\n' +
'        .status { background: #1a1a1a; padding: 15px; border-radius: 8px; margin-bottom: 20px; }\n' +
'        .profitable { color: #0f0; }\n' +
'        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }\n' +
'        .card { background: #1a1a1a; padding: 15px; border-radius: 8px; }\n' +
'        pre { background: #1a1a1a; padding: 10px; overflow-x: auto; }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="container">\n' +
'    <div class="status">\n' +
'        <h1>Flash Loan Arbitrage Bot</h1>\n' +
'        <p>Mode: <strong>' + (DRY_RUN_MODE ? 'DATA COLLECTION (24 hours)' : 'LIVE TRADING') + '</strong></p>\n' +
'        <p>Minimum Profit: <strong>$' + MIN_PROFIT_USD + '</strong> | Target Spread: <strong>' + MIN_SPREAD_PERCENT + '%</strong></p>\n' +
'        <p>Optimal Hours: <strong>2-6 AM UTC</strong> | Flash Loan: <strong>$' + FLASH_LOAN_AMOUNT + '</strong></p>\n' +
'    </div>\n' +
'    <div class="stats">\n' +
'        <div class="card">Total Scans<br><span id="scans">0</span></div>\n' +
'        <div class="card">Profitable Spreads<br><span id="profitable">0</span></div>\n' +
'        <div class="card">Avg Spread<br><span id="avgSpread">0%</span></div>\n' +
'        <div class="card">Best Spread<br><span id="bestSpread">0%</span></div>\n' +
'    </div>\n' +
'    <div class="card">\n' +
'        <h3>Hourly Performance</h3>\n' +
'        <pre id="hourlyData">Loading...</pre>\n' +
'    </div>\n' +
'    <div class="card">\n' +
'        <h3>Live Logs</h3>\n' +
'        <pre id="logs" style="height: 300px; overflow-y: auto;"></pre>\n' +
'    </div>\n' +
'</div>\n' +
'<script>\n' +
'    async function fetchData() {\n' +
'        const res = await fetch("/api/state");\n' +
'        const data = await res.json();\n' +
'        document.getElementById("scans").innerText = data.stats?.totalSpreadsFound || 0;\n' +
'        document.getElementById("profitable").innerText = data.stats?.profitableSpreads || 0;\n' +
'        document.getElementById("avgSpread").innerText = (data.stats?.averageSpread || 0) + "%";\n' +
'        document.getElementById("bestSpread").innerText = (data.stats?.bestSpread || 0) + "%";\n' +
'        \n' +
'        let hourlyText = "";\n' +
'        if (data.hourlyStats) {\n' +
'            for (const hour in data.hourlyStats) {\n' +
'                const stats = data.hourlyStats[hour];\n' +
'                hourlyText += hour + ":00 UTC - " + stats.count + " opportunities, avg $" + (stats.totalProfit/stats.count).toFixed(2) + "\\n";\n' +
'            }\n' +
'        }\n' +
'        document.getElementById("hourlyData").innerText = hourlyText || "No data yet. Keep bot running...";\n' +
'        \n' +
'        let logsText = "";\n' +
'        if (data.logs) {\n' +
'            for (let i = 0; i < Math.min(data.logs.length, 20); i++) {\n' +
'                logsText += data.logs[i].message + "\\n";\n' +
'            }\n' +
'        }\n' +
'        document.getElementById("logs").innerText = logsText;\n' +
'    }\n' +
'    fetchData();\n' +
'    setInterval(fetchData, 5000);\n' +
'</script>\n' +
'</body>\n' +
'</html>';
    
    res.send(html);
});

// ==================== START ====================
async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('PROFITABLE FLASH LOAN ARBITRAGE BOT');
    console.log('='.repeat(60));
    console.log(`Mode: ${DRY_RUN_MODE ? 'DATA COLLECTION (24 hours)' : 'LIVE TRADING'}`);
    console.log(`Minimum Profit: $${MIN_PROFIT_USD}`);
    console.log(`Target Spread: ${MIN_SPREAD_PERCENT}%`);
    console.log(`Optimal Hours: 2-6 AM UTC`);
    console.log(`Tokens: ${TARGET_TOKENS.map(t => t.symbol).join(', ')}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('TIMELINE:');
    console.log('   - First 24 hours: DRY RUN - Collect spread data');
    console.log('   - Check spreads_log.json for analysis');
    console.log('   - Then set DRY_RUN_MODE = false to start trading');
    console.log('');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Dashboard: http://localhost:${PORT}`);
        console.log(`Data collection started. Let bot run for 24 hours.`);
    });
}

start();
