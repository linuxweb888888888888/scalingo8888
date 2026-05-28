require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
// Parse multiple API keys from environment
// Format: HTX_API_KEY_1, HTX_SECRET_KEY_1, HTX_API_KEY_2, HTX_SECRET_KEY_2, etc.
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
    accounts: apiAccounts
};

// ==================== ACCOUNT STATES ====================
// Each account has its own state and direction
let accountStates = {};

// Initialize states for each account
config.accounts.forEach((account, idx) => {
    const direction = idx === 0 ? 'buy' : 'sell'; // First account buys, second sells
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
    direction: direction, // 'buy' or 'sell'
    position: { volume: 0, costHold: 0 },
    totalTrades: 0,
    winningTrades: 0,
    allTimeHigh: 0,
    settings: {
        baseOrder: 1,
        takeProfit: parseFloat(process.env.TAKE_PROFIT) || 1.5, // 1.5% TP
        orderSize: parseFloat(process.env.ORDER_SIZE) || 1 // Fixed order size
    }
    };
});

// Legacy botState for backward compatibility with UI
let botState = {
    isRunning: true,
    startTime: Date.now(),
    currentPrice: 0,
    realizedProfit: 0,
    profitPct: 0,
    displayBalance: 0,
    initialBalance: 0,
    settings: {
        baseOrder: 1,
        takeProfit: 1.5
    },
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    allTimeHigh: 0,
    totalTrades: 0,
    winningTrades: 0,
    profitShibLeveraged: 0,
    openPosition: { volume: 0, direction: "", costHold: 0 },
    roi: 0,
    safetyOrdersFilled: 0,
    maxAffordableSteps: 0,
    distToNext: 0
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
        // Get account info
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

        // Get position info for this specific direction
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
        
        // Update elapsed time and estimates
        const elapsed = (Date.now() - state.startTime) / 3600000;
        const hr = state.realizedProfit / Math.max(elapsed, 0.01);
        state.estimates = { 
            hr, 
            day: hr * 24, 
            week: hr * 168, 
            month: hr * 720, 
            dgr: (hr * 24 / Math.max(state.initialBalance, 0.01)) * 100 
        };
        
        // Update total botState for UI
        updateCombinedState();
    } catch (e) {
        console.error(`Sync error for account ${account.accountId}:`, e);
    }
}

// Update combined state for UI display
function updateCombinedState() {
    let totalRealizedProfit = 0;
    let totalDisplayBalance = 0;
    let totalInitialBalance = 0;
    let totalTrades = 0;
    let totalWinningTrades = 0;
    let totalVolume = 0;
    let activeDirection = "";
    let activeCostHold = 0;
    
    Object.values(accountStates).forEach(state => {
        totalRealizedProfit += state.realizedProfit;
        totalDisplayBalance += state.displayBalance;
        totalInitialBalance += state.initialBalance;
        totalTrades += state.totalTrades;
        totalWinningTrades += state.winningTrades;
        
        if (state.position.volume > 0) {
            totalVolume += state.position.volume;
            activeDirection = state.direction;
            activeCostHold = state.avgPrice;
        }
    });
    
    botState.realizedProfit = totalRealizedProfit;
    botState.displayBalance = totalDisplayBalance;
    botState.initialBalance = totalInitialBalance;
    botState.totalTrades = totalTrades;
    botState.winningTrades = totalWinningTrades;
    botState.profitPct = totalInitialBalance > 0 ? (totalRealizedProfit / totalInitialBalance) * 100 : 0;
    
    if (totalVolume > 0) {
        botState.openPosition = { 
            volume: totalVolume, 
            direction: activeDirection, 
            costHold: activeCostHold 
        };
        botState.roi = Object.values(accountStates).find(s => s.position.volume > 0)?.roi || 0;
    } else {
        botState.openPosition = { volume: 0, direction: "", costHold: 0 };
        botState.roi = 0;
    }
    
    // Calculate profit in SHIB
    if (botState.currentPrice > 0) {
        botState.profitShibLeveraged = (botState.realizedProfit * 10) / botState.currentPrice;
    }
    
    // Calculate average daily growth rate
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
        
        // Check take profit condition
        if (hasPosition && state.roi >= state.settings.takeProfit) {
            // Close position with profit
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
            console.log(`Account ${account.accountId}: Closed ${state.direction} position with ${state.roi}% profit`);
        } 
        // Open position if no position exists
        else if (!hasPosition && state.settings.baseOrder > 0) {
            await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: state.settings.orderSize,
                direction: state.direction, 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            state.totalTrades++;
            console.log(`Account ${account.accountId}: Opened ${state.direction} position with ${state.settings.orderSize} contracts`);
        }
    } catch (e) {
        console.error(`Trade error for account ${account.accountId}:`, e);
    }
    
    state.isTrading = false;
}

// Main trading check that iterates through all accounts
async function checkTrades() {
    for (let i = 0; i < config.accounts.length; i++) {
        const account = config.accounts[i];
        const state = accountStates[account.accountId];
        await checkTradesForAccount(account, state);
    }
}

// ==================== UI ====================
app.get('/', (req, res) => {
    // Create account info display string
    const accountInfo = config.accounts.map((acc, idx) => 
        `${idx === 0 ? '📈 LONG' : '📉 SHORT'} Account ${acc.accountId}`
    ).join(' | ');
    
    res.send(`
<!DOCTYPE html>
<html class="bg-white">
<head>
    <title>HTX Dual Direction Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background: #ffffff; }
        .card { background: white; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .gradient-text { background: linear-gradient(135deg, #059669 0%, #0284c7 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stat-number { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
    </style>
</head>
<body class="text-gray-900 p-6 md:p-10 bg-gray-50">
    <div class="max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold tracking-tight">DUAL<span class="gradient-text">_DIRECTION</span></h1>
                <p class="text-[10px] text-gray-400 uppercase tracking-widest mt-1">${config.symbol} | ${config.leverage}X LEVERAGE</p>
                <p class="text-[10px] text-emerald-600 font-bold mt-2">🎯 ${accountInfo}</p>
                <p class="text-[10px] text-blue-600 mt-1">🔄 One direction per account | Fixed position sizing</p>
            </div>
            <div class="text-right">
                <p id="dgrText" class="text-3xl font-bold text-emerald-600">0.00%</p>
                <p class="text-[10px] text-gray-400 uppercase tracking-wider">Daily Growth Rate</p>
            </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Total Net Profit</p>
                <p id="p1" class="text-2xl font-bold text-emerald-600 stat-number">$0.00</p>
                <p id="p2" class="text-[10px] font-bold text-gray-400 mt-1">0.00% TOTAL GAIN</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Profit SHIB (10x)</p>
                <p id="pShib" class="text-2xl font-bold text-emerald-900 stat-number">0</p>
                <p class="text-[10px] font-bold text-gray-400 mt-1 uppercase">Units</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Open ROI</p>
                <p id="roi" class="text-2xl font-bold stat-number">0.00%</p>
                <p id="directionText" class="text-[10px] font-bold text-blue-600 mt-1">NO ACTIVE POSITION</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Active Accounts</p>
                <p id="activeAccounts" class="text-2xl font-bold text-blue-600 stat-number">${config.accounts.length}</p>
                <p class="text-[10px] font-bold text-gray-400 mt-1 uppercase">Buy/Sell Separate</p>
            </div>
            <div class="card p-6 rounded-2xl">
                <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Combined Balance</p>
                <p id="bal" class="text-2xl font-bold text-gray-900 stat-number">$0.00</p>
                <p id="totalTrades" class="text-[10px] font-bold text-gray-400 mt-1">0 TOTAL TRADES</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            ${config.accounts.map((acc, idx) => `
            <div class="card p-6 rounded-2xl bg-gradient-to-r ${idx === 0 ? 'from-emerald-50 to-white' : 'from-red-50 to-white'}">
                <div class="flex justify-between items-start mb-4">
                    <div>
                        <p class="text-[10px] text-gray-400 uppercase tracking-wider">Account ${acc.accountId}</p>
                        <p class="text-lg font-bold ${idx === 0 ? 'text-emerald-600' : 'text-red-600'}">${idx === 0 ? '📈 LONG' : '📉 SHORT'}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs font-mono font-bold">Balance</p>
                        <p id="balance_${acc.accountId}" class="text-sm font-bold">$0.00</p>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3 text-xs">
                    <div>
                        <p class="text-gray-400">Position</p>
                        <p id="position_${acc.accountId}" class="font-bold">0</p>
                    </div>
                    <div>
                        <p class="text-gray-400">ROI</p>
                        <p id="roi_${acc.accountId}" class="font-bold">0%</p>
                    </div>
                    <div>
                        <p class="text-gray-400">Profit</p>
                        <p id="profit_${acc.accountId}" class="font-bold text-emerald-600">$0</p>
                    </div>
                    <div>
                        <p class="text-gray-400">Trades</p>
                        <p id="trades_${acc.accountId}" class="font-bold">0</p>
                    </div>
                </div>
            </div>
            `).join('')}
        </div>

        <div class="card p-6 rounded-2xl bg-gray-50">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 items-center">
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Order Size</p>
                    <p id="orderSize" class="text-xl font-bold text-gray-800">${config.accounts[0]?.settings.orderSize || 1}</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Live Price</p>
                    <p id="curPrice" class="text-xl font-mono font-bold text-gray-800">0.00000000</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Take Profit</p>
                    <p class="text-xl font-bold text-emerald-600">${config.accounts[0]?.settings.takeProfit || 1.5}%</p>
                </div>
                <div>
                    <p class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Strategy</p>
                    <p class="text-xl font-bold text-purple-600">Fixed Size</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function update() {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                document.getElementById('p1').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('p2').innerText = d.profitPct.toFixed(4) + '% TOTAL GAIN';
                document.getElementById('pShib').innerText = Math.floor(d.profitShibLeveraged).toLocaleString();
                document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
                document.getElementById('roi').style.color = d.roi >= 0 ? '#059669' : '#dc2626';
                document.getElementById('bal').innerText = '$' + d.displayBalance.toFixed(2);
                document.getElementById('totalTrades').innerText = d.totalTrades + ' TOTAL TRADES';
                document.getElementById('dgrText').innerText = d.estimates.dgr.toFixed(4) + '%';
                document.getElementById('curPrice').innerText = d.currentPrice.toFixed(8);
                
                if (d.openPosition.volume > 0) {
                    document.getElementById('directionText').innerHTML = d.openPosition.direction.toUpperCase() + ' ' + d.openPosition.volume + ' CONTRACTS';
                } else {
                    document.getElementById('directionText').innerHTML = 'NO ACTIVE POSITION';
                }
                
                // Update individual account stats if available
                if (d.accounts) {
                    for (const acc of d.accounts) {
                        document.getElementById('balance_' + acc.id)?.innerText = '$' + acc.balance.toFixed(2);
                        document.getElementById('position_' + acc.id)?.innerText = acc.position;
                        document.getElementById('roi_' + acc.id)?.innerText = acc.roi.toFixed(2) + '%';
                        document.getElementById('profit_' + acc.id)?.innerText = '$' + acc.profit.toFixed(2);
                        document.getElementById('trades_' + acc.id)?.innerText = acc.trades;
                    }
                }
            } catch (e) {}
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => {
    // Add individual account data to response
    const accountsData = Object.entries(accountStates).map(([id, state]) => ({
        id: parseInt(id),
        balance: state.displayBalance,
        position: state.position.volume,
        roi: state.roi,
        profit: state.realizedProfit,
        trades: state.totalTrades,
        direction: state.direction
    }));
    
    res.json({
        ...botState,
        accounts: accountsData
    });
});

// ==================== WEB SOCKET & MAIN ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) {
                botState.currentPrice = parseFloat(msg.tick.close);
                // Update current price for all accounts
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

// ==================== INITIALIZE & START ====================
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
    console.log(`Order Size: ${config.accounts[0]?.settings.orderSize || 1} contracts`);
    console.log(`Take Profit: ${config.accounts[0]?.settings.takeProfit || 1.5}%`);
    console.log('========================================\n');
    
    // Initial sync for all accounts
    for (let i = 0; i < config.accounts.length; i++) {
        const account = config.accounts[i];
        const state = accountStates[account.accountId];
        await syncAccountData(account, state);
    }
    
    app.listen(config.port, () => {
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
