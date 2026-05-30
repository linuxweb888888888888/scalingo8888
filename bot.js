// FILE: bot.js - COMPLETE DEPLOYMENT READY VERSION

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    positionSizeUSDT: 200,
    minSpreadPercent: 0.10,
    maxOpenPositions: 3,
    closeSpreadPercent: 0.05,
    maxLossPercent: 2.0,
    port: process.env.PORT || 3000,
    
    initialBalances: {
        htx: { USDT: 10000, SHIB: 50000000 },
        phemex: { USDT: 10000, SHIB: 50000000 }
    }
};

// ==================== PAPER TRADING STATE ====================
const paperState = {
    balances: { 
        htx: { ...config.initialBalances.htx }, 
        phemex: { ...config.initialBalances.phemex } 
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

function checkBalances(exchange, side, price, quantity) {
    const value = price * quantity;
    const balance = paperState.balances[exchange];
    
    if (side === 'buy') {
        if (balance.USDT < value) {
            console.log(`❌ ${exchange.toUpperCase()} insufficient USDT: Need $${value.toFixed(2)}, Have $${balance.USDT.toFixed(2)}`);
            return false;
        }
    } else {
        if (balance.SHIB < quantity) {
            console.log(`❌ ${exchange.toUpperCase()} insufficient SHIB: Need ${quantity.toLocaleString()}, Have ${balance.SHIB.toLocaleString()}`);
            return false;
        }
    }
    return true;
}

function calculateQuantity(price) {
    if (!price || price <= 0) return 0;
    const rawQuantity = config.positionSizeUSDT / price;
    return Math.max(Math.floor(rawQuantity / 1000) * 1000, 1000);
}

async function executeTrade(exchange, side, price, quantity) {
    const value = price * quantity;
    
    if (!checkBalances(exchange, side, price, quantity)) {
        return false;
    }
    
    if (exchange === 'htx') {
        if (side === 'buy') {
            paperState.balances.htx.USDT -= value;
            paperState.balances.htx.SHIB += quantity;
        } else {
            paperState.balances.htx.USDT += value;
            paperState.balances.htx.SHIB -= quantity;
        }
    } else {
        if (side === 'buy') {
            paperState.balances.phemex.USDT -= value;
            paperState.balances.phemex.SHIB += quantity;
        } else {
            paperState.balances.phemex.USDT += value;
            paperState.balances.phemex.SHIB -= quantity;
        }
    }
    
    console.log(`✅ ${exchange.toUpperCase()} ${side.toUpperCase()} ${quantity.toLocaleString()} SHIB @ $${price.toFixed(8)}`);
    return true;
}

async function checkAndExecuteArbitrage() {
    const htxBid = paperState.prices.htx.bid;
    const htxAsk = paperState.prices.htx.ask;
    const phemexBid = paperState.prices.phemex.bid;
    const phemexAsk = paperState.prices.phemex.ask;
    
    if (!htxBid || !htxAsk || !phemexBid || !phemexAsk) return;
    if (htxBid <= 0 || htxAsk <= 0 || phemexBid <= 0 || phemexAsk <= 0) return;
    
    const buyHTXSellPhemex = ((phemexBid - htxAsk) / htxAsk) * 100;
    const buyPhemexSellHTX = ((htxBid - phemexAsk) / phemexAsk) * 100;
    
    if (Date.now() - paperState.lastLog > 10000) {
        console.log(`\n📊 Spreads: Buy HTX→Phemex: ${buyHTXSellPhemex.toFixed(4)}% | Buy Phemex→HTX: ${buyPhemexSellHTX.toFixed(4)}%`);
        paperState.lastLog = Date.now();
    }
    
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
    
    if (buyExchange && paperState.openPositions.length < config.maxOpenPositions) {
        const quantity = calculateQuantity(buyPrice);
        if (quantity <= 0) return;
        
        console.log(`\n🎯 ARBITRAGE! Expected profit: ${expectedProfit.toFixed(4)}%`);
        
        const buySuccess = await executeTrade(buyExchange, 'buy', buyPrice, quantity);
        const sellSuccess = await executeTrade(sellExchange, 'sell', sellPrice, quantity);
        
        if (buySuccess && sellSuccess) {
            paperState.openPositions.push({
                id: `pos_${Date.now()}`,
                openTime: Date.now(),
                openTimeStr: new Date().toLocaleTimeString(),
                buyExchange, sellExchange,
                buyPrice, sellPrice,
                quantity,
                expectedProfit: expectedProfit
            });
            paperState.stats.totalTrades++;
            paperState.status = `Trade executed! Expected profit: ${expectedProfit.toFixed(4)}%`;
        }
    }
}

async function checkClosePositions() {
    for (let i = 0; i < paperState.openPositions.length; i++) {
        const pos = paperState.openPositions[i];
        
        const htxBid = paperState.prices.htx.bid;
        const phemexBid = paperState.prices.phemex.bid;
        const htxAsk = paperState.prices.htx.ask;
        const phemexAsk = paperState.prices.phemex.ask;
        
        let currentProfit = 0;
        let closeBuyPrice = 0;
        let closeSellPrice = 0;
        
        if (pos.buyExchange === 'htx' && pos.sellExchange === 'phemex') {
            currentProfit = ((phemexBid - pos.buyPrice) / pos.buyPrice) * 100;
            closeBuyPrice = htxAsk;
            closeSellPrice = phemexBid;
        } else {
            currentProfit = ((htxBid - pos.buyPrice) / pos.buyPrice) * 100;
            closeBuyPrice = phemexAsk;
            closeSellPrice = htxBid;
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
            console.log(`\n💰 CLOSING: ${pos.id} - ${reason}`);
            
            const closeSuccess = await executeTrade(pos.sellExchange, 'buy', closeSellPrice, pos.quantity);
            const closeSuccess2 = await executeTrade(pos.buyExchange, 'sell', closeBuyPrice, pos.quantity);
            
            if (closeSuccess && closeSuccess2) {
                const actualProfit = (closeSellPrice - closeBuyPrice) * pos.quantity;
                
                if (actualProfit > 0) paperState.stats.winningTrades++;
                else paperState.stats.losingTrades++;
                paperState.stats.totalProfit += actualProfit;
                
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
    paperState.balances = { 
        htx: { USDT: config.initialBalances.htx.USDT, SHIB: config.initialBalances.htx.SHIB }, 
        phemex: { USDT: config.initialBalances.phemex.USDT, SHIB: config.initialBalances.phemex.SHIB } 
    };
    paperState.openPositions = [];
    paperState.stats = { totalTrades: 0, winningTrades: 0, losingTrades: 0, totalProfit: 0, maxDrawdown: 0, startTime: Date.now() };
    paperState.status = 'Reset complete';
    res.json({ reset: true });
});

app.post('/api/config', (req, res) => {
    if (req.body.minSpreadPercent) config.minSpreadPercent = req.body.minSpreadPercent;
    if (req.body.positionSizeUSDT) config.positionSizeUSDT = req.body.positionSizeUSDT;
    res.json({ config });
});

// ==================== SIMPLE HTML DASHBOARD ====================

const HTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arbitrage Bot - HTX vs Phemex</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0a0a0f; color: #e5e5e5; font-family: 'Courier New', monospace; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .card { background: rgba(15, 25, 35, 0.9); border-radius: 16px; border: 1px solid rgba(0,255,255,0.2); padding: 20px; margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .profit { color: #00ff88; }
        .loss { color: #ff4466; }
        .cyan { color: #00ffff; }
        .orange { color: #ffaa00; }
        .spread-big { font-size: 48px; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        button { background: #00ffff20; border: 1px solid #00ffff; color: #00ffff; padding: 10px 20px; border-radius: 8px; cursor: pointer; }
        button:hover { background: #00ffff40; }
        input { background: #1a1a2e; border: 1px solid #333; color: white; padding: 8px; border-radius: 6px; width: 100%; }
        .opportunity { background: rgba(0,255,136,0.1); border: 1px solid rgba(0,255,136,0.3); }
    </style>
</head>
<body>
<div class="container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <div>
            <h1 class="cyan">⚡ Arbitrage Bot</h1>
            <p style="color: #666;">HTX ↔ PHEMEX | SHIB/USDT | PAPER TRADING</p>
        </div>
        <div>
            <button onclick="scanNow()">🔍 Manual Scan</button>
            <button onclick="resetTrading()" style="margin-left: 10px;">🔄 Reset</button>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <p style="color: #666;">Total Profit</p>
            <p id="totalProfit" class="profit" style="font-size: 32px; font-weight: bold;">$0.00</p>
            <p>Win Rate: <span id="winRate">0</span>% | Trades: <span id="totalTrades">0</span></p>
        </div>
        <div class="card">
            <p style="color: #666;">Open Positions</p>
            <p id="openPositions" class="cyan" style="font-size: 48px; font-weight: bold;">0</p>
            <p>Max: <span id="maxPositions">3</span></p>
        </div>
        <div class="card">
            <p style="color: #666;">Session</p>
            <p><span id="wins" class="profit">0</span> Wins | <span id="losses" class="loss">0</span> Losses</p>
            <p>Running: <span id="runningTime">0</span> min</p>
        </div>
    </div>

    <div class="card" id="marketCard">
        <h2 class="cyan">📡 Live Market Data</h2>
        <div class="grid" style="margin-top: 15px;">
            <div style="text-align: center;">
                <h3 class="orange">HTX</h3>
                <p style="font-size: 24px; font-weight: bold;" id="htxPrice">$0.00000000</p>
                <p>Bid: <span id="htxBid" class="profit">0</span> | Ask: <span id="htxAsk" class="loss">0</span></p>
            </div>
            <div style="text-align: center;" id="spreadBox">
                <div style="font-size: 48px;" id="spreadArrow">↔️</div>
                <p id="spreadValue" style="font-size: 32px; font-weight: bold;">0.00%</p>
                <p id="spreadStatus" style="color: #666;">Waiting...</p>
            </div>
            <div style="text-align: center;">
                <h3 class="cyan">PHEMEX</h3>
                <p style="font-size: 24px; font-weight: bold;" id="phemexPrice">$0.00000000</p>
                <p>Bid: <span id="phemexBid" class="profit">0</span> | Ask: <span id="phemexAsk" class="loss">0</span></p>
            </div>
        </div>
    </div>

    <div class="card">
        <h2 class="cyan">📊 Open Positions (<span id="posCount">0</span>)</h2>
        <div style="overflow-x: auto;">
            <table>
                <thead><tr><th>Time</th><th>Buy</th><th>Sell</th><th>Buy Price</th><th>Sell Price</th><th>Expected %</th><th>Qty</th></tr></thead>
                <tbody id="positionsTable"><tr><td colspan="7" style="text-align: center;">No open positions</td></tr></tbody>
            </table>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <h2 class="cyan">💰 Balances</h2>
            <div style="margin-top: 10px;">
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00000030; border-radius: 8px; margin-bottom: 10px;">
                    <span class="orange">HTX</span><span id="htxUSDT">$10000.00</span><span id="htxSHIB">0 SHIB</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00000030; border-radius: 8px; margin-bottom: 10px;">
                    <span class="cyan">PHEMEX</span><span id="phemexUSDT">$10000.00</span><span id="phemexSHIB">0 SHIB</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 10px; background: #00ffff10; border-radius: 8px;">
                    <span>Total Equity</span><span id="totalEquity" class="profit">$20000.00</span>
                </div>
            </div>
        </div>
        <div class="card">
            <h2 class="cyan">⚙️ Config</h2>
            <div style="margin-top: 10px;">
                <p>Min Spread: <span id="currentMinSpread">0.10</span>%</p>
                <input type="number" id="minSpread" placeholder="Min Spread %" value="0.10" step="0.01">
                <input type="number" id="positionSize" placeholder="Position Size USDT" value="200" step="50" style="margin-top: 10px;">
                <button onclick="updateConfig()" style="margin-top: 10px; width: 100%;">Update Config</button>
            </div>
        </div>
    </div>

    <div style="text-align: center; margin-top: 20px;">
        <p id="statusMsg" class="cyan">Initializing...</p>
        <p style="color: #666; font-size: 12px; margin-top: 10px;">⚠️ PAPER TRADING - Requires BOTH USDT AND SHIB on each exchange</p>
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
            
            spreadValue.innerText = spread.toFixed(4) + '%';
            
            if (spread >= minRequired) {
                spreadBox.className = 'opportunity';
                document.getElementById('spreadArrow').innerHTML = '📈 ACTIVE';
                document.getElementById('spreadStatus').innerHTML = '✅ OPPORTUNITY!';
                spreadValue.className = 'profit';
            } else {
                spreadBox.className = '';
                document.getElementById('spreadArrow').innerHTML = '↔️';
                document.getElementById('spreadStatus').innerHTML = 'Waiting for spread > ' + minRequired + '%';
                spreadValue.className = '';
            }
            
            const totalProfit = parseFloat(d.stats.totalProfit);
            const profitElem = document.getElementById('totalProfit');
            profitElem.innerHTML = (totalProfit >= 0 ? '+' : '') + '$' + Math.abs(totalProfit).toFixed(4);
            profitElem.className = totalProfit >= 0 ? 'profit' : 'loss';
            
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
            
            const tbody = document.getElementById('positionsTable');
            if (d.positions.details && d.positions.details.length > 0) {
                tbody.innerHTML = d.positions.details.map(p => 
                    '<tr><td>' + p.openTime + '</td>' +
                    '<td class="orange">' + p.buyExchange.toUpperCase() + '</td>' +
                    '<td class="cyan">' + p.sellExchange.toUpperCase() + '</td>' +
                    '<td>$' + p.buyPrice + '</td>' +
                    '<td>$' + p.sellPrice + '</td>' +
                    '<td class="profit">+' + p.expectedProfit + '%</td>' +
                    '<td>' + parseInt(p.quantity).toLocaleString() + '</td></tr>'
                ).join('');
            } else {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No open positions</td></tr>';
            }
            
            document.getElementById('statusMsg').innerHTML = '🟢 ' + d.status;
            document.getElementById('minSpread').value = d.config.minSpreadPercent;
            document.getElementById('positionSize').value = d.config.positionSizeUSDT;
        } catch(e) {}
    }
    
    async function scanNow() { await fetch('/api/scan', { method: 'POST' }); }
    async function resetTrading() { if(confirm('Reset all data?')) await fetch('/api/reset', { method: 'POST' }); }
    async function updateConfig() {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                minSpreadPercent: parseFloat(document.getElementById('minSpread').value),
                positionSizeUSDT: parseFloat(document.getElementById('positionSize').value)
            })
        });
        alert('Config updated');
    }
    
    fetchStatus();
</script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(HTML);
});

// ==================== MAIN LOOP ====================

async function mainLoop() {
    await fetchPrices();
    await checkClosePositions();
    await checkAndExecuteArbitrage();
}

async function start() {
    console.log('='.repeat(60));
    console.log('🚀 ARBITRAGE BOT STARTED');
    console.log('='.repeat(60));
    console.log(`\n📊 Config: Min Spread ${config.minSpreadPercent}% | Position $${config.positionSizeUSDT}`);
    console.log(`💰 Required: BOTH USDT AND SHIB on each exchange`);
    console.log(`🤖 Auto-trading ACTIVE\n`);
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`✅ Dashboard: http://localhost:${config.port}`);
    });
    
    setInterval(mainLoop, 3000);
    paperState.status = 'Running - Auto-trading active';
}

start();
