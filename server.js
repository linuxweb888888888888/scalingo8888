const express = require('express');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// --- 1. DATABASE CONNECTION ---
const MONGODB_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb";
mongoose.connect(MONGODB_URI);

// --- 2. SCHEMAS (Updated with Wallet fields) ---
const AccountSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    balances: { type: Map, of: Number, default: {} },
    address: String,      // Real Blockchain Address
    privateKey: String    // Encrypted in a real app, but for now saved here
});
const OrderBookSchema = new mongoose.Schema({
    pair: { type: String, unique: true },
    buys: { type: Array, default: [] },
    sells: { type: Array, default: [] }
});
const Account = mongoose.model('Account', AccountSchema);
const OrderBook = mongoose.model('OrderBook', OrderBookSchema);

// --- 3. EXCHANGE ENGINE ---
class PrivateExchange {
    constructor() {
        this.fee = 0.0005; 
        this.coins = Array.from({length: 148}, (_, i) => `C${i+1}`); 
        this.allAssets = ['USDT', 'BTC', ...this.coins]; 
    }

    async getAccount(userId) {
        let acc = await Account.findOne({ userId });
        if (!acc) {
            // GENERATE REAL WALLET FOR DEPOSITS
            const wallet = ethers.Wallet.createRandom();
            const initialBalances = { USDT: 0, BTC: 0 };
            this.coins.forEach(c => initialBalances[c] = 0);

            acc = await Account.create({ 
                userId, 
                balances: initialBalances,
                address: wallet.address,
                privateKey: wallet.privateKey
            });
        }
        return acc;
    }

    // [Matching Engine Logic remains the same as previous step]
    async placeOrder(userId, pair, side, price, amount) {
        let book = await OrderBook.findOne({ pair }) || await OrderBook.create({ pair });
        const takerOrder = { userId, side, price: parseFloat(price), amount: parseFloat(amount), id: uuidv4() };
        let opposite = side === 'buy' ? book.sells : book.buys;
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
        if (takerOrder.amount > 0) side === 'buy' ? book.buys.push(takerOrder) : book.sells.push(takerOrder);
        await OrderBook.updateOne({ pair }, { buys: book.buys, sells: book.sells });
        await takerAcc.save();
    }

    async executeTrade(taker, maker, size, price, pair, side) {
        const [base, quote] = pair.split('/');
        const cost = size * price;
        const fee = cost * this.fee;
        if (side === 'buy') {
            taker.balances.set(quote, (taker.balances.get(quote) || 0) - (cost + fee));
            taker.balances.set(base, (taker.balances.get(base) || 0) + size);
            maker.balances.set(quote, (maker.balances.get(quote) || 0) + cost);
            maker.balances.set(base, (maker.balances.get(base) || 0) - size);
        } else {
            taker.balances.set(quote, (taker.balances.get(quote) || 0) + (cost - fee));
            taker.balances.set(base, (taker.balances.get(base) || 0) - size);
            maker.balances.set(quote, (maker.balances.get(quote) || 0) - cost);
            maker.balances.set(base, (maker.balances.get(base) || 0) + size);
        }
        await maker.save();
    }
}

const engine = new PrivateExchange();
let logs = [];
let stats = { scanned: 0, profit: 0, currentPair: '---' };

// --- 4. ROUTES & UI ---
app.get('/status', async (req, res) => {
    const acc = await engine.getAccount('USER_1');
    res.json({ 
        stats, 
        logs, 
        balances: Object.fromEntries(acc.balances),
        address: acc.address // Send address to UI
    });
});

app.post('/api/order', async (req, res) => {
    const { side, pair, price, amount } = req.body;
    await engine.placeOrder('USER_1', pair, side, price, amount);
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Private Arb Engine</title>
    <style>
        body { background: #020617; color: #f1f5f9; font-family: 'Inter', sans-serif; padding: 20px; margin: 0; }
        .wrapper { max-width: 1100px; margin: auto; }
        .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .ticker-val { font-size: 1.8rem; font-weight: 800; color: #38bdf8; }
        .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
        .wallet-card { background: #1e293b; padding: 15px; border-radius: 12px; border: 2px dashed #38bdf8; margin-bottom: 20px; text-align: center; }
        .main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: #0f172a; border-radius: 12px; border: 1px solid #1e293b; padding: 20px; }
        input, select { background: #1e293b; border: 1px solid #334155; color: white; padding: 10px; border-radius: 6px; width: 100%; margin-bottom: 10px; box-sizing: border-box; }
        button { background: #38bdf8; color: #020617; border: none; padding: 12px; border-radius: 6px; font-weight: bold; width: 100%; cursor: pointer; }
        .green { color: #4ade80; }
        #address { color: #38bdf8; font-family: monospace; font-weight: bold; letter-spacing: 1px; }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="header">
            <div><small style="color:#64748b">PRIVATE EXCHANGE ENGINE</small><br><div class="ticker-val">INTERNAL</div></div>
            <div style="text-align: right;"><small style="color:#64748b">SCANNING PAIR</small><br><div id="pairName" style="font-size: 1.4rem; font-weight:bold;">---</div></div>
        </div>

        <div class="wallet-card">
            <small style="color:#64748b; text-transform: uppercase;">Real Funds Deposit Address (BSC Network)</small><br>
            <div id="address">Loading...</div>
            <small style="color:#475569">Send USDT (BEP-20) here. Once confirmed, manual credit is required in this demo.</small>
        </div>

        <div class="stat-grid">
            <div class="stat-card"><small style="color:#64748b">SCANS</small><br><b id="scanned">0</b></div>
            <div class="stat-card"><small style="color:#64748b">BOT PROFIT</small><br><b id="profit" class="green">$0.00</b></div>
            <div class="stat-card"><small style="color:#64748b">ASSETS</small><br><b>150 COINS</b></div>
            <div class="stat-card"><small style="color:#64748b">DATABASE</small><br><b class="green">PERSISTENT</b></div>
        </div>

        <div class="main-grid">
            <div class="card">
                <h3 style="margin-top:0">Trading Terminal</h3>
                <select id="side"><option value="buy">BUY</option><option value="sell">SELL</option></select>
                <input id="pair" value="BTC/USDT">
                <input id="price" placeholder="Price">
                <input id="amount" placeholder="Amount">
                <button onclick="trade()">EXECUTE ORDER</button>
            </div>
            <div class="card">
                <h3 style="margin-top:0">Internal Ledger</h3>
                <pre id="ledger" style="font-size:0.75rem; height:400px; overflow-y:auto; color:#94a3b8"></pre>
            </div>
        </div>
    </div>
    <script>
        async function trade() {
            await fetch('/api/order', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    side: document.getElementById('side').value,
                    pair: document.getElementById('pair').value,
                    price: document.getElementById('price').value,
                    amount: document.getElementById('amount').value
                })
            });
            update();
        }
        async function update() {
            const res = await fetch('/status');
            const d = await res.json();
            document.getElementById('address').innerText = d.address;
            document.getElementById('pairName').innerText = d.stats.currentPair;
            document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
            document.getElementById('profit').innerText = '$' + d.stats.profit.toFixed(2);
            document.getElementById('ledger').innerText = JSON.stringify(d.balances, null, 2);
        }
        setInterval(update, 2000); update();
    </script>
</body>
</html>
    `);
});

app.listen(port);
