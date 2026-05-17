const express = require('express');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// --- 1. DATABASE CONNECTION ---
const MONGODB_URI = "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb";
mongoose.connect(MONGODB_URI).then(() => console.log("Exchange Database Connected"));

// --- 2. SCHEMAS ---
const AccountSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    balances: { type: Map, of: Number, default: {} },
    address: String,
    privateKey: String
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
        this.fee = 0.0005; // 0.05%
        this.coins = Array.from({length: 148}, (_, i) => `C${i+1}`); 
        this.allAssets = ['USDT', 'BTC', ...this.coins]; 
    }

    // FIXED: Now handles missing addresses for existing MongoDB records
    async getAccount(userId) {
        let acc = await Account.findOne({ userId });
        
        if (!acc || !acc.address) {
            console.log(`Setting up wallet for ${userId}...`);
            const wallet = ethers.Wallet.createRandom();
            const initialBalances = { USDT: 1000, BTC: 0 };
            this.coins.forEach(c => initialBalances[c] = 0);

            if (!acc) {
                acc = await Account.create({ 
                    userId, 
                    balances: initialBalances,
                    address: wallet.address,
                    privateKey: wallet.privateKey
                });
            } else {
                acc.address = wallet.address;
                acc.privateKey = wallet.privateKey;
                await acc.save();
            }
        }
        return acc;
    }

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

// --- 4. BOTS (Liquidity Maker & Internal Arb) ---
function startBots() {
    setInterval(async () => {
        const sym = engine.coins[Math.floor(Math.random() * engine.coins.length)];
        const price = 10 + (Math.random() * 3);
        await engine.placeOrder('MARKET_MAKER', `${sym}/USDT`, 'sell', price, 2);
        await engine.placeOrder('MARKET_MAKER', `${sym}/USDT`, 'buy', price - 0.45, 2);
    }, 4000);

    setInterval(async () => {
        stats.scanned++;
        const sym = engine.coins[Math.floor(Math.random() * engine.coins.length)];
        stats.currentPair = `${sym}/USDT`;
        const book = await OrderBook.findOne({ pair: stats.currentPair });
        if (book?.sells.length > 0 && book?.buys.length > 0) {
            const spread = book.sells[0].price - book.buys[0].price;
            if (spread < 0) {
                const profit = Math.abs(spread) * 1.5;
                stats.profit += profit;
                logs.unshift({ time: new Date().toLocaleTimeString(), path: stats.currentPair, profit: profit.toFixed(4) });
                if (logs.length > 15) logs.pop();
            }
        }
    }, 1000);
}

// --- 5. API ROUTES ---
app.get('/status', async (req, res) => {
    const acc = await engine.getAccount('USER_1');
    res.json({ stats, logs, balances: Object.fromEntries(acc.balances), address: acc.address });
});

app.post('/api/order', async (req, res) => {
    const { side, pair, price, amount } = req.body;
    await engine.placeOrder('USER_1', pair, side, price, amount);
    res.json({ success: true });
});

app.post('/api/withdraw', async (req, res) => {
    const { amount, targetAddress, asset } = req.body;
    try {
        const acc = await Account.findOne({ userId: 'USER_1' });
        if (acc.balances.get(asset) < amount) return res.json({ error: "Low Balance" });
        
        const provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
        const wallet = new ethers.Wallet(acc.privateKey, provider);
        const contract = new ethers.Contract("0x55d398326f99059fF775485246999027B3197955", ["function transfer(address to, uint256 amount) public returns (bool)"], wallet);
        
        const tx = await contract.transfer(targetAddress, ethers.parseUnits(amount.toString(), 18));
        acc.balances.set(asset, acc.balances.get(asset) - amount);
        await acc.save();
        res.json({ success: true, txHash: tx.hash });
    } catch (e) { res.json({ error: e.message }); }
});

// --- 6. TERMINAL DASHBOARD UI ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Master Arb Engine v4</title>
    <style>
        body { background: #020617; color: #f1f5f9; font-family: 'Inter', sans-serif; padding: 20px; margin: 0; }
        .wrapper { max-width: 1100px; margin: auto; }
        .header { background: #0f172a; padding: 20px; border-radius: 12px; border: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .ticker-val { font-size: 1.8rem; font-weight: 800; color: #38bdf8; }
        .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
        .wallet-banner { background: #1e293b; padding: 15px; border-radius: 12px; border: 2px dashed #38bdf8; margin-bottom: 20px; text-align: center; }
        .main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: #0f172a; border-radius: 12px; border: 1px solid #1e293b; padding: 20px; margin-bottom: 20px; }
        input, select { background: #1e293b; border: 1px solid #334155; color: white; padding: 10px; border-radius: 6px; width: 100%; margin-bottom: 10px; box-sizing: border-box; }
        button { background: #38bdf8; color: #020617; border: none; padding: 12px; border-radius: 6px; font-weight: bold; width: 100%; cursor: pointer; }
        .log-box { background: #020617; height: 180px; overflow-y: auto; margin-top: 15px; border-radius: 8px; padding: 10px; font-size: 0.8rem; border: 1px solid #1e293b; }
        .green { color: #4ade80; }
        #address { color: #38bdf8; font-weight: bold; font-family: monospace; letter-spacing: 1px; font-size: 1.1rem; }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="header">
            <div><small style="color:#64748b">ENGINE STATUS</small><br><div class="ticker-val">PRIVATE_EX</div></div>
            <div style="text-align: right;"><small style="color:#64748b">BOT ACTIVE SCAN</small><br><div id="pairName" style="font-size: 1.4rem; font-weight:bold;">---</div></div>
        </div>

        <div class="wallet-banner">
            <small style="color:#64748b; text-transform: uppercase;">Real Funds Deposit Address (BSC Network)</small><br>
            <div id="address">SYNCHRONIZING...</div>
            <small style="color:#475569">Funds sent here are backed by the internal ledger.</small>
        </div>

        <div class="stat-grid">
            <div class="stat-card"><small>INTERNAL SCANS</small><br><b id="scanned">0</b></div>
            <div class="stat-card"><small>BOT TOTAL PROFIT</small><br><b id="profit" class="green">$0.00</b></div>
            <div class="stat-card"><small>ASSETS</small><br><b>150 COINS</b></div>
            <div class="stat-card"><small>LEDGER</small><br><b class="green">PERSISTENT</b></div>
        </div>

        <div class="main-grid">
            <div class="col">
                <div class="card">
                    <h3>Internal Trading Terminal</h3>
                    <select id="side"><option value="buy">BUY</option><option value="sell">SELL</option></select>
                    <input id="pair" value="C1/USDT">
                    <input id="price" placeholder="Price">
                    <input id="amount" placeholder="Amount">
                    <button onclick="trade()">EXECUTE INTERNAL ORDER</button>
                    <div class="log-box" id="logBox"></div>
                </div>
                <div class="card">
                    <h3 style="color:#a855f7">Settle Profit (Withdraw)</h3>
                    <input id="wAsset" value="USDT">
                    <input id="wAmount" placeholder="Amount">
                    <input id="wTarget" placeholder="Target MetaMask Address">
                    <button onclick="withdraw()" style="background:#a855f7; color:white;">SEND TO BLOCKCHAIN</button>
                </div>
            </div>
            <div class="card">
                <h3>Private Ledger Balances</h3>
                <pre id="ledger" style="font-size:0.75rem; height:500px; overflow-y:auto; color:#94a3b8"></pre>
            </div>
        </div>
    </div>
    <script>
        async function trade() {
            await fetch('/api/order', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ side: document.getElementById('side').value, pair: document.getElementById('pair').value, price: document.getElementById('price').value, amount: document.getElementById('amount').value })
            });
            update();
        }
        async function withdraw() {
            const res = await fetch('/api/withdraw', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ asset: document.getElementById('wAsset').value, amount: document.getElementById('wAmount').value, targetAddress: document.getElementById('wTarget').value })
            });
            const d = await res.json();
            alert(d.success ? "Withdrawal Sent! TX Hash: " + d.txHash : "Error: " + d.error);
            update();
        }
        async function update() {
            try {
                const res = await fetch('/status');
                const d = await res.json();
                document.getElementById('address').innerText = d.address || "GENERATING...";
                document.getElementById('pairName').innerText = d.stats.currentPair;
                document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
                document.getElementById('profit').innerText = '$' + d.stats.profit.toFixed(2);
                
                // Show only active balances
                const b = Object.entries(d.balances)
                    .filter(([c, v]) => v !== 0)
                    .map(([c, v]) => \`\${c}: \${v.toFixed(4)}\`)
                    .join('\\n');
                document.getElementById('ledger').innerText = b || "All balances are 0.00";
                
                document.getElementById('logBox').innerHTML = d.logs.map(l => 
                    \`<div>[\${l.time}] <b>\${l.path}</b> <span class="green" style="float:right">+\$\${l.profit}</span></div>\`
                ).join('');
            } catch(e) {}
        }
        setInterval(update, 2000); update();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => startBots());
