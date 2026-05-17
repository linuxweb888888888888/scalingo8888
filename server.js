const { ethers } = require('ethers');
const express = require('express');
const app = express();
app.use(express.json());

// --- 1. THE COIN DATABASE ---
// You can add ANY coin here by finding its contract address on BscScan or Etherscan
const COIN_CONFIG = {
    'USDT': { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    'WBTC': { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
    'PEPE': { address: '0x25d887Ce733038661280338F8790b83e46766468', decimals: 18 },
    'WBNB': { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 }
};

const PROVIDER_URL = 'https://bsc-dataseed.binance.org/';
const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);

// --- 2. THE MULTI-COIN ENGINE ---
class MultiCoinExchange {
    constructor() {
        this.balances = {
            'ADMIN': { USDT: 0, WBTC: 0, PEPE: 0, WBNB: 0 },
            'USER_1': { USDT: 100, WBTC: 0, PEPE: 0, WBNB: 0 }
        };
        this.pairs = {}; // Order books for BTC/USDT, PEPE/USDT, etc.
    }

    // Connect to the blockchain to listen for ANY of the coins above
    async startListeners() {
        const abi = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
        
        for (const [symbol, config] of Object.entries(COIN_CONFIG)) {
            const contract = new ethers.Contract(config.address, abi, provider);
            
            contract.on("Transfer", (from, to, value) => {
                if (to.toLowerCase() === wallet.address.toLowerCase()) {
                    const amount = parseFloat(ethers.formatUnits(value, config.decimals));
                    console.log(`DEPOSIT DETECTED: ${amount} ${symbol} from ${from}`);
                    this.balances['USER_1'][symbol] = (this.balances['USER_1'][symbol] || 0) + amount;
                }
            });
            console.log(`Listening for ${symbol} deposits...`);
        }
    }

    // Trade any coin against USDT (Internal Ledger)
    placeOrder(userId, base, quote, side, price, amount) {
        const pair = `${base}/${quote}`;
        if (!this.pairs[pair]) this.pairs[pair] = { buys: [], sells: [] };

        // ... [Insert Matching Logic from previous steps here] ...
        // It moves 'base' and 'quote' symbols in the this.balances[userId] object
        console.log(`Order placed for ${pair}: ${side} ${amount} @ ${price}`);
    }

    // Withdraw any coin back to the real blockchain
    async withdraw(userId, symbol, toAddress, amount) {
        const config = COIN_CONFIG[symbol];
        if (!config || this.balances[userId][symbol] < amount) return { error: "Failed" };

        const abi = ["function transfer(address to, uint256 amount) public returns (bool)"];
        const contract = new ethers.Contract(config.address, abi, wallet);
        
        const tx = await contract.transfer(toAddress, ethers.parseUnits(amount.toString(), config.decimals));
        await tx.wait();

        this.balances[userId][symbol] -= amount;
        return { success: true, tx: tx.hash };
    }
}

const engine = new MultiCoinExchange();
engine.startListeners();

// --- 3. API ---
app.post('/trade', (req, res) => {
    const { base, quote, side, price, amount } = req.body;
    engine.placeOrder('USER_1', base, quote, side, price, amount);
    res.json(engine.balances['USER_1']);
});

app.get('/', (req, res) => {
    res.send(`<h1>Exchange Ledger</h1><pre>${JSON.stringify(engine.balances, null, 2)}</pre>`);
});

app.listen(3000);
