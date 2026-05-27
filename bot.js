require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    // Use the exact format required by the API
    symbols: ['SHIB-USDT', 'PEPE-USDT', 'BONK-USDT', 'FLOKI-USDT', 'LUNC-USDT', 'XEC-USDT', 'BTTC-USDT', 'HOT-USDT', 'XVG-USDT', 'WIF-USDT']
};

let botState = {
    isRunning: true,
    isTrading: false,
    startTime: Date.now(),
    initialBalance: 0,
    walletBalance: 0,
    displayBalance: 0,
    peakBalance: 0,
    realizedProfit: 0,
    profitPct: 0,
    totalTrades: 0,
    estimates: { hr: 0, day: 0, week: 0, month: 0, dgr: 0 },
    coins: {}
};

config.symbols.forEach((sym, index) => {
    botState.coins[sym] = {
        symbol: sym,
        direction: index % 2 === 0 ? 'buy' : 'sell',
        currentPrice: 0,
        avgPrice: 0,
        roi: 0,
        safetyOrdersFilled: 0,
        maxAffordableSteps: 0,
        distToNext: 0,
        volume: 0,
        baseOrder: 0,
        settings: { priceDrop: 0.1, volumeMult: 1.2, takeProfit: 1.5 }
    };
});

async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        if (res.data.status !== 'ok') {
            console.log(`HTX API Error: ${res.data['err-msg']} for ${path}`);
        }
        return res.data;
    } catch (e) { 
        console.log(`HTX Connection Error: ${e.message}`);
        return null; 
    }
}

function calculateMaxPossibleSteps(balance, leverage, baseOrder, multiplier, price) {
    if (price <= 0 || baseOrder <= 0 || balance <= 0) return 0;
    let totalContracts = 0;
    let currentStepVolume = baseOrder;
    let buyingPower = (balance / config.symbols.length) * leverage;
    let steps = 0;
    while (steps < 50) {
        let stepNotional = currentStepVolume * price * 0.001; // Rough contract size estimate
        if ((totalContracts * price * 0.001) + stepNotional > buyingPower) break;
        totalContracts += currentStepVolume;
        currentStepVolume = Math.floor(currentStepVolume * multiplier);
        steps++;
    }
    return steps;
}

function calculateCurrentStep(totalVol, baseVol, multiplier) {
    if (totalVol <= baseVol) return 0;
    let step = 0; let runningTotal = baseVol; let lastOrder = baseVol;
    while (runningTotal < totalVol && step < 50) {
        step++;
        lastOrder = Math.floor(lastOrder * multiplier);
        runningTotal += lastOrder;
        if (Math.abs(runningTotal - totalVol) / totalVol < 0.1) return step;
    }
    return step;
}

async function syncData() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            if (acc) {
                const equity = parseFloat(acc.margin_balance);
                const unrealized = parseFloat(acc.profit_unreal) || 0;
                const realBalance = equity - unrealized;

                if (botState.initialBalance <= 0) {
                    botState.initialBalance = realBalance;
                    botState.displayBalance = realBalance;
                    botState.peakBalance = realBalance;
                }
                if (realBalance > botState.peakBalance) {
                    botState.displayBalance += (realBalance - botState.peakBalance);
                    botState.peakBalance = realBalance;
                }
                botState.walletBalance = realBalance;
                botState.realizedProfit = botState.displayBalance - botState.initialBalance;
                botState.profitPct = (botState.realizedProfit / botState.initialBalance) * 100;
            }
        }

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { margin_asset: 'USDT' });
        
        for (let sym of config.symbols) {
            const coin = botState.coins[sym];
            const pos = posRes?.data?.find(p => p.contract_code === sym);

            // Dynamically set baseOrder: ensure it's at least 1 contract
            coin.baseOrder = Math.max(1, Math.floor((botState.walletBalance / config.symbols.length) / 2));
            
            if (coin.currentPrice > 0) {
                coin.maxAffordableSteps = calculateMaxPossibleSteps(botState.walletBalance, config.leverage, coin.baseOrder, coin.settings.volumeMult, coin.currentPrice);
            }

            if (pos && parseFloat(pos.volume) > 0) {
                coin.avgPrice = parseFloat(pos.cost_hold);
                coin.roi = parseFloat(pos.profit_rate) * 100;
                coin.volume = parseFloat(pos.volume);
                coin.safetyOrdersFilled = calculateCurrentStep(coin.volume, coin.baseOrder, coin.settings.volumeMult);

                const diff = coin.direction === 'buy' ? (coin.avgPrice - coin.currentPrice) : (coin.currentPrice - coin.avgPrice);
                const currentDrop = (diff / coin.avgPrice) * 100;
                coin.distToNext = Math.max(0, coin.settings.priceDrop - currentDrop);
            } else {
                coin.volume = 0; coin.roi = 0; coin.avgPrice = 0; coin.distToNext = 0; coin.safetyOrdersFilled = 0;
            }
        }
    } catch (e) {
        console.log("Sync Error:", e.message);
    }
}

async function checkTrades() {
    if (!botState.isRunning || botState.isTrading || botState.walletBalance <= 0) return;
    botState.isTrading = true;
    
    for (let sym of config.symbols) {
        const coin = botState.coins[sym];
        if (coin.currentPrice <= 0) continue; // Still waiting for WebSocket price

        try {
            const hasPos = coin.volume > 0;
            const oppDir = coin.direction === 'buy' ? 'sell' : 'buy';

            if (hasPos && coin.roi >= coin.settings.takeProfit) {
                console.log(`TAKING PROFIT on ${sym}`);
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: sym, volume: coin.volume, direction: oppDir, offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
                botState.totalTrades++;
            } else if (hasPos) {
                const diff = coin.direction === 'buy' ? (coin.avgPrice - coin.currentPrice) : (coin.currentPrice - coin.avgPrice);
                const currentDrop = (diff / coin.avgPrice) * 100;
                if (currentDrop >= coin.settings.priceDrop) {
                    const nextVol = Math.max(1, Math.floor(coin.baseOrder * Math.pow(coin.settings.volumeMult, coin.safetyOrdersFilled + 1)));
                    console.log(`ADDING SAFETY ORDER for ${sym}`);
                    await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: sym, volume: nextVol, direction: coin.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                    });
                    botState.totalTrades++;
                }
            } else if (!hasPos && coin.baseOrder > 0) {
                console.log(`OPENING FIRST ORDER for ${sym}`);
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: sym, volume: coin.baseOrder, direction: coin.direction, offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
                botState.totalTrades++;
            }
        } catch (e) {}
    }
    botState.isTrading = false;
}

function startWS() {
    const ws = new WebSocket(config.wsHost);
    
    ws.on('open', () => {
        console.log("WebSocket Connected to HTX");
        config.symbols.forEach(sym => {
            // HTX Linear Swap symbols in WS are usually uppercase, e.g., "BTC-USDT"
            const subData = JSON.stringify({ sub: `market.${sym}.detail`, id: `id_${sym}` });
            ws.send(subData);
        });
    });

    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            
            // Handle Heartbeat
            if (msg.ping) {
                ws.send(JSON.stringify({ pong: msg.ping }));
                return;
            }

            // Extract Price
            const ch = msg.ch; // e.g., "market.LUNC-USDT.detail"
            if (ch) {
                const sym = ch.split('.')[1];
                if (botState.coins[sym] && msg.tick) {
                    botState.coins[sym].currentPrice = parseFloat(msg.tick.close);
                }
            }
        });
    });

    ws.on('error', (e) => console.log("WS Error:", e.message));
    ws.on('close', () => {
        console.log("WebSocket Closed. Reconnecting...");
        setTimeout(startWS, 5000);
    });
}

// Keep your existing UI Route (app.get('/'))
app.get('/', (req, res) => { /* ... exact same UI code as your original post ... */ });

app.get('/api/status', (req, res) => res.json(botState));

app.listen(config.port, () => {
    console.log(`Bot Server running on port ${config.port}`);
    startWS();
    setInterval(syncData, 3000);
    setInterval(checkTrades, 4000);
});
