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

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    const accountInfo = config.accounts.map((acc, idx) => 
        `${idx === 0 ? '📈 LONG' : '📉 SHORT'} Account ${acc.accountId}`
    ).join(' | ');
    
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>HTX Dual Direction Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <meta http-equiv="refresh" content="5">
</head>
<body class="p-8 bg-gray-100">
    <div class="max-w-4xl mx-auto">
        <div class="bg-white rounded-lg shadow p-6 mb-4">
            <h1 class="text-2xl font-bold mb-2">HTX Dual Direction Bot</h1>
            <p>Symbol: ${config.symbol} | Leverage: ${config.leverage}X | TP: ${config.takeProfitPercent}% | SL: ${config.stopLossPercent}%</p>
            <p>Accounts: ${accountInfo}</p>
        </div>
        <div class="bg-white rounded-lg shadow p-6">
            <pre id="status" class="text-sm"></pre>
        </div>
    </div>
    <script>
        async function load() {
            const r = await fetch('/api/status');
            const d = await r.json();
            document.getElementById('status').innerHTML = JSON.stringify(d, null, 2);
        }
        setInterval(load, 2000);
        load();
    </script>
</body>
</html>`);
});

app.get('/api/status', (req, res) => {
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
