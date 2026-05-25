require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    passphrase: process.env.HTX_PASSPHRASE,
    
    symbol: process.env.SYMBOL || 'SHIB-USDT',
    totalInvestment: parseFloat(process.env.TOTAL_INVESTMENT) || 100,
    priceDecreasePercent: parseFloat(process.env.PRICE_DECREASE_PERCENT) / 100 || 0.001,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) / 100 || 0.0015,
    maxSafetyOrders: parseInt(process.env.MAX_SAFETY_ORDERS) || 10,
    leverage: parseInt(process.env.LEVERAGE) || 1,
    volumeScale: parseFloat(process.env.VOLUME_SCALE) || 1.2,
    initialAmount: parseFloat(process.env.INITIAL_AMOUNT) || 6000,
    
    port: process.env.PORT || 3000,
    restEndpoint: 'https://api.htx.com'
};

// ==================== ✅ CORRECT API ENDPOINTS (NO DUPLICATE /api/v1/) ====================
const API = {
    setLeverage: '/linear-swap-api/v1/swap_cross_swap_leverage',
    placeOrder: '/linear-swap-api/v1/swap_order',
    getPosition: '/linear-swap-api/v1/swap_cross_position_info',
    cancelOrder: '/linear-swap-api/v1/swap_cancel',
    orderInfo: '/linear-swap-api/v1/swap_order_info',
    marketDetail: '/linear-swap-api/market/detail'
};

// ==================== HTX SIGNATURE ====================
function generateSignature(method, path, body = '') {
    const timestamp = Date.now();
    const stringToSign = method + '\n' + path + '\n' + body + '\n' + timestamp;
    const signature = crypto
        .createHmac('sha256', config.secretKey)
        .update(stringToSign)
        .digest('base64');
    return { signature, timestamp };
}

async function apiRequest(method, path, data = null, needAuth = true) {
    const url = `${config.restEndpoint}${path}`;
    const body = data ? JSON.stringify(data) : '';
    
    let headers = { 'Content-Type': 'application/json' };
    
    if (needAuth) {
        const { signature, timestamp } = generateSignature(method, path, body);
        headers = {
            ...headers,
            'AccessKeyId': config.apiKey,
            'SignatureMethod': 'HmacSHA256',
            'SignatureVersion': '2',
            'Timestamp': timestamp.toString(),
            'Signature': signature
        };
        if (config.passphrase) {
            headers['AccessPassphrase'] = config.passphrase;
        }
    }
    
    try {
        const response = await axios({ method, url, headers, data: data });
        if (response.data.status === 'error') {
            throw new Error(response.data['err-msg'] || 'API Error');
        }
        return response.data;
    } catch (error) {
        console.error(`❌ API Error: ${path}`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Message: ${error.response?.data?.message || error.message}`);
        throw error;
    }
}

// ==================== ✅ FIXED ORDER CALCULATIONS (NO DIVISION BY ZERO) ====================
function calculateOrderAmount(orderIndex) {
    // SAFE: Calculate total shares with at least 1 share
    let totalShares = 0;
    for (let i = 0; i <= config.maxSafetyOrders; i++) {
        totalShares += Math.pow(config.volumeScale, i);
    }
    
    // Ensure we don't divide by zero
    if (totalShares <= 0) {
        totalShares = 1;
    }
    
    const multiplier = Math.pow(config.volumeScale, orderIndex);
    let amount;
    
    if (orderIndex === 0) {
        amount = config.initialAmount;
    } else {
        // Calculate based on total investment proportion
        amount = (multiplier / totalShares) * config.totalInvestment;
        // Ensure minimum amount
        if (amount < 1) amount = 1;
    }
    
    return {
        multiplier: multiplier.toFixed(2),
        amount: Math.floor(amount), // Whole number for SHIB
        orderIndex
    };
}

function calculateSafetyOrderPrice(entryPrice, orderIndex) {
    if (!entryPrice || entryPrice <= 0) return 0.000005;
    return entryPrice * (1 - (config.priceDecreasePercent * (orderIndex + 1)));
}

function calculateTakeProfitPrice(entryPrice) {
    if (!entryPrice || entryPrice <= 0) return 0.000006;
    return entryPrice * (1 + config.takeProfitPercent);
}

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    currentPrice: 0,
    averageEntryPrice: 0,
    totalPositionSize: 0,
    totalPnL: 0,
    unrealizedPnL: 0,
    realizedPnL: 0,
    status: 'stopped',
    tpOrder: null,
    initialOrder: null,
    additionOrders: [],
    filledOrders: [],
    errors: []
};

// ==================== API ACTIONS ====================
async function setLeverage() {
    console.log(`📊 Setting leverage to ${config.leverage}x...`);
    const data = {
        contract_code: config.symbol,
        lever_rate: config.leverage,
        swap_type: 'swap_cross'
    };
    const result = await apiRequest('POST', API.setLeverage, data, true);
    console.log(`✅ Leverage set to ${config.leverage}x`);
    return result;
}

async function placeOrder(amount, price = null, direction = 'buy', orderType = 'limit') {
    const data = {
        contract_code: config.symbol,
        volume: amount,
        direction: direction,
        offset: 'open',
        lever_rate: config.leverage,
        order_price_type: orderType
    };
    if (price && orderType === 'limit') {
        data.price = price;
    }
    
    console.log(`📝 ${direction === 'buy' ? 'BUY' : 'SELL'} ${amount} @ ${price || 'MARKET'}`);
    const result = await apiRequest('POST', API.placeOrder, data, true);
    
    if (result.data && result.data.order_id) {
        console.log(`✅ Order ID: ${result.data.order_id}`);
        return result.data.order_id;
    }
    return null;
}

async function getMarketPrice() {
    try {
        const url = `${config.restEndpoint}${API.marketDetail}?contract_code=${config.symbol}`;
        const response = await axios.get(url);
        if (response.data.status === 'ok' && response.data.tick) {
            return parseFloat(response.data.tick.close);
        }
        return null;
    } catch (error) {
        console.error(`Failed to get price: ${error.message}`);
        return null;
    }
}

async function getPosition() {
    const data = { contract_code: config.symbol };
    const result = await apiRequest('POST', API.getPosition, data, true);
    
    if (result.data && result.data.length > 0) {
        const pos = result.data[0];
        botState.currentPrice = parseFloat(pos.last_price);
        botState.averageEntryPrice = parseFloat(pos.cost_hold);
        botState.totalPositionSize = parseFloat(pos.volume);
        if (botState.totalPositionSize > 0) {
            botState.unrealizedPnL = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        }
        return pos;
    }
    return null;
}

async function closePosition() {
    if (botState.totalPositionSize <= 0) return false;
    
    const orderId = await placeOrder(botState.totalPositionSize, null, 'sell', 'market');
    if (orderId) {
        const profit = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        botState.realizedPnL += profit;
        botState.totalPnL = botState.realizedPnL;
        console.log(`💰 Profit: ${profit.toFixed(8)} USDT`);
        return true;
    }
    return false;
}

// ==================== BOT ACTIONS ====================
async function placeInitialOrder() {
    const { amount } = calculateOrderAmount(0);
    const orderId = await placeOrder(amount, null, 'buy', 'market');
    
    // Wait a bit for position to update
    await new Promise(resolve => setTimeout(resolve, 2000));
    await getPosition();
    
    botState.initialOrder = {
        id: orderId,
        type: 'Initial Order',
        amount: amount,
        price: botState.averageEntryPrice || botState.currentPrice,
        status: 'Filled',
        timestamp: Date.now()
    };
    botState.filledOrders.push(botState.initialOrder);
    
    // Set TP Order
    const tpPrice = calculateTakeProfitPrice(botState.averageEntryPrice);
    const tpOrderId = await placeOrder(botState.totalPositionSize, tpPrice, 'sell', 'limit');
    
    botState.tpOrder = {
        id: tpOrderId,
        type: 'TP Order',
        amount: botState.totalPositionSize,
        price: tpPrice,
        status: 'To be filled',
        timestamp: Date.now()
    };
    
    console.log(`\n✅ INITIAL ORDER: ${amount} @ ${botState.currentPrice}`);
    console.log(`🎯 TAKE PROFIT: ${tpPrice} (${(config.takeProfitPercent * 100).toFixed(2)}%)\n`);
}

async function placeAdditionOrder(orderIndex) {
    const { amount, multiplier } = calculateOrderAmount(orderIndex);
    const orderPrice = calculateSafetyOrderPrice(botState.averageEntryPrice, orderIndex - 1);
    
    const orderId = await placeOrder(amount, orderPrice, 'buy', 'limit');
    
    const order = {
        id: orderId,
        type: `Addition Order #${orderIndex}`,
        amount: amount,
        price: orderPrice,
        multiplier: multiplier,
        status: 'To be filled',
        orderIndex: orderIndex,
        timestamp: Date.now()
    };
    
    botState.additionOrders.push(order);
    console.log(`📊 ADDITION #${orderIndex}: ${amount} @ ${orderPrice} (${multiplier}x)`);
    return order;
}

async function checkTakeProfit() {
    await getPosition();
    
    if (botState.tpOrder && botState.currentPrice >= botState.tpOrder.price) {
        console.log(`🎯 TAKE PROFIT TRIGGERED! Current: ${botState.currentPrice} >= TP: ${botState.tpOrder.price}`);
        await closePosition();
        
        // Reset for next cycle
        botState.additionOrders = [];
        botState.tpOrder = null;
        botState.initialOrder = null;
        botState.filledOrders = [];
        
        // Start new cycle
        setTimeout(async () => {
            if (botState.isRunning) {
                await placeInitialOrder();
            }
        }, 5000);
        
        return true;
    }
    return false;
}

async function checkPriceDrop() {
    if (!botState.averageEntryPrice || botState.averageEntryPrice <= 0) return;
    
    const currentDropPercent = (botState.averageEntryPrice - botState.currentPrice) / botState.averageEntryPrice;
    const nextOrderIndex = botState.additionOrders.length + 1;
    const expectedDrop = config.priceDecreasePercent * (nextOrderIndex);
    
    if (currentDropPercent >= expectedDrop && nextOrderIndex <= config.maxSafetyOrders) {
        const alreadyPlaced = botState.additionOrders.some(o => o.orderIndex === nextOrderIndex);
        if (!alreadyPlaced) {
            console.log(`📉 Price dropped ${(currentDropPercent * 100).toFixed(2)}%, triggering addition order #${nextOrderIndex}`);
            await placeAdditionOrder(nextOrderIndex);
        }
    }
}

// ==================== MONITORING ====================
let monitoringInterval = null;

async function monitorLoop() {
    if (!botState.isRunning) return;
    
    try {
        await getPosition();
        await checkTakeProfit();
        await checkPriceDrop();
    } catch (error) {
        console.error(`Monitor error: ${error.message}`);
        botState.errors.push({ time: Date.now(), error: error.message });
    }
}

function startMonitoring() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    monitoringInterval = setInterval(monitorLoop, 3000);
    console.log('👀 Monitoring started (interval: 3s)');
}

function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
}

// ==================== BOT CONTROL ====================
async function startBot() {
    console.log('\n🚀 STARTING MARTINGALE BOT');
    console.log('=========================');
    console.log(`   Symbol: ${config.symbol}`);
    console.log(`   Volume Scale: ${config.volumeScale}x`);
    console.log(`   Max Safety Orders: ${config.maxSafetyOrders}`);
    console.log(`   Initial Amount: ${config.initialAmount}`);
    console.log(`   Total Investment: ${config.totalInvestment} USDT`);
    console.log(`   Leverage: ${config.leverage}x`);
    console.log('=========================\n');
    
    try {
        // Get current market price
        const marketPrice = await getMarketPrice();
        if (marketPrice) {
            botState.currentPrice = marketPrice;
            console.log(`📊 Current ${config.symbol} price: ${marketPrice}`);
        }
        
        // Set leverage
        await setLeverage();
        
        // Place initial order
        await placeInitialOrder();
        
        botState.isRunning = true;
        botState.status = 'running';
        botState.startTime = new Date();
        
        startMonitoring();
        console.log('\n✅ Bot is running!\n');
        
    } catch (error) {
        console.error('\n❌ Failed to start bot:', error.message);
        botState.status = 'error';
        botState.errorMessage = error.message;
    }
}

function stopBot() {
    console.log('\n🛑 Stopping bot...');
    stopMonitoring();
    botState.isRunning = false;
    botState.status = 'stopped';
    console.log('✅ Bot stopped\n');
}

// ==================== EXPRESS SERVER ====================
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => {
    // Calculate order preview safely
    const additionPreview = [];
    for (let i = 1; i <= config.maxSafetyOrders; i++) {
        const { amount, multiplier } = calculateOrderAmount(i);
        const price = calculateSafetyOrderPrice(botState.averageEntryPrice || botState.currentPrice || 0.00000564, i - 1);
        additionPreview.push({
            number: i,
            amount: amount,
            price: price,
            multiplier: multiplier,
            status: botState.additionOrders.find(o => o.orderIndex === i)?.status || 'Pending'
        });
    }
    
    res.json({
        status: botState.status,
        isRunning: botState.isRunning,
        currentPrice: botState.currentPrice,
        averageEntryPrice: botState.averageEntryPrice,
        totalPositionSize: botState.totalPositionSize,
        totalPnL: botState.totalPnL,
        unrealizedPnL: botState.unrealizedPnL,
        realizedPnL: botState.realizedPnL,
        startTime: botState.startTime,
        errors: botState.errors.slice(-10),
        tpOrder: botState.tpOrder,
        initialOrder: botState.initialOrder,
        additionOrders: botState.additionOrders,
        additionPreview: additionPreview,
        config: {
            symbol: config.symbol,
            totalInvestment: config.totalInvestment,
            priceDecreasePercent: config.priceDecreasePercent * 100,
            takeProfitPercent: config.takeProfitPercent * 100,
            maxSafetyOrders: config.maxSafetyOrders,
            volumeScale: config.volumeScale,
            initialAmount: config.initialAmount,
            leverage: config.leverage
        }
    });
});

app.post('/api/start', async (req, res) => {
    if (botState.isRunning) {
        return res.json({ success: false, message: 'Bot already running' });
    }
    try {
        await startBot();
        res.json({ success: true, message: 'Bot started' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/close', async (req, res) => {
    try {
        await closePosition();
        res.json({ success: true, message: 'Position closed' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Simple HTML dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Martingale Bot</title>
    <style>
        body { font-family: Arial; background: #0d1117; color: #e6edf3; padding: 20px; }
        .card { background: #161b22; padding: 20px; border-radius: 10px; margin: 10px 0; }
        button { background: #238636; color: white; padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; }
        .profit { color: #2ea043; }
        .loss { color: #f85149; }
        .status-running { color: #2ea043; }
        .status-stopped { color: #8b949e; }
        .status-error { color: #f85149; }
    </style>
</head>
<body>
    <h1>🤖 HTX Futures Martingale Bot</h1>
    <div class="card">
        <h2>Status: <span id="status" class="status-stopped">Stopped</span></h2>
        <p>Price: $<span id="price">-</span></p>
        <p>Avg Entry: $<span id="entry">-</span></p>
        <p>Position: <span id="position">-</span></p>
        <p>PnL: $<span id="pnl">-</span></p>
        <button onclick="startBot()">▶ Start</button>
        <button onclick="stopBot()">⏹ Stop</button>
        <button onclick="closePos()">🔒 Close</button>
    </div>
    <div class="card">
        <h3>Order Preview</h3>
        <div id="orders"></div>
    </div>
    <script>
        setInterval(fetchStatus, 2000);
        
        async function fetchStatus() {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('status').innerHTML = data.status;
            document.getElementById('status').className = 'status-' + data.status;
            document.getElementById('price').innerHTML = data.currentPrice?.toFixed(8) || '-';
            document.getElementById('entry').innerHTML = data.averageEntryPrice?.toFixed(8) || '-';
            document.getElementById('position').innerHTML = data.totalPositionSize?.toFixed(0) || '0';
            const pnl = document.getElementById('pnl');
            pnl.innerHTML = data.totalPnL?.toFixed(4) || '0';
            pnl.className = data.totalPnL >= 0 ? 'profit' : 'loss';
            
            const ordersDiv = document.getElementById('orders');
            if (data.additionPreview) {
                ordersDiv.innerHTML = data.additionPreview.map(o => 
                    '<div>Order #' + o.number + ': ' + o.multiplier + 'x → ' + o.amount + ' @ ' + o.price?.toFixed(8) + ' (' + o.status + ')</div>'
                ).join('');
            }
        }
        
        async function startBot() { await fetch('/api/start', {method:'POST'}); fetchStatus(); }
        async function stopBot() { await fetch('/api/stop', {method:'POST'}); fetchStatus(); }
        async function closePos() { if(confirm('Close positions?')) await fetch('/api/close', {method:'POST'}); }
        
        fetchStatus();
    </script>
</body>
</html>
    `);
});

// ==================== START ====================
app.listen(config.port, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   HTX Futures Martingale Bot           ║
    ║   Dashboard: http://localhost:${config.port}  ║
    ║   Symbol: ${config.symbol.padEnd(20)}      ║
    ║   Volume Scale: ${config.volumeScale}x                    ║
    ╚════════════════════════════════════════╝
    `);
});
