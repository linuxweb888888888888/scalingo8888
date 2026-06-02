require('dotenv').config();
const express = require('express');
const ccxt = require('ccxt');
const https = require('https');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const FORCED_LEVERAGE = 75;
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

let BOT_CONFIG = {
    htxSymbol: 'SHIB/USDT:USDT',         
    binanceSymbol: '1000SHIB/USDT:USDT', 
    leverage: FORCED_LEVERAGE, 
    baseContracts: 1, 
    contractSize: 1000, 
    takerFee: 0.0004,
    takeProfitPct: 10.0, 
    stopLossPct: -50.0, 
    mlLookback: 50, 
    mlThreshold: 60.0, 
    mlAverageTicks: 5, 
    mlUseAverage: false, 
    flipOnlyInProfit: true, 
    flipThresholdPct: 0.5, 
    dcaRoiThresholdPct: 1.0, 
    dcaMultiplier: 2.0, 
    profitRoiThresholdPct: 2.0, 
    profitMultiplier: 2.0, 
    maxContracts: 100
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
    cycle: {
        active: false,
        isWaiting: false,
        data: null
    }
};

// ==================== EXCHANGE INIT ====================
const htx = new ccxt.pro.htx({
    apiKey: process.env.HTX_API_KEY,
    secret: process.env.HTX_API_SECRET,
    agent: keepAliveAgent,
    options: { defaultType: 'swap', defaultSubType: 'linear' }
});

const binance = new ccxt.pro.binance({ options: { defaultType: 'swap' } });

// ==================== ML MATH ENGINE ====================
function calculateMLSignal(prices, lookback) {
    if (prices.length < lookback + 15) return { confidence: 0, type: 'flat', rawValue: 0.5 };
    let X = [], y = [];
    const getFeatures = (idx) => [
        ((prices[idx] - prices[idx-1]) / prices[idx-1]) * 1000,
        ((prices[idx] - prices[idx-3]) / prices[idx-3]) * 1000,
        ((prices[idx] - prices[idx-5]) / prices[idx-5]) * 1000,
        ((prices[idx] - prices[idx-10]) / prices[idx-10]) * 1000
    ];

    for (let i = prices.length - lookback - 1; i < prices.length - 1; i++) {
        X.push(getFeatures(i));
        y.push(prices[i+1] > prices[i] ? 1 : 0);
    }

    // Simple Perceptron/Logistic approximation
    let w = [0,0,0,0], b = 0, lr = 0.05;
    for (let e = 0; e < 10; e++) {
        for (let i = 0; i < X.length; i++) {
            let z = w[0]*X[i][0] + w[1]*X[i][1] + w[2]*X[i][2] + w[3]*X[i][3] + b;
            let pred = 1 / (1 + Math.exp(-z));
            let err = pred - y[i];
            for(let j=0; j<4; j++) w[j] -= lr * err * X[i][j];
            b -= lr * err;
        }
    }

    let currX = getFeatures(prices.length - 1);
    let zCur = w[0]*currX[0] + w[1]*currX[1] + w[2]*currX[2] + w[3]*currX[3] + b;
    let finalPred = 1 / (1 + Math.exp(-zCur));
    let confidence = Math.abs(finalPred - 0.5) * 200;
    return { confidence: Math.min(confidence, 100), type: finalPred >= 0.5 ? 'bull' : 'bear', rawValue: finalPred };
}

// ==================== CORE TRADING LOGIC ====================
async function handleCycleLogic() {
    if (!state.cycle.active || state.cycle.isWaiting) return;
    
    const bal = state.walletBalance || 10;
    const startBal = state.cycle.data.startBalance;
    const currentGrowth = ((bal - startBal) / startBal) * 100;
    
    if (currentGrowth >= state.cycle.data.targetGrowthPct) {
        state.cycle.isWaiting = true;
        state.cycle.data.status = 'achieved';
        state.cycle.data.nextStartTime = Date.now() + state.cycle.data.duration;
        if (state.activePosition) await forceClose("CYCLE_TARGET_REACHED");
    }
}

async function forceClose(reason = "MANUAL") {
    if (!state.activePosition || state.isTrading) return;
    state.isTrading = true;
    try {
        const pos = state.activePosition;
        if (state.liveTradingEnabled) {
            const side = pos.side === 'long' ? 'sell' : 'buy';
            await htx.createMarketOrder(BOT_CONFIG.htxSymbol, side, pos.contracts, undefined, { reduceOnly: true });
        }
        
        state.tradeHistory.unshift({
            ...pos,
            exitReason: reason,
            timestamp: Date.now(),
            netPnl: (pos.exchangePnl || 0) - (pos.size * BOT_CONFIG.takerFee * 2)
        });
        state.activePosition = null;
        state.lastCloseTime = Date.now();
    } catch (e) { console.error("Close Error:", e.message); }
    state.isTrading = false;
}

async function openPosition(side) {
    if (state.activePosition || state.isTrading || (Date.now() - state.lastCloseTime < 5000)) return;
    if (state.cycle.isWaiting) return;

    state.isTrading = true;
    try {
        const price = state.tickBuffer[state.tickBuffer.length - 1];
        const qty = Math.max(1, Math.floor((state.walletBalance || 10) * 1000));
        
        if (state.liveTradingEnabled) {
            const htxSide = side === 'long' ? 'buy' : 'sell';
            await htx.createMarketOrder(BOT_CONFIG.htxSymbol, htxSide, qty);
        }

        const size = qty * BOT_CONFIG.contractSize * price;
        state.activePosition = {
            side, 
            entryPrice: price, 
            contracts: qty, 
            size: size,
            marginUsed: size / FORCED_LEVERAGE,
            entryTime: Date.now(),
            exchangeROI: 0,
            exchangePnl: 0,
            dcaStep: 0
        };
    } catch (e) { console.error("Open Error:", e.message); }
    state.isTrading = false;
}

// ==================== MASTER TICK STREAM ====================
async function startStream() {
    while (true) {
        try {
            const ticker = await binance.watchTicker(BOT_CONFIG.binanceSymbol);
            const mid = (ticker.bid + ticker.ask) / 2;
            state.tickBuffer.push(mid);
            if (state.tickBuffer.length > 200) state.tickBuffer.shift();

            // ML Processing
            const ml = calculateMLSignal(state.tickBuffer, BOT_CONFIG.mlLookback);
            state.mlRawBuffer.push(ml.rawValue);
            if (state.mlRawBuffer.length > BOT_CONFIG.mlAverageTicks) state.mlRawBuffer.shift();
            
            const avgRaw = state.mlRawBuffer.reduce((a,b)=>a+b,0) / state.mlRawBuffer.length;
            state.mlSignal = {
                ...ml,
                avgConfidence: Math.abs(avgRaw - 0.5) * 200,
                avgType: avgRaw >= 0.5 ? 'bull' : 'bear'
            };

            // Charting
            if (state.chartHistory.length === 0 || Date.now() - state.chartHistory[state.chartHistory.length-1].ts > 2000) {
                state.chartHistory.push({ price: mid, ml: ml.rawValue, ts: Date.now() });
                if (state.chartHistory.length > 800) state.chartHistory.shift();
            }

            // Trading Logic
            const activeType = BOT_CONFIG.mlUseAverage ? state.mlSignal.avgType : state.mlSignal.type;
            const activeConf = BOT_CONFIG.mlUseAverage ? state.mlSignal.avgConfidence : state.mlSignal.confidence;
            const signal = activeConf >= BOT_CONFIG.mlThreshold ? activeType : null;

            if (state.activePosition) {
                // Update ROI
                const pos = state.activePosition;
                const sideMult = pos.side === 'long' ? 1 : -1;
                pos.exchangeROI = ((mid - pos.entryPrice) / pos.entryPrice) * 100 * sideMult * FORCED_LEVERAGE;
                pos.exchangePnl = (pos.exchangeROI / 100) * pos.marginUsed;

                // Exits
                if (pos.exchangeROI >= BOT_CONFIG.takeProfitPct) await forceClose("TAKE_PROFIT");
                else if (pos.exchangeROI <= BOT_CONFIG.stopLossPct) await forceClose("STOP_LOSS");
                else if (signal && signal !== pos.side) {
                    if (!BOT_CONFIG.flipOnlyInProfit || pos.exchangeROI >= BOT_CONFIG.flipThresholdPct) {
                        await forceClose("ML_FLIP");
                    }
                }
                await handleCycleLogic();
            } else if (signal) {
                await openPosition(signal === 'bull' ? 'long' : 'short');
            }

        } catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
}

// ==================== API ROUTES ====================
const app = express();
app.use(express.json());

app.get('/api/data', (req, res) => {
    res.json({
        config: BOT_CONFIG,
        state: {
            uptime: Math.floor((Date.now() - state.startTime) / 1000),
            activePosition: state.activePosition,
            mlSignal: state.mlSignal,
            walletBalance: state.walletBalance,
            tradeHistory: state.tradeHistory.slice(0, 10),
            liveTradingEnabled: state.liveTradingEnabled
        }
    });
});

app.get('/api/chart', (req, res) => res.json(state.chartHistory));

app.post('/api/config', (req, res) => {
    BOT_CONFIG = { ...BOT_CONFIG, ...req.body };
    res.json({ status: 'ok' });
});

app.post('/api/cycle', (req, res) => {
    const { targetGrowth, unit, value } = req.body;
    let dur = 3600000; // default hour
    if (unit === 'minute') dur = 60000 * value;
    if (unit === 'day') dur = 86400000 * value;

    state.cycle = {
        active: true,
        isWaiting: false,
        data: {
            startBalance: state.walletBalance || 10,
            targetGrowthPct: parseFloat(targetGrowth),
            duration: dur,
            status: 'active'
        }
    };
    res.json(state.cycle);
});

app.get('/api/close', async (req, res) => {
    await forceClose("MANUAL_UI");
    res.json({ status: 'ok' });
});

// ==================== DASHBOARD UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Trading Terminal | Stateless</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono&display=swap" rel="stylesheet">
    <style>body { font-family: 'Roboto Mono', monospace; background: #0b0e11; color: #eaeaeb; }</style>
</head>
<body class="p-4">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8 bg-gray-900 p-4 rounded-lg border border-gray-800">
            <div>
                <h1 class="text-2xl font-bold text-yellow-500">TERMINAL_V4</h1>
                <p class="text-xs text-gray-500">NON-CUSTODIAL ML ENGINE</p>
            </div>
            <div class="flex gap-4">
                <div class="text-right">
                    <p class="text-xs text-gray-500 uppercase">Balance</p>
                    <p id="ui-bal" class="text-xl font-bold">$0.00</p>
                </div>
                <button onclick="fetch('/api/close')" class="bg-red-600 hover:bg-red-700 px-6 py-2 rounded font-bold transition">FORCE_CLOSE</button>
            </div>
        </div>

        <div class="grid grid-cols-12 gap-6">
            <!-- Left: Chart and Metrics -->
            <div class="col-span-12 lg:col-span-8 space-y-6">
                <div class="bg-gray-900 p-4 rounded-lg border border-gray-800 h-96">
                    <canvas id="mainChart"></canvas>
                </div>
                
                <div class="grid grid-cols-4 gap-4">
                    <div class="bg-gray-900 p-4 rounded border border-gray-800">
                        <p class="text-xs text-gray-500">POSITION</p>
                        <p id="ui-pos" class="text-lg font-bold">FLAT</p>
                    </div>
                    <div class="bg-gray-900 p-4 rounded border border-gray-800">
                        <p class="text-xs text-gray-500">LIVE_ROI</p>
                        <p id="ui-roi" class="text-lg font-bold">0.00%</p>
                    </div>
                    <div class="bg-gray-900 p-4 rounded border border-gray-800">
                        <p class="text-xs text-gray-500">ML_SIGNAL</p>
                        <p id="ui-ml" class="text-lg font-bold">---</p>
                    </div>
                    <div class="bg-gray-900 p-4 rounded border border-gray-800">
                        <p class="text-xs text-gray-500">UPTIME</p>
                        <p id="ui-uptime" class="text-lg font-bold">0s</p>
                    </div>
                </div>

                <div class="bg-gray-900 rounded border border-gray-800 overflow-hidden">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-gray-800 text-gray-400 uppercase text-xs">
                            <tr><th class="p-3">Time</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th></tr>
                        </thead>
                        <tbody id="ui-history"></tbody>
                    </table>
                </div>
            </div>

            <!-- Right: Config and Cycle -->
            <div class="col-span-12 lg:col-span-4 space-y-6">
                <div class="bg-gray-900 p-6 rounded-lg border border-gray-800">
                    <h2 class="text-yellow-500 font-bold mb-4 uppercase text-sm">Cycle_Control</h2>
                    <div class="space-y-4">
                        <input id="cy-growth" type="number" step="0.1" placeholder="Target Growth %" class="w-full bg-black border border-gray-700 p-2 rounded outline-none focus:border-yellow-500">
                        <div class="flex gap-2">
                            <input id="cy-val" type="number" placeholder="Value" class="flex-1 bg-black border border-gray-700 p-2 rounded outline-none">
                            <select id="cy-unit" class="bg-black border border-gray-700 p-2 rounded outline-none">
                                <option value="minute">Min</option>
                                <option value="hour">Hr</option>
                                <option value="day">Day</option>
                            </select>
                        </div>
                        <button onclick="startCycle()" class="w-full bg-yellow-600 hover:bg-yellow-700 py-2 rounded font-bold uppercase text-black">Start_Cycle</button>
                    </div>
                </div>

                <div class="bg-gray-900 p-6 rounded-lg border border-gray-800">
                    <h2 class="text-yellow-500 font-bold mb-4 uppercase text-sm">Engine_Params</h2>
                    <div id="ui-config-form" class="space-y-3 text-xs">
                        <!-- Dynamic config fields -->
                    </div>
                    <button onclick="saveConfig()" class="w-full mt-4 bg-gray-700 hover:bg-gray-600 py-2 rounded font-bold uppercase">Update_Params</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        let chart;
        function initChart() {
            const ctx = document.getElementById('mainChart').getContext('2d');
            chart = new Chart(ctx, {
                type: 'line',
                data: { labels: [], datasets: [
                    { label: 'Price', data: [], borderColor: '#f3ba2f', yAxisID: 'y', pointRadius: 0, borderWidth: 2 },
                    { label: 'ML', data: [], borderColor: '#3b82f6', yAxisID: 'y1', pointRadius: 0, borderWidth: 1 }
                ]},
                options: { 
                    animation: false, maintainAspectRatio: false,
                    scales: { 
                        y: { position: 'left' }, 
                        y1: { position: 'right', min: 0, max: 1, grid: { display: false } }
                    }
                }
            });
        }

        async function update() {
            const res = await fetch('/api/data');
            const { state, config } = await res.json();
            
            document.getElementById('ui-bal').innerText = '$' + (state.walletBalance || 0).toFixed(2);
            document.getElementById('ui-pos').innerText = state.activePosition ? state.activePosition.side.toUpperCase() : 'FLAT';
            document.getElementById('ui-roi').innerText = (state.activePosition?.exchangeROI || 0).toFixed(2) + '%';
            document.getElementById('ui-ml').innerText = state.mlSignal.avgConfidence.toFixed(1) + '% ' + state.mlSignal.avgType.toUpperCase();
            document.getElementById('ui-uptime').innerText = state.uptime + 's';

            let histHtml = '';
            state.tradeHistory.forEach(t => {
                histHtml += '<tr class="border-t border-gray-800"><td class="p-3">'+new Date(t.timestamp).toLocaleTimeString()+'</td><td class="'+(t.side==='long'?'text-green-500':'text-red-500')+'">'+t.side.toUpperCase()+'</td><td>$'+t.entryPrice.toFixed(6)+'</td><td>$'+(t.exitPrice||0).toFixed(6)+'</td><td class="'+(t.netPnl>=0?'text-green-500':'text-red-500')+'">$'+t.netPnl.toFixed(4)+'</td></tr>';
            });
            document.getElementById('ui-history').innerHTML = histHtml;

            // Update Chart
            const chartRes = await fetch('/api/chart');
            const chartData = await chartRes.json();
            chart.data.labels = chartData.map(d => '');
            chart.data.datasets[0].data = chartData.map(d => d.price);
            chart.data.datasets[1].data = chartData.map(d => d.ml);
            chart.update();
        }

        function startCycle() {
            fetch('/api/cycle', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    targetGrowth: document.getElementById('cy-growth').value,
                    value: document.getElementById('cy-val').value,
                    unit: document.getElementById('cy-unit').value
                })
            });
        }

        setInterval(update, 2000);
        window.onload = initChart;
    </script>
</body>
</html>
    `);
});

// ==================== STARTUP ====================
app.listen(PORT, () => {
    console.log(`\n🚀 TERMINAL_V4 ONLINE | PORT: ${PORT}`);
    console.log(`📈 MODE: ${state.liveTradingEnabled ? 'LIVE_EXECUTION' : 'PAPER_TRADING'}`);
    startStream();
});
