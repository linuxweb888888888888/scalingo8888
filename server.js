const express = require('express');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// --- 1. EXCHANGE CORE ENGINE ---
class PrivateExchange {
    constructor() {
        this.fee = 0.0005; // YOUR CUSTOM FEE (0.05%)
        this.balances = {
            'ADMIN_RESERVE': {},
            'USER_BOT_1': { USDT: 10000 }
        };
        this.orderBooks = {};
        this.assets = {};
        this.initAssets();
    }

    initAssets() {
        // Define 150 coins dynamically
        const bases = ['BTC', 'ETH', 'BNB', 'SOL', 'GOLD', 'SILV', 'AAPL', 'TSLA', 'MARS', 'PEPE'];
        for (let i = 1; i <= 150; i++) {
            let symbol = i <= bases.length ? bases[i-1] : `COIN_${i}`;
            this.assets[symbol] = { id: i, name: `Asset ${symbol}`, balance: 0 };
            this.balances['USER_BOT_1'][symbol] = 0;
            this.balances['ADMIN_RESERVE'][symbol] = 0;
            if (symbol !== 'USDT') {
                this.orderBooks[`${symbol}/USDT`] = { buys: [], sells: [] };
            }
        }
        this.balances['ADMIN_RESERVE']['USDT'] = 0;
    }

    // Matching Engine (Price-Time Priority)
    placeOrder(userId, pair, side, price, amount) {
        const book = this.orderBooks[pair];
        if (!book) return { error: "Pair not found" };

        const takerOrder = { userId, side, price: parseFloat(price), amount: parseFloat(amount), id: uuidv4() };
        const opposite = side === 'buy' ? book.sells : book.buys;

        // Sort: Sells (low to high), Buys (high to low)
        opposite.sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price);

        for (let i = 0; i < opposite.length; i++) {
            const maker = opposite[i];
            const match = side === 'buy' ? takerOrder.price >= maker.price : takerOrder.price <= maker.price;

            if (match) {
                const tradeSize = Math.min(takerOrder.amount, maker.amount);
                this.executeTrade(takerOrder, maker, tradeSize, maker.price, pair);
                takerOrder.amount -= tradeSize;
                maker.amount -= tradeSize;
                if (maker.amount === 0) opposite.splice(i, 1);
                if (takerOrder.amount === 0) break;
            }
        }

        if (takerOrder.amount > 0) {
            (side === 'buy' ? book.buys : book.sells).push(takerOrder);
        }
        return { status: "processed", balance: this.balances[userId] };
    }

    executeTrade(taker, maker, size, price, pair) {
        const [base, quote] = pair.split('/');
        const cost = size * price;
        const fee = cost * this.fee;

        if (taker.side === 'buy') {
            this.balances[taker.userId][quote] -= (cost + fee);
            this.balances[taker.userId][base] += size;
            this.balances[maker.userId][quote] += cost;
            this.balances[maker.userId][base] -= size;
            this.balances['ADMIN_RESERVE'][quote] += fee; // YOU EARN THE FEE
        } else {
            this.balances[taker.userId][quote] += (cost - fee);
            this.balances[taker.userId][base] -= size;
            this.balances[maker.userId][quote] -= cost;
            this.balances[maker.userId][base] += size;
            this.balances['ADMIN_RESERVE'][quote] += fee; // YOU EARN THE FEE
        }
    }
}

const engine = new PrivateExchange();

// --- 2. BLOCKCHAIN BRIDGE (REAL FUNDS) ---
const BSC_PROVIDER = 'https://bsc-dataseed.binance.org/';
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';

async function connectBlockchain() {
    try {
        const provider = new ethers.JsonRpcProvider(BSC_PROVIDER);
        console.log("Connected to Real Blockchain: BSC");
        
        // Example: Logic to watch your Master Wallet for real USDT deposits
        // and credit engine.balances['USER_BOT_1'].USDT would go here.
    } catch (e) { console.log("Blockchain Offline - Running in Local Ledger Mode"); }
}

// --- 3. DASHBOARD & API ---
app.get('/api/state', (req, res) => res.json({
    balances: engine.balances['USER_BOT_1'],
    feesEarned: engine.balances['ADMIN_RESERVE'],
    assets: Object.keys(engine.assets).length
}));

app.post('/api/order', (req, res) => {
    const { side, pair, price, amount } = req.body;
    res.json(engine.placeOrder('USER_BOT_1', pair, side, price, amount));
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#f1f5f9; font-family:monospace; padding:20px;">
            <h1 style="color:#38bdf8">Private Asset Exchange (150 Coins)</h1>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div style="background:#0f172a; padding:20px; border-radius:10px; border:1px solid #1e293b;">
                    <h3>Submit Internal Trade</h3>
                    <input id="pair" value="GOLD/USDT" style="width:100%; margin-bottom:10px;">
                    <input id="price" placeholder="Price" style="width:100%; margin-bottom:10px;">
                    <input id="amount" placeholder="Amount" style="width:100%; margin-bottom:10px;">
                    <button onclick="trade('buy')" style="width:48%; background:#4ade80; border:none; padding:10px; font-weight:bold;">BUY</button>
                    <button onclick="trade('sell')" style="width:48%; background:#f87171; border:none; padding:10px; font-weight:bold;">SELL</button>
                </div>
                <div style="background:#0f172a; padding:20px; border-radius:10px; border:1px solid #1e293b;">
                    <h3>Internal Ledger</h3>
                    <div id="ledger" style="font-size:0.8rem; height:200px; overflow-y:auto;"></div>
                </div>
            </div>
            <script>
                async function trade(side) {
                    await fetch('/api/order', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            side, 
                            pair: document.getElementById('pair').value,
                            price: document.getElementById('price').value,
                            amount: document.getElementById('amount').value
                        })
                    });
                    update();
                }
                async function update() {
                    const res = await fetch('/api/state');
                    const data = await res.json();
                    document.getElementById('ledger').innerHTML = '<pre>' + JSON.stringify(data.balances, null, 2) + '</pre>';
                }
                setInterval(update, 2000);
                update();
            </script>
        </body>
    `);
});

app.listen(port, () => {
    console.log(`Exchange Server active on port ${port}`);
    connectBlockchain();
});
