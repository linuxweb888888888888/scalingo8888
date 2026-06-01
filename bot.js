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
    // FIX: Scalingo provides the port via process.env.PORT
    port: process.env.PORT || 3000, 
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    totalAccounts: 50,
    baseVolume: 1000,
    resetDiffThreshold: 1.5,
    takerFeeRate: 0.0005,
    initialBalance: 1000
};

let market = { bid: 0, ask: 0, spread: 0, status: 'WAITING FOR DATA', totalNetGain: 0 };
let tradeHistory = [];
let accounts = {};

// Initialize 50 Accounts
for (let i = 1; i <= config.totalAccounts; i++) {
    accounts[i] = {
        id: i,
        direction: i <= 25 ? 'buy' : 'sell',
        pairId: i <= 25 ? i : i - 25,
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
    if (!price) return; // Don't open if market data hasn't arrived
    const fee = config.baseVolume * price * config.takerFeeRate;
    acc.entryPrice = price;
    acc.volume = config.baseVolume;
    acc.balance -= fee;
    acc.lastAction = 'OPEN';
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
                for (let i = 1; i <= config.totalAccounts; i++) {
                    const acc = accounts[i];
                    if (acc.volume === 0) openPosition(i);
                    const curPrice = acc.direction === 'buy' ? market.bid : market.ask;
                    acc.pnl = acc.direction === 'buy'
                        ? (curPrice - acc.entryPrice) * acc.volume
                        : (acc.entryPrice - curPrice) * acc.volume;
                    acc.roi = (acc.pnl / (acc.entryPrice * acc.volume / config.leverage)) * 100;
                    tempTotalGain += (acc.pnl + (acc.balance - config.initialBalance));
                }
                market.totalNetGain = tempTotalGain;

                for (let p = 1; p <= 25; p++) {
                    const longAcc = accounts[p];
                    const shortAcc = accounts[p + 25];
                    const diffSum = Math.max(longAcc.roi, shortAcc.roi) - (market.spread * config.leverage);
                    if (diffSum >= config.resetDiffThreshold) {
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

// ==================== DASHBOARD UI ====================
app.get('/status', (req, res) => res.json({ market, accounts, tradeHistory }));
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>DOGE Cluster</title><script src="https://cdn.tailwindcss.com"></script><style>body{background:#020617;color:white;font-family:sans-serif;}.grid-container{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;}.acc-box{background:#0f172a;border:1px solid #1e293b;padding:8px;border-radius:4px;text-align:center;}.roi-text{font-weight:900;font-size:12px;}</style></head><body class="p-4"><div class="max-w-7xl mx-auto"><div class="flex justify-between items-end mb-6"><div><h1 class="text-xl font-black text-indigo-500 uppercase">DOGE Cluster</h1><p class="text-xs text-slate-500">50 Virtual Accounts</p></div><div class="text-right"><p id="totalNet" class="text-3xl font-black text-white">$0.00</p></div></div><div class="grid-container mb-8" id="accGrid"></div><div id="logs" class="text-[10px] font-mono space-y-1 h-32 overflow-y-auto bg-slate-900 p-2 rounded"></div></div><script>const grid=document.getElementById('accGrid');for(let i=1;i<=50;i++){grid.innerHTML+='<div id="box-'+i+'" class="acc-box"><div class="text-[8px] text-slate-500 font-bold">#'+i+'</div><div id="roi-'+i+'" class="roi-text">0%</div></div>';}setInterval(async()=>{const r=await fetch('/status');const d=await r.json();document.getElementById('totalNet').innerText='$'+d.market.totalNetGain.toFixed(2);Object.values(d.accounts).forEach(acc=>{const el=document.getElementById('roi-'+acc.id);el.innerText=acc.roi.toFixed(1)+'%';el.className='roi-text '+(acc.roi>=0?'text-emerald-400':'text-rose-500');});document.getElementById('logs').innerHTML=d.tradeHistory.map(h=>'<div>'+h.time+' | ACC #'+h.acc+' | '+h.type+' | $'+h.pnl+'</div>').join('');},1000);</script></body></html>`);
});

// STARTING SERVER
// FIX: Bind to 0.0.0.0 and use the dynamic port
app.listen(config.port, '0.0.0.0', () => {
    console.log(`Application started on port ${config.port}`);
    startWS(); // Only start the WebSocket after the server is listening
});
