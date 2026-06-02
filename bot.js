const express = require('express');
const ccxt = require('ccxt');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(express.json());

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

// ==================== IN-MEMORY STATE ====================
const DEFAULT_CFG = {
    htxSymbol: 'SHIB/USDT:USDT',
    binanceSymbol: '1000SHIB/USDT:USDT',
    leverage: 75,
    baseContracts: 1,
    contractSize: 1000,
    takeProfitPct: 10.0,
    stopLossPct: -50.0,
    mlLookback: 50,
    mlThreshold: 60.0,
    dcaRoiThresholdPct: 1.0,
    dcaMultiplier: 2.0,
    maxContracts: 100
};

let appState = {
    config1: { ...DEFAULT_CFG },
    config2: { ...DEFAULT_CFG },
    activePos1: null,
    activePos2: null,
    metrics: { trades: [], totalNetPnl: 0, startTime: Date.now() },
    market: { mid: 0, tickBuffer: [], mlSignal: { confidence: 0, type: 'flat' } },
    liveTradingEnabled: process.env.LIVE_TRADING === 'true'
};

// ==================== EXCHANGE INITIALIZATION ====================
const htx1 = new ccxt.pro.htx({ 
    apiKey: process.env.HTX_API_KEY_1, 
    secret: process.env.HTX_SECRET_KEY_1, 
    agent: keepAliveAgent,
    options: { defaultType: 'swap', positionMode: 'hedged' }
});

const htx2 = new ccxt.pro.htx({ 
    apiKey: process.env.HTX_API_KEY_2, 
    secret: process.env.HTX_SECRET_KEY_2, 
    agent: keepAliveAgent,
    options: { defaultType: 'swap', positionMode: 'hedged' }
});

const binance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== ML ENGINE LOGIC ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat' };
    
    let X = [], y = [];
    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        let feat = [((prices[i] - prices[i-1]) / prices[i-1]) * 1000];
        X.push(feat);
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }

    let w = [0], b = 0, lr = 0.1;
    for (let e = 0; e < 10; e++) {
        for (let i = 0; i < X.length; i++) {
            let z = w[0] * X[i][0] + b;
            let pred = 1 / (1 + Math.exp(-z));
            let err = pred - y[i];
            w[0] -= lr * err * X[i][0];
            b -= lr * err;
        }
    }

    let lastFeat = [((prices[prices.length-1] - prices[prices.length-2]) / prices[prices.length-2]) * 1000];
    let finalZ = w[0] * lastFeat[0] + b;
    let prob = 1 / (1 + Math.exp(-finalZ));
    
    return { 
        confidence: Math.abs(prob - 0.5) * 200, 
        type: prob >= 0.5 ? 'bull' : 'bear',
        rawValue: prob
    };
}

// ==================== TRADING CORE ====================
async function checkLogic() {
    const sig = appState.market.mlSignal;
    const price = appState.market.mid;
    if (!price) return;

    // Account 1: LONG ONLY
    if (!appState.activePos1 && sig.type === 'bull' && sig.confidence >= appState.config1.mlThreshold) {
        await executeOpen(1, 'long', price);
    } else if (appState.activePos1) {
        await handlePosition(1, price);
    }

    // Account 2: SHORT ONLY
    if (!appState.activePos2 && sig.type === 'bear' && sig.confidence >= appState.config2.mlThreshold) {
        await executeOpen(2, 'short', price);
    } else if (appState.activePos2) {
        await handlePosition(2, price);
    }
}

async function executeOpen(accNum, side, price) {
    const config = accNum === 1 ? appState.config1 : appState.config2;
    const client = accNum === 1 ? htx1 : htx2;
    const qty = config.baseContracts;

    console.log(`[Acc ${accNum}] Signal Detected: Opening ${side.toUpperCase()}...`);
    
    if (appState.liveTradingEnabled) {
        try {
            await client.createMarketOrder(config.htxSymbol, side === 'long' ? 'buy' : 'sell', qty, undefined, { offset: 'open' });
        } catch (e) { console.error(`Acc ${accNum} Order Failed:`, e.message); return; }
    }

    const sizeUsd = qty * config.contractSize * price;
    const pos = { side, entryPrice: price, contracts: qty, size: sizeUsd, margin: sizeUsd / 75, lastDca: Date.now() };
    
    if (accNum === 1) appState.activePos1 = pos; else appState.activePos2 = pos;
}

async function handlePosition(accNum, price) {
    const pos = accNum === 1 ? appState.activePos1 : appState.activePos2;
    const config = accNum === 1 ? appState.config1 : appState.config2;
    
    const sideMult = pos.side === 'long' ? 1 : -1;
    const roi = ((price - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * 75;

    // Exit
    if (roi >= config.takeProfitPct || roi <= config.stopLossPct) {
        const client = accNum === 1 ? htx1 : htx2;
        if (appState.liveTradingEnabled) {
            try { await client.createMarketOrder(config.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { offset: 'close', reduceOnly: true }); } catch(e) {}
        }
        
        const netPnl = (roi / 100) * pos.margin;
        appState.metrics.totalNetPnl += netPnl;
        appState.metrics.trades.unshift({ acc: accNum, side: pos.side, entry: pos.entryPrice, exit: price, roi, pnl: netPnl, time: new Date().toLocaleTimeString() });
        if (appState.metrics.trades.length > 20) appState.metrics.trades.pop();

        if (accNum === 1) appState.activePos1 = null; else appState.activePos2 = null;
    } 
    // DCA
    else if (roi <= -config.dcaRoiThresholdPct && (Date.now() - pos.lastDca > 15000)) {
        const addQty = Math.floor(pos.contracts * config.dcaMultiplier);
        if (pos.contracts + addQty > config.maxContracts) return;

        if (appState.liveTradingEnabled) {
            const client = accNum === 1 ? htx1 : htx2;
            try { await client.createMarketOrder(config.htxSymbol, pos.side === 'long' ? 'buy' : 'sell', addQty, undefined, { offset: 'open' }); } catch(e) { return; }
        }

        const addSize = addQty * config.contractSize * price;
        pos.entryPrice = ((pos.entryPrice * pos.size) + (price * addSize)) / (pos.size + addSize);
        pos.size += addSize;
        pos.contracts += addQty;
        pos.margin = pos.size / 75;
        pos.lastDca = Date.now();
    }
}

// ==================== TICKER LOOP ====================
async function start() {
    console.log("🚀 Starting Dual-Acc Terminal...");
    while (true) {
        try {
            const ticker = await binance.watchTicker(DEFAULT_CFG.binanceSymbol);
            appState.market.mid = (ticker.bid + ticker.ask) / 2;
            appState.market.tickBuffer.push(appState.market.mid);
            if (appState.market.tickBuffer.length > 200) appState.market.tickBuffer.shift();

            appState.market.mlSignal = calculateMLSignal(appState.market.tickBuffer, 50);
            await checkLogic();
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
}

// ==================== WEB API & UI ====================
app.get('/api/status', (req, res) => res.json(appState));

app.post('/api/config', (req, res) => {
    const { acc, cfg } = req.body;
    if (acc === 1) appState.config1 = { ...appState.config1, ...cfg };
    else appState.config2 = { ...appState.config2, ...cfg };
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>SHIB Terminal</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap" rel="stylesheet">
    <style>body{font-family:'Roboto Mono',monospace;}</style>
</head>
<body class="bg-zinc-950 text-zinc-200 p-4">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8 border-b border-zinc-800 pb-4">
            <div>
                <h1 class="text-xl font-bold text-white">TRADEBOT<span class="text-yellow-500">PILLE</span></h1>
                <p class="text-xs text-zinc-500">Live Dual-Account Perceptron Engine</p>
            </div>
            <div class="text-right">
                <div id="market-price" class="text-lg text-white">$0.00000000</div>
                <div id="ml-sig" class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Calculating ML...</div>
            </div>
        </div>

        <div class="grid md:grid-cols-2 gap-6 mb-8">
            <!-- Account 1 -->
            <div class="bg-zinc-900 p-5 rounded border border-zinc-800">
                <div class="flex justify-between items-center mb-4">
                    <span class="text-xs font-bold text-green-500">ACCOUNT 1 (LONG)</span>
                    <span id="pos1-status" class="text-[10px] bg-zinc-800 px-2 py-0.5 rounded">IDLE</span>
                </div>
                <div id="pos1-details" class="h-16 text-sm text-zinc-400">No active position</div>
                <div class="grid grid-cols-2 gap-2 mt-4">
                    <input id="tp1" type="number" placeholder="TP%" class="bg-zinc-950 border border-zinc-800 p-2 text-xs rounded">
                    <input id="sl1" type="number" placeholder="SL%" class="bg-zinc-950 border border-zinc-800 p-2 text-xs rounded">
                </div>
                <button onclick="updateCfg(1)" class="w-full bg-zinc-800 hover:bg-zinc-700 text-white text-xs mt-2 py-2 rounded transition">Update Config</button>
            </div>

            <!-- Account 2 -->
            <div class="bg-zinc-900 p-5 rounded border border-zinc-800">
                <div class="flex justify-between items-center mb-4">
                    <span class="text-xs font-bold text-red-500">ACCOUNT 2 (SHORT)</span>
                    <span id="pos2-status" class="text-[10px] bg-zinc-800 px-2 py-0.5 rounded">IDLE</span>
                </div>
                <div id="pos2-details" class="h-16 text-sm text-zinc-400">No active position</div>
                <div class="grid grid-cols-2 gap-2 mt-4">
                    <input id="tp2" type="number" placeholder="TP%" class="bg-zinc-950 border border-zinc-800 p-2 text-xs rounded">
                    <input id="sl2" type="number" placeholder="SL%" class="bg-zinc-950 border border-zinc-800 p-2 text-xs rounded">
                </div>
                <button onclick="updateCfg(2)" class="w-full bg-zinc-800 hover:bg-zinc-700 text-white text-xs mt-2 py-2 rounded transition">Update Config</button>
            </div>
        </div>

        <div class="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
            <div class="bg-zinc-800/50 px-4 py-2 text-[10px] font-bold text-zinc-500 flex justify-between">
                <span>RECENT EXECUTIONS</span>
                <span id="total-pnl">Total PnL: $0.00</span>
            </div>
            <table class="w-full text-[11px] text-left">
                <thead class="bg-zinc-900 border-b border-zinc-800 text-zinc-500">
                    <tr><th class="p-3">Acc</th><th>Side</th><th>Entry</th><th>Exit</th><th>ROI</th><th class="text-right p-3">PnL</th></tr>
                </thead>
                <tbody id="trade-list"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function update() {
            const res = await fetch('/api/status');
            const data = await res.json();

            document.getElementById('market-price').innerText = '$' + data.market.mid.toFixed(8);
            const sig = data.market.mlSignal;
            document.getElementById('ml-sig').innerText = sig.type + ' (' + sig.confidence.toFixed(1) + '%)';
            document.getElementById('ml-sig').className = 'text-[10px] font-bold uppercase tracking-widest ' + (sig.type === 'bull' ? 'text-green-500' : 'text-red-500');

            // Pos 1
            if(data.activePos1) {
                document.getElementById('pos1-status').innerText = 'ACTIVE';
                document.getElementById('pos1-details').innerHTML = 'Entry: $' + data.activePos1.entryPrice.toFixed(8) + '<br>Contracts: ' + data.activePos1.contracts;
            } else {
                document.getElementById('pos1-status').innerText = 'IDLE';
                document.getElementById('pos1-details').innerText = 'No active position';
            }

            // Pos 2
            if(data.activePos2) {
                document.getElementById('pos2-status').innerText = 'ACTIVE';
                document.getElementById('pos2-details').innerHTML = 'Entry: $' + data.activePos2.entryPrice.toFixed(8) + '<br>Contracts: ' + data.activePos2.contracts;
            } else {
                document.getElementById('pos2-status').innerText = 'IDLE';
                document.getElementById('pos2-details').innerText = 'No active position';
            }

            document.getElementById('total-pnl').innerText = 'Total PnL: $' + data.metrics.totalNetPnl.toFixed(4);
            document.getElementById('trade-list').innerHTML = data.metrics.trades.map(t => 
                '<tr class="border-b border-zinc-800/50"><td class="p-3">#'+t.acc+'</td><td class="'+(t.side==='long'?'text-green-500':'text-red-500')+'">'+t.side+'</td><td>'+t.entry.toFixed(8)+'</td><td>'+t.exit.toFixed(8)+'</td><td>'+t.roi.toFixed(1)+'%</td><td class="text-right p-3 '+(t.pnl>=0?'text-green-500':'text-red-500')+'">$'+t.pnl.toFixed(4)+'</td></tr>'
            ).join('');
        }

        async function updateCfg(num) {
            const cfg = { 
                takeProfitPct: parseFloat(document.getElementById('tp'+num).value), 
                stopLossPct: parseFloat(document.getElementById('sl'+num).value) 
            };
            await fetch('/api/config', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({acc: num, cfg}) 
            });
            alert('Acc ' + num + ' Updated');
        }

        setInterval(update, 1000);
    </script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, () => {
    start();
});
