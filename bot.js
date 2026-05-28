require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const zlib = require('zlib');

const app = express();
app.use(express.json());

// ==================== CONFIGURATION ====================
const apiAccounts = [];
let accountIndex = 1;
while (process.env[`HTX_API_KEY_${accountIndex}`] && process.env[`HTX_SECRET_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}

const config = {
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 2.0,
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 5.0, // Wider SL for hedge
    orderSize: parseFloat(process.env.ORDER_SIZE) || 1,
    hedgeThreshold: parseFloat(process.env.HEDGE_THRESHOLD) || 0.15,
    maxSpreadPct: 0.08 // ❌ Won't open if Bid/Ask gap is wider than this %
};

// ==================== GLOBAL MARKET STATE ====================
let marketData = {
    bid: 0,
    ask: 0,
    mid: 0,
    spread: 0
};

let accountStates = {};
let totalResets = 0;
let isOpeningPositions = false;

config.accounts.forEach((account, idx) => {
    const direction = idx === 0 ? 'buy' : 'sell';
    accountStates[account.accountId] = {
        accountId: account.accountId,
        direction: direction,
        walletBalance: 0,
        initialBalance: 0,
        displayBalance: 0,
        peakBalance: 0,
        avgPrice: 0,
        roi: 0,
        position: { volume: 0 },
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        realizedProfit: 0
    };
});

let botState = { realizedProfit: 0, profitPct: 0, totalResets: 0, lastResetReason: "" };

// ==================== API HANDLER ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { AccessKeyId: account.apiKey, SignatureMethod: 'HmacSHA256', SignatureVersion: '2', Timestamp: timestamp };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ method, url, data: method === 'POST' ? data : null, headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
        return res.data;
    } catch (e) { return { status: 'error', message: e.message }; }
}

// ==================== DATA SYNC & ROI CALC ====================
async function syncAccountData(account, state) {
    try {
        const accRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { margin_asset: 'USDT' });
        if (accRes?.data) {
            const acc = accRes.data.find(a => a.margin_asset === 'USDT');
            const realBalance = parseFloat(acc.margin_balance) - (parseFloat(acc.profit_unreal) || 0);
            if (state.initialBalance <= 0) state.initialBalance = state.peakBalance = state.displayBalance = realBalance;
            if (realBalance > state.peakBalance) {
                state.displayBalance += (realBalance - state.peakBalance);
                state.peakBalance = realBalance;
            }
            state.walletBalance = realBalance;
            state.realizedProfit = state.displayBalance - state.initialBalance;
        }

        const posRes = await htxRequest(account, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { contract_code: config.symbol });
        const pos = posRes?.data?.find(p => parseFloat(p.volume) > 0 && p.direction === state.direction);

        if (pos) {
            state.avgPrice = parseFloat(pos.cost_hold);
            state.position.volume = parseFloat(pos.volume);
            
            // 🎯 BETTER ROI CALCULATION: Compare entry vs MID price to remove Bid/Ask bias
            if (state.direction === 'buy') {
                state.roi = ((marketData.mid - state.avgPrice) / state.avgPrice) * 100 * config.leverage;
            } else {
                state.roi = ((state.avgPrice - marketData.mid) / state.avgPrice) * 100 * config.leverage;
            }
        } else {
            state.position.volume = 0;
            state.roi = 0;
        }
    } catch (e) { console.log("Sync Error:", e.message); }
}

// ==================== ATOMIC TRADING LOGIC ====================

async function openBothPositionsTogether() {
    if (isOpeningPositions || marketData.mid === 0) return;

    const longState = accountStates[config.accounts[0].accountId];
    const shortState = accountStates[config.accounts[1].accountId];

    if (longState.position.volume === 0 && shortState.position.volume === 0) {
        
        // 🛑 SPREAD PROTECTION
        if (marketData.spread > config.maxSpreadPct) {
            console.log(`⏳ Waiting for spread to narrow... Current: ${marketData.spread.toFixed(4)}%`);
            return;
        }

        isOpeningPositions = true;
        console.log(`\n🚀 SPREAD OK (${marketData.spread.toFixed(4)}%). OPENING ATOMICALY...`);

        // Use Promise.all to send both orders in the same event loop tick
        const [res1, res2] = await Promise.all([
            htxRequest(config.accounts[0], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize,
                direction: 'buy', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            }),
            htxRequest(config.accounts[1], 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: config.orderSize,
                direction: 'sell', offset: 'open', lever_rate: config.leverage, order_price_type: 'optimal_5'
            })
        ]);

        if (res1.status === 'ok' && res2.status === 'ok') {
            console.log("✅ Both orders filled.");
            longState.totalTrades++; shortState.totalTrades++;
        }
        
        await new Promise(r => setTimeout(r, 1000));
        isOpeningPositions = false;
    }
}

async function handleSafetyAndProfit() {
    const long = accountStates[config.accounts[0].accountId];
    const short = accountStates[config.accounts[1].accountId];

    // 1. Force Reset if only one side exists (Imbalance)
    if ((long.position.volume > 0) !== (short.position.volume > 0)) {
        console.log("⚠️ Imbalance detected. Force closing...");
        await Promise.all(config.accounts.map(acc => {
            const state = accountStates[acc.accountId];
            return state.position.volume > 0 ? htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, volume: state.position.volume,
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5'
            }) : Promise.resolve();
        }));
        totalResets++;
        return;
    }

    // 2. Hedge Drift Check (If they move too far apart)
    if (long.position.volume > 0 && short.position.volume > 0) {
        const deviation = Math.abs(long.roi + short.roi);
        if (deviation > config.hedgeThreshold) {
            console.log(`🔄 Drift too high (${deviation.toFixed(2)}%). Resetting Hedge...`);
            // Close both simultaneously
            await Promise.all(config.accounts.map(acc => {
                const state = accountStates[acc.accountId];
                return htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                    contract_code: config.symbol, volume: state.position.volume,
                    direction: state.direction === 'buy' ? 'sell' : 'buy', 
                    offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5'
                });
            }));
            totalResets++;
            return;
        }

        // 3. Take Profit Check (Check if combined or individual side hits target)
        // In a perfect hedge, we look for one side to hit TP
        for (const state of [long, short]) {
            if (state.roi >= config.takeProfitPercent) {
                console.log(`🎯 TP Hit on ${state.direction.toUpperCase()}! Closing both...`);
                await Promise.all(config.accounts.map(acc => {
                    const s = accountStates[acc.accountId];
                    return htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                        contract_code: config.symbol, volume: s.position.volume,
                        direction: s.direction === 'buy' ? 'sell' : 'buy', 
                        offset: 'close', lever_rate: config.leverage, order_price_type: 'optimal_5'
                    });
                }));
                state.winningTrades++;
                break;
            }
        }
    }
}

// ==================== WEBSOCKET (BBO FOR REALTIME SPREAD) ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => {
        // Subscribe to Best Bid Offer (BBO) for precise price
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo1' }));
    });

    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) {
                marketData.bid = parseFloat(msg.tick.bid[0]);
                marketData.ask = parseFloat(msg.tick.ask[0]);
                marketData.mid = (marketData.bid + marketData.ask) / 2;
                marketData.spread = ((marketData.ask - marketData.bid) / marketData.mid) * 100;
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== WEB UI ====================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Perfect Hedge Pro</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-black text-gray-200 p-8">
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center bg-gray-900 p-6 rounded-xl border border-gray-800 mb-6">
                <div><h1 class="text-2xl font-bold text-blue-500">🛡️ PERFECT HEDGE</h1><p class="text-xs text-gray-500">Spread Protected | Atomic Execution</p></div>
                <div class="text-right">
                    <div id="price" class="text-3xl font-mono">$0.000000</div>
                    <div id="spread" class="text-xs text-orange-400">Spread: 0.00%</div>
                </div>
            </div>
            <div id="accs" class="grid grid-cols-2 gap-6"></div>
            <div class="mt-6 bg-gray-900 p-4 rounded-lg text-center font-mono text-sm">
                Total Profit: <span id="profit" class="text-green-400">$0.00</span> | Resets: <span id="resets" class="text-red-400">0</span>
            </div>
        </div>
        <script>
            setInterval(async () => {
                const r = await fetch('/api/status'); const d = await r.json();
                document.getElementById('price').innerText = d.mid.toFixed(8);
                document.getElementById('spread').innerText = 'Spread: ' + d.spread.toFixed(4) + '%';
                document.getElementById('resets').innerText = d.totalResets;
                document.getElementById('profit').innerText = '$' + d.totalProfit.toFixed(4);
                let h = '';
                d.accounts.forEach(a => {
                    h += \`<div class="bg-gray-900 p-6 rounded-xl border-t-2 \${a.direction === 'buy' ? 'border-green-500' : 'border-red-500'}">
                        <div class="flex justify-between font-bold mb-2"><span>\${a.direction.toUpperCase()}</span><span class="\${a.roi >= 0 ? 'text-green-400' : 'text-red-400'}">\${a.roi.toFixed(2)}%</span></div>
                        <div class="text-xs text-gray-500">Entry: \${a.avgPrice.toFixed(8)}</div>
                        <div class="text-xs text-gray-500">Size: \${a.position}</div>
                    </div>\`;
                });
                document.getElementById('accs').innerHTML = h;
            }, 1000);
        </script>
    </body></html>`);
});

app.get('/api/status', (req, res) => {
    let totalProfit = 0;
    const accs = Object.values(accountStates).map(s => {
        totalProfit += s.realizedProfit;
        return { direction: s.direction, roi: s.roi, avgPrice: s.avgPrice, position: s.position.volume };
    });
    res.json({ mid: marketData.mid, spread: marketData.spread, totalResets, totalProfit, accounts: accs });
});

// ==================== INIT ====================
async function main() {
    startWS();
    // Wait for price
    while (marketData.mid === 0) { console.log("Waiting for price..."); await new Promise(r => setTimeout(r, 1000)); }
    
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`Bot Running on Port ${config.port}`);
        // Data Sync Loop
        setInterval(async () => {
            for (const acc of config.accounts) await syncAccountData(acc, accountStates[acc.accountId]);
        }, 2000);
        // Trade Logic Loop
        setInterval(async () => {
            await openBothPositionsTogether();
            await handleSafetyAndProfit();
        }, 3000);
    });
}

main();
