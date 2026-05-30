// FILE: arbitrage-bot.js - FIXED DISPLAY VERSION

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    positionSizeUSDT: 200,  // Increased to make trades more visible
    minSpreadPercent: 0.10,
    maxOpenPositions: 3,
    closeSpreadPercent: 0.05,
    maxLossPercent: 2.0,
    port: process.env.PORT || 3000,
};

// ==================== PAPER TRADING STATE ====================
const paperState = {
    balances: { 
        htx: { USDT: 10000, SHIB: 0 }, 
        phemex: { USDT: 10000, SHIB: 0 } 
    },
    openPositions: [],
    prices: { 
        htx: { bid: 0, ask: 0, last: 0 }, 
        phemex: { bid: 0, ask: 0, last: 0 } 
    },
    stats: { 
        totalTrades: 0, winningTrades: 0, losingTrades: 0, 
        totalProfit: 0, maxDrawdown: 0, startTime: Date.now() 
    },
    status: 'Initializing...',
    lastLog: 0
};

// ==================== PRICE FETCHING ====================

async function fetchPrices() {
    try {
        // Fetch HTX price
        const htxRes = await axios.get('https://api.huobi.pro/market/ticker', {
            params: { symbol: 'shibusdt' },
            timeout: 5000
        });
        
        if (htxRes.data && htxRes.data.tick) {
            paperState.prices.htx = {
                bid: parseFloat(htxRes.data.tick.bid),
                ask: parseFloat(htxRes.data.tick.ask),
                last: parseFloat(htxRes.data.tick.close)
            };
        }
        
        // Fetch Phemex price
        const phemexRes = await axios.get('https://api.phemex.com/public/ticker/spot/SHIBUSDT', {
            timeout: 5000
        });
        
        if (phemexRes.data && phemexRes.data.result) {
            paperState.prices.phemex = {
                bid: parseFloat(phemexRes.data.result.bidEp),
                ask: parseFloat(phemexRes.data.result.askEp),
                last: parseFloat(phemexRes.data.result.lastEp)
            };
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

// ==================== TRADE EXECUTION ====================

function calculateQuantity(price) {
    if (!price || price <= 0) return 0;
    const rawQuantity = config.positionSizeUSDT / price;
    return Math.max(Math.floor(rawQuantity / 1000) * 1000, 1000);
}

async function executeTrade(exchange, side, price, quantity) {
    const value = price * quantity;
    
    if (exchange === 'htx') {
        if (side === 'buy') {
            if (paperState.balances.htx.USDT < value) return false;
            paperState.balances.htx.USDT -= value;
            paperState.balances.htx.SHIB += quantity;
        } else {
            if (paperState.balances.htx.SHIB < quantity) return false;
            paperState.balances.htx.USDT += value;
            paperState.balances.htx.SHIB -= quantity;
        }
    } else {
        if (side === 'buy') {
            if (paperState.balances.phemex.USDT < value) return false;
            paperState.balances.phemex.USDT -= value;
            paperState.balances.phemex.SHIB += quantity;
        } else {
            if (paperState.balances.phemex.SHIB < quantity) return false;
            paperState.balances.phemex.USDT += value;
            paperState.balances.phemex.SHIB -= quantity;
        }
    }
    
    console.log(`📝 ${exchange.toUpperCase()} ${side.toUpperCase()} ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)} = $${value.toFixed(2)}`);
    return true;
}

// MAIN ARBITRAGE LOGIC
async function checkAndExecuteArbitrage() {
    const htxBid = paperState.prices.htx.bid;
    const htxAsk = paperState.prices.htx.ask;
    const phemexBid = paperState.prices.phemex.bid;
    const phemexAsk = paperState.prices.phemex.ask;
    
    if (!htxBid || !htxAsk || !phemexBid || !phemexAsk) return;
    if (htxBid <= 0 || htxAsk <= 0 || phemexBid <= 0 || phemexAsk <= 0) return;
    
    // Calculate spreads
    const buyHTXSellPhemex = ((phemexBid - htxAsk) / htxAsk) * 100;
    const buyPhemexSellHTX = ((htxBid - phemexAsk) / phemexAsk) * 100;
    
    // Log every 10 seconds
    if (Date.now() - paperState.lastLog > 10000) {
        console.log(`\n📊 Spreads: HTX→Phemex: ${buyHTXSellPhemex.toFixed(4)}% | Phemex→HTX: ${buyPhemexSellHTX.toFixed(4)}%`);
        console.log(`   HTX: Bid $${htxBid.toFixed(8)} Ask $${htxAsk.toFixed(8)}`);
        console.log(`   Phemex: Bid $${phemexBid.toFixed(8)} Ask $${phemexAsk.toFixed(8)}`);
        console.log(`   Open positions: ${paperState.openPositions.length}`);
        paperState.lastLog = Date.now();
    }
    
    // Check for opportunity
    let buyExchange = null;
    let sellExchange = null;
    let buyPrice = 0;
    let sellPrice = 0;
    let expectedProfit = 0;
    
    if (buyHTXSellPhemex > buyPhemexSellHTX && buyHTXSellPhemex >= config.minSpreadPercent) {
        buyExchange = 'htx';
        sellExchange = 'phemex';
        buyPrice = htxAsk;
        sellPrice = phemexBid;
        expectedProfit = buyHTXSellPhemex;
    } 
    else if (buyPhemexSellHTX >= config.minSpreadPercent) {
        buyExchange = 'phemex';
        sellExchange = 'htx';
        buyPrice = phemexAsk;
        sellPrice = htxBid;
        expectedProfit = buyPhemexSellHTX;
    }
    
    // Execute trade if opportunity found
    if (buyExchange && paperState.openPositions.length < config.maxOpenPositions) {
        const quantity = calculateQuantity(buyPrice);
        if (quantity <= 0) return;
        
        console.log(`\n🎯 ARBITRAGE OPPORTUNITY! Expected profit: ${expectedProfit.toFixed(4)}%`);
        console.log(`   Buy ${quantity.toLocaleString()} SHIB on ${buyExchange.toUpperCase()} @ $${buyPrice.toFixed(8)}`);
        console.log(`   Sell on ${sellExchange.toUpperCase()} @ $${sellPrice.toFixed(8)}`);
        
        const buySuccess = await executeTrade(buyExchange, 'buy', buyPrice, quantity);
        const sellSuccess = await executeTrade(sellExchange, 'sell', sellPrice, quantity);
        
        if (buySuccess && sellSuccess) {
            const position = {
                id: `pos_${Date.now()}`,
                openTime: Date.now(),
                openTimeStr: new Date().toLocaleTimeString(),
                buyExchange, sellExchange,
                buyPrice, sellPrice,
                quantity,
                expectedProfit: expectedProfit
            };
            
            paperState.openPositions.push(position);
            paperState.stats.totalTrades++;
            paperState.status = `✅ Trade executed! Expected profit: ${expectedProfit.toFixed(4)}%`;
            
            console.log(`✅ POSITION OPENED! ID: ${position.id}`);
            console.log(`   Open positions: ${paperState.openPositions.length}`);
            console.log(`   Balances - HTX: $${paperState.balances.htx.USDT.toFixed(2)} | Phemex: $${paperState.balances.phemex.USDT.toFixed(2)}\n`);
        }
    }
}

// Check and close positions
async function checkClosePositions() {
    for (let i = 0; i < paperState.openPositions.length; i++) {
        const pos = paperState.openPositions[i];
        
        const htxBid = paperState.prices.htx.bid;
        const phemexBid = paperState.prices.phemex.bid;
        
        let currentProfit = 0;
        
        if (pos.buyExchange === 'htx' && pos.sellExchange === 'phemex') {
            currentProfit = ((phemexBid - pos.buyPrice) / pos.buyPrice) * 100;
        } else {
            currentProfit = ((htxBid - pos.buyPrice) / pos.buyPrice) * 100;
        }
        
        let shouldClose = false;
        let reason = '';
        
        if (currentProfit >= config.closeSpreadPercent) {
            shouldClose = true;
            reason = `Target profit ${currentProfit.toFixed(2)}%`;
        } else if (currentProfit <= -config.maxLossPercent) {
            shouldClose = true;
            reason = `Stop loss ${currentProfit.toFixed(2)}%`;
        } else if (Date.now() - pos.openTime > 30 * 60 * 1000) {
            shouldClose = true;
            reason = `Max hold time (30 min)`;
        }
        
        if (shouldClose) {
            console.log(`\n💰 CLOSING POSITION: ${pos.id} - ${reason}`);
            console.log(`   Current profit: ${currentProfit.toFixed(2)}%`);
            
            const closeBuyPrice = pos.buyExchange === 'htx' ? paperState.prices.htx.ask : paperState.prices.phemex.ask;
            const closeSellPrice = pos.sellExchange === 'htx' ? paperState.prices.htx.bid : paperState.prices.phemex.bid;
            
            const closeSuccess = await executeTrade(pos.sellExchange, 'buy', closeSellPrice, pos.quantity);
            const closeSuccess2 = await executeTrade(pos.buyExchange, 'sell', closeBuyPrice, pos.quantity);
            
            if (closeSuccess && closeSuccess2) {
                const actualProfit = (closeSellPrice - closeBuyPrice) * pos.quantity;
                
                if (actualProfit > 0) paperState.stats.winningTrades++;
                else paperState.stats.losingTrades++;
                paperState.stats.totalProfit += actualProfit;
                
                console.log(`   Actual profit: $${actualProfit.toFixed(4)}`);
                console.log(`   Total profit: $${paperState.stats.totalProfit.toFixed(4)}\n`);
                
                paperState.openPositions.splice(i, 1);
                i--;
                paperState.status = `Closed - ${reason} | Profit: $${actualProfit.toFixed(4)}`;
            }
        }
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const htxBid = paperState.prices.htx.bid;
    const htxAsk = paperState.prices.htx.ask;
    const phemexBid = paperState.prices.phemex.bid;
    const phemexAsk = paperState.prices.phemex.ask;
    
    let spread1 = 0, spread2 = 0;
    if (htxAsk > 0 && phemexBid > 0) spread1 = ((phemexBid - htxAsk) / htxAsk) * 100;
    if (phemexAsk > 0 && htxBid > 0) spread2 = ((htxBid - phemexAsk) / phemexAsk) * 100;
    
    const bestSpread = Math.max(spread1, spread2);
    const bestDirection = spread1 > spread2 ? 'BUY_HTX_SELL_PHEMEX' : 'BUY_PHEMEX_SELL_HTX';
    
    const winRate = paperState.stats.totalTrades > 0 ? (paperState.stats.winningTrades / paperState.stats.totalTrades) * 100 : 0;
    
    // Calculate total equity
    const totalEquity = paperState.balances.htx.USDT + (paperState.balances.htx.SHIB * paperState.prices.htx.last) +
                        paperState.balances.phemex.USDT + (paperState.balances.phemex.SHIB * paperState.prices.phemex.last);
    
    res.json({
        status: paperState.status,
        prices: {
            htx: paperState.prices.htx,
            phemex: paperState.prices.phemex,
            spreadPercent: bestSpread.toFixed(4),
            spreadDirection: bestDirection
        },
        positions: { 
            open: paperState.openPositions.length, 
            maxAllowed: config.maxOpenPositions,
            details: paperState.openPositions.map(p => ({
                id: p.id,
                openTime: p.openTimeStr,
                buyExchange: p.buyExchange,
                sellExchange: p.sellExchange,
                buyPrice: p.buyPrice.toFixed(8),
                sellPrice: p.sellPrice.toFixed(8),
                quantity: p.quantity,
                expectedProfit: p.expectedProfit.toFixed(4)
            }))
        },
        balances: {
            htx: { USDT: paperState.balances.htx.USDT.toFixed(2), SHIB: paperState.balances.htx.SHIB },
            phemex: { USDT: paperState.balances.phemex.USDT.toFixed(2), SHIB: paperState.balances.phemex.SHIB },
            totalEquity: totalEquity.toFixed(2)
        },
        stats: {
            totalTrades: paperState.stats.totalTrades,
            winningTrades: paperState.stats.winningTrades,
            losingTrades: paperState.stats.losingTrades,
            winRate: winRate.toFixed(2),
            totalProfit: paperState.stats.totalProfit.toFixed(4),
            runningTime: Math.floor((Date.now() - paperState.stats.startTime) / 1000 / 60)
        },
        config: {
            minSpreadPercent: config.minSpreadPercent,
            positionSizeUSDT: config.positionSizeUSDT,
            maxOpenPositions: config.maxOpenPositions,
        }
    });
});

app.post('/api/scan', async (req, res) => {
    await fetchPrices();
    await checkAndExecuteArbitrage();
    res.json({ scanned: true });
});

app.post('/api/reset', (req, res) => {
    paperState.balances = { htx: { USDT: 10000, SHIB: 0 }, phemex: { USDT: 10000, SHIB: 0 } };
    paperState.openPositions = [];
    paperState.stats = { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalProfit: 0, maxDrawdown: 0, startTime: Date.now() };
    paperState.status = 'Reset complete';
    console.log('🔄 Trading reset');
    res.json({ reset: true });
});

app.post('/api/config', (req, res) => {
    if (req.body.minSpreadPercent) config.minSpreadPercent = req.body.minSpreadPercent;
    if (req.body.positionSizeUSDT) config.positionSizeUSDT = req.body.positionSizeUSDT;
    console.log(`⚙️ Config updated: Min Spread ${config.minSpreadPercent}% | Position $${config.positionSizeUSDT}`);
    res.json({ config });
});

// ==================== WEB DASHBOARD ====================

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Arbitrage Bot - HTX vs Phemex</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0a0a0f; color: #e5e5e5; font-family: monospace; }
        .glass { background: rgba(15, 25, 35, 0.7); backdrop-filter: blur(10px); border-radius: 16px; border: 1px solid rgba(0,255,255,0.2); padding: 20px; }
        .profit { color: #00ff88; }
        .loss { color: #ff4466; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .live { display: inline-block; width: 8px; height: 8px; background: #00ff88; border-radius: 50%; animation: pulse 1.5s infinite; margin-right: 6px; }
        .opportunity { background: rgba(0,255,136,0.15); border: 1px solid rgba(0,255,136,0.4); }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold text-cyan-400">⚡ Arbitrage Bot</h1>
                <p class="text-gray-500">HTX ↔ PHEMEX | SHIB/USDT | PAPER TRADING</p>
            </div>
            <div class="flex gap-3">
                <button onclick="scanNow()" class="px-4 py-2 bg-cyan-500 rounded-lg hover:bg-cyan-600">🔍 Manual Scan</button>
                <button onclick="resetTrading()" class="px-4 py-2 bg-red-500 rounded-lg hover:bg-red-600">🔄 Reset</button>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-6 mb-8">
            <div class="glass">
                <p class="text-gray-400 text-sm">Total Profit</p>
                <p id="totalProfit" class="text-3xl font-bold profit">$0.00</p>
                <p class="text-xs text-gray-500">Win Rate: <span id="winRate">0</span>% | Trades: <span id="totalTrades">0</span></p>
            </div>
            <div class="glass">
                <p class="text-gray-400 text-sm">Open Positions</p>
                <p id="openPositions" class="text-3xl font-bold text-cyan-400">0</p>
                <p class="text-xs text-gray-500">Max: <span id="maxPositions">3</span></p>
            </div>
            <div class="glass">
                <p class="text-gray-400 text-sm">Session</p>
                <p><span id="wins" class="profit">0</span> Wins | <span id="losses" class="loss">0</span> Losses</p>
                <p class="text-xs text-gray-500">Running: <span id="runningTime">0</span> min</p>
            </div>
        </div>

        <div class="glass mb-8">
            <h2 class="text-lg font-semibold mb-4"><span class="live"></span>Live Market Data</h2>
            <div class="grid grid-cols-3 gap-6">
                <div class="text-center">
                    <p class="font-bold text-orange-400 text-xl">HTX</p>
                    <p class="text-2xl font-bold" id="htxPrice">$0.00000000</p>
                    <p class="text-xs text-gray-500 mt-2">Bid: <span id="htxBid" class="text-green-400">0</span> | Ask: <span id="htxAsk" class="text-red-400">0</span></p>
                </div>
                <div class="text-center p-4 rounded-lg" id="spreadBox">
                    <p class="text-4xl" id="spreadArrow">↔️</p>
                    <p class="text-2xl font-bold mt-2" id="spreadValue">0.00%</p>
                    <p class="text-xs text-gray-500" id="spreadStatus">Checking...</p>
                </div>
                <div class="text-center">
                    <p class="font-bold text-blue-400 text-xl">PHEMEX</p>
                    <p class="text-2xl font-bold" id="phemexPrice">$0.00000000</p>
                    <p class="text-xs text-gray-500 mt-2">Bid: <span id="phemexBid" class="text-green-400">0</span> | Ask: <span id="phemexAsk" class="text-red-400">0</span></p>
                </div>
            </div>
        </div>

        <div class="glass mb-8">
            <h2 class="text-lg font-semibold mb-4">📊 Open Positions (<span id="posCount">0</span>)</h2>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="border-b border-gray-700">
                        <tr class="text-left">
                            <th class="pb-2">Time</th><th class="pb-2">Buy</th><th class="pb-2">Sell</th>
                            <th class="pb-2">Buy Price</th><th class="pb-2">Sell Price</th><th class="pb-2">Expected %</th><th class="pb-2">Qty</th>
                        </tr>
                    </thead>
                    <tbody id="positionsTable">
                        <tr><td colspan="7" class="text-center py-4 text-gray-500">No open positions</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-6">
            <div class="glass">
                <h2 class="text-lg font-semibold mb-4">💰 Balances</h2>
                <div class="space-y-2">
                    <div class="flex justify-between p-3 bg-black/30 rounded">
                        <span class="text-orange-400 font-bold">HTX</span>
                        <span id="htxUSDT">$10000.00</span>
                        <span id="htxSHIB" class="text-xs">0 SHIB</span>
                    </div>
                    <div class="flex justify-between p-3 bg-black/30 rounded">
                        <span class="text-blue-400 font-bold">PHEMEX</span>
                        <span id="phemexUSDT">$10000.00</span>
                        <span id="phemexSHIB" class="text-xs">0 SHIB</span>
                    </div>
                    <div class="flex justify-between p-3 bg-cyan-500/20 rounded">
                        <span class="font-bold">Total Equity</span>
                        <span id="totalEquity" class="font-bold">$20000.00</span>
                    </div>
                </div>
            </div>
            <div class="glass">
                <h2 class="text-lg font-semibold mb-4">⚙️ Configuration</h2>
                <div class="space-y-2">
                    <div>
                        <label class="text-xs text-gray-400">Min Spread % (Current: <span id="currentMinSpread">0.10</span>%)</label>
                        <input type="number" id="minSpread" step="0.01" class="w-full bg-black/50 border border-gray-700 rounded p-2 mt-1" value="0.10">
                    </div>
                    <div>
                        <label class="text-xs text-gray-400">Position Size (USDT)</label>
                        <input type="number" id="positionSize" step="50" class="w-full bg-black/50 border border-gray-700 rounded p-2 mt-1" value="200">
                    </div>
                    <button onclick="updateConfig()" class="w-full bg-cyan-600 hover:bg-cyan-700 py-2 rounded font-bold mt-2">Update Config</button>
                </div>
            </div>
        </div>
        
        <div class="mt-8 text-center">
            <p id="statusMsg" class="text-cyan-400">Initializing...</p>
            <p class="text-xs text-gray-500 mt-2">⚠️ PAPER TRADING - Bot auto-trades when spread > min requirement</p>
        </div>
    </div>

    <script>
        setInterval(fetchStatus, 1000);
        
        async function fetchStatus() {
            try {
                const r = await fetch('/api/status');
                const d = await r.json();
                
                document.getElementById('htxPrice').innerText = '$' + (d.prices.htx.last || 0).toFixed(8);
                document.getElementById('htxBid').innerText = (d.prices.htx.bid || 0).toFixed(8);
                document.getElementById('htxAsk').innerText = (d.prices.htx.ask || 0).toFixed(8);
                document.getElementById('phemexPrice').innerText = '$' + (d.prices.phemex.last || 0).toFixed(8);
                document.getElementById('phemexBid').innerText = (d.prices.phemex.bid || 0).toFixed(8);
                document.getElementById('phemexAsk').innerText = (d.prices.phemex.ask || 0).toFixed(8);
                
                const spread = parseFloat(d.prices.spreadPercent);
                const minRequired = d.config.minSpreadPercent;
                const spreadBox = document.getElementById('spreadBox');
                const spreadValue = document.getElementById('spreadValue');
                const spreadArrow = document.getElementById('spreadArrow');
                const spreadStatus = document.getElementById('spreadStatus');
                
                spreadValue.innerText = spread.toFixed(4) + '%';
                
                if (spread >= minRequired) {
                    spreadBox.className = 'text-center p-4 rounded-lg opportunity';
                    spreadArrow.innerHTML = '📈 ACTIVE';
                    spreadStatus.innerHTML = '✅ OPPORTUNITY! Bot will trade';
                    spreadValue.className = 'text-2xl font-bold mt-2 profit';
                } else {
                    spreadBox.className = 'text-center p-4 rounded-lg';
                    spreadArrow.innerHTML = '↔️';
                    spreadStatus.innerHTML = `Waiting for spread > ${minRequired}% (Current: ${spread.toFixed(4)}%)`;
                    spreadValue.className = 'text-2xl font-bold mt-2 text-gray-400';
                }
                
                const totalProfit = parseFloat(d.stats.totalProfit);
                document.getElementById('totalProfit').innerHTML = (totalProfit >= 0 ? '+' : '') + '$' + Math.abs(totalProfit).toFixed(4);
                document.getElementById('totalProfit').className = 'text-3xl font-bold ' + (totalProfit >= 0 ? 'profit' : 'loss');
                document.getElementById('winRate').innerText = d.stats.winRate;
                document.getElementById('totalTrades').innerText = d.stats.totalTrades;
                document.getElementById('openPositions').innerText = d.positions.open;
                document.getElementById('posCount').innerText = d.positions.open;
                document.getElementById('wins').innerText = d.stats.winningTrades;
                document.getElementById('losses').innerText = d.stats.losingTrades;
                document.getElementById('runningTime').innerText = d.stats.runningTime;
                document.getElementById('maxPositions').innerText = d.positions.maxAllowed;
                document.getElementById('currentMinSpread').innerText = d.config.minSpreadPercent;
                
                document.getElementById('htxUSDT').innerHTML = '$' + d.balances.htx.USDT;
                document.getElementById('htxSHIB').innerHTML = Math.floor(d.balances.htx.SHIB).toLocaleString() + ' SHIB';
                document.getElementById('phemexUSDT').innerHTML = '$' + d.balances.phemex.USDT;
                document.getElementById('phemexSHIB').innerHTML = Math.floor(d.balances.phemex.SHIB).toLocaleString() + ' SHIB';
                document.getElementById('totalEquity').innerHTML = '$' + d.balances.totalEquity;
                
                // FIXED: Display open positions correctly
                const tbody = document.getElementById('positionsTable');
                if (d.positions.details && d.positions.details.length > 0) {
                    tbody.innerHTML = d.positions.details.map(p => 
                        `<tr class="border-b border-gray-800">
                            <td class="py-2">${p.openTime}</td>
                            <td class="py-2 text-orange-400 font-bold">${p.buyExchange.toUpperCase()}</td>
                            <td class="py-2 text-blue-400 font-bold">${p.sellExchange.toUpperCase()}</td>
                            <td class="py-2 font-mono">$${p.buyPrice}</td>
                            <td class="py-2 font-mono">$${p.sellPrice}</td>
                            <td class="py-2 profit">+${p.expectedProfit}%</td>
                            <td class="py-2">${parseInt(p.quantity).toLocaleString()}</td>
                        </tr>`
                    ).join('');
                } else {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-500">No open positions</td></tr>';
                }
                
                document.getElementById('statusMsg').innerHTML = '🟢 ' + d.status;
                document.getElementById('minSpread').value = d.config.minSpreadPercent;
                document.getElementById('positionSize').value = d.config.positionSizeUSDT;
            } catch(e) {
                console.error(e);
            }
        }
        
        async function scanNow() {
            await fetch('/api/scan', { method: 'POST' });
            setTimeout(() => fetchStatus(), 500);
        }
        
        async function resetTrading() {
            if (confirm('Reset all paper trading data?')) {
                await fetch('/api/reset', { method: 'POST' });
                fetchStatus();
            }
        }
        
        async function updateConfig() {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    minSpreadPercent: parseFloat(document.getElementById('minSpread').value),
                    positionSizeUSDT: parseFloat(document.getElementById('positionSize').value)
                })
            });
            alert('Configuration updated!');
        }
        
        fetchStatus();
    </script>
</body>
</html>`);
});

// ==================== MAIN LOOP ====================

async function mainLoop() {
    await fetchPrices();
    await checkClosePositions();
    await checkAndExecuteArbitrage();
}

async function start() {
    console.clear();
    console.log('='.repeat(60));
    console.log('🚀 ARBITRAGE BOT - HTX vs PHEMEX');
    console.log('='.repeat(60));
    console.log(`\n📊 Config: Min Spread ${config.minSpreadPercent}% | Position $${config.positionSizeUSDT}`);
    console.log(`🤖 Auto-trading ACTIVE\n`);
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${config.port}\n`);
    });
    
    setInterval(mainLoop, 3000);
    paperState.status = 'Running - Auto-trading active';
}

start();
