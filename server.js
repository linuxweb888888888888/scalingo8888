const express = require('express');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const ccxt = require('ccxt');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());

// --- 1. DATABASE CONNECTION ---
// Replace with your connection string in environment variables for safety
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb";

mongoose.connect(MONGODB_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Connection Error:", err));

// --- 2. DATABASE SCHEMAS ---
const WalletSchema = new mongoose.Schema({
    address: String,
    privateKey: String,
    createdAt: { type: Date, default: Date.now }
});

const StatsSchema = new mongoose.Schema({
    totalScanned: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },
    bestRoi: { type: Number, default: 0 }
});

const LogSchema = new mongoose.Schema({
    time: String,
    ex: String,
    path: String,
    roi: Number,
    profit: Number,
    color: String
});

const WalletModel = mongoose.model('Wallet', WalletSchema);
const StatsModel = mongoose.model('Stats', StatsSchema);
const LogModel = mongoose.model('Log', LogSchema);

// --- 3. EXCHANGE CONFIGURATION ---
const exchangeConfig = {
    mexc: { fee: 0.0005, color: '#00ff00', name: 'MEXC' },
    lbank: { fee: 0.0010, color: '#38bdf8', name: 'LBANK' },
    bitget: { fee: 0.0010, color: '#38bdf8', name: 'BITGET' },
    phemex: { fee: 0.0010, color: '#facc15', name: 'PHEMEX' },
    bitrue: { fee: 0.00098, color: '#ef4444', name: 'BITRUE' },
    coinex: { fee: 0.0020, color: '#10b981', name: 'COINEX' },
    htx: { fee: 0.0020, color: '#818cf8', name: 'HTX' },
    xt: { fee: 0.0020, color: '#a855f7', name: 'XT' }
};

// --- 4. BOT ENGINE ---
let masterWallet = null;
let currentStats = { scanned: 0, profit: 0, bestRoi: 0 };
let currentEx = "Initializing...";
let currentPair = "---";

async function init() {
    // A. Handle Wallet Persistence
    let walletData = await WalletModel.findOne();
    if (!walletData) {
        console.log("No wallet found. Generating new master wallet...");
        const newWallet = ethers.Wallet.createRandom();
        walletData = await WalletModel.create({
            address: newWallet.address,
            privateKey: newWallet.privateKey
        });
    }
    masterWallet = new ethers.Wallet(walletData.privateKey);
    console.log(`Master Wallet Active: ${masterWallet.address}`);

    // B. Handle Stats Persistence
    const dbStats = await StatsModel.findOne();
    if (dbStats) {
        currentStats.scanned = dbStats.totalScanned;
        currentStats.profit = dbStats.totalProfit;
        currentStats.bestRoi = dbStats.bestRoi;
    } else {
        await StatsModel.create({});
    }

    runScanner();
}

async function runScanner() {
    const ids = Object.keys(exchangeConfig);
    while (true) {
        for (const id of ids) {
            try {
                currentEx = exchangeConfig[id].name;
                const ex = new ccxt[id]({ enableRateLimit: true });
                const markets = await ex.loadMarkets();
                const symbols = Object.keys(markets).filter(s => markets[s].active);
                
                const quotes = ['BTC', 'ETH', 'USDC'];
                const paths = [];
                for (const q of quotes) {
                    const cross = symbols.filter(s => markets[s].quote === q);
                    for (const cp of cross) {
                        const alt = cp.split('/')[0];
                        if (markets[`${alt}/USDT`] && markets[`${q}/USDT`]) {
                            paths.push([`${q}/USDT`, cp, `${alt}/USDT`]);
                        }
                    }
                }

                const tickers = await ex.fetchTickers();
                for (const [s1, s2, s3] of paths) {
                    currentPair = s2;
                    currentStats.scanned++;
                    const t1 = tickers[s1], t2 = tickers[s2], t3 = tickers[s3];
                    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;

                    const net = (100 / t1.ask / t2.ask) * t3.bid * Math.pow((1 - exchangeConfig[id].fee), 3);
                    const roi = net - 100;

                    if (roi > 0.01 && roi < 15) {
                        currentStats.profit += roi;
                        if (roi > currentStats.bestRoi) currentStats.bestRoi = roi;

                        await LogModel.create({
                            time: new Date().toLocaleTimeString(),
                            ex: currentEx,
                            path: `${s1}>${s2}>${s3}`,
                            roi: roi.toFixed(4),
                            profit: roi.toFixed(4),
                            color: exchangeConfig[id].color
                        });

                        // Update DB stats every profit found
                        await StatsModel.updateOne({}, {
                            totalScanned: currentStats.scanned,
                            totalProfit: currentStats.profit,
                            bestRoi: currentStats.bestRoi
                        });
                    }
                }
                // Memory Cleanup
                ex.markets = {};
                if (global.gc) global.gc();
            } catch (e) {
                console.log(`Scan Error ${id}: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// --- 5. UI & API ---
app.get('/status', async (req, res) => {
    const recentLogs = await LogModel.find().sort({ _id: -1 }).limit(20);
    res.json({ stats: currentStats, logs: recentLogs, wallet: masterWallet.address, currentEx, currentPair });
});

app.get('/', (req, res) => {
    res.send(`
        <body style="background:#020617; color:#f1f5f9; font-family:monospace; padding:20px;">
            <div style="max-width:900px; margin:auto;">
                <h2 style="color:#38bdf8">ArbFleet Pro + MongoDB Persistence</h2>
                <div style="background:#0f172a; padding:15px; border-radius:8px; border:1px solid #1e293b; margin-bottom:15px;">
                    <div>WALLET: <b id="wAddr">...</b></div>
                    <div style="margin-top:10px;">ENGINE: <b id="exName">...</b> | SCANNING: <b id="pName">...</b></div>
                </div>
                <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-bottom:15px;">
                    <div style="background:#1e293b; padding:10px; border-radius:5px; text-align:center;">SCANS<br><b id="scanned">0</b></div>
                    <div style="background:#1e293b; padding:10px; border-radius:5px; text-align:center;">BEST ROI<br><b id="roi" style="color:#4ade80">0%</b></div>
                    <div style="background:#1e293b; padding:10px; border-radius:5px; text-align:center;">TOTAL PROFIT<br><b id="profit" style="color:#4ade80">$0.00</b></div>
                </div>
                <div id="logBox" style="background:#09090b; padding:15px; height:400px; overflow-y:auto; border-radius:8px; border:1px solid #1e293b;"></div>
            </div>
            <script>
                async function update() {
                    const r = await fetch('/status'); const d = await r.json();
                    document.getElementById('wAddr').innerText = d.wallet;
                    document.getElementById('exName').innerText = d.currentEx;
                    document.getElementById('pName').innerText = d.currentPair;
                    document.getElementById('scanned').innerText = d.stats.scanned.toLocaleString();
                    document.getElementById('roi').innerText = d.stats.bestRoi.toFixed(3) + '%';
                    document.getElementById('profit').innerText = '$' + d.stats.profit.toFixed(2);
                    document.getElementById('logBox').innerHTML = d.logs.map(l => 
                        '<div style="border-bottom:1px solid #1e293b; padding:5px 0;"><b>['+l.ex+']</b> '+l.path+' <span style="float:right" style="color:#4ade80">+$'+l.profit+'</span></div>'
                    ).join('');
                }
                setInterval(update, 1000);
            </script>
        </body>
    `);
});

app.listen(port, () => init());
