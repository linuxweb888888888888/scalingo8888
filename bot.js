// ==================== [ Imports & Setup ] ====================
const express = require('express');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const solc = require('solc');

// Correct provider import and custom provider class
const { JsonRpcProvider, Network } = require('ethers');

class FastJsonRpcProvider extends JsonRpcProvider {
    constructor(url, network, options) {
        super(url, network, options);
    }
    async _detectNetwork() {
        return Network.from(137); // Polygon mainnet
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== [ RPC & Delay Setup ] ====================
const RPC_ENDPOINTS = [
    "https://cosmopolitan-muddy-dew.matic.quiknode.pro/45b8f7a71d2385208254951a496c78fb94b9676d/"
];

const RPC_CONNECTION_DELAY = 30000;
let initialDelayDone = false;

// ==================== [ Contract Compilation ] ====================
const CONTRACT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts);
}

contract BalancerFlashLoanArbitrage {
    address public owner;
    uint256 public totalFlashLoans;
    uint256 public totalProfit;
    
    IBalancerVault public constant VAULT = IBalancerVault(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address public constant USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    receive() external payable {}
    
    function executeFlashLoan(address token, uint256 amount, address dexA, address dexB, address targetToken) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        totalFlashLoans++;
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        bytes memory userData = abi.encode(dexA, dexB, targetToken, amount);
        IERC20(token).approve(address(VAULT), amount);
        VAULT.flashLoan(address(this), tokens, amounts, userData);
    }
    
    function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external {
        require(msg.sender == address(VAULT), "Only Vault");
        (address dexA, address dexB, address targetToken, uint256 borrowAmount) = abi.decode(userData, (address, address, address, uint256));
        uint256 borrowAmountWithFee = amounts[0] + feeAmounts[0];
        address token = tokens[0];
        IERC20(token).approve(dexA, amounts[0]);
        address[] memory path1 = new address[](2);
        path1[0] = token;
        path1[1] = targetToken;
        uint256[] memory amounts1 = IUniswapV2Router(dexA).swapExactTokensForTokens(amounts[0], 1, path1, address(this), block.timestamp + 300);
        uint256 targetTokenAmount = amounts1[1];
        require(targetTokenAmount > 0, "Swap 1 failed");
        IERC20(targetToken).approve(dexB, targetTokenAmount);
        address[] memory path2 = new address[](2);
        path2[0] = targetToken;
        path2[1] = token;
        uint256[] memory amounts2 = IUniswapV2Router(dexB).swapExactTokensForTokens(targetTokenAmount, 1, path2, address(this), block.timestamp + 300);
        uint256 finalTokenAmount = amounts2[1];
        require(finalTokenAmount > 0, "Swap 2 failed");
        require(finalTokenAmount >= borrowAmountWithFee, "Insufficient repayment");
        uint256 profit = finalTokenAmount - borrowAmountWithFee;
        if (profit > 0) {
            totalProfit += profit;
            IERC20(token).transfer(owner, profit);
        }
    }
    
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(amount <= balance, "Insufficient balance");
        IERC20(token).transfer(owner, amount);
    }
    function withdrawAllTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner, balance);
        }
    }
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner).transfer(balance);
        }
    }
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}`;

// Compile contract
function compileContract() {
    const input = {
        language: 'Solidity',
        sources: {
            'BalancerFlashLoanArbitrage.sol': { content: CONTRACT_SOURCE }
        },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { '*': { '*': ['*'] } }
        }
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    if (output.errors) {
        for (const error of output.errors) {
            if (error.severity === 'error') {
                console.error("❌ Compilation error:", error.formattedMessage);
                throw new Error(`Compilation failed: ${error.formattedMessage}`);
            }
        }
    }
    const contractFile = output.contracts['BalancerFlashLoanArbitrage.sol']['BalancerFlashLoanArbitrage'];
    return {
        bytecode: '0x' + contractFile.evm.bytecode.object,
        abi: contractFile.abi
    };
}

// Compile at startup
const COMPILED_CONTRACT = compileContract();
let CONTRACT_BYTECODE = COMPILED_CONTRACT.bytecode;
let CONTRACT_ABI = COMPILED_CONTRACT.abi;
fs.writeFileSync('contract-abi.json', JSON.stringify(CONTRACT_ABI, null, 2));

// ==================== [ State Management ] ====================
let state = {
    connected: false,
    rpc: RPC_ENDPOINTS[0],
    walletBal: "0.00",
    autoTrade: true,
    stats: {
        scans: 0,
        tradesExecuted: 0,
        successfulTrades: 0,
        failedTrades: 0,
        totalProfit: 0,
        totalGasSpent: 0,
        totalDexFees: 0
    },
    logs: [],
    opportunities: [],
    tradeHistory: [],
    pendingFlash: null,
    pendingTransactions: [],
    discoveryStats: null
};

let deploymentInfo = {
    wallet: null,
    contractAddress: null,
    privateKey: null,
    deployed: false,
    botRunning: false,
    walletBalance: "0"
};

let provider, wallet, contract;
let contractDeployed = false;
let activeExecutions = new Map();

// ==================== [ Logging Function ] ====================
function addLog(message) {
    const logEntry = {
        time: new Date().toISOString(),
        message: message
    };
    state.logs.unshift(logEntry);
    if (state.logs.length > 50) state.logs.pop();
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// ==================== [ RPC Provider with delay ] ====================
async function getWorkingProvider(retryCount = 0) {
    if (!initialDelayDone) {
        addLog(`⏳ Waiting ${RPC_CONNECTION_DELAY / 1000} seconds before connecting to RPC...`);
        initialDelayDone = true;
        await new Promise(resolve => setTimeout(resolve, RPC_CONNECTION_DELAY));
    }
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const testProvider = new FastJsonRpcProvider(rpc, 137);
            await Promise.race([
                testProvider.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
            ]);
            addLog(`✅ Connected to RPC: ${rpc.substring(0, 50)}...`);
            return testProvider;
        } catch (e) {}
    }
    if (retryCount < 3) {
        addLog(`⚠️ No working RPC, retrying in 10s (${retryCount + 1}/3)...`);
        await new Promise(res => setTimeout(res, 10000));
        return getWorkingProvider(retryCount + 1);
    }
    throw new Error("No working RPC found");
}

// ==================== [ Wallet Management ] ====================
function createNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    deploymentInfo.wallet = wallet.address;
    deploymentInfo.privateKey = wallet.privateKey;
    fs.writeFileSync('wallet.json', JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey, createdAt: new Date().toISOString() }, null, 2));
    addLog(`✅ Wallet created: ${wallet.address}`);
    return { address: wallet.address, privateKey: wallet.privateKey };
}

async function importWallet(pk) {
    let cleanKey = pk.startsWith('0x') ? pk : '0x' + pk;
    const walletInstance = new ethers.Wallet(cleanKey);
    deploymentInfo.wallet = walletInstance.address;
    deploymentInfo.privateKey = cleanKey;
    fs.writeFileSync('wallet.json', JSON.stringify({ address: walletInstance.address, privateKey: cleanKey, importedAt: new Date().toISOString() }, null, 2));
    addLog(`✅ Wallet imported: ${walletInstance.address}`);
    return { address: walletInstance.address };
}

async function checkWalletBalance() {
    if (!deploymentInfo.privateKey) return "0";
    try {
        const provider = await getWorkingProvider();
        const walletInstance = new ethers.Wallet(deploymentInfo.privateKey, provider);
        const balance = await provider.getBalance(walletInstance.address);
        const maticBalance = parseFloat(ethers.formatEther(balance)).toFixed(4);
        deploymentInfo.walletBalance = maticBalance;
        return maticBalance;
    } catch (e) {
        addLog(`⚠️ Balance check error: ${e.message}`);
        return deploymentInfo.walletBalance || "0";
    }
}

// ==================== [ Contract Deployment & Import ] ====================
async function deployContract() {
    if (!deploymentInfo.privateKey) throw new Error("No wallet");
    addLog("🚀 Starting contract deployment...");
    const provider = await getWorkingProvider();
    const walletInstance = new ethers.Wallet(deploymentInfo.privateKey, provider);
    const address = await walletInstance.getAddress();

    // Check balance
    const balance = await checkWalletBalance();
    addLog(`💰 Wallet balance: ${balance} MATIC`);
    if (parseFloat(balance) < 0.05) throw new Error("Insufficient POL to deploy");

    // Gas info
    const feeData = await provider.getFeeData();
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("30", "gwei");
    const maxFeePerGas = feeData.maxFeePerGas || ethers.parseUnits("60", "gwei");
    const gasLimit = 3000000;
    const estimatedCost = parseFloat(ethers.formatUnits(maxFeePerGas * BigInt(gasLimit), "ether")).toFixed(4);
    addLog(`⛽ Gas limit: ${gasLimit} | Estimated cost: ~${estimatedCost} MATIC`);

    if (parseFloat(balance) < parseFloat(estimatedCost))
        throw new Error(`Insufficient balance for deployment`);

    const factory = new ethers.ContractFactory(CONTRACT_ABI, CONTRACT_BYTECODE, walletInstance);
    const deployed = await factory.deploy({
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit
    });
    const tx = deployed.deploymentTransaction();
    addLog(`📝 Deployment tx hash: ${tx.hash}`);
    addLog(`🔗 View: https://polygonscan.com/tx/${tx.hash}`);

    // Wait for confirmation
    let receipt = null;
    for (let i = 0; i < 180; i++) {
        await new Promise(res => setTimeout(res, 2000));
        receipt = await provider.getTransactionReceipt(tx.hash);
        if (receipt) break;
        if (i % 5 === 0) addLog(`⏳ Waiting for confirmation... (${i * 2}s)`);
    }
    if (!receipt || receipt.status !== 1) throw new Error("Deployment failed");
    const contractAddress = receipt.contractAddress;
    deploymentInfo.contractAddress = contractAddress;
    deploymentInfo.deployed = true;
    contractDeployed = true;
    fs.writeFileSync('contract-address.txt', contractAddress);
    addLog(`✅ Contract deployed at: ${contractAddress}`);
    return contractAddress;
}

async function importContract(address) {
    const provider = await getWorkingProvider();
    const code = await provider.getCode(address);
    if (!code || code === '0x') throw new Error("No code at address");
    deploymentInfo.contractAddress = address;
    deploymentInfo.deployed = true;
    contractDeployed = true;
    fs.writeFileSync('contract-address.txt', address);
    addLog(`✅ Contract imported: ${address}`);
    return address;
}

// ==================== [ Connect & Initialize ] ====================
async function connect() {
    try {
        provider = await getWorkingProvider();
        const block = await provider.getBlockNumber();
        state.connected = true;
        console.log(`✅ Connected to Polygon (block ${block})`);
        if (deploymentInfo.privateKey) {
            wallet = new ethers.Wallet(deploymentInfo.privateKey, provider);
            const balance = await provider.getBalance(wallet.address);
            state.walletBal = parseFloat(ethers.formatEther(balance)).toFixed(4);
            console.log(`Wallet: ${wallet.address}`);
            console.log(`Balance: ${state.walletBal} MATIC`);
            if (deploymentInfo.contractAddress) {
                const code = await provider.getCode(deploymentInfo.contractAddress);
                if (code && code !== '0x') {
                    contract = new ethers.Contract(deploymentInfo.contractAddress, CONTRACT_ABI, wallet);
                    contractDeployed = true;
                    console.log(`Contract at ${deploymentInfo.contractAddress} loaded`);
                }
            }
        }
    } catch (e) {
        console.log('Connection error:', e.message);
        state.connected = false;
    }
}

// ==================== [ HTML Pages ] ====================
const menuHTML = `<!DOCTYPE html>
<html><head><title>TITAN ARBITRAGE v9.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.container{max-width:1200px;width:100%}
.header{text-align:center;margin-bottom:48px}
h1{font-size:48px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:#94a3b8;font-size:18px}
.menu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:24px;margin-bottom:48px}
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
.badge-pending{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>⚡ TITAN ARBITRAGE v9.0</h1><div class="subtitle">Balancer Flash Loan Arbitrage Bot for Polygon | Gas Protection | Opportunity Validator | Auto-Discovery</div></div>
<div class="menu-grid">
<div class="menu-card" onclick="location.href='/wallet'"><div class="menu-icon">💰</div><div class="menu-title">Wallet Manager</div><div class="menu-desc">Create or import wallet</div></div>
<div class="menu-card" onclick="location.href='/deploy'"><div class="menu-icon">🚀</div><div class="menu-title">Deploy Contract</div><div class="menu-desc">Deploy Balancer flash loan contract</div></div>
<div class="menu-card" onclick="location.href='/dashboard'"><div class="menu-icon">🤖</div><div class="menu-title">Arbitrage Bot</div><div class="menu-desc">Start bot & monitor profits</div></div>
<div class="menu-card" onclick="location.href='/import-contract'"><div class="menu-icon">📥</div><div class="menu-title">Import Contract</div><div class="menu-desc">Use existing contract address</div></div>
</div>
<div class="status-bar">
<div class="status-item"><div class="status-label">WALLET</div><div class="status-value" id="walletStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">CONTRACT</div><div class="status-value" id="contractStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BALANCE</div><div class="status-value" id="balanceStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">BOT</div><div class="status-value" id="botStatus">Loading...</div></div>
<div class="status-item"><div class="status-label">TOKENS</div><div class="status-value" id="tokenCount">Loading...</div></div>
<div class="status-item"><div class="status-label">DEXES</div><div class="status-value" id="dexCount">Loading...</div></div>
</div>
</div>
<script>
async function updateStatus(){try{const res=await fetch('/api/status');const data=await res.json();
document.getElementById('walletStatus').innerHTML=data.walletCreated?'<span class="badge badge-success">✓ ACTIVE</span><br>'+data.walletAddress?.substring(0,10)+'...':'<span class="badge badge-danger">✗ NO WALLET</span>';
document.getElementById('contractStatus').innerHTML=data.contractDeployed?'<span class="badge badge-success">✓ DEPLOYED</span><br>'+data.contractAddress?.substring(0,10)+'...':'<span class="badge badge-warning">⚠ NOT DEPLOYED</span>';
document.getElementById('balanceStatus').innerHTML=data.walletBalance+' POL';
document.getElementById('botStatus').innerHTML=data.botRunning?'<span class="badge badge-success">● RUNNING</span>':'<span class="badge badge-warning">● STOPPED</span>';
document.getElementById('tokenCount').innerHTML=data.activeTokensCount || TOKENS.length;
document.getElementById('dexCount').innerHTML=data.activeDexesCount || Object.keys(DEX_MAP).length;
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
<h1>🚀 Deploy Balancer Contract</h1>

<div class="card">
<h3>📋 Requirements</h3>
<div class="requirements">
✓ Need 0.05+ POL for gas fees<br>
✓ Wallet must be created and funded<br>
✓ Balancer Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
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

<button class="success" onclick="deployContract()" id="deployBtn" disabled>🚀 Deploy Balancer Contract</button>
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
        if(balance >= 0.05){ 
            statusDiv.innerHTML+='<div class="info-box" style="background:#10b98120;border-color:#10b981;">✅ Sufficient balance! You can deploy now.</div>';
            document.getElementById('deployBtn').disabled=false;
            document.getElementById('deployBtn').style.opacity='1';
            document.getElementById('deployBtn').style.cursor='pointer';
        }else{
            statusDiv.innerHTML+='<div class="requirements" style="background:#ef444420;border-color:#ef4444;">⚠️ Insufficient balance! Need 0.05+ POL. Current: '+balance+' POL</div>';
            document.getElementById('deployBtn').disabled=true;
            document.getElementById('deployBtn').style.opacity='0.5';
            document.getElementById('deployBtn').style.cursor='not-allowed';
        }
    }else{
        statusDiv.innerHTML='<div class="requirements" style="background:#ef444420;">❌ No wallet found! Please create or import a wallet first.</div>';
        faucetSection.style.display='none';
        document.getElementById('deployBtn').disabled=true;
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
            alert('✅ Balancer contract deployed successfully!\\nAddress: '+data.contractAddress);
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
setInterval(refreshBalance, 10000);
setInterval(fetchLogs, 2000);
</script>
</body>
</html>`;

const importHTML = `<!DOCTYPE html>
<html><head><title>Import Contract</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;color:#e2e8f0}
.container{max-width:800px;margin:0 auto}
.card{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;border:1px solid #334155;margin-bottom:20px}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;text-align:center;margin-bottom:20px}
button{background:#3b82f6;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;margin:8px}
button.success{background:#10b981}
input{width:100%;padding:12px;margin:8px 0;background:#1e293b;border:1px solid #334155;border-radius:8px;color:white;font-family:monospace}
.back-btn{background:#6b7280}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back</button>
<h1>📥 Import Contract</h1>
<div class="card"><h3>🔧 Contract Address</h3><input type="text" id="contractInput" placeholder="0x... contract address"><button onclick="importContract()">Import Now</button></div>
</div>
<script>
async function importContract(){const addr=document.getElementById('contractInput').value;if(!addr){alert('Enter address');return;}const res=await fetch('/api/import-contract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contractAddress:addr})});const data=await res.json();if(data.success){alert('Imported!');location.href='/dashboard';}else{alert('Error: '+data.error);}}
</script>
</body>
</html>`;

const dashboardHTML = `<!DOCTYPE html>
<html><head><title>TITAN ARBITRAGE v9.0 - REAL OPPORTUNITIES</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%);font-family:'Segoe UI',monospace;padding:20px;min-height:100vh;color:#e2e8f0}
.container{max-width:1600px;margin:0 auto}
.header{background:rgba(15,23,42,0.95);border-radius:16px;padding:24px;margin-bottom:24px;border:1px solid #334155}
h1{font-size:28px;background:linear-gradient(135deg,#60a5fa,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.status{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:bold}
.online{background:#10b981;color:white;animation:pulse 2s infinite}
.offline{background:#ef4444;color:white}
.pending-flash{background:#f59e0b;color:white;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-bottom:24px}
.stat-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;border:1px solid #334155}
.stat-label{font-size:12px;color:#94a3b8;text-transform:uppercase}
.stat-value{font-size:32px;font-weight:bold;margin:8px 0;font-family:monospace}
.profit{color:#10b981}
.count-badge{background:#3b82f6;color:white;border-radius:20px;padding:4px 12px;font-size:14px;display:inline-block;margin-left:10px}
.table-container{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #334155;overflow-x:auto}
.feature-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #60a5fa}
.real-opp-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:2px solid #10b981}
.miner-card{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #f59e0b}
.discovery-stats{background:rgba(15,23,42,0.95);border-radius:16px;padding:20px;margin-bottom:24px;border:1px solid #10b981}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:12px;background:#1e293b;color:#94a3b8;font-size:12px}
td{padding:12px;border-bottom:1px solid #334155;font-size:13px;font-family:monospace}
.profit-badge{background:#10b981;color:white;padding:4px 8px;border-radius:8px;font-size:11px}
.real-badge{background:#10b981;color:white;padding:4px 8px;border-radius:8px;font-size:11px;animation:pulse 2s infinite}
.loss-badge{background:#ef4444;color:white;padding:4px 8px;border-radius:8px;font-size:11px}
.pending-badge{background:#f59e0b;color:white;padding:4px 8px;border-radius:8px;font-size:11px;animation:pulse 1s infinite}
.progress-bar{width:100%;background:#1e293b;height:6px;border-radius:3px;overflow:hidden;margin-top:4px}
.progress-fill{height:100%;background:#f59e0b;transition:width 0.5s}
.log-entry{padding:8px;border-bottom:1px solid #334155;font-size:12px;font-family:monospace}
button{background:#3b82f6;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-weight:bold;margin-right:10px}
button.danger{background:#ef4444}
button.success{background:#10b981}
.back-btn{background:#6b7280;margin-bottom:20px}
.feature-badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;margin-left:8px}
.gas-protect{background:#10b98120;color:#10b981;border:1px solid #10b981}
.opp-validate{background:#60a5fa20;color:#60a5fa;border:1px solid #60a5fa}
.auto-discovery{background:#8b5cf620;color:#8b5cf6;border:1px solid #8b5cf6}
</style>
</head>
<body>
<div class="container">
<button class="back-btn" onclick="location.href='/'">← Back to Menu</button>
<div class="header"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap"><div><h1>⚡ TITAN ARBITRAGE v9.0 <span class="feature-badge gas-protect">GAS PROTECTION</span><span class="feature-badge opp-validate">OPPORTUNITY VALIDATOR</span><span class="feature-badge auto-discovery">AUTO-DISCOVERY</span></h1><p style="color:#94a3b8;margin-top:8px">Balancer Flash Loans | REAL On-chain Arbitrage | $5+ Minimum Profit | $50k+ Liquidity Required</p></div><div style="text-align:right"><span id="connectionStatus" class="status offline">● CONNECTING</span><span id="pendingStatus" style="margin-left:10px"></span><button id="toggleTrade" class="success" style="margin-left:10px">🟢 Trading ON</button></div></div></div>

<div class="real-opp-card"><h3 style="margin-bottom:16px">💰 REAL ARBITRAGE OPPORTUNITIES FOUND <span id="opportunityCount" class="count-badge">0</span></h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px"><div><span class="stat-label">Only REAL Profitable</span><div class="stat-value profit" id="realOppCount">0</div></div><div><span class="stat-label">Min Profit Required</span><div class="stat-value">$5.00</div></div><div><span class="stat-label">Min Liquidity</span><div class="stat-value">$50k</div></div></div></div>

<div class="discovery-stats"><h3 style="margin-bottom:16px">🔍 AUTO-DISCOVERY STATUS (Updates every 60 seconds)</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px"><div><span class="stat-label">Active Tokens</span><div class="stat-value" id="activeTokens">0</div></div><div><span class="stat-label">Active DEXes</span><div class="stat-value" id="activeDexes">0</div></div><div><span class="stat-label">Discovered Tokens</span><div class="stat-value" id="discoveredTokens">0</div></div><div><span class="stat-label">Last Discovery</span><div class="stat-value" id="lastDiscovery" style="font-size:14px">Never</div></div></div></div>

<div class="stats-grid"><div class="stat-card"><div class="stat-label">Total Profit</div><div class="stat-value profit" id="totalProfit">$0.00</div><div class="stat-label">Win Rate: <span id="winRate">0</span>%</div></div>
<div class="stat-card"><div class="stat-label">Trades Executed</div><div class="stat-value" id="totalTrades">0</div><div class="stat-label">Success: <span id="successTrades">0</span> | Failed: <span id="failedTrades">0</span></div></div>
<div class="stat-card"><div class="stat-label">Min Profit Required</div><div class="stat-value">$5.00</div><div class="stat-label">Borrow Amount: $1000</div></div>
<div class="stat-card"><div class="stat-label">Wallet Balance</div><div class="stat-value" id="walletBalance">0 MATIC</div><div class="stat-label">Gas Cost: ~$0.04</div></div></div>

<div class="miner-card"><h3 style="margin-bottom:16px">⛏️ PENDING TRANSACTIONS (Waiting for Miners)</h3><div id="minerPendingContainer"><p style="color:#94a3b8">No pending transactions</p></div></div>

<div class="table-container"><h3 style="margin-bottom:16px">🔥 REAL ARBITRAGE OPPORTUNITIES (DexScreener + Liquidity + Slippage Filtered)</h3><table id="opportunitiesTable"><thead><tr><th>Token</th><th>Buy → Sell</th><th>Spread</th><th>Liquidity</th><th>Gross Profit</th><th>Fees+Slippage</th><th>NET PROFIT</th><th>Status</th></tr></thead><tbody id="opportunitiesBody"></tbody></table></div>

<div class="table-container"><h3 style="margin-bottom:16px">📊 TRADE HISTORY</h3><table id="historyTable"><thead><tr><th>Time</th><th>Token</th><th>Route</th><th>Net Profit</th><th>Status</th><th>Tx</th></tr></thead><tbody id="historyBody"></tbody></table></div>

<div class="table-container"><h3 style="margin-bottom:16px">📝 LIVE LOGS (Gas Protection & Validator Events)</h3><div id="logsContainer" style="height:200px;overflow-y:auto;font-family:monospace;font-size:12px"></div></div></div>

<script>
let autoRefresh=setInterval(fetchData,3000);
async function fetchData(){try{const res=await fetch('/api/data');const data=await res.json();updateUI(data);}catch(e){}}
function formatNumber(num){return new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).format(num);}
function formatCurrency(num){return '$'+formatNumber(num);}
function formatLiquidity(num){if(num>=1000000)return '$'+(num/1000000).toFixed(1)+'M';if(num>=1000)return '$'+(num/1000).toFixed(0)+'k';return '$'+num.toFixed(0);}
function updateUI(data){const statusEl=document.getElementById('connectionStatus');if(data.connected){statusEl.className='status online';statusEl.innerHTML='● ONLINE';}else{statusEl.className='status offline';statusEl.innerHTML='● OFFLINE';}
const pendingStatus=document.getElementById('pendingStatus');if(data.pendingFlash){pendingStatus.innerHTML='<span class="pending-flash" style="padding:4px 12px;border-radius:20px;font-size:12px">⏳ FLASH PENDING: '+data.pendingFlash+'</span>';}else{pendingStatus.innerHTML='';}
const minerContainer=document.getElementById('minerPendingContainer');if(data.pendingTransactions&&data.pendingTransactions.length>0){minerContainer.innerHTML='<table style="width:100%"><thead><tr><th>Token</th><th>Tx Hash</th><th>Expected Profit</th><th>Progress</th><th>Gas Price</th></tr></thead><tbody>'+data.pendingTransactions.map(tx=>{const waitSec=Math.floor((Date.now()-new Date(tx.timestamp))/1000);return '<tr><td><b>'+tx.token+'</b></td><td><a href="https://polygonscan.com/tx/'+tx.txHash+'" target="_blank" style="color:#60a5fa">'+tx.txHash.substring(0,10)+'...</a></td><td class="profit">'+formatCurrency(tx.expectedProfit)+'</td><td><div class="progress-bar"><div class="progress-fill" style="width:'+tx.progress+'%"></div></div><span style="font-size:10px">'+tx.progress+'% ('+waitSec+'s)</span></td><td>'+tx.gasPrice+' Gwei</td></tr>';}).join('')+'</tbody></table>';}else{minerContainer.innerHTML='<p style="color:#94a3b8">No pending transactions waiting for miners</p>';}
document.getElementById('totalProfit').innerHTML='<span class="profit">'+formatCurrency(data.stats?.totalProfit||0)+'</span>';
document.getElementById('totalTrades').innerText=data.stats?.tradesExecuted||0;
document.getElementById('successTrades').innerText=data.stats?.successfulTrades||0;
document.getElementById('failedTrades').innerText=data.stats?.failedTrades||0;
document.getElementById('walletBalance').innerText=(data.walletBal||0)+' MATIC';
document.getElementById('winRate').innerText=((data.stats?.successfulTrades/(data.stats?.tradesExecuted||1))*100).toFixed(1);
document.getElementById('activeTokens').innerText=data.discoveryStats?.activeTokensCount || data.activeTokensCount || 100;
document.getElementById('activeDexes').innerText=data.discoveryStats?.activeDexesCount || 25;
document.getElementById('discoveredTokens').innerText=data.discoveryStats?.totalTokensDiscovered || 0;
document.getElementById('lastDiscovery').innerText=data.discoveryStats?.lastDiscoveryTime ? new Date(data.discoveryStats.lastDiscoveryTime).toLocaleTimeString() : 'Never';
const realOppCount = (data.opportunities||[]).filter(o=>o.netProfit>5).length;
document.getElementById('realOppCount').innerText=realOppCount;
document.getElementById('opportunityCount').innerText=realOppCount;
const oppBody=document.getElementById('opportunitiesBody');
if(data.opportunities&&data.opportunities.length>0){const realOpps=data.opportunities.filter(o=>o.netProfit>5);if(realOpps.length>0){oppBody.innerHTML=realOpps.map(opp=>'<tr><td><b>'+opp.token+'</b></td><td>'+opp.buyDex+' → '+opp.sellDex+'</td><td class="profit">+'+opp.spreadPercent+'%</td><td>'+formatLiquidity(opp.buyLiquidity||0)+'</td><td class="profit">'+formatCurrency(opp.grossProfit)+'</td><td class="loss">'+formatCurrency(opp.totalFees)+'</td><td class="profit"><b>'+formatCurrency(opp.netProfit)+'</b></td><td><span class="real-badge">💰 REAL</span></td></tr>').join('');}else{oppBody.innerHTML='<tr><td colspan="8" style="text-align:center">🔍 Scanning for REAL opportunities (need $5+ profit after fees & slippage)...</td></tr>';}}else{oppBody.innerHTML='<tr><td colspan="8" style="text-align:center">🔍 Scanning 100+ tokens across 25+ DEXes for REAL opportunities...</td></table>';}
const historyBody=document.getElementById('historyBody');
if(data.tradeHistory&&data.tradeHistory.length>0){historyBody.innerHTML=data.tradeHistory.slice(0,20).map(t=>'<tr><td style="font-size:11px">'+new Date(t.timestamp).toLocaleTimeString()+'</span></td><td><b>'+(t.token||'-')+'</b></span></td><td>'+(t.buyDex||'-')+'→'+(t.sellDex||'-')+'</span></td><td class="profit">'+formatCurrency(t.netProfit||0)+'</span></td><td><span class="'+(t.status==='✅ SUCCESS'?'profit-badge':'loss-badge')+'">'+t.status+'</span></span></td><td>'+(t.txHash?'<a href="https://polygonscan.com/tx/'+t.txHash+'" target="_blank" style="color:#60a5fa">View</a>':'-')+'</span></tr>').join('');}
const logsDiv=document.getElementById('logsContainer');if(data.logs&&data.logs.length>0){logsDiv.innerHTML=data.logs.slice(0,20).map(l=>'<div class="log-entry">['+new Date(l.time).toLocaleTimeString()+'] '+l.message+'</div>').join('');}}
document.getElementById('toggleTrade').onclick=async()=>{const res=await fetch('/api/toggle',{method:'POST'});const data=await res.json();const btn=document.getElementById('toggleTrade');if(data.autoTrade){btn.className='success';btn.innerHTML='🟢 Trading ON';}else{btn.className='danger';btn.innerHTML='🔴 Trading OFF';}};
fetchData();
</script>
</body>
</html>`;

// ==================== [ API Routes ] ====================
app.get('/api/status', async (req, res) => {
    if (deploymentInfo.privateKey) {
        try {
            const balance = await checkWalletBalance();
            deploymentInfo.walletBalance = balance;
        } catch (e) {}
    }
    res.json({
        walletCreated: !!deploymentInfo.privateKey,
        walletAddress: deploymentInfo.wallet,
        walletBalance: deploymentInfo.walletBalance,
        contractDeployed: deploymentInfo.deployed || contractDeployed,
        contractAddress: deploymentInfo.contractAddress || (deploymentInfo.contractAddress),
        botRunning: deploymentInfo.botRunning,
        totalProfit: state.stats.totalProfit,
        activeTokensCount: TOKENS.length,
        activeDexesCount: Object.keys(DEX_MAP).length
    });
});

app.get('/api/data', (req, res) => {
    const winRate = (state.stats?.tradesExecuted || 0) > 0 ? (state.stats.successfulTrades / state.stats.tradesExecuted) * 100 : 0;
    res.json({
        ...state,
        winRate: winRate,
        contractDeployed: contractDeployed || deploymentInfo.deployed,
        contractAddress: deploymentInfo.contractAddress,
        walletBal: state.walletBal,
        uptime: process.uptime(),
        pendingFlash: state.pendingFlash,
        pendingTransactions: state.pendingTransactions,
        activeTokensCount: TOKENS.length,
        activeDexesCount: Object.keys(DEX_MAP).length,
        discoveryStats: state.discoveryStats,
        config: {
            borrowAmount: BORROW_AMOUNT,
            minProfitTrigger: MIN_PROFIT_USD,
            liquidityFloor: LIQUIDITY_FLOOR
        }
    });
});

app.get('/api/deploy-logs', (req, res) => {
    res.json({ logs: state.logs.slice(0, 30) });
});

app.post('/api/toggle', (req, res) => {
    state.autoTrade = !state.autoTrade;
    if (state.autoTrade && !deploymentInfo.botRunning) startBot();
    if (!state.autoTrade && deploymentInfo.botRunning) stopBot();
    res.json({ autoTrade: state.autoTrade });
});

app.post('/api/create-wallet', (req, res) => {
    try {
        const wallet = createNewWallet();
        res.json({ success: true, ...wallet });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/import-wallet', async (req, res) => {
    try {
        const { privateKey } = req.body;
        const wallet = await importWallet(privateKey);
        res.json({ success: true, ...wallet });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/import-contract', async (req, res) => {
    try {
        const { contractAddress } = req.body;
        const addr = await importContract(contractAddress);
        res.json({ success: true, contractAddress: addr });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    try {
        const addr = await deployContract();
        res.json({ success: true, contractAddress: addr });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/start-bot', async (req, res) => {
    try {
        await startBot();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/stop-bot', (req, res) => {
    stopBot();
    res.json({ success: true });
});

// ==================== [ runBot and main loop ] ====================
async function validateOpportunityOnChain(opp, provider) {
    try {
        const routerABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"];

        const routerA = new ethers.Contract(DEX_MAP[opp.buyDex]?.router, routerABI, provider);
        const routerB = new ethers.Contract(DEX_MAP[opp.sellDex]?.router, routerABI, provider);

        const borrowAmount = ethers.parseUnits(BORROW_AMOUNT.toString(), 6);
        const pathBuy = [USDC_ADDR, opp.tokenAddress];
        const pathSell = [opp.tokenAddress, USDC_ADDR];

        // Get on-chain quotes
        const amountsOutBuy = await routerA.getAmountsOut(borrowAmount, pathBuy);
        const amountsOutSell = await routerB.getAmountsOut(amountsOutBuy[1], pathSell);

        const buyTokenAmount = amountsOutBuy[1];
        const sellTokenAmount = amountsOutSell[1];

        const buyPriceOnChain = Number(ethers.formatUnits(buyTokenAmount, opp.decimals || 6));
        const sellPriceOnChain = Number(ethers.formatUnits(sellTokenAmount, 6));
        const onChainSpread = ((sellPriceOnChain - buyPriceOnChain) / buyPriceOnChain) * 100;

        addLog(`🔍 On-chain validation: ${opp.token} | Spread: ${onChainSpread.toFixed(3)}%`);

        const spreadDifference = Math.abs(parseFloat(opp.spreadPercent) - onChainSpread);
        const isSpreadValid = spreadDifference < 5 && onChainSpread > 0.05;

        const liquidityUsd = parseFloat(opp.buyLiquidity || 0);
        const grossProfitOnChain = (Number(ethers.formatUnits(buyTokenAmount, opp.decimals || 6))) * (onChainSpread / 100);
        const totalFees = opp.swapFeesBuy + opp.swapFeesSell + (liquidityUsd > 200000 ? 0.003 : 0.005);
        const netProfitEstimate = grossProfitOnChain - totalFees - 0.05;

        const isProfitable = netProfitEstimate > MIN_PROFIT_USD;

        if (!isSpreadValid || !isProfitable) {
            addLog(`⚠️ Validation failed for ${opp.token}`);
            return false;
        }
        return true;
    } catch (e) {
        addLog(`⚠️ On-chain validation error for ${opp.token}: ${e.message.slice(0,80)}`);
        return false;
    }
}

async function scanForOpportunities() {
    const opportunities = [];
    const provider = await getWorkingProvider();

    for (const token of TOKENS) {
        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token.a}`, { timeout: 5000 });
            if (!res.data.pairs) continue;

            const pairs = res.data.pairs.filter(p => 
                p.chainId === 'polygon' && 
                parseFloat(p.liquidity?.usd || 0) > 50000 && 
                DEX_MAP[p.dexId] && 
                p.priceUsd && 
                parseFloat(p.priceUsd) > 0.0001
            );

            if (pairs.length < 2) continue;
            pairs.sort((a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd));

            const low = pairs[0];
            const high = pairs[pairs.length - 1];

            const buyPrice = parseFloat(low.priceUsd);
            const sellPrice = parseFloat(high.priceUsd);
            const spread = ((sellPrice - buyPrice) / buyPrice) * 100;

            const borrowAmount = BORROW_AMOUNT;
            const tokenAmount = borrowAmount / buyPrice;

            const liquidityUsd = parseFloat(low.liquidity?.usd || 0);
            const slippage = liquidityUsd > 200000 ? 0.003 : (liquidityUsd > 100000 ? 0.005 : 0.01);
            const slippageLoss = borrowAmount * slippage;

            const grossProfit = borrowAmount * (spread / 100);
            const swapFeesBuy = borrowAmount * (DEX_MAP[low.dexId]?.fee || 0.003);
            const swapFeesSell = (borrowAmount + grossProfit) * (DEX_MAP[high.dexId]?.fee || 0.003);
            const totalFees = swapFeesBuy + swapFeesSell + slippageLoss;

            const netProfit = grossProfit - totalFees - 0.05;

            if (spread > 0.1 && spread < 25 && netProfit > 5 && liquidityUsd > 50000) {
                const isValid = await validateOpportunityOnChain({
                    token: token.s,
                    tokenAddress: token.a,
                    decimals: token.decimals || 6,
                    buyDex: low.dexId,
                    sellDex: high.dexId,
                    buyPrice: buyPrice,
                    sellPrice: sellPrice,
                    spreadPercent: spread.toFixed(3),
                    grossProfit: grossProfit,
                    slippageLoss: slippageLoss,
                    swapFeesBuy: swapFeesBuy,
                    swapFeesSell: swapFeesSell,
                    totalFees: totalFees,
                    netProfit: netProfit,
                    buyLiquidity: liquidityUsd,
                    sellLiquidity: parseFloat(high.liquidity?.usd || 0)
                }, provider);

                if (isValid) {
                    opportunities.push({
                        token: token.s,
                        tokenAddress: token.a,
                        decimals: token.decimals || 6,
                        buyDex: low.dexId,
                        buyPrice: buyPrice,
                        sellDex: high.dexId,
                        sellPrice: sellPrice,
                        spreadPercent: spread.toFixed(3),
                        grossProfit: grossProfit,
                        slippageLoss: slippageLoss,
                        totalFees: totalFees,
                        netProfit: netProfit,
                        buyLiquidity: liquidityUsd,
                        sellLiquidity: parseFloat(high.liquidity?.usd || 0),
                        isProfitable: true,
                        timestamp: Date.now()
                    });
                    addLog(`🎯 Real opportunity: ${token.s} on ${low.dexId} → ${high.dexId} | Spread: ${spread.toFixed(2)}% | Net: $${netProfit.toFixed(2)}`);
                }
            }
        } catch (e) {}
    }
    return opportunities.sort((a, b) => b.netProfit - a.netProfit);
}

// --- Main scan loop ---
async function scan() {
    if (!state.connected) await connect();

    // Run auto-discovery periodically (skip for brevity, keep your existing code)

    // Find opportunities
    const opportunities = await scanForOpportunities();

    // Limit to top 15
    state.opportunities = opportunities.slice(0, 15);

    // Check pending transactions
    await checkPendingTransactions();

    // Execute opportunities
    if (state.autoTrade && contract && contractDeployed && opportunities.length > 0) {
        for (const opp of opportunities.filter(o => o.isProfitable && o.netProfit > 5)) {
            if (!activeExecutions.has(opp.token) && !state.pendingFlash) {
                // Gas simulation
                addLog(`🔬 GAS PROTECTION: Simulating for ${opp.token}...`);
                const simRes = await simulateTransaction(wallet, contract, "executeFlashLoan", [
                    USDC_ADDR,
                    ethers.parseUnits(BORROW_AMOUNT.toString(), 6),
                    DEX_MAP[opp.buyDex]?.router,
                    DEX_MAP[opp.sellDex]?.router,
                    opp.tokenAddress
                ], { gasLimit: 800000 });
                if (!simRes.success) {
                    addLog(`🛡️ Gas simulation failed for ${opp.token}`);
                    continue;
                }

                // On-chain validation
                addLog(`🔍 OPPORTUNITY VALIDATOR: ${opp.token}...`);
                const valid = await validateOpportunityOnChain(opp, provider);
                if (!valid) {
                    addLog(`🛡️ Validation failed for ${opp.token}`);
                    continue;
                }

                // Execute
                activeExecutions.set(opp.token, true);
                executeFlashLoan(opp).finally(() => activeExecutions.delete(opp.token));
            }
        }
    }
}

// --- Start server and bot ---
async function start() {
    console.log(`Starting at http://localhost:${PORT}`);
    await connect();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
    runBotLoop();
}
start();

// --- Your existing functions: executeFlashLoan, runBotLoop, stopBot, etc. ---
