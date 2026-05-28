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
let totalResets = 0;
let isOpeningPositions = false;

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

let botState = {
    isRunning: true,
    startTime: Date.now(),
    currentPrice: 0,
    realizedProfit: 0,
    profitPct: 0,
    displayBalance: 0,
    initialBalance: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    longRoi: 0,
    shortRoi: 0,
    hedgeDeviation: 0,
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
        return { status: 'error', 'err-msg': e.message }; 
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
            }
            state.walletBalance = realBalance;
            state.realizedProfit = state.displayBalance - state.initialBalance;
        }

        const posRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);

        if (pos) {
            state.avgPrice = parseFloat(pos.cost_hold);
            state.roi = parseFloat(pos.profit_rate) * 100;
            state.position = { volume: parseFloat(pos.volume), costHold: state.avgPrice };
        } else {
            state.position = { volume: 0, costHold: 0 };
            state.roi = 0;
            state.avgPrice = 0;
        }
        updateCombinedState();
    } catch (e) { console.error(`Sync error:`, e.message); }
}

function updateCombinedState() {
    let totalRealizedProfit = 0, totalDisplayBalance = 0, totalInitialBalance = 0;
    let totalTrades = 0, totalWins = 0, totalLosses = 0;
    let longRoi = 0, shortRoi = 0;
    
    Object.values(accountStates).forEach(state => {
        totalRealizedProfit += state.realizedProfit;
        totalDisplayBalance += state.displayBalance;
        totalInitialBalance += state.initialBalance;
        totalTrades += state.totalTrades;
        totalWins += state.winningTrades;
        totalLosses += state.losingTrades;
        if (state.direction === 'buy') longRoi = state.roi;
        if (state.direction === 'sell') shortRoi = state.roi;
    });
    
    botState.realizedProfit = totalRealizedProfit;
    botState.displayBalance = totalDisplayBalance;
    botState.initialBalance = totalInitialBalance;
    botState.totalTrades = totalTrades;
    botState.winningTrades = totalWins;
    botState.losingTrades = totalLosses;
    botState.profitPct = totalInitialBalance > 0 ? (totalRealizedProfit / totalInitialBalance) * 100 : 0;
    botState.longRoi = longRoi;
    botState.shortRoi = shortRoi;
    botState.hedgeDeviation = Math.abs(longRoi + shortRoi);
    botState.totalResets = totalResets;
    
    const elapsed = (Date.now() - botState.startTime) / 3600000;
    const hr = botState.realizedProfit / Math.max(elapsed, 0.01);
    botState.estimates = { hr, day: hr * 24, dgr: (hr * 24 / Math.max(botState.initialBalance, 0.01)) * 100 };
}

// ==================== SIMULTANEOUS TRADING LOGIC ====================

async function openBothPositionsTogether() {
    if (config.accounts.length < 2 || isOpeningPositions) return;
    
    const longAcc = config.accounts[0], shortAcc = config.accounts[1];
    const longState = accountStates[longAcc.accountId], shortState = accountStates[shortAcc.accountId];
    
    if (longState.position.volume === 0 && shortState.position.volume === 0) {
        isOpeningPositions = true;
        console.log(`\n🚀 DISPATCHING SIMULTANEOUS ORDERS [${config.symbol}]`);

        // Fire both orders at the same time using Promise.all
        const results = await Promise.all([
            htxRequest(longAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: longState.settings.orderSize,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            }),
            htxRequest(shortAcc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: shortState.settings.orderSize,
                direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            })
        ]);

        if (results[0].status === 'ok' && results[1].status === 'ok') {
            console.log(`   ✅ BOTH orders successfully dispatched`);
            longState.totalTrades++; shortState.totalTrades++;
        } else {
            console.log(`   ⚠️ Partial fill or error. Safety cleanup will handle imbalances.`);
        }
        
        await new Promise(r => setTimeout(r, 1500));
        isOpeningPositions = false;
    }
}

async function forceResetIfOnlyOneOpen() {
    const longState = accountStates[config.accounts[0].accountId];
    const shortState = accountStates[config.accounts[1].accountId];
    
    if ((longState.position.volume > 0) !== (shortState.position.volume > 0)) {
        console.log(`\n⚠️ IMBALANCE DETECTED - Reseting...`);
        botState.lastResetReason = "Single side detected";
        
        await Promise.all([
            longState.position.volume > 0 ? htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: longState.position.volume, direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            }) : Promise.resolve(),
            shortState.position.volume > 0 ? htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: shortState.position.volume, direction: 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            }) : Promise.resolve()
        ]);
        totalResets++;
    }
}

async function checkHedgePerfect() {
    const longState = accountStates[config.accounts[0].accountId];
    const shortState = accountStates[config.accounts[1].accountId];
    
    if (longState.position.volume > 0 && shortState.position.volume > 0) {
        const deviation = Math.abs(longState.roi + shortState.roi);
        
        if (deviation > config.hedgeThreshold) {
            console.log(`\n🔄 HEDGE DEVIATION TOO HIGH: ${deviation.toFixed(2)}% - Closing both.`);
            botState.lastResetReason = `Hedge Drift: ${deviation.toFixed(2)}%`;
            
            await Promise.all([
                htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: longState.position.volume, direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                }),
                htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: shortState.position.volume, direction: 'buy', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                })
            ]);
            totalResets++;
        }
    }
}

async function checkTrades() {
    await forceResetIfOnlyOneOpen();
    await openBothPositionsTogether();
    await checkHedgePerfect();

    // Check Take Profit / Stop Loss
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.position.volume > 0) {
            if (state.roi >= state.settings.takeProfit || state.roi <= -state.settings.stopLoss) {
                const dir = state.direction === 'buy' ? 'sell' : 'buy';
                const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: state.position.volume, direction: dir, offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
                });
                if (res.status === 'ok') {
                    if (state.roi > 0) state.winningTrades++; else state.losingTrades++;
                    state.totalTrades++;
                    console.log(`🎯 TP/SL Triggered for ${state.direction.toUpperCase()}: ${state.roi.toFixed(2)}%`);
                }
            }
        }
    }
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Perfect Hedge</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-900 text-white font-sans p-8">
        <div class="max-w-6xl mx-auto">
            <div class="flex justify-between items-end mb-8 bg-slate-800 p-6 rounded-2xl border border-slate-700">
                <div><h1 class="text-3xl font-black text-indigo-400">🎯 ATOMIC HEDGE</h1><p class="text-slate-400">Simultaneous Order Execution Active</p></div>
                <div class="text-right"><div id="price" class="text-4xl font-mono font-bold">$0.0000</div><div class="text-indigo-400 font-bold">${config.symbol}</div></div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                    <div class="text-slate-400 text-sm uppercase">Total Profit</div>
                    <div id="profit" class="text-3xl font-bold text-emerald-400">$0.00</div>
                </div>
                <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                    <div class="text-slate-400 text-sm uppercase">Hedge Deviation</div>
                    <div id="dev" class="text-3xl font-bold text-amber-400">0.00%</div>
                </div>
                <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                    <div class="text-slate-400 text-sm uppercase">Safety Resets</div>
                    <div id="resets" class="text-3xl font-bold text-rose-400">0</div>
                </div>
            </div>
            <div id="accounts" class="grid grid-cols-1 md:grid-cols-2 gap-6"></div>
        </div>
        <script>
            async function update() {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('price').innerText = '$' + d.currentPrice.toFixed(8);
                document.getElementById('profit').innerText = '$' + d.realizedProfit.toFixed(4);
                document.getElementById('dev').innerText = d.hedgeDeviation.toFixed(2) + '%';
                document.getElementById('resets').innerText = d.totalResets;
                
                let html = '';
                d.accounts.forEach(a => {
                    const isLong = a.direction === 'buy';
                    html += \`<div class="bg-slate-800 p-6 rounded-xl border-l-4 \${isLong ? 'border-emerald-500' : 'border-rose-500'}">
                        <div class="flex justify-between mb-4">
                            <span class="font-bold text-xl">\${isLong ? 'LONG' : 'SHORT'} Side</span>
                            <span class="font-mono \${a.roi >= 0 ? 'text-emerald-400' : 'text-rose-400'}">\${a.roi.toFixed(2)}%</span>
                        </div>
                        <div class="text-sm text-slate-400">Position: \${a.position} contracts</div>
                        <div class="text-sm text-slate-400">Entry: \$\${(a.avgPrice || 0).toFixed(8)}</div>
                    </div>\`;
                });
                document.getElementById('accounts').innerHTML = html;
            }
            setInterval(update, 1000);
        </script>
    </body></html>`);
});

app.get('/api/status', (req, res) => {
    const accountsData = Object.entries(accountStates).map(([id, state]) => ({
        id: parseInt(id), position: state.position.volume, roi: state.roi, direction: state.direction, avgPrice: state.avgPrice
    }));
    res.json({ ...botState, accounts: accountsData });
});

// ==================== WEBSOCKET & INIT ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.detail`, id: 'p1' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) {
                botState.currentPrice = parseFloat(msg.tick.close);
                Object.values(accountStates).forEach(s => { s.currentPrice = botState.currentPrice; });
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

async function initialize() {
    console.log(`🚀 Perfect Hedge Starting for ${config.symbol}...`);
    for (const acc of config.accounts) await syncAccountData(acc, accountStates[acc.accountId]);
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Web UI: http://localhost:${config.port}`);
        startWS();
        setInterval(async () => {
            for (const acc of config.accounts) await syncAccountData(acc, accountStates[acc.accountId]);
        }, 2000);
        setInterval(checkTrades, 3000);
    });
}

initialize();
