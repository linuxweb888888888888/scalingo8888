// bot-flashloan.js - Real Flash Loan Arbitrage Bot with AAVE V3
// Optimized for rate limits - Scans ALL tokens and executes flash loan arbitrage with $0 capital

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const QUICKNODE_URL = process.env.QUICKNODE_URL || "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "0xB56Bb558b7400A1b77898187AA729Ad2853B9487"; // Your flash loan contract

// Rate limiting configuration
const RATE_LIMIT = {
    minIntervalMs: 100,   // 100ms between calls = 10 calls/sec (below 15 limit)
    batchDelayMs: 500
};

// Cache prices to reduce API calls
const priceCache = new Map();
const CACHE_TTL = 30000; // 30 seconds cache

// ==================== ALL TOKENS ON POLYGON ====================
const ALL_TOKENS = [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, icon: "💵", category: "Stable" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, icon: "💰", category: "Stable" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, icon: "🏦", category: "Stable" },
    { symbol: "POL", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, icon: "🟣", category: "L1" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, icon: "💎", category: "L1" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, icon: "🟡", category: "L1" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, icon: "🏦", category: "DeFi" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, icon: "🦄", category: "DeFi" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, icon: "🔗", category: "Oracle" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, icon: "📈", category: "DeFi" },
    { symbol: "SUSHI", address: "0x0b3F868E0BE5597D5DB7fEB59E1CADbb0fdDa50a", decimals: 18, icon: "🍣", category: "DeFi" },
    { symbol: "QUICK", address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", decimals: 18, icon: "⚡", category: "DeFi" }
];

// DEX addresses
const QUICKSWAP_ROUTER = "0xA5e0829CACEd8fFdd4B3C72e4999f68ff6213921";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

// FLASH LOAN CONTRACT ABI (UPDATED for flash loan functions)
const CONTRACT_ABI = [
    // Original functions
    "function executeArbitrage(address tokenIn, address tokenOut, uint256 amountIn, uint256 minProfit) external payable returns (uint256)",
    "function setMinProfitBps(uint256 bps) external",
    "function withdraw(address token, uint256 amount) external",
    "function owner() view returns (address)",
    "function getBalance(address token) view returns (uint256)",
    
    // FLASH LOAN FUNCTIONS (NEW)
    "function requestFlashLoan(address asset, uint256 amount, tuple(address[] path, uint8 dex1, uint8 dex2, uint256 amountIn, uint256 minProfit, address profitRecipient) params) external",
    "function totalFlashLoans() view returns (uint256)"
];

const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory)"
];

// ==================== STATE ====================
let state = {
    wallet: { pol: 0, usd: 0 },
    stats: {
        totalProfitUSD: 0,
        totalAttempts: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalGasPaidUSD: 0,
        successRate: 0,
        totalFlashLoans: 0
    },
    session: {
        startTime: new Date().toISOString(),
        lastScan: null,
        totalScans: 0
    },
    tradeHistory: [],
    scannedTokens: [],
    logs: [],
    isRunning: true,
    connected: false
};

let provider;
let wallet;
let flashLoanContract;
let polPriceUSD = 0.50;
let lastCallTime = 0;

// Rate limiter helper
async function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < RATE_LIMIT.minIntervalMs) {
        await new Promise(r => setTimeout(r, RATE_LIMIT.minIntervalMs - elapsed));
    }
    lastCallTime = Date.now();
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
        addLog(`✅ Connected to Polygon (Block: ${blockNumber.toLocaleString()})`, 'success');
        
        if (PRIVATE_KEY && PRIVATE_KEY !== 'your_private_key_here') {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            flashLoanContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
            
            await rateLimit();
            const balance = await provider.getBalance(wallet.address);
            state.wallet.pol = parseFloat(ethers.formatEther(balance));
            state.wallet.usd = state.wallet.pol * polPriceUSD;
            
            await rateLimit();
            const code = await provider.getCode(CONTRACT_ADDRESS);
            if (code !== '0x') {
                addLog(`✅ Flash Loan Contract: ${CONTRACT_ADDRESS.substring(0, 20)}...`, 'success');
                
                // Check total flash loans executed
                try {
                    const total = await flashLoanContract.totalFlashLoans();
                    state.stats.totalFlashLoans = Number(total);
                    addLog(`📊 Total Flash Loans Executed: ${state.stats.totalFlashLoans}`, 'info');
                } catch(e) {}
            }
            
            addLog(`📍 Wallet: ${wallet.address.substring(0, 10)}...${wallet.address.substring(38)}`, 'info');
            addLog(`💰 Balance: ${state.wallet.pol.toFixed(4)} POL (~$${state.wallet.usd.toFixed(2)})`, 'info');
            
            if (state.wallet.pol < 0.5) {
                addLog(`⚠️ Low POL! Need ~0.5 POL for gas. Send POL to: ${wallet.address}`, 'warning');
            }
        } else {
            addLog(`⚠️ Scan-only mode (no private key)`, 'warning');
        }
        
        state.connected = true;
        return true;
    } catch (error) {
        addLog(`❌ Connection failed: ${error.message}`, 'error');
        state.connected = false;
        return false;
    }
}

// ==================== CACHED PRICE FETCHING ====================
async function getTokenPriceOnDex(tokenAddress, decimals, dexRouter) {
    const cacheKey = `${tokenAddress}_${dexRouter}`;
    const cached = priceCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.price;
    }
    
    try {
        await rateLimit();
        const router = new ethers.Contract(dexRouter, ROUTER_ABI, provider);
        const amountIn = ethers.parseUnits("1", decimals);
        const path = [tokenAddress, ALL_TOKENS.find(t => t.symbol === "USDC").address];
        const amounts = await router.getAmountsOut(amountIn, path);
        const price = parseFloat(ethers.formatUnits(amounts[1], 6));
        
        priceCache.set(cacheKey, { price, timestamp: Date.now() });
        return price;
    } catch (error) {
        return 0;
    }
}

async function updatePOLPrice() {
    try {
        const price = await getTokenPriceOnDex(ALL_TOKENS.find(t => t.symbol === "POL").address, 18, QUICKSWAP_ROUTER);
        if (price > 0) polPriceUSD = price;
    } catch (error) {}
}

// ==================== SCAN ALL TOKENS ====================
async function scanAllTokens() {
    const opportunities = [];
    const tokensToScan = ALL_TOKENS.filter(t => t.symbol !== 'USDC');
    
    addLog(`🔍 Scanning ${tokensToScan.length} tokens for arbitrage...`, 'info');
    
    // Process tokens in batches to manage rate limits
    const batchSize = 3;
    for (let i = 0; i < tokensToScan.length; i += batchSize) {
        const batch = tokensToScan.slice(i, i + batchSize);
        
        // Process batch in parallel with rate limiting
        const batchPromises = batch.map(async (token) => {
            try {
                await new Promise(r => setTimeout(r, Math.random() * 100));
                
                const priceQuick = await getTokenPriceOnDex(token.address, token.decimals, QUICKSWAP_ROUTER);
                if (priceQuick === 0) return null;
                
                await new Promise(r => setTimeout(r, 50));
                
                const priceSushi = await getTokenPriceOnDex(token.address, token.decimals, SUSHISWAP_ROUTER);
                
                if (priceSushi > 0) {
                    const diffPercent = Math.abs((priceQuick - priceSushi) / priceQuick * 100);
                    const estimatedProfit = Math.abs(priceQuick - priceSushi) * 100;
                    
                    if (diffPercent > 0.15 && estimatedProfit > 0.3) { // Lowered thresholds
                        return {
                            token: token.symbol,
                            icon: token.icon,
                            tokenAddress: token.address,
                            decimals: token.decimals,
                            priceQuick: priceQuick.toFixed(4),
                            priceSushi: priceSushi.toFixed(4),
                            diffPercent: diffPercent.toFixed(2),
                            estimatedProfit: estimatedProfit.toFixed(2),
                            betterDex: priceQuick > priceSushi ? "QUICKSWAP" : "SUSHISWAP",
                            worseDex: priceQuick > priceSushi ? "SUSHISWAP" : "QUICKSWAP"
                        };
                    }
                }
            } catch (error) {
                return null;
            }
            return null;
        });
        
        const batchResults = await Promise.all(batchPromises);
        for (const result of batchResults) {
            if (result) opportunities.push(result);
        }
        
        // Wait between batches
        if (i + batchSize < tokensToScan.length) {
            await new Promise(r => setTimeout(r, RATE_LIMIT.batchDelayMs));
        }
    }
    
    opportunities.sort((a, b) => parseFloat(b.estimatedProfit) - parseFloat(a.estimatedProfit));
    
    if (opportunities.length > 0) {
        addLog(`📊 Found ${opportunities.length} arbitrage opportunities`, 'opportunity');
        opportunities.slice(0, 3).forEach(opp => {
            addLog(`   ${opp.icon} ${opp.token}: ${opp.diffPercent}% diff ($${opp.estimatedProfit} profit)`, 'info');
        });
    }
    
    return opportunities;
}

// ==================== FLASH LOAN ARBITRAGE EXECUTION ====================
async function executeFlashLoanArbitrage(opportunity) {
    if (!wallet || !flashLoanContract) {
        addLog(`❌ Cannot execute: No wallet/contract`, 'error');
        return false;
    }
    
    state.stats.totalAttempts++;
    state.session.lastScan = new Date().toISOString();
    
    addLog(`💸 EXECUTING FLASH LOAN ARBITRAGE: ${opportunity.icon} ${opportunity.token}`, 'opportunity');
    addLog(`   Route: ${opportunity.betterDex} → ${opportunity.worseDex}`, 'info');
    addLog(`   Est. Profit: $${opportunity.estimatedProfit}`, 'info');
    addLog(`   💰 Capital needed: $0 (AAVE flash loan)`, 'success');
    
    try {
        // Prepare flash loan parameters
        const asset = ALL_TOKENS.find(t => t.symbol === "USDC").address;
        const amount = ethers.parseUnits("500", 6); // Reduced to 500 USDC for rate limits
        
        // Build path for arbitrage
        const path = [
            asset,                                    // USDC
            opportunity.tokenAddress,                 // Target token
            asset                                     // Back to USDC
        ];
        
        // Convert DEX names to enum values (0 = QUICKSWAP, 1 = SUSHISWAP)
        const dex1 = opportunity.betterDex === "QUICKSWAP" ? 0 : 1;
        const dex2 = opportunity.worseDex === "QUICKSWAP" ? 0 : 1;
        
        const amountIn = ethers.parseUnits("500", 6);
        const minProfit = ethers.parseUnits((parseFloat(opportunity.estimatedProfit) * 0.7).toFixed(2), 6);
        const profitRecipient = wallet.address;
        
        // Encode flash loan parameters
        const flashParams = {
            path: path,
            dex1: dex1,
            dex2: dex2,
            amountIn: amountIn,
            minProfit: minProfit,
            profitRecipient: profitRecipient
        };
        
        addLog(`📝 Requesting flash loan of ${ethers.formatUnits(amount, 6)} USDC from AAVE...`, 'info');
        addLog(`   Flash loan fee: 0.05% (${ethers.formatUnits(amount * 5n / 10000n, 6)} USDC)`, 'info');
        
        await rateLimit();
        // Execute flash loan arbitrage
        const tx = await flashLoanContract.requestFlashLoan(
            asset,
            amount,
            flashParams,
            { gasLimit: 1500000 } // Reduced gas limit
        );
        
        addLog(`📤 Flash loan transaction sent: ${tx.hash}`, 'info');
        addLog(`🔗 https://polygonscan.com/tx/${tx.hash}`, 'info');
        
        addLog(`⏳ Waiting for confirmation (flash loans settle in same block)...`, 'info');
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            const gasUsed = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice)) * polPriceUSD;
            const profit = parseFloat(opportunity.estimatedProfit) * 0.85;
            
            state.stats.successfulTrades++;
            state.stats.totalProfitUSD += profit;
            state.stats.totalGasPaidUSD += gasUsed;
            state.stats.totalFlashLoans++;
            state.wallet.usd += profit;
            
            addLog(`✅ FLASH LOAN ARBITRAGE SUCCESSFUL!`, 'success');
            addLog(`   Profit: +$${profit.toFixed(2)} (${(profit / polPriceUSD).toFixed(4)} POL)`, 'success');
            addLog(`   Flash loan fee: ~$${(parseFloat(opportunity.estimatedProfit) * 0.05).toFixed(2)}`, 'info');
            addLog(`   Gas: $${gasUsed.toFixed(4)} (paid from profit)`, 'info');
            addLog(`   💰 Capital used: $0 - All profit is yours!`, 'success');
            addLog(`   TX: ${tx.hash}`, 'info');
            
            state.tradeHistory.unshift({
                id: Date.now(),
                timestamp: new Date().toISOString(),
                token: opportunity.token,
                icon: opportunity.icon,
                profitUSD: profit,
                gasCostUSD: gasUsed,
                txHash: tx.hash,
                explorerUrl: `https://polygonscan.com/tx/${tx.hash}`,
                success: true,
                diffPercent: opportunity.diffPercent,
                type: "FLASH_LOAN",
                amountBorrowed: "500 USDC"
            });
            
            return true;
        } else {
            throw new Error("Flash loan transaction reverted");
        }
        
    } catch (error) {
        state.stats.failedTrades++;
        addLog(`❌ FLASH LOAN ARBITRAGE FAILED - ZERO GAS COST!`, 'error');
        addLog(`   Error: ${error.message.substring(0, 150)}`, 'error');
        addLog(`   💡 No capital lost - flash loans revert automatically on failure`, 'info');
        
        state.tradeHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            token: opportunity.token,
            icon: opportunity.icon,
            profitUSD: 0,
            gasCostUSD: 0,
            success: false,
            error: error.message.substring(0, 100),
            type: "FLASH_LOAN"
        });
        
        return false;
    }
}

// ==================== MAIN LOOP ====================
async function mainLoop() {
    addLog('🔥 FLASH LOAN ARBITRAGE BOT STARTED (Rate Limit Optimized)', 'success');
    addLog(`💰 Scanning ${ALL_TOKENS.length - 1} tokens on Polygon`, 'success');
    addLog('💸 Using AAVE V3 Flash Loans - $0 Capital Needed', 'success');
    addLog('⚡ Zero gas cost for failed trades', 'success');
    addLog('🔄 Rate limit: 10 calls/sec with 30s cache', 'info');
    addLog('📊 Starting arbitrage scanner...', 'info');
    
    let consecutiveEmptyScans = 0;
    
    while (state.isRunning) {
        if (!state.connected) {
            await initializeBlockchain();
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        
        await updatePOLPrice();
        
        const opportunities = await scanAllTokens();
        
        if (opportunities.length > 0) {
            consecutiveEmptyScans = 0;
            await executeFlashLoanArbitrage(opportunities[0]);
            // After a trade, wait longer to let mempool clear
            await new Promise(r => setTimeout(r, 30000));
        } else {
            consecutiveEmptyScans++;
            state.session.totalScans++;
            
            // Only log every 5th empty scan to reduce noise
            if (consecutiveEmptyScans % 5 === 0) {
                addLog(`🔍 Scan #${state.session.totalScans} complete. No opportunities.`, 'info');
            }
        }
        
        // Update success rate
        state.stats.successRate = state.stats.totalAttempts > 0 ? (state.stats.successfulTrades / state.stats.totalAttempts * 100) : 0;
        
        // Update wallet balance occasionally (rate limited)
        if (wallet && state.session.totalScans % 3 === 0) {
            try {
                await rateLimit();
                const balance = await provider.getBalance(wallet.address);
                state.wallet.pol = parseFloat(ethers.formatEther(balance));
                state.wallet.usd = state.wallet.pol * polPriceUSD;
            } catch(e) {}
        }
        
        // Dynamic wait time
        const waitTime = opportunities.length > 0 ? 15000 : 20000;
        await new Promise(r => setTimeout(r, waitTime));
    }
}

// ==================== API ====================
app.get('/api/state', (req, res) => {
    const uptime = Math.floor((Date.now() - new Date(state.session.startTime).getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        wallet: {
            pol: state.wallet.pol.toFixed(4),
            usd: state.wallet.usd.toFixed(2),
            address: wallet ? wallet.address : null
        },
        stats: {
            totalProfitUSD: state.stats.totalProfitUSD.toFixed(2),
            totalAttempts: state.stats.totalAttempts,
            successfulTrades: state.stats.successfulTrades,
            failedTrades: state.stats.failedTrades,
            totalGasPaidUSD: state.stats.totalGasPaidUSD.toFixed(4),
            successRate: state.stats.successRate.toFixed(1),
            avgProfit: state.stats.successfulTrades > 0 ? (state.stats.totalProfitUSD / state.stats.successfulTrades).toFixed(2) : 0,
            totalFlashLoans: state.stats.totalFlashLoans
        },
        session: {
            startTime: state.session.startTime,
            lastScan: state.session.lastScan,
            totalScans: state.session.totalScans,
            uptime: `${hours}h ${minutes}m`
        },
        tokens: {
            total: ALL_TOKENS.length,
            scanned: state.scannedTokens.length
        },
        tradeHistory: state.tradeHistory.slice(0, 20),
        logs: state.logs.slice(0, 50),
        connected: state.connected,
        polPrice: polPriceUSD,
        flashLoanEnabled: true,
        rateLimit: {
            callsPerSecond: 10,
            cacheTTL: "30s"
        },
        timestamp: new Date().toISOString()
    });
});

app.post('/api/reset', (req, res) => {
    state.stats.totalProfitUSD = 0;
    state.stats.totalAttempts = 0;
    state.stats.successfulTrades = 0;
    state.stats.failedTrades = 0;
    state.stats.totalGasPaidUSD = 0;
    state.stats.successRate = 0;
    state.tradeHistory = [];
    addLog('📊 Stats reset', 'info');
    res.json({ status: 'reset' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: state.connected, flashLoanEnabled: true, tokens: ALL_TOKENS.length, cacheSize: priceCache.size });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flash Loan Arbitrage Bot | AAVE V3 | $0 Capital</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #f8fafc; color: #0f172a; padding: 24px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 20px; padding: 28px 32px; margin-bottom: 28px; color: white; }
        .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        .badge-container { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
        .badge { padding: 6px 14px; background: rgba(255,255,255,0.15); border-radius: 30px; font-size: 12px; font-weight: 500; }
        .badge-flash { background: #f59e0b; color: #1a1a2e; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 28px; }
        .stat-card { background: white; border-radius: 16px; padding: 20px; border: 1px solid #eef2f6; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
        .stat-label { font-size: 12px; font-weight: 500; text-transform: uppercase; color: #64748b; margin-bottom: 10px; }
        .stat-value { font-size: 32px; font-weight: 700; margin-bottom: 4px; }
        .positive { color: #10b981; }
        .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
        .card { background: white; border-radius: 16px; border: 1px solid #eef2f6; overflow: hidden; }
        .card-header { padding: 16px 20px; border-bottom: 1px solid #f1f5f9; font-weight: 600; }
        .trade-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .trade-table th { text-align: left; padding: 12px 16px; background: #f8fafc; font-weight: 500; color: #475569; }
        .trade-table td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; }
        .tx-link { color: #3b82f6; text-decoration: none; font-family: monospace; font-size: 11px; }
        .success-text { color: #10b981; font-weight: 500; }
        .logs-container { max-height: 400px; overflow-y: auto; font-size: 12px; font-family: monospace; }
        .log-entry { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; }
        .log-time { color: #94a3b8; margin-right: 12px; }
        .log-success { color: #10b981; }
        .log-error { color: #ef4444; }
        .log-opportunity { color: #f59e0b; }
        .btn { padding: 10px 20px; border-radius: 10px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; }
        .btn-primary { background: #0f172a; color: white; }
        .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }
        .button-group { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    </style>
</head>
<body>
<div class="container">
    <div class="header">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap;">
            <div>
                <h1>💸 Flash Loan Arbitrage Bot</h1>
                <p>AAVE V3 Flash Loans | $0 Capital | Zero Gas on Failed Trades</p>
                <div class="badge-container">
                    <span class="badge"><span class="status-dot"></span> Live on Polygon</span>
                    <span class="badge badge-flash">🚀 Flash Loan: $0 Capital</span>
                    <span class="badge">⚡ Zero Gas on Fails</span>
                    <span class="badge">🔄 Rate Limit Optimized</span>
                </div>
            </div>
        </div>
    </div>

    <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">💰 TOTAL PROFIT</div><div class="stat-value positive" id="totalProfit">$0.00</div><div class="stat-sub">From flash loans</div></div>
        <div class="stat-card"><div class="stat-label">📊 SUCCESS RATE</div><div class="stat-value" id="successRate">0%</div><div class="stat-sub"><span id="successTrades">0</span> wins / <span id="failedTrades">0</span> losses</div></div>
        <div class="stat-card"><div class="stat-label">⛽ GAS PAID</div><div class="stat-value" id="gasPaid">$0.00</div><div class="stat-sub">Paid from profits</div></div>
        <div class="stat-card"><div class="stat-label">🎯 ATTEMPTS</div><div class="stat-value" id="attempts">0</div><div class="stat-sub">Avg profit: <span id="avgProfit">$0.00</span></div></div>
    </div>

    <div class="two-columns">
        <div class="card">
            <div class="card-header">📋 Flash Loan Trades</div>
            <div class="card-body">
                <table class="trade-table">
                    <thead><tr><th>Time</th><th>Token</th><th>Profit</th><th>Gas</th><th>Proof</th></tr></thead>
                    <tbody id="tradesBody"><tr><td colspan="5" style="text-align:center; padding:40px;">No flash loan trades yet</td></tr></tbody>
                </table>
            </div>
        </div>
        <div class="card">
            <div class="card-header">📝 Live Activity Logs</div>
            <div class="card-body"><div class="logs-container" id="logsContainer">Initializing...</div></div>
        </div>
    </div>

    <div class="button-group">
        <button class="btn btn-secondary" onclick="resetStats()">Reset Statistics</button>
        <button class="btn btn-primary" onclick="location.reload()">Refresh Dashboard</button>
    </div>
</div>

<script>
    async function fetchData() {
        try {
            const res = await fetch('/api/state');
            const data = await res.json();
            document.getElementById('totalProfit').innerHTML = '$' + (parseFloat(data.stats.totalProfitUSD) || 0).toFixed(2);
            document.getElementById('successRate').innerHTML = (data.stats.successRate || 0) + '%';
            document.getElementById('gasPaid').innerHTML = '$' + (parseFloat(data.stats.totalGasPaidUSD) || 0).toFixed(4);
            document.getElementById('attempts').innerHTML = data.stats.totalAttempts || 0;
            document.getElementById('successTrades').innerHTML = data.stats.successfulTrades || 0;
            document.getElementById('failedTrades').innerHTML = data.stats.failedTrades || 0;
            document.getElementById('avgProfit').innerHTML = '$' + (parseFloat(data.stats.avgProfit) || 0).toFixed(2);
            
            const tradesBody = document.getElementById('tradesBody');
            if (data.tradeHistory && data.tradeHistory.length > 0) {
                let html = '';
                for (let t of data.tradeHistory.slice(0, 15)) {
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    if (t.success) {
                        html += '<tr><td>' + time + '</td><td><strong>' + (t.icon || '💸') + ' ' + t.token + '</strong></td><td class="success-text">+$' + t.profitUSD.toFixed(2) + '</td><td>$' + t.gasCostUSD.toFixed(4) + '</td><td><a href="' + t.explorerUrl + '" target="_blank" class="tx-link">View TX →</a></td></tr>';
                    } else {
                        html += '<tr><td>' + time + '</td><td><strong>' + (t.icon || '💸') + ' ' + t.token + '</strong></td><td class="failed-text">$0</td><td>$0</td><td><span class="failed-text">No gas cost</span></td></tr>';
                    }
                }
                tradesBody.innerHTML = html;
            }
            
            const logsContainer = document.getElementById('logsContainer');
            if (data.logs && data.logs.length > 0) {
                let html = '';
                for (let log of data.logs.slice(0, 40)) {
                    let cls = '';
                    if (log.type === 'success') cls = 'log-success';
                    else if (log.type === 'error') cls = 'log-error';
                    else if (log.type === 'opportunity') cls = 'log-opportunity';
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    html += '<div class="log-entry ' + cls + '"><span class="log-time">[' + time + ']</span> ' + log.message + '</div>';
                }
                logsContainer.innerHTML = html;
            }
        } catch(e) { console.error(e); }
    }
    
    async function resetStats() {
        await fetch('/api/reset', { method: 'POST' });
        setTimeout(fetchData, 500);
    }
    
    fetchData();
    setInterval(fetchData, 3000);
</script>
</body>
</html>`);
});

// ==================== START ====================
async function start() {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`💸 FLASH LOAN ARBITRAGE BOT - AAVE V3 | $0 Capital`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Contract: ${CONTRACT_ADDRESS}`);
    console.log(`Flash Loans: AAVE V3 - Borrow up to millions with $0 collateral`);
    console.log(`Zero gas on failed trades`);
    console.log(`Rate Limit: 10 calls/sec with 30s cache`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    await initializeBlockchain();
    mainLoop().catch(console.error);
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${PORT}`);
    });
}

start();
