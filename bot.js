require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// ==================== MONGODB SETUP ====================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://web88888888888888_db_user:ZETrZHXzaxoekjkm@clusterweb8888.l0rv6hv.mongodb.net/botdb?appName=Clusterweb8888";
mongoose.connect(MONGO_URI).then(() => console.log("📦 MongoDB Connected"));

const BotSchema = new mongoose.Schema({
    id: { type: String, default: "htx_martingale" },
    initialBalance: { type: Number, default: 0 },
    startTime: { type: Number, default: Date.now() }
});
const BotModel = mongoose.model('BotConfig_V33', BotSchema);

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

let botState = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    currentPrice: 0,
    avgPrice: 0,
    roi: 0, 
    realizedProfit: 0,
    profitPct: 0,      
    walletBalance: 0,  
    initialBalance: 0, 
    safetyOrdersFilled: 0,
    distToNext: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 }, 
    settings: {
        baseOrder: 0, 
        priceDrop: 0.1,
        volumeMult: 1.2,
        takeProfit: 1.5,
        maxSteps: 10
    },
    martingaleLadder: [] // Will store all steps
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { 
        AccessKeyId: config.apiKey, 
        SignatureMethod: 'HmacSHA256', 
        SignatureVersion: '2', 
        Timestamp: timestamp 
    };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) {
        console.error(`❌ API Error:`, e.response?.data || e.message);
        return null;
    }
}

// ==================== CALCULATE FULL MARTINGALE LADDER ====================
function calculateMartingaleLadder(walletBalance, baseOrder) {
    const leverage = config.leverage;
    const marginPerContract = 1 / leverage; // 0.1 USDT per contract
    const multiplier = 1.2;
    const steps = botState.settings.maxSteps;
    
    let ladder = [];
    let totalContracts = 0;
    let totalMargin = 0;
    let currentStepSize = baseOrder;
    
    for (let step = 0; step <= steps; step++) {
        if (step === 0) {
            currentStepSize = baseOrder;
        } else {
            currentStepSize = Math.floor(baseOrder * Math.pow(multiplier, step));
        }
        
        totalContracts += currentStepSize;
        totalMargin = totalContracts * marginPerContract;
        
        // Calculate percentage of wallet used
        const percentUsed = (totalMargin / walletBalance) * 100;
        
        ladder.push({
            step: step,
            additionalSize: currentStepSize,
            totalSize: totalContracts,
            marginNeeded: totalMargin,
            percentOfWallet: Math.min(percentUsed, 100),
            canAfford: totalMargin <= walletBalance * 0.85 // 85% max usage
        });
        
        // Stop if we exceed wallet capacity
        if (totalMargin > walletBalance) break;
    }
    
    return ladder;
}

// ==================== FETCH PRICE ====================
async function fetchPriceFromRest() {
    try {
        const response = await axios.get(`https://${config.restHost}/linear-swap-api/v1/swap_best_limit_order`, {
            params: { contract_code: config.symbol }
        });
        if (response.data?.data?.ask_price) {
            return parseFloat(response.data.data.ask_price[0]);
        }
    } catch (e) {
        return null;
    }
    return null;
}

// ==================== TRADING LOGIC ====================
async function runLogic() {
    if (!botState.isRunning || botState.isTrading) return;
    botState.isTrading = true;

    try {
        if (botState.currentPrice <= 0) {
            const price = await fetchPriceFromRest();
            if (price) botState.currentPrice = price;
        }
        
        const [posRes, accRes] = await Promise.all([
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol }),
            htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' })
        ]);

        let pos = null;
        if (posRes && posRes.data && Array.isArray(posRes.data)) {
            pos = posRes.data.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');
        }
        
        let walletBalance = 0;
        if (accRes && accRes.data && accRes.data.length > 0) {
            const account = accRes.data[0];
            walletBalance = parseFloat(account.margin_balance) || 0;
        }

        if (walletBalance > 0) {
            botState.walletBalance = Number(walletBalance.toFixed(4));
            
            if (botState.walletBalance > 0) {
                // Calculate base order (minimum 1 contract)
                const marginPerContract = 1 / config.leverage;
                const seriesSum = (Math.pow(1.2, 11) - 1) / (1.2 - 1);
                const availableMargin = botState.walletBalance * 0.85;
                let baseOrder = Math.floor(availableMargin / (seriesSum * marginPerContract));
                baseOrder = Math.max(1, Math.min(baseOrder, 100));
                botState.settings.baseOrder = baseOrder;
                
                // Calculate the full martingale ladder
                botState.martingaleLadder = calculateMartingaleLadder(botState.walletBalance, botState.settings.baseOrder);
                
                console.log(`🎯 Base Order: ${botState.settings.baseOrder} | Total Steps: ${botState.martingaleLadder.length}`);
            }
            
            if (botState.initialBalance <= 0 && botState.walletBalance > 0) {
                botState.initialBalance = botState.walletBalance;
                botState.startTime = Date.now();
                await BotModel.updateOne({ id: "htx_martingale" }, 
                    { initialBalance: botState.initialBalance, startTime: botState.startTime }, 
                    { upsert: true });
            }
        }

        if (botState.initialBalance > 0 && botState.walletBalance > 0) {
            botState.realizedProfit = botState.walletBalance - botState.initialBalance;
            botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
        }

        const elapsedHours = (Date.now() - botState.startTime) / (1000 * 60 * 60);
        if (elapsedHours > 0.1 && botState.initialBalance > 0 && botState.walletBalance > 0 && botState.initialBalance !== botState.walletBalance) {
            const hourlyReturn = Math.pow(botState.walletBalance / botState.initialBalance, (1 / elapsedHours)) - 1;
            const safeHourly = hourlyReturn > 0 ? hourlyReturn : 0;
            botState.estimates.dgr = safeHourly * 24 * 100;
            botState.estimates.hr = botState.realizedProfit / elapsedHours;
            botState.estimates.day = botState.walletBalance * safeHourly * 24;
            botState.estimates.week = botState.walletBalance * (Math.pow(1 + safeHourly, 24 * 7) - 1);
            botState.estimates.month = botState.walletBalance * (Math.pow(1 + safeHourly, 24 * 30) - 1);
        }

        if (pos && botState.currentPrice > 0) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            const triggerPrice = botState.avgPrice * (1 - (botState.settings.priceDrop / 100));
            
            if (botState.roi >= botState.settings.takeProfit) {
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: pos.volume,
                    direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                botState.safetyOrdersFilled = 0;
            } else if (botState.currentPrice <= triggerPrice && botState.safetyOrdersFilled < botState.settings.maxSteps) {
                botState.safetyOrdersFilled++;
                const nextVol = Math.floor(botState.settings.baseOrder * Math.pow(1.2, botState.safetyOrdersFilled));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: Math.max(1, nextVol),
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
            }
        } else if (botState.settings.baseOrder > 0 && botState.walletBalance > 0 && botState.currentPrice > 0) {
            botState.safetyOrdersFilled = 0;
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } catch (e) {
        console.error("❌ Trading error:", e?.message || e);
    }
    botState.isTrading = false;
}

// ==================== WEBSOCKET ====================
function setupWebSocket() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        console.log("🔌 WebSocket Connected");
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' }));
    });
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dezipped) => {
            if (!err) {
                try {
                    const msg = JSON.parse(dezipped.toString());
                    if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
                    if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
                } catch (e) {}
            }
        });
    });
    ws.on('error', (err) => {
        console.error("WebSocket Error:", err.message);
        setTimeout(setupWebSocket, 5000);
    });
    ws.on('close', () => setTimeout(setupWebSocket, 5000));
    return ws;
}

// ==================== STARTUP ====================
async function boot() {
    let data = await BotModel.findOne({ id: "htx_martingale" });
    if (!data) data = await BotModel.create({ id: "htx_martingale" });
    botState.initialBalance = data.initialBalance || 0;
    botState.startTime = data.startTime || Date.now();
    
    setupWebSocket();
    setInterval(runLogic, 5000);
    
    setTimeout(async () => {
        const price = await fetchPriceFromRest();
        if (price && botState.currentPrice <= 0) botState.currentPrice = price;
    }, 1000);
}

// ==================== UI WITH MARTINGALE LADDER ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html class="bg-slate-50">
<head>
    <title>HTX Engine | Full Martingale Ladder</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Roboto Mono', monospace; }
        .glass { background: white; border: 1px solid rgba(0, 0, 0, 0.08); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02); }
        .step-active { background: #2563eb; color: white; border-color: #2563eb; }
        .step-upcoming { background: white; color: #2563eb; border: 2px solid #2563eb; }
        .step-exceed { background: #fef2f2; color: #dc2626; border: 2px solid #fecaca; }
    </style>
</head>
<body class="text-slate-600 p-4 md:p-10">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-slate-900 text-2xl font-bold tracking-tighter uppercase">Martingale <span class="text-blue-600">Ladder</span></h1>
                <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">${config.symbol} | 1.2x Multiplier | 10x Leverage</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-blue-600 font-bold text-2xl">0.00%</p>
                <p class="text-[10px] text-slate-400 uppercase font-bold">Daily Growth Rate</p>
            </div>
        </div>

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold">Static Profit</p>
                <p id="p1" class="text-2xl text-emerald-600 font-bold">$0.0000</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold">Static Gain</p>
                <p id="p2" class="text-2xl text-emerald-600 font-bold">0.00%</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold">Live ROI</p>
                <p id="roi" class="text-2xl font-bold text-slate-300">0.00%</p>
            </div>
            <div class="glass p-5 rounded-2xl">
                <p class="text-[10px] text-slate-400 uppercase font-bold">Wallet Balance</p>
                <p id="bal" class="text-2xl text-slate-900 font-bold">$0.0000</p>
            </div>
        </div>

        <!-- Projections -->
        <div class="grid grid-cols-3 gap-4 mb-8">
            <div class="bg-blue-600 p-5 rounded-2xl text-white text-center">
                <p class="text-[10px] opacity-70 uppercase font-bold">24h Projection</p>
                <p id="estDay" class="text-2xl font-bold">$0.00</p>
            </div>
            <div class="glass p-5 rounded-2xl text-center">
                <p class="text-[10px] text-slate-400 uppercase font-bold">7 Day</p>
                <p id="estWeek" class="text-2xl text-slate-900 font-bold">$0.00</p>
            </div>
            <div class="glass p-5 rounded-2xl text-center border-b-4 border-b-blue-600">
                <p class="text-[10px] text-slate-400 uppercase font-bold">30 Day</p>
                <p id="estMonth" class="text-2xl text-slate-900 font-bold">$0</p>
            </div>
        </div>

        <!-- MARTINGALE LADDER - FULL TABLE -->
        <div class="glass p-6 rounded-2xl mb-6">
            <div class="flex justify-between items-center mb-4">
                <div>
                    <p class="text-[10px] text-slate-400 uppercase font-bold">Martingale Ladder (1.2x Multiplier)</p>
                    <p class="text-xs text-slate-500 mt-1">Base Order: <span id="baseOrderDisplay" class="font-bold text-blue-600">0</span> contracts</p>
                </div>
                <div class="text-right">
                    <p class="text-[10px] text-slate-400 uppercase">Current Step</p>
                    <p id="stepIndicator" class="text-3xl font-bold text-blue-600">0/<span id="maxSteps">10</span></p>
                </div>
            </div>
            
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b-2 border-slate-200">
                            <th class="text-left py-3 text-[10px] text-slate-400 uppercase font-bold">Step</th>
                            <th class="text-right py-3 text-[10px] text-slate-400 uppercase font-bold">Add Size</th>
                            <th class="text-right py-3 text-[10px] text-slate-400 uppercase font-bold">Total Size</th>
                            <th class="text-right py-3 text-[10px] text-slate-400 uppercase font-bold">Margin Needed</th>
                            <th class="text-right py-3 text-[10px] text-slate-400 uppercase font-bold">% of Wallet</th>
                            <th class="text-center py-3 text-[10px] text-slate-400 uppercase font-bold">Status</th>
                        </tr>
                    </thead>
                    <tbody id="ladderBody">
                        <tr><td colspan="6" class="text-center py-8 text-slate-400">Loading ladder...</td></tr>
                    </tbody>
                </table>
            </div>
            
            <div class="mt-4 pt-3 border-t border-slate-100">
                <div class="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div id="totalProgress" class="bg-blue-600 h-full rounded-full transition-all duration-500" style="width: 0%"></div>
                </div>
                <p class="text-[9px] text-slate-400 text-center mt-2">Total wallet usage progression</p>
            </div>
        </div>

        <!-- Current Price & Actions -->
        <div class="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase">
            <div>Price: <span id="curPrice" class="text-slate-900 ml-1">0.00000000</span></div>
            <div>Hourly Avg: <span id="estHr" class="text-slate-900 ml-1">$0.0000</span></div>
            <button onclick="resetStats()" class="text-red-400 hover:text-red-600 transition-colors">Reset Session</button>
        </div>
    </div>

    <script>
        let currentStep = 0;
        
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(2) + '%';
                document.getElementById('bal').innerHTML = '$' + d.walletBalance.toFixed(4);
                document.getElementById('baseOrderDisplay').innerText = d.settings.baseOrder;
                document.getElementById('stepIndicator').innerHTML = d.safetyOrdersFilled + '/<span id="maxSteps">' + d.settings.maxSteps + '</span>';
                
                const roiEl = document.getElementById('roi');
                roiEl.innerText = d.roi.toFixed(2) + '%';
                roiEl.className = 'text-2xl font-bold ' + (d.roi >= 0 ? (d.roi == 0 ? 'text-slate-300' : 'text-emerald-500') : 'text-red-500');
                
                document.getElementById('dgrText').innerHTML = d.estimates.dgr.toFixed(2) + '%';
                document.getElementById('estHr').innerText = '$' + d.estimates.hr.toFixed(4);
                document.getElementById('estDay').innerText = '$' + d.estimates.day.toFixed(2);
                document.getElementById('estWeek').innerText = '$' + d.estimates.week.toFixed(2);
                document.getElementById('estMonth').innerText = '$' + d.estimates.month.toFixed(0);
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                
                currentStep = d.safetyOrdersFilled;
                
                // Render ladder
                if (d.martingaleLadder && d.martingaleLadder.length > 0) {
                    const tbody = document.getElementById('ladderBody');
                    tbody.innerHTML = '';
                    
                    let maxPercent = 0;
                    
                    d.martingaleLadder.forEach(step => {
                        const row = document.createElement('tr');
                        row.className = 'border-b border-slate-100';
                        
                        let statusClass = '';
                        let statusText = '';
                        let isActive = step.step === currentStep;
                        let isPast = step.step < currentStep;
                        let canAfford = step.canAfford;
                        
                        if (isPast && canAfford) {
                            statusText = '✓ COMPLETED';
                            statusClass = 'text-emerald-600';
                        } else if (isActive && canAfford) {
                            statusText = '⚡ ACTIVE';
                            statusClass = 'text-blue-600 font-bold';
                        } else if (!canAfford) {
                            statusText = '✗ EXCEEDS';
                            statusClass = 'text-red-500';
                        } else {
                            statusText = '○ READY';
                            statusClass = 'text-slate-400';
                        }
                        
                        if (step.percentOfWallet > maxPercent) maxPercent = step.percentOfWallet;
                        
                        row.innerHTML = \`
                            <td class="py-3 font-mono font-bold text-left">\${step.step === 0 ? 'BASE' : '#' + step.step}\${isActive ? ' 🔴' : ''}</td>
                            <td class="py-3 text-right font-mono">\${step.additionalSize.toLocaleString()}</td>
                            <td class="py-3 text-right font-mono">\${step.totalSize.toLocaleString()}</td>
                            <td class="py-3 text-right font-mono">$\${step.marginNeeded.toFixed(4)}</td>
                            <td class="py-3 text-right font-mono">\${step.percentOfWallet.toFixed(1)}%</td>
                            <td class="py-3 text-center"><span class="text-[9px] font-bold \${statusClass}">\${statusText}</span></td>
                        \`;
                        
                        if (isActive) row.classList.add('bg-blue-50');
                        tbody.appendChild(row);
                    });
                    
                    document.getElementById('totalProgress').style.width = Math.min(maxPercent, 100) + '%';
                }
            } catch (e) {
                console.error(e);
            }
        }
        
        async function resetStats() { 
            if(confirm("Reset session?")) {
                await fetch('/api/reset-stats', {method:'POST'});
                setTimeout(update, 500);
            }
        }
        
        setInterval(update, 1000); 
        update();
    </script>
</body>
</html>`);
});

app.get('/api/status', (req, res) => res.json(botState));
app.post('/api/reset-stats', async (req, res) => { 
    botState.initialBalance = botState.walletBalance; 
    botState.startTime = Date.now();
    botState.realizedProfit = 0; 
    botState.profitPct = 0;
    botState.safetyOrdersFilled = 0;
    botState.estimates = { hr: 0, day: 0, week: 0, month: 0, dgr: 0 };
    await BotModel.updateOne({ id: "htx_martingale" }, 
        { initialBalance: botState.initialBalance, startTime: botState.startTime }, 
        { upsert: true });
    res.sendStatus(200); 
});

app.listen(config.port, () => {
    console.log(`\n🚀 HTX Martingale Bot Running on port ${config.port}`);
    console.log(`📊 Symbol: ${config.symbol} | 1.2x Multiplier | 10x Leverage`);
    console.log(`🌐 Open: http://localhost:${config.port}\n`);
    boot();
});
