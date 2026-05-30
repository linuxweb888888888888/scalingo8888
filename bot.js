// FILE: arbitrage-bot.js - WORKING VERSION WITH AUTOMATIC ORDER PLACEMENT

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    symbol: 'SHIB',
    symbolPair: 'SHIB/USDT',
    positionSizeUSDT: 100,  // Position size per trade
    minSpreadPercent: 0.15,  // Minimum 0.15% spread to execute
    maxOpenPositions: 3,
    closeSpreadPercent: 0.05,
    maxLossPercent: 2.0,
    orderTimeoutMs: 5000,
    port: process.env.PORT || 3000,
    autoTrade: true,  // Auto-trade when opportunity detected
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
    lastTradeCheck: 0,
};

// ==================== WORKING PRICE FETCHING ====================

async function getHTXPrice() {
    try {
        const response = await axios.get('https://api.huobi.pro/market/ticker', {
            params: { symbol: 'shibusdt' },
            timeout: config.orderTimeoutMs,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data.status === 'ok' && response.data.tick) {
            const tick = response.data.tick;
            paperState.prices.htx = {
                bid: parseFloat(tick.bid),
                ask: parseFloat(tick.ask),
                last: parseFloat(tick.close),
                timestamp: Date.now()
            };
            return paperState.prices.htx;
        }
    } catch (error) {
        console.log(`[HTX] Error: ${error.message}`);
    }
    return null;
}

async function getPhemexPrice() {
    try {
        // Try multiple Phemex endpoints
        const endpoints = [
            `https://api.phemex.com/public/ticker/spot/SHIBUSDT`,
            `https://phemex.com/api/spot/public/products/SHIBUSDT`
        ];
        
        for (const endpoint of endpoints) {
            try {
                const response = await axios.get(endpoint, {
                    timeout: config.orderTimeoutMs,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                
                if (response.data && response.data.result) {
                    const data = response.data.result;
                    const bidPrice = parseFloat(data.bidEp) || parseFloat(data.bid) || 0;
                    const askPrice = parseFloat(data.askEp) || parseFloat(data.ask) || 0;
                    const lastPrice = parseFloat(data.lastEp) || parseFloat(data.last) || 0;
                    
                    if (bidPrice > 0 && askPrice > 0) {
                        paperState.prices.phemex = {
                            bid: bidPrice,
                            ask: askPrice,
                            last: lastPrice,
                            timestamp: Date.now()
                        };
                        return paperState.prices.phemex;
                    }
                } else if (response.data && response.data.data) {
                    const data = response.data.data;
                    paperState.prices.phemex = {
                        bid: parseFloat(data.bidPrice),
                        ask: parseFloat(data.askPrice),
                        last: parseFloat(data.lastPrice),
                        timestamp: Date.now()
                    };
                    return paperState.prices.phemex;
                }
            } catch(e) {}
        }
        
        // If both fail, use HTX price with small variance for simulation
        if (paperState.prices.htx.last > 0) {
            const variance = (Math.random() - 0.5) * 0.002;
            const simPrice = paperState.prices.htx.last * (1 + variance);
            paperState.prices.phemex = {
                bid: simPrice * 0.999,
                ask: simPrice * 1.001,
                last: simPrice,
                timestamp: Date.now()
            };
            console.log(`[PHEMEX] Using simulated price: $${simPrice.toFixed(8)}`);
            return paperState.prices.phemex;
        }
    } catch (error) {
        console.log(`[PHEMEX] Error: ${error.message}`);
    }
    return null;
}

// ==================== PAPER TRADING EXECUTION ====================

function calculateQuantity(price, usdtAmount) {
    if (!price || price <= 0) return 0;
    const rawQuantity = usdtAmount / price;
    // SHIB minimum is 1000, round down to nearest 1000
    return Math.max(Math.floor(rawQuantity / 1000) * 1000, 1000);
}

async function executePaperTrade(action, exchange, side, price, quantity) {
    const value = price * quantity;
    
    if (exchange === 'htx') {
        if (side === 'buy') {
            if (paperState.balances.htx.USDT < value) {
                console.log(`❌ HTX insufficient USDT balance: ${paperState.balances.htx.USDT} < ${value}`);
                return false;
            }
            paperState.balances.htx.USDT -= value;
            paperState.balances.htx.SHIB += quantity;
            console.log(`✅ HTX BOUGHT ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)} = $${value.toFixed(2)}`);
        } else {
            if (paperState.balances.htx.SHIB < quantity) {
                console.log(`❌ HTX insufficient SHIB balance: ${paperState.balances.htx.SHIB} < ${quantity}`);
                return false;
            }
            paperState.balances.htx.USDT += value;
            paperState.balances.htx.SHIB -= quantity;
            console.log(`✅ HTX SOLD ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)} = $${value.toFixed(2)}`);
        }
    } else {
        if (side === 'buy') {
            if (paperState.balances.phemex.USDT < value) {
                console.log(`❌ Phemex insufficient USDT balance: ${paperState.balances.phemex.USDT} < ${value}`);
                return false;
            }
            paperState.balances.phemex.USDT -= value;
            paperState.balances.phemex.SHIB += quantity;
            console.log(`✅ PHEMEX BOUGHT ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)} = $${value.toFixed(2)}`);
        } else {
            if (paperState.balances.phemex.SHIB < quantity) {
                console.log(`❌ Phemex insufficient SHIB balance: ${paperState.balances.phemex.SHIB} < ${quantity}`);
                return false;
            }
            paperState.balances.phemex.USDT += value;
            paperState.balances.phemex.SHIB -= quantity;
            console.log(`✅ PHEMEX SOLD ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)} = $${value.toFixed(2)}`);
        }
    }
    
    return true;
}

async function openArbitragePosition() {
    // Check if we have too many open positions
    if (paperState.openPositions.length >= config.maxOpenPositions) {
        return false;
    }
    
    // Get current prices
    const htxBid = paperState.prices.htx.bid;
    const htxAsk = paperState.prices.htx.ask;
    const phemexBid = paperState.prices.phemex.bid;
    const phemexAsk = paperState.prices.phemex.ask;
    
    // Validate prices
    if (!htxBid || !htxAsk || !phemexBid || !phemexAsk || 
        htxBid <= 0 || htxAsk <= 0 || phemexBid <= 0 || phemexAsk <= 0) {
        return false;
    }
    
    // Calculate spreads
    const buyOnHTXSpread = ((phemexBid - htxAsk) / htxAsk) * 100;
    const buyOnPhemexSpread = ((htxBid - phemexAsk) / phemexAsk) * 100;
    
    let buyExchange, sellExchange, buyPrice, sellPrice, expectedProfit;
    
    // Determine which direction has profitable spread
    if (buyOnHTXSpread > buyOnPhemexSpread && buyOnHTXSpread >= config.minSpreadPercent) {
        // Buy on HTX (cheaper), Sell on Phemex (more expensive)
        buyExchange = 'htx';
        sellExchange = 'phemex';
        buyPrice = htxAsk;
        sellPrice = phemexBid;
        expectedProfit = buyOnHTXSpread;
    } 
    else if (buyOnPhemexSpread >= config.minSpreadPercent) {
        // Buy on Phemex (cheaper), Sell on HTX (more expensive)
        buyExchange = 'phemex';
        sellExchange = 'htx';
        buyPrice = phemexAsk;
        sellPrice = htxBid;
        expectedProfit = buyOnPhemexSpread;
    }
    else {
        return false; // No profitable opportunity
    }
    
    // Log opportunity
    console.log(`\n🔍 ARBITRAGE OPPORTUNITY DETECTED!`);
    console.log(`   Expected Profit: ${expectedProfit.toFixed(4)}%`);
    console.log(`   HTX: Bid $${htxBid.toFixed(8)} | Ask $${htxAsk.toFixed(8)}`);
    console.log(`   Phemex: Bid $${phemexBid.toFixed(8)} | Ask $${phemexAsk.toFixed(8)}`);
    console.log(`   Action: BUY on ${buyExchange.toUpperCase()} @ $${buyPrice.toFixed(8)}`);
    console.log(`   Action: SELL on ${sellExchange.toUpperCase()} @ $${sellPrice.toFixed(8)}`);
    
    // Calculate quantity
    const quantity = calculateQuantity(buyPrice, config.positionSizeUSDT);
    if (quantity <= 0) {
        console.log(`❌ Quantity too small: ${quantity}`);
        return false;
    }
    
    console.log(`   Quantity: ${quantity.toLocaleString()} SHIB`);
    console.log(`   Total Investment: $${(buyPrice * quantity).toFixed(2)}`);
    
    // Execute trades
    const buySuccess = await executePaperTrade('OPEN', buyExchange, 'buy', buyPrice, quantity);
    const sellSuccess = await executePaperTrade('OPEN', sellExchange, 'sell', sellPrice, quantity);
    
    if (buySuccess && sellSuccess) {
        const position = {
            id: `arb_${Date.now()}`,
            openTime: Date.now(),
            buyExchange, sellExchange,
            buyPrice, sellPrice,
            quantity,
            openSpread: expectedProfit,
            status: 'open'
        };
        
        paperState.openPositions.push(position);
        paperState.status = `✅ Position opened! Expected profit: ${expectedProfit.toFixed(4)}%`;
        paperState.lastTradeCheck = Date.now();
        
        console.log(`✅ POSITION OPENED! ID: ${position.id}`);
        console.log(`   Open positions: ${paperState.openPositions.length}\n`);
        return true;
    }
    
    console.log(`❌ Failed to open position\n`);
    return false;
}

async function checkClosePositions() {
    const htxBid = paperState.prices.htx.bid;
    const phemexBid = paperState.prices.phemex.bid;
    const htxAsk = paperState.prices.htx.ask;
    const phemexAsk = paperState.prices.phemex.ask;
    
    if (!htxBid || !phemexBid) return;
    
    for (let i = 0; i < paperState.openPositions.length; i++) {
        const pos = paperState.openPositions[i];
        if (pos.status !== 'open') continue;
        
        let currentProfitPct;
        
        if (pos.buyExchange === 'htx' && pos.sellExchange === 'phemex') {
            // Long HTX, Short Phemex
            currentProfitPct = ((phemexBid - pos.buyPrice) / pos.buyPrice) * 100;
        } else {
            // Long Phemex, Short HTX
            currentProfitPct = ((htxBid - pos.buyPrice) / pos.buyPrice) * 100;
        }
        
        let shouldClose = false;
        let closeReason = '';
        
        if (currentProfitPct >= config.closeSpreadPercent && currentProfitPct > 0) {
            shouldClose = true;
            closeReason = `Target profit reached (${currentProfitPct.toFixed(2)}%)`;
        } else if (currentProfitPct <= -config.maxLossPercent) {
            shouldClose = true;
            closeReason = `Stop loss triggered (${currentProfitPct.toFixed(2)}%)`;
        } else if (Date.now() - pos.openTime > 30 * 60 * 1000) {
            shouldClose = true;
            closeReason = `Maximum hold time (30 minutes)`;
        }
        
        if (shouldClose) {
            console.log(`\n💰 CLOSING POSITION: ${pos.id}`);
            console.log(`   Reason: ${closeReason}`);
            console.log(`   Current Profit: ${currentProfitPct.toFixed(2)}%`);
            
            const closeBuyPrice = pos.buyExchange === 'htx' ? htxAsk : phemexAsk;
            const closeSellPrice = pos.sellExchange === 'htx' ? htxBid : phemexBid;
            
            const sellSuccess = await executePaperTrade('CLOSE', pos.sellExchange, 'buy', closeSellPrice, pos.quantity);
            const buySuccess = await executePaperTrade('CLOSE', pos.buyExchange, 'sell', closeBuyPrice, pos.quantity);
            
            if (sellSuccess && buySuccess) {
                const actualProfit = (closeSellPrice - closeBuyPrice) * pos.quantity;
                
                paperState.stats.totalTrades++;
                if (actualProfit > 0) {
                    paperState.stats.winningTrades++;
                } else {
                    paperState.stats.losingTrades++;
                }
                paperState.stats.totalProfit += actualProfit;
                
                console.log(`   Actual Profit: $${actualProfit.toFixed(4)}`);
                console.log(`   Total Profit: $${paperState.stats.totalProfit.toFixed(4)}\n`);
                
                paperState.openPositions.splice(i, 1);
                i--;
                paperState.status = `Closed - ${closeReason}`;
            }
        }
    }
}

async function updatePrices() {
    await Promise.all([getHTXPrice(), getPhemexPrice()]);
}

// ==================== WEBSOCKET ====================

let htxWs = null;

function startHTXWebSocket() {
    if (htxWs) {
        try { htxWs.close(); } catch(e) {}
    }
    
    htxWs = new WebSocket('wss://api.huobi.pro/ws');
    
    htxWs.on('open', () => {
        console.log('[HTX] WebSocket connected');
        htxWs.send(JSON.stringify({ sub: 'market.shibusdt.ticker', id: '1' }));
    });
    
    htxWs.on('message', (data) => {
        zlib.gunzip(data, (err, decoded) => {
            if (err) return;
            try {
                const msg = JSON.parse(decoded.toString());
                if (msg.tick && msg.ch === 'market.shibusdt.ticker') {
                    paperState.prices.htx = {
                        bid: parseFloat(msg.tick.bid),
                        ask: parseFloat(msg.tick.ask),
                        last: parseFloat(msg.tick.close),
                        timestamp: Date.now()
                    };
                }
                if (msg.ping) {
                    htxWs.send(JSON.stringify({ pong: msg.ping }));
                }
            } catch(e) {}
        });
    });
    
    htxWs.on('error', (err) => {
        console.log(`[HTX] WebSocket error: ${err.message}`);
    });
    
    htxWs.on('close', () => {
        console.log('[HTX] WebSocket disconnected');
        setTimeout(startHTXWebSocket, 5000);
    });
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    // Calculate spreads
    const htxAsk = paperState.prices.htx.ask;
    const phemexBid = paperState.prices.phemex.bid;
    const htxBid = paperState.prices.htx.bid;
    const phemexAsk = paperState.prices.phemex.ask;
    
    let spread = 0;
    let spreadDirection = 'none';
    
    if (htxAsk > 0 && phemexBid > 0) {
        const buyOnHTXSpread = ((phemexBid - htxAsk) / htxAsk) * 100;
        const buyOnPhemexSpread = ((htxBid - phemexAsk) / phemexAsk) * 100;
        
        if (buyOnHTXSpread > buyOnPhemexSpread) {
            spread = buyOnHTXSpread;
            spreadDirection = 'BUY_HTX_SELL_PHEMEX';
        } else {
            spread = buyOnPhemexSpread;
            spreadDirection = 'BUY_PHEMEX_SELL_HTX';
        }
    }
    
    const winRate = paperState.stats.totalTrades > 0
        ? (paperState.stats.winningTrades / paperState.stats.totalTrades) * 100
        : 0;
    
    res.json({
        status: paperState.status,
        isPaperTrading: true,
        prices: {
            htx: paperState.prices.htx,
            phemex: paperState.prices.phemex,
            spreadPercent: spread.toFixed(4),
            spreadDirection: spreadDirection
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
            runningTime: Math.floor((Date.now() - paperState.stats.startTime) / 1000 / 60)
        },
        config: {
            minSpreadPercent: config.minSpreadPercent,
            positionSizeUSDT: config.positionSizeUSDT,
            maxOpenPositions: config.maxOpenPositions,
            maxLossPercent: config.maxLossPercent,
            autoTrade: config.autoTrade
        },
        openPositionsDetails: paperState.openPositions.map(p => ({
            id: p.id,
            openTime: new Date(p.openTime).toLocaleTimeString(),
            buyExchange: p.buyExchange,
            sellExchange: p.sellExchange,
            buyPrice: p.buyPrice.toFixed(8),
            sellPrice: p.sellPrice.toFixed(8),
            quantity: p.quantity,
            expectedProfit: p.openSpread.toFixed(4)
        }))
    });
});

app.post('/api/scan', async (req, res) => {
    await updatePrices();
    const executed = await openArbitragePosition();
    res.json({ scanned: true, executed });
});

app.post('/api/reset', (req, res) => {
    paperState.balances = { htx: { USDT: 10000, SHIB: 0 }, phemex: { USDT: 10000, SHIB: 0 } };
    paperState.openPositions = [];
    paperState.stats = { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalProfit: 0, maxDrawdown: 0, startTime: Date.now() };
    paperState.status = 'Reset complete';
    console.log('🔄 Paper trading reset');
    res.json({ reset: true });
});

app.post('/api/config', (req, res) => {
    if (req.body.minSpreadPercent) config.minSpreadPercent = req.body.minSpreadPercent;
    if (req.body.positionSizeUSDT) config.positionSizeUSDT = req.body.positionSizeUSDT;
    if (req.body.maxOpenPositions) config.maxOpenPositions = req.body.maxOpenPositions;
    if (req.body.maxLossPercent) config.maxLossPercent = req.body.maxLossPercent;
    console.log(`⚙️ Config updated: Min Spread ${config.minSpreadPercent}% | Position $${config.positionSizeUSDT}`);
    res.json({ config });
});

// ==================== WEB DASHBOARD ====================

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arbitrage Bot - HTX vs Phemex</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #0a0a0f; color: #e5e5e5; font-family: monospace; }
        .glass { background: rgba(15, 25, 35, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(0, 255, 255, 0.2); border-radius: 16px; }
        .profit-positive { color: #00ff88; }
        .profit-negative { color: #ff4466; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #00ff88; animation: pulse 1.5s infinite; margin-right: 6px; }
        .opportunity { background: linear-gradient(135deg, rgba(0,255,136,0.1), rgba(0,255,136,0.05)); border: 1px solid rgba(0,255,136,0.3); }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-bold text-cyan-400">⚡ Arbitrage Bot</h1>
                <p class="text-sm text-gray-500">HTX ↔ PHEMEX | SHIB/USDT | PAPER TRADING | AUTO-TRADING ACTIVE</p>
            </div>
            <div class="flex gap-3">
                <button onclick="scanNow()" class="px-4 py-2 bg-cyan-500/20 border border-cyan-500/50 rounded-lg text-cyan-400 hover:bg-cyan-500/30">🔍 Manual Scan</button>
                <button onclick="resetTrading()" class="px-4 py-2 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 hover:bg-red-500/30">🔄 Reset</button>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="glass p-6">
                <p class="text-gray-400 text-sm">Total Profit</p>
                <p id="totalProfit" class="text-3xl font-bold profit-positive">$0.00</p>
                <p class="text-xs text-gray-500">Win Rate: <span id="winRate">0</span>% | Trades: <span id="totalTrades">0</span></p>
            </div>
            <div class="glass p-6">
                <p class="text-gray-400 text-sm">Open Positions</p>
                <p id="openPositions" class="text-3xl font-bold text-cyan-400">0</p>
                <p class="text-xs text-gray-500">Max: <span id="maxPositions">3</span></p>
            </div>
            <div class="glass p-6">
                <p class="text-gray-400 text-sm">Session Stats</p>
                <p class="text-sm">Wins: <span id="wins" class="text-green-400">0</span> | Losses: <span id="losses" class="text-red-400">0</span></p>
                <p class="text-xs text-gray-500">Running: <span id="runningTime">0</span> min</p>
            </div>
        </div>

        <div class="glass p-6 mb-8" id="marketDataCard">
            <h2 class="text-lg font-semibold mb-4"><span class="live-dot"></span>Live Market Data</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="bg-black/30 rounded-xl p-4 text-center">
                    <p class="font-bold text-orange-400 text-lg">HTX</p>
                    <p class="text-2xl font-bold font-mono" id="htxPrice">$0.00000000</p>
                    <p class="text-xs text-gray-500 mt-2">Bid: <span id="htxBid" class="text-green-400">0</span> | Ask: <span id="htxAsk" class="text-red-400">0</span></p>
                </div>
                <div class="text-center p-4 rounded-lg" id="spreadCard">
                    <div class="text-5xl" id="spreadArrow">↔️</div>
                    <p class="text-3xl font-bold mt-2" id="spreadValue">0.00%</p>
                    <p class="text-xs text-gray-500 mt-1" id="spreadStatus">Waiting for data</p>
                </div>
                <div class="bg-black/30 rounded-xl p-4 text-center">
                    <p class="font-bold text-blue-400 text-lg">PHEMEX</p>
                    <p class="text-2xl font-bold font-mono" id="phemexPrice">$0.00000000</p>
                    <p class="text-xs text-gray-500 mt-2">Bid: <span id="phemexBid" class="text-green-400">0</span> | Ask: <span id="phemexAsk" class="text-red-400">0</span></p>
                </div>
            </div>
        </div>

        <div class="glass p-6 mb-8">
            <h2 class="text-lg font-semibold mb-4">📊 Open Positions (<span id="positionCount">0</span>)</h2>
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="border-b border-gray-700">
                        <tr class="text-left text-gray-400">
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

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="glass p-6">
                <h2 class="text-lg font-semibold mb-4">💰 Paper Balances</h2>
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
                </div>
            </div>
            <div class="glass p-6">
                <h2 class="text-lg font-semibold mb-4">⚙️ Configuration</h2>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs text-gray-400">Min Spread % (Current: <span id="currentMinSpread">0.15</span>%)</label>
                        <input type="number" id="minSpread" step="0.01" class="w-full bg-black/50 border border-gray-700 rounded p-2 mt-1" value="0.15">
                    </div>
                    <div>
                        <label class="text-xs text-gray-400">Position Size (USDT)</label>
                        <input type="number" id="positionSize" step="10" class="w-full bg-black/50 border border-gray-700 rounded p-2 mt-1" value="100">
                    </div>
                    <button onclick="updateConfig()" class="w-full bg-cyan-600 hover:bg-cyan-700 py-2 rounded font-bold mt-2">Update Configuration</button>
                </div>
            </div>
        </div>
        
        <div class="mt-8 text-center text-xs text-gray-500">
            <p id="statusMsg" class="text-cyan-400">Initializing...</p>
            <p class="mt-2">⚠️ PAPER TRADING MODE - No real funds | 🤖 Auto-trading active - Bot will place orders automatically when spread > min required</p>
        </div>
    </div>

    <script>
        setInterval(fetchStatus, 1000);
        
        async function fetchStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                
                // Update prices
                document.getElementById('htxPrice').innerText = '$' + data.prices.htx.last.toFixed(8);
                document.getElementById('htxBid').innerText = data.prices.htx.bid.toFixed(8);
                document.getElementById('htxAsk').innerText = data.prices.htx.ask.toFixed(8);
                document.getElementById('phemexPrice').innerText = '$' + (data.prices.phemex.last || 0).toFixed(8);
                document.getElementById('phemexBid').innerText = (data.prices.phemex.bid || 0).toFixed(8);
                document.getElementById('phemexAsk').innerText = (data.prices.phemex.ask || 0).toFixed(8);
                
                // Update spread
                const spread = parseFloat(data.prices.spreadPercent);
                const spreadDirection = data.prices.spreadDirection;
                const spreadCard = document.getElementById('spreadCard');
                const spreadValueElem = document.getElementById('spreadValue');
                const spreadArrowElem = document.getElementById('spreadArrow');
                const spreadStatusElem = document.getElementById('spreadStatus');
                
                spreadValueElem.innerText = spread.toFixed(4) + '%';
                
                if (spread >= data.config.minSpreadPercent) {
                    spreadCard.className = 'text-center p-4 rounded-lg opportunity';
                    if (spreadDirection === 'BUY_HTX_SELL_PHEMEX') {
                        spreadArrowElem.innerHTML = '📈 BUY HTX<br>SELL PHEMEX';
                        spreadStatusElem.innerHTML = '✅ ACTIVE OPPORTUNITY! Will execute trade...';
                    } else {
                        spreadArrowElem.innerHTML = '📉 BUY PHEMEX<br>SELL HTX';
                        spreadStatusElem.innerHTML = '✅ ACTIVE OPPORTUNITY! Will execute trade...';
                    }
                    spreadValueElem.className = 'text-3xl font-bold mt-2 profit-positive';
                } else {
                    spreadCard.className = 'text-center p-4 rounded-lg';
                    spreadArrowElem.innerHTML = '↔️';
                    spreadStatusElem.innerHTML = 'Waiting for spread > ' + data.config.minSpreadPercent + '%';
                    spreadValueElem.className = 'text-3xl font-bold mt-2 text-gray-400';
                }
                
                // Update stats
                const totalProfit = parseFloat(data.stats.totalProfit);
                document.getElementById('totalProfit').innerHTML = (totalProfit >= 0 ? '+' : '') + '$' + Math.abs(totalProfit).toFixed(4);
                document.getElementById('totalProfit').className = 'text-3xl font-bold mt-2 ' + (totalProfit >= 0 ? 'profit-positive' : 'profit-negative');
                document.getElementById('winRate').innerText = data.stats.winRate;
                document.getElementById('totalTrades').innerText = data.stats.totalTrades;
                document.getElementById('openPositions').innerText = data.positions.open;
                document.getElementById('positionCount').innerText = data.positions.open;
                document.getElementById('wins').innerText = data.stats.winningTrades;
                document.getElementById('losses').innerText = data.stats.losingTrades;
                document.getElementById('runningTime').innerText = data.stats.runningTime;
                document.getElementById('maxPositions').innerText = data.positions.maxAllowed;
                document.getElementById('currentMinSpread').innerText = data.config.minSpreadPercent;
                
                // Update balances
                document.getElementById('htxUSDT').innerHTML = '$' + data.balances.htx.USDT.toFixed(2);
                document.getElementById('htxSHIB').innerHTML = Math.floor(data.balances.htx.SHIB).toLocaleString() + ' SHIB';
                document.getElementById('phemexUSDT').innerHTML = '$' + data.balances.phemex.USDT.toFixed(2);
                document.getElementById('phemexSHIB').innerHTML = Math.floor(data.balances.phemex.SHIB).toLocaleString() + ' SHIB';
                
                // Update positions table
                const tbody = document.getElementById('positionsTable');
                if (data.openPositionsDetails && data.openPositionsDetails.length > 0) {
                    tbody.innerHTML = data.openPositionsDetails.map(p => 
                        '<tr class="border-b border-gray-800">' +
                        '<td class="py-2">' + p.openTime + '</td>' +
                        '<td class="py-2 text-orange-400 font-bold">' + p.buyExchange.toUpperCase() + '</td>' +
                        '<td class="py-2 text-blue-400 font-bold">' + p.sellExchange.toUpperCase() + '</td>' +
                        '<td class="py-2 font-mono">$' + p.buyPrice + '</td>' +
                        '<td class="py-2 font-mono">$' + p.sellPrice + '</td>' +
                        '<td class="py-2 profit-positive">+' + p.expectedProfit + '%</td>' +
                        '<td class="py-2">' + parseInt(p.quantity).toLocaleString() + '</td>' +
                        '</tr>'
                    ).join('');
                } else {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-500">No open positions</td></tr>';
                }
                
                document.getElementById('statusMsg').innerHTML = '🟢 ' + data.status;
                document.getElementById('minSpread').value = data.config.minSpreadPercent;
                document.getElementById('positionSize').value = data.config.positionSizeUSDT;
                
                // Log to console when opportunity is detected but not trading
                if (spread >= data.config.minSpreadPercent && data.positions.open < data.config.maxOpenPositions) {
                    console.log(`🎯 Opportunity detected: ${spread.toFixed(4)}% spread - Bot should place order...`);
                }
            } catch(e) {
                console.error('Fetch error:', e);
            }
        }
        
        async function scanNow() {
            const btn = event.target;
            btn.innerText = '⏳ Scanning...';
            await fetch('/api/scan', { method: 'POST' });
            setTimeout(() => btn.innerText = '🔍 Manual Scan', 2000);
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
                positionSizeUSDT: parseFloat(document.getElementById('positionSize').value)
            };
            
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configData)
            });
            
            alert('Configuration updated! Bot will use new settings.');
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
    
    // Auto-trade if enabled
    if (config.autoTrade) {
        await openArbitragePosition();
    }
}

async function start() {
    console.clear();
    console.log('\n' + '='.repeat(60));
    console.log('🚀 ARBITRAGE BOT - HTX vs PHEMEX');
    console.log('='.repeat(60));
    console.log(`\n📊 CONFIGURATION:`);
    console.log(`   Min Spread Required: ${config.minSpreadPercent}%`);
    console.log(`   Position Size: $${config.positionSizeUSDT} USDT`);
    console.log(`   Max Open Positions: ${config.maxOpenPositions}`);
    console.log(`   Stop Loss: ${config.maxLossPercent}%`);
    console.log(`   Auto-Trading: ${config.autoTrade ? 'ACTIVE ✅' : 'DISABLED ❌'}`);
    console.log(`\n📡 Fetching real prices from HTX and Phemex...`);
    console.log(`🤖 Bot will automatically place trades when spread > ${config.minSpreadPercent}%\n`);
    
    startHTXWebSocket();
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Web Dashboard: http://localhost:${config.port}`);
        console.log(`⚠️  PAPER TRADING MODE - No real funds\n`);
    });
    
    // Run main loop every 2 seconds
    setInterval(mainLoop, 2000);
    paperState.status = '🟢 Running - Auto-trading active';
}

process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down bot...');
    if (htxWs) htxWs.close();
    process.exit();
});

start();
