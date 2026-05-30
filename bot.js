// FILE: full-market-arbitrage-bot.js
// SCANS ALL AVAILABLE COINS ON HTX AND PHEMEX

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    positionSizeUSDT: 100,      // Position size per trade in USDT
    minSpreadPercent: 0.15,      // Minimum 0.15% spread to execute
    maxOpenPositions: 5,          // Maximum concurrent positions
    closeSpreadPercent: 0.05,     // Close when profit > 0.05%
    maxLossPercent: 2.0,          // Stop loss at 2%
    port: process.env.PORT || 3000,
    scanIntervalMs: 15000,        // Scan every 15 seconds
    minVolume24h: 50000,          // Minimum $50k volume to consider
    
    initialBalances: {
        htx: { USDT: 50000 },
        phemex: { USDT: 50000 }
    }
};

// ==================== STATE ====================
const paperState = {
    balances: { 
        htx: { USDT: config.initialBalances.htx.USDT },
        phemex: { USDT: config.initialBalances.phemex.USDT }
    },
    holdings: { htx: {}, phemex: {} },
    openPositions: [],
    allPairs: [],           // All common trading pairs
    prices: {},             // Current prices for all pairs
    spreadData: {},         // Spread data for all pairs
    lastScanTime: 0,
    isScanning: false,
    stats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: 0,
        startTime: Date.now(),
        tradesByCoin: {}
    },
    status: 'Initializing...'
};

// ==================== FETCH AVAILABLE PAIRS FROM EXCHANGES ====================

async function fetchHTXPairs() {
    try {
        // HTX public API for all tickers
        const response = await axios.get('https://api.huobi.pro/market/tickers', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data.status === 'ok' && response.data.data) {
            const pairs = [];
            for (const ticker of response.data.data) {
                const symbol = ticker.symbol;
                if (symbol.endsWith('usdt')) {
                    const baseCoin = symbol.replace('usdt', '').toUpperCase();
                    pairs.push({
                        symbol: baseCoin,
                        pair: symbol,
                        volume: parseFloat(ticker.vol) || 0,
                        lastPrice: parseFloat(ticker.close) || 0
                    });
                }
            }
            console.log(`[HTX] Found ${pairs.length} USDT pairs`);
            return pairs;
        }
    } catch (error) {
        console.log(`[HTX] Failed to fetch pairs: ${error.message}`);
    }
    return [];
}

async function fetchPhemexPairs() {
    try {
        // Phemex public API for products
        const response = await axios.get('https://api.phemex.com/public/products', {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data.data && response.data.data.products) {
            const pairs = [];
            for (const product of response.data.data.products) {
                if (product.symbol && product.symbol.endsWith('USDT')) {
                    const baseCoin = product.symbol.replace('USDT', '');
                    pairs.push({
                        symbol: baseCoin,
                        pair: product.symbol,
                        volume: parseFloat(product.volume24h) || 0,
                        lastPrice: parseFloat(product.lastPrice) || 0
                    });
                }
            }
            console.log(`[PHEMEX] Found ${pairs.length} USDT pairs`);
            return pairs;
        }
    } catch (error) {
        console.log(`[PHEMEX] Failed to fetch pairs: ${error.message}`);
    }
    return [];
}

// Find common coins between both exchanges
async function findCommonPairs() {
    console.log('\n🔍 Fetching trading pairs from both exchanges...');
    
    const [htxPairs, phemexPairs] = await Promise.all([
        fetchHTXPairs(),
        fetchPhemexPairs()
    ]);
    
    // Create maps for quick lookup
    const htxMap = new Map();
    for (const p of htxPairs) {
        htxMap.set(p.symbol, p);
    }
    
    const phemexMap = new Map();
    for (const p of phemexPairs) {
        phemexMap.set(p.symbol, p);
    }
    
    // Find common symbols with sufficient volume
    const commonPairs = [];
    for (const [symbol, htxData] of htxMap) {
        const phemexData = phemexMap.get(symbol);
        if (phemexData) {
            const volume = Math.max(htxData.volume, phemexData.volume);
            if (volume >= config.minVolume24h) {
                commonPairs.push({
                    symbol: symbol,
                    htxPair: htxData.pair,
                    phemexPair: phemexData.pair,
                    volume24h: volume
                });
            }
        }
    }
    
    // Sort by volume (highest first) for better scanning priority
    commonPairs.sort((a, b) => b.volume24h - a.volume24h);
    
    console.log(`✅ Found ${commonPairs.length} common coins with volume > $${config.minVolume24h}`);
    console.log(`   Top 10 by volume: ${commonPairs.slice(0, 10).map(p => p.symbol).join(', ')}`);
    
    return commonPairs;
}

// ==================== PRICE FETCHING FOR ALL PAIRS ====================

async function fetchHTXPrice(symbol, pair) {
    try {
        const response = await axios.get(`https://api.huobi.pro/market/ticker`, {
            params: { symbol: pair.toLowerCase() },
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data.status === 'ok' && response.data.tick) {
            const tick = response.data.tick;
            return {
                bid: parseFloat(tick.bid),
                ask: parseFloat(tick.ask),
                last: parseFloat(tick.close)
            };
        }
    } catch (error) {}
    return null;
}

async function fetchPhemexPrice(symbol, pair) {
    try {
        const response = await axios.get(`https://api.phemex.com/public/ticker/spot/${pair}`, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (response.data && response.data.result) {
            const data = response.data.result;
            return {
                bid: parseFloat(data.bidEp) || parseFloat(data.bid) || 0,
                ask: parseFloat(data.askEp) || parseFloat(data.ask) || 0,
                last: parseFloat(data.lastEp) || parseFloat(data.last) || 0
            };
        }
    } catch (error) {}
    return null;
}

// Scan all common pairs for spreads
async function scanAllSpreads() {
    if (paperState.isScanning) {
        console.log('⏳ Scan already in progress, skipping...');
        return;
    }
    
    paperState.isScanning = true;
    console.log(`\n📊 Starting spread scan for ${paperState.allPairs.length} coins...`);
    
    const scanStartTime = Date.now();
    let scanned = 0;
    let opportunities = 0;
    
    // Scan each pair (batch in parallel with concurrency limit)
    const batchSize = 10;
    for (let i = 0; i < paperState.allPairs.length; i += batchSize) {
        const batch = paperState.allPairs.slice(i, i + batchSize);
        const promises = batch.map(async (pair) => {
            const [htxPrice, phemexPrice] = await Promise.all([
                fetchHTXPrice(pair.symbol, pair.htxPair),
                fetchPhemexPrice(pair.symbol, pair.phemexPair)
            ]);
            
            if (htxPrice && htxPrice.bid > 0 && htxPrice.ask > 0 &&
                phemexPrice && phemexPrice.bid > 0 && phemexPrice.ask > 0) {
                
                paperState.prices[pair.symbol] = {
                    htx: htxPrice,
                    phemex: phemexPrice
                };
                
                // Calculate spreads
                const spreadBuyHTX = ((phemexPrice.bid - htxPrice.ask) / htxPrice.ask) * 100;
                const spreadBuyPhemex = ((htxPrice.bid - phemexPrice.ask) / phemexPrice.ask) * 100;
                
                let spreadData = null;
                if (spreadBuyHTX > spreadBuyPhemex && spreadBuyHTX > 0) {
                    spreadData = {
                        spread: spreadBuyHTX,
                        opportunity: spreadBuyHTX >= config.minSpreadPercent,
                        direction: 'BUY_HTX_SELL_PHEMEX',
                        buyExchange: 'htx',
                        sellExchange: 'phemex',
                        buyPrice: htxPrice.ask,
                        sellPrice: phemexPrice.bid
                    };
                } else if (spreadBuyPhemex > 0) {
                    spreadData = {
                        spread: spreadBuyPhemex,
                        opportunity: spreadBuyPhemex >= config.minSpreadPercent,
                        direction: 'BUY_PHEMEX_SELL_HTX',
                        buyExchange: 'phemex',
                        sellExchange: 'htx',
                        buyPrice: phemexPrice.ask,
                        sellPrice: htxPrice.bid
                    };
                } else {
                    spreadData = {
                        spread: Math.max(spreadBuyHTX, spreadBuyPhemex),
                        opportunity: false,
                        direction: null
                    };
                }
                
                paperState.spreadData[pair.symbol] = spreadData;
                
                if (spreadData.opportunity) {
                    opportunities++;
                    console.log(`🎯 ${pair.symbol}: ${spreadData.spread.toFixed(4)}% spread - ${spreadData.direction}`);
                }
            }
            scanned++;
        });
        await Promise.all(promises);
        
        // Show progress
        if ((i + batchSize) % 50 === 0) {
            console.log(`   Scanned ${Math.min(i + batchSize, paperState.allPairs.length)}/${paperState.allPairs.length} coins...`);
        }
    }
    
    const scanTime = ((Date.now() - scanStartTime) / 1000).toFixed(1);
    console.log(`✅ Scan complete in ${scanTime}s | ${scanned} scanned | ${opportunities} opportunities found`);
    
    paperState.lastScanTime = Date.now();
    paperState.status = `Last scan: ${new Date().toLocaleTimeString()} | ${opportunities} opportunities`;
    paperState.isScanning = false;
}

// ==================== TRADE EXECUTION ====================

function calculateQuantity(coin, price) {
    if (!price || price <= 0) return 0;
    const rawQuantity = config.positionSizeUSDT / price;
    
    // Dynamic min quantity based on coin price
    let minQty = 1;
    if (price < 0.00001) minQty = 1000000;
    else if (price < 0.001) minQty = 10000;
    else if (price < 0.1) minQty = 100;
    else if (price < 1) minQty = 10;
    else if (price < 10) minQty = 1;
    else minQty = 0.1;
    
    return Math.max(Math.floor(rawQuantity / minQty) * minQty, minQty);
}

async function executeTrade(coin, exchange, side, price, quantity) {
    const value = price * quantity;
    
    if (side === 'buy') {
        if (paperState.balances[exchange].USDT < value) {
            console.log(`❌ ${exchange.toUpperCase()} insufficient USDT for ${coin}`);
            return false;
        }
        paperState.balances[exchange].USDT -= value;
        paperState.holdings[exchange][coin] = (paperState.holdings[exchange][coin] || 0) + quantity;
        console.log(`✅ ${exchange.toUpperCase()} BUY ${quantity} ${coin} @ $${price.toFixed(8)}`);
    } else {
        if ((paperState.holdings[exchange][coin] || 0) < quantity) {
            console.log(`❌ ${exchange.toUpperCase()} insufficient ${coin}`);
            return false;
        }
        paperState.balances[exchange].USDT += value;
        paperState.holdings[exchange][coin] -= quantity;
        console.log(`✅ ${exchange.toUpperCase()} SELL ${quantity} ${coin} @ $${price.toFixed(8)}`);
    }
    
    return true;
}

async function executeArbitrage(coin, spreadData) {
    if (paperState.openPositions.length >= config.maxOpenPositions) {
        return false;
    }
    
    const quantity = calculateQuantity(coin, spreadData.buyPrice);
    if (quantity <= 0) return false;
    
    console.log(`\n🎯 EXECUTING ARBITRAGE ON ${coin}!`);
    console.log(`   Expected profit: ${spreadData.spread.toFixed(4)}%`);
    console.log(`   Buy ${quantity} ${coin} on ${spreadData.buyExchange.toUpperCase()} @ $${spreadData.buyPrice.toFixed(8)}`);
    console.log(`   Sell on ${spreadData.sellExchange.toUpperCase()} @ $${spreadData.sellPrice.toFixed(8)}`);
    
    const buySuccess = await executeTrade(coin, spreadData.buyExchange, 'buy', spreadData.buyPrice, quantity);
    const sellSuccess = await executeTrade(coin, spreadData.sellExchange, 'sell', spreadData.sellPrice, quantity);
    
    if (buySuccess && sellSuccess) {
        const position = {
            id: `${coin}_${Date.now()}`,
            coin: coin,
            openTime: Date.now(),
            openTimeStr: new Date().toLocaleTimeString(),
            buyExchange: spreadData.buyExchange,
            sellExchange: spreadData.sellExchange,
            buyPrice: spreadData.buyPrice,
            sellPrice: spreadData.sellPrice,
            quantity: quantity,
            expectedProfit: spreadData.spread,
            status: 'open'
        };
        
        paperState.openPositions.push(position);
        paperState.stats.totalTrades++;
        
        if (!paperState.stats.tradesByCoin[coin]) {
            paperState.stats.tradesByCoin[coin] = { count: 0, totalProfit: 0 };
        }
        paperState.stats.tradesByCoin[coin].count++;
        
        console.log(`✅ POSITION OPENED! ${coin}`);
        return true;
    }
    
    return false;
}

async function checkAndClosePositions() {
    for (let i = 0; i < paperState.openPositions.length; i++) {
        const pos = paperState.openPositions[i];
        const prices = paperState.prices[pos.coin];
        
        if (!prices) continue;
        
        let currentProfit = 0;
        let closeBuyPrice = 0;
        let closeSellPrice = 0;
        
        if (pos.buyExchange === 'htx' && pos.sellExchange === 'phemex') {
            currentProfit = ((prices.phemex.bid - pos.buyPrice) / pos.buyPrice) * 100;
            closeBuyPrice = prices.htx.ask;
            closeSellPrice = prices.phemex.bid;
        } else {
            currentProfit = ((prices.htx.bid - pos.buyPrice) / pos.buyPrice) * 100;
            closeBuyPrice = prices.phemex.ask;
            closeSellPrice = prices.htx.bid;
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
            reason = `Max hold time`;
        }
        
        if (shouldClose) {
            console.log(`\n💰 CLOSING ${pos.coin}: ${reason}`);
            
            const closeSuccess = await executeTrade(pos.coin, pos.sellExchange, 'buy', closeSellPrice, pos.quantity);
            const closeSuccess2 = await executeTrade(pos.coin, pos.buyExchange, 'sell', closeBuyPrice, pos.quantity);
            
            if (closeSuccess && closeSuccess2) {
                const actualProfit = (closeSellPrice - closeBuyPrice) * pos.quantity;
                
                if (actualProfit > 0) paperState.stats.winningTrades++;
                else paperState.stats.losingTrades++;
                paperState.stats.totalProfit += actualProfit;
                
                if (paperState.stats.tradesByCoin[pos.coin]) {
                    paperState.stats.tradesByCoin[pos.coin].totalProfit += actualProfit;
                }
                
                paperState.openPositions.splice(i, 1);
                i--;
            }
        }
    }
}

// ==================== API ENDPOINTS ====================

app.get('/api/status', (req, res) => {
    // Find top opportunities
    const opportunities = [];
    for (const [coin, data] of Object.entries(paperState.spreadData)) {
        if (data.opportunity) {
            opportunities.push({
                coin: coin,
                spread: data.spread.toFixed(4),
                direction: data.direction
            });
        }
    }
    opportunities.sort((a, b) => parseFloat(b.spread) - parseFloat(a.spread));
    
    const totalEquity = paperState.balances.htx.USDT + paperState.balances.phemex.USDT;
    const winRate = paperState.stats.totalTrades > 0 ? (paperState.stats.winningTrades / paperState.stats.totalTrades) * 100 : 0;
    
    res.json({
        status: paperState.status,
        stats: {
            totalTrades: paperState.stats.totalTrades,
            winningTrades: paperState.stats.winningTrades,
            losingTrades: paperState.stats.losingTrades,
            winRate: winRate.toFixed(2),
            totalProfit: paperState.stats.totalProfit.toFixed(4),
            runningTime: Math.floor((Date.now() - paperState.stats.startTime) / 1000 / 60),
            tradesByCoin: paperState.stats.tradesByCoin
        },
        positions: {
            open: paperState.openPositions.length,
            maxAllowed: config.maxOpenPositions,
            details: paperState.openPositions.map(p => ({
                coin: p.coin,
                openTime: p.openTimeStr,
                buyExchange: p.buyExchange,
                sellExchange: p.sellExchange,
                buyPrice: p.buyPrice.toFixed(8),
                sellPrice: p.sellPrice.toFixed(8),
                quantity: p.quantity,
                expectedProfit: p.expectedProfit.toFixed(4)
            }))
        },
        opportunities: {
            count: opportunities.length,
            list: opportunities.slice(0, 20)
        },
        market: {
            totalPairs: paperState.allPairs.length,
            lastScan: new Date(paperState.lastScanTime).toLocaleTimeString(),
            isScanning: paperState.isScanning
        },
        balances: {
            htx: { USDT: paperState.balances.htx.USDT.toFixed(2) },
            phemex: { USDT: paperState.balances.phemex.USDT.toFixed(2) },
            totalEquity: totalEquity.toFixed(2)
        },
        config: {
            minSpreadPercent: config.minSpreadPercent,
            positionSizeUSDT: config.positionSizeUSDT,
            maxOpenPositions: config.maxOpenPositions,
            minVolume24h: config.minVolume24h
        }
    });
});

app.post('/api/scan', async (req, res) => {
    await scanAllSpreads();
    res.json({ scanned: true });
});

app.post('/api/execute/:coin', async (req, res) => {
    const coin = req.params.coin.toUpperCase();
    const spreadData = paperState.spreadData[coin];
    
    if (!spreadData || !spreadData.opportunity) {
        res.json({ error: 'No opportunity for this coin' });
        return;
    }
    
    const executed = await executeArbitrage(coin, spreadData);
    res.json({ executed, coin });
});

app.post('/api/reset', (req, res) => {
    paperState.balances = { 
        htx: { USDT: config.initialBalances.htx.USDT },
        phemex: { USDT: config.initialBalances.phemex.USDT }
    };
    paperState.holdings = { htx: {}, phemex: {} };
    paperState.openPositions = [];
    paperState.stats = {
        totalTrades: 0, winningTrades: 0, losingTrades: 0,
        totalProfit: 0, startTime: Date.now(), tradesByCoin: {}
    };
    paperState.status = 'Reset complete';
    res.json({ reset: true });
});

app.post('/api/config', (req, res) => {
    if (req.body.minSpreadPercent) config.minSpreadPercent = req.body.minSpreadPercent;
    if (req.body.positionSizeUSDT) config.positionSizeUSDT = req.body.positionSizeUSDT;
    if (req.body.minVolume24h) config.minVolume24h = req.body.minVolume24h;
    res.json({ config });
});

// ==================== HTML DASHBOARD ====================

const HTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Full Market Arbitrage Scanner - HTX vs Phemex</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0f; color: #e5e5e5; font-family: monospace; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        .card { background: rgba(15, 25, 35, 0.9); border-radius: 16px; border: 1px solid rgba(0,255,255,0.2); padding: 20px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .profit { color: #00ff88; }
        .loss { color: #ff4466; }
        .cyan { color: #00ffff; }
        .orange { color: #ffaa00; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        button { background: #00ffff20; border: 1px solid #00ffff; color: #00ffff; padding: 8px 16px; border-radius: 8px; cursor: pointer; }
        button:hover { background: #00ffff40; }
        input, select { background: #1a1a2e; border: 1px solid #333; color: white; padding: 8px; border-radius: 6px; }
        .opportunity-row { background: rgba(0,255,136,0.1); }
        .scanning { animation: pulse 1s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; }
        .badge-opp { background: #00ff8820; color: #00ff88; border: 1px solid #00ff88; }
    </style>
</head>
<body>
<div class="container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <div>
            <h1 class="cyan">🔍 Full Market Arbitrage Scanner</h1>
            <p style="color: #666;">HTX ↔ PHEMEX | Scanning ALL common coins | PAPER TRADING</p>
        </div>
        <div>
            <button onclick="manualScan()" id="scanBtn">🔍 Scan All Pairs</button>
            <button onclick="resetTrading()" style="margin-left: 10px;">🔄 Reset</button>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <p style="color: #666;">Total Profit</p>
            <p id="totalProfit" class="profit" style="font-size: 32px;">$0.00</p>
            <p>Win Rate: <span id="winRate">0</span>% | Trades: <span id="totalTrades">0</span></p>
        </div>
        <div class="card">
            <p style="color: #666;">Open Positions</p>
            <p id="openPositions" class="cyan" style="font-size: 48px;">0</p>
            <p>Max: <span id="maxPositions">5</span></p>
        </div>
        <div class="card">
            <p style="color: #666;">Market Status</p>
            <p id="pairsCount" class="cyan" style="font-size: 24px;">0 pairs</p>
            <p>Last scan: <span id="lastScan">Never</span></p>
        </div>
    </div>

    <div class="card">
        <h2 class="cyan">🎯 Live Opportunities</h2>
        <div style="overflow-x: auto; max-height: 300px;">
            <table>
                <thead><tr><th>Coin</th><th>Spread</th><th>Direction</th><th>Action</th></tr></thead>
                <tbody id="opportunitiesTable"><tr><td colspan="4" style="text-align: center;">Run a scan to find opportunities</td></tr></tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <h2 class="cyan">📊 Open Positions</h2>
        <div style="overflow-x: auto;">
            <table>
                <thead><tr><th>Coin</th><th>Time</th><th>Buy</th><th>Sell</th><th>Buy Price</th><th>Sell Price</th><th>Qty</th><th>Expected %</th></tr></thead>
                <tbody id="positionsTable"><tr><td colspan="8" style="text-align: center;">No open positions</td></tr></tbody>
            </table>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <h2 class="cyan">💰 Balances</h2>
            <div style="margin-top: 10px;">
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00000030; border-radius: 8px;">
                    <span class="orange">HTX</span><span id="htxUSDT">$50000.00</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00000030; border-radius: 8px; margin-top: 5px;">
                    <span class="cyan">PHEMEX</span><span id="phemexUSDT">$50000.00</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00ffff10; border-radius: 8px; margin-top: 10px;">
                    <span>Total Equity</span><span id="totalEquity" class="profit">$100000.00</span>
                </div>
            </div>
        </div>
        <div class="card">
            <h2 class="cyan">⚙️ Configuration</h2>
            <div style="margin-top: 10px;">
                <div><label>Min Spread %</label><input type="number" id="minSpread" value="0.15" step="0.01"></div>
                <div style="margin-top: 10px;"><label>Position Size (USDT)</label><input type="number" id="positionSize" value="100" step="10"></div>
                <div style="margin-top: 10px;"><label>Min 24h Volume ($)</label><input type="number" id="minVolume" value="50000" step="10000"></div>
                <button onclick="updateConfig()" style="margin-top: 15px; width: 100%;">Update Config</button>
            </div>
        </div>
    </div>

    <div class="card">
        <h2 class="cyan">📈 Trade History by Coin</h2>
        <div style="overflow-x: auto; max-height: 200px;">
            <table>
                <thead><tr><th>Coin</th><th>Trades</th><th>Total Profit</th></tr></thead>
                <tbody id="historyTable"><tr><td colspan="3" style="text-align: center;">No trades yet</td></tr></tbody>
            </table>
        </div>
    </div>

    <div style="text-align: center; margin-top: 20px;">
        <p id="statusMsg" class="cyan">Initializing...</p>
        <p style="color: #666; font-size: 12px;">⚠️ PAPER TRADING | Scanning ALL common coins between HTX and Phemex</p>
    </div>
</div>

<script>
    let autoRefreshInterval;
    
    setInterval(fetchStatus, 2000);
    
    async function fetchStatus() {
        try {
            const r = await fetch('/api/status');
            const d = await r.json();
            
            document.getElementById('totalProfit').innerHTML = (d.stats.totalProfit >= 0 ? '+' : '') + '$' + Math.abs(d.stats.totalProfit).toFixed(4);
            document.getElementById('totalProfit').className = (d.stats.totalProfit >= 0 ? 'profit' : 'loss') + ' ' + 'profit';
            document.getElementById('winRate').innerHTML = d.stats.winRate;
            document.getElementById('totalTrades').innerHTML = d.stats.totalTrades;
            document.getElementById('openPositions').innerHTML = d.positions.open;
            document.getElementById('maxPositions').innerHTML = d.positions.maxAllowed;
            document.getElementById('pairsCount').innerHTML = d.market.totalPairs + ' pairs';
            document.getElementById('lastScan').innerHTML = d.market.lastScan || 'Never';
            
            if (d.market.isScanning) {
                document.getElementById('scanBtn').innerHTML = '⏳ Scanning...';
                document.getElementById('scanBtn').disabled = true;
            } else {
                document.getElementById('scanBtn').innerHTML = '🔍 Scan All Pairs';
                document.getElementById('scanBtn').disabled = false;
            }
            
            document.getElementById('htxUSDT').innerHTML = '$' + d.balances.htx.USDT;
            document.getElementById('phemexUSDT').innerHTML = '$' + d.balances.phemex.USDT;
            document.getElementById('totalEquity').innerHTML = '$' + d.balances.totalEquity;
            
            // Opportunities table
            const oppTable = document.getElementById('opportunitiesTable');
            if (d.opportunities && d.opportunities.list.length > 0) {
                oppTable.innerHTML = d.opportunities.list.map(opp => 
                    '<tr class="opportunity-row">' +
                    '<td><span class="badge badge-opp">' + opp.coin + '</span></td>' +
                    '<td class="profit">+' + opp.spread + '%</td>' +
                    '<td>' + opp.direction + '</td>' +
                    '<td><button onclick="executeTrade(\'' + opp.coin + '\')">Execute</button></td>' +
                    '</tr>'
                ).join('');
            } else {
                oppTable.innerHTML = '<tr><td colspan="4" style="text-align: center;">No opportunities found. Run a scan!</td></tr>';
            }
            
            // Positions table
            const posTable = document.getElementById('positionsTable');
            if (d.positions.details && d.positions.details.length > 0) {
                posTable.innerHTML = d.positions.details.map(p => 
                    '<tr>' +
                    '<td>' + p.coin + '</td>' +
                    '<td>' + p.openTime + '</td>' +
                    '<td class="orange">' + p.buyExchange.toUpperCase() + '</td>' +
                    '<td class="cyan">' + p.sellExchange.toUpperCase() + '</td>' +
                    '<td>$' + p.buyPrice + '</td>' +
                    '<td>$' + p.sellPrice + '</td>' +
                    '<td>' + parseInt(p.quantity).toLocaleString() + '</td>' +
                    '<td class="profit">+' + p.expectedProfit + '%</td>' +
                    '</tr>'
                ).join('');
            } else {
                posTable.innerHTML = '<tr><td colspan="8" style="text-align: center;">No open positions</td></tr>';
            }
            
            // Trade history
            const historyTable = document.getElementById('historyTable');
            if (d.stats.tradesByCoin && Object.keys(d.stats.tradesByCoin).length > 0) {
                historyTable.innerHTML = Object.entries(d.stats.tradesByCoin).map(([coin, data]) => 
                    '<tr><td>' + coin + '</td><td>' + data.count + '</td><td class="' + (data.totalProfit >= 0 ? 'profit' : 'loss') + '">$' + data.totalProfit.toFixed(4) + '</td></tr>'
                ).join('');
            } else {
                historyTable.innerHTML = '<tr><td colspan="3" style="text-align: center;">No trades yet</td></tr>';
            }
            
            document.getElementById('statusMsg').innerHTML = '🟢 ' + d.status;
            document.getElementById('minSpread').value = d.config.minSpreadPercent;
            document.getElementById('positionSize').value = d.config.positionSizeUSDT;
            document.getElementById('minVolume').value = d.config.minVolume24h;
        } catch(e) {}
    }
    
    async function manualScan() {
        const btn = document.getElementById('scanBtn');
        btn.innerHTML = '⏳ Scanning ' + document.getElementById('pairsCount').innerText + '...';
        await fetch('/api/scan', { method: 'POST' });
        setTimeout(fetchStatus, 1000);
    }
    
    async function executeTrade(coin) {
        if (confirm('Execute arbitrage on ' + coin + '?')) {
            const r = await fetch('/api/execute/' + coin, { method: 'POST' });
            const d = await r.json();
            if (d.executed) {
                alert('Trade executed on ' + coin);
                fetchStatus();
            } else {
                alert('Failed to execute trade');
            }
        }
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
                positionSizeUSDT: parseFloat(document.getElementById('positionSize').value),
                minVolume24h: parseFloat(document.getElementById('minVolume').value)
            })
        });
        alert('Config updated');
    }
    
    fetchStatus();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(HTML);
});

// ==================== MAIN LOOP ====================

async function initialize() {
    console.log('='.repeat(60));
    console.log('🚀 FULL MARKET ARBITRAGE SCANNER');
    console.log('='.repeat(60));
    
    // Fetch all common trading pairs
    paperState.allPairs = await findCommonPairs();
    
    if (paperState.allPairs.length === 0) {
        console.log('⚠️ No common pairs found. Using fallback list...');
        // Fallback to known major coins
        paperState.allPairs = [
            { symbol: 'BTC', htxPair: 'btcusdt', phemexPair: 'BTCUSDT', volume24h: 10000000 },
            { symbol: 'ETH', htxPair: 'ethusdt', phemexPair: 'ETHUSDT', volume24h: 5000000 },
            { symbol: 'SOL', htxPair: 'solusdt', phemexPair: 'SOLUSDT', volume24h: 2000000 },
            { symbol: 'XRP', htxPair: 'xrpusdt', phemexPair: 'XRPUSDT', volume24h: 1500000 },
            { symbol: 'DOGE', htxPair: 'dogeusdt', phemexPair: 'DOGEUSDT', volume24h: 1000000 },
            { symbol: 'ADA', htxPair: 'adausdt', phemexPair: 'ADAUSDT', volume24h: 800000 },
            { symbol: 'AVAX', htxPair: 'avaxusdt', phemexPair: 'AVAXUSDT', volume24h: 700000 },
            { symbol: 'DOT', htxPair: 'dotusdt', phemexPair: 'DOTUSDT', volume24h: 600000 },
            { symbol: 'LINK', htxPair: 'linkusdt', phemexPair: 'LINKUSDT', volume24h: 500000 },
            { symbol: 'MATIC', htxPair: 'maticusdt', phemexPair: 'MATICUSDT', volume24h: 500000 }
        ];
        console.log(`   Using ${paperState.allPairs.length} major coins as fallback`);
    }
    
    console.log(`\n📊 Configuration:`);
    console.log(`   Min Spread: ${config.minSpreadPercent}%`);
    console.log(`   Position Size: $${config.positionSizeUSDT}`);
    console.log(`   Min Volume: $${config.minVolume24h}`);
    console.log(`   Max Positions: ${config.maxOpenPositions}`);
    
    console.log(`\n🤖 Auto-scanning every ${config.scanIntervalMs/1000} seconds`);
    console.log(`✅ Dashboard: http://localhost:${config.port}\n`);
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`🌐 Web UI: http://localhost:${config.port}`);
    });
    
    // Initial scan
    await scanAllSpreads();
    
    // Periodic scanning
    setInterval(async () => {
        await scanAllSpreads();
        await checkAndClosePositions();
    }, config.scanIntervalMs);
    
    paperState.status = `Running | Scanning ${paperState.allPairs.length} pairs`;
}

initialize();
