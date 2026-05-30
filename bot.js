// FILE: arbitrage-bot.js
// PAPER TRADING MODE - No real funds used

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    // Trading pair
    symbol: 'SHIBUSDT',  // Format for each exchange
    symbolDisplay: 'SHIB-USDT',
    
    // Position sizing
    positionSizeUSDT: 100,  // Size per arbitrage cycle in USDT
    minSpreadPercent: 0.15,  // Minimum 0.15% spread to execute
    maxOpenPositions: 3,     // Maximum concurrent arbitrage positions
    closeSpreadPercent: 0.05, // Close when spread collapses to 0.05%
    
    // Risk management
    maxLossPercent: 2.0,      // Stop loss if trade goes against us
    
    // Timeouts
    orderTimeoutMs: 5000,
    priceStaleMs: 2000,
    
    // Server
    port: process.env.PORT || 3000,
    
    // Exchange configs
    exchanges: {
        htx: {
            name: 'HTX',
            restHost: 'api.huobi.pro',  // Using spot API for simplicity
            wsHost: 'wss://api.huobi.pro/ws',
            apiKey: process.env.HTX_API_KEY || 'PAPER_MODE',
            secretKey: process.env.HTX_SECRET_KEY || 'PAPER_MODE'
        },
        phemex: {
            name: 'PHEMEX',
            restHost: 'api.phemex.com',
            wsHost: 'wss://phemex.com/ws',
            apiKey: process.env.PHEMEX_API_KEY || 'PAPER_MODE',
            secretKey: process.env.PHEMEX_SECRET_KEY || 'PAPER_MODE'
        }
    }
};

// ==================== PAPER TRADING STATE ====================
const paperState = {
    balances: {
        htx: { USDT: 10000, SHIB: 0 },
        phemex: { USDT: 10000, SHIB: 0 }
    },
    openPositions: [],
    prices: {
        htx: { bid: 0, ask: 0, last: 0, timestamp: 0 },
        phemex: { bid: 0, ask: 0, last: 0, timestamp: 0 }
    },
    stats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: 0,
        maxDrawdown: 0,
        startTime: Date.now()
    },
    status: 'Initializing...',
    isPaperTrading: true
};

// ==================== PRICE FETCHING ====================

async function getHTXPrice() {
    try {
        const response = await axios.get(`https://${config.exchanges.htx.restHost}/market/ticker?symbol=shibusdt`, {
            timeout: config.orderTimeoutMs
        });
        
        if (response.data && response.data.tick) {
            const tick = response.data.tick;
            paperState.prices.htx = {
                bid: parseFloat(tick.bid[0]),
                ask: parseFloat(tick.ask[0]),
                last: parseFloat(tick.close),
                timestamp: Date.now()
            };
            return paperState.prices.htx;
        }
    } catch (error) {
        console.log(`[HTX] Price fetch error: ${error.message}`);
    }
    return null;
}

async function getPhemexPrice() {
    try {
        const response = await axios.get(`https://${config.exchanges.phemex.restHost}/public/products/${config.symbol}`, {
            timeout: config.orderTimeoutMs
        });
        
        if (response.data && response.data.data) {
            const data = response.data.data;
            paperState.prices.phemex = {
                bid: parseFloat(data.bidPrice),
                ask: parseFloat(data.askPrice),
                last: parseFloat(data.lastPrice),
                timestamp: Date.now()
            };
            return paperState.prices.phemex;
        }
    } catch (error) {
        try {
            const response2 = await axios.get(`https://${config.exchanges.phemex.restHost}/md/spot/ticker/24hr?symbol=${config.symbol}`, {
                timeout: config.orderTimeoutMs
            });
            if (response2.data && response2.data.result) {
                const data = response2.data.result;
                paperState.prices.phemex = {
                    bid: parseFloat(data.bidPrice),
                    ask: parseFloat(data.askPrice),
                    last: parseFloat(data.lastPrice),
                    timestamp: Date.now()
                };
                return paperState.prices.phemex;
            }
        } catch (e) {
            console.log(`[PHEMEX] Price fetch error: ${e.message}`);
        }
    }
    return null;
}

function calculateQuantity(price, usdtAmount) {
    if (!price || price <= 0) return 0;
    const rawQuantity = usdtAmount / price;
    return Math.floor(rawQuantity / 1000) * 1000;
}

async function executePaperTrade(action, exchange, side, price, quantity) {
    const timestamp = new Date().toISOString();
    const tradeId = `${exchange}_${side}_${Date.now()}`;
    
    console.log(`\n📝 PAPER TRADE EXECUTED:`);
    console.log(`   Time: ${timestamp}`);
    console.log(`   Exchange: ${exchange.toUpperCase()}`);
    console.log(`   Side: ${side.toUpperCase()}`);
    console.log(`   Price: $${price.toFixed(8)}`);
    console.log(`   Quantity: ${quantity.toLocaleString()} SHIB`);
    console.log(`   Value: $${(price * quantity).toFixed(2)}`);
    
    const value = price * quantity;
    
    if (exchange === 'htx') {
        if (side === 'buy') {
            paperState.balances.htx.USDT -= value;
            paperState.balances.htx.SHIB += quantity;
        } else {
            paperState.balances.htx.USDT += value;
            paperState.balances.htx.SHIB -= quantity;
        }
    } else if (exchange === 'phemex') {
        if (side === 'buy') {
            paperState.balances.phemex.USDT -= value;
            paperState.balances.phemex.SHIB += quantity;
        } else {
            paperState.balances.phemex.USDT += value;
            paperState.balances.phemex.SHIB -= quantity;
        }
    }
    
    return { tradeId, success: true, price, quantity };
}

async function openArbitragePosition() {
    if (paperState.openPositions.length >= config.maxOpenPositions) {
        paperState.status = `Max positions (${config.maxOpenPositions}) reached`;
        return false;
    }
    
    const htxPrice = paperState.prices.htx.ask;
    const phemexPrice = paperState.prices.phemex.bid;
    
    if (!htxPrice || !phemexPrice || htxPrice <= 0 || phemexPrice <= 0) {
        return false;
    }
    
    const spreadPct = ((htxPrice - phemexPrice) / phemexPrice) * 100;
    
    let buyExchange, sellExchange, buyPrice, sellPrice, expectedProfit;
    
    if (htxPrice < phemexPrice) {
        buyExchange = 'htx';
        sellExchange = 'phemex';
        buyPrice = htxPrice;
        sellPrice = phemexPrice;
        expectedProfit = (sellPrice - buyPrice) / buyPrice * 100;
    } else {
        buyExchange = 'phemex';
        sellExchange = 'htx';
        buyPrice = phemexPrice;
        sellPrice = htxPrice;
        expectedProfit = (sellPrice - buyPrice) / buyPrice * 100;
    }
    
    if (expectedProfit < config.minSpreadPercent) {
        return false;
    }
    
    console.log(`\n🔍 ARBITRAGE OPPORTUNITY DETECTED!`);
    console.log(`   HTX: $${htxPrice.toFixed(8)} | Phemex: $${phemexPrice.toFixed(8)}`);
    console.log(`   Spread: ${spreadPct.toFixed(4)}%`);
    console.log(`   Expected Profit: ${expectedProfit.toFixed(4)}%`);
    console.log(`   Action: Buy on ${buyExchange.toUpperCase()}, Sell on ${sellExchange.toUpperCase()}`);
    
    const quantity = calculateQuantity(buyPrice, config.positionSizeUSDT);
    if (quantity <= 0) {
        console.log(`   ❌ Quantity too small: ${quantity}`);
        return false;
    }
    
    const buyResult = await executePaperTrade('open_buy', buyExchange, 'buy', buyPrice, quantity);
    const sellResult = await executePaperTrade('open_sell', sellExchange, 'sell', sellPrice, quantity);
    
    if (buyResult.success && sellResult.success) {
        const position = {
            id: `arb_${Date.now()}`,
            openTime: Date.now(),
            buyExchange,
            sellExchange,
            buyPrice,
            sellPrice,
            quantity,
            openSpread: expectedProfit,
            status: 'open'
        };
        
        paperState.openPositions.push(position);
        paperState.status = `Open position #${paperState.openPositions.length} - Expected profit: ${expectedProfit.toFixed(4)}%`;
        
        console.log(`   ✅ Position opened! ID: ${position.id}`);
        console.log(`   Open Positions: ${paperState.openPositions.length}`);
        
        return true;
    }
    
    return false;
}

async function checkClosePositions() {
    const htxCurrent = paperState.prices.htx.bid;
    const phemexCurrent = paperState.prices.phemex.ask;
    
    if (!htxCurrent || !phemexCurrent) return;
    
    for (let i = 0; i < paperState.openPositions.length; i++) {
        const pos = paperState.openPositions[i];
        if (pos.status !== 'open') continue;
        
        let profitPct;
        
        if (pos.buyExchange === 'htx' && pos.sellExchange === 'phemex') {
            profitPct = ((phemexCurrent - pos.buyPrice) / pos.buyPrice) * 100;
        } else {
            profitPct = ((htxCurrent - pos.buyPrice) / pos.buyPrice) * 100;
        }
        
        let shouldClose = false;
        let closeReason = '';
        
        if (profitPct <= config.closeSpreadPercent && profitPct > 0) {
            shouldClose = true;
            closeReason = 'Target profit reached';
        } else if (profitPct <= -config.maxLossPercent) {
            shouldClose = true;
            closeReason = 'Stop loss triggered';
        } else if (Date.now() - pos.openTime > 30 * 60 * 1000) {
            shouldClose = true;
            closeReason = 'Maximum hold time (30 min)';
        }
        
        if (shouldClose) {
            const closeBuyPrice = pos.buyExchange === 'htx' ? htxCurrent : phemexCurrent;
            const closeSellPrice = pos.sellExchange === 'htx' ? htxCurrent : phemexCurrent;
            
            await executePaperTrade('close_buy', pos.buyExchange, 'sell', closeBuyPrice, pos.quantity);
            await executePaperTrade('close_sell', pos.sellExchange, 'buy', closeSellPrice, pos.quantity);
            
            const buyValue = pos.buyPrice * pos.quantity;
            const sellValue = pos.sellPrice * pos.quantity;
            const expectedUsdtProfit = sellValue - buyValue;
            
            const closeBuyValue = closeBuyPrice * pos.quantity;
            const closeSellValue = closeSellPrice * pos.quantity;
            const actualUsdtProfit = closeSellValue - closeBuyValue;
            
            paperState.stats.totalTrades++;
            if (actualUsdtProfit > 0) {
                paperState.stats.winningTrades++;
            } else {
                paperState.stats.losingTrades++;
            }
            paperState.stats.totalProfit += actualUsdtProfit;
            
            if (paperState.stats.totalProfit < -paperState.stats.maxDrawdown) {
                paperState.stats.maxDrawdown = Math.abs(paperState.stats.totalProfit);
            }
            
            pos.status = 'closed';
            pos.closeTime = Date.now();
            pos.closeReason = closeReason;
            pos.actualProfit = actualUsdtProfit;
            
            console.log(`\n💰 POSITION CLOSED: ${pos.id}`);
            console.log(`   Reason: ${closeReason}`);
            console.log(`   Expected Profit: $${expectedUsdtProfit.toFixed(4)}`);
            console.log(`   Actual Profit: $${actualUsdtProfit.toFixed(4)}`);
            console.log(`   Total Profit: $${paperState.stats.totalProfit.toFixed(4)}`);
            
            paperState.openPositions.splice(i, 1);
            i--;
            
            paperState.status = `Closed position - Profit: $${actualUsdtProfit.toFixed(4)}`;
        }
    }
}

// ==================== WEBSOCKET ====================

let htxWs = null;
let phemexWs = null;

function startHTXWebSocket() {
    if (htxWs) htxWs.close();
    
    htxWs = new WebSocket(config.exchanges.htx.wsHost);
    
    htxWs.on('open', () => {
        console.log('[HTX] WebSocket connected');
        const subMsg = JSON.stringify({
            sub: `market.shibusdt.ticker`,
            id: 'shib_ticker'
        });
        htxWs.send(subMsg);
    });
    
    htxWs.on('message', (data) => {
        zlib.gunzip(data, (err, decoded) => {
            if (err) return;
            const msg = JSON.parse(decoded.toString());
            if (msg.tick && msg.ch === `market.shibusdt.ticker`) {
                paperState.prices.htx = {
                    bid: parseFloat(msg.tick.bid[0]),
                    ask: parseFloat(msg.tick.ask[0]),
                    last: parseFloat(msg.tick.close),
                    timestamp: Date.now()
                };
            }
            if (msg.ping) {
                htxWs.send(JSON.stringify({ pong: msg.ping }));
            }
        });
    });
    
    htxWs.on('error', (err) => {
        console.log(`[HTX] WebSocket error: ${err.message}`);
    });
    
    htxWs.on('close', () => {
        console.log('[HTX] WebSocket disconnected, reconnecting in 5s...');
        setTimeout(startHTXWebSocket, 5000);
    });
}

function startPhemexWebSocket() {
    if (phemexWs) phemexWs.close();
    
    phemexWs = new WebSocket(config.exchanges.phemex.wsHost);
    
    phemexWs.on('open', () => {
        console.log('[PHEMEX] WebSocket connected');
        const subMsg = JSON.stringify({
            method: "subscribe",
            params: [`spot.ticker.${config.symbol}`],
            id: Date.now()
        });
        phemexWs.send(subMsg);
    });
    
    phemexWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.result && msg.result.ticker) {
                paperState.prices.phemex = {
                    bid: parseFloat(msg.result.ticker.bid),
                    ask: parseFloat(msg.result.ticker.ask),
                    last: parseFloat(msg.result.ticker.last),
                    timestamp: Date.now()
                };
            }
        } catch (e) {}
    });
    
    phemexWs.on('error', (err) => {
        console.log(`[PHEMEX] WebSocket error: ${err.message}`);
    });
    
    phemexWs.on('close', () => {
        console.log('[PHEMEX] WebSocket disconnected, reconnecting in 5s...');
        setTimeout(startPhemexWebSocket, 5000);
    });
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    const currentSpread = paperState.prices.htx.ask && paperState.prices.phemex.bid
        ? ((paperState.prices.htx.ask - paperState.prices.phemex.bid) / paperState.prices.phemex.bid) * 100
        : 0;
    
    const winRate = paperState.stats.totalTrades > 0
        ? (paperState.stats.winningTrades / paperState.stats.totalTrades) * 100
        : 0;
    
    res.json({
        status: paperState.status,
        isPaperTrading: paperState.isPaperTrading,
        prices: {
            htx: paperState.prices.htx,
            phemex: paperState.prices.phemex,
            spreadPercent: currentSpread.toFixed(4)
        },
        positions: {
            open: paperState.openPositions.length,
            maxAllowed: config.maxOpenPositions
        },
        balances: paperState.balances,
        stats: {
            totalTrades: paperState.stats.totalTrades,
            winningTrades: paperState.stats.winningTrades,
            losingTrades: paperState.stats.losingTrades,
            winRate: winRate.toFixed(2),
            totalProfit: paperState.stats.totalProfit.toFixed(4),
            maxDrawdown: paperState.stats.maxDrawdown.toFixed(4),
            runningTime: Math.floor((Date.now() - paperState.stats.startTime) / 1000 / 60)
        },
        config: {
            minSpreadPercent: config.minSpreadPercent,
            positionSizeUSDT: config.positionSizeUSDT,
            maxOpenPositions: config.maxOpenPositions,
            maxLossPercent: config.maxLossPercent
        },
        openPositionsDetails: paperState.openPositions.map(p => ({
            id: p.id,
            openTime: new Date(p.openTime).toLocaleTimeString(),
            buyExchange: p.buyExchange,
            sellExchange: p.sellExchange,
            buyPrice: p.buyPrice.toFixed(8),
            sellPrice: p.sellPrice.toFixed(8),
            quantity: p.quantity,
            expectedProfit: ((p.sellPrice - p.buyPrice) / p.buyPrice * 100).toFixed(4)
        }))
    });
});

app.post('/api/scan', async (req, res) => {
    await updatePrices();
    const executed = await openArbitragePosition();
    res.json({ scanned: true, executed });
});

app.post('/api/reset', (req, res) => {
    paperState.balances = {
        htx: { USDT: 10000, SHIB: 0 },
        phemex: { USDT: 10000, SHIB: 0 }
    };
    paperState.openPositions = [];
    paperState.stats = {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: 0,
        maxDrawdown: 0,
        startTime: Date.now()
    };
    paperState.status = 'Reset complete';
    res.json({ reset: true });
});

app.post('/api/config', (req, res) => {
    if (req.body.minSpreadPercent) config.minSpreadPercent = req.body.minSpreadPercent;
    if (req.body.positionSizeUSDT) config.positionSizeUSDT = req.body.positionSizeUSDT;
    if (req.body.maxOpenPositions) config.maxOpenPositions = req.body.maxOpenPositions;
    res.json({ config });
});

async function updatePrices() {
    await Promise.all([
        getHTXPrice(),
        getPhemexPrice()
    ]);
}

// ==================== WEB DASHBOARD ====================

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arbitrage Bot - HTX vs Phemex (Paper Trading)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0a0a0f; color: #e5e5e5; font-family: 'Inter', sans-serif; }
        .glass { background: rgba(15, 25, 35, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(0, 255, 255, 0.1); border-radius: 16px; }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4466; }
        .card { transition: all 0.3s ease; }
        .card:hover { transform: translateY(-2px); border-color: rgba(0, 255, 255, 0.3); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .scanning { animation: pulse 1s infinite; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
                    ⚡ Arbitrage Bot
                </h1>
                <p class="text-sm text-gray-500 mt-1">HTX ↔ PHEMEX | SHIB/USDT | PAPER TRADING MODE</p>
            </div>
            <div class="flex gap-3">
                <button onclick="scanNow()" class="px-4 py-2 bg-cyan-500/20 border border-cyan-500/50 rounded-lg text-cyan-400 hover:bg-cyan-500/30 transition">
                    🔍 Scan Now
                </button>
                <button onclick="resetTrading()" class="px-4 py-2 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 hover:bg-red-500/30 transition">
                    🔄 Reset
                </button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="glass p-6 card">
                <p class="text-gray-400 text-sm uppercase tracking-wider">Total Profit (Paper)</p>
                <p id="totalProfit" class="text-3xl font-bold mt-2 profit-positive">$0.00</p>
                <p class="text-xs text-gray-500 mt-2">Win Rate: <span id="winRate">0</span>%</p>
            </div>
            <div class="glass p-6 card">
                <p class="text-gray-400 text-sm uppercase tracking-wider">Open Positions</p>
                <p id="openPositions" class="text-3xl font-bold mt-2 text-cyan-400">0</p>
                <p class="text-xs text-gray-500 mt-2">Max: <span id="maxPositions">3</span></p>
            </div>
            <div class="glass p-6 card">
                <p class="text-gray-400 text-sm uppercase tracking-wider">Total Trades</p>
                <p id="totalTrades" class="text-3xl font-bold mt-2 text-white">0</p>
                <p class="text-xs text-gray-500 mt-2">Wins: <span id="wins">0</span> | Losses: <span id="losses">0</span></p>
            </div>
        </div>

        <div class="glass p-6 mb-8">
            <h2 class="text-lg font-semibold mb-4 flex items-center gap-2">
                <span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                Live Market Data
            </h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="bg-black/30 rounded-xl p-4">
                    <div class="flex items-center justify-between">
                        <span class="font-bold text-orange-400">HTX</span>
                        <span class="text-xs text-gray-500" id="htxTime">--:--:--</span>
                    </div>
                    <p class="text-2xl font-mono mt-2" id="htxPrice">$0.00000000</p>
                    <div class="flex justify-between text-xs mt-2">
                        <span class="text-gray-500">Bid: <span id="htxBid">0</span></span>
                        <span class="text-gray-500">Ask: <span id="htxAsk">0</span></span>
                    </div>
                </div>
                <div class="flex flex-col items-center justify-center">
                    <div class="text-4xl" id="spreadArrow">↔️</div>
                    <p class="text-2xl font-mono font-bold mt-2" id="spreadValue">0.00%</p>
                    <p class="text-xs text-gray-500 mt-1" id="spreadStatus">Waiting for spread</p>
                </div>
                <div class="bg-black/30 rounded-xl p-4">
                    <div class="flex items-center justify-between">
                        <span class="font-bold text-blue-400">PHEMEX</span>
                        <span class="text-xs text-gray-500" id="phemexTime">--:--:--</span>
                    </div>
                    <p class="text-2xl font-mono mt-2" id="phemexPrice">$0.00000000</p>
                    <div class="flex justify-between text-xs mt-2">
                        <span class="text-gray-500">Bid: <span id="phemexBid">0</span></span>
                        <span class="text-gray-500">Ask: <span id="phemexAsk">0</span></span>
                    </div>
                </div>
            </div>
        </div>

        <div class="glass p-6 mb-8">
            <h2 class="text-lg font-semibold mb-4">📊 Open Arbitrage Positions</h2>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="border-b border-gray-700">
                        <tr class="text-left text-gray-400">
                            <th class="pb-2">ID</th>
                            <th class="pb-2">Time</th>
                            <th class="pb-2">Buy on</th>
                            <th class="pb-2">Sell on</th>
                            <th class="pb-2">Buy Price</th>
                            <th class="pb-2">Sell Price</th>
                            <th class="pb-2">Expected Profit</th>
                            <th class="pb-2">Quantity</th>
                        </tr>
                    </thead>
                    <tbody id="positionsTable">
                        <tr>
                            <td colspan="8" class="text-center text-gray-500 py-4">No open positions</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="glass p-6">
                <h2 class="text-lg font-semibold mb-4">💰 Paper Balances</h2>
                <div class="space-y-3">
                    <div class="flex justify-between items-center p-3 bg-black/30 rounded-lg">
                        <span class="font-bold text-orange-400">HTX</span>
                        <div>
                            <span class="text-white" id="htxUSDT">$10,000.00</span>
                            <span class="text-gray-500 mx-2">|</span>
                            <span class="text-white" id="htxSHIB">0 SHIB</span>
                        </div>
                    </div>
                    <div class="flex justify-between items-center p-3 bg-black/30 rounded-lg">
                        <span class="font-bold text-blue-400">PHEMEX</span>
                        <div>
                            <span class="text-white" id="phemexUSDT">$10,000.00</span>
                            <span class="text-gray-500 mx-2">|</span>
                            <span class="text-white" id="phemexSHIB">0 SHIB</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="glass p-6">
                <h2 class="text-lg font-semibold mb-4">⚙️ Configuration</h2>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs text-gray-400 block mb-1">Min Spread %</label>
                        <input type="number" id="minSpread" step="0.01" class="w-full bg-black/50 border border-gray-700 rounded-lg p-2 text-white" value="0.15">
                    </div>
                    <div>
                        <label class="text-xs text-gray-400 block mb-1">Position Size (USDT)</label>
                        <input type="number" id="positionSize" step="10" class="w-full bg-black/50 border border-gray-700 rounded-lg p-2 text-white" value="100">
                    </div>
                    <div>
                        <label class="text-xs text-gray-400 block mb-1">Max Open Positions</label>
                        <input type="number" id="maxPos" class="w-full bg-black/50 border border-gray-700 rounded-lg p-2 text-white" value="3">
                    </div>
                    <button onclick="updateConfig()" class="w-full mt-2 bg-cyan-600 hover:bg-cyan-700 py-2 rounded-lg transition">Update Config</button>
                </div>
            </div>
        </div>
        
        <div class="mt-8 text-center text-xs text-gray-500">
            <p id="statusMsg">Initializing...</p>
            <p class="mt-2">⚠️ PAPER TRADING MODE - No real funds are being used</p>
        </div>
    </div>

    <script>
        setInterval(fetchStatus, 1000);
        
        async function fetchStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                document.getElementById('htxPrice').innerText = '$' + data.prices.htx.last.toFixed(8);
                document.getElementById('htxBid').innerText = data.prices.htx.bid.toFixed(8);
                document.getElementById('htxAsk').innerText = data.prices.htx.ask.toFixed(8);
                document.getElementById('phemexPrice').innerText = '$' + data.prices.phemex.last.toFixed(8);
                document.getElementById('phemexBid').innerText = data.prices.phemex.bid.toFixed(8);
                document.getElementById('phemexAsk').innerText = data.prices.phemex.ask.toFixed(8);
                
                if (data.prices.htx.timestamp) {
                    document.getElementById('htxTime').innerText = new Date(data.prices.htx.timestamp).toLocaleTimeString();
                }
                if (data.prices.phemex.timestamp) {
                    document.getElementById('phemexTime').innerText = new Date(data.prices.phemex.timestamp).toLocaleTimeString();
                }
                
                const spreadValue = parseFloat(data.prices.spreadPercent);
                document.getElementById('spreadValue').innerText = spreadValue.toFixed(4) + '%';
                if (spreadValue > 0) {
                    document.getElementById('spreadArrow').innerHTML = '📈';
                    document.getElementById('spreadStatus').innerHTML = 'HTX premium';
                    document.getElementById('spreadValue').className = 'text-2xl font-mono font-bold mt-2 profit-positive';
                } else if (spreadValue < 0) {
                    document.getElementById('spreadArrow').innerHTML = '📉';
                    document.getElementById('spreadStatus').innerHTML = 'Phemex premium';
                    document.getElementById('spreadValue').className = 'text-2xl font-mono font-bold mt-2 profit-negative';
                } else {
                    document.getElementById('spreadArrow').innerHTML = '↔️';
                    document.getElementById('spreadStatus').innerHTML = 'No spread';
                }
                
                document.getElementById('totalProfit').innerHTML = (data.stats.totalProfit >= 0 ? '+' : '') + '$' + parseFloat(data.stats.totalProfit).toFixed(4);
                document.getElementById('totalProfit').className = 'text-3xl font-bold mt-2 ' + (data.stats.totalProfit >= 0 ? 'profit-positive' : 'profit-negative');
                document.getElementById('winRate').innerText = data.stats.winRate;
                document.getElementById('openPositions').innerText = data.positions.open;
                document.getElementById('totalTrades').innerText = data.stats.totalTrades;
                document.getElementById('wins').innerText = data.stats.winningTrades;
                document.getElementById('losses').innerText = data.stats.losingTrades;
                document.getElementById('maxPositions').innerText = data.positions.maxAllowed;
                
                document.getElementById('htxUSDT').innerHTML = '$' + data.balances.htx.USDT.toFixed(2);
                document.getElementById('htxSHIB').innerHTML = Math.floor(data.balances.htx.SHIB).toLocaleString() + ' SHIB';
                document.getElementById('phemexUSDT').innerHTML = '$' + data.balances.phemex.USDT.toFixed(2);
                document.getElementById('phemexSHIB').innerHTML = Math.floor(data.balances.phemex.SHIB).toLocaleString() + ' SHIB';
                
                const positionsTable = document.getElementById('positionsTable');
                if (data.openPositionsDetails && data.openPositionsDetails.length > 0) {
                    positionsTable.innerHTML = data.openPositionsDetails.map(pos => {
                        return '<tr class="border-b border-gray-800">' +
                            '<td class="py-2 font-mono text-xs">' + pos.id + '</td>' +
                            '<td class="py-2">' + pos.openTime + '</td>' +
                            '<td class="py-2 text-orange-400">' + pos.buyExchange.toUpperCase() + '</td>' +
                            '<td class="py-2 text-blue-400">' + pos.sellExchange.toUpperCase() + '</td>' +
                            '<td class="py-2 font-mono">$' + pos.buyPrice + '</td>' +
                            '<td class="py-2 font-mono">$' + pos.sellPrice + '</td>' +
                            '<td class="py-2 profit-positive">+' + pos.expectedProfit + '%</td>' +
                            '<td class="py-2">' + parseInt(pos.quantity).toLocaleString() + '</td>' +
                        '</tr>';
                    }).join('');
                } else {
                    positionsTable.innerHTML = '<tr><td colspan="8" class="text-center text-gray-500 py-4">No open positions</td></tr>';
                }
                
                document.getElementById('statusMsg').innerHTML = data.status;
                document.getElementById('minSpread').value = data.config.minSpreadPercent;
                document.getElementById('positionSize').value = data.config.positionSizeUSDT;
                document.getElementById('maxPos').value = data.config.maxOpenPositions;
                
            } catch(e) {
                console.error('Fetch error:', e);
            }
        }
        
        async function scanNow() {
            const btn = event.target;
            btn.classList.add('scanning');
            await fetch('/api/scan', { method: 'POST' });
            setTimeout(() => btn.classList.remove('scanning'), 1000);
        }
        
        async function resetTrading() {
            if (confirm('Reset all paper trading data? This will clear all positions and balances.')) {
                await fetch('/api/reset', { method: 'POST' });
                await fetchStatus();
            }
        }
        
        async function updateConfig() {
            const configData = {
                minSpreadPercent: parseFloat(document.getElementById('minSpread').value),
                positionSizeUSDT: parseFloat(document.getElementById('positionSize').value),
                maxOpenPositions: parseInt(document.getElementById('maxPos').value)
            };
            
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
            
            alert('Configuration updated');
        }
        
        fetchStatus();
    </script>
</body>
</html>`);
});

// ==================== MAIN LOOP ====================

async function mainLoop() {
    await updatePrices();
    await checkClosePositions();
    await openArbitragePosition();
}

async function start() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 ARBITRAGE BOT STARTING - PAPER TRADING MODE');
    console.log('='.repeat(60));
    console.log(`\n📊 Configuration:`);
    console.log(`   Symbol: SHIB/USDT`);
    console.log(`   Exchanges: HTX ↔ PHEMEX`);
    console.log(`   Min Spread: ${config.minSpreadPercent}%`);
    console.log(`   Position Size: $${config.positionSizeUSDT}`);
    console.log(`   Max Positions: ${config.maxOpenPositions}`);
    console.log(`   Stop Loss: ${config.maxLossPercent}%`);
    console.log(`\n⚠️  PAPER TRADING MODE - No real funds used`);
    console.log(`📊 Web Dashboard: http://localhost:${config.port}\n`);
    
    startHTXWebSocket();
    startPhemexWebSocket();
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Dashboard running at http://localhost:${config.port}`);
    });
    
    setInterval(mainLoop, 2000);
    
    paperState.status = 'Running - Scanning for arbitrage opportunities';
}

process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    if (htxWs) htxWs.close();
    if (phemexWs) phemexWs.close();
    process.exit();
});

start();
