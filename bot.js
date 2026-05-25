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
    totalInvestment: parseFloat(process.env.TOTAL_INVESTMENT) || 100,
    priceDecreasePercent: parseFloat(process.env.PRICE_DECREASE_PERCENT) / 100 || 0.01,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) / 100 || 0.015,
    maxCycles: parseInt(process.env.MAX_CYCLES) || 4,
    leverage: parseInt(process.env.LEVERAGE) || 1,
    
    // Volume Scale Multiplier (like HTX bot)
    volumeScale: parseFloat(process.env.VOLUME_SCALE) || 1.5,
    
    // Server
    port: process.env.PORT || 3000,
    restEndpoint: 'https://api.htx.com'
};

// ==================== MULTIPLIER WITH VOLUME SCALE ====================
// HTX style: Order N = Base × (VolumeScale)^(N)
function calculateMultiplier(cycleIndex) {
    // cycleIndex: 0 = first order, 1 = second, 2 = third, 3 = fourth
    return Math.pow(config.volumeScale, cycleIndex);
}

function calculateOrderAmount(cycleIndex) {
    const multiplier = calculateMultiplier(cycleIndex);
    const totalShares = Array.from({ length: config.maxCycles }, (_, i) => calculateMultiplier(i)).reduce((a, b) => a + b, 0);
    const orderAmount = (multiplier / totalShares) * config.totalInvestment;
    return { multiplier, amount: orderAmount };
}

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    currentCycle: 0,
    orders: [],
    positions: [],
    averageEntryPrice: 0,
    totalPositionSize: 0,
    currentPrice: 0,
    totalPnL: 0,
    unrealizedPnL: 0,
    realizedPnL: 0,
    startTime: null,
    lastUpdate: null,
    status: 'stopped',
    errorMessage: null
};

// ==================== HTX API HELPER ====================
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
        'Accept-Language': 'en-US',
        'AccessKeyId': config.apiKey,
        'SignatureMethod': 'HmacSHA256',
        'SignatureVersion': '2',
        'Timestamp': timestamp,
        'Signature': signature
    };
    
    if (config.passphrase) {
        headers['AccessPassphrase'] = config.passphrase;
    }
    
    try {
        const response = await axios({ method, url, headers, data: data });
        if (response.data.status === 'error') {
            throw new Error(response.data['err-msg'] || 'API Error');
        }
        return response.data;
    } catch (error) {
        console.error(`API Error: ${error.message}`);
        throw error;
    }
}

async function setLeverage() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_swap_leverage';
    const data = {
        contract_code: `${config.symbol}`,
        lever_rate: config.leverage,
        swap_type: 'swap_cross'
    };
    await apiRequest('POST', path, data);
    console.log(`✅ Leverage set to ${config.leverage}x`);
}

async function placeOrder(amount, price = null) {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    
    let volume;
    if (config.symbol.includes('USDT')) {
        volume = amount;
    } else {
        volume = amount / (botState.currentPrice || 50000);
    }
    
    const data = {
        contract_code: `${config.symbol}`,
        volume: volume,
        direction: 'buy',
        offset: 'open',
        lever_rate: config.leverage,
        order_price_type: price ? 'limit' : 'market'
    };
    if (price) data.price = price;
    
    try {
        const response = await apiRequest('POST', path, data);
        if (response.data && response.data.order_id) {
            console.log(`✅ Order placed: ${amount.toFixed(2)} USDT at ${price || 'market price'}`);
            return response.data.order_id;
        }
        throw new Error('Order failed');
    } catch (error) {
        console.error(`❌ Order failed: ${error.message}`);
        return null;
    }
}

async function getPosition() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_position_info';
    const data = {
        contract_code: `${config.symbol}`
    };
    
    try {
        const response = await apiRequest('POST', path, data);
        if (response.data && response.data.length > 0) {
            const position = response.data[0];
            botState.currentPrice = parseFloat(position.last_price);
            botState.averageEntryPrice = parseFloat(position.cost_hold);
            botState.totalPositionSize = parseFloat(position.volume);
            
            if (botState.totalPositionSize > 0) {
                botState.unrealizedPnL = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
            }
            
            botState.lastUpdate = new Date();
            return position;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get position:', error.message);
        return null;
    }
}

async function closePosition() {
    if (botState.totalPositionSize <= 0) {
        console.log('No position to close');
        return false;
    }
    
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    const data = {
        contract_code: `${config.symbol}`,
        volume: Math.abs(botState.totalPositionSize),
        direction: 'sell',
        offset: 'close',
        lever_rate: config.leverage,
        order_price_type: 'market'
    };
    
    try {
        const response = await apiRequest('POST', path, data);
        if (response.data && response.data.order_id) {
            const realizedProfit = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
            botState.realizedPnL += realizedProfit;
            botState.totalPnL = botState.realizedPnL;
            console.log(`✅ Position closed! Profit: ${realizedProfit.toFixed(2)} USDT`);
            this.resetCycle();
            return true;
        }
        throw new Error('Close position failed');
    } catch (error) {
        console.error(`❌ Failed to close position: ${error.message}`);
        return false;
    }
}

function checkTakeProfit() {
    if (botState.totalPositionSize === 0 || botState.averageEntryPrice === 0) {
        return false;
    }
    
    const currentProfitPercent = (botState.currentPrice - botState.averageEntryPrice) / botState.averageEntryPrice;
    
    if (currentProfitPercent >= config.takeProfitPercent) {
        console.log(`🎯 Take profit triggered! Profit: ${(currentProfitPercent * 100).toFixed(2)}%`);
        closePosition();
        return true;
    }
    return false;
}

async function executeMartingaleStep() {
    if (botState.currentCycle >= config.maxCycles) {
        console.log('Max cycles reached, waiting for take profit or manual intervention');
        return;
    }
    
    const { multiplier, amount } = calculateOrderAmount(botState.currentCycle);
    const targetPrice = botState.currentPrice * (1 - config.priceDecreasePercent);
    
    console.log(`\n🔄 Cycle ${botState.currentCycle + 1}/${config.maxCycles}`);
    console.log(`   Multiplier: ${multiplier.toFixed(2)}x`);
    console.log(`   Order amount: ${amount.toFixed(2)} USDT`);
    console.log(`   Target price: ${targetPrice.toFixed(2)}`);
    
    const orderId = await placeOrder(amount, targetPrice);
    
    if (orderId) {
        botState.orders.push({
            id: orderId,
            multiplier: multiplier,
            amount: amount,
            price: targetPrice,
            cycle: botState.currentCycle,
            timestamp: Date.now()
        });
        
        botState.currentCycle++;
        
        setTimeout(async () => {
            await getPosition();
            checkTakeProfit();
        }, 2000);
    }
}

function resetCycle() {
    botState.currentCycle = 0;
    botState.orders = [];
    botState.averageEntryPrice = 0;
    botState.totalPositionSize = 0;
    botState.unrealizedPnL = 0;
    console.log('🔄 Cycle reset, ready for next round');
}

async function startMartingale() {
    if (botState.currentCycle === 0) {
        console.log('\n🚀 Starting initial position...');
        const { amount } = calculateOrderAmount(0);
        await placeOrder(amount, null);
        botState.currentCycle = 1;
        
        setTimeout(async () => {
            await getPosition();
            console.log(`📊 Initial position: ${botState.totalPositionSize} contracts at ${botState.averageEntryPrice}`);
        }, 2000);
    }
    
    botState.isRunning = true;
    botState.status = 'running';
    monitorPrice();
}

let monitoringInterval = null;
let lastPrice = null;

async function monitorPrice() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    
    monitoringInterval = setInterval(async () => {
        if (!botState.isRunning) {
            return;
        }
        
        await getPosition();
        
        // Check for take profit
        const tookProfit = checkTakeProfit();
        if (tookProfit) {
            return;
        }
        
        // Check for price drop to trigger next martingale step
        if (lastPrice && botState.currentPrice && botState.currentCycle < config.maxCycles) {
            const priceDropPercent = (lastPrice - botState.currentPrice) / lastPrice;
            
            if (priceDropPercent >= config.priceDecreasePercent) {
                console.log(`📉 Price dropped ${(priceDropPercent * 100).toFixed(2)}%, triggering martingale step`);
                await executeMartingaleStep();
            }
        }
        
        lastPrice = botState.currentPrice;
    }, 5000);
}

async function initBot() {
    try {
        await setLeverage();
        await getPosition();
        
        if (botState.totalPositionSize === 0) {
            await startMartingale();
        } else {
            console.log('Existing position detected, resuming monitoring');
            botState.isRunning = true;
            botState.status = 'running';
            monitorPrice();
        }
        
        botState.startTime = new Date();
        console.log('Bot initialized successfully');
    } catch (error) {
        botState.status = 'error';
        botState.errorMessage = error.message;
        console.error('Bot initialization failed:', error);
    }
}

function stopBot() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    botState.isRunning = false;
    botState.status = 'stopped';
    console.log('Bot stopped');
}

// ==================== EXPRESS WEB SERVER ====================
const app = express();
app.use(express.json());

// API Routes
app.get('/api/status', (req, res) => {
    // Calculate preview of all orders
    const orderPreview = [];
    for (let i = 0; i < config.maxCycles; i++) {
        const { multiplier, amount } = calculateOrderAmount(i);
        orderPreview.push({
            cycle: i + 1,
            multiplier: multiplier.toFixed(2),
            amount: amount.toFixed(2)
        });
    }
    
    res.json({
        ...botState,
        orderPreview: orderPreview,
        config: {
            symbol: config.symbol,
            totalInvestment: config.totalInvestment,
            priceDecreasePercent: config.priceDecreasePercent * 100,
            takeProfitPercent: config.takeProfitPercent * 100,
            maxCycles: config.maxCycles,
            leverage: config.leverage,
            volumeScale: config.volumeScale
        }
    });
});

app.post('/api/start', async (req, res) => {
    if (botState.status === 'running') {
        return res.json({ success: false, message: 'Bot is already running' });
    }
    try {
        await initBot();
        res.json({ success: true, message: 'Bot started successfully' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/stop', (req, res) => {
    stopBot();
    res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/close-position', async (req, res) => {
    try {
        await closePosition();
        res.json({ success: true, message: 'Position closed' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.get('/api/history', (req, res) => {
    res.json({
        orders: botState.orders,
        totalPnL: botState.totalPnL,
        totalTrades: botState.orders.length
    });
});

// HTML Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Martingale Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; color: white; margin-bottom: 30px; }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .card h3 { color: #333; margin-bottom: 15px; font-size: 1.2em; border-left: 4px solid #667eea; padding-left: 12px; }
        .stat { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
        .stat-label { color: #666; font-weight: 500; }
        .stat-value { color: #333; font-weight: 600; font-family: 'Courier New', monospace; }
        .profit { color: #10b981; }
        .loss { color: #ef4444; }
        .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
        .status-running { background-color: #10b981; }
        .status-stopped { background-color: #6b7280; }
        .status-error { background-color: #ef4444; }
        .button-group { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
        .btn { padding: 10px 20px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-size: 14px; }
        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5a67d8; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-warning { background: #f59e0b; color: white; }
        .btn-warning:hover { background: #d97706; }
        .order-list { max-height: 300px; overflow-y: auto; }
        .order-item { padding: 8px; border-bottom: 1px solid #f0f0f0; font-size: 12px; font-family: 'Courier New', monospace; }
        .multiplier-badge { display: inline-block; background: #667eea; color: white; padding: 2px 8px; border-radius: 20px; font-size: 11px; margin: 2px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 HTX Martingale Bot</h1>
            <p>Volume Scale: <strong id="volumeScale">-</strong>x | Total Investment: $<strong id="totalInvestment">-</strong></p>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>📊 Bot Status</h3>
                <div class="stat">
                    <span class="stat-label">Status</span>
                    <span class="stat-value" id="status">
                        <span class="status-indicator" id="statusIndicator"></span>
                        <span id="statusText">Loading...</span>
                    </span>
                </div>
                <div class="stat">
                    <span class="stat-label">Current Cycle</span>
                    <span class="stat-value" id="currentCycle">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Current Price</span>
                    <span class="stat-value" id="currentPrice">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Position Size</span>
                    <span class="stat-value" id="positionSize">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Avg Entry Price</span>
                    <span class="stat-value" id="avgEntryPrice">-</span>
                </div>
                <div class="button-group">
                    <button class="btn btn-primary" onclick="startBot()">▶ Start Bot</button>
                    <button class="btn btn-danger" onclick="stopBot()">⏹ Stop Bot</button>
                    <button class="btn btn-warning" onclick="closePosition()">🔒 Close Position</button>
                </div>
            </div>
            
            <div class="card">
                <h3>💰 Profit & Loss</h3>
                <div class="stat">
                    <span class="stat-label">Total PnL</span>
                    <span class="stat-value" id="totalPnL">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Realized PnL</span>
                    <span class="stat-value" id="realizedPnL">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Unrealized PnL</span>
                    <span class="stat-value" id="unrealizedPnL">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Active Orders</span>
                    <span class="stat-value" id="activeOrders">-</span>
                </div>
            </div>
            
            <div class="card">
                <h3>⚙️ Order Preview (Volume Scale)</h3>
                <div id="orderPreview" class="order-list"></div>
            </div>
        </div>
        
        <div class="card">
            <h3>📋 Order History</h3>
            <div id="orderHistory" class="order-list">
                <div class="order-item">No orders yet</div>
            </div>
        </div>
    </div>
    
    <script>
        let refreshInterval = null;
        
        async function fetchStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                updateUI(data);
            } catch (error) {
                console.error('Failed to fetch status:', error);
            }
        }
        
        function updateUI(data) {
            // Volume scale display
            document.getElementById('volumeScale').textContent = data.config?.volumeScale || '-';
            document.getElementById('totalInvestment').textContent = data.config?.totalInvestment || '-';
            
            // Status
            const statusText = document.getElementById('statusText');
            const statusIndicator = document.getElementById('statusIndicator');
            statusText.textContent = data.status;
            statusIndicator.className = 'status-indicator status-' + data.status;
            
            document.getElementById('currentCycle').textContent = data.currentCycle + ' / ' + data.config?.maxCycles;
            document.getElementById('currentPrice').textContent = '$' + (data.currentPrice?.toFixed(2) || '-');
            document.getElementById('positionSize').textContent = data.totalPositionSize?.toFixed(4) || '0';
            document.getElementById('avgEntryPrice').textContent = '$' + (data.averageEntryPrice?.toFixed(2) || '-');
            
            // PnL
            const totalPnL = document.getElementById('totalPnL');
            totalPnL.textContent = '$' + (data.totalPnL?.toFixed(2) || '0');
            totalPnL.className = 'stat-value ' + (data.totalPnL >= 0 ? 'profit' : 'loss');
            
            const realizedPnL = document.getElementById('realizedPnL');
            realizedPnL.textContent = '$' + (data.realizedPnL?.toFixed(2) || '0');
            realizedPnL.className = 'stat-value ' + (data.realizedPnL >= 0 ? 'profit' : 'loss');
            
            const unrealizedPnL = document.getElementById('unrealizedPnL');
            unrealizedPnL.textContent = '$' + (data.unrealizedPnL?.toFixed(2) || '0');
            unrealizedPnL.className = 'stat-value ' + (data.unrealizedPnL >= 0 ? 'profit' : 'loss');
            
            document.getElementById('activeOrders').textContent = data.orders?.length || 0;
            
            // Order Preview
            const orderPreview = document.getElementById('orderPreview');
            if (data.orderPreview && data.orderPreview.length > 0) {
                orderPreview.innerHTML = data.orderPreview.map(order => 
                    '<div class="order-item">' +
                    'Cycle ' + order.cycle + ': ' +
                    '<span class="multiplier-badge">' + order.multiplier + 'x</span> → ' +
                    '$' + order.amount +
                    '</div>'
                ).join('');
            } else {
                orderPreview.innerHTML = '<div class="order-item">No preview available</div>';
            }
            
            // Order History
            const orderHistory = document.getElementById('orderHistory');
            if (data.orders && data.orders.length > 0) {
                orderHistory.innerHTML = data.orders.slice().reverse().map(order => 
                    '<div class="order-item">' +
                    'Cycle ' + (order.cycle + 1) + ': ' +
                    '<span class="multiplier-badge">' + order.multiplier.toFixed(2) + 'x</span> → ' +
                    '$' + order.amount.toFixed(2) + ' @ $' + order.price.toFixed(2) +
                    '</div>'
                ).join('');
            } else {
                orderHistory.innerHTML = '<div class="order-item">No orders yet</div>';
            }
        }
        
        async function startBot() {
            try {
                const response = await fetch('/api/start', { method: 'POST' });
                const result = await response.json();
                if (result.success) {
                    showAlert('Bot started successfully', 'success');
                    fetchStatus();
                } else {
                    showAlert('Failed to start: ' + result.message, 'error');
                }
            } catch (error) {
                showAlert('Error: ' + error.message, 'error');
            }
        }
        
        async function stopBot() {
            try {
                const response = await fetch('/api/stop', { method: 'POST' });
                const result = await response.json();
                if (result.success) {
                    showAlert('Bot stopped', 'success');
                    fetchStatus();
                }
            } catch (error) {
                showAlert('Error: ' + error.message, 'error');
            }
        }
        
        async function closePosition() {
            if (confirm('Are you sure you want to close all positions?')) {
                try {
                    const response = await fetch('/api/close-position', { method: 'POST' });
                    const result = await response.json();
                    if (result.success) {
                        showAlert('Position closed', 'success');
                        fetchStatus();
                    } else {
                        showAlert('Failed: ' + result.message, 'error');
                    }
                } catch (error) {
                    showAlert('Error: ' + error.message, 'error');
                }
            }
        }
        
        function showAlert(message, type) {
            const alertDiv = document.createElement('div');
            alertDiv.className = 'alert alert-' + type;
            alertDiv.textContent = message;
            alertDiv.style.position = 'fixed';
            alertDiv.style.top = '20px';
            alertDiv.style.right = '20px';
            alertDiv.style.padding = '12px 20px';
            alertDiv.style.borderRadius = '8px';
            alertDiv.style.backgroundColor = type === 'success' ? '#10b981' : '#ef4444';
            alertDiv.style.color = 'white';
            alertDiv.style.zIndex = '1000';
            document.body.appendChild(alertDiv);
            setTimeout(() => alertDiv.remove(), 3000);
        }
        
        // Auto-refresh every 2 seconds
        fetchStatus();
        refreshInterval = setInterval(fetchStatus, 2000);
    </script>
</body>
</html>
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    stopBot();
    process.exit(0);
});

// ==================== START SERVER ====================
const server = app.listen(config.port, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   HTX Martingale Bot - Web Dashboard  ║
    ╠═══════════════════════════════════════╣
    ║   Server running on port ${config.port}      ║
    ║   Dashboard: http://localhost:${config.port} ║
    ║   Volume Scale: ${config.volumeScale}x                ║
    ╚═══════════════════════════════════════╝
    `);
    
    // Display order preview
    console.log('📊 Order Preview:');
    for (let i = 0; i < config.maxCycles; i++) {
        const { multiplier, amount } = calculateOrderAmount(i);
        console.log(`   Cycle ${i + 1}: ${multiplier.toFixed(2)}x → ${amount.toFixed(2)} USDT`);
    }
    console.log('');
    
    if (process.env.AUTO_START === 'true') {
        setTimeout(() => initBot(), 3000);
    }
});

module.exports = app;
