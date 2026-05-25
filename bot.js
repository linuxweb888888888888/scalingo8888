require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { URLSearchParams } = require('url');

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    
    totalInvestment: parseFloat(process.env.TOTAL_INVESTMENT) || 100,
    priceDecreasePercent: (parseFloat(process.env.PRICE_DECREASE_PERCENT) || 0.1) / 100,
    takeProfitPercent: (parseFloat(process.env.TAKE_PROFIT_PERCENT) || 0.15) / 100,
    maxSafetyOrders: parseInt(process.env.MAX_SAFETY_ORDERS) || 10,
    leverage: parseInt(process.env.LEVERAGE) || 1,
    volumeScale: parseFloat(process.env.VOLUME_SCALE) || 1.2,
    initialAmount: parseFloat(process.env.INITIAL_AMOUNT) || 10, // Note: In Futures, this is 'Contracts'
    
    port: process.env.PORT || 3000,
    host: 'api.htx.com',
    restEndpoint: 'https://api.htx.com'
};

const API = {
    setLeverage: '/linear-swap-api/v1/swap_cross_swap_leverage',
    placeOrder: '/linear-swap-api/v1/swap_order',
    getPosition: '/linear-swap-api/v1/swap_cross_position_info',
    marketDetail: '/linear-swap-api/market/detail'
};

// ==================== ✅ FIXED HTX SIGNATURE V2 ====================
function signHmac(method, path, params) {
    const sortedParams = Object.keys(params).sort().map(key => 
        `${key}=${encodeURIComponent(params[key])}`
    ).join('&');

    const payload = [
        method.toUpperCase(),
        config.host,
        path,
        sortedParams
    ].join('\n');

    return crypto.createHmac('sha256', config.secretKey)
        .update(payload)
        .digest('base64');
}

async function apiRequest(method, path, data = null) {
    const timestamp = new Date().toISOString().split('.')[0];
    
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };

    const signature = signHmac(method, path, params);
    params.Signature = signature;

    const queryString = new URLSearchParams(params).toString();
    const url = `${config.restEndpoint}${path}?${queryString}`;

    try {
        const response = await axios({
            method,
            url,
            data: data,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.status !== 'ok') {
            throw new Error(JSON.stringify(response.data));
        }
        return response.data;
    } catch (error) {
        const errMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        console.error(`❌ API Error [${path}]:`, errMsg);
        throw new Error(errMsg);
    }
}

// ==================== BOT LOGIC ====================

let botState = {
    isRunning: false,
    currentPrice: 0,
    averageEntryPrice: 0,
    totalPositionSize: 0,
    totalPnL: 0,
    status: 'stopped',
    tpOrder: null,
    additionOrders: [],
    errors: []
};

// SHIB-USDT volume must be an integer (number of contracts)
function calculateOrderAmount(orderIndex) {
    const multiplier = Math.pow(config.volumeScale, orderIndex);
    const amount = Math.floor(config.initialAmount * multiplier); 
    return { amount: amount > 0 ? amount : 1, multiplier: multiplier.toFixed(2) };
}

async function getMarketPrice() {
    try {
        const url = `${config.restEndpoint}${API.marketDetail}?contract_code=${config.symbol}`;
        const res = await axios.get(url);
        return res.data.tick.close;
    } catch (e) { return null; }
}

async function updatePositionState() {
    try {
        const res = await apiRequest('POST', API.getPosition, { contract_code: config.symbol });
        if (res.data && res.data.length > 0) {
            const pos = res.data[0];
            botState.averageEntryPrice = parseFloat(pos.cost_hold);
            botState.totalPositionSize = parseFloat(pos.volume);
            botState.currentPrice = parseFloat(pos.last_price);
        } else {
            botState.totalPositionSize = 0;
        }
    } catch (e) {
        console.error("Error updating position:", e.message);
    }
}

async function startBot() {
    console.log(`🚀 Starting Bot for ${config.symbol}...`);
    try {
        // 1. Set Leverage
        await apiRequest('POST', API.setLeverage, { 
            contract_code: config.symbol, 
            lever_rate: config.leverage 
        });

        // 2. Place Initial Market Buy
        const { amount } = calculateOrderAmount(0);
        await apiRequest('POST', API.placeOrder, {
            contract_code: config.symbol,
            volume: amount,
            direction: 'buy',
            offset: 'open',
            lever_rate: config.leverage,
            order_price_type: 'opponent' // Market order
        });

        botState.isRunning = true;
        botState.status = 'running';
        console.log(`✅ Initial Order Placed: ${amount} contracts`);
    } catch (e) {
        botState.status = 'error';
        console.error("Start Failed:", e.message);
    }
}

// ==================== MONITORING LOOP ====================
async function monitor() {
    if (!botState.isRunning) return;

    await updatePositionState();

    if (botState.totalPositionSize > 0) {
        const tpPrice = botState.averageEntryPrice * (1 + config.takeProfitPercent);
        
        // Take Profit Check
        if (botState.currentPrice >= tpPrice) {
            console.log("🎯 TP Hit! Closing position...");
            await apiRequest('POST', API.placeOrder, {
                contract_code: config.symbol,
                volume: botState.totalPositionSize,
                direction: 'sell',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            botState.additionOrders = [];
            // Restart cycle
            setTimeout(startBot, 5000);
            return;
        }

        // Safety Order Check
        const nextIdx = botState.additionOrders.length + 1;
        const triggerPrice = botState.averageEntryPrice * (1 - (config.priceDecreasePercent * nextIdx));

        if (botState.currentPrice <= triggerPrice && nextIdx <= config.maxSafetyOrders) {
            console.log(`📉 Price drop! Placing Safety Order #${nextIdx}`);
            const { amount } = calculateOrderAmount(nextIdx);
            await apiRequest('POST', API.placeOrder, {
                contract_code: config.symbol,
                volume: amount,
                direction: 'buy',
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'opponent'
            });
            botState.additionOrders.push({ index: nextIdx, amount });
        }
    }
}

setInterval(monitor, 5000);

// ==================== WEB INTERFACE ====================
const app = express();
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#111; color:#fff; font-family:sans-serif; padding:20px;">
            <h1>HTX Martingale Bot: ${config.symbol}</h1>
            <div style="border:1px solid #444; padding:15px;">
                <p>Status: ${botState.status}</p>
                <p>Current Price: ${botState.currentPrice}</p>
                <p>Avg Entry: ${botState.averageEntryPrice}</p>
                <p>Position Size: ${botState.totalPositionSize} contracts</p>
                <p>Safety Orders: ${botState.additionOrders.length} / ${config.maxSafetyOrders}</p>
            </div>
            <br>
            <button onclick="fetch('/start', {method:'POST'})">START</button>
            <button onclick="fetch('/stop', {method:'POST'})">STOP</button>
            <script>
                async function action(path) { await fetch(path, {method:'POST'}); location.reload(); }
            </script>
        </body>
    `);
});

app.post('/start', async (req, res) => {
    await startBot();
    res.sendStatus(200);
});

app.post('/stop', (req, res) => {
    botState.isRunning = false;
    botState.status = 'stopped';
    res.sendStatus(200);
});

app.listen(config.port, () => console.log(`Dashboard: http://localhost:${config.port}`));
