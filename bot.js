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
while (process.env[`HTX_API_KEY_${accountIndex}`]) {
    apiAccounts.push({
        apiKey: process.env[`HTX_API_KEY_${accountIndex}`],
        secretKey: process.env[`HTX_SECRET_KEY_${accountIndex}`],
        accountId: accountIndex
    });
    accountIndex++;
}

const config = {
    symbol: (process.env.SYMBOL || 'SHIB-USDT').toUpperCase(),
    leverage: parseInt(process.env.LEVERAGE) || 75,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: parseInt(process.env.BASE_VOLUME) || 1,
    multiplier: 1.2,
    stepDistancePct: 0.2,
    takeProfitPct: 15.0,
    maxStartSpread: 0.1,
    takerFeeRate: 0.0005,
    pollInterval: 1000,
    contractMultiplier: 0.001
};

let market = {
    status: 'Active', bid: 0, ask: 0, spread: 0,
    totalNetGain: 0, growthPct: 0, dgr: 0,
    initialTotalEquity: 0, startTime: Date.now(),
    lastPriceUpdate: 0
};

let tradeHistory = [];
let accountStates = {};

config.accounts.forEach((account, idx) => {
    accountStates[account.accountId] = {
        direction: idx === 0 ? 'buy' : 'sell',
        roi: 0, volume: 0, unrealizedUsdt: 0, entryPrice: 0,
        currentEquity: 0, availableMargin: 0, initialEquity: null,
        isLocked: false,
        pendingOrderId: null,
        lastAction: 'Idle',
        step: 0, lastStepPrice: 0, lastAddedVolume: 0, startTime: null,
        lastRawProfitRate: 0
    };
});

// ==================== HTX API CORE ====================
function getSignature(account, method, path, params = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const allParams = {
        AccessKeyId: account.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp,
        ...params
    };
    
    const sortedParams = Object.keys(allParams).sort().map(key => `${key}=${encodeURIComponent(allParams[key])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, sortedParams].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    
    return { timestamp, signature, sortedParams };
}

async function htxRequest(account, method, path, data = {}) {
    try {
        const { timestamp, signature, sortedParams } = getSignature(account, method, path, method === 'GET' ? data : {});
        const url = `https://${config.restHost}${path}?${sortedParams}&Signature=${encodeURIComponent(signature)}`;
        
        const options = {
            method,
            url,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 5000
        };
        
        if (method === 'POST') {
            options.data = data;
        }
        
        const res = await axios(options);
        return res.data;
    } catch (e) {
        console.error(`API Error: ${e.message}`);
        return { status: 'error', msg: e.message };
    }
}

async function fetchPriceRest() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`;
        const res = await axios.get(url, { timeout: 3000 });
        if (res.data?.tick) {
            market.bid = parseFloat(res.data.tick.bid[0]);
            market.ask = parseFloat(res.data.tick.ask[0]);
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
            market.lastPriceUpdate = Date.now();
        }
    } catch (e) {
        console.error('Price fetch error:', e.message);
    }
}

async function syncAccount(acc, state) {
    try {
        // Check pending orders
        if (state.pendingOrderId) {
            const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
                contract_code: config.symbol,
                order_id: state.pendingOrderId
            });
            if (orderRes?.data?.[0]?.status === 6 || orderRes?.data?.[0]?.status === 7) {
                state.pendingOrderId = null;
                state.isLocked = false;
            } else if (orderRes?.data?.[0]?.status === 4 || orderRes?.data?.[0]?.status === 5) {
                state.pendingOrderId = null;
                state.isLocked = false;
            } else {
                return;
            }
        }

        if (state.isLocked) return;

        // Get position info
        const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', {
            contract_code: config.symbol
        });

        if (posRes?.status === 'ok' && posRes.data) {
            const positions = posRes.data;
            const pos = positions.find(p => p.direction === state.direction);
            
            if (pos && parseFloat(pos.volume) > 0) {
                state.volume = parseFloat(pos.volume);
                state.entryPrice = parseFloat(pos.cost_open);
                
                // CRITICAL FIX: Handle profit_rate correctly
                // HTX returns profit_rate as a percentage already (e.g., 0.0992 = 9.92%)
                // But sometimes it returns as raw decimal, so we need to ensure it's displayed correctly
                let rawProfitRate = parseFloat(pos.profit_rate);
                state.lastRawProfitRate = rawProfitRate;
                
                // If profit_rate > 100, it's likely in basis points or multiplied by 100
                if (Math.abs(rawProfitRate) > 100) {
                    state.roi = rawProfitRate / 100; // Convert to percentage
                } else {
                    state.roi = rawProfitRate; // Already correct percentage
                }
                
                state.unrealizedUsdt = parseFloat(pos.profit);
                
                if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
                if (!state.startTime) state.startTime = new Date().toLocaleString();
                
                // Debug log to see what exchange returns
                console.log(`${state.direction.toUpperCase()} - Raw profit_rate: ${rawProfitRate}, Display ROI: ${state.roi.toFixed(4)}%, PnL: ${state.unrealizedUsdt.toFixed(8)} USDT, Vol: ${state.volume}`);
            } else {
                state.volume = 0;
                state.roi = 0;
                state.unrealizedUsdt = 0;
                state.entryPrice = 0;
                state.step = 0;
                state.lastStepPrice = 0;
                state.startTime = null;
            }
        }

        // Get account balance
        const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', {
            margin_asset: 'USDT'
        });

        if (accRes?.status === 'ok' && accRes.data?.[0]) {
            state.currentEquity = parseFloat(accRes.data[0].margin_balance);
            state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
            if (state.initialEquity === null) state.initialEquity = state.currentEquity;
        }
    } catch (e) {
        console.error(`Sync error for account ${acc.accountId}:`, e.message);
    }
}

function logTradeExchangeStyle(state, exitPrice, exitTime, finalRoi, finalPnl) {
    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: finalRoi.toFixed(2) + '%',
        netPnlUsdt: finalPnl.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    
    ws.on('open', () => {
        console.log('WebSocket connected');
        ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' }));
    });
    
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            try {
                const msg = JSON.parse(dec.toString());
                if (msg.tick) {
                    market.bid = msg.tick.bid[0];
                    market.ask = msg.tick.ask[0];
                    market.spread = ((market.ask - market.bid) / market.bid) * 100;
                    market.lastPriceUpdate = Date.now();
                }
                if (msg.ping) {
                    ws.send(JSON.stringify({ pong: msg.ping }));
                }
            } catch (e) {}
        });
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
    
    ws.on('close', () => {
        console.log('WebSocket disconnected, reconnecting in 5s...');
        setTimeout(startWS, 5000);
    });
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0 || market.ask === 0) continue;
        
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
        
        if (currentPrice === 0) continue;

        // Open initial position
        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread && market.spread > 0) {
                state.lastAction = `Wait Spread (${market.spread.toFixed(2)}%)`;
                continue;
            }
            
            console.log(`Opening ${state.direction} position for account ${acc.accountId} at ${currentPrice}`);
            state.isLocked = true;
            state.lastAction = "Opening Position...";
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: config.baseVolume,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Position Opening";
            } else {
                state.isLocked = false;
                state.lastAction = "Open Failed";
                console.error(`Open order failed:`, res);
            }
            continue;
        }

        // Take profit - Use correctly formatted ROI
        if (state.roi >= config.takeProfitPct) {
            console.log(`Take profit triggered for ${state.direction} - ROI: ${state.roi.toFixed(4)}%`);
            const v = state.volume;
            const finalRoi = state.roi;
            const finalPnl = state.unrealizedUsdt;
            const exitTime = new Date().toLocaleString();
            
            state.isLocked = true;
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: v,
                direction: state.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Take Profit Close";
                logTradeExchangeStyle(state, currentPrice, exitTime, finalRoi, finalPnl);
            } else {
                state.isLocked = false;
                state.lastAction = "TP Failed";
            }
            continue;
        }

        // Martingale step
        let priceMove = 0;
        if (state.direction === 'buy') {
            priceMove = ((state.lastStepPrice - currentPrice) / state.lastStepPrice) * 100;
        } else {
            priceMove = ((currentPrice - state.lastStepPrice) / state.lastStepPrice) * 100;
        }
        
        if (priceMove >= config.stepDistancePct && state.lastStepPrice > 0) {
            console.log(`Martingale step ${state.step + 1} for ${state.direction} - Move: ${priceMove.toFixed(2)}%`);
            state.isLocked = true;
            const nextVol = Math.max(1, Math.ceil((state.lastAddedVolume || config.baseVolume) * config.multiplier));
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: nextVol,
                direction: state.direction,
                offset: 'open',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
            
            if (res?.status === 'ok' && res.data?.order_id_str) {
                state.pendingOrderId = res.data.order_id_str;
                state.step++;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${state.step}`;
            } else {
                state.isLocked = false;
                state.lastAction = "Step Failed";
            }
        }
    }
}

async function backgroundLoop() {
    try {
        if (Date.now() - market.lastPriceUpdate > 3000) {
            await fetchPriceRest();
        }
        
        await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
        
        const s1 = accountStates[1];
        const s2 = accountStates[2];
        
        if (s1 && s2) {
            if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
                market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
                console.log(`Initial Total Equity: ${market.initialTotalEquity.toFixed(4)} USDT`);
            }
            
            if (market.initialTotalEquity > 0) {
                market.totalNetGain = (s1.currentEquity + s2.currentEquity) - market.initialTotalEquity;
                market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
                const elapsedDays = (Date.now() - market.startTime) / (1000 * 60 * 60 * 24);
                market.dgr = elapsedDays > 0 ? (market.growthPct / elapsedDays) : 0;
            }
        }
        
        if (market.status === 'Active') {
            await processMartingale();
        }
    } catch (e) {
        console.error('Background loop error:', e);
    }
}

// ==================== ENDPOINTS ====================
app.get('/api/status', (req, res) => {
    res.json({
        market,
        accounts: Object.values(accountStates),
        tradeHistory
    });
});

app.post('/api/close', async (req, res) => {
    market.status = "LIQUIDATING";
    for (const acc of config.accounts) {
        const s = accountStates[acc.accountId];
        if (s.volume > 0) {
            await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol,
                volume: s.volume,
                direction: s.direction === 'buy' ? 'sell' : 'buy',
                offset: 'close',
                lever_rate: config.leverage,
                order_price_type: 'optimal_20'
            });
        }
    }
    setTimeout(() => market.status = "Active", 5000);
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Direct Exchange Data</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .exchange-card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .badge-long { background: rgba(0, 209, 178, 0.12); color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .badge-short { background: rgba(255, 77, 109, 0.12); color: #FF4D6D; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .exchange-table { width: 100%; border-collapse: collapse; }
        .exchange-table th { text-align: left; padding: 14px 12px; background: #0F141C; color: #6B7A8F; font-size: 11px; font-weight: 700; border-bottom: 1px solid #1F2A3E; }
        .exchange-table td { padding: 12px; border-bottom: 1px solid #1A212E; font-size: 13px; }
        .mono { font-family: 'SF Mono', monospace; font-size: 12px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black">MARTINGALE <span class="text-indigo-500">PRO</span></h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="flex items-center gap-1.5">
                        <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span id="botStatus" class="text-[10px] font-bold text-emerald-400">LIVE</span>
                    </div>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                </div>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-bold text-slate-500 mb-1">TOTAL NET GAIN</p>
                <p id="totalNetGain" class="text-3xl font-black mono">$0.00000000</p>
                <div class="flex gap-3 justify-end mt-1">
                    <p id="growthPct" class="text-[10px] font-bold text-emerald-400">+0.00%</p>
                    <p id="dgrPct" class="text-[10px] font-bold text-indigo-400">DGR: 0.00%/D</p>
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">TARGET TP</p>
                <p class="text-2xl font-black">${config.takeProfitPct}%</p>
                <p class="text-[10px] text-slate-500 mt-1">STEP: ${config.stepDistancePct}%</p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">MARKET SPREAD</p>
                <p id="uiSpread" class="text-2xl font-black">0.000%</p>
                <p class="text-[10px] text-slate-500 mt-1">BID: <span id="bidPrice">0.00000000</span> | ASK: <span id="askPrice">0.00000000</span></p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">LONG ACCOUNT</p>
                <p id="lRoi" class="text-2xl font-black">0.00%</p>
                <p id="lPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="lAction" class="text-[9px] text-indigo-400 mt-1"></p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">SHORT ACCOUNT</p>
                <p id="sRoi" class="text-2xl font-black">0.00%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
                <p id="sAction" class="text-[9px] text-indigo-400 mt-1"></p>
            </div>
        </div>

        <div class="exchange-card overflow-hidden">
            <div class="px-6 py-4 border-b border-[#1F2A3E]">
                <p class="font-bold text-sm">📋 EXCHANGE STYLE HISTORY</p>
                <p class="text-[9px] text-slate-500">Direct from HTX API - Real P&L including fees</p>
            </div>
            <div class="overflow-x-auto">
                <table class="exchange-table">
                    <thead>
                        <tr><th>CONTRACT</th><th>SIDE</th><th>OPEN TIME</th><th>CLOSE TIME</th><th>VOLUME</th><th>ENTRY</th><th>EXIT</th><th>ROI</th><th>NET PNL</th></tr>
                    </thead>
                    <tbody id="historyBody">
                        <tr><td colspan="9" class="text-center text-slate-500 py-12">No closed trades yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <button onclick="triggerClose()" class="w-full mt-8 py-4 rounded-xl bg-red-500/10 border border-red-500/30 font-bold uppercase tracking-wider text-sm hover:bg-red-500/20 transition-all">
            ⚠ EMERGENCY LIQUIDATION ⚠
        </button>
    </div>

    <script>
        async function triggerClose() { if(confirm("Close all positions?")) fetch('/api/close', {method:'POST'}); }
        
        setInterval(async () => {
            try {
                const r = await fetch('/api/status'); 
                const d = await r.json();
                document.getElementById('totalNetGain').innerHTML = (d.market.totalNetGain >= 0 ? '+' : '') + d.market.totalNetGain.toFixed(8);
                document.getElementById('growthPct').innerHTML = (d.market.growthPct >= 0 ? '+' : '') + d.market.growthPct.toFixed(2) + '%';
                document.getElementById('dgrPct').innerHTML = 'DGR: ' + (d.market.dgr >= 0 ? '+' : '') + d.market.dgr.toFixed(2) + '%/D';
                document.getElementById('uiSpread').innerHTML = d.market.spread.toFixed(3) + '%';
                document.getElementById('bidPrice').innerHTML = d.market.bid.toFixed(8);
                document.getElementById('askPrice').innerHTML = d.market.ask.toFixed(8);
                
                if (d.accounts && d.accounts.length >= 2) {
                    const long = d.accounts[0], short = d.accounts[1];
                    
                    const lElem = document.getElementById('lRoi');
                    const longRoi = parseFloat(long.roi);
                    lElem.innerHTML = (longRoi >= 0 ? '+' : '') + longRoi.toFixed(2) + '%';
                    lElem.className = 'text-2xl font-black ' + (longRoi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + long.unrealizedUsdt.toFixed(8);
                    document.getElementById('lStep').innerHTML = 'STEP ' + long.step + ' | VOL ' + long.volume;
                    document.getElementById('lAction').innerHTML = long.lastAction;
                    
                    const sElem = document.getElementById('sRoi');
                    const shortRoi = parseFloat(short.roi);
                    sElem.innerHTML = (shortRoi >= 0 ? '+' : '') + shortRoi.toFixed(2) + '%';
                    sElem.className = 'text-2xl font-black ' + (shortRoi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + short.unrealizedUsdt.toFixed(8);
                    document.getElementById('sStep').innerHTML = 'STEP ' + short.step + ' | VOL ' + short.volume;
                    document.getElementById('sAction').innerHTML = short.lastAction;
                }
                
                let html = '';
                if (d.tradeHistory && d.tradeHistory.length > 0) {
                    d.tradeHistory.forEach(h => {
                        const roiVal = parseFloat(h.roi);
                        html += '<tr class="hover:bg-[#1A212E]">';
                        html += '<td class="font-bold">' + h.symbol + '</td>';
                        html += '<td><span class="' + (h.side === 'LONG' ? 'badge-long' : 'badge-short') + '">' + h.side + '</span></td>';
                        html += '<td class="mono text-xs">' + (h.openTime || '--') + '</td>';
                        html += '<td class="mono text-xs">' + (h.closeTime || '--') + '</td>';
                        html += '<td>' + h.volume + '</td>';
                        html += '<td class="mono">' + h.entryPrice + '</td>';
                        html += '<td class="mono">' + h.exitPrice + '</td>';
                        html += '<td class="font-bold ' + (roiVal >= 0 ? 'value-positive' : 'value-negative') + '">' + (roiVal >= 0 ? '+' : '') + h.roi + '</td>';
                        html += '<td class="mono font-bold ' + (parseFloat(h.netPnlUsdt) >= 0 ? 'value-positive' : 'value-negative') + '">' + (parseFloat(h.netPnlUsdt) >= 0 ? '+' : '') + h.netPnlUsdt + ' USDT</td>';
                        html += '</tr>';
                    });
                } else {
                    html = '<tr><td colspan="9" class="text-center text-slate-500 py-12">No closed trades yet</td></tr>';
                }
                document.getElementById('historyBody').innerHTML = html;
            } catch(e) { console.error(e); }
        }, 1000);
    </script>
</body>
</html>`);
});

// ==================== START ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✅ Martingale Pro Engine Started`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}%`);
    console.log(`📈 Step Distance: ${config.stepDistancePct}%`);
    console.log(`🔧 Leverage: ${config.leverage}x`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}\n`);
});
