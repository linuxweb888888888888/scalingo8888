require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

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
    
    // Server
    port: process.env.PORT || 3000,
    
    // API Endpoints
    restEndpoint: 'https://api.htx.com',
    wsEndpoint: 'wss://api.htx.com/ws/v1'
};

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
    orderSequence: [],
    status: 'stopped', // stopped, running, error, paused
    errorMessage: null
};

// Generate order sequence (1,1,2,4 pattern)
function generateOrderSequence() {
    const sequence = [1];
    for (let i = 1; i < config.maxCycles; i++) {
        if (i === 1) {
            sequence.push(1);
        } else {
            sequence.push(sequence[i-1] * 2);
        }
    }
    return sequence;
}

botState.orderSequence = generateOrderSequence();

// Calculate order amount for a specific cycle
function calculateOrderAmount(cycleIndex) {
    const ratio = botState.orderSequence[cycleIndex];
    const totalShares = botState.orderSequence.reduce((a, b) => a + b, 0);
    return (ratio / totalShares) * config.totalInvestment;
}

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

// ==================== BOT CORE LOGIC ====================
async function setLeverage() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_swap_leverage';
    const data = {
        contract_code: `${config.symbol}`,
        lever_rate: config.leverage,
        swap_type: 'swap_cross'
    };
    await apiRequest('POST', path, data);
}

async function placeOrder(amount, price = null) {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    const data = {
        contract_code: `${config.symbol}`,
        volume: amount,
        direction: 'buy',
        offset: 'open',
        lever_rate: config.leverage,
        order_price_type: price ? 'limit' : 'market'
    };
    if (price) data.price = price;
    
    const response = await apiRequest('POST', path, data);
    if (response.data && response.data.order_id) {
        return response.data.order_id;
    }
    throw new Error('Order failed');
}

async function getPosition() {
    const path = '/api/v1/contract_linear_swap_api/v1/swap_cross_position_info';
    const data = { contract_code: `${config.symbol}` };
    
    const response = await apiRequest('POST', path, data);
    if (response.data && response.data.length > 0) {
        const position = response.data[0];
        botState.currentPrice = parseFloat(position.last_price);
        botState.averageEntryPrice = parseFloat(position.cost_hold);
        botState.totalPositionSize = parseFloat(position.volume);
        
        // Calculate unrealized PnL
        if (botState.totalPositionSize > 0) {
            botState.unrealizedPnL = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        }
        
        botState.lastUpdate = new Date();
        return position;
    }
    return null;
}

async function closePosition() {
    if (botState.totalPositionSize <= 0) return false;
    
    const path = '/api/v1/contract_linear_swap_api/v1/swap_order';
    const data = {
        contract_code: `${config.symbol}`,
        volume: Math.abs(botState.totalPositionSize),
        direction: 'sell',
        offset: 'close',
        lever_rate: config.leverage,
        order_price_type: 'market'
    };
    
    const response = await apiRequest('POST', path, data);
    if (response.data && response.data.order_id) {
        // Calculate realized PnL
        const realizedProfit = (botState.currentPrice - botState.averageEntryPrice) * botState.totalPositionSize;
        botState.realizedPnL += realizedProfit;
        botState.totalPnL = botState.realizedPnL;
        
        resetCycle();
        return true;
    }
    return false;
}

function checkTakeProfit() {
    if (botState.totalPositionSize === 0 || botState.averageEntryPrice === 0) return false;
    
    const currentProfitPercent = (botState.currentPrice - botState.averageEntryPrice) / botState.averageEntryPrice;
    
    if (currentProfitPercent >= config.takeProfitPercent) {
        closePosition();
        return true;
    }
    return false;
}

async function executeMartingaleStep() {
    if (botState.currentCycle >= config.maxCycles) return;
    
    const orderAmount = calculateOrderAmount(botState.currentCycle);
    const targetPrice = botState.currentPrice * (1 - config.priceDecreasePercent);
    
    const orderId = await placeOrder(orderAmount, targetPrice);
    
    if (orderId) {
        botState.orders.push({
            id: orderId,
            amount: orderAmount,
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
}

async function startMartingale() {
    if (botState.currentCycle === 0) {
        const initialAmount = calculateOrderAmount(0);
        await placeOrder(initialAmount, null);
        botState.currentCycle = 1;
        
        setTimeout(async () => {
            await getPosition();
        }, 2000);
    }
    
    botState.status = 'running';
    monitorPrice();
}

// Price monitoring with polling (WebSocket alternative)
let monitoringInterval = null;
let lastPrice = null;

async function monitorPrice() {
    if (monitoringInterval) clearInterval(monitoringInterval);
    
    monitoringInterval = setInterval(async () => {
        if (botState.status !== 'running') return;
        
        await getPosition();
        
        // Check take profit
        checkTakeProfit();
        
        // Check for price drop to trigger martingale
        if (lastPrice && botState.currentPrice && botState.currentCycle < config.maxCycles) {
            const priceDropPercent = (lastPrice - botState.currentPrice) / lastPrice;
            if (priceDropPercent >= config.priceDecreasePercent) {
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
    botState.status = 'stopped';
    console.log('Bot stopped');
}

// ==================== EXPRESS WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        ...botState,
        config: {
            symbol: config.symbol,
            totalInvestment: config.totalInvestment,
            priceDecreasePercent: config.priceDecreasePercent * 100,
            takeProfitPercent: config.takeProfitPercent * 100,
            maxCycles: config.maxCycles,
            leverage: config.leverage
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

// Serve HTML dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HTX Martingale Bot Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        
        .header p {
            opacity: 0.9;
        }
        
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .card {
            background: white;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }
        
        .card:hover {
            transform: translateY(-2px);
        }
        
        .card h3 {
            color: #333;
            margin-bottom: 15px;
            font-size: 1.2em;
            border-left: 4px solid #667eea;
            padding-left: 12px;
        }
        
        .stat {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #eee;
        }
        
        .stat-label {
            color: #666;
            font-weight: 500;
        }
        
        .stat-value {
            color: #333;
            font-weight: 600;
            font-family: 'Courier New', monospace;
        }
        
        .profit {
            color: #10b981;
        }
        
        .loss {
            color: #ef4444;
        }
        
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 8px;
        }
        
        .status-running { background-color: #10b981; box-shadow: 0 0 5px #10b981; }
        .status-stopped { background-color: #6b7280; }
        .status-error { background-color: #ef4444; }
        .status-paused { background-color: #f59e0b; }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
            flex-wrap: wrap;
        }
        
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 14px;
        }
        
        .btn-primary {
            background: #667eea;
            color: white;
        }
        
        .btn-primary:hover {
            background: #5a67d8;
            transform: translateY(-1px);
        }
        
        .btn-danger {
            background: #ef4444;
            color: white;
        }
        
        .btn-danger:hover {
            background: #dc2626;
        }
        
        .btn-warning {
            background: #f59e0b;
            color: white;
        }
        
        .btn-warning:hover {
            background: #d97706;
        }
        
        .btn-secondary {
            background: #6b7280;
            color: white;
        }
        
        .btn-secondary:hover {
            background: #4b5563;
        }
        
        .order-list {
            max-height: 300px;
            overflow-y: auto;
        }
        
        .order-item {
            padding: 10px;
            border-bottom: 1px solid #f0f0f0;
            font-size: 12px;
            font-family: 'Courier New', monospace;
        }
        
        .order-item:last-child {
            border-bottom: none;
        }
        
        .alert {
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 15px;
        }
        
        .alert-error {
            background: #fee;
            color: #c33;
            border: 1px solid #fcc;
        }
        
        .alert-success {
            background: #efe;
            color: #3a3;
            border: 1px solid #cfc;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .loading {
            animation: pulse 1s ease-in-out infinite;
        }
        
        @media (max-width: 768px) {
            .grid {
                grid-template-columns: 1fr;
            }
            .button-group {
                flex-direction: column;
            }
            .btn {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 HTX Martingale Bot</h1>
            <p>Automated Futures Trading with 1,1,2,4 Position Sizing</p>
        </div>
        
        <div class="grid">
            <!-- Status Card -->
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
            
            <!-- PnL Card -->
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
                    <span class="stat-label">Total Investment</span>
                    <span class="stat-value" id="totalInvestment">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Active Orders</span>
                    <span class="stat-value" id="activeOrders">-</span>
                </div>
            </div>
            
            <!-- Configuration Card -->
            <div class="card">
                <h3>⚙️ Configuration</h3>
                <div class="stat">
                    <span class="stat-label">Trading Pair</span>
                    <span class="stat-value" id="symbol">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Price Decrease %</span>
                    <span class="stat-value" id="priceDecrease">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Take Profit %</span>
                    <span class="stat-value" id="takeProfit">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Max Cycles</span>
                    <span class="stat-value" id="maxCycles">-</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Order Sequence</span>
                    <span class="stat-value" id="orderSequence">-</span>
                </div>
            </div>
        </div>
        
        <!-- Orders Card -->
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
            // Status
            const statusText = document.getElementById('statusText');
            const statusIndicator = document.getElementById('statusIndicator');
            statusText.textContent = data.status;
            statusIndicator.className = 'status-indicator status-' + data.status;
            
            document.getElementById('currentCycle').textContent = data.currentCycle + ' / ' + data.config.maxCycles;
            document.getElementById('currentPrice').textContent = '$' + data.currentPrice?.toFixed(2) || '-';
            document.getElementById('positionSize').textContent = data.totalPositionSize?.toFixed(4) || '0';
            document.getElementById('avgEntryPrice').textContent = '$' + data.averageEntryPrice?.toFixed(2) || '-';
            
            // PnL
            const totalPnL = document.getElementById('totalPnL');
            totalPnL.textContent = '$' + data.totalPnL?.toFixed(2) || '$0';
            totalPnL.className = 'stat-value ' + (data.totalPnL >= 0 ? 'profit' : 'loss');
            
            const realizedPnL = document.getElementById('realizedPnL');
            realizedPnL.textContent = '$' + data.realizedPnL?.toFixed(2) || '$0';
            realizedPnL.className = 'stat-value ' + (data.realizedPnL >= 0 ? 'profit' : 'loss');
            
            const unrealizedPnL = document.getElementById('unrealizedPnL');
            unrealizedPnL.textContent = '$' + data.unrealizedPnL?.toFixed(2) || '$0';
            unrealizedPnL.className = 'stat-value ' + (data.unrealizedPnL >= 0 ? 'profit' : 'loss');
            
            document.getElementById('totalInvestment').textContent = '$' + data.config.totalInvestment;
            document.getElementById('activeOrders').textContent = data.orders?.length || 0;
            
            // Config
            document.getElementById('symbol').textContent = data.config.symbol;
            document.getElementById('priceDecrease').textContent = data.config.priceDecreasePercent + '%';
            document.getElementById('takeProfit').textContent = data.config.takeProfitPercent + '%';
            document.getElementById('maxCycles').textContent = data.config.maxCycles;
            document.getElementById('orderSequence').textContent = data.config.orderSequence?.join(', ') || '-';
            
            // Order History
            const orderHistory = document.getElementById('orderHistory');
            if (data.orders && data.orders.length > 0) {
                orderHistory.innerHTML = data.orders.slice().reverse().map(order => 
                    '<div class="order-item">' +
                    'Cycle ' + order.cycle + ' | ' +
                    'Amount: $' + order.amount.toFixed(2) + ' | ' +
                    'Price: $' + order.price.toFixed(2) + ' | ' +
                    'Time: ' + new Date(order.timestamp).toLocaleTimeString() +
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

// ==================== SCALINGO READINESS CHECK ====================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        botStatus: botState.status,
        timestamp: new Date().toISOString()
    });
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
    ║   Health:    http://localhost:${config.port}/health ║
    ╚═══════════════════════════════════════╝
    `);
    
    // Auto-start bot if configured
    if (process.env.AUTO_START === 'true') {
        setTimeout(() => initBot(), 3000);
    }
});

module.exports = app;
