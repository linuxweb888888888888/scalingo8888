const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// --- 1. DATABASE CONNECTION ---
const MONGODB_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb";
mongoose.connect(MONGODB_URI);

// --- 2. SCHEMAS ---
const AccountSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    balances: { type: Map, of: Number, default: {} }
});
const OrderBookSchema = new mongoose.Schema({
    pair: { type: String, unique: true },
    buys: { type: Array, default: [] }, // Format: {price, amount, userId}
    sells: { type: Array, default: [] }
});
const Account = mongoose.model('Account', AccountSchema);
const OrderBook = mongoose.model('OrderBook', OrderBookSchema);

// --- 3. EXCHANGE ENGINE ---
class PrivateExchange {
    constructor() {
        this.fee = 0.0005; 
        this.coins = Array.from({length: 149}, (_, i) => `C${i+1}`); // C1 to C149
        this.allAssets = ['USDT', 'BTC', ...this.coins]; // 150 Total
    }

    async getAccount(userId) {
        let acc = await Account.findOne({ userId });
        if (!acc) {
            const initialBalances = { USDT: 100000, BTC: 10 };
            this.coins.forEach(c => initialBalances[c] = 1000);
            acc = await Account.create({ userId, balances: initialBalances });
        }
        return acc;
    }

    async placeOrder(userId, pair, side, price, amount) {
        let book = await OrderBook.findOne({ pair });
        if (!book) book = await OrderBook.create({ pair });

        const takerOrder = { userId, side, price: parseFloat(price), amount: parseFloat(amount), id: uuidv4() };
        let opposite = side === 'buy' ? book.sells : book.buys;
        
        // Match Logic
        opposite.sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price);
        
        const takerAcc = await this.getAccount(userId);
        for (let i = 0; i < opposite.length; i++) {
            const maker = opposite[i];
            const isMatch = side === 'buy' ? takerOrder.price >= maker.price : takerOrder.price <= maker.price;

            if (isMatch) {
                const tradeSize = Math.min(takerOrder.amount, maker.amount);
                const makerAcc = await this.getAccount(maker.userId);
                
                await this.executeTrade(takerAcc, makerAcc, tradeSize, maker.price, pair, side);
                
                takerOrder.amount -= tradeSize;
                maker.amount -= tradeSize;
                if (maker.amount <= 0) opposite.splice(i, 1);
                if (takerOrder.amount <= 0) break;
            }
        }

        if (takerOrder.amount > 0) {
            side === 'buy' ? book.buys.push(takerOrder) : book.sells.push(takerOrder);
        }

        await OrderBook.updateOne({ pair }, { buys: book.buys, sells: book.sells });
        await takerAcc.save();
    }

    async executeTrade(taker, maker, size, price, pair, side) {
        const [base, quote] = pair.split('/');
        const cost = size * price;
        const fee = cost * this.fee;

        if (side === 'buy') {
            taker.balances.set(quote, taker.balances.get(quote) - (cost + fee));
            taker.balances.set(base, taker.balances.get(base) + size);
            maker.balances.set(quote, maker.balances.get(quote) + cost);
            maker.balances.set(base, maker.balances.get(base) - size);
        } else {
            taker.balances.set(quote, taker.balances.get(quote) + (cost - fee));
            taker.balances.set(base, taker.balances.get(base) - size);
            maker.balances.set(quote, maker.balances.get(quote) - cost);
            maker.balances.set(base, maker.balances.get(base) + size);
        }
        await maker.save();
    }
}

const engine = new PrivateExchange();

// --- 4. LIQUIDITY GENERATOR (Injects Orders) ---
// This mimics a real market so the Arb Bot has something to scan
async function injectLiquidity() {
    console.log("Injecting Synthetic Liquidity into 150 books...");
    const symbols = engine.coins; // C1...C149
    
    for (const sym of symbols) {
        // Create price for Coin/USDT (Randomized around $10)
        const priceUSDT = 10 + (Math.random() * 2 - 1); 
        await engine.placeOrder('MARKET_MAKER', `${sym}/USDT`, 'sell', priceUSDT + 0.05, 10);
        await engine.placeOrder('MARKET_MAKER', `${sym}/USDT`, 'buy', priceUSDT - 0.05, 10);

        // Create price for Coin/BTC (Randomized around 0.0001 BTC)
        const priceBTC = 0.0001 + (Math.random() * 0.00002 - 0.00001);
        await engine.placeOrder('MARKET_MAKER', `${sym}/BTC`, 'sell', priceBTC + 0.000001, 10);
        await engine.placeOrder('MARKET_MAKER', `${sym}/BTC`, 'buy', priceBTC - 0.000001, 10);
    }
    // Also provide BTC/USDT liquidity
    await engine.placeOrder('MARKET_MAKER', 'BTC/USDT', 'sell', 60000.10, 5);
    await engine.placeOrder('MARKET_MAKER', 'BTC/USDT', 'buy', 59999.90, 5);
}

// --- 5. TRIANGULAR ARB BOT ---
async function runArbBot() {
    console.log("Internal Arb Bot Scanning...");
    while (true) {
        const books = await OrderBook.find();
        const map = {};
        books.forEach(b => map[b.pair] = b);

        for (const sym of engine.coins) {
            try {
                // Path: USDT -> BTC -> Coin -> USDT
                const p1 = map['BTC/USDT']?.sells[0]?.price;
                const p2 = map[`${sym}/BTC`]?.sells[0]?.price;
                const p3 = map[`${sym}/USDT`]?.buys[0]?.price;

                if (p1 && p2 && p3) {
                    const result = (100 / p1 / p2) * p3 * Math.pow(0.9995, 3);
                    if (result > 100.05) {
                        console.log(`[PROFIT] Triangle Found on ${sym}: $${(result - 100).toFixed(4)}`);
                        // Execute the Arb trades against the Market Maker
                        await engine.placeOrder('ARB_BOT', 'BTC/USDT', 'buy', p1, 100/p1);
                        await engine.placeOrder('ARB_BOT', `${sym}/BTC`, 'buy', p2, (100/p1)/p2);
                        await engine.placeOrder('ARB_BOT', `${sym}/USDT`, 'sell', p3, (100/p1)/p2);
                    }
                }
            } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

// --- 6. API & UI ---
app.get('/api/stats', async (req, res) => {
    const arb = await engine.getAccount('ARB_BOT');
    const mm = await engine.getAccount('MARKET_MAKER');
    res.json({ arbBalance: arb.balances, mmBalance: mm.balances });
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#f1f5f9; font-family:monospace; padding:20px;">
            <h2>Private Exchange: 150 Coins + Arb Bot</h2>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <div style="background:#0f172a; padding:15px; border-radius:10px;">
                    <h3>Arb Bot Performance (Ledger)</h3>
                    <pre id="arb" style="font-size:0.7rem; height:400px; overflow-y:auto;"></pre>
                </div>
                <div style="background:#0f172a; padding:15px; border-radius:10px;">
                    <h3>Market Maker Inventory</h3>
                    <pre id="mm" style="font-size:0.7rem; height:400px; overflow-y:auto;"></pre>
                </div>
            </div>
            <script>
                async function update() {
                    const res = await fetch('/api/stats');
                    const d = await res.json();
                    document.getElementById('arb').innerText = JSON.stringify(d.arbBalance, null, 2);
                    document.getElementById('mm').innerText = JSON.stringify(d.mmBalance, null, 2);
                }
                setInterval(update, 3000); update();
            </script>
        </body>
    `);
});

app.listen(port, async () => {
    await injectLiquidity(); // Fill books once at start
    setInterval(injectLiquidity, 60000); // Re-fill every minute
    runArbBot();
});
