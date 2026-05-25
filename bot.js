require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    
    totalInvestment: parseFloat(process.env.TOTAL_INVESTMENT) || 100,
    priceDecreasePercent: (parseFloat(process.env.PRICE_DECREASE_PERCENT) || 0.1) / 100,
    takeProfitPercent: (parseFloat(process.env.TAKE_PROFIT_PERCENT) || 0.15) / 100,
    maxSafetyOrders: parseInt(process.env.MAX_SAFETY_ORDERS) || 10,
    leverage: parseInt(process.env.LEVERAGE) || 10,
    volumeScale: parseFloat(process.env.VOLUME_SCALE) || 1.2,
    initialAmount: parseInt(process.env.INITIAL_AMOUNT) || 6000,
    
    port: process.env.PORT || 3000,
    host: 'api.htx.com',
    restEndpoint: 'https://api.htx.com'
};

// ✅ CORRECT V3 PRIVATE LINEAR ENDPOINTS
const API = {
    setLeverage: '/v3/linear-swap-api/v1/swap_cross_switch_lever_rate',
    placeOrder: '/v3/linear-swap-api/v1/swap_cross_order',
    getPosition: '/v3/linear-swap-api/v1/swap_cross_position_info',
    // Market data remains on the public exchange path
    marketDetail: '/linear-swap-ex/market/detail/merged' 
};

// ==================== HTX SIGNATURE V2 (Still used for V3 paths) ====================
function getSignature(method, path, params) {
    const sortedKeys = Object.keys(params).sort();
    const query = sortedKeys.map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    const payload = [method.toUpperCase(), config.host, path, query].join('\n');
    return crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
}

async function apiRequest(method, path, data = {}) {
    // Note: HTX expects UTC time in ISO format without milliseconds
    const timestamp = new Date().toISOString().split('.')[0]; 
    
    const params = {
        AccessKeyId: config.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp
    };

    const signature = getSignature(method, path, params);
    params.Signature = signature;

    const url = `${config.restEndpoint}${path}?${new URLSearchParams(params).toString()}`;

    try {
        const response = await axios({
            method,
            url,
            data: method.toUpperCase() === 'POST' ? data : null,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data.status !== 'ok') {
            throw new Error(`API Error: ${response.data['err-msg'] || JSON.stringify(response.data)}`);
        }
        return response.data;
    } catch (error) {
        const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        console.error(`❌ V3 Error [${path}]:`, errorData);
        throw new Error(errorData);
    }
}

// ==================== BOT STATE ====================
let botState = {
    isRunning: false,
    currentPrice: 0,
    averageEntryPrice: 0,
    totalPositionSize: 0,
    status: 'stopped',
    additionOrders: []
};

// ==================== ACTIONS ====================
async function getMarketPrice() {
    try {
        // Market Detail usually requires lowercase symbol for the query param on some HTX clusters
        const url = `${config.restEndpoint}${API.marketDetail}?symbol=${config.symbol}`;
        const res = await axios.get(url);
        return res.data.tick.close;
    } catch (e) {
        return null;
    }
}

async function startBot() {
    console.log(`\n🚀 STARTING MARTINGALE (V3 PRIVATE): ${config.symbol}`);
    try {
        // 1. Set Leverage
        console.log(`⚙️ [V3] Setting leverage to ${config.leverage}x...`);
        await apiRequest('POST', API.setLeverage, { 
            contract_code: config.symbol, 
            lever_rate: config.leverage 
        });

        // 2. Place Initial Order
        console.log(`🛒 [V3] Placing initial order: ${config.initialAmount} contracts`);
        await apiRequest('POST', API.placeOrder, {
            contract_code: config.symbol,
            volume: config.initialAmount,
            direction: 'buy',
            offset: 'open',
            lever_rate: config.leverage,
            order_price_type: 'opponent' // Market-like fill
        });

        botState.isRunning = true;
        botState.status = 'running';
        console.log("✅ V3 Bot is running!");
    } catch (e) {
        botState.status = 'error';
        console.error("Critical Start Error:", e.message);
    }
}

async function monitor() {
    if (!botState.isRunning) return;

    try {
        const price = await getMarketPrice();
        if (price) botState.currentPrice = price;

        // Update Position via V3
        const posRes = await apiRequest('POST', API.getPosition, { contract_code: config.symbol });
        
        if (posRes.data && posRes.data.length > 0) {
            const pos = posRes.data[0];
            botState.averageEntryPrice = parseFloat(pos.cost_hold);
            botState.totalPositionSize = parseFloat(pos.volume);

            // Take Profit
            const tpPrice = botState.averageEntryPrice * (1 + config.takeProfitPercent);
            if (botState.currentPrice >= tpPrice) {
                console.log(`🎯 TP Hit at ${botState.currentPrice}! Closing via V3...`);
                await apiRequest('POST', API.placeOrder, {
                    contract_code: config.symbol,
                    volume: botState.totalPositionSize,
                    direction: 'sell',
                    offset: 'close',
                    lever_rate: config.leverage,
                    order_price_type: 'opponent'
                });
                botState.additionOrders = [];
                setTimeout(startBot, 10000);
                return;
            }

            // Safety Order
            const nextIdx = botState.additionOrders.length + 1;
            const triggerPrice = botState.averageEntryPrice * (1 - (config.priceDecreasePercent * nextIdx));

            if (botState.currentPrice <= triggerPrice && nextIdx <= config.maxSafetyOrders) {
                const amount = Math.floor(config.initialAmount * Math.pow(config.volumeScale, nextIdx));
                console.log(`📉 V3 Safety Order #${nextIdx} triggered at ${botState.currentPrice}`);
                await apiRequest('POST', API.placeOrder, {
                    contract_code: config.symbol,
                    volume: amount,
                    direction: 'buy',
                    offset: 'open',
                    lever_rate: config.leverage,
                    order_price_type: 'opponent'
                });
                botState.additionOrders.push({ idx: nextIdx, amount });
            }
        }
    } catch (e) {
        console.error("Monitor Loop Error:", e.message);
    }
}

setInterval(monitor, 5000);

// ==================== EXPRESS DASHBOARD ====================
const app = express();
app.get('/', (req, res) => {
    res.send(`
        <body style="background:#0d1117; color:#c9d1d9; font-family: sans-serif; padding: 40px;">
            <h2>HTX V3 Private Linear Bot [${config.symbol}]</h2>
            <div style="background:#161b22; padding:20px; border-radius:8px;">
                <p>Status: <b style="color:${botState.isRunning ? '#238636' : '#f85149'}">${botState.status.toUpperCase()}</b></p>
                <p>Price: <b>${botState.currentPrice}</b></p>
                <p>Avg Entry: <b>${botState.averageEntryPrice}</b></p>
                <p>Size: <b>${botState.totalPositionSize} contracts</b></p>
                <p>Safety Filled: <b>${botState.additionOrders.length} / ${config.maxSafetyOrders}</b></p>
            </div>
            <br>
            <button onclick="fetch('/start',{method:'POST'})" style="padding:10px; background:#238636; color:white; border:0; cursor:pointer;">START</button>
            <button onclick="fetch('/stop',{method:'POST'})" style="padding:10px; background:#da3633; color:white; border:0; cursor:pointer;">STOP</button>
        </body>
    `);
});
app.post('/start', (req, res) => { startBot(); res.sendStatus(200); });
app.post('/stop', (req, res) => { botState.isRunning = false; botState.status = 'stopped'; res.sendStatus(200); });

app.listen(config.port, () => console.log(`🚀 V3 Dashboard: http://localhost:${config.port}`));
