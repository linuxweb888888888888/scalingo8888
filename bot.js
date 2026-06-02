require('dotenv').config();
const express = require('express');
const ccxt = require('ccxt');
const https = require('https');

// ==================== ENGINE CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

let BOT_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    contractSize: 1000, 
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    mlLookback: 50, 
    mlThreshold: 60.0, 
    mlAverageTicks: 5, 
    mlUseAverage: false,
    flipOnlyInProfit: true,
    flipThresholdPct: 0.5
};

// ==================== IN-MEMORY STATE ====================
const state = {
    isTrading: false,
    liveTradingEnabled: process.env.LIVE_TRADING === 'true',
    activePosition: null,
    tradeHistory: [],
    chartHistory: [],
    tickBuffer: [],
    walletBalance: 0,
    startTime: Date.now(),
    lastCloseTime: 0,
    mlSignal: { confidence: 0, type: 'flat', rawValue: 0.5, avgConfidence: 0, avgType: 'flat' },
    mlRawBuffer: [],
    cycle: { active: false, isWaiting: false, data: null }
};

// ==================== EXCHANGE HANDLERS ====================
const htx = new ccxt.pro.htx({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_API_SECRET,
    agent: keepAliveAgent,
    options: { defaultType: 'swap', defaultSubType: 'linear' }
});

const binance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== MATH & ML ENGINE ====================
function calculateML(prices, lookback) {
    if (prices.length < lookback + 10) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getF = (i) => [((prices[i]-prices[i-1])/prices[i-1])*1000, ((prices[i]-prices[i-5])/prices[i-5])*1000];
    
    for (let i = prices.length - lookback; i < prices.length - 1; i++) {
        X.push(getF(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }
    
    let w = [0,0], b = 0, lr = 0.01;
    for (let e = 0; e < 5; e++) {
        for (let i = 0; i < X.length; i++) {
            let p = 1 / (1 + Math.exp(-(w[0]*X[i][0] + w[1]*X[i][1] + b)));
            let err = p - y[i];
            w[0] -= lr * err * X[i][0]; w[1] -= lr * err * X[i][1]; b -= lr * err;
        }
    }
    
    let curX = getF(prices.length - 1);
    let final = 1 / (1 + Math.exp(-(w[0]*curX[0] + w[1]*curX[1] + b)));
    return { confidence: Math.abs(final - 0.5) * 200, type: final >= 0.5 ? 'bull' : 'bear', rawValue: final };
}

// ==================== TRADE EXECUTION ====================
async function syncWallet() {
    if (state.liveTradingEnabled) {
        try {
            const bal = await htx.fetchBalance();
            state.walletBalance = bal.total.USDT || 0;
        } catch (e) { console.error("HTX Balance Error"); }
    }
}

async function forceClose(reason = "MANUAL") {
    if (!state.activePosition || state.isTrading) return;
    state.isTrading = true;
    try {
        const pos = state.activePosition;
        if (state.liveTradingEnabled) {
            await htx.createMarketOrder(BOT_CONFIG.htxSymbol, pos.side === 'long' ? 'sell' : 'buy', pos.contracts, undefined, { reduceOnly: true });
        }
        state.tradeHistory.unshift({ ...pos, exitPrice: state.tickBuffer[state.tickBuffer.length-1], timestamp: Date.now(), exitReason: reason });
        state.activePosition = null;
        state.lastCloseTime = Date.now();
    } catch (e) { console.error("Close Error:", e.message); }
    state.isTrading = false;
}

async function openPos(side) {
    if (state.activePosition || state.isTrading || (Date.now() - state.lastCloseTime < 3000)) return;
    if (state.cycle.isWaiting) return;
    state.isTrading = true;
    try {
        const price = state.tickBuffer[state.tickBuffer.length - 1];
        const displayBal = state.walletBalance > 0 ? state.walletBalance : 10;
        const qty = Math.max(1, Math.floor(displayBal * 1000));
        
        if (state.liveTradingEnabled) {
            await htx.createMarketOrder(BOT_CONFIG.htxSymbol, side === 'long' ? 'buy' : 'sell', qty);
        }

        state.activePosition = {
            side, entryPrice: price, contracts: qty, marginUsed: (qty * BOT_CONFIG.contractSize * price) / FORCED_LEVERAGE,
            entryTime: Date.now(), exchangeROI: 0, exchangePnl: 0
        };
    } catch (e) { console.error("Open Error:", e.message); }
    state.isTrading = false;
}

// ==================== MAIN TICK LOOP ====================
async function start() {
    syncWallet();
    while (true) {
        try {
            const ticker = await binance.watchTicker(BOT_CONFIG.binanceSymbol);
            const mid = (ticker.bid + ticker.ask) / 2;
            state.tickBuffer.push(mid);
            if (state.tickBuffer.length > 100) state.tickBuffer.shift();

            const ml = calculateML(state.tickBuffer, BOT_CONFIG.mlLookback);
            state.mlRawBuffer.push(ml.rawValue);
            if (state.mlRawBuffer.length > BOT_CONFIG.mlAverageTicks) state.mlRawBuffer.shift();
            const avg = state.mlRawBuffer.reduce((a,b)=>a+b,0) / state.mlRawBuffer.length;
            state.mlSignal = { ...ml, avgConfidence: Math.abs(avg - 0.5) * 200, avgType: avg >= 0.5 ? 'bull' : 'bear' };

            if (state.chartHistory.length === 0 || Date.now() - state.chartHistory[state.chartHistory.length-1].ts > 2000) {
                state.chartHistory.push({ price: mid, ml: ml.rawValue, ts: Date.now() });
                if (state.chartHistory.length > 300) state.chartHistory.shift();
            }

            const activeT = BOT_CONFIG.mlUseAverage ? state.mlSignal.avgType : state.mlSignal.type;
            const activeC = BOT_CONFIG.mlUseAverage ? state.mlSignal.avgConfidence : state.mlSignal.confidence;

            if (state.activePosition) {
                const pos = state.activePosition;
                pos.exchangeROI = ((mid - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side==='long'?1:-1) * FORCED_LEVERAGE;
                pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed;

                if (pos.exchangeROI >= BOT_CONFIG.takeProfitPct) await forceClose("TP");
                else if (pos.exchangeROI <= BOT_CONFIG.stopLossPct) await forceClose("SL");
                else if (activeC >= BOT_CONFIG.mlThreshold && activeT !== pos.side) {
                    if (!BOT_CONFIG.flipOnlyInProfit || pos.exchangeROI >= BOT_CONFIG.flipThresholdPct) await forceClose("FLIP");
                }
                
                // Cycle logic
                if (state.cycle.active && !state.cycle.isWaiting) {
                    const growth = ((state.walletBalance - state.cycle.data.startBal) / state.cycle.data.startBal) * 100;
                    if (growth >= state.cycle.data.target) {
                        state.cycle.isWaiting = true;
                        state.cycle.data.status = "COMPLETED";
                        await forceClose("CYCLE_END");
                    }
                }
            } else if (activeC >= BOT_CONFIG.mlThreshold) {
                await openPos(activeT === 'bull' ? 'long' : 'short');
            }
        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
}

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());

app.get('/api/data', (req, res) => res.json({ config: BOT_CONFIG, state }));
app.get('/api/close', (req, res) => { forceClose("UI_MANUAL"); res.json({status:'ok'}); });
app.post('/api/config', (req, res) => { BOT_CONFIG = { ...BOT_CONFIG, ...req.body }; res.json({status:'ok'}); });
app.post('/api/cycle', (req, res) => {
    state.cycle = { active: true, isWaiting: false, data: { startBal: state.walletBalance || 10, target: parseFloat(req.body.target), status: "RUNNING" } };
    res.json({status:'ok'});
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TERMINAL_V4</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>body { background: #0b0e11; color: #eaeaeb; font-family: 'monospace'; }</style>
</head>
<body class="p-6">
    <div class="max-w-6xl mx-auto space-y-6">
        <div class="flex justify-between items-center bg-gray-900 p-6 rounded-xl border border-gray-800">
            <div>
                <h1 class="text-2xl font-bold text-yellow-500">TERMINAL_V4</h1>
                <p class="text-xs text-gray-500 uppercase tracking-widest">Non-Custodial ML Engine</p>
            </div>
            <div class="text-right">
                <p class="text-xs text-gray-500 uppercase">Balance</p>
                <p id="ui-bal" class="text-2xl font-bold text-white">$0.00</p>
            </div>
        </div>

        <div class="grid grid-cols-4 gap-4">
            <div class="bg-gray-900 p-4 rounded border border-gray-800"><p class="text-xs text-gray-500">POSITION</p><p id="ui-pos" class="font-bold">---</p></div>
            <div class="bg-gray-900 p-4 rounded border border-gray-800"><p class="text-xs text-gray-500">LIVE_ROI</p><p id="ui-roi" class="font-bold">0.00%</p></div>
            <div class="bg-gray-900 p-4 rounded border border-gray-800"><p class="text-xs text-gray-500">ML_SIGNAL</p><p id="ui-ml" class="font-bold text-blue-400">0.0% ---</p></div>
            <div class="bg-gray-900 p-4 rounded border border-gray-800"><p class="text-xs text-gray-500">UPTIME</p><p id="ui-uptime" class="font-bold">0s</p></div>
        </div>

        <div class="grid grid-cols-3 gap-6">
            <div class="col-span-2 space-y-6">
                <div class="bg-gray-900 p-4 rounded-xl border border-gray-800 h-80"><canvas id="c"></canvas></div>
                <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                    <table class="w-full text-left text-xs">
                        <thead class="bg-gray-800 text-gray-400"><tr><th class="p-3">TIME</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>REASON</th></tr></thead>
                        <tbody id="ui-hist"></tbody>
                    </table>
                </div>
            </div>
            <div class="space-y-6">
                <div class="bg-gray-900 p-6 rounded-xl border border-gray-800 space-y-4">
                    <h3 class="text-yellow-500 font-bold text-sm">Cycle_Control</h3>
                    <input id="cy-t" type="number" placeholder="Target Growth %" class="w-full bg-black border border-gray-700 p-2 rounded text-sm">
                    <button onclick="startCy()" class="w-full bg-yellow-600 text-black font-bold py-2 rounded text-sm hover:bg-yellow-500">START_CYCLE</button>
                    <p id="ui-cy-status" class="text-[10px] text-gray-500">Inactive</p>
                </div>
                <div class="bg-gray-900 p-6 rounded-xl border border-gray-800 space-y-3">
                    <h3 class="text-yellow-500 font-bold text-sm">Engine_Params</h3>
                    <div class="space-y-2 text-[10px]">
                        <div>TP%: <input id="in-tp" type="number" class="bg-black p-1 w-full border border-gray-800 rounded"></div>
                        <div>SL%: <input id="in-sl" type="number" class="bg-black p-1 w-full border border-gray-800 rounded"></div>
                        <div>ML_THRESHOLD: <input id="in-th" type="number" class="bg-black p-1 w-full border border-gray-800 rounded"></div>
                    </div>
                    <button onclick="saveP()" class="w-full bg-gray-800 py-2 rounded text-xs font-bold hover:bg-gray-700">UPDATE_PARAMS</button>
                    <button onclick="fetch('/api/close')" class="w-full bg-red-900/40 text-red-500 py-2 rounded text-xs font-bold border border-red-900/50">FORCE_CLOSE</button>
                </div>
            </div>
        </div>
    </div>
    <script>
        let chart;
        function initChart() {
            chart = new Chart(document.getElementById('c'), {
                type: 'line',
                data: { labels: [], datasets: [
                    { label: 'Price', data: [], borderColor: '#f3ba2f', yAxisID: 'y', pointRadius: 0 },
                    { label: 'ML', data: [], borderColor: '#3b82f6', yAxisID: 'y1', pointRadius: 0, borderDash: [5,5] }
                ]},
                options: { animation: false, scales: { y1: { position: 'right', min: 0, max: 1 } } }
            });
        }

        async function tick() {
            const r = await fetch('/api/data');
            const { state, config } = await r.json();
            
            document.getElementById('ui-bal').innerText = '$' + (state.walletBalance || 0).toFixed(2);
            document.getElementById('ui-pos').innerText = state.activePosition ? state.activePosition.side.toUpperCase() : 'FLAT';
            document.getElementById('ui-roi').innerText = (state.activePosition?.exchangeROI || 0).toFixed(2) + '%';
            document.getElementById('ui-ml').innerText = state.mlSignal.avgConfidence.toFixed(1) + '% ' + state.mlSignal.avgType.toUpperCase();
            document.getElementById('ui-uptime').innerText = state.uptime + 's';
            document.getElementById('ui-cy-status').innerText = state.cycle.active ? 'Cycle: ' + state.cycle.data.status : 'Inactive';

            // Update Form
            if(!window.loaded) {
                document.getElementById('in-tp').value = config.takeProfitPct;
                document.getElementById('in-sl').value = config.stopLossPct;
                document.getElementById('in-th').value = config.mlThreshold;
                window.loaded = true;
            }

            // History
            document.getElementById('ui-hist').innerHTML = state.tradeHistory.map(h => 
                \`<tr class="border-t border-gray-800"><td class="p-3">\${new Date(h.timestamp).toLocaleTimeString()}</td><td>\${h.side}</td><td>\${h.entryPrice}</td><td>\${h.exitPrice}</td><td>\${h.exitReason}</td></tr>\`
            ).join('');

            // Chart
            chart.data.labels = state.chartHistory.map(d => '');
            chart.data.datasets[0].data = state.chartHistory.map(d => d.price);
            chart.data.datasets[1].data = state.chartHistory.map(d => d.ml);
            chart.update();
        }

        function saveP() {
            fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                takeProfitPct: parseFloat(document.getElementById('in-tp').value),
                stopLossPct: parseFloat(document.getElementById('in-sl').value),
                mlThreshold: parseFloat(document.getElementById('in-th').value)
            })});
        }

        function startCy() {
            fetch('/api/cycle', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                target: document.getElementById('cy-t').value
            })});
        }

        window.onload = () => { initChart(); setInterval(tick, 1000); };
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 TERMINAL_V4 ONLINE | PORT ${PORT}`);
    start();
});
