require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const config = {
    apiKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    leverage: 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws'
};

// ==================== BOT STATE ====================
let botState = {
    isRunning: true,
    isTrading: false,
    activeSymbol: 'WAITING...', // Will be auto-selected by scanner
    walletBalance: 0.78,        // Starting reference
    realizedProfit: 0,
    roi: 0,
    safetyOrdersFilled: 0,
    currentPrice: 0,
    avgPrice: 0,
    totalTrades: 0,
    affordableCoins: [],        // List of coins sorted by smallest notional
    settings: {
        baseOrder: 1,
        priceDrop: 0.15,        // 0.15% drop for safety orders
        volumeMult: 1.1,
        takeProfit: 1.2         // 1.2% target
    },
    openPosition: { volume: 0, costHold: 0 }
};

// ==================== API HANDLER ====================
async function htxRequest(method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: config.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', config.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return null; }
}

// ==================== MARKET SCANNER (FIND CHEAPEST COINS) ====================
async function scanMarket() {
    try {
        const infoRes = await axios.get(`https://${config.restHost}/linear-swap-api/v1/swap_contract_info`);
        const priceRes = await axios.get(`https://${config.restHost}/linear-swap-ex/market/detail/batch_merged`);

        if (!infoRes.data?.data || !priceRes.data?.ticks) return;

        const contracts = infoRes.data.data;
        const prices = priceRes.data.ticks;

        let list = [];
        contracts.forEach(c => {
            const pData = prices.find(p => p.symbol === c.contract_code);
            if (!pData) return;

            const notionalValue = parseFloat(c.contract_size) * pData.close;
            const marginReq = notionalValue / config.leverage;

            if (marginReq < botState.walletBalance) {
                list.push({
                    symbol: c.contract_code,
                    notional: notionalValue.toFixed(4),
                    cost: marginReq.toFixed(4),
                    price: pData.close
                });
            }
        });

        // Sort: Smallest Notional Value first
        botState.affordableCoins = list.sort((a, b) => a.notional - b.notional).slice(0, 10);

        // If not trading, auto-select the cheapest coin
        if (botState.openPosition.volume === 0 && botState.affordableCoins.length > 0) {
            const cheapest = botState.affordableCoins[0].symbol;
            if (botState.activeSymbol !== cheapest) {
                botState.activeSymbol = cheapest;
                restartWS(); // Change WebSocket to the new coin
            }
        }
    } catch (e) { console.log("Scanner Error"); }
}

// ==================== DATA SYNC ====================
async function syncData() {
    try {
        const accRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            botState.walletBalance = parseFloat(acc.margin_balance);
        }

        if (botState.activeSymbol === 'WAITING...') return;

        const posRes = await htxRequest('POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: botState.activeSymbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === 'buy');

        if (pos) {
            botState.avgPrice = parseFloat(pos.cost_hold);
            botState.roi = parseFloat(pos.profit_rate) * 100;
            botState.openPosition = { volume: parseFloat(pos.volume), costHold: botState.avgPrice };
            // Calculate steps manually based on volume
            botState.safetyOrdersFilled = Math.floor(Math.log(botState.openPosition.volume / botState.settings.baseOrder) / Math.log(botState.settings.volumeMult)) || 0;
        } else {
            botState.openPosition = { volume: 0, costHold: 0 };
            botState.roi = 0;
        }
    } catch (e) {}
}

// ==================== TRADING LOGIC ====================
async function checkTrades() {
    if (!botState.isRunning || botState.isTrading || botState.activeSymbol === 'WAITING...') return;
    botState.isTrading = true;
    try {
        const hasPos = botState.openPosition.volume > 0;

        if (hasPos && botState.roi >= botState.settings.takeProfit) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: botState.activeSymbol, volume: botState.openPosition.volume,
                direction: 'sell', offset: 'close', lever_rate: config.leverage, order_price_type: 'opponent'
            });
            botState.totalTrades++;
        } else if (hasPos) {
            const drop = ((botState.avgPrice - botState.currentPrice) / botState.avgPrice) * 100;
            if (drop >= botState.settings.priceDrop) {
                const nextVol = Math.max(1, Math.ceil(botState.settings.baseOrder * Math.pow(botState.settings.volumeMult, botState.safetyOrdersFilled + 1)));
                await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: botState.activeSymbol, volume: nextVol,
                    direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
                });
            }
        } else if (!hasPos) {
            await htxRequest('POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: botState.activeSymbol, volume: botState.settings.baseOrder,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'opponent'
            });
        }
    } catch (e) {}
    botState.isTrading = false;
}

// ==================== UI ====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Micro-Balance Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body { background: #0f172a; color: white; font-family: sans-serif; }</style>
</head>
<body class="p-8">
    <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-end mb-8">
            <div>
                <h1 class="text-4xl font-black text-emerald-500">MICRO_BOT</h1>
                <p class="text-gray-400">Targeting Smallest Notional Coins | Wallet: $${botState.walletBalance}</p>
            </div>
            <div class="text-right">
                <p class="text-xs text-gray-500 uppercase">Active Symbol</p>
                <p id="sym" class="text-2xl font-bold text-white">${botState.activeSymbol}</p>
            </div>
        </div>

        <div class="grid grid-cols-3 gap-4 mb-8">
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                <p class="text-xs text-gray-400 uppercase">Exchange ROI</p>
                <p id="roi" class="text-3xl font-mono font-bold">0.00%</p>
            </div>
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                <p class="text-xs text-gray-400 uppercase">Safety Steps</p>
                <p id="steps" class="text-3xl font-mono font-bold">0</p>
            </div>
            <div class="bg-slate-800 p-6 rounded-xl border border-slate-700">
                <p class="text-xs text-gray-400 uppercase">Live Price</p>
                <p id="price" class="text-3xl font-mono font-bold text-emerald-400">0.0000</p>
            </div>
        </div>

        <div class="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
            <div class="p-4 bg-slate-700 text-xs font-bold uppercase tracking-widest">Scanner: Affordable Coins (Smallest First)</div>
            <table class="w-full text-left text-sm">
                <thead class="bg-slate-900 text-gray-400">
                    <tr>
                        <th class="p-3">Symbol</th>
                        <th class="p-3">Notional Value</th>
                        <th class="p-3">Margin Cost (10x)</th>
                    </tr>
                </thead>
                <tbody id="coinTable"></tbody>
            </table>
        </div>
    </div>

    <script>
        async function update() {
            const r = await fetch('/api/status');
            const d = await r.json();
            document.getElementById('sym').innerText = d.activeSymbol;
            document.getElementById('roi').innerText = d.roi.toFixed(2) + '%';
            document.getElementById('roi').style.color = d.roi >= 0 ? '#10b981' : '#ef4444';
            document.getElementById('steps').innerText = d.safetyOrdersFilled;
            document.getElementById('price').innerText = d.currentPrice;
            
            const tbody = document.getElementById('coinTable');
            tbody.innerHTML = d.affordableCoins.map(c => \`
                <tr class="border-t border-slate-700 \${c.symbol === d.activeSymbol ? 'bg-emerald-500/10' : ''}">
                    <td class="p-3 font-bold">\${c.symbol}</td>
                    <td class="p-3">$\${c.notional}</td>
                    <td class="p-3 text-emerald-400">$\${c.cost}</td>
                </tr>
            \`).join('');
        }
        setInterval(update, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/status', (req, res) => res.json(botState));

// ==================== WEBSOCKET ====================
let currentWS = null;
function restartWS() {
    if (currentWS) currentWS.close();
    if (botState.activeSymbol === 'WAITING...') return;

    currentWS = new WebSocket(config.wsHost);
    currentWS.on('open', () => {
        currentWS.send(JSON.stringify({ sub: `market.${botState.activeSymbol}.detail`, id: 'p1' }));
    });
    currentWS.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick?.close) botState.currentPrice = parseFloat(msg.tick.close);
            if (msg.ping) currentWS.send(JSON.stringify({ pong: msg.ping }));
        });
    });
}

// ==================== START ====================
app.listen(config.port, async () => {
    console.log(`Bot live on port ${config.port}`);
    await scanMarket(); // Initial scan
    setInterval(scanMarket, 10000);
    setInterval(syncData, 2000);
    setInterval(checkTrades, 3000);
});
