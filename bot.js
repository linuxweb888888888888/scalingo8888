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
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1,
    hedgeThreshold: parseFloat(process.env.HEDGE_THRESHOLD) || 0.1
};

// ==================== ACCOUNT STATES ====================
let accountStates = {};
let lastSyncTime = 0;
let totalResets = 0;
let isOpeningPositions = false;

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
        lastOpenTime: 0,
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
    roi: 0,
    hedgeDeviation: 0,
    longRoi: 0,
    shortRoi: 0,
    totalResets: 0,
    lastResetReason: ""
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
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
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
                console.log(`Account ${account.accountId} (${state.direction.toUpperCase()}) Initial Balance: $${realBalance.toFixed(2)}`);
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
    let longRoi = 0;
    let shortRoi = 0;
    
    Object.values(accountStates).forEach(state => {
        totalRealizedProfit += state.realizedProfit;
        totalDisplayBalance += state.displayBalance;
        totalInitialBalance += state.initialBalance;
        totalTrades += state.totalTrades;
        totalWinningTrades += state.winningTrades;
        totalLosingTrades += state.losingTrades;
        
        if (state.direction === 'buy') {
            longRoi = state.roi;
        } else if (state.direction === 'sell') {
            shortRoi = state.roi;
        }
    });
    
    botState.realizedProfit = totalRealizedProfit;
    botState.displayBalance = totalDisplayBalance;
    botState.initialBalance = totalInitialBalance;
    botState.totalTrades = totalTrades;
    botState.winningTrades = totalWinningTrades;
    botState.losingTrades = totalLosingTrades;
    botState.profitPct = totalInitialBalance > 0 ? (totalRealizedProfit / totalInitialBalance) * 100 : 0;
    botState.longRoi = longRoi;
    botState.shortRoi = shortRoi;
    botState.hedgeDeviation = Math.abs(longRoi + shortRoi);
    botState.totalResets = totalResets;
    botState.roi = longRoi !== 0 ? longRoi : shortRoi;
    
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

// ==================== ATOMIC POSITION OPENING ====================
async function openBothPositionsTogether() {
    if (config.accounts.length < 2) return false;
    if (isOpeningPositions) return false;
    
    const longAccount = config.accounts[0];
    const shortAccount = config.accounts[1];
    const longState = accountStates[longAccount.accountId];
    const shortState = accountStates[shortAccount.accountId];
    
    // Check if both are closed
    const longHasPosition = longState.position.volume > 0;
    const shortHasPosition = shortState.position.volume > 0;
    
    if (!longHasPosition && !shortHasPosition) {
        isOpeningPositions = true;
        
        console.log(`\n🔗 Attempting to open BOTH positions simultaneously at ${botState.currentPrice}`);
        
        try {
            // Check balances first
            console.log(`   Checking balances...`);
            console.log(`   LONG Account Balance: $${longState.walletBalance.toFixed(2)}`);
            console.log(`   SHORT Account Balance: $${shortState.walletBalance.toFixed(2)}`);
            
            if (longState.walletBalance < 1) {
                console.log(`   ❌ LONG account has insufficient balance! Need at least $1 USDT`);
            }
            if (shortState.walletBalance < 1) {
                console.log(`   ❌ SHORT account has insufficient balance! Need at least $1 USDT`);
            }
            
            // Open LONG position
            console.log(`   Opening LONG position...`);
            const longOrder = await htxRequest(longAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: longState.settings.orderSize,
                direction: 'buy',
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            
            if (longOrder?.data?.order_id) {
                console.log(`   ✅ LONG position opened successfully (Order: ${longOrder.data.order_id})`);
            } else {
                console.log(`   ❌ LONG position failed:`, longOrder);
            }
            
            // Wait 1 second between orders
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Open SHORT position
            console.log(`   Opening SHORT position...`);
            const shortOrder = await htxRequest(shortAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: shortState.settings.orderSize,
                direction: 'sell',
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            
            if (shortOrder?.data?.order_id) {
                console.log(`   ✅ SHORT position opened successfully (Order: ${shortOrder.data.order_id})`);
            } else {
                console.log(`   ❌ SHORT position failed:`, shortOrder);
            }
            
            // Verify both opened
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Refresh data to check if positions are actually open
            await syncAccountData(longAccount, longState);
            await syncAccountData(shortAccount, shortState);
            
            const longNowHasPosition = longState.position.volume > 0;
            const shortNowHasPosition = shortState.position.volume > 0;
            
            if (longNowHasPosition && shortNowHasPosition) {
                console.log(`   ✅ SUCCESS: Both positions are now open!`);
                longState.totalTrades++;
                shortState.totalTrades++;
                longState.lastOpenTime = Date.now();
                shortState.lastOpenTime = Date.now();
                console.log(`=========================================\n`);
                isOpeningPositions = false;
                return true;
            } else if (!longNowHasPosition && !shortNowHasPosition) {
                console.log(`   ❌ FAILED: Neither position opened`);
            } else if (!longNowHasPosition) {
                console.log(`   ⚠️ PARTIAL: Only SHORT position opened - LONG failed`);
                // Close the open position to maintain consistency
                console.log(`   Closing orphaned SHORT position...`);
                await htxRequest(shortAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol,
                    volume: shortState.position.volume,
                    direction: 'buy',
                    offset: 'close',
                    lever_rate: config.leverage,
                    order_price_type: 'opponent'
                });
            } else if (!shortNowHasPosition) {
                console.log(`   ⚠️ PARTIAL: Only LONG position opened - SHORT failed`);
                // Close the open position to maintain consistency
                console.log(`   Closing orphaned LONG position...`);
                await htxRequest(longAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol,
                    volume: longState.position.volume,
                    direction: 'sell',
                    offset: 'close',
                    lever_rate: config.leverage,
                    order_price_type: 'opponent'
                });
            }
            
        } catch (error) {
            console.error(`   Error opening positions:`, error);
        }
        
        console.log(`=========================================\n`);
        isOpeningPositions = false;
        return false;
    }
    return false;
}

// ==================== FORCE RESET (close both if only one open) ====================
async function forceResetIfOnlyOneOpen() {
    if (config.accounts.length < 2) return;
    
    const longAccount = config.accounts[0];
    const shortAccount = config.accounts[1];
    const longState = accountStates[longAccount.accountId];
    const shortState = accountStates[shortAccount.accountId];
    
    const longHasPosition = longState.position.volume > 0;
    const shortHasPosition = shortState.position.volume > 0;
    
    // If ONLY ONE side has a position, close it immediately
    if (longHasPosition !== shortHasPosition) {
        console.log(`\n⚠️ IMBALANCE DETECTED: Only ${longHasPosition ? 'LONG' : 'SHORT'} has position`);
        
        if (longHasPosition) {
            console.log(`   Closing orphaned LONG position...`);
            await htxRequest(longAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: longState.position.volume,
                direction: 'sell',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            console.log(`   ✅ LONG position closed`);
        } else if (shortHasPosition) {
            console.log(`   Closing orphaned SHORT position...`);
            await htxRequest(shortAccount, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: shortState.position.volume,
                direction: 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            console.log(`   ✅ SHORT position closed`);
        }
        
        console.log(`   Both positions now closed. Will reopen together.`);
        console.log(`=========================================\n`);
        
        totalResets++;
        botState.lastResetReason = "Single side only - force reset";
    }
}

// ==================== CHECK HEDGE PERFECT ====================
async function checkHedgePerfect() {
    if (config.accounts.length < 2) return;
    
    const longState = accountStates[config.accounts[0].accountId];
    const shortState = accountStates[config.accounts[1].accountId];
    
    const longHasPosition = longState.position.volume > 0;
    const shortHasPosition = shortState.position.volume > 0;
    
    // If both have positions, check hedge deviation
    if (longHasPosition && shortHasPosition) {
        const deviation = Math.abs(longState.roi + shortState.roi);
        
        if (deviation > config.hedgeThreshold) {
            console.log(`\n🔄 HEDGE RESET TRIGGERED - Deviation: ${deviation.toFixed(2)}%`);
            console.log(`   LONG ROI: ${longState.roi.toFixed(2)}% | SHORT ROI: ${shortState.roi.toFixed(2)}%`);
            
            // Close both positions
            await htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: longState.position.volume,
                direction: 'sell',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            
            await new Promise(resolve => setTimeout(resolve, 500));
            
            await htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: shortState.position.volume,
                direction: 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            
            console.log(`   ✅ Both positions closed`);
            console.log(`   Will reopen both together on next cycle`);
            console.log(`=========================================\n`);
            
            totalResets++;
            botState.lastResetReason = `Hedge deviation ${deviation.toFixed(2)}% > ${config.hedgeThreshold}%`;
        }
    }
}

async function checkTradesForAccount(account, state) {
    if (!state.isRunning || state.isTrading || botState.currentPrice <= 0) return;
    
    const hasPosition = state.position.volume > 0;
    
    if (hasPosition) {
        state.isTrading = true;
        try {
            // Check take profit
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
            // Check stop loss
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
        } catch (e) {
            console.error(`Trade error for account ${account.accountId}:`, e);
        }
        state.isTrading = false;
    }
}

async function checkTrades() {
    // FIRST: Force close if only one side is open (most important)
    await forceResetIfOnlyOneOpen();
    
    // SECOND: Open both positions together if both are closed
    await openBothPositionsTogether();
    
    // THIRD: Check hedge deviation if both are open
    await checkHedgePerfect();
    
    // FOURTH: Check take profit/stop loss
    for (let i = 0; i < config.accounts.length; i++) {
        const account = config.accounts[i];
        const state = accountStates[account.accountId];
        await checkTradesForAccount(account, state);
    }
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Perfect Hedge Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .card-hover { transition: all 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); }
        .number-font { font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
        @keyframes pulse-green { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .pulse { animation: pulse-green 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    </style>
</head>
<body class="bg-gradient-to-br from-gray-50 to-gray-100">
    <div class="container mx-auto px-4 py-8 max-w-7xl">
        <div class="gradient-bg rounded-2xl shadow-2xl p-6 mb-8 text-white">
            <div class="flex justify-between items-center">
                <div>
                    <h1 class="text-4xl font-bold mb-2">🎯 Perfect Hedge Bot</h1>
                    <p class="text-white/80 text-sm">Atomic Position Opening | Both Sides MUST Open Together</p>
                </div>
                <div class="text-right">
                    <div class="text-3xl font-bold number-font" id="livePrice">$0.00000000</div>
                    <div class="text-sm text-white/70">${config.symbol}</div>
                </div>
            </div>
            <div class="grid grid-cols-6 gap-4 mt-6 pt-4 border-t border-white/20">
                <div><div class="text-xs text-white/70">Leverage</div><div class="text-xl font-bold">${config.leverage}X</div></div>
                <div><div class="text-xs text-white/70">Order Size</div><div class="text-xl font-bold">${config.orderSize}</div></div>
                <div><div class="text-xs text-white/70">Take Profit</div><div class="text-xl font-bold text-green-300">${config.takeProfitPercent}%</div></div>
                <div><div class="text-xs text-white/70">Stop Loss</div><div class="text-xl font-bold text-red-300">${config.stopLossPercent}%</div></div>
                <div><div class="text-xs text-white/70">Hedge Threshold</div><div class="text-xl font-bold text-yellow-300">${config.hedgeThreshold}%</div></div>
                <div><div class="text-xs text-white/70">Resets</div><div class="text-xl font-bold" id="resetCount">0</div></div>
            </div>
        </div>

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

        <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold">🎯 Hedge Status Monitor</h3>
                <div class="text-xs bg-green-100 text-green-600 px-2 py-1 rounded-full">Atomic Opening ACTIVE</div>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-4">
                <div class="text-center">
                    <div class="text-sm text-gray-500 mb-2">📈 LONG ROI</div>
                    <div class="text-3xl font-bold" id="longRoi">0.00%</div>
                </div>
                <div class="text-center">
                    <div class="text-sm text-gray-500 mb-2">🎯 Hedge Deviation</div>
                    <div class="text-3xl font-bold" id="hedgeDeviation">0.00%</div>
                    <div class="text-xs text-gray-400">Target: 0% | Reset if > ${config.hedgeThreshold}%</div>
                </div>
                <div class="text-center">
                    <div class="text-sm text-gray-500 mb-2">📉 SHORT ROI</div>
                    <div class="text-3xl font-bold" id="shortRoi">0.00%</div>
                </div>
            </div>
            <div class="mt-4 h-4 bg-gray-200 rounded-full overflow-hidden">
                <div id="hedgeBar" class="h-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 transition-all duration-500" style="width: 50%"></div>
            </div>
            <div class="mt-4 p-3 bg-gray-50 rounded-lg">
                <div class="flex justify-between text-sm">
                    <span class="text-gray-600">Last Reset Reason:</span>
                    <span class="font-mono font-bold" id="lastResetReason">None</span>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8" id="accountsContainer"></div>
        
        <div class="bg-white rounded-xl shadow-lg p-6 mb-8">
            <h3 class="text-lg font-bold mb-4">Profit Timeline</h3>
            <canvas id="profitChart" height="100"></canvas>
        </div>

        <div class="bg-white rounded-xl shadow-lg p-4 text-center">
            <div class="flex items-center justify-center gap-2">
                <div class="w-2 h-2 bg-green-500 rounded-full pulse"></div>
                <span class="text-sm text-gray-600">Atomic Hedge Mode | Both positions open/close together | Last update: <span id="lastUpdate">Just now</span></span>
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
                document.getElementById('resetCount').innerText = data.totalResets || 0;
                document.getElementById('lastResetReason').innerText = data.lastResetReason || 'None';
                
                const winLossRatio = data.winningTrades / Math.max(data.losingTrades, 1);
                document.getElementById('wlRatio').innerText = winLossRatio.toFixed(2);
                document.getElementById('dgr').innerText = data.estimates.dgr.toFixed(2) + '%';
                
                document.getElementById('longRoi').innerText = data.longRoi.toFixed(2) + '%';
                document.getElementById('shortRoi').innerText = data.shortRoi.toFixed(2) + '%';
                document.getElementById('longRoi').style.color = data.longRoi >= 0 ? '#10b981' : '#ef4444';
                document.getElementById('shortRoi').style.color = data.shortRoi >= 0 ? '#10b981' : '#ef4444';
                
                const hedgeDev = Math.abs(data.hedgeDeviation);
                document.getElementById('hedgeDeviation').innerText = hedgeDev.toFixed(2) + '%';
                const hedgeElem = document.getElementById('hedgeDeviation');
                if (hedgeDev < 0.2) hedgeElem.style.color = '#10b981';
                else if (hedgeDev < 1) hedgeElem.style.color = '#f59e0b';
                else hedgeElem.style.color = '#ef4444';
                
                const hedgeBarPosition = 50 + (data.longRoi - data.shortRoi) * 5;
                document.getElementById('hedgeBar').style.width = Math.min(100, Math.max(0, hedgeBarPosition)) + '%';
                
                if (data.accounts && data.accounts.length > 0) {
                    const container = document.getElementById('accountsContainer');
                    container.innerHTML = '';
                    data.accounts.forEach((acc, idx) => {
                        const isLong = idx === 0;
                        const bgGradient = isLong ? 'from-emerald-50 to-emerald-100/30' : 'from-red-50 to-red-100/30';
                        const icon = isLong ? '📈' : '📉';
                        const title = isLong ? 'LONG POSITION' : 'SHORT POSITION';
                        const card = document.createElement('div');
                        card.className = \`bg-gradient-to-br \${bgGradient} rounded-xl shadow-lg p-6\`;
                        card.innerHTML = \`
                            <div class="flex justify-between items-start mb-4">
                                <div><div class="text-3xl mb-2">\${icon}</div><h3 class="text-xl font-bold">Account \${acc.id}</h3><div class="text-sm text-gray-600">\${title}</div></div>
                                <div class="text-right"><div class="text-xs text-gray-500">Balance</div><div class="text-2xl font-bold">$\${acc.balance.toFixed(2)}</div></div>
                            </div>
                            <div class="grid grid-cols-2 gap-4 mb-4">
                                <div><div class="text-xs text-gray-500">Position Size</div><div class="text-lg font-bold">\${acc.position}</div></div>
                                <div><div class="text-xs text-gray-500">Current ROI</div><div class="text-lg font-bold" style="color: \${acc.roi >= 0 ? '#059669' : '#dc2626'}">\${acc.roi.toFixed(2)}%</div></div>
                                <div><div class="text-xs text-gray-500">Avg Entry</div><div class="text-sm">$\${(acc.avgPrice || 0).toFixed(8)}</div></div>
                                <div><div class="text-xs text-gray-500">Trades</div><div class="text-sm">\${acc.trades}</div></div>
                            </div>
                            <div class="border-t pt-3"><div class="flex justify-between text-sm"><span class="text-gray-600">Realized P&L</span><span class="font-bold" style="color: \${acc.profit >= 0 ? '#059669' : '#dc2626'}">$\${acc.profit.toFixed(2)}</span></div></div>
                        \`;
                        container.appendChild(card);
                    });
                }
                
                profitHistory.push(data.realizedProfit);
                if (profitHistory.length > 50) profitHistory.shift();
                if (profitChart) { profitChart.data.datasets[0].data = profitHistory; profitChart.update(); }
                document.getElementById('lastUpdate').innerText = new Date().toLocaleTimeString();
            } catch (error) { console.error('Error:', error); }
        }
        
        function initChart() {
            const ctx = document.getElementById('profitChart').getContext('2d');
            profitChart = new Chart(ctx, { type: 'line', data: { labels: Array(50).fill(''), datasets: [{ label: 'Total Profit ($)', data: Array(50).fill(0), borderColor: 'rgb(16, 185, 129)', backgroundColor: 'rgba(16, 185, 129, 0.1)', tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: false }, x: { display: false } } } });
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
        avgPrice: state.avgPrice
    }));
    res.json({ ...botState, accounts: accountsData });
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
                Object.values(accountStates).forEach(state => { state.currentPrice = botState.currentPrice; });
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
    console.log('PERFECT HEDGE TRADING BOT - ATOMIC MODE');
    console.log('========================================');
    console.log(`Symbol: ${config.symbol}`);
    console.log(`Leverage: ${config.leverage}X`);
    console.log(`Hedge Threshold: ${config.hedgeThreshold}%`);
    console.log(`Strategy: Both positions MUST open together`);
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
