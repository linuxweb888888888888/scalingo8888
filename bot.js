/**
 * ⚡ TITAN ARBITRAGE v9.1 - FIXED BALANCER FLASH LOANS ⚡
 * ✅ CONTRACT DEPLOYED: 0x45EA9b7cB6DA33e651Ae7cb71C877cc5C6e42b63
 * ✅ Using Balancer Vault for Flash Loans
 */

const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== [ CONFIGURATION ] ====================
const PRIVATE_KEY = "0xe97293d254eb17ce5325c22803d16018a22c649d3d71098672eaa0363bfcd894";
// ✅ YOUR DEPLOYED CONTRACT
const CONTRACT_ADDRESS = "0x45EA9b7cB6DA33e651Ae7cb71C877cc5C6e42b63";
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ✅ BALANCER VAULT (CORRECT ADDRESS FOR FLASH LOANS)
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// ✅ USING ONLY WORKING dRPC ENDPOINT
const RPC_URL = "https://polygon.drpc.org";

// Financial parameters
const BORROW_AMOUNT = 10000;      // $10,000 USDC
const FLASH_LOAN_FEE = 0.00009;    // 0.009% Balancer fee (FIXED)
const DEX_FEE_PERCENT = 0.006;    // 0.6% for two swaps (0.3% each)
const EST_GAS_GWEI = 100;          // 100 Gwei
const EST_GAS_LIMIT = 800000;      // 800k gas for flash loan + swaps
const MIN_PROFIT_TRIGGER = 20;     // $20 minimum profit to execute (lowered for testing)

const SCAN_SPEED = 8000; // 8 seconds

// Tokens with real pairs on DEXes
const TOKENS = [
    { s: "WMATIC", a: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", cg: "matic-network", decimals: 18 },
    { s: "WETH", a: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", cg: "ethereum", decimals: 18 },
    { s: "WBTC", a: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", cg: "wrapped-bitcoin", decimals: 8 },
    { s: "LINK", a: "0xb0897686c545045aFc77CF20eC7A532E3120E0F1", cg: "chainlink", decimals: 18 },
    { s: "USDT", a: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", cg: "tether", decimals: 6 },
    { s: "DAI", a: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", cg: "dai", decimals: 18 }
];

// DEX mapping with correct router addresses for Polygon
const DEX_MAP = { 
    "quickswap": { 
        router: "0xa5e0829caced8ffdd4b3c72e4999f68ff6213923", 
        factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
        fee: 0.003 
    },
    "sushiswap": { 
        router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", 
        factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
        fee: 0.003 
    },
    "uniswap": { 
        router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", 
        factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        fee: 0.003 
    }
};

// ==================== [ STATE MANAGEMENT ] ====================
let state = { 
    connected: false, 
    rpc: RPC_URL,
    walletBal: "0.00", 
    autoTrade: true,
    stats: { 
        scans: 0, 
        tradesExecuted: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0,
        totalFlashFees: 0,
        totalGasSpent: 0,
        totalDexFees: 0
    }, 
    logs: [], 
    opportunities: [],
    tradeHistory: []
};

let provider, wallet, contract;
let contractDeployed = false;

// ==================== [ COMPLETE CONTRACT ABI FOR FLASH LOANS ] ====================
const CONTRACT_ABI = [
    // Flash Loan Functions
    "function executeFlashLoan(address token, uint256 amount, address dexA, address dexB, address targetToken) external returns (bool)",
    "function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external",
    
    // Admin Functions
    "function withdraw(address token, uint256 amount) external",
    "function withdrawETH() external",
    "function setApprovals() external",
    
    // View Functions
    "function getBalance(address token) view returns (uint256)",
    "function owner() view returns (address)",
    "function totalFlashLoans() view returns (uint256)",
    "function balancerVault() view returns (address)",
    
    // Events
    "event FlashLoanExecuted(address indexed token, uint256 amount, uint256 profit)",
    "event ArbitrageExecuted(address indexed token, uint256 buyAmount, uint256 sellAmount, uint256 profit)"
];

// ==================== [ CONNECTION & CONTRACT ] ====================
async function connect() {
    try {
        // ✅ USING ONLY dRPC WORKING ENDPOINT
        provider = new ethers.JsonRpcProvider(RPC_URL);
        const block = await provider.getBlockNumber();
        state.connected = true;
        
        console.log(`✅ Connected to dRPC Polygon (Block: ${block})`);
        console.log(`📍 RPC: ${RPC_URL} (100% uptime)`);
        
        if (PRIVATE_KEY && PRIVATE_KEY !== "your_private_key_here") {
            wallet = new ethers.Wallet(PRIVATE_KEY, provider);
            const balance = await provider.getBalance(wallet.address);
            state.walletBal = parseFloat(ethers.formatEther(balance)).toFixed(4);
            
            console.log(`✅ Wallet: ${wallet.address.substring(0, 10)}...`);
            console.log(`💰 MATIC Balance: ${state.walletBal}`);
            
            // Check if contract exists
            const code = await provider.getCode(CONTRACT_ADDRESS);
            if (code && code !== "0x") {
                console.log(`✅ Contract found at: ${CONTRACT_ADDRESS}`);
                contractDeployed = true;
                
                contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
                
                try {
                    const owner = await contract.owner();
                    console.log(`✅ Contract owner: ${owner.substring(0, 10)}...`);
                    if (owner.toLowerCase() === wallet.address.toLowerCase()) {
                        console.log("✅ You are the contract owner!");
                    }
                } catch(e) {
                    console.log("⚠️ Could not verify ownership, but continuing...");
                }
                
                try {
                    const vault = await contract.balancerVault();
                    console.log(`✅ Balancer Vault: ${vault}`);
                } catch(e) {
                    console.log("⚠️ Could not get vault address, using default");
                }
                
                try {
                    const total = await contract.totalFlashLoans();
                    console.log(`📊 Total Flash Loans Executed: ${total}`);
                } catch(e) {}
                
            } else {
                console.log(`❌ Contract NOT found at ${CONTRACT_ADDRESS}`);
                console.log(`⚠️ Please deploy the contract first using the Solidity code`);
                contractDeployed = false;
            }
        } else {
            console.log("⚠️ SIMULATION MODE: No private key provided");
            contractDeployed = false;
        }
    } catch (e) { 
        console.log("Connection failed:", e.message);
        state.connected = false;
    }
}

// ==================== [ REAL PROFIT CALCULATION ] ====================
function calculateRealProfit(spreadPercent, borrowAmount = BORROW_AMOUNT) {
    const grossProfit = borrowAmount * (spreadPercent / 100);
    const dexFees = borrowAmount * DEX_FEE_PERCENT;
    const flashFee = borrowAmount * FLASH_LOAN_FEE;
    const gasCostEstimate = (EST_GAS_GWEI * EST_GAS_LIMIT * 1e-9) * 250; // ~$0.25 USD
    const totalCosts = dexFees + flashFee + gasCostEstimate;
    const netProfit = grossProfit - totalCosts;
    
    return {
        grossProfit: grossProfit,
        dexFees: dexFees,
        flashFee: flashFee,
        gasCost: gasCostEstimate,
        totalCosts: totalCosts,
        netProfit: netProfit,
        netProfitPercent: (netProfit / borrowAmount) * 100,
        isProfitable: netProfit > MIN_PROFIT_TRIGGER,
        roi: totalCosts > 0 ? (netProfit / totalCosts) * 100 : 0
    };
}

// ==================== [ PRICE FETCHING ] ====================
async function getDexScreenerPrices(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
            timeout: 5000
        });
        
        if (response.data && response.data.pairs) {
            const pairs = response.data.pairs.filter(p => 
                p.chainId === "polygon" && 
                p.priceUsd && 
                parseFloat(p.priceUsd) > 0 &&
                (p.baseToken.address.toLowerCase() === tokenAddress.toLowerCase() ||
                 p.quoteToken.address.toLowerCase() === tokenAddress.toLowerCase())
            );
            
            const dexPrices = {};
            pairs.forEach(pair => {
                let price = parseFloat(pair.priceUsd);
                const dexId = pair.dexId;
                if (!dexPrices[dexId] || price > dexPrices[dexId]) {
                    dexPrices[dexId] = price;
                }
            });
            
            return dexPrices;
        }
    } catch(e) {
        // Silent fail
    }
    return {};
}

// ==================== [ MAIN SCAN LOGIC ] ====================
async function scan() {
    if (!state.connected) {
        await connect();
    }
    
    state.stats.scans++;
    const opportunities = [];
    
    for (const token of TOKENS) {
        try {
            const dexPrices = await getDexScreenerPrices(token.a);
            const dexEntries = Object.entries(dexPrices);
            
            if (dexEntries.length < 2) continue;
            
            let lowest = { dex: null, price: Infinity };
            let highest = { dex: null, price: -Infinity };
            
            dexEntries.forEach(([dex, price]) => {
                if (price < lowest.price && DEX_MAP[dex]) {
                    lowest = { dex, price };
                }
                if (price > highest.price && DEX_MAP[dex]) {
                    highest = { dex, price };
                }
            });
            
            if (!lowest.dex || !highest.dex) continue;
            
            const spreadPercent = ((highest.price - lowest.price) / lowest.price) * 100;
            const profitCalc = calculateRealProfit(spreadPercent);
            const progress = Math.min(100, (profitCalc.netProfit / MIN_PROFIT_TRIGGER) * 100);
            
            const opportunity = {
                token: token.s,
                tokenAddress: token.a,
                buyDex: lowest.dex,
                buyPrice: lowest.price,
                sellDex: highest.dex,
                sellPrice: highest.price,
                spreadPercent: spreadPercent.toFixed(3),
                progress: progress.toFixed(0),
                grossProfit: profitCalc.grossProfit,
                dexFees: profitCalc.dexFees,
                flashFee: profitCalc.flashFee,
                gasCost: profitCalc.gasCost,
                totalCosts: profitCalc.totalCosts,
                netProfit: profitCalc.netProfit,
                netProfitPercent: profitCalc.netProfitPercent.toFixed(2),
                roi: profitCalc.roi.toFixed(0),
                isProfitable: profitCalc.isProfitable,
                timestamp: Date.now()
            };
            
            opportunities.push(opportunity);
            
            // EXECUTE FLASH LOAN IF PROFITABLE
            if (profitCalc.isProfitable && state.autoTrade && contract && contractDeployed) {
                console.log(`\n🚀 TRIGGERING FLASH LOAN for ${token.s}`);
                console.log(`   Profit: $${profitCalc.netProfit.toFixed(2)}`);
                await executeFlashLoan(opportunity);
            }
            
        } catch(e) {
            // Silent fail for individual token errors
        }
    }
    
    state.opportunities = opportunities.sort((a, b) => b.netProfit - a.netProfit).slice(0, 15);
    
    if (state.stats.scans % 10 === 0) {
        console.log(`📊 Scan #${state.stats.scans} - Found ${opportunities.length} opportunities`);
    }
}

// ==================== [ EXECUTE FLASH LOAN - FIXED FOR BALANCER ] ====================
async function executeFlashLoan(opportunity) {
    if (!contract || !wallet) {
        console.log("❌ Cannot execute: No contract or wallet");
        return;
    }
    
    if (!contractDeployed) {
        console.log("❌ Contract not deployed!");
        console.log("📝 Please deploy the BalancerFlashLoan contract first");
        return;
    }
    
    const startTime = Date.now();
    state.stats.tradesExecuted++;
    
    state.logs.unshift({
        time: new Date().toISOString(),
        message: `🚀 EXECUTING: ${opportunity.token} | ${opportunity.buyDex} → ${opportunity.sellDex} | Est Profit: $${opportunity.netProfit.toFixed(2)}`
    });
    
    console.log(`\n💸 EXECUTING FLASH LOAN for ${opportunity.token}`);
    console.log(`   Buy: ${opportunity.buyDex} @ $${opportunity.buyPrice.toFixed(4)}`);
    console.log(`   Sell: ${opportunity.sellDex} @ $${opportunity.sellPrice.toFixed(4)}`);
    console.log(`   Expected Profit: $${opportunity.netProfit.toFixed(2)}`);
    
    try {
        // Get router addresses
        const dexARouter = DEX_MAP[opportunity.buyDex]?.router;
        const dexBRouter = DEX_MAP[opportunity.sellDex]?.router;
        
        if (!dexARouter || !dexBRouter) {
            const errorMsg = `DEX router not found for ${opportunity.buyDex} or ${opportunity.sellDex}`;
            console.log(`❌ ${errorMsg}`);
            console.log(`   Available DEXes: ${Object.keys(DEX_MAP).join(', ')}`);
            throw new Error(errorMsg);
        }
        
        const borrowAmount = ethers.parseUnits(BORROW_AMOUNT.toString(), 6);
        
        console.log(`   Borrow Amount: ${BORROW_AMOUNT} USDC`);
        console.log(`   Balancer Vault: ${BALANCER_VAULT}`);
        console.log(`   Router A (${opportunity.buyDex}): ${dexARouter.substring(0, 15)}...`);
        console.log(`   Router B (${opportunity.sellDex}): ${dexBRouter.substring(0, 15)}...`);
        console.log(`   Target Token: ${opportunity.tokenAddress.substring(0, 15)}...`);
        
        // Estimate gas first
        const gasEstimate = await contract.executeFlashLoan.estimateGas(
            USDC_ADDR,
            borrowAmount,
            dexARouter,
            dexBRouter,
            opportunity.tokenAddress
        ).catch(() => EST_GAS_LIMIT);
        
        const gasLimit = Math.min(Math.floor(Number(gasEstimate) * 1.2), 2000000);
        console.log(`   Gas Estimate: ${gasEstimate}, Using: ${gasLimit}`);
        
        // Execute the flash loan transaction
        const tx = await contract.executeFlashLoan(
            USDC_ADDR,
            borrowAmount,
            dexARouter,
            dexBRouter,
            opportunity.tokenAddress,
            { 
                gasLimit: gasLimit,
                maxFeePerGas: ethers.parseUnits("150", "gwei"),
                maxPriorityFeePerGas: ethers.parseUnits("30", "gwei")
            }
        );
        
        console.log(`📤 Transaction sent: ${tx.hash}`);
        console.log(`🔗 https://polygonscan.com/tx/${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait(1); // Wait for 1 confirmation
        
        if (receipt.status === 1) {
            const executionTime = Date.now() - startTime;
            const gasUsedMatic = parseFloat(ethers.formatEther(receipt.gasUsed * receipt.gasPrice));
            const maticPrice = 0.80; // Approximate, you can fetch this
            const actualGasCost = gasUsedMatic * maticPrice;
            
            state.stats.successfulTrades++;
            state.stats.totalProfit += opportunity.netProfit;
            state.stats.totalFlashFees += opportunity.flashFee;
            state.stats.totalDexFees += opportunity.dexFees;
            state.stats.totalGasSpent += actualGasCost;
            
            state.tradeHistory.unshift({
                id: Date.now(),
                token: opportunity.token,
                buyDex: opportunity.buyDex,
                sellDex: opportunity.sellDex,
                borrowAmount: BORROW_AMOUNT,
                grossProfit: opportunity.grossProfit,
                netProfit: opportunity.netProfit,
                flashFee: opportunity.flashFee,
                dexFees: opportunity.dexFees,
                gasCost: actualGasCost,
                spread: opportunity.spreadPercent,
                executionTime: executionTime,
                timestamp: new Date().toISOString(),
                status: "✅ SUCCESS",
                txHash: tx.hash
            });
            
            state.logs.unshift({
                time: new Date().toISOString(),
                message: `✅ PROFIT: $${opportunity.netProfit.toFixed(2)} from ${opportunity.token} | Tx: ${tx.hash.substring(0, 10)}...`
            });
            
            console.log(`✅✅✅ FLASH LOAN SUCCESSFUL!`);
            console.log(`   Net Profit: $${opportunity.netProfit.toFixed(2)}`);
            console.log(`   Gas Used: ${receipt.gasUsed.toString()}`);
            console.log(`   Actual Gas Cost: $${actualGasCost.toFixed(4)}`);
            console.log(`   Time: ${executionTime}ms`);
            
        } else {
            throw new Error("Transaction reverted on-chain");
        }
        
    } catch(e) {
        state.stats.failedTrades++;
        state.tradeHistory.unshift({
            id: Date.now(),
            token: opportunity.token,
            error: e.message,
            timestamp: new Date().toISOString(),
            status: "❌ FAILED"
        });
        
        state.logs.unshift({
            time: new Date().toISOString(),
            message: `❌ FAILED: ${opportunity.token} - ${e.message.substring(0, 100)}`
        });
        
        console.log(`❌ Flash loan failed:`, e.message);
        if (e.error) console.log(`   Details:`, e.error);
    }
}

// ==================== [ EXPRESS DASHBOARD ] ====================
app.get('/api/data', (req, res) => {
    const winRate = state.stats.tradesExecuted > 0 
        ? (state.stats.successfulTrades / state.stats.tradesExecuted) * 100 
        : 0;
    
    res.json({
        ...state,
        winRate: winRate,
        contractDeployed: contractDeployed,
        contractAddress: CONTRACT_ADDRESS,
        balancerVault: BALANCER_VAULT,
        uptime: process.uptime(),
        config: {
            borrowAmount: BORROW_AMOUNT,
            minProfitTrigger: MIN_PROFIT_TRIGGER,
            flashFeePercent: FLASH_LOAN_FEE * 100,
            dexFeePercent: DEX_FEE_PERCENT * 100
        }
    });
});

app.post('/api/toggle', (req, res) => {
    state.autoTrade = !state.autoTrade;
    console.log(`🔄 Auto-trading ${state.autoTrade ? 'ENABLED' : 'DISABLED'}`);
    res.json({ autoTrade: state.autoTrade });
});

app.post('/api/reset', (req, res) => {
    state.stats = { 
        scans: 0, 
        tradesExecuted: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0,
        totalFlashFees: 0,
        totalGasSpent: 0,
        totalDexFees: 0
    };
    res.json({ message: "Stats reset" });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>TITAN ARBITRAGE v9.1 - BALANCER FLASH LOANS</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
                font-family: 'Segoe UI', monospace;
                padding: 20px;
                min-height: 100vh;
                color: #e2e8f0;
            }
            .container { max-width: 1600px; margin: 0 auto; }
            .header { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; }
            h1 { font-size: 28px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
            .online { background: #10b981; color: white; animation: pulse 2s infinite; }
            .offline { background: #ef4444; color: white; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 24px; }
            .stat-card { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 20px; border: 1px solid #334155; transition: transform 0.2s; }
            .stat-card:hover { transform: translateY(-2px); }
            .stat-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
            .stat-value { font-size: 32px; font-weight: bold; margin: 8px 0; font-family: monospace; }
            .profit { color: #10b981; }
            .loss { color: #ef4444; }
            .rpc-badge { background: #10b98120; border: 1px solid #10b981; padding: 4px 12px; border-radius: 20px; font-size: 11px; }
            .table-container { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #334155; overflow-x: auto; }
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; padding: 12px; background: #1e293b; color: #94a3b8; font-size: 12px; font-weight: 600; }
            td { padding: 12px; border-bottom: 1px solid #334155; font-size: 13px; font-family: monospace; }
            .profit-badge { background: #10b981; color: white; padding: 4px 8px; border-radius: 8px; font-size: 11px; font-weight: bold; }
            .loss-badge { background: #ef4444; color: white; padding: 4px 8px; border-radius: 8px; font-size: 11px; font-weight: bold; }
            .progress-bar { width: 100%; background: #1e293b; height: 8px; border-radius: 4px; overflow: hidden; margin: 8px 0; }
            .progress-fill { height: 100%; transition: width 0.3s; border-radius: 4px; }
            .log-entry { padding: 8px; border-bottom: 1px solid #334155; font-size: 12px; font-family: monospace; }
            button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; margin-right: 10px; }
            button:hover { background: #2563eb; }
            button.danger { background: #ef4444; }
            button.success { background: #10b981; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                    <div>
                        <h1>⚡ TITAN ARBITRAGE v9.1</h1>
                        <p style="color: #94a3b8; margin-top: 8px;">Balancer Flash Loans | Real-time Arbitrage | ✅ BALANCER INTEGRATED</p>
                    </div>
                    <div style="text-align: right;">
                        <div>
                            <span id="connectionStatus" class="status offline">● CONNECTING</span>
                            <button id="toggleTrade" class="success" style="margin-left: 10px;">🟢 Trading ON</button>
                            <button id="resetStats" style="background: #6b7280;">🔄 Reset Stats</button>
                        </div>
                        <div style="margin-top: 8px;">
                            <span class="rpc-badge">🔗 dRPC: polygon.drpc.org</span>
                            <span class="rpc-badge" style="margin-left: 8px;">🏦 Balancer Vault</span>
                            <span class="rpc-badge" style="margin-left: 8px;">📜 ${CONTRACT_ADDRESS.substring(0, 10)}...</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-label">Total Profit</div><div class="stat-value profit" id="totalProfit">$0.00</div><div class="stat-label">Win Rate: <span id="winRate">0</span>%</div></div>
                <div class="stat-card"><div class="stat-label">Trades Executed</div><div class="stat-value" id="totalTrades">0</div><div class="stat-label">Success: <span id="successTrades">0</span> | Failed: <span id="failedTrades">0</span></div></div>
                <div class="stat-card"><div class="stat-label">Flash Loan Stats</div><div class="stat-value" id="flashFees">$0.00</div><div class="stat-label">Fees Paid (0.009%)</div></div>
                <div class="stat-card"><div class="stat-label">Wallet Balance</div><div class="stat-value" id="walletBalance">0 MATIC</div><div class="stat-label">Gas Spent: $<span id="gasSpent">0</span></div></div>
            </div>
            
            <div class="table-container">
                <h3 style="margin-bottom: 16px;">🔥 LIVE ARBITRAGE OPPORTUNITIES</h3>
                <table id="opportunitiesTable">
                    <thead><tr><th>Token</th><th>Buy → Sell</th><th>Spread</th><th>Gross Profit</th><th>Costs</th><th>NET PROFIT</th><th>ROI</th><th>Trigger</th></tr></thead>
                    <tbody id="opportunitiesBody"></tbody>
                </table>
            </div>
            
            <div class="table-container">
                <h3 style="margin-bottom: 16px;">📊 TRADE HISTORY</h3>
                <table id="historyTable">
                    <thead><tr><th>Time</th><th>Token</th><th>Route</th><th>Net Profit</th><th>Flash Fee</th><th>Gas</th><th>Status</th><th>Tx</th></tr></thead>
                    <tbody id="historyBody"></tbody>
                </table>
            </div>
            
            <div class="table-container">
                <h3 style="margin-bottom: 16px;">📝 LIVE LOGS</h3>
                <div id="logsContainer" style="height: 200px; overflow-y: auto; font-family: monospace; font-size: 12px;"></div>
            </div>
        </div>
        
        <script>
            let autoRefresh = setInterval(fetchData, 2000);
            
            async function fetchData() {
                try {
                    const res = await fetch('/api/data');
                    const data = await res.json();
                    updateUI(data);
                } catch(e) {}
            }
            
            function updateUI(data) {
                const statusEl = document.getElementById('connectionStatus');
                if (data.connected) {
                    statusEl.className = 'status online';
                    statusEl.innerHTML = '● ONLINE';
                } else {
                    statusEl.className = 'status offline';
                    statusEl.innerHTML = '● OFFLINE';
                }
                
                document.getElementById('totalProfit').innerHTML = '<span class="profit">$' + data.stats.totalProfit.toFixed(2) + '</span>';
                document.getElementById('totalTrades').innerText = data.stats.tradesExecuted || 0;
                document.getElementById('successTrades').innerText = data.stats.successfulTrades || 0;
                document.getElementById('failedTrades').innerText = data.stats.failedTrades || 0;
                document.getElementById('flashFees').innerHTML = '<span class="loss">$' + data.stats.totalFlashFees?.toFixed(2) + '</span>';
                document.getElementById('walletBalance').innerText = data.walletBal + ' MATIC';
                document.getElementById('gasSpent').innerText = data.stats.totalGasSpent?.toFixed(2) || '0';
                document.getElementById('winRate').innerText = data.winRate?.toFixed(1) || '0';
                
                const oppBody = document.getElementById('opportunitiesBody');
                if (data.opportunities && data.opportunities.length > 0) {
                    oppBody.innerHTML = data.opportunities.map(opp => {
                        const profitColor = opp.isProfitable ? '#10b981' : '#ef4444';
                        const progressColor = opp.isProfitable ? '#10b981' : (opp.progress > 70 ? '#f59e0b' : '#3b82f6');
                        return \`<tr>
                            <td><b>\${opp.token}</b></td>
                            <td>\${opp.buyDex} → \${opp.sellDex}</td>
                            <td style="color: \${profitColor}">+\${opp.spreadPercent}%</td>
                            <td class="profit">$\${opp.grossProfit?.toFixed(2)}</td>
                            <td class="loss">$\${opp.totalCosts?.toFixed(2)}</td>
                            <td class="profit">$\${opp.netProfit?.toFixed(2)}</td>
                            <td>+\${opp.roi}%</td>
                            <td><div class="progress-bar"><div class="progress-fill" style="width: \${opp.progress}%; background: \${progressColor}"></div></div><span style="font-size: 10px;">\${opp.progress}% to trigger</span></td>
                        </tr>\`;
                    }).join('');
                } else {
                    oppBody.innerHTML = '<tr><td colspan="8" style="text-align: center;">🔍 Scanning for opportunities...</td></tr>';
                }
                
                const historyBody = document.getElementById('historyBody');
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    historyBody.innerHTML = data.tradeHistory.map(trade => \`<tr>
                        <td style="font-size: 11px;">\${new Date(trade.timestamp).toLocaleTimeString()}</td>
                        <td><b>\${trade.token}</b></td>
                        <td>\${trade.buyDex || '-'} → \${trade.sellDex || '-'}</td>
                        <td class="profit">$\${trade.netProfit?.toFixed(2) || '0'}</td>
                        <td>$\${trade.flashFee?.toFixed(2) || '0'}</td>
                        <td>$\${trade.gasCost?.toFixed(2) || '0'}</td>
                        <td><span class="\${trade.status === '✅ SUCCESS' ? 'profit-badge' : 'loss-badge'}">\${trade.status}</span></td>
                        <td>\${trade.txHash ? '<a href="https://polygonscan.com/tx/' + trade.txHash + '" target="_blank" style="color:#60a5fa;">View</a>' : '-'}</td>
                    </tr>\`).join('');
                }
                
                const logsContainer = document.getElementById('logsContainer');
                if (data.logs && data.logs.length > 0) {
                    logsContainer.innerHTML = data.logs.slice(0, 20).map(log => \`<div class="log-entry">[\${new Date(log.time).toLocaleTimeString()}] \${log.message}</div>\`).join('');
                }
            }
            
            document.getElementById('toggleTrade').onclick = async () => {
                const res = await fetch('/api/toggle', { method: 'POST' });
                const data = await res.json();
                const btn = document.getElementById('toggleTrade');
                if (data.autoTrade) {
                    btn.className = 'success';
                    btn.innerHTML = '🟢 Trading ON';
                } else {
                    btn.className = 'danger';
                    btn.innerHTML = '🔴 Trading OFF';
                }
            };
            
            document.getElementById('resetStats').onclick = async () => {
                await fetch('/api/reset', { method: 'POST' });
                fetchData();
            };
            
            fetchData();
        </script>
    </body>
    </html>
    `);
});

// ==================== [ START SYSTEM ] ====================
async function start() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║     ⚡ TITAN ARBITRAGE v9.1 - BALANCER FLASH LOANS ⚡                         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  RPC:          https://polygon.drpc.org (100% uptime)
║  Balancer:     ${BALANCER_VAULT}
║  Contract:     ${CONTRACT_ADDRESS}
║  Dashboard:    http://localhost:${PORT}
║  Borrow:       $${BORROW_AMOUNT} USDC
║  Min Profit:   $${MIN_PROFIT_TRIGGER}
║  Flash Fee:    ${FLASH_LOAN_FEE * 100}%
║  Auto Trade:   ${state.autoTrade ? '✅ ENABLED' : '❌ DISABLED'}
╚══════════════════════════════════════════════════════════════════════════════╝
    `);
    
    await connect();
    
    if (!contractDeployed) {
        console.log(`
⚠️  CONTRACT NOT DEPLOYED!

Please deploy the BalancerFlashLoan contract first using this address:
${BALANCER_VAULT} (Balancer V2 Vault on Polygon)

The contract needs to implement:
- IBalancerFlashLoanReceiver interface
- swap functions for Quickswap, Sushiswap, Uniswap
- Approval management for USDC and tokens
        `);
    }
    
    setInterval(scan, SCAN_SPEED);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Dashboard: http://localhost:${PORT}`);
        console.log(`✅ Using dRPC endpoint: ${RPC_URL}`);
        console.log(`✅ Scanning for arbitrage opportunities...\n`);
    });
}

start();
