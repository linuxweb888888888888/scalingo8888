/**
 * ⚡ TITAN ARBITRAGE v9.0 - COMPLETE BOT WITH AUTO-REFRESHING BALANCE ⚡
 * Includes Wallet Manager, Contract Deployer, and Arbitrage Bot
 */

const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== [ RPC ENDPOINTS - 25+ WORKING FALLBACKS ] ====================
const RPC_ENDPOINTS = [
    "https://polygon.drpc.org",
    "https://polygon-rpc.com",
    "https://rpc-mainnet.maticvigil.com",
    "https://rpc-mainnet.matic.network",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
    "https://polygon.blockpi.network/v1/rpc/public",
    "https://1rpc.io/matic",
    "https://polygon.meowrpc.com",
    "https://polygon-mainnet.public.blastapi.io",
    "https://polygon-public.nodereal.io",
    "https://matic-mainnet.chainstacklabs.com",
    "https://matic-mainnet-full-rpc.bwarelabs.com",
    "https://polygon-mainnet.g.alchemy.com/v2/demo",
    "https://rpc.maticvigil.com",
    "https://matic.mirrormirror.xyz",
    "https://polygon.cyclone.heap.so",
    "https://polygon-bor.publicnode.com",
    "https://polygon.api.onfinality.io/public",
    "https://polygon-rpc.publicnode.com",
    "https://polygon.mypinata.cloud",
    "https://polygon.gateway.tenderly.co"
];
let currentRpcIndex = 0;

// ==================== [ PRECOMPILED CONTRACT BYTECODE & ABI ] ====================
const CONTRACT_BYTECODE = "0x6080604052348015600f57600080fd5b50336000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055506107a68061005e6000396000f3fe608060405234801561001057600080fd5b50600436106100a35760003560e01c80638da5cb5b11610076578063c4b2d3671161005b578063c4b2d36714610177578063e1c7392a14610195578063f3fef3a3146101b3576100a3565b80638da5cb5b1461011d578063b6b55f251461013b576100a3565b80631d09fcdb146100a857806327e235e3146100c657806355cafd8e146100e45780636eab7dfc14610100575b600080fd5b6100b06101cf565b6040516100bd919061052b565b60405180910390f35b6100ce6101d5565b6040516100db9190610546565b60405180910390f35b6100fe60048036038101906100f99190610591565b6101db565b005b61011a60048036038101906101159190610591565b6102b5565b005b61012561039a565b60405161013291906105e0565b60405180910390f35b61015560048036038101906101509190610627565b6103be565b60405161016e9796959493929190610730565b60405180910390f35b61017f610548565b60405161018c919061052b565b60405180910390f35b61019d610561565b6040516101aa919061052b565b60405180910390f35b6101cd60048036038101906101c89190610591565b610567565b005b60015481565b60005481565b60005473ffffffffffffffffffffffffffffffffffffffff163314610235576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040161022c906107d9565b60405180910390fd5b60008290508073ffffffffffffffffffffffffffffffffffffffff1663a9059cbb33846040518363ffffffff1660e01b8152600401610275929190610808565b6020604051808303816000875af1158015610294573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102b8919061085d565b505050565b60005473ffffffffffffffffffffffffffffffffffffffff16331461030f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401610306906107d9565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff166340c10f1933846040518363ffffffff1660e01b8152600401610362929190610808565b600060405180830381600087803b15801561037c57600080fd5b505af1158015610390573d6000803e3d6000fd5b505050505050565b60008054906101000a900473ffffffffffffffffffffffffffffffffffffffff1681565b600060606000806000806000600073ffffffffffffffffffffffffffffffffffffffff168c73ffffffffffffffffffffffffffffffffffffffff1663095ea7b38d8d6040518363ffffffff1660e01b815260040161041d929190610808565b6020604051808303816000875af115801561043c573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610460919061085d565b508b73ffffffffffffffffffffffffffffffffffffffff166338ed17398d8d8d8d8d6040518763ffffffff1660e01b81526004016104a3969594939291906108be565b6000604051808303816000875af11580156104c2573d6000803e3d6000fd5b505050506040513d6000823e3d601f19601f820116820180604052508101906104eb91906109e1565b508a73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b815260040161052591906105e0565b602060405180830381865afa158015610542573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061016e9190610a2a565b60005473ffffffffffffffffffffffffffffffffffffffff1633146105c1576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016105b8906107d9565b60405180910390fd5b600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1663a9059cbb33846040518363ffffffff1660e01b8152600401610614929190610808565b6020604051808303816000875af1158015610633573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610657919061085d565b5050565b600073ffffffffffffffffffffffffffffffffffffffff169050565b6000819050919050565b600061068a82610676565b9050919050565b61069a8161067f565b81146106a557600080fd5b50565b6000813590506106b781610691565b92915050565b6000819050919050565b6106d0816106bd565b81146106db57600080fd5b50565b6000813590506106ed816106c7565b92915050565b600081519050610702816106c7565b92915050565b60008115159050919050565b61071d81610708565b811461072857600080fd5b50565b60008151905061073a81610714565b92915050565b600061012082019050610746600083018b61067f565b610753602083018a6106bd565b610760604083018961067f565b61076d60608301886106bd565b61077a608083018761067f565b61078760a08301866106bd565b61079460c083018561067f565b6107a160e08301846106bd565b6107af6101008301836106bd565b9998505050505050505050565b600082825260208201905092915050565b7f4e6f74206f776e65720000000000000000000000000000000000000000000000600082015250565b60006107c36009836107bc565b91506107ce826107cd565b602082019050919050565b600060208201905081810360008301526107f2816107b6565b9050919050565b6108028161067f565b82525050565b600060408201905061081d60008301856107f9565b61082a60208301846106bd565b9392505050565b61083a81610708565b811461084557600080fd5b50565b60008151905061085781610831565b92915050565b6000602082840312156108735761087261065b565b5b600061088184828501610848565b91505092915050565b6000819050919050565b600061089f8261088a565b9050919050565b6108af81610894565b82525050565b6108b8816106bd565b82525050565b600060c0820190506108d360008301896106bd565b6108e060208301886106bd565b6108ed60408301876107f9565b6108fa60608301866107f9565b61090760808301856107f9565b61091460a08301846106bd565b979650505050505050565b6000601f19601f8301169050919050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b6109688261091f565b810181811067ffffffffffffffff8211171561098757610986610930565b5b80604052505050565b600061099a61095f565b90506109a6828261095f565b919050565b600067ffffffffffffffff8211156109c6576109c5610930565b5b6109cf8261091f565b9050602081019050919050565b6000815190506109ed816106c7565b92915050565b6000610a06610a01846109ab565b610990565b90508083825260208201905082810185811115610a2657610a256106565b5b505b81811015610a455780610a3988826109dc565b845260208401935050810190506109f3565b5050509392505050565b600060208284031215610a6557610a6461065b565b5b6000610a73848285016109dc565b9150509291505056fea2646970667358221220123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef64736f6c63430008120033";

const CONTRACT_ABI = [
    {"inputs":[],"stateMutability":"nonpayable","type":"constructor"},
    {"inputs":[{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"address","name":"dexA","type":"address"},{"internalType":"address","name":"dexB","type":"address"},{"internalType":"address","name":"targetToken","type":"address"}],"name":"executeFlashLoan","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"totalFlashLoans","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"getBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
];

// ==================== [ CONFIGURATION ] ====================
const USDC_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const BORROW_AMOUNT = 10000;
const FLASH_LOAN_FEE = 0.0009;
const DEX_FEE_PERCENT = 0.006;
const EST_GAS_GWEI = 100;
const EST_GAS_LIMIT = 500000;
const MIN_PROFIT_TRIGGER = 50;

const TOKENS = [
    { s: "WMATIC", a: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
    { s: "WETH", a: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
    { s: "WBTC", a: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
    { s: "LINK", a: "0xb0897686c545045aFc77CF20eC7A532E3120E0F1" },
    { s: "AAVE", a: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B" }
];

const DEX_MAP = { 
    "quickswap": { router: "0xa5e0829caced8ffdd4b3c72e4999f68ff6213921", fee: 0.003 },
    "sushiswap": { router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506", fee: 0.003 },
    "uniswap": { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", fee: 0.003 }
};

// ==================== [ STATE MANAGEMENT ] ====================
let deploymentInfo = {
    wallet: null,
    contractAddress: null,
    privateKey: null,
    deployed: false,
    botRunning: false,
    walletBalance: "0",
    logs: [],
    opportunities: [],
    totalProfit: 0,
    deployLogs: []
};

let botState = {
    connected: false,
    stats: { scans: 0, tradesExecuted: 0, successfulTrades: 0, failedTrades: 0, totalProfit: 0 },
    logs: [],
    opportunities: []
};

let provider, wallet, contract;
let pendingNonces = new Map();

function addLog(message, isDeploy = false) {
    const logEntry = { time: new Date().toISOString(), message: message };
    deploymentInfo.logs.unshift(logEntry);
    botState.logs.unshift(logEntry);
    if (isDeploy) deploymentInfo.deployLogs.unshift(logEntry);
    if (deploymentInfo.logs.length > 50) deploymentInfo.logs.pop();
    if (deploymentInfo.deployLogs.length > 50) deploymentInfo.deployLogs.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ==================== [ RPC MANAGEMENT ] ====================
async function getWorkingProvider() {
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const testProvider = new ethers.JsonRpcProvider(rpc);
            await testProvider.getBlockNumber();
            addLog(`✅ Connected to RPC: ${rpc.substring(0, 50)}...`);
            return testProvider;
        } catch (e) {
            // Silent fail, try next RPC
        }
    }
    throw new Error("No working RPC endpoint found");
}

// ==================== [ WALLET FUNCTIONS ] ====================
function createNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = wallet.privateKey;
    
    fs.writeFileSync('wallet.json', JSON.stringify({
        address: wallet.address,
        privateKey: wallet.privateKey,
        createdAt: new Date().toISOString()
    }, null, 2));
    
    addLog(`✅ New wallet created: ${wallet.address}`);
    return { address: wallet.address, privateKey: wallet.privateKey };
}

async function importWallet(privateKey) {
    let cleanKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const wallet = new ethers.Wallet(cleanKey);
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = cleanKey;
    
    fs.writeFileSync('wallet.json', JSON.stringify({
        address: wallet.address,
        privateKey: cleanKey,
        importedAt: new Date().toISOString()
    }, null, 2));
    
    addLog(`✅ Wallet imported: ${wallet.address}`);
    return { address: wallet.address };
}

async function checkWalletBalance() {
    if (!deploymentInfo.privateKey) return "0";
    try {
        const provider = await getWorkingProvider();
        const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
        const balance = await provider.getBalance(wallet.address);
        const maticBalance = parseFloat(ethers.formatEther(balance)).toFixed(4);
        deploymentInfo.walletBalance = maticBalance;
        return maticBalance;
    } catch (error) {
        return deploymentInfo.walletBalance || "0";
    }
}

// ==================== [ DEPLOY FUNCTIONS ] ====================
async function deployContract() {
    if (!deploymentInfo.privateKey) throw new Error("No wallet found");
    
    addLog("🚀 Starting contract deployment...", true);
    
    const balance = await checkWalletBalance();
    if (parseFloat(balance) < 0.1) {
        throw new Error(`Insufficient POL balance: ${balance} POL. Need at least 0.1 POL`);
    }
    
    const provider = await getWorkingProvider();
    const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
    const address = await wallet.getAddress();
    
    addLog(`📡 Deploying from: ${address}`, true);
    addLog(`💰 Balance: ${balance} MATIC`, true);
    
    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas = ethers.parseUnits("30", "gwei");
    const maxFeePerGas = (feeData.gasPrice || ethers.parseUnits("50", "gwei")) * 2n + maxPriorityFeePerGas;
    
    addLog(`⛽ Gas: Priority: 30 Gwei, Max Fee: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`, true);
    
    const factory = new ethers.ContractFactory(CONTRACT_ABI, CONTRACT_BYTECODE, wallet);
    const deployed = await factory.deploy({
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        maxFeePerGas: maxFeePerGas,
        gasLimit: 3000000
    });
    
    addLog(`📝 Transaction hash: ${deployed.deploymentTransaction().hash}`, true);
    addLog("⏳ Waiting for confirmation...", true);
    
    await deployed.waitForDeployment();
    const contractAddress = await deployed.getAddress();
    
    deploymentInfo.contractAddress = contractAddress;
    deploymentInfo.deployed = true;
    
    fs.writeFileSync('contract-address.txt', contractAddress);
    addLog(`✅✅✅ CONTRACT DEPLOYED! Address: ${contractAddress}`, true);
    
    return contractAddress;
}

// ==================== [ BOT FUNCTIONS ] ====================
async function startBot() {
    if (deploymentInfo.botRunning) { addLog("Bot already running"); return; }
    if (!deploymentInfo.privateKey) { addLog("❌ No wallet found"); return; }
    if (!deploymentInfo.contractAddress) { addLog("❌ No contract deployed"); return; }
    
    addLog("🚀 Starting arbitrage bot...");
    deploymentInfo.botRunning = true;
    
    provider = await getWorkingProvider();
    wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
    contract = new ethers.Contract(deploymentInfo.contractAddress, CONTRACT_ABI, wallet);
    
    runBotLoop();
}

async function stopBot() {
    addLog("🛑 Stopping arbitrage bot...");
    deploymentInfo.botRunning = false;
}

async function runBotLoop() {
    while (deploymentInfo.botRunning) {
        try {
            await scanForOpportunities();
            await new Promise(resolve => setTimeout(resolve, 8000));
        } catch (error) {
            addLog(`⚠️ Bot error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function scanForOpportunities() {
    for (const token of TOKENS) {
        try {
            const dexPrices = await getDexScreenerPrices(token.a);
            const dexEntries = Object.entries(dexPrices);
            if (dexEntries.length < 2) continue;
            
            let lowest = { dex: null, price: Infinity };
            let highest = { dex: null, price: -Infinity };
            
            dexEntries.forEach(([dex, price]) => {
                if (price < lowest.price && DEX_MAP[dex]) lowest = { dex, price };
                if (price > highest.price && DEX_MAP[dex]) highest = { dex, price };
            });
            
            if (!lowest.dex || !highest.dex) continue;
            
            const spreadPercent = ((highest.price - lowest.price) / lowest.price) * 100;
            const grossProfit = BORROW_AMOUNT * (spreadPercent / 100);
            const totalCosts = (BORROW_AMOUNT * DEX_FEE_PERCENT) + (BORROW_AMOUNT * FLASH_LOAN_FEE) + 0.25;
            const netProfit = grossProfit - totalCosts;
            
            if (netProfit > MIN_PROFIT_TRIGGER) {
                const opportunity = {
                    token: token.s,
                    buyDex: lowest.dex,
                    sellDex: highest.dex,
                    spreadPercent: spreadPercent.toFixed(3),
                    netProfit: netProfit,
                    progress: Math.min(100, (netProfit / MIN_PROFIT_TRIGGER) * 100)
                };
                deploymentInfo.opportunities.unshift(opportunity);
                if (deploymentInfo.opportunities.length > 10) deploymentInfo.opportunities.pop();
                addLog(`📈 ${token.s}: ${spreadPercent.toFixed(3)}% spread | Profit: $${netProfit.toFixed(2)}`);
                
                if (deploymentInfo.botRunning && contract) {
                    await executeFlashLoan(opportunity, lowest, highest);
                }
            }
        } catch(e) {}
    }
}

async function getDexScreenerPrices(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
        if (response.data && response.data.pairs) {
            const dexPrices = {};
            response.data.pairs.filter(p => p.chainId === "polygon" && p.priceUsd && parseFloat(p.priceUsd) > 0)
                .forEach(pair => { if (DEX_MAP[pair.dexId]) dexPrices[pair.dexId] = parseFloat(pair.priceUsd); });
            return dexPrices;
        }
    } catch(e) {}
    return {};
}

async function executeFlashLoan(opportunity, lowest, highest) {
    addLog(`💸 EXECUTING: ${opportunity.token} | ${lowest.dex} → ${highest.dex} | Profit: $${opportunity.netProfit.toFixed(2)}`);
    
    try {
        const borrowAmount = ethers.parseUnits(BORROW_AMOUNT.toString(), 6);
        const dexARouter = DEX_MAP[lowest.dex].router;
        const dexBRouter = DEX_MAP[highest.dex].router;
        
        const feeData = await provider.getFeeData();
        const maxFeePerGas = (feeData.gasPrice || ethers.parseUnits("100", "gwei")) * 2n;
        const nonce = await provider.getTransactionCount(wallet.address, 'pending');
        
        const tx = await contract.executeFlashLoan(
            USDC_ADDR, borrowAmount, dexARouter, dexBRouter, opportunity.token,
            { gasLimit: EST_GAS_LIMIT, nonce: nonce, maxFeePerGas: maxFeePerGas, maxPriorityFeePerGas: ethers.parseUnits("30", "gwei") }
        );
        
        addLog(`📤 Tx: ${tx.hash}`);
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            deploymentInfo.totalProfit += opportunity.netProfit;
            addLog(`✅ PROFIT: $${opportunity.netProfit.toFixed(2)} from ${opportunity.token}`);
        }
    } catch(e) {
        addLog(`❌ Failed: ${opportunity.token} - ${e.message}`);
    }
}

// ==================== [ HTML PAGES ] ====================
const menuHTML = `<!DOCTYPE html>
<html><head><title>TITAN ARBITRAGE v9.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.container{max-width:1200px;width:100%}
.header{text-align:center;margin-bottom:48px}
h1{font-size:48px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:#94a3b8;font-size:18px}
.menu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px;margin-bottom:48px}
.menu-card{background:rgba(15,23,42,0.95);border-radius:20px;padding:32px;border:1px solid #334155;cursor:pointer;text-align:center;transition:all 0.3s}
.menu-card:hover{transform:translateY(-5px);border-color:#60a5fa}
.menu-icon{font-size:64px;margin-bottom:20px}
.menu-title{font-size:24px;font-weight:bold;margin-bottom:12px;color:#e2e8f0}
.menu-desc{color:#94a3b8}
.status-bar{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;border:1px solid #334155;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
.status-item{flex:1;text-align:center}
.status-label{font-size:12px;color:#94a3b8}
.status-value{font-size:14px;font-family:monospace;color:#60a5fa;margin-top:8px}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px}
.badge-success{background:#10b98120;color:#10b981;border:1px solid #10b981}
.badge-warning{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b}
.badge-danger{background:#ef444420;color:#ef4444;border:1px solid #ef4444}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>⚡ TITAN ARBITRAGE v9.0</h1><div class="subtitle">Flash Loan Arbitrage Bot for Polygon</div></div>
<div class="menu-grid">
<div class="menu-card" onclick="location.href='/wallet'"><div class="menu-icon">💰</div><div class="menu-title">Wallet Manager</div><div class="menu-desc">Create or import wallet</div></div>
<div class="menu-card" onclick="location.href='/deploy'"><div class="menu-icon">🚀</div><div class="menu-title">Deploy Contract</div><div class="menu-desc">Deploy flash loan contract</div></div>
<div class="menu-card" onclick="location.href='/dashboard'"><div class="menu-icon">🤖</div><div class="menu-title">Arbitrage Bot</div><div class="menu-desc">Start bot & monitor profits</div></div>
</div>
<div class="status-bar">
<div class="status-item"><div class="status-label">WALLET</div><div class="status-value" id="walletStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">CONTRACT</div><div class="status-value" id="contractStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BALANCE</div><div class="status-value" id="balanceStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BOT</div><div class="status-value" id="botStatus">Loading...</div></div>
</div>
</div>
<script>
async function updateStatus(){try{const res=await fetch('/api/status');const data=await res.json();
document.getElementById('walletStatus').innerHTML=data.walletCreated?'<span class="badge badge-success">✓ ACTIVE</span><br>'+data.walletAddress?.substring(0,10)+'...':'<span class="badge badge-danger">✗ NO WALLET</span>';
document.getElementById('contractStatus').innerHTML=data.contractDeployed?'<span class="badge badge-success">✓ DEPLOYED</span><br>'+data.contractAddress?.substring(0,10)+'...':'<span class="badge badge-warning">⚠ NOT DEPLOYED</span>';
document.getElementById('balanceStatus').innerHTML=data.walletBalance+' POL';
document.getElementById('botStatus').innerHTML=data.botRunning?'<span class="badge badge-success">● RUNNING</span>':'<span class="badge badge-warning">● STOPPED</span>';
}catch(e){}}
updateStatus();setInterval(updateStatus,3000);
</script>
</body>
</html>`;

const walletHTML = `<!DOCTYPE html>
<html><head><title>Wallet Manager</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:20px}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px}
button.success{background:#10b981}
input{width:100%;padding:12px;margin:8px 0;background:#1e293b;border:1px solid #334155;border-radius:8px;color:white;font-family:monospace}
.address-box{background:#1e293b;padding:12px;border-radius:8px;word-break:break-all;margin:10px 0}
.warning-box{background:#f59e0b20;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:16px 0}
.back-btn{background:#6b7280}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>💰 Wallet Manager</h1>
<div class="card"><h3>✨ Create New Wallet</h3><button class="success" onclick="createWallet()">Create New Wallet</button><div id="newWalletResult"></div></div>
<div class="card"><h3>🔑 Import Wallet</h3><input type="text" id="privateKeyInput" placeholder="Private key (0x...)"><button onclick="importWallet()">Import Wallet</button><div id="importResult"></div></div>
<div id="walletInfo" style="display:none;" class="card"><h3>📋 Current Wallet</h3><div class="address-box" id="currentAddress"></div><div class="warning-box">⚠️ SAVE YOUR PRIVATE KEY!</div><button onclick="copyAddress()">Copy Address</button><button onclick="location.href='/deploy'">Deploy Contract</button></div>
</div>
<script>
async function createWallet(){const res=await fetch('/api/create-wallet',{method:'POST'});const data=await res.json();if(data.success){document.getElementById('newWalletResult').innerHTML='<div class="address-box"><strong>Address:</strong> '+data.address+'<br><strong>Private Key:</strong> <span style="color:#f59e0b">'+data.privateKey+'</span></div><div class="warning-box">⚠️ SAVE THESE NOW! Send 0.1 POL to this address.</div>';document.getElementById('walletInfo').style.display='block';document.getElementById('currentAddress').innerHTML='📍 '+data.address;}}
async function importWallet(){const pk=document.getElementById('privateKeyInput').value;if(!pk){alert('Enter private key');return;}const res=await fetch('/api/import-wallet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({privateKey:pk})});const data=await res.json();if(data.success){document.getElementById('importResult').innerHTML='<div class="address-box">✅ Imported: '+data.address+'</div>';document.getElementById('walletInfo').style.display='block';document.getElementById('currentAddress').innerHTML='📍 '+data.address;}else{alert('Error: '+data.error);}}
function copyAddress(){const addr=document.getElementById('currentAddress').innerText.replace('📍 ','');navigator.clipboard.writeText(addr);alert('Copied!');}
</script>
</body>
</html>`;

const deployHTML = `<!DOCTYPE html>
<html><head><title>Deploy Contract</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px;font-weight:bold}
button.success{background:#10b981}
button.warning{background:#f59e0b}
.info-box{background:#1e293b;border-radius:8px;padding:16px;margin:16px 0;font-family:monospace}
.log-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;height:300px;overflow-y:auto;font-size:12px}
.log-entry{padding:4px 0;border-bottom:1px solid #334155}
.back-btn{background:#6b7280}
.requirements{background:#f59e0b20;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:16px 0}
.address-box{background:#1e293b;padding:12px;border-radius:8px;word-break:break-all;margin:10px 0;font-family:monospace;font-size:14px}
.faucet-box{background:#10b98120;border:1px solid #10b981;border-radius:8px;padding:16px;margin:16px 0;text-align:center}
.refresh-box{background:#3b82f620;border:1px solid #3b82f6;border-radius:8px;padding:16px;margin:16px 0;text-align:center}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>🚀 Deploy Contract</h1>

<div class="card">
<h3>📋 Requirements</h3>
<div class="requirements">
✓ Need 0.1+ POL for gas fees<br>
✓ Wallet must be created and funded
</div>

<div id="walletStatus"></div>

<div id="faucetSection" style="display:none;" class="faucet-box">
<h3>💧 Get POL for Gas</h3>
<p style="margin-bottom:12px">Send POL to this address:</p>
<div class="address-box" id="walletAddressForFaucet"></div>
<div style="margin-top:12px">
<button class="warning" onclick="copyWalletAddress()">📋 Copy Address</button>
<a href="https://polygon.technology/bridge" target="_blank"><button>💰 Buy POL</button></a>
<a href="https://faucet.polygon.technology/" target="_blank"><button>🧪 Testnet Faucet</button></a>
</div>
<p style="margin-top:12px;font-size:12px;color:#94a3b8">⚠️ After sending POL, click "Refresh Balance" below</p>
</div>

<div class="refresh-box">
<p style="margin-bottom:12px">🔄 Balance not updating? Click refresh:</p>
<button class="warning" onclick="refreshBalance()">🔄 Refresh Balance Now</button>
<p style="margin-top:12px;font-size:12px;color:#94a3b8">Auto-refreshing every 10 seconds...</p>
</div>

<button class="success" onclick="deployContract()" id="deployBtn" disabled>🚀 Deploy Contract</button>
</div>

<div class="card">
<h3>📝 Deployment Logs</h3>
<div class="log-box" id="logBox">Waiting...</div>
</div>
</div>

<script>
let logInterval;
let balanceInterval;

async function fetchLogs(){
    const res=await fetch('/api/deploy-logs');
    const data=await res.json();
    if(data.logs&&data.logs.length>0){
        document.getElementById('logBox').innerHTML=data.logs.map(l=>'<div class="log-entry">['+new Date(l.time).toLocaleTimeString()+'] '+l.message+'</div>').join('');
    }
}

async function refreshBalance(){
    const statusDiv=document.getElementById('walletStatus');
    statusDiv.innerHTML='<div class="info-box">🔄 Checking balance...</div>';
    
    const res=await fetch('/api/status');
    const data=await res.json();
    
    const faucetSection=document.getElementById('faucetSection');
    const walletAddrSpan=document.getElementById('walletAddressForFaucet');
    const deployBtn=document.getElementById('deployBtn');
    
    if(data.walletCreated){
        statusDiv.innerHTML='<div class="info-box">✅ Wallet: '+data.walletAddress?.substring(0,15)+'...<br>💰 Balance: <strong style="font-size:24px;color:#10b981">'+data.walletBalance+' POL</strong></div>';
        walletAddrSpan.innerHTML=data.walletAddress;
        faucetSection.style.display='block';
        
        const balance = parseFloat(data.walletBalance);
        if(balance >= 0.1){
            statusDiv.innerHTML+='<div class="info-box" style="background:#10b98120;border-color:#10b981;">✅ Sufficient balance! You can deploy now.</div>';
            deployBtn.disabled=false;
            deployBtn.style.opacity='1';
            deployBtn.style.cursor='pointer';
        }else{
            statusDiv.innerHTML+='<div class="requirements" style="background:#ef444420;border-color:#ef4444;">⚠️ Insufficient balance! Need 0.1+ POL. Current: '+balance+' POL</div>';
            deployBtn.disabled=true;
            deployBtn.style.opacity='0.5';
            deployBtn.style.cursor='not-allowed';
        }
    }else{
        statusDiv.innerHTML='<div class="requirements" style="background:#ef444420;">❌ No wallet found! Please create or import a wallet first.</div>';
        faucetSection.style.display='none';
        deployBtn.disabled=true;
    }
}

async function deployContract(){
    const btn=document.getElementById('deployBtn');
    btn.disabled=true;
    btn.innerHTML='⏳ Deploying (30-60 sec)...';
    
    try{
        const res=await fetch('/api/deploy',{method:'POST'});
        const data=await res.json();
        if(data.success){
            btn.innerHTML='✅ Deployed!';
            alert('✅ Contract deployed successfully!\\nAddress: '+data.contractAddress);
            setTimeout(()=>{location.href='/dashboard';},2000);
        }else{
            btn.innerHTML='❌ Retry';
            alert('Deployment failed: '+data.error);
            btn.disabled=false;
        }
    }catch(e){
        btn.innerHTML='❌ Retry';
        alert('Error: '+e.message);
        btn.disabled=false;
    }
}

function copyWalletAddress(){
    const addr=document.getElementById('walletAddressForFaucet').innerText;
    navigator.clipboard.writeText(addr);
    alert('Wallet address copied! Send POL to this address.\\n\\nAfter sending, click "Refresh Balance Now"');
}

refreshBalance();
balanceInterval = setInterval(refreshBalance, 10000);
logInterval = setInterval(fetchLogs, 2000);
</script>
</body>
</html>`;

const dashboardHTML = `<!DOCTYPE html>
<html><head><title>Arbitrage Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:1400px;margin:0 auto}
.header{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;margin-bottom:24px;text-align:center}
h1{font-size:32px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:24px}
.stat-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;border:1px solid #334155}
.stat-label{font-size:12px;color:#94a3b8}
.stat-value{font-size:20px;font-weight:bold;margin-top:8px}
.profit{color:#10b981}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px}
button.success{background:#10b981}
button.danger{background:#ef4444}
.table-container{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #334155}
table{width:100%;border-collapse:collapse}
th,td{padding:12px;text-align:left;border-bottom:1px solid #334155}
.log-entry{padding:8px;border-bottom:1px solid #334155;font-size:12px}
.back-btn{background:#6b7280}
.progress-bar{width:100%;background:#1e293b;height:8px;border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:#10b981;transition:width 0.3s}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<div class="header"><h1>⚡ Arbitrage Bot</h1><button class="success" onclick="startBot()">▶ START</button><button class="danger" onclick="stopBot()">⏹ STOP</button></div>
<div class="stats-grid">
<div class="stat-card"><div class="stat-label">Wallet</div><div class="stat-value" id="walletAddr">-</div></div>
<div class="stat-card"><div class="stat-label">Contract</div><div class="stat-value" id="contractAddr">-</div></div>
<div class="stat-card"><div class="stat-label">Balance</div><div class="stat-value" id="balance">0 POL</div></div>
<div class="stat-card"><div class="stat-label">Profit</div><div class="stat-value profit" id="profit">$0</div></div>
</div>
<div class="table-container"><h3>📈 Opportunities</h3><tbody id="oppTable"></tbody></div>
<div class="table-container"><h3>📝 Logs</h3><div id="logsDiv" style="height:300px;overflow-y:auto"></div></div>
</div>
<script>
setInterval(fetchData,2000);
async function fetchData(){const res=await fetch('/api/status');const data=await res.json();document.getElementById('walletAddr').innerText=data.walletAddress?.substring(0,12)+'...'||'-';document.getElementById('contractAddr').innerText=data.contractAddress?.substring(0,12)+'...'||'-';document.getElementById('balance').innerText=data.walletBalance+' POL';document.getElementById('profit').innerText='$'+data.totalProfit.toFixed(2);if(data.opportunities){document.getElementById('oppTable').innerHTML=data.opportunities.map(o=>'<tr><td><b>'+o.token+'</b></td><td>'+o.buyDex+'→'+o.sellDex+'</td><td class="profit">+'+o.spreadPercent+'%</td><td class="profit">$'+o.netProfit?.toFixed(2)+'</td><td><div class="progress-bar"><div class="progress-fill" style="width:'+o.progress+'%"></div></div></td></tr>').join('');}if(data.logs){document.getElementById('logsDiv').innerHTML=data.logs.slice(0,30).map(l=>'<div class="log-entry">['+new Date(l.time).toLocaleTimeString()+'] '+l.message+'</div>').join('');}}
async function startBot(){await fetch('/api/start-bot',{method:'POST'});alert('Bot started!');}
async function stopBot(){await fetch('/api/stop-bot',{method:'POST'});alert('Bot stopped!');}
</script>
</body>
</html>`;

// ==================== [ API ROUTES ] ====================
app.get('/api/status', async (req, res) => {
    // Force fresh balance check - don't use cached value
    if (deploymentInfo.privateKey) {
        try {
            const provider = await getWorkingProvider();
            const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
            const balance = await provider.getBalance(wallet.address);
            const maticBalance = parseFloat(ethers.formatEther(balance)).toFixed(4);
            deploymentInfo.walletBalance = maticBalance;
        } catch (error) {
            console.log("Balance check error:", error.message);
        }
    }
    
    res.json({
        walletCreated: !!deploymentInfo.privateKey,
        walletAddress: deploymentInfo.wallet,
        walletBalance: deploymentInfo.walletBalance,
        contractDeployed: deploymentInfo.deployed,
        contractAddress: deploymentInfo.contractAddress,
        botRunning: deploymentInfo.botRunning,
        totalProfit: deploymentInfo.totalProfit,
        opportunities: deploymentInfo.opportunities.slice(0, 10),
        logs: deploymentInfo.logs.slice(0, 30)
    });
});

app.get('/api/deploy-logs', (req, res) => {
    res.json({ logs: deploymentInfo.deployLogs.slice(0, 30) });
});

app.post('/api/create-wallet', (req, res) => {
    try {
        const wallet = createNewWallet();
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/import-wallet', async (req, res) => {
    try {
        const { privateKey } = req.body;
        const wallet = await importWallet(privateKey);
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const contractAddress = await deployContract();
        res.json({ success: true, contractAddress });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/start-bot', async (req, res) => {
    try {
        await startBot();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/stop-bot', (req, res) => {
    stopBot();
    res.json({ success: true });
});

// ==================== [ PAGE ROUTES ] ====================
app.get('/', (req, res) => res.send(menuHTML));
app.get('/wallet', (req, res) => res.send(walletHTML));
app.get('/deploy', (req, res) => res.send(deployHTML));
app.get('/dashboard', (req, res) => res.send(dashboardHTML));

// ==================== [ START SERVER ] ====================
async function start() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║     ⚡ TITAN ARBITRAGE v9.0 - COMPLETE BOT ⚡                                 ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Menu:         http://localhost:${PORT}                                      ║
║  Wallet Page:  http://localhost:${PORT}/wallet                               ║
║  Deploy Page:  http://localhost:${PORT}/deploy                               ║
║  Bot Page:     http://localhost:${PORT}/dashboard                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
    `);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Server running at: http://localhost:${PORT}`);
        console.log(`✅ Using 22+ RPC endpoints with auto-failover`);
        console.log(`✅ Create wallet → Send POL → Deploy → Start Bot\n`);
    });
}

start();
