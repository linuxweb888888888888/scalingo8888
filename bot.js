require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const config = {
    // HTX API
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    passphrase: process.env.HTX_PASSPHRASE,
    
    // Bot Settings
    symbol: process.env.SYMBOL || 'BTC-USDT',
    baseOrderAmount: parseFloat(process.env.BASE_ORDER_AMOUNT) || 10,
    volumeScale: parseFloat(process.env.VOLUME_SCALE) || 1.5,  // ← POSITION MULTIPLIER 1.5x
    priceDecreasePercent: parseFloat(process.env.PRICE_DECREASE_PERCENT) / 100 || 0.01,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) / 100 || 0.015,
    maxSafetyOrders: parseInt(process.env.MAX_SAFETY_ORDERS) || 4,
    leverage: parseInt(process.env.LEVERAGE) || 1,
    
    // Server
    port: process.env.PORT || 3000,
    restEndpoint: 'https://api.htx.com'
};

// ==================== VOLUME SCALE CALCULATION ====================
// Using Volume Scale multiplier (e.g., 1.5x) like HTX bot
function calculateOrderAmount(orderIndex) {
    // orderIndex: 0 = initial, 1 = safety order 1, 2 = safety order 2, etc.
    const multiplier = Math.pow(config.volumeScale, orderIndex);
    const amount = config.baseOrderAmount * multiplier;
    return { multiplier, amount, orderIndex };
}

function calculateTotalInvestment() {
    let total = 0;
    for (let i = 0; i <= config.maxSafetyOrders; i++) {
        total += config.baseOrderAmount * Math.pow(config.volumeScale, i);
    }
    return total;
}

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    currentOrderIndex: 0,  // 0 = initial order placed
    orders: [],
    averageEntryPrice: 0,
    totalPositionSize: 0,
    currentPrice: 0,
    totalPnL: 0,
    unrealizedPnL: 0,
    realizedPnL: 0,
    status: 'stopped'
};

// ==================== HTX API ====================
function generateSignature(method, path, body = '') {
    const timestamp = Date.now();
    const stringToSign = timestamp + method + path + body;
    const signature = crypto
        .createHmac('sha256', config.secretKey)
        .update(stringToSign)
        .digest('base64');
    return { signature, timestamp };
}

async function apiRequest(method, path, data = null) {
    const url = `${config.restEndpoint}${path}`;
    const body = data ? JSON.stringify(data) : '';
    const { signature, timestamp } = generateSignature(method, path, body);
    
    const headers = {
        'Content-Type': 'application/json',
        'AccessKeyId': config.apiKey,
        'SignatureMethod': 'HmacSHA256',
        'SignatureVersion': '2',
        'Timestamp': timestamp,
        'Signature': signature
    };
    if (config.passphrase) headers['AccessPassphrase'] = config.passphrase;
    
    const response = await axios({ method, url, headers, data: data });
    if (response.data.status === 'error') throw new Error(response.data['err-msg']);
    return response.data;
}

async function setLeverage() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_swap_leverage';
    await apiRequest('POST', path, {
        contract_code: config.symbol,
        lever_rate: config.leverage,
        swap_type: 'swap_cross'
    });
}

async function placeOrder(amountUSDT, price = null) {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    const volume = config.symbol.includes('USDT') ? amountUSDT : amountUSDT / (botState.currentPrice || 50000);
    
    const data = {
        contract_code: config.symbol,
        volume: volume,
        direction: 'buy',
        offset: 'open',
        lever_rate: config.leverage,
        order_price_type: price ? 'limit' : 'market'
    };
    if (price) data.price = price;
    
    const response = await apiRequest('POST', path, data);
    return response.data.order_id;
}

async function getPosition() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_position_info';
    const response = await apiRequest('POST', path, { contract_code: config.symbol });
    
    if (response.data && response.data.length > 0) {
        const pos = response.data[0];
        botState.currentPrice = parseFloat(pos.last_price);
        botState.averageEntryPrice = parseFloat(pos.cost_hold);
        botState.totalPositionSize = parseFloat(pos.volume);
        if (botState.totalPositionSize > 0) {
            botState.unrealizedPnL = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        }
    }
}

async function closePosition() {
    if (botState.totalPositionSize <= 0) return false;
    
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    const response = await apiRequest('POST', path, {
        contract_code: config.symbol,
        volume: Math.abs(botState.totalPositionSize),
        direction: 'sell',
        offset: 'close',
        lever_rate: config.leverage,
        order_price_type: 'market'
    });
    
    if (response.data.order_id) {
        const profit = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        botState.realizedPnL += profit;
        botState.totalPnL = botState.realizedPnL;
        resetCycle();
        return true;
    }
    return false;
}

function checkTakeProfit() {
    if (botState.totalPositionSize === 0 || botState.averageEntryPrice === 0) return false;
    const profitPercent = (botState.currentPrice - botState.averageEntryPrice) / botState.averageEntryPrice;
    if (profitPercent >= config.takeProfitPercent) {
        console.log(`🎯 Take profit! ${(profitPercent * 100).toFixed(2)}%`);
        closePosition();
        return true;
    }
    return false;
}

async function executeSafetyOrder() {
    if (botState.currentOrderIndex >= config.maxSafetyOrders) {
        console.log(`Max safety orders (${config.maxSafetyOrders}) reached, waiting for take profit`);
        return;
    }
    
    const nextIndex = botState.currentOrderIndex + 1;
    const { multiplier, amount } = calculateOrderAmount(nextIndex);
    const targetPrice = botState.currentPrice * (1 - config.priceDecreasePercent);
    
    console.log(`\n🔄 Safety Order #${nextIndex}/${config.maxSafetyOrders}`);
    console.log(`   Volume Scale: ${config.volumeScale}x → Multiplier: ${multiplier.toFixed(2)}x`);
    console.log(`   Order amount: ${amount.toFixed(2)} USDT`);
    console.log(`   Target price: ${targetPrice.toFixed(2)}`);
    
    const orderId = await placeOrder(amount, targetPrice);
    
    if (orderId) {
        botState.orders.push({
            id: orderId,
            orderIndex: nextIndex,
            multiplier: multiplier,
            amount: amount,
            price: targetPrice
        });
        botState.currentOrderIndex = nextIndex;
        
        setTimeout(async () => {
            await getPosition();
            checkTakeProfit();
        }, 2000);
    }
}

function resetCycle() {
    console.log(`\n✅ Cycle reset. Total PnL: ${botState.totalPnL.toFixed(2)} USDT`);
    botState.currentOrderIndex = 0;
    botState.orders = [];
    botState.averageEntryPrice = 0;
    botState.totalPositionSize = 0;
    botState.unrealizedPnL = 0;
}

let lastPrice = null;
let interval = null;

async function monitorPrice() {
    interval = setInterval(async () => {
        if (!botState.isRunning) return;
        
        await getPosition();
        checkTakeProfit();
        
        if (lastPrice && botState.currentPrice && botState.currentOrderIndex < config.maxSafetyOrders) {
            const drop = (lastPrice - botState.currentPrice) / lastPrice;
            if (drop >= config.priceDecreasePercent) {
                console.log(`📉 Price dropped ${(drop * 100).toFixed(2)}%`);
                await executeSafetyOrder();
            }
        }
        lastPrice = botState.currentPrice;
    }, 5000);
}

async function startBot() {
    const totalRequired = calculateTotalInvestment();
    console.log('\n🚀 Starting HTX Martingale Bot (Volume Scale Mode)');
    console.log(`   Volume Scale: ${config.volumeScale}x`);
    console.log(`   Base Order: ${config.baseOrderAmount} USDT`);
    console.log(`   Safety Orders: ${config.maxSafetyOrders}`);
    console.log(`   Total Required: ${totalRequired.toFixed(2)} USDT\n`);
    
    await setLeverage();
    await getPosition();
    
    if (botState.currentOrderIndex === 0) {
        const { multiplier, amount } = calculateOrderAmount(0);
        console.log(`📊 Initial Order: ${multiplier}x → ${amount} USDT`);
        await placeOrder(amount, null);
        botState.currentOrderIndex = 0;
        botState.orders.push({
            orderIndex: 0,
            multiplier: multiplier,
            amount: amount,
            price: 'market'
        });
        setTimeout(async () => await getPosition(), 2000);
    }
    
    botState.isRunning = true;
    botState.status = 'running';
    monitorPrice();
}

function stopBot() {
    if (interval) clearInterval(interval);
    botState.isRunning = false;
    botState.status = 'stopped';
    console.log('Bot stopped');
}

// ==================== EXPRESS SERVER ====================
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => {
    // Generate order preview
    const orderPreview = [];
    for (let i = 0; i <= config.maxSafetyOrders; i++) {
        const { multiplier, amount } = calculateOrderAmount(i);
        orderPreview.push({ orderIndex: i, multiplier: multiplier.toFixed(2), amount: amount.toFixed(2) });
    }
    
    res.json({
        status: botState.status,
        currentOrderIndex: botState.currentOrderIndex,
        maxSafetyOrders: config.maxSafetyOrders,
        volumeScale: config.volumeScale,
        baseOrderAmount: config.baseOrderAmount,
        totalInvestmentRequired: calculateTotalInvestment(),
        currentPrice: botState.currentPrice,
        averageEntryPrice: botState.averageEntryPrice,
        totalPositionSize: botState.totalPositionSize,
        totalPnL: botState.totalPnL,
        realizedPnL: botState.realizedPnL,
        unrealizedPnL: botState.unrealizedPnL,
        orders: botState.orders,
        orderPreview: orderPreview,
        config: {
            symbol: config.symbol,
            priceDecreasePercent: config.priceDecreasePercent * 100,
            takeProfitPercent: config.takeProfitPercent * 100,
            leverage: config.leverage
        }
    });
});

app.post('/api/start', async (req, res) => {
    if (botState.status === 'running') return res.json({ success: false, message: 'Already running' });
    try {
        await startBot();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true });
});

app.post('/api/close', async (req, res) => {
    try {
        await closePosition();
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// HTML Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Martingale Bot - Volume Scale ${config.volumeScale}x</title>
    <style>
        body { font-family: Arial; background: #1a1a2e; color: white; padding: 20px; }
        .card { background: #16213e; padding: 20px; border-radius: 10px; margin: 10px 0; }
        button { background: #0f3460; color: white; padding: 10px 20px; margin: 5px; border: none; border-radius: 5px; cursor: pointer; }
        .profit { color: #4caf50; }
        .loss { color: #f44336; }
        .order-preview { display: inline-block; background: #e94560; padding: 5px 10px; border-radius: 5px; margin: 2px; font-size: 12px; }
    </style>
</head>
<body>
    <h1>🤖 HTX Martingale Bot</h1>
    <div class="card">
        <h3>Volume Scale: ${config.volumeScale}x | Base: ${config.baseOrderAmount} USDT</h3>
        <div id="orderPreview"></div>
        <hr>
        <p>Status: <strong id="status">-</strong></p>
        <p>Order Index: <span id="orderIndex">-</span> / ${config.maxSafetyOrders}</p>
        <p>Current Price: $<span id="price">-</span></p>
        <p>Avg Entry: $<span id="entry">-</span></p>
        <p>Total PnL: $<span id="pnl">-</span></p>
        <button onclick="startBot()">▶ Start</button>
        <button onclick="stopBot()">⏹ Stop</button>
        <button onclick="closePos()">🔒 Close</button>
    </div>
    <div class="card">
        <h3>Order History</h3>
        <div id="orders"></div>
    </div>
    <script>
        // Generate order preview
        const preview = ${JSON.stringify(Array.from({length: config.maxSafetyOrders + 1}, (_, i) => {
            const m = Math.pow(config.volumeScale, i);
            return { orderIndex: i, multiplier: m.toFixed(2), amount: (config.baseOrderAmount * m).toFixed(2) };
        }))};
        document.getElementById('orderPreview').innerHTML = preview.map(o => 
            '<span class="order-preview">#'+o.orderIndex+': '+o.multiplier+'x → '+o.amount+' USDT</span>'
        ).join(' ');
        
        setInterval(fetchStatus, 2000);
        async function fetchStatus() {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('status').innerHTML = data.status;
            document.getElementById('orderIndex').innerHTML = data.currentOrderIndex;
            document.getElementById('price').innerHTML = data.currentPrice?.toFixed(2) || '-';
            document.getElementById('entry').innerHTML = data.averageEntryPrice?.toFixed(2) || '-';
            const pnl = document.getElementById('pnl');
            pnl.innerHTML = data.totalPnL?.toFixed(2) || '0';
            pnl.className = data.totalPnL >= 0 ? 'profit' : 'loss';
            document.getElementById('orders').innerHTML = data.orders.slice().reverse().map(o => 
                '<div>Order #'+o.orderIndex+': '+o.multiplier.toFixed(2)+'x → $'+o.amount.toFixed(2)+' @ '+(o.price === 'market' ? 'MARKET' : '$'+o.price.toFixed(2))+'</div>'
            ).join('');
        }
        async function startBot() { await fetch('/api/start', {method:'POST'}); fetchStatus(); }
        async function stopBot() { await fetch('/api/stop', {method:'POST'}); fetchStatus(); }
        async function closePos() { if(confirm('Close all positions?')) await fetch('/api/close', {method:'POST'}); }
        fetchStatus();
    </script>
</body>
</html>
    `);
});

const totalRequired = calculateTotalInvestment();
app.listen(config.port, () => {
    console.log(`\n✅ Bot running at http://localhost:${config.port}`);
    console.log(`📊 Volume Scale: ${config.volumeScale}x`);
    console.log(`📈 Order Sequence:`);
    for (let i = 0; i <= config.maxSafetyOrders; i++) {
        const { multiplier, amount } = calculateOrderAmount(i);
        console.log(`   Order ${i}: ${multiplier.toFixed(2)}x → ${amount.toFixed(2)} USDT`);
    }
    console.log(`💰 Total Required: ${totalRequired.toFixed(2)} USDT\n`);
});
