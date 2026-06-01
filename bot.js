require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    symbol: 'DOGE-USDT',
    leverage: 20,
    port: 3000,
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    totalAccounts: 50,
    baseVolume: 1000,        // 1000 DOGE per account
    resetDiffThreshold: 1.5, // Reset trigger percentage
    takerFeeRate: 0.0005,
    initialBalance: 1000
};

let market = { bid: 0, ask: 0, spread: 0, status: 'WAITING FOR DATA', totalNetGain: 0 };
let tradeHistory = [];
let accounts = {};

// Initialize 50 Accounts (1-25 are Long, 26-50 are Short)
for (let i = 1; i <= config.totalAccounts; i++) {
    accounts[i] = {
        id: i,
        direction: i <= 25 ? 'buy' : 'sell',
        pairId: i <= 25 ? i : i - 25, // Pair 1 is Acc 1 and Acc 26
        volume: 0,
        entryPrice: 0,
        roi: 0,
        pnl: 0,
        balance: config.initialBalance,
        lastAction: 'Idle'
    };
}

// ==================== ENGINE CORE ====================

function logTrade(id, type, side, pnl) {
    tradeHistory.unshift({
        time: new Date().toLocaleTimeString(),
        acc: id,
        type: type,
        side: side.toUpperCase(),
        pnl: pnl.toFixed(4)
    });
    if (tradeHistory.length > 30) tradeHistory.pop();
}

function openPosition(id) {
    const acc = accounts[id];
    const price = acc.direction === 'buy' ? market.ask : market.bid;
    const fee = config.baseVolume * price * config.takerFeeRate;
    
    acc.entryPrice = price;
    acc.volume = config.baseVolume;
    acc.balance -= fee;
    acc.lastAction = 'OPEN';
    // No logging for mass start to keep feed clean, only logging resets
}

function resetAccount(id) {
    const acc = accounts[id];
    const priceClose = acc.direction === 'buy' ? market.bid : market.ask;
    const pnl = acc.direction === 'buy' 
        ? (priceClose - acc.entryPrice) * acc.volume 
        : (acc.entryPrice - priceClose) * acc.volume;
    const fee = acc.volume * priceClose * config.takerFeeRate;
    
    acc.balance += (pnl - fee);
    logTrade(id, 'RESET', acc.direction, pnl - fee);

    // Re-open at new price
    const priceOpen = acc.direction === 'buy' ? market.ask : market.bid;
    const feeOpen = config.baseVolume * priceOpen * config.takerFeeRate;
    acc.entryPrice = priceOpen;
    acc.balance -= feeOpen;
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo` })));
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                market.bid = msg.tick.bid[0];
                market.ask = msg.tick.ask[0];
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                market.status = 'ACTIVE';

                let tempTotalGain = 0;

                // 1. MASS START & UPDATE STATS
                for (let i = 1; i <= config.totalAccounts; i++) {
                    const acc = accounts[i];
                    
                    // Trigger "START ALL" if not opened
                    if (acc.volume === 0) openPosition(i);

                    // Update live ROI and PnL
                    const curPrice = acc.direction === 'buy' ? market.bid : market.ask;
                    acc.pnl = acc.direction === 'buy'
                        ? (curPrice - acc.entryPrice) * acc.volume
                        : (acc.entryPrice - curPrice) * acc.volume;
                    acc.roi = (acc.pnl / (acc.entryPrice * acc.volume / config.leverage)) * 100;
                    
                    tempTotalGain += (acc.pnl + (acc.balance - config.initialBalance));
                }
                market.totalNetGain = tempTotalGain;

                // 2. PAIR RESET LOGIC (Checking 25 pairs)
                for (let p = 1; p <= 25; p++) {
                    const longAcc = accounts[p];
                    const shortAcc = accounts[p + 25];

                    const diffSum = Math.max(longAcc.roi, shortAcc.roi) - (market.spread * config.leverage);
                    
                    if (diffSum >= config.resetDiffThreshold) {
                        // Reset the one with the lower ROI in the pair
                        const loserId = longAcc.roi < shortAcc.roi ? longAcc.id : shortAcc.id;
                        resetAccount(loserId);
                    }
                }
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== DASHBOARD ====================

app.get('/status', (req, res) => res.json({ market, accounts, tradeHistory }));

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>50-Acc DOGE Cluster</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            body { background: #020617; color: white; font-family: 'Inter', sans-serif; }
            .grid-container { display: grid; grid-template-columns: repeat(10, 1fr); gap: 8px; }
            .acc-box { background: #0f172a; border: 1px solid #1e293b; padding: 8px; border-radius: 4px; text-align: center; }
            .roi-text { font-weight: 900; font-size: 14px; }
        </head>
        <body class="p-6">
            <div class="max-w-7xl mx-auto">
                <div class="flex justify-between items-end mb-6">
                    <div>
                        <h1 class="text-xl font-black text-indigo-500 uppercase tracking-tighter">DOGE Cluster Engine</h1>
                        <p class="text-xs text-slate-500">50 Virtual Accounts | DOGE-USDT | 20x Leverage</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs font-bold text-slate-500">CLUSTER NET PNL</p>
                        <p id="totalNet" class="text-4xl font-black text-white">$0.00</p>
                    </div>
                </div>

                <div class="grid-container mb-8" id="accGrid"></div>

                <div class="grid grid-cols-3 gap-6">
                    <div class="col-span-2 bg-slate-900/50 p-4 rounded-lg border border-slate-800">
                        <h3 class="text-xs font-bold text-slate-500 mb-3 uppercase">Reset History</h3>
                        <div id="logs" class="space-y-1 h-48 overflow-y-auto text-[10px] font-mono"></div>
                    </div>
                    <div class="bg-slate-900/50 p-4 rounded-lg border border-slate-800">
                        <h3 class="text-xs font-bold text-slate-500 mb-3 uppercase">Market Data</h3>
                        <div class="text-sm space-y-2">
                            <div class="flex justify-between"><span>DOGE:</span><span id="price" class="text-indigo-400 font-bold">0.0000</span></div>
                            <div class="flex justify-between"><span>Spread:</span><span id="spread">0.00%</span></div>
                            <div class="flex justify-between"><span>Status:</span><span id="status" class="text-emerald-400">WAITING</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                const grid = document.getElementById('accGrid');
                for(let i=1; i<=50; i++) {
                    grid.innerHTML += \`
                        <div id="box-\${i}" class="acc-box">
                            <div class="text-[9px] text-slate-500 font-bold">#\${i} \${i<=25?'L':'S'}</div>
                            <div id="roi-\${i}" class="roi-text">0.0%</div>
                        </div>
                    \`;
                }

                setInterval(async () => {
                    const res = await fetch('/status');
                    const d = await res.json();
                    
                    document.getElementById('totalNet').innerText = (d.market.totalNetGain >= 0 ? '$' : '-$') + Math.abs(d.market.totalNetGain).toFixed(2);
                    document.getElementById('totalNet').className = 'text-4xl font-black ' + (d.market.totalNetGain >= 0 ? 'text-emerald-400' : 'text-rose-500');
                    document.getElementById('price').innerText = d.market.bid;
                    document.getElementById('spread').innerText = d.market.spread.toFixed(3) + '%';
                    document.getElementById('status').innerText = d.market.status;

                    Object.values(d.accounts).forEach(acc => {
                        const el = document.getElementById('roi-'+acc.id);
                        el.innerText = acc.roi.toFixed(1) + '%';
                        el.className = 'roi-text ' + (acc.roi >= 0 ? 'text-emerald-400' : 'text-rose-500');
                        document.getElementById('box-'+acc.id).style.borderColor = acc.roi > 5 ? '#10b981' : acc.roi < -5 ? '#f43f5e' : '#1e293b';
                    });

                    document.getElementById('logs').innerHTML = d.tradeHistory.map(h => \`
                        <div class="flex justify-between border-b border-slate-800 pb-1">
                            <span>\${h.time}</span>
                            <span class="text-indigo-400">ACC #\${h.acc}</span>
                            <span class="font-bold">\${h.type}</span>
                            <span class="\${parseFloat(h.pnl) >= 0 ? 'text-emerald-400' : 'text-rose-500'}">\$\${h.pnl}</span>
                        </div>
                    \`).join('');
                }, 1000);
            </script>
        </body>
    </html>
    `);
});

startWS();
app.listen(config.port, () => console.log(`Mass Cluster Online: Port ${config.port}`));
