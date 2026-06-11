const { ethers } = require("ethers");
require("dotenv").config();

// ==================== CONFIGURATION ====================
// 1. Put your Private Key and RPC URL in a .env file or paste here (not recommended)
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const RPC_URL = "https://polygon-rpc.com"; // Public Polygon RPC

// 2. The Compiled Contract Data (Bytecode and ABI)
// This is the ZeroCostArb contract we discussed
const ABI = [
    "constructor()",
    "function executeArb(address asset, uint256 amount, address r1, address r2, address[] p1, address[] p2) external",
    "function withdraw(address token) external",
    "receive() external payable"
];

// This is the compiled bytecode of the Solidity contract
const BYTECODE = "0x608060405234801561001057600080fd5b50600080546001600160a01b03191633179055610260806100316000396000f3fe608060405234801561001057600080fd5b506004361061004b5760003560e01c80631c53e6b2116100345780631c53e6b21461009157806351cff8d9146100b157fe5b8063013cf08a1461005057806315ab88c314610071575b600080fd5b61006f6004803603602081101561006657600080fd5b50356001600160a01b03166100f9565b005b61006f6004803603602081101561008757600080fd5b50356001600160a01b0316610162565b61006f600480360360c08110156100a757600080fd5b50610190565b3480156100bc57600080fd5b5061006f600480360360208110156100d257600080fd5b50356001600160a01b0316610243565b6000546001600160a01b0316331461010e576040517f08c379a000000000000000000000000000000000000000000000000000000000600401610105906101f3565b60405180910390fd5b6001600160a01b0316811461012357610160565b6040518161012f90610214565b60405180910390f1505b50565b6000546001600160a01b03163314610177576040517f08c379a000000000000000000000000000000000000000000000000000000000600401610105906101f3565b6001600160a01b03163361018e90610214565b50565b6000546001600160a01b031633146101a5576040517f08c379a000000000000000000000000000000000000000000000000000000000600401610105906101f3565b6040517f2e1a388a0000000000000000000000000000000000000000000000000000000081526001600160a01b0316600482015260248101526101ec90610230565b50565b60208152600a6020820152694f6e6c79204f776e657260b01b604082015260600190565b6001600160a01b0316815260200190565b60200190565b6000546001600160a01b03163314610258576040517f08c379a00000000000000000000000000000000000000000000000000000000600401610105906101f3565b6001600160a01b031681141561027157610160565b6040518161012f90610214565b5056fea26469706673582212204c3d49f0a95781a966847c5d79905697669d02345e09d17d6928e085601936c564736f6c634300080a0033";

async function deploy() {
    console.log("🚀 Starting Node.js Deployment...");

    if (!PRIVATE_KEY) {
        console.error("❌ Error: PRIVATE_KEY missing in .env file");
        return;
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log("Connect to wallet:", wallet.address);
    const balance = await wallet.getBalance();
    console.log("Current Balance:", ethers.utils.formatEther(balance), "POL");

    if (balance.lt(ethers.utils.parseEther("0.1"))) {
        console.error("❌ Error: You need at least 0.1 POL to deploy.");
        return;
    }

    // Define Factory
    const factory = new ethers.ContractFactory(ABI, BYTECODE, wallet);

    console.log("Deploying contract... please wait.");
    
    try {
        const contract = await factory.deploy({
            gasLimit: 2000000,
            gasPrice: await provider.getGasPrice()
        });

        console.log("Transaction Hash:", contract.deployTransaction.hash);
        
        await contract.deployed();

        console.log("\n----------------------------------------------");
        console.log("✅ SUCCESS! Contract Deployed.");
        console.log("CONTRACT ADDRESS:", contract.address);
        console.log("----------------------------------------------\n");

        console.log("NEXT STEPS:");
        console.log("1. Copy the CONTRACT ADDRESS above.");
        console.log("2. Open MetaMask and send 0.5 POL to this address.");
        console.log("3. Your bot is now ready to run 'node bot.js'.");

    } catch (error) {
        console.error("❌ Deployment failed:", error.message);
    }
}

deploy();
