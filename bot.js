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
    leverage: parseInt(process.env.LEVERAGE) || 10,
    port: process.env.PORT || 3000,
    restHost: 'api.hbdm.com',
    wsHost: 'wss://api.hbdm.com/linear-swap-ws',
    accounts: apiAccounts,
    baseVolume: 1, 
    multiplier: 1.2,
    stepDistancePct: 0.1,
    takeProfitPct: 1.0,
    maxStartSpread: 0.1, 
    takerFeeRate: 0.0005, 
    pollInterval: 1000,
    contractMultiplier: 0.001 // SHIB contract multiplier (each contract = 1000 SHIB)
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
        // Exchange-accurate tracking
        totalCost: 0,
        totalClosedPnl: 0,
        avgEntryPrice: 0,
        totalVolume: 0
    };
});

// ==================== EXCHANGE-ACCURATE CALCULATIONS ====================

/**
 * Calculate ROI exactly as exchange does:
 * ROI = (Unrealized P&L / Initial Margin) * 100
 * Initial Margin = (Position Value / Leverage)
 * Position Value = Volume * Contract Multiplier * Entry Price
 */
function calculateExchangeRoi(position, currentPrice) {
    const faceValue = config.contractMultiplier;
    const volume = parseFloat(position.volume);
    const entryPrice = parseFloat(position.cost_open);
    const positionValue = volume * faceValue * entryPrice;
    const initialMargin = positionValue / config.leverage;
    const unrealizedPnl = parseFloat(position.profit);
    
    // Exchange-style ROI calculation
    let roi = 0;
    if (initialMargin > 0) {
        roi = (unrealizedPnl / initialMargin) * 100;
    }
    
    return {
        roi: roi,
        unrealizedPnl: unrealizedPnl,
        positionValue: positionValue,
        initialMargin: initialMargin
    };
}

/**
 * Calculate P&L exactly as exchange does
 */
function calculateRealizedPnl(entryPrice, exitPrice, volume, direction, fees) {
    const faceValue = config.contractMultiplier;
    let rawPnl = 0;
    
    if (direction === 'buy') {
        // Long: (Exit - Entry) * Volume * Multiplier
        rawPnl = (exitPrice - entryPrice) * volume * faceValue;
    } else {
        // Short: (Entry - Exit) * Volume * Multiplier
        rawPnl = (entryPrice - exitPrice) * volume * faceValue;
    }
    
    return rawPnl - fees;
}

// ==================== HTX API CORE ====================
async function htxRequest(account, method, path, data = {}) {
    const timestamp = new Date().toISOString().split('.')[0];
    const params = { 
        AccessKeyId: account.apiKey, 
        SignatureMethod: 'HmacSHA256', 
        SignatureVersion: '2', 
        Timestamp: timestamp 
    };
    const query = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const payload = [method.toUpperCase(), config.restHost, path, query].join('\n');
    const signature = crypto.createHmac('sha256', account.secretKey).update(payload).digest('base64');
    const url = `https://${config.restHost}${path}?${query}&Signature=${encodeURIComponent(signature)}`;
    try {
        const res = await axios({ 
            method, 
            url, 
            data: method === 'POST' ? data : null, 
            headers: { 'Content-Type': 'application/json' }, 
            timeout: 2000 
        });
        return res.data;
    } catch (e) { 
        return { status: 'error' }; 
    }
}

async function fetchPriceRest() {
    try {
        const url = `https://${config.restHost}/linear-swap-ex/market/detail/merged?contract_code=${config.symbol}`;
        const res = await axios.get(url);
        if (res.data?.tick) {
            market.bid = res.data.tick.bid[0];
            market.ask = res.data.tick.ask[0];
            market.spread = ((market.ask - market.bid) / market.bid) * 100;
            market.lastPriceUpdate = Date.now();
        }
    } catch (e) {}
}

async function syncAccount(acc, state) {
    if (state.pendingOrderId) {
        const orderRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order_info', {
            contract_code: config.symbol,
            order_id: state.pendingOrderId
        });
        if (orderRes?.data?.[0]?.status >= 4) {
            state.pendingOrderId = null;
            state.isLocked = false; 
        } else {
            state.lastAction = "Waiting Confirmation";
            return;
        }
    }

    if (state.isLocked) return; 

    const posRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_position_info', { 
        contract_code: config.symbol 
    });
    
    if (posRes?.status === 'ok' && posRes.data) {
        const pos = posRes.data.find(p => p.direction === state.direction);
        if (pos) {
            const currentPrice = state.direction === 'buy' ? market.bid : market.ask;
            state.volume = parseFloat(pos.volume);
            state.entryPrice = parseFloat(pos.cost_open);
            
            // EXCHANGE-ACCURATE ROI CALCULATION
            const exchangeData = calculateExchangeRoi(pos, currentPrice);
            state.roi = exchangeData.roi;
            state.unrealizedUsdt = exchangeData.unrealizedPnl;
            
            if (state.lastStepPrice === 0) state.lastStepPrice = state.entryPrice;
            if (!state.startTime) state.startTime = new Date().toLocaleString();
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
    
    const accRes = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_account_info', { 
        margin_asset: 'USDT' 
    });
    
    if (accRes?.status === 'ok' && accRes.data?.[0]) {
        state.currentEquity = parseFloat(accRes.data[0].margin_balance);
        state.availableMargin = parseFloat(accRes.data[0].withdraw_available);
        if (state.initialEquity === null) state.initialEquity = state.currentEquity;
    }
}

/**
 * Exchange-accurate trade logging with proper P&L calculation
 */
function logTradeExchangeStyle(state, exitPrice, exitTime) {
    const faceValue = config.contractMultiplier;
    const entryNotional = state.volume * state.entryPrice * faceValue;
    const exitNotional = state.volume * exitPrice * faceValue;
    const entryFee = entryNotional * config.takerFeeRate;
    const exitFee = exitNotional * config.takerFeeRate;
    const totalFees = entryFee + exitFee;
    
    // Exchange-accurate realized P&L
    const realizedPnl = calculateRealizedPnl(
        state.entryPrice, 
        exitPrice, 
        state.volume, 
        state.direction, 
        totalFees
    );
    
    // ROI based on initial margin (exchange standard)
    const initialMargin = entryNotional / config.leverage;
    const exchangeRoi = initialMargin > 0 ? (realizedPnl / initialMargin) * 100 : 0;
    
    tradeHistory.unshift({
        symbol: config.symbol.replace('-', '') + 'Perpetual',
        type: (state.direction === 'buy' ? 'BuyCross' : 'SellCross'),
        side: state.direction === 'buy' ? 'LONG' : 'SHORT',
        openTime: state.startTime,
        closeTime: exitTime,
        volume: state.volume,
        entryPrice: state.entryPrice.toFixed(8),
        exitPrice: exitPrice.toFixed(8),
        roi: exchangeRoi.toFixed(4) + '%',
        netPnlUsdt: realizedPnl.toFixed(8),
        status: 'All Closed',
        entryValue: entryNotional.toFixed(4),
        exitValue: exitNotional.toFixed(4),
        fees: totalFees.toFixed(8)
    });
    
    if (tradeHistory.length > 20) tradeHistory.pop();
}

// ==================== WS ENGINE ====================
function startWS() {
    const ws = new WebSocket(config.wsHost);
    ws.on('open', () => ws.send(JSON.stringify({ sub: `market.${config.symbol}.bbo`, id: 'bbo' })));
    ws.on('message', (data) => {
        zlib.gunzip(data, (err, dec) => {
            if (err) return;
            const msg = JSON.parse(dec.toString());
            if (msg.tick) { 
                market.bid = msg.tick.bid[0]; 
                market.ask = msg.tick.ask[0]; 
                market.spread = ((market.ask - market.bid) / market.bid) * 100;
                market.lastPriceUpdate = Date.now();
            }
            if (msg.ping) ws.send(JSON.stringify({ pong: msg.ping }));
        });
    });
    ws.on('close', () => setTimeout(startWS, 5000));
}

// ==================== MARTINGALE LOGIC ====================
async function processMartingale() {
    for (const acc of config.accounts) {
        const state = accountStates[acc.accountId];
        if (state.isLocked || market.bid === 0) continue;
        const currentPrice = state.direction === 'buy' ? market.bid : market.ask;

        if (state.volume === 0) {
            if (market.spread > config.maxStartSpread) {
                state.lastAction = "Wait Spread < 0.1%";
                continue;
            }
            state.isLocked = true;
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: config.baseVolume, 
                direction: state.direction, 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.lastAction = "Opening Position";
            } else {
                state.isLocked = false;
            }
            continue;
        }

        // EXCHANGE-ACCURATE TAKE PROFIT CHECK
        if (state.roi >= config.takeProfitPct) {
            const v = state.volume;
            state.isLocked = true; 
            const exitTime = new Date().toLocaleString();
            logTradeExchangeStyle(state, currentPrice, exitTime);
            
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', { 
                contract_code: config.symbol, 
                volume: v, 
                direction: state.direction === 'buy' ? 'sell' : 'buy', 
                offset: 'close', 
                lever_rate: config.leverage, 
                order_price_type: 'optimal_20' 
            });
            if (res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.volume = 0; 
                state.roi = 0;
                state.lastAction = "Take Profit Closed";
            } else {
                state.isLocked = false;
            }
            continue;
        }

        // Martingale step logic
        let priceMove = state.direction === 'buy' ? 
            ((state.lastStepPrice - currentPrice) / state.lastStepPrice) * 100 : 
            ((currentPrice - state.lastStepPrice) / state.lastStepPrice) * 100;

        if (priceMove >= config.stepDistancePct) {
            state.isLocked = true;
            const nextVol = Math.max(1, Math.ceil((state.lastAddedVolume || config.baseVolume) * config.multiplier));
            const res = await htxRequest(acc, 'POST', '/linear-swap-api/v1/swap_cross_order', {
                contract_code: config.symbol, 
                volume: nextVol, 
                direction: state.direction, 
                offset: 'open', 
                lever_rate: config.leverage, 
                order_price_type: 'opponent'
            });
            if(res?.status === 'ok') {
                state.pendingOrderId = res.data.order_id_str;
                state.step++;
                state.lastStepPrice = currentPrice;
                state.lastAddedVolume = nextVol;
                state.lastAction = `Martingale Step ${state.step}`;
            } else {
                state.isLocked = false;
            }
        }
    }
}

async function backgroundLoop() {
    if (Date.now() - market.lastPriceUpdate > 2000) await fetchPriceRest();
    
    await Promise.all(config.accounts.map(acc => syncAccount(acc, accountStates[acc.accountId])));
    
    // Portfolio tracking
    const s1 = accountStates[1]; 
    const s2 = accountStates[2];
    
    if (s1 && s2) {
        if (market.initialTotalEquity === 0 && s1.initialEquity !== null && s2.initialEquity !== null) {
            market.initialTotalEquity = s1.initialEquity + s2.initialEquity;
        }

        if (market.initialTotalEquity > 0) {
            market.totalNetGain = (s1.currentEquity + s2.currentEquity) - market.initialTotalEquity;
            market.growthPct = (market.totalNetGain / market.initialTotalEquity) * 100;
            
            const elapsedDays = (Date.now() - market.startTime) / (1000 * 60 * 60 * 24);
            market.dgr = elapsedDays > 0 ? (market.growthPct / elapsedDays) : 0;
        }
    }

    if (market.status === 'Active') await processMartingale();
}

// ==================== ENDPOINTS & UI ====================
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
    res.json({status:'ok'});
});

// HTML UI with exchange-style display
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Martingale Pro - Exchange Style</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
        body { background: #0A0E17; color: #E8EDF2; }
        .exchange-card { background: #131824; border: 1px solid #1F2A3E; border-radius: 12px; }
        .stat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6B7A8F; }
        .value-positive { color: #00D1B2; }
        .value-negative { color: #FF4D6D; }
        .badge-long { background: rgba(0, 209, 178, 0.12); color: #00D1B2; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .badge-short { background: rgba(255, 77, 109, 0.12); color: #FF4D6D; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
        .exchange-table { width: 100%; border-collapse: collapse; }
        .exchange-table th { text-align: left; padding: 14px 12px; background: #0F141C; color: #6B7A8F; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; border-bottom: 1px solid #1F2A3E; }
        .exchange-table td { padding: 12px; border-bottom: 1px solid #1A212E; font-size: 13px; }
        .exchange-row:hover { background: #151C28; cursor: pointer; }
        .mono { font-family: 'SF Mono', 'Monaco', monospace; font-size: 12px; }
        .btn-emergency { background: rgba(255, 77, 109, 0.1); border: 1px solid rgba(255, 77, 109, 0.3); transition: all 0.2s; }
        .btn-emergency:hover { background: rgba(255, 77, 109, 0.2); border-color: #FF4D6D; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <div class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
                    MARTINGALE <span class="text-indigo-500">PRO</span>
                </h1>
                <div class="flex items-center gap-3 mt-2">
                    <div class="flex items-center gap-1.5">
                        <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span id="botStatus" class="text-[10px] font-bold text-emerald-400 tracking-wider">LIVE</span>
                    </div>
                    <span class="text-[10px] text-slate-500">${config.symbol}</span>
                    <span class="text-[10px] text-slate-500">${config.leverage}x LEVERAGE</span>
                </div>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-bold text-slate-500 tracking-wider mb-1">TOTAL NET GAIN</p>
                <p id="totalNetGain" class="text-3xl font-black mono">$0.00000000</p>
                <div class="flex gap-3 justify-end mt-1">
                    <p id="growthPct" class="text-[10px] font-bold text-emerald-400">+0.00%</p>
                    <p id="dgrPct" class="text-[10px] font-bold text-indigo-400">DGR: 0.00%/D</p>
                </div>
            </div>
        </div>

        <!-- Stats Grid -->
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
                <p id="lRoi" class="text-2xl font-black value-positive">0.0000%</p>
                <p id="lPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="lStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
            </div>
            <div class="exchange-card p-5">
                <p class="stat-label mb-2">SHORT ACCOUNT</p>
                <p id="sRoi" class="text-2xl font-black value-negative">0.0000%</p>
                <p id="sPnl" class="text-sm mono mt-1">$0.00000000</p>
                <p id="sStep" class="text-[10px] text-slate-500 mt-2">STEP 0 | VOL 0</p>
            </div>
        </div>

        <!-- Exchange Style History Table -->
        <div class="exchange-card overflow-hidden">
            <div class="px-6 py-4 border-b border-[#1F2A3E]">
                <p class="font-bold text-sm">📋 EXCHANGE STYLE HISTORY</p>
                <p class="text-[10px] text-slate-500 mt-0.5">PERPETUAL FUTURES • REAL P&L</p>
            </div>
            <div class="overflow-x-auto">
                <table class="exchange-table">
                    <thead>
                        <tr>
                            <th>CONTRACT</th>
                            <th>SIDE</th>
                            <th>OPEN TIME</th>
                            <th>CLOSE TIME</th>
                            <th>VOLUME</th>
                            <th>ENTRY</th>
                            <th>EXIT</th>
                            <th>ROI</th>
                            <th>NET PNL</th>
                        </tr>
                    </thead>
                    <tbody id="historyBody">
                        <tr>
                            <td colspan="9" class="text-center text-slate-500 py-12">No trade history yet</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Emergency Button -->
        <button onclick="triggerClose()" class="btn-emergency w-full mt-8 py-4 rounded-xl font-bold uppercase tracking-wider text-sm transition-all">
            ⚠ EMERGENCY LIQUIDATION ⚠
        </button>
    </div>

    <script>
        async function triggerClose() { 
            if(confirm("⚠ DANGER: This will close ALL positions immediately. Continue?")) 
                fetch('/api/close', {method:'POST'}); 
        }

        function formatDateTime(timestamp) {
            if (!timestamp) return '--/--/---- --:--:--';
            const d = new Date(timestamp);
            return d.toLocaleString('en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).replace(/[/,]/g, '/').replace(/\//g, '/').replace(/,/, '');
        }

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
                    const long = d.accounts[0];
                    const short = d.accounts[1];
                    
                    const longRoiElem = document.getElementById('lRoi');
                    longRoiElem.innerHTML = (long.roi >= 0 ? '+' : '') + long.roi.toFixed(4) + '%';
                    longRoiElem.className = 'text-2xl font-black ' + (long.roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('lPnl').innerHTML = (long.unrealizedUsdt >= 0 ? '+' : '') + long.unrealizedUsdt.toFixed(8);
                    document.getElementById('lStep').innerHTML = 'STEP ' + long.step + ' | VOL ' + long.volume;
                    
                    const shortRoiElem = document.getElementById('sRoi');
                    shortRoiElem.innerHTML = (short.roi >= 0 ? '+' : '') + short.roi.toFixed(4) + '%';
                    shortRoiElem.className = 'text-2xl font-black ' + (short.roi >= 0 ? 'value-positive' : 'value-negative');
                    
                    document.getElementById('sPnl').innerHTML = (short.unrealizedUsdt >= 0 ? '+' : '') + short.unrealizedUsdt.toFixed(8);
                    document.getElementById('sStep').innerHTML = 'STEP ' + short.step + ' | VOL ' + short.volume;
                }
                
                let html = '';
                if (d.tradeHistory && d.tradeHistory.length > 0) {
                    d.tradeHistory.forEach(h => {
                        const roiValue = parseFloat(h.roi);
                        const pnlValue = parseFloat(h.netPnlUsdt);
                        const side = h.side || (h.type.includes('Buy') ? 'LONG' : 'SHORT');
                        const sideClass = side === 'LONG' ? 'badge-long' : 'badge-short';
                        const roiClass = roiValue >= 0 ? 'value-positive' : 'value-negative';
                        const pnlClass = pnlValue >= 0 ? 'value-positive' : 'value-negative';
                        
                        html += '<tr class="exchange-row">';
                        html += '<td class="font-bold">' + h.symbol + '</td>';
                        html += '<td><span class="' + sideClass + '">' + side + '</span></td>';
                        html += '<td class="mono text-slate-400 text-xs">' + formatDateTime(h.openTime) + '</td>';
                        html += '<td class="mono text-slate-400 text-xs">' + formatDateTime(h.closeTime) + '</td>';
                        html += '<td class="font-mono font-bold">' + h.volume + '</td>';
                        html += '<td class="mono">' + h.entryPrice + '</td>';
                        html += '<td class="mono">' + h.exitPrice + '</td>';
                        html += '<td class="font-bold ' + roiClass + '">' + (roiValue >= 0 ? '+' : '') + h.roi + '</td>';
                        html += '<td class="mono font-bold ' + pnlClass + '">' + (pnlValue >= 0 ? '+' : '') + h.netPnlUsdt + ' USDT</td>';
                        html += '</tr>';
                    });
                } else {
                    html = '<tr><td colspan="9" class="text-center text-slate-500 py-12">No trade history yet</td></tr>';
                }
                document.getElementById('historyBody').innerHTML = html;
                
            } catch(e) { 
                console.error('Update error:', e);
            }
        }, 1000);
    </script>
</body>
</html>`);
});

// ==================== START SERVER ====================
startWS();
setInterval(backgroundLoop, config.pollInterval);
app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ Martingale Pro Engine Started`);
    console.log(`📊 Symbol: ${config.symbol}`);
    console.log(`🎯 Take Profit: ${config.takeProfitPct}%`);
    console.log(`📈 Step Distance: ${config.stepDistancePct}%`);
    console.log(`🔗 WebSocket: ${config.wsHost}`);
    console.log(`🌐 Dashboard: http://localhost:${config.port}`);
});
