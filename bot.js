/**
 * ⚡ TITAN ARBITRAGE v9.0 - COMPLETE WEB INTERFACE ⚡
 * With Wallet Generator & Contract Deployer
 */

const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== [ RPC ENDPOINTS ] ====================
const RPC_ENDPOINTS = [
    "https://polygon-rpc.com",
    "https://rpc-mainnet.maticvigil.com",
    "https://rpc-mainnet.matic.network",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
    "https://polygon.blockpi.network/v1/rpc/public",
    "https://1rpc.io/matic",
    "https://polygon.drpc.org"
];

// ==================== [ CONTRACT SOURCE CODE ] ====================
const CONTRACT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IDexRouter {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

contract TitanFlashLoanArbitrage {
    IBalancerVault public constant VAULT = IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address public owner;
    uint256 public totalFlashLoans;
    
    constructor() {
        owner = msg.sender;
    }
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    function executeFlashLoan(address token, uint256 amount, address dexA, address dexB, address targetToken) external onlyOwner {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        bytes memory userData = abi.encode(dexA, dexB, targetToken);
        VAULT.flashLoan(address(this), tokens, amounts, userData);
    }
    
    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external {
        require(msg.sender == address(VAULT), "Not vault");
        (address dexA, address dexB, address targetToken) = abi.decode(userData, (address, address, address));
        address usdc = tokens[0];
        uint256 flashAmount = amounts[0];
        uint256 flashFee = feeAmounts[0];
        uint256 debtAmount = flashAmount + flashFee;
        
        IERC20(usdc).approve(dexA, flashAmount);
        address[] memory path1 = new address[](2);
        path1[0] = usdc;
        path1[1] = targetToken;
        IDexRouter(dexA).swapExactTokensForTokens(flashAmount, 0, path1, address(this), block.timestamp + 300);
        
        uint256 tokenBalance = IERC20(targetToken).balanceOf(address(this));
        IERC20(targetToken).approve(dexB, tokenBalance);
        address[] memory path2 = new address[](2);
        path2[0] = targetToken;
        path2[1] = usdc;
        IDexRouter(dexB).swapExactTokensForTokens(tokenBalance, debtAmount, path2, address(this), block.timestamp + 300);
        
        IERC20(usdc).approve(address(VAULT), debtAmount);
        totalFlashLoans++;
    }
    
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }
    
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
`;

// Store deployment info
let deploymentInfo = {
    wallet: null,
    contractAddress: null,
    privateKey: null,
    mnemonic: null,
    deployed: false,
    botRunning: false,
    botProcess: null,
    walletBalance: "0",
    logs: [],
    opportunities: [],
    totalProfit: 0
};

// Bot state
let botState = {
    connected: false,
    stats: {
        scans: 0,
        tradesExecuted: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0
    },
    logs: [],
    opportunities: []
};

// ==================== [ BOT FUNCTIONS ] ====================
async function startBot() {
    if (deploymentInfo.botRunning) {
        addLog("Bot already running");
        return;
    }
    
    if (!deploymentInfo.privateKey) {
        addLog("❌ No wallet found. Please create or import a wallet first.");
        return;
    }
    
    if (!deploymentInfo.contractAddress) {
        addLog("❌ No contract deployed. Please deploy the contract first.");
        return;
    }
    
    addLog("🚀 Starting arbitrage bot...");
    deploymentInfo.botRunning = true;
    
    // Start bot in background
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
    if (!deploymentInfo.privateKey) return;
    
    botState.stats.scans++;
    
    const TOKENS = [
        { s: "WMATIC", a: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270" },
        { s: "WETH", a: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
        { s: "WBTC", a: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
        { s: "LINK", a: "0xb0897686c545045aFc77CF20eC7A532E3120E0F1" },
        { s: "AAVE", a: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B" }
    ];
    
    const DEX_MAP = {
        "quickswap": "0xa5e0829caced8ffdd4b3c72e4999f68ff6213921",
        "sushiswap": "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
        "uniswap": "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    };
    
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
            const netProfit = 10000 * (spreadPercent / 100) - 80.90;
            
            if (netProfit > 5) {
                const opportunity = {
                    token: token.s,
                    buyDex: lowest.dex,
                    sellDex: highest.dex,
                    spreadPercent: spreadPercent.toFixed(3),
                    netProfit: netProfit,
                    progress: Math.min(100, (netProfit / 50) * 100)
                };
                
                botState.opportunities.unshift(opportunity);
                deploymentInfo.opportunities = botState.opportunities.slice(0, 10);
                addLog(`📈 ${token.s}: ${spreadPercent.toFixed(3)}% spread | Profit: $${netProfit.toFixed(2)}`);
            }
            
        } catch(e) {}
    }
}

async function getDexScreenerPrices(tokenAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
            timeout: 5000
        });
        
        if (response.data && response.data.pairs) {
            const pairs = response.data.pairs.filter(p => 
                p.chainId === "polygon" && p.priceUsd && parseFloat(p.priceUsd) > 0
            );
            
            const dexPrices = {};
            pairs.forEach(pair => {
                const dexId = pair.dexId;
                if (!dexPrices[dexId] || parseFloat(pair.priceUsd) > dexPrices[dexId]) {
                    dexPrices[dexId] = parseFloat(pair.priceUsd);
                }
            });
            return dexPrices;
        }
    } catch(e) {}
    return {};
}

function addLog(message) {
    const logEntry = {
        time: new Date().toISOString(),
        message: message
    };
    deploymentInfo.logs.unshift(logEntry);
    botState.logs.unshift(logEntry);
    if (deploymentInfo.logs.length > 50) deploymentInfo.logs.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ==================== [ WALLET FUNCTIONS ] ====================
function createNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = wallet.privateKey;
    deploymentInfo.mnemonic = wallet.mnemonic.phrase;
    
    // Save wallet to file
    const walletData = {
        address: wallet.address,
        privateKey: wallet.privateKey,
        mnemonic: wallet.mnemonic.phrase,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync('wallet.json', JSON.stringify(walletData, null, 2));
    
    addLog(`✅ New wallet created: ${wallet.address}`);
    return walletData;
}

async function importWallet(privateKey) {
    try {
        let cleanKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
        const wallet = new ethers.Wallet(cleanKey);
        deploymentInfo.wallet = wallet.address;
        deploymentInfo.privateKey = cleanKey;
        deploymentInfo.mnemonic = null;
        
        const walletData = {
            address: wallet.address,
            privateKey: cleanKey,
            importedAt: new Date().toISOString()
        };
        fs.writeFileSync('wallet.json', JSON.stringify(walletData, null, 2));
        
        addLog(`✅ Wallet imported: ${wallet.address}`);
        return walletData;
    } catch (error) {
        throw new Error(`Invalid private key: ${error.message}`);
    }
}

async function checkWalletBalance() {
    if (!deploymentInfo.privateKey) return "0";
    
    try {
        const provider = new ethers.JsonRpcProvider(RPC_ENDPOINTS[0]);
        const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
        const balance = await provider.getBalance(wallet.address);
        const maticBalance = parseFloat(ethers.formatEther(balance)).toFixed(4);
        deploymentInfo.walletBalance = maticBalance;
        return maticBalance;
    } catch (error) {
        return "0";
    }
}

// ==================== [ DEPLOY FUNCTIONS ] ====================
async function deployContract() {
    if (!deploymentInfo.privateKey) {
        throw new Error("No wallet found. Please create or import a wallet first.");
    }
    
    addLog("🔨 Compiling contract...");
    
    // Compile contract
    const input = {
        language: 'Solidity',
        sources: { 'Titan.sol': { content: CONTRACT_SOURCE } },
        settings: { 
            outputSelection: { '*': { '*': ['*'] } }, 
            optimizer: { enabled: true, runs: 200 } 
        }
    };
    
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    
    if (output.errors) {
        for (const err of output.errors) {
            if (err.severity === 'error') {
                throw new Error(`Compilation error: ${err.formattedMessage}`);
            }
        }
    }
    
    const contract = output.contracts['Titan.sol']['TitanFlashLoanArbitrage'];
    
    // Find working RPC
    addLog("🔍 Finding working RPC endpoint...");
    let provider = null;
    let workingRpc = null;
    
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const testProvider = new ethers.JsonRpcProvider(rpc);
            await testProvider.getBlockNumber();
            provider = testProvider;
            workingRpc = rpc;
            addLog(`✅ Using RPC: ${rpc.substring(0, 50)}...`);
            break;
        } catch (e) {}
    }
    
    if (!provider) throw new Error("No working RPC endpoint found");
    
    const wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
    const address = await wallet.getAddress();
    
    addLog(`📡 Deploying from: ${address}`);
    
    const balance = await provider.getBalance(address);
    addLog(`💰 Balance: ${ethers.formatEther(balance)} MATIC`);
    
    if (balance < ethers.parseEther("0.05")) {
        throw new Error(`Insufficient MATIC. Balance: ${ethers.formatEther(balance)} MATIC (need 0.05+)`);
    }
    
    // Get gas prices
    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas = ethers.parseUnits("30", "gwei");
    const maxFeePerGas = (feeData.gasPrice || ethers.parseUnits("50", "gwei")).mul(2).add(maxPriorityFeePerGas);
    
    addLog(`⛽ Gas Settings: Max Priority: 30 Gwei, Max Fee: ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei`);
    
    addLog("🚀 Deploying contract...");
    
    const factory = new ethers.ContractFactory(contract.abi, contract.evm.bytecode.object, wallet);
    const deployTransaction = factory.getDeployTransaction();
    const estimatedGas = await provider.estimateGas(deployTransaction);
    const gasLimit = estimatedGas.mul(12).div(10);
    
    const deployed = await factory.deploy({
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        maxFeePerGas: maxFeePerGas,
        gasLimit: gasLimit
    });
    
    addLog(`📝 Transaction hash: ${deployed.deploymentTransaction().hash}`);
    addLog("⏳ Waiting for confirmation...");
    
    await deployed.waitForDeployment();
    const contractAddress = await deployed.getAddress();
    
    deploymentInfo.contractAddress = contractAddress;
    deploymentInfo.deployed = true;
    
    // Save deployment info
    const deployData = {
        contractAddress: contractAddress,
        deployer: address,
        transactionHash: deployed.deploymentTransaction().hash,
        timestamp: new Date().toISOString()
    };
    fs.writeFileSync('deployment-info.json', JSON.stringify(deployData, null, 2));
    fs.writeFileSync('contract-address.txt', contractAddress);
    
    addLog(`✅✅✅ CONTRACT DEPLOYED! Address: ${contractAddress}`);
    
    return contractAddress;
}

// ==================== [ HTML PAGES ] ====================

// Menu Page HTML
const menuHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>TITAN ARBITRAGE v9.0 - Menu</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
            font-family: 'Segoe UI', monospace;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container { max-width: 1200px; width: 100%; }
        .header { text-align: center; margin-bottom: 48px; }
        h1 { font-size: 48px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 16px; }
        .subtitle { color: #94a3b8; font-size: 18px; }
        .menu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; margin-bottom: 48px; }
        .menu-card { 
            background: rgba(15, 23, 42, 0.95); 
            border-radius: 20px; 
            padding: 32px; 
            border: 1px solid #334155;
            transition: transform 0.2s, border-color 0.2s;
            cursor: pointer;
            text-align: center;
        }
        .menu-card:hover { 
            transform: translateY(-5px); 
            border-color: #60a5fa;
        }
        .menu-icon { font-size: 64px; margin-bottom: 20px; }
        .menu-title { font-size: 24px; font-weight: bold; margin-bottom: 12px; color: #e2e8f0; }
        .menu-desc { color: #94a3b8; font-size: 14px; line-height: 1.5; }
        .status-bar {
            background: rgba(15, 23, 42, 0.95);
            border-radius: 16px;
            padding: 20px;
            border: 1px solid #334155;
            display: flex;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 16px;
        }
        .status-item { flex: 1; text-align: center; }
        .status-label { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
        .status-value { font-size: 14px; font-family: monospace; color: #60a5fa; word-break: break-all; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
        .badge-success { background: #10b98120; color: #10b981; border: 1px solid #10b981; }
        .badge-warning { background: #f59e0b20; color: #f59e0b; border: 1px solid #f59e0b; }
        .badge-danger { background: #ef444420; color: #ef4444; border: 1px solid #ef4444; }
        button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; margin-top: 16px; }
        button:hover { background: #2563eb; }
        @media (max-width: 768px) { .menu-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚡ TITAN ARBITRAGE v9.0</h1>
            <div class="subtitle">Flash Loan Arbitrage Bot for Polygon Network</div>
        </div>
        
        <div class="menu-grid">
            <div class="menu-card" onclick="location.href='/wallet'">
                <div class="menu-icon">💰</div>
                <div class="menu-title">Wallet Manager</div>
                <div class="menu-desc">Create new wallet or import existing one. Save your private key securely.</div>
            </div>
            
            <div class="menu-card" onclick="location.href='/deploy'">
                <div class="menu-icon">🚀</div>
                <div class="menu-title">Deploy Contract</div>
                <div class="menu-desc">Deploy the Balancer Flash Loan contract to Polygon network.</div>
            </div>
            
            <div class="menu-card" onclick="location.href='/dashboard'">
                <div class="menu-icon">🤖</div>
                <div class="menu-title">Arbitrage Bot</div>
                <div class="menu-desc">Start the automated arbitrage bot and monitor profits.</div>
            </div>
        </div>
        
        <div class="status-bar">
            <div class="status-item">
                <div class="status-label">WALLET</div>
                <div class="status-value" id="walletStatus">Loading...</div>
            </div>
            <div class="status-item">
                <div class="status-label">CONTRACT</div>
                <div class="status-value" id="contractStatus">Loading...</div>
            </div>
            <div class="status-item">
                <div class="status-label">BALANCE</div>
                <div class="status-value" id="balanceStatus">Loading...</div>
            </div>
            <div class="status-item">
                <div class="status-label">BOT STATUS</div>
                <div class="status-value" id="botStatus">Loading...</div>
            </div>
        </div>
    </div>
    
    <script>
        async function updateStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                const walletEl = document.getElementById('walletStatus');
                if (data.walletCreated) {
                    walletEl.innerHTML = '<span class="status-badge badge-success">✓ ACTIVE</span><br>' + data.walletAddress?.substring(0, 10) + '...';
                } else {
                    walletEl.innerHTML = '<span class="status-badge badge-danger">✗ NOT SETUP</span><br>Create wallet first';
                }
                
                const contractEl = document.getElementById('contractStatus');
                if (data.contractDeployed) {
                    contractEl.innerHTML = '<span class="status-badge badge-success">✓ DEPLOYED</span><br>' + data.contractAddress?.substring(0, 10) + '...';
                } else {
                    contractEl.innerHTML = '<span class="status-badge badge-warning">⚠ NOT DEPLOYED</span><br>Deploy contract';
                }
                
                const balanceEl = document.getElementById('balanceStatus');
                balanceEl.innerHTML = data.walletBalance + ' POL';
                
                const botEl = document.getElementById('botStatus');
                if (data.botRunning) {
                    botEl.innerHTML = '<span class="status-badge badge-success">● RUNNING</span><br>Profit: $' + data.totalProfit.toFixed(2);
                } else {
                    botEl.innerHTML = '<span class="status-badge badge-warning">● STOPPED</span><br>Start from dashboard';
                }
            } catch(e) {}
        }
        
        updateStatus();
        setInterval(updateStatus, 3000);
    </script>
</body>
</html>
`;

// Wallet Page HTML
const walletHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Wallet Manager - Titan Arbitrage</title>
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
        .container { max-width: 800px; margin: 0 auto; }
        .header { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; text-align: center; }
        h1 { font-size: 28px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .card { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; border: 1px solid #334155; margin-bottom: 20px; }
        button { background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 8px; }
        button:hover { background: #2563eb; }
        button.success { background: #10b981; }
        button.warning { background: #f59e0b; }
        input, textarea { width: 100%; padding: 12px; margin: 8px 0; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: white; font-family: monospace; }
        label { font-size: 12px; color: #94a3b8; margin-top: 10px; display: block; }
        .warning-box { background: #f59e0b20; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin: 16px 0; }
        .address-box { font-family: monospace; background: #1e293b; padding: 12px; border-radius: 8px; word-break: break-all; margin: 10px 0; }
        .flex { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
        .back-btn { background: #6b7280; margin-bottom: 20px; }
        .back-btn:hover { background: #4b5563; }
    </style>
</head>
<body>
    <div class="container">
        <button class="back-btn" onclick="location.href='/'">← Back to Menu</button>
        
        <div class="header">
            <h1>💰 Wallet Manager</h1>
            <p>Create a new wallet or import an existing one</p>
        </div>
        
        <div class="card">
            <h3>✨ Create New Wallet</h3>
            <p style="color: #94a3b8; margin: 12px 0;">Generate a fresh Polygon wallet</p>
            <button class="success" onclick="createWallet()">Create New Wallet</button>
            <div id="newWalletResult"></div>
        </div>
        
        <div class="card">
            <h3>🔑 Import Existing Wallet</h3>
            <p style="color: #94a3b8; margin: 12px 0;">Enter your private key to import an existing wallet</p>
            <label>Private Key (with or without 0x)</label>
            <input type="text" id="privateKeyInput" placeholder="0x... or just the hex string">
            <button onclick="importWallet()">Import Wallet</button>
            <div id="importResult"></div>
        </div>
        
        <div class="card" id="walletInfo" style="display:none;">
            <h3>📋 Current Wallet</h3>
            <div class="address-box" id="currentAddress"></div>
            <div class="warning-box">
                ⚠️ <strong>IMPORTANT:</strong> Save your private key and mnemonic phrase!<br>
                Never share them with anyone. Store them securely offline.
            </div>
            <div class="flex">
                <button onclick="copyAddress()">📋 Copy Address</button>
                <button onclick="location.href='/deploy'">🚀 Deploy Contract</button>
            </div>
        </div>
    </div>
    
    <script>
        async function createWallet() {
            const resultDiv = document.getElementById('newWalletResult');
            resultDiv.innerHTML = '<p style="color: #f59e0b;">⏳ Creating wallet...</p>';
            
            try {
                const res = await fetch('/api/create-wallet', { method: 'POST' });
                const data = await res.json();
                
                if (data.success) {
                    resultDiv.innerHTML = \`
                        <div class="address-box">
                            <strong>📍 Address:</strong> \${data.address}<br>
                            <strong>🔑 Private Key:</strong> <span style="color: #f59e0b;">\${data.privateKey}</span><br>
                            <strong>🔐 Mnemonic:</strong> <span style="color: #f59e0b;">\${data.mnemonic}</span>
                        </div>
                        <div class="warning-box">
                            ⚠️ <strong>SAVE THESE NOW!</strong> You won't see them again!<br>
                            Send at least 0.1 POL to this address for gas fees.
                        </div>
                    \`;
                    document.getElementById('walletInfo').style.display = 'block';
                    document.getElementById('currentAddress').innerHTML = \`📍 \${data.address}\`;
                    loadWalletInfo();
                }
            } catch(e) {
                resultDiv.innerHTML = '<p style="color: #ef4444;">❌ Error creating wallet</p>';
            }
        }
        
        async function importWallet() {
            const privateKey = document.getElementById('privateKeyInput').value;
            const resultDiv = document.getElementById('importResult');
            
            if (!privateKey) {
                resultDiv.innerHTML = '<p style="color: #ef4444;">❌ Please enter a private key</p>';
                return;
            }
            
            resultDiv.innerHTML = '<p style="color: #f59e0b;">⏳ Importing wallet...</p>';
            
            try {
                const res = await fetch('/api/import-wallet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ privateKey: privateKey })
                });
                const data = await res.json();
                
                if (data.success) {
                    resultDiv.innerHTML = \`<div class="address-box">✅ Wallet imported! Address: \${data.address}</div>\`;
                    document.getElementById('walletInfo').style.display = 'block';
                    document.getElementById('currentAddress').innerHTML = \`📍 \${data.address}\`;
                    loadWalletInfo();
                } else {
                    resultDiv.innerHTML = \`<p style="color: #ef4444;">❌ \${data.error}</p>\`;
                }
            } catch(e) {
                resultDiv.innerHTML = '<p style="color: #ef4444;">❌ Error importing wallet</p>';
            }
        }
        
        async function loadWalletInfo() {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (data.walletCreated) {
                document.getElementById('walletInfo').style.display = 'block';
                document.getElementById('currentAddress').innerHTML = \`📍 \${data.walletAddress}\`;
            }
        }
        
        function copyAddress() {
            const address = document.getElementById('currentAddress').innerText.replace('📍 ', '');
            navigator.clipboard.writeText(address);
            alert('Address copied to clipboard!');
        }
        
        loadWalletInfo();
    </script>
</body>
</html>
`;

// Deploy Page HTML
const deployHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Deploy Contract - Titan Arbitrage</title>
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
        .container { max-width: 800px; margin: 0 auto; }
        .header { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; text-align: center; }
        h1 { font-size: 28px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .card { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; border: 1px solid #334155; margin-bottom: 20px; }
        button { background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 8px; }
        button:hover { background: #2563eb; }
        button.success { background: #10b981; }
        button.warning { background: #f59e0b; }
        .info-box { background: #1e293b; border-radius: 8px; padding: 16px; margin: 16px 0; font-family: monospace; }
        .log-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; }
        .log-entry { padding: 4px 0; border-bottom: 1px solid #334155; }
        .back-btn { background: #6b7280; margin-bottom: 20px; }
        .back-btn:hover { background: #4b5563; }
        .requirements { background: #f59e0b20; border: 1px solid #f59e0b; border-radius: 8px; padding: 16px; margin: 16px 0; }
    </style>
</head>
<body>
    <div class="container">
        <button class="back-btn" onclick="location.href='/'">← Back to Menu</button>
        
        <div class="header">
            <h1>🚀 Deploy Flash Loan Contract</h1>
            <p>Deploy TitanFlashLoanArbitrage to Polygon Network</p>
        </div>
        
        <div class="card" id="deployCard">
            <h3>📋 Requirements</h3>
            <div class="requirements">
                ✓ Wallet with at least 0.1 POL for gas fees<br>
                ✓ Private key imported or wallet created<br>
                ✓ Active internet connection
            </div>
            
            <div id="walletStatus"></div>
            
            <button class="success" onclick="deployContract()" id="deployBtn">🚀 Deploy Contract</button>
            <button onclick="location.href='/wallet'">💰 Manage Wallet</button>
        </div>
        
        <div class="card" id="resultCard" style="display:none;">
            <h3>📊 Deployment Result</h3>
            <div id="deployResult"></div>
        </div>
        
        <div class="card">
            <h3>📝 Deployment Logs</h3>
            <div class="log-box" id="logBox">
                <div class="log-entry">Waiting for deployment...</div>
            </div>
        </div>
    </div>
    
    <script>
        let logInterval;
        
        async function checkWallet() {
            const res = await fetch('/api/status');
            const data = await res.json();
            const statusDiv = document.getElementById('walletStatus');
            
            if (data.walletCreated) {
                statusDiv.innerHTML = \`<div class="info-box">✅ Wallet ready: \${data.walletAddress?.substring(0, 15)}...<br>Balance: \${data.walletBalance} POL</div>\`;
                if (parseFloat(data.walletBalance) < 0.1) {
                    statusDiv.innerHTML += \`<div class="requirements" style="background: #ef444420; border-color: #ef4444;">⚠️ Low balance! Need at least 0.1 POL for gas. Send POL to your wallet address.</div>\`;
                }
            } else {
                statusDiv.innerHTML = '<div class="requirements" style="background: #ef444420; border-color: #ef4444;">❌ No wallet found! Please create or import a wallet first.</div>';
                document.getElementById('deployBtn').disabled = true;
            }
        }
        
        async function fetchLogs() {
            const res = await fetch('/api/deploy-logs');
            const data = await res.json();
            const logBox = document.getElementById('logBox');
            if (data.logs && data.logs.length > 0) {
                logBox.innerHTML = data.logs.map(log => \`<div class="log-entry">[\${new Date(log.time).toLocaleTimeString()}] \${log.message}</div>\`).join('');
            }
        }
        
        async function deployContract() {
            const deployBtn = document.getElementById('deployBtn');
            deployBtn.disabled = true;
            deployBtn.innerHTML = '⏳ Deploying...';
            
            const resultDiv = document.getElementById('deployResult');
            document.getElementById('resultCard').style.display = 'block';
            resultDiv.innerHTML = '<div class="info-box" style="color: #f59e0b;">⏳ Deploying contract. This may take 30-60 seconds...</div>';
            
            try {
                const res = await fetch('/api/deploy', { method: 'POST' });
                const data = await res.json();
                
                if (data.success) {
                    resultDiv.innerHTML = \`
                        <div class="info-box" style="background: #10b98120; border-color: #10b981;">
                            ✅ <strong>CONTRACT DEPLOYED SUCCESSFULLY!</strong><br><br>
                            📫 <strong>Contract Address:</strong> <span style="color: #60a5fa;">\${data.contractAddress}</span><br>
                            🔗 <a href="https://polygonscan.com/address/\${data.contractAddress}" target="_blank" style="color: #60a5fa;">View on Polygonscan</a><br>
                            📝 <strong>Transaction:</strong> <a href="https://polygonscan.com/tx/\${data.txHash}" target="_blank" style="color: #60a5fa;">\${data.txHash?.substring(0, 20)}...</a>
                        </div>
                    \`;
                    deployBtn.innerHTML = '✅ Deployed!';
                    setTimeout(() => { location.href = '/dashboard'; }, 3000);
                } else {
                    resultDiv.innerHTML = \`<div class="info-box" style="background: #ef444420; border-color: #ef4444;">❌ Deployment failed: \${data.error}</div>\`;
                    deployBtn.disabled = false;
                    deployBtn.innerHTML = '🚀 Retry Deployment';
                }
            } catch(e) {
                resultDiv.innerHTML = \`<div class="info-box" style="background: #ef444420; border-color: #ef4444;">❌ Error: \${e.message}</div>\`;
                deployBtn.disabled = false;
                deployBtn.innerHTML = '🚀 Deploy Contract';
            }
        }
        
        checkWallet();
        logInterval = setInterval(fetchLogs, 2000);
        setInterval(checkWallet, 5000);
    </script>
</body>
</html>
`;

// Dashboard HTML (main bot interface)
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>TITAN ARBITRAGE v9.0 - Dashboard</title>
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
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 24px; margin-bottom: 24px; border: 1px solid #334155; text-align: center; }
        h1 { font-size: 32px; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; }
        .online { background: #10b981; color: white; }
        .offline { background: #ef4444; color: white; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 24px; }
        .stat-card { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 20px; border: 1px solid #334155; }
        .stat-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
        .stat-value { font-size: 24px; font-weight: bold; margin: 8px 0; font-family: monospace; }
        .profit { color: #10b981; }
        .button-group { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; margin-top: 16px; }
        button { background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; transition: all 0.2s; }
        button:hover { background: #2563eb; transform: translateY(-1px); }
        button.danger { background: #ef4444; }
        button.danger:hover { background: #dc2626; }
        button.success { background: #10b981; }
        button.success:hover { background: #059669; }
        .table-container { background: rgba(15, 23, 42, 0.95); border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid #334155; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 12px; background: #1e293b; color: #94a3b8; font-size: 12px; font-weight: 600; }
        td { padding: 12px; border-bottom: 1px solid #334155; font-size: 13px; font-family: monospace; }
        .log-entry { padding: 8px; border-bottom: 1px solid #334155; font-size: 12px; font-family: monospace; }
        .progress-bar { width: 100%; background: #1e293b; height: 8px; border-radius: 4px; overflow: hidden; }
        .progress-fill { height: 100%; transition: width 0.3s; border-radius: 4px; background: #10b981; }
        .back-btn { background: #6b7280; margin-bottom: 20px; }
        .back-btn:hover { background: #4b5563; }
    </style>
</head>
<body>
    <div class="container">
        <button class="back-btn" onclick="location.href='/'">← Back to Menu</button>
        
        <div class="header">
            <h1>⚡ TITAN ARBITRAGE v9.0</h1>
            <p>Balancer Flash Loans | Real-time Arbitrage Bot</p>
            <div class="button-group">
                <button id="startBotBtn" class="success" onclick="startBot()">▶ Start Bot</button>
                <button id="stopBotBtn" class="danger" onclick="stopBot()">⏹ Stop Bot</button>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Wallet</div>
                <div class="stat-value" id="walletAddress">Not loaded</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Contract</div>
                <div class="stat-value" id="contractAddress">Not deployed</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Balance</div>
                <div class="stat-value" id="walletBalance">0 POL</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Total Profit</div>
                <div class="stat-value profit" id="totalProfit">$0.00</div>
            </div>
        </div>

        <div class="table-container">
            <h3 style="margin-bottom: 16px;">🔥 LIVE ARBITRAGE OPPORTUNITIES</h3>
            <table>
                <thead><tr><th>Token</th><th>Buy → Sell</th><th>Spread</th><th>NET PROFIT</th><th>Trigger</th></tr></thead>
                <tbody id="opportunitiesBody"><tr><td colspan="5" style="text-align: center;">Waiting for bot to start...</td></tr></tbody>
            </table>
        </div>

        <div class="table-container">
            <h3 style="margin-bottom: 16px;">📝 LIVE LOGS</h3>
            <div id="logsContainer" style="height: 300px; overflow-y: auto;"></div>
        </div>
    </div>

    <script>
        let autoRefresh = setInterval(fetchData, 2000);
        
        async function fetchData() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                updateUI(data);
            } catch(e) {}
        }
        
        function updateUI(data) {
            document.getElementById('walletAddress').innerText = data.walletAddress ? data.walletAddress.substring(0, 15) + '...' : 'Not created';
            document.getElementById('contractAddress').innerText = data.contractAddress ? data.contractAddress.substring(0, 15) + '...' : 'Not deployed';
            document.getElementById('walletBalance').innerText = data.walletBalance + ' POL';
            document.getElementById('totalProfit').innerHTML = '$' + data.totalProfit.toFixed(2);
            
            if (data.opportunities && data.opportunities.length > 0) {
                document.getElementById('opportunitiesBody').innerHTML = data.opportunities.map(opp => \`
                    <tr>
                        <td><b>\${opp.token}</b></td>
                        <td>\${opp.buyDex} → \${opp.sellDex}</td>
                        <td style="color: #10b981">+\${opp.spreadPercent}%</td>
                        <td style="color: #10b981">$\${opp.netProfit?.toFixed(2)}</td>
                        <td><div class="progress-bar"><div class="progress-fill" style="width: \${opp.progress}%"></div></div></td>
                    </tr>
                \`).join('');
            }
            
            if (data.logs && data.logs.length > 0) {
                document.getElementById('logsContainer').innerHTML = data.logs.slice(0, 20).map(log => \`<div class="log-entry">[\${new Date(log.time).toLocaleTimeString()}] \${log.message}</div>\`).join('');
            }
        }
        
        async function startBot() {
            const res = await fetch('/api/start-bot', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Bot started!');
            } else {
                alert('Error: ' + data.error);
            }
        }
        
        async function stopBot() {
            const res = await fetch('/api/stop-bot', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                alert('Bot stopped!');
            }
        }
        
        fetchData();
    </script>
</body>
</html>
`;

// ==================== [ API ROUTES ] ====================

// Status API
app.get('/api/status', async (req, res) => {
    const balance = await checkWalletBalance();
    res.json({
        walletCreated: !!deploymentInfo.privateKey,
        walletAddress: deploymentInfo.wallet,
        walletBalance: balance,
        contractDeployed: deploymentInfo.deployed,
        contractAddress: deploymentInfo.contractAddress,
        botRunning: deploymentInfo.botRunning,
        totalProfit: deploymentInfo.totalProfit,
        opportunities: deploymentInfo.opportunities.slice(0, 10),
        logs: deploymentInfo.logs.slice(0, 20)
    });
});

// Create wallet API
app.post('/api/create-wallet', async (req, res) => {
    try {
        const wallet = createNewWallet();
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Import wallet API
app.post('/api/import-wallet', async (req, res) => {
    try {
        const { privateKey } = req.body;
        const wallet = await importWallet(privateKey);
        res.json({ success: true, ...wallet });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Deploy contract API
app.post('/api/deploy', async (req, res) => {
    try {
        const contractAddress = await deployContract();
        res.json({ success: true, contractAddress });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Start bot API
app.post('/api/start-bot', async (req, res) => {
    try {
        await startBot();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Stop bot API
app.post('/api/stop-bot', async (req, res) => {
    await stopBot();
    res.json({ success: true });
});

// Deploy logs API
app.get('/api/deploy-logs', (req, res) => {
    res.json({ logs: deploymentInfo.logs.slice(0, 30) });
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
║     ⚡ TITAN ARBITRAGE v9.0 - COMPLETE WEB INTERFACE ⚡                      ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Dashboard:    http://localhost:${PORT}                                      ║
║  Wallet Page:  http://localhost:${PORT}/wallet                               ║
║  Deploy Page:  http://localhost:${PORT}/deploy                               ║
║  Bot Page:     http://localhost:${PORT}/dashboard                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
    `);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ Server running at: http://localhost:${PORT}`);
        console.log(`✅ Open this URL in your browser to get started!\n`);
    });
}

start();
