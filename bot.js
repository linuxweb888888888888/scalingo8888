require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const apiAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`] && process.env[`HTX_SECRET_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}

// If no numbered keys found, try single key format
if (apiAccounts.length === 0 && process.env.HTX_API_KEY && process.env.HTX_SECRET_KEY) {
    apiAccounts.push({
        apiKey: process.env.HTX_API_KEY,
        secretKey: process.env.HTX_SECRET_KEY,
        accountId: 1
    });
}

const config = {
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 2.0,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 2.0,
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1
};

// ==================== ACCOUNT STATES ====================
let accountStates = {};

// Initialize states for each account
config.accounts.forEach((account, idx) => {
    const direction = idx === 0 ? 'buy' : 'sell';
    accountStates[account.accountId] = {
        isRunning: true,
        isTrading: false,
        startTime: Date.now(),
        currentPrice: 0,
        avgPrice: 0,
        roi: 0,
        realizedProfit: 0,
        profitPct: 0,
        walletBalance: 0,
        displayBalance: 0,
        peakBalance: 0,
        initialBalance: 0,
        direction: direction,
        position: { volume: 0, costHold: 0 },
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        allTimeHigh: 0,
        settings: {
            takeProfit: config.takeProfitPercent,
            stopLoss: config.stopLossPercent,
            orderSize: config.orderSize
        }
    };
});

// Combined botState for UI
let botState = {
    isRunning: true,
    startTime: Date.now(),
    currentPrice: 0,
    realizedProfit: 0,
    profitPct: 0,
    displayBalance: 0,
    initialBalance: 0,
    settings: {
        takeProfit: config.takeProfitPercent,
        stopLoss: config.stopLossPercent
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    profitShibLeveraged: 0,
    openPosition: { volume: 0, direction: "", costHold: 0 },
    roi: 0
};

// ==================== API HANDLER ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { 
        AccessKeyId: account.apiKey, 
        SignatureMethod: 'HmacSHA256', 
        SignatureVersion: '2', 
        Timestamp: timestamp 
    };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { 
        console.error(`API Error for account ${account.accountId}:`, e.message);
        return null; 
    }
}

// ==================== DATA SYNC ====================
async function syncAccountData(account, state) {
    try {
        const accRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const equity = parseFloat(acc.margin_balance);
            const unrealized = parseFloat(acc.profit_unreal) || 0;
            const realBalance = equity - unrealized;

            if (state.initialBalance <= 0) {
                state.initialBalance = realBalance;
                state.displayBalance = realBalance;
                state.peakBalance = realBalance;
            }
            if (realBalance > state.peakBalance) {
                state.displayBalance += (realBalance - state.peakBalance);
                state.peakBalance = realBalance;
                if (state.displayBalance > (state.allTimeHigh || 0)) state.allTimeHigh = state.displayBalance;
            }
            state.walletBalance = realBalance;
            state.realizedProfit = state.displayBalance - state.initialBalance;
            state.profitPct = (state.realizedProfit / state.initialBalance) * 100;
        }

        const posRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);

        if (pos) {
            state.avgPrice = parseFloat(pos.cost_hold);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.position = { 
                volume: parseFloat(pos.volume), 
                costHold: state.avgPrice 
            };
        } else {
            state.position = { volume: 0, costHold: 0 };
            state.roi = 0;
            state.avgPrice = 0;
        }
        
        const elapsed = (Date.now() - state.startTime) / 3600000;
        const hr = state.realizedProfit / Math.max(elapsed, 0.01);
        state.estimates = { 
            hr, 
            day: hr * 24, 
            week: hr * 168, 
            month: hr * 720, 
            dgr: (hr * 24 / Math.max(state.initialBalance, 0.01)) * 100 
        };
        
        updateCombinedState();
    } catch (e) {
        console.error(`Sync error for account ${account.accountId}:`, e);
    }
}

function updateCombinedState() {
    let totalRealizedProfit = 0;
    let totalDisplayBalance = 0;
    let totalInitialBalance = 0;
    let totalTrades = 0;
    let totalWinningTrades = 0;
    let totalLosingTrades = 0;
    let totalVolume = 0;
    let activeDirection = "";
    let activeCostHold = 0;
    let activeRoi = 0;
    
    Object.values(accountStates).forEach(state => {
        totalRealizedProfit += state.realizedProfit;
        totalDisplayBalance += state.displayBalance;
        totalInitialBalance += state.initialBalance;
        totalTrades += state.totalTrades;
        totalWinningTrades += state.winningTrades;
        totalLosingTrades += state.losingTrades;
        
        if (state.position.volume > 0) {
            totalVolume += state.position.volume;
            activeDirection = state.direction;
            activeCostHold = state.avgPrice;
            activeRoi = state.roi;
        }
    });
    
    botState.realizedProfit = totalRealizedProfit;
    botState.displayBalance = totalDisplayBalance;
    botState.initialBalance = totalInitialBalance;
    botState.totalTrades = totalTrades;
    botState.winningTrades = totalWinningTrades;
    botState.losingTrades = totalLosingTrades;
    botState.profitPct = totalInitialBalance > 0 ? (totalRealizedProfit / totalInitialBalance) * 100 : 0;
    
    if (totalVolume > 0) {
        botState.openPosition = { 
            volume: totalVolume, 
            direction: activeDirection, 
            costHold: activeCostHold 
        };
        botState.roi = activeRoi;
    } else {
        botState.openPosition = { volume: 0, direction: "", costHold: 0 };
        botState.roi = 0;
    }
    
    if (botState.currentPrice > 0) {
        botState.profitShibLeveraged = (botState.realizedProfit * 10) / botState.currentPrice;
    }
    
    const elapsed = (Date.now() - botState.startTime) / 3600000;
    const hr = botState.realizedProfit / Math.max(elapsed, 0.01);
    botState.estimates = { 
        hr, 
        day: hr * 24, 
        week: hr * 168, 
        month: hr * 720, 
        dgr: (hr * 24 / Math.max(botState.initialBalance, 0.01)) * 100 
    };
}

// ==================== TRADING LOGIC ====================
async function checkTradesForAccount(account, state) {
    if (!state.isRunning || state.isTrading || botState.currentPrice <= 0) return;
    state.isTrading = true;
    
    try {
        const hasPosition = state.position.volume > 0;
        
        if (hasPosition) {
            if (state.roi >= state.settings.takeProfit) {
                const closeDirection = state.direction === 'buy' ? 'sell' : 'buy';
                await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: state.position.volume,
                    direction: closeDirection, 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                state.winningTrades++;
                state.totalTrades++;
                console.log(`✅ Account ${account.accountId} (${state.direction.toUpperCase()}): TAKE PROFIT at ${state.roi.toFixed(2)}%`);
            } 
            else if (state.roi <= -state.settings.stopLoss) {
                const closeDirection = state.direction === 'buy' ? 'sell' : 'buy';
                await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, 
                    volume: state.position.volume,
                    direction: closeDirection, 
                    offset: 'close', 
                    lever_rate: config.leverage, 
                    order_price_type: 'opponent'
                });
                state.losingTrades++;
                state.totalTrades++;
                console.log(`❌ Account ${account.accountId} (${state.direction.toUpperCase()}): STOP LOSS at ${state.roi.toFixed(2)}%`);
            }
        } 
        else if (!hasPosition && state.settings.orderSize > 0) {
            await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: state.settings.orderSize,
                direction: state.direction, 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            state.totalTrades++;
            console.log(`🟢 Account ${account.accountId}: Opened ${state.direction.toUpperCase()} position with ${state.settings.orderSize} contracts`);
        }
    } catch (e) {
        console.error(`Trade error for account ${account.accountId}:`, e);
    }
    
    state.isTrading = false;
}

async function checkTrades() {
    for (let i = 0; i < config.accounts.length; i++) {
        const account = config.accounts[i];
        const state = accountStates[account.accountId];
        await checkTradesForAccount(account, state);
    }
}

// ==================== WEB UI WITH NEAT DESIGN ====================
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Dual Direction Trading Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .card-hover { transition: all 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.02); }
        .number-font { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
        @keyframes pulse-green {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .pulse { animation: pulse-green 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    </style>
</head>
<body class="bg-gradient-to-br from-gray-50 to-gray-100">
    <div class="container mx-auto px-4 py-8 max-w-7xl">
        <!-- Header -->
        <div class="gradient-bg rounded-2xl shadow-2xl p-6 mb-8 text-white">
            <div class="flex justify-between items-center">
                <div>
                    <h1 class="text-4xl font-bold mb-2">🤖 HTX Dual Direction Bot</h1>
                    <p class="text-white/80 text-sm">Advanced Futures Trading Automation | LONG + SHORT Strategy</p>
                </div>
                <div class="text-right">
                    <div class="text-3xl font-bold number-font" id="livePrice">$0.00000000</div>
                    <div class="text-sm text-white/70">${config.symbol}</div>
                </div>
            </div>
            <div class="grid grid-cols-4 gap-4 mt-6 pt-4 border-t border-white/20">
                <div>
                    <div class="text-xs text-white/70">Leverage</div>
                    <div class="text-xl font-bold">${config.leverage}X</div>
                </div>
                <div>
                    <div class="text-xs text-white/70">Order Size</div>
                    <div class="text-xl font-bold">${config.orderSize} contracts</div>
                </div>
                <div>
                    <div class="text-xs text-white/70">Take Profit</div>
                    <div class="text-xl font-bold text-green-300">${config.takeProfitPercent}%</div>
                </div>
                <div>
                    <div class="text-xs text-white/70">Stop Loss</div>
                    <div class="text-xl font-bold text-red-300">${config.stopLossPercent}%</div>
                </div>
            </div>
        </div>

        <!-- Combined Stats -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div class="bg-white rounded-xl shadow-lg p-6 card-hover">
                <div class="text-gray-500 text-sm mb-2">💰 Total Net Profit</div>
                <div class="text-3xl font-bold text-green-600 number-font" id="totalProfit">$0.00</div>
                <div class="text-sm text-gray-500 mt-2" id="totalProfitPct">0.00%</div>
            </div>
            <div class="bg-white rounded-xl shadow-lg p-6 card-hover">
                <div class="text-gray-500 text-sm mb-2">📊 Total Balance</div>
                <div class="text-3xl font-bold text-blue-600 number-font" id="totalBalance">$0.00</div>
                <div class="text-sm text-gray-500 mt-2">Initial: $<span id="initialBalance">0.00</span></div>
            </div>
            <div class="bg-white rounded-xl shadow-lg p-6 card-hover">
                <div class="text-gray-500 text-sm mb-2">🎯 Win/Loss Ratio</div>
                <div class="text-3xl font-bold text-purple-600 number-font" id="wlRatio">0.00</div>
                <div class="text-sm text-gray-500 mt-2">Wins: <span id="wins">0</span> | Losses: <span id="losses">0</span></div>
            </div>
            <div class="bg-white rounded-xl shadow-lg p-6 card-hover">
                <div class="text-gray-500 text-sm mb-2">📈 Daily Growth Rate</div>
                <div class="text-3xl font-bold text-emerald-600 number-font" id="dgr">0.00%</div>
                <div class="text-sm text-gray-500 mt-2">Total Trades: <span id="totalTradesCount">0</span></div>
            </div>
        </div>

        <!-- Account Cards -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8" id="accountsContainer"></div>

        <!-- Charts Section -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h3 class="text-lg font-bold mb-4">Profit Timeline</h3>
                <canvas id="profitChart" height="200"></canvas>
            </div>
            <div class="bg-white rounded-xl shadow-lg p-6">
                <h3 class="text-lg font-bold mb-4">Performance Metrics</h3>
                <div class="space-y-4">
                    <div>
                        <div class="flex justify-between text-sm mb-1">
                            <span>Win Rate</span>
                            <span id="winRate">0%</span>
                        </div>
                        <div class="w-full bg-gray-200 rounded-full h-2">
                            <div id="winRateBar" class="bg-green-500 rounded-full h-2" style="width: 0%"></div>
                        </div>
                    </div>
                    <div>
                        <div class="flex justify-between text-sm mb-1">
                            <span>Profit Factor</span>
                            <span id="profitFactor">0.00</span>
                        </div>
                        <div class="w-full bg-gray-200 rounded-full h-2">
                            <div id="profitFactorBar" class="bg-blue-500 rounded-full h-2" style="width: 0%"></div>
                        </div>
                    </div>
                    <div>
                        <div class="flex justify-between text-sm mb-1">
                            <span>Expected Value</span>
                            <span id="expectedValue">$0.00</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Status Badge -->
        <div class="bg-white rounded-xl shadow-lg p-4 text-center">
            <div class="flex items-center justify-center gap-2">
                <div class="w-2 h-2 bg-green-500 rounded-full pulse"></div>
                <span class="text-sm text-gray-600">Bot is actively monitoring markets | Last update: <span id="lastUpdate">Just now</span></span>
            </div>
        </div>
    </div>

    <script>
        let profitHistory = [];
        let profitChart = null;

        async function updateUI() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                document.getElementById('totalProfit').innerText = '$' + data.realizedProfit.toFixed(4);
                document.getElementById('totalProfitPct').innerText = data.profitPct.toFixed(2) + '%';
                document.getElementById('totalBalance').innerText = '$' + data.displayBalance.toFixed(2);
                document.getElementById('initialBalance').innerText = data.initialBalance.toFixed(2);
                document.getElementById('livePrice').innerText = '$' + data.currentPrice.toFixed(8);
                document.getElementById('totalTradesCount').innerText = data.totalTrades;
                document.getElementById('wins').innerText = data.winningTrades;
                document.getElementById('losses').innerText = data.losingTrades;
                
                const winLossRatio = data.winningTrades / Math.max(data.losingTrades, 1);
                document.getElementById('wlRatio').innerText = winLossRatio.toFixed(2);
                document.getElementById('dgr').innerText = data.estimates.dgr.toFixed(2) + '%';
                
                const winRate = (data.winningTrades / Math.max(data.totalTrades, 1)) * 100;
                document.getElementById('winRate').innerText = winRate.toFixed(1) + '%';
                document.getElementById('winRateBar').style.width = winRate + '%';
                
                const profitFactor = data.totalTrades > 0 ? (data.winningTrades / Math.max(data.losingTrades, 1)) : 0;
                document.getElementById('profitFactor').innerText = profitFactor.toFixed(2);
                document.getElementById('profitFactorBar').style.width = Math.min(profitFactor * 20, 100) + '%';
                
                const expectedValue = data.realizedProfit / Math.max(data.totalTrades, 1);
                document.getElementById('expectedValue').innerText = '$' + expectedValue.toFixed(4);
                
                // Update account cards
                if (data.accounts && data.accounts.length > 0) {
                    const container = document.getElementById('accountsContainer');
                    container.innerHTML = '';
                    
                    data.accounts.forEach((acc, idx) => {
                        const isLong = idx === 0;
                        const bgGradient = isLong ? 'from-emerald-50 to-emerald-100/30' : 'from-red-50 to-red-100/30';
                        const borderColor = isLong ? 'border-emerald-200' : 'border-red-200';
                        const icon = isLong ? '📈' : '📉';
                        const title = isLong ? 'LONG POSITION' : 'SHORT POSITION';
                        
                        const card = document.createElement('div');
                        card.className = \`bg-gradient-to-br \${bgGradient} rounded-xl shadow-lg p-6 card-hover border \${borderColor}\`;
                        card.innerHTML = \`
                            <div class="flex justify-between items-start mb-4">
                                <div>
                                    <div class="text-3xl mb-2">\${icon}</div>
                                    <h3 class="text-xl font-bold">Account \${acc.id}</h3>
                                    <div class="text-sm text-gray-600">\${title}</div>
                                </div>
                                <div class="text-right">
                                    <div class="text-xs text-gray-500">Balance</div>
                                    <div class="text-2xl font-bold number-font" id="balance_\${acc.id}">$\${acc.balance.toFixed(2)}</div>
                                </div>
                            </div>
                            <div class="grid grid-cols-2 gap-4 mb-4">
                                <div>
                                    <div class="text-xs text-gray-500">Position Size</div>
                                    <div class="text-lg font-bold number-font" id="position_\${acc.id}">\${acc.position}</div>
                                </div>
                                <div>
                                    <div class="text-xs text-gray-500">Current ROI</div>
                                    <div class="text-lg font-bold number-font" id="roi_\${acc.id}" style="color: \${acc.roi >= 0 ? '#059669' : '#dc2626'}">\${acc.roi.toFixed(2)}%</div>
                                </div>
                                <div>
                                    <div class="text-xs text-gray-500">Avg Entry</div>
                                    <div class="text-sm number-font">$\${(acc.avgPrice || 0).toFixed(8)}</div>
                                </div>
                                <div>
                                    <div class="text-xs text-gray-500">Trades</div>
                                    <div class="text-sm number-font">\${acc.trades}</div>
                                </div>
                            </div>
                            <div class="border-t pt-3">
                                <div class="flex justify-between text-sm">
                                    <span class="text-gray-600">Realized P&L</span>
                                    <span class="font-bold number-font" style="color: \${acc.profit >= 0 ? '#059669' : '#dc2626'}">$\${acc.profit.toFixed(2)}</span>
                                </div>
                            </div>
                        \`;
                        container.appendChild(card);
                    });
                }
                
                profitHistory.push(data.realizedProfit);
                if (profitHistory.length > 50) profitHistory.shift();
                
                if (profitChart) {
                    profitChart.data.datasets[0].data = profitHistory;
                    profitChart.update();
                }
                
                document.getElementById('lastUpdate').innerText = new Date().toLocaleTimeString();
            } catch (error) {
                console.error('Error updating UI:', error);
            }
        }
        
        function initChart() {
            const ctx = document.getElementById('profitChart').getContext('2d');
            profitChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: Array(50).fill(''),
                    datasets: [{
                        label: 'Total Profit ($)',
                        data: Array(50).fill(0),
                        borderColor: 'rgb(16, 185, 129)',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: { display: false },
                        tooltip: { mode: 'index', intersect: false }
                    },
                    scales: {
                        y: { beginAtZero: false, grid: { color: 'rgba(0,0,0,0.05)' } },
                        x: { display: false }
                    }
                }
            });
        }
        
        initChart();
        setInterval(updateUI, 1000);
        updateUI();
    </script>
</body>
</html>`;
    res.send(htmlContent);
});

app.get('/api/status', (req, res) => {
    const accountsData = Object.entries(accountStates).map(([id, state]) => ({
        id: parseInt(id),
        balance: state.displayBalance,
        position: state.position.volume,
        roi: state.roi,
        profit: state.realizedProfit,
        trades: state.totalTrades,
        direction: state.direction,
        avgPrice: state.avgPrice,
        initialBalance: state.initialBalance
    }));
    
    res.json({
        ...botState,
        accounts: accountsData
    });
});

// ==================== WEBSOCKET ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) {
                botState.currentPrice = parseFloat(msg.tick.close);
                Object.values(accountStates).forEach(state => {
                    state.currentPrice = botState.currentPrice;
                });
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
    ws.on('error', (err) => console.error('WebSocket error:', err));
}

// ==================== INITIALIZE ====================
async function initialize() {
    console.log('========================================');
    console.log('DUAL DIRECTION TRADING BOT');
    console.log('========================================');
    console.log(`Symbol: ${config.symbol}`);
    console.log(`Leverage: ${config.leverage}X`);
    console.log(`Active Accounts: ${config.accounts.length}`);
    config.accounts.forEach((acc, idx) => {
        console.log(`  Account ${acc.accountId}: ${idx === 0 ? 'BUY (LONG)' : 'SELL (SHORT)'} direction`);
    });
    console.log(`Order Size: ${config.orderSize} contracts`);
    console.log(`Take Profit: ${config.takeProfitPercent}%`);
    console.log(`Stop Loss: ${config.stopLossPercent}%`);
    console.log('========================================\n');
    
    for (let i = 0; i < config.accounts.length; i++) {
        const account = config.accounts[i];
        const state = accountStates[account.accountId];
        await syncAccountData(account, state);
    }
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Web UI: http://localhost:${config.port}`);
        startWS();
        setInterval(async () => {
            for (let i = 0; i < config.accounts.length; i++) {
                await syncAccountData(config.accounts[i], accountStates[config.accounts[i].accountId]);
            }
        }, 2000);
        setInterval(checkTrades, 3000);
    });
}

initialize();
