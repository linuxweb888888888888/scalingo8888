const express = require('express');
const axios = require('axios');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

// Configuration
const config = {
    symbol: 'shibusdt',
    interval: '1min',
    limit: 200,
    restHost: 'api.huobi.pro'
};

// Store data
let ohlcv = [];
let indicators = {};
let lastUpdate = null;
let updateInterval = null;

// ============ CUSTOM TECHNICAL INDICATORS ============

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateSMA(data, period) {
    if (data.length < period) return data[data.length - 1];
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = closes.length - period; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change >= 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateMACD(closes) {
    if (closes.length < 35) return { macd: 0, signal: 0, histogram: 0 };
    
    const ema12 = calculateEMA(closes.slice(-26), 12);
    const ema26 = calculateEMA(closes.slice(-26), 26);
    const macdLine = ema12 - ema26;
    
    // Calculate signal line (9-period EMA of MACD)
    const macdHistory = [];
    for (let i = 0; i < closes.length - 26; i++) {
        const e12 = calculateEMA(closes.slice(i, i + 26), 12);
        const e26 = calculateEMA(closes.slice(i, i + 26), 26);
        macdHistory.push(e12 - e26);
    }
    
    const signalLine = calculateEMA(macdHistory, 9);
    const histogram = macdLine - signalLine;
    
    return { macd: macdLine, signal: signalLine, histogram: histogram };
}

function calculateBB(closes, period = 20, stdDev = 2) {
    if (closes.length < period) {
        return { upper: 0, middle: 0, lower: 0 };
    }
    
    const slice = closes.slice(-period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    
    const squaredDiffs = slice.map(price => Math.pow(price - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(variance);
    
    return {
        upper: sma + (stdDev * std),
        middle: sma,
        lower: sma - (stdDev * std)
    };
}

function calculateStochastic(highs, lows, closes, period = 14, smoothK = 3, smoothD = 3) {
    if (highs.length < period) return { k: 50, d: 50 };
    
    const lastHighs = highs.slice(-period);
    const lastLows = lows.slice(-period);
    const lastClose = closes[closes.length - 1];
    
    const highestHigh = Math.max(...lastHighs);
    const lowestLow = Math.min(...lastLows);
    
    const k = ((lastClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    return { k: Math.min(100, Math.max(0, k)), d: k };
}

function calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return 0;
    
    const trValues = [];
    for (let i = highs.length - period; i < highs.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        trValues.push(Math.max(hl, hc, lc));
    }
    
    return trValues.reduce((a, b) => a + b, 0) / period;
}

function calculateMFI(highs, lows, closes, volumes, period = 14) {
    if (highs.length < period + 1) return 50;
    
    let positiveFlow = 0;
    let negativeFlow = 0;
    
    for (let i = highs.length - period; i < highs.length; i++) {
        const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
        const prevTypicalPrice = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
        const rawMoneyFlow = typicalPrice * volumes[i];
        
        if (typicalPrice > prevTypicalPrice) {
            positiveFlow += rawMoneyFlow;
        } else if (typicalPrice < prevTypicalPrice) {
            negativeFlow += rawMoneyFlow;
        }
    }
    
    if (negativeFlow === 0) return 100;
    const moneyRatio = positiveFlow / negativeFlow;
    return 100 - (100 / (1 + moneyRatio));
}

function calculateADX(highs, lows, closes, period = 14) {
    if (highs.length < period * 2) return 20;
    
    const plusDM = [];
    const minusDM = [];
    const tr = [];
    
    for (let i = highs.length - period * 2; i < highs.length; i++) {
        const highDiff = highs[i] - highs[i - 1];
        const lowDiff = lows[i - 1] - lows[i];
        
        plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
        minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
        
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    
    const atr = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
    const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
    const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    
    return isNaN(dx) ? 20 : dx;
}

function calculateCCI(highs, lows, closes, period = 20) {
    if (highs.length < period) return 0;
    
    const tp = [];
    for (let i = highs.length - period; i < highs.length; i++) {
        tp.push((highs[i] + lows[i] + closes[i]) / 3);
    }
    
    const sma = tp.reduce((a, b) => a + b, 0) / period;
    const meanDev = tp.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    
    return (tp[tp.length - 1] - sma) / (0.015 * meanDev);
}

function calculateMomentum(closes, period = 10) {
    if (closes.length < period + 1) return 0;
    return closes[closes.length - 1] - closes[closes.length - 1 - period];
}

function calculateROC(closes, period = 10) {
    if (closes.length < period + 1) return 0;
    return ((closes[closes.length - 1] - closes[closes.length - 1 - period]) / closes[closes.length - 1 - period]) * 100;
}

function calculateOBV(closes, volumes) {
    if (closes.length < 2) return 0;
    
    let obv = 0;
    for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i - 1]) {
            obv += volumes[i];
        } else if (closes[i] < closes[i - 1]) {
            obv -= volumes[i];
        }
    }
    return obv;
}

function calculateVWAP(highs, lows, closes, volumes) {
    let typicalPriceSum = 0;
    let volumeSum = 0;
    
    for (let i = 0; i < highs.length; i++) {
        const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
        typicalPriceSum += typicalPrice * volumes[i];
        volumeSum += volumes[i];
    }
    
    return typicalPriceSum / volumeSum;
}

// ============ CANDLESTICK PATTERNS ============

function detectDoji(open, close, high, low) {
    const bodySize = Math.abs(close - open);
    const totalRange = high - low;
    return bodySize <= totalRange * 0.1;
}

function detectHammer(candle, prevCandle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
    const upperShadow = candle.high - Math.max(candle.open, candle.close);
    const totalRange = candle.high - candle.low;
    
    return lowerShadow > bodySize * 2 && 
           upperShadow < bodySize * 0.5 &&
           candle.close > prevCandle.close;
}

function detectShootingStar(candle, prevCandle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const upperShadow = candle.high - Math.max(candle.open, candle.close);
    const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
    
    return upperShadow > bodySize * 2 && 
           lowerShadow < bodySize * 0.5 &&
           candle.close < prevCandle.close;
}

function detectEngulfing(candle, prevCandle) {
    const isBullish = candle.close > candle.open && 
                      prevCandle.close < prevCandle.open &&
                      candle.open < prevCandle.close &&
                      candle.close > prevCandle.open;
    
    const isBearish = candle.close < candle.open && 
                      prevCandle.close > prevCandle.open &&
                      candle.open > prevCandle.close &&
                      candle.close < prevCandle.open;
    
    return { bullish: isBullish, bearish: isBearish };
}

function detectMorningStar(candles, idx) {
    if (idx < 2) return false;
    const c1 = candles[idx - 2];
    const c2 = candles[idx - 1];
    const c3 = candles[idx];
    
    return c1.close < c1.open && // First bearish
           Math.abs(c2.close - c2.open) < (c2.high - c2.low) * 0.3 && // Doji/small body
           c3.close > c3.open && // Third bullish
           c3.close > (c1.open + c1.close) / 2;
}

function detectEveningStar(candles, idx) {
    if (idx < 2) return false;
    const c1 = candles[idx - 2];
    const c2 = candles[idx - 1];
    const c3 = candles[idx];
    
    return c1.close > c1.open && // First bullish
           Math.abs(c2.close - c2.open) < (c2.high - c2.low) * 0.3 && // Doji/small body
           c3.close < c3.open && // Third bearish
           c3.close < (c1.open + c1.close) / 2;
}

function detectThreeWhiteSoldiers(candles, idx) {
    if (idx < 2) return false;
    const c1 = candles[idx - 2];
    const c2 = candles[idx - 1];
    const c3 = candles[idx];
    
    return c1.close > c1.open &&
           c2.close > c2.open &&
           c3.close > c3.open &&
           c2.close > c1.close &&
           c3.close > c2.close;
}

function detectThreeBlackCrows(candles, idx) {
    if (idx < 2) return false;
    const c1 = candles[idx - 2];
    const c2 = candles[idx - 1];
    const c3 = candles[idx];
    
    return c1.close < c1.open &&
           c2.close < c2.open &&
           c3.close < c3.open &&
           c2.close < c1.close &&
           c3.close < c2.close;
}

function detectHarami(candle, prevCandle) {
    const isBullish = prevCandle.close < prevCandle.open && // Previous bearish
                      candle.close > candle.open && // Current bullish
                      candle.open > prevCandle.close &&
                      candle.close < prevCandle.open;
    
    const isBearish = prevCandle.close > prevCandle.open && // Previous bullish
                      candle.close < candle.open && // Current bearish
                      candle.open < prevCandle.close &&
                      candle.close > prevCandle.open;
    
    return { bullish: isBullish, bearish: isBearish };
}

// ============ FETCH DATA ============

async function fetchOHLCV() {
    try {
        const url = `https://${config.restHost}/market/history/kline?symbol=${config.symbol}&period=${config.interval}&size=${config.limit}`;
        const response = await axios.get(url, { timeout: 10000 });
        
        if (response.data && response.data.data) {
            ohlcv = response.data.data.map(k => ({
                time: k.id * 1000,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.vol)
            }));
            
            console.log(`✅ Fetched ${ohlcv.length} candles for SHIB/USDT`);
            return true;
        }
    } catch (error) {
        console.error('Error fetching OHLCV:', error.message);
    }
    return false;
}

// ============ CALCULATE ALL INDICATORS ============

function calculateAllIndicators() {
    if (ohlcv.length < 50) return null;
    
    const highs = ohlcv.map(c => c.high);
    const lows = ohlcv.map(c => c.low);
    const closes = ohlcv.map(c => c.close);
    const opens = ohlcv.map(c => c.open);
    const volumes = ohlcv.map(c => c.volume);
    
    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = currentPrice - prevPrice;
    const priceChangePercent = (priceChange / prevPrice) * 100;
    
    // Calculate all indicators
    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes);
    const bb = calculateBB(closes, 20, 2);
    const stoch = calculateStochastic(highs, lows, closes, 14, 3, 3);
    const atr = calculateATR(highs, lows, closes, 14);
    const mfi = calculateMFI(highs, lows, closes, volumes, 14);
    const adx = calculateADX(highs, lows, closes, 14);
    const cci = calculateCCI(highs, lows, closes, 20);
    const momentum = calculateMomentum(closes, 10);
    const roc = calculateROC(closes, 10);
    const obv = calculateOBV(closes, volumes);
    const vwap = calculateVWAP(highs, lows, closes, volumes);
    const ema9 = calculateEMA(closes, 9);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    
    // Detect patterns
    const lastCandle = ohlcv[ohlcv.length - 1];
    const prevCandle = ohlcv[ohlcv.length - 2];
    const prev2Candle = ohlcv[ohlcv.length - 3];
    
    const patterns = {
        doji: detectDoji(lastCandle.open, lastCandle.close, lastCandle.high, lastCandle.low),
        hammer: detectHammer(lastCandle, prevCandle),
        shootingStar: detectShootingStar(lastCandle, prevCandle),
        engulfing: detectEngulfing(lastCandle, prevCandle),
        harami: detectHarami(lastCandle, prevCandle),
        morningStar: detectMorningStar(ohlcv, ohlcv.length - 1),
        eveningStar: detectEveningStar(ohlcv, ohlcv.length - 1),
        threeWhiteSoldiers: detectThreeWhiteSoldiers(ohlcv, ohlcv.length - 1),
        threeBlackCrows: detectThreeBlackCrows(ohlcv, ohlcv.length - 1)
    };
    
    // Trend detection
    let trend = 'NEUTRAL';
    if (ema20 > ema50 && rsi > 50 && macd.histogram > 0) trend = 'BULLISH';
    else if (ema20 < ema50 && rsi < 50 && macd.histogram < 0) trend = 'BEARISH';
    
    // Overall signal
    let signal = 'NEUTRAL';
    let signalStrength = 0;
    
    if (rsi < 30) { signal = 'BUY'; signalStrength += 2; }
    if (rsi > 70) { signal = 'SELL'; signalStrength += 2; }
    if (macd.histogram > 0 && macd.macd > macd.signal) { signal = 'BUY'; signalStrength += 1.5; }
    if (macd.histogram < 0 && macd.macd < macd.signal) { signal = 'SELL'; signalStrength += 1.5; }
    if (currentPrice < bb.lower) { signal = 'BUY'; signalStrength += 1; }
    if (currentPrice > bb.upper) { signal = 'SELL'; signalStrength += 1; }
    if (stoch.k < 20) { signal = 'BUY'; signalStrength += 1; }
    if (stoch.k > 80) { signal = 'SELL'; signalStrength += 1; }
    if (patterns.hammer) { signal = 'BUY'; signalStrength += 2; }
    if (patterns.shootingStar) { signal = 'SELL'; signalStrength += 2; }
    if (patterns.engulfing.bullish) { signal = 'BUY'; signalStrength += 2.5; }
    if (patterns.engulfing.bearish) { signal = 'SELL'; signalStrength += 2.5; }
    
    return {
        timestamp: Date.now(),
        currentPrice,
        priceChange,
        priceChangePercent,
        volume: volumes[volumes.length - 1],
        indicators: {
            // Momentum
            rsi: { value: rsi, status: rsi > 70 ? 'OVERBOUGHT' : (rsi < 30 ? 'OVERSOLD' : 'NEUTRAL') },
            stochK: { value: stoch.k, status: stoch.k > 80 ? 'OVERBOUGHT' : (stoch.k < 20 ? 'OVERSOLD' : 'NEUTRAL') },
            stochD: stoch.d,
            willr: -((bb.upper - currentPrice) / (bb.upper - bb.lower)) * 100,
            cci: cci,
            mfi: { value: mfi, status: mfi > 80 ? 'OVERBOUGHT' : (mfi < 20 ? 'OVERSOLD' : 'NEUTRAL') },
            momentum: momentum,
            roc: roc,
            
            // Trend
            macd: macd,
            adx: { value: adx, strength: adx > 25 ? 'STRONG' : (adx > 20 ? 'MODERATE' : 'WEAK') },
            ema9: ema9,
            ema20: ema20,
            ema50: ema50,
            sma20: sma20,
            sma50: sma50,
            trend: trend,
            
            // Volatility
            bb: bb,
            atr: atr,
            atrPercent: (atr / currentPrice) * 100,
            
            // Volume
            obv: obv,
            vwap: vwap,
            volumeRatio: volumes[volumes.length - 1] / calculateSMA(volumes, 20),
            
            // Overall
            signal: signal,
            signalStrength: signalStrength
        },
        patterns: patterns,
        recentCandles: ohlcv.slice(-10)
    };
}

// ============ WEBSOCKET REAL-TIME UPDATES ============

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

async function updateData() {
    const success = await fetchOHLCV();
    if (success) {
        const data = calculateAllIndicators();
        if (data) {
            indicators = data;
            lastUpdate = new Date();
            io.emit('indicators', indicators);
            console.log(`📊 Data updated: $${data.currentPrice.toFixed(8)} | RSI: ${data.indicators.rsi.value.toFixed(1)} | Signal: ${data.indicators.signal}`);
        }
    }
}

// ============ EXPRESS ROUTES ============

app.use(express.static('public'));

app.get('/api/indicators', (req, res) => {
    if (indicators) {
        res.json(indicators);
    } else {
        res.json({ error: 'No data yet', message: 'Waiting for first data fetch...' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        lastUpdate: lastUpdate,
        candlesCount: ohlcv.length,
        symbol: config.symbol,
        interval: config.interval
    });
});

// ============ HTML DASHBOARD ============

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SHIB/USDT - Real-Time Technical Analysis Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { font-family: 'Courier New', monospace; }
        body { background: #0a0a0a; color: #00ff00; }
        .signal-bullish { background: #00ff0020; border-left: 4px solid #00ff00; }
        .signal-bearish { background: #ff000020; border-left: 4px solid #ff0000; }
        .signal-neutral { background: #ffff0020; border-left: 4px solid #ffff00; }
        .indicator-card { background: #111; border: 1px solid #333; border-radius: 8px; padding: 15px; margin: 10px 0; }
        .badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: bold; }
        .badge-bullish { background: #00ff00; color: #000; }
        .badge-bearish { background: #ff0000; color: #fff; }
        .badge-neutral { background: #ffff00; color: #000; }
        .value-up { color: #00ff00; }
        .value-down { color: #ff4444; }
        .stat-number { font-size: 24px; font-weight: bold; }
        .pattern-active { animation: pulse 1s infinite; background: #00ff0010; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 15px; }
    </style>
</head>
<body class="p-6">
    <div class="max-w-7xl mx-auto">
        <!-- Header -->
        <div class="text-center mb-8">
            <h1 class="text-4xl font-bold">🐕 SHIB/USDT</h1>
            <p class="text-sm text-gray-500">Real-Time TA-Lib Technical Analysis | Live Updates via WebSocket</p>
            <div class="flex justify-center gap-4 mt-3">
                <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span id="status" class="text-xs text-green-500">● LIVE</span>
                <span id="lastUpdate" class="text-xs text-gray-500">Waiting for data...</span>
            </div>
        </div>

        <!-- Current Price -->
        <div class="indicator-card text-center bg-gradient-to-r from-green-900/20 to-transparent">
            <div class="text-sm text-gray-400">SHIB / USDT</div>
            <div class="stat-number" id="currentPrice">$0.00000000</div>
            <div id="priceChange" class="text-sm"></div>
            <div id="signal" class="mt-2"></div>
        </div>

        <!-- Main Grid -->
        <div class="grid-3">
            
            <!-- Momentum Oscillators -->
            <div class="indicator-card">
                <h3 class="text-lg font-bold mb-3">📊 MOMENTUM OSCILLATORS</h3>
                <div class="space-y-2">
                    <div class="flex justify-between">
                        <span>RSI (14):</span>
                        <span id="rsi" class="font-bold">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Stochastic (14,3,3):</span>
                        <span id="stoch">-- / --</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Williams %R:</span>
                        <span id="willr">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>CCI (20):</span>
                        <span id="cci">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>MFI (14):</span>
                        <span id="mfi">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Momentum (10):</span>
                        <span id="momentum">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>ROC (10):</span>
                        <span id="roc">--%</span>
                    </div>
                </div>
            </div>

            <!-- Trend Indicators -->
            <div class="indicator-card">
                <h3 class="text-lg font-bold mb-3">📈 TREND INDICATORS</h3>
                <div class="space-y-2">
                    <div class="flex justify-between">
                        <span>MACD:</span>
                        <span id="macd">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Signal Line:</span>
                        <span id="signalLine">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Histogram:</span>
                        <span id="histogram">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>ADX:</span>
                        <span id="adx">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>EMA 20:</span>
                        <span id="ema20">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>EMA 50:</span>
                        <span id="ema50">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Overall Trend:</span>
                        <span id="trend">--</span>
                    </div>
                </div>
            </div>

            <!-- Volatility & Volume -->
            <div class="indicator-card">
                <h3 class="text-lg font-bold mb-3">📉 VOLATILITY & VOLUME</h3>
                <div class="space-y-2">
                    <div class="flex justify-between">
                        <span>BB Upper:</span>
                        <span id="bbUpper">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>BB Middle:</span>
                        <span id="bbMiddle">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>BB Lower:</span>
                        <span id="bbLower">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>ATR:</span>
                        <span id="atr">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>ATR %:</span>
                        <span id="atrPercent">--%</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Volume:</span>
                        <span id="volume">--</span>
                    </div>
                    <div class="flex justify-between">
                        <span>Volume Ratio:</span>
                        <span id="volumeRatio">--x</span>
                    </div>
                    <div class="flex justify-between">
                        <span>VWAP:</span>
                        <span id="vwap">--</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Candlestick Patterns -->
        <div class="indicator-card mt-4">
            <h3 class="text-lg font-bold mb-3">🕯️ CANDLESTICK PATTERNS DETECTED</h3>
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3" id="patterns">
                <div class="text-center p-2">Loading...</div>
            </div>
        </div>

        <!-- Trading Signal -->
        <div class="indicator-card mt-4" id="signalCard">
            <h3 class="text-lg font-bold mb-3">🎯 TRADING SIGNAL</h3>
            <div id="tradingSignal" class="text-center p-4 rounded-lg">
                Waiting for data...
            </div>
        </div>

        <!-- Recent Candles -->
        <div class="indicator-card mt-4">
            <h3 class="text-lg font-bold mb-3">📋 RECENT CANDLES (Last 10)</h3>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead>
                        <tr class="text-gray-400">
                            <th class="text-left p-2">Time</th>
                            <th class="text-right p-2">Open</th>
                            <th class="text-right p-2">High</th>
                            <th class="text-right p-2">Low</th>
                            <th class="text-right p-2">Close</th>
                            <th class="text-right p-2">Volume</th>
                        </tr>
                    </thead>
                    <tbody id="recentCandles"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        
        function formatNumber(num, decimals = 8) {
            if (num === undefined || num === null) return '--';
            return num.toFixed(decimals);
        }
        
        function formatPrice(num) {
            if (num === undefined || num === null) return '--';
            return '$' + num.toFixed(8);
        }
        
        function formatVolume(num) {
            if (num === undefined || num === null) return '--';
            if (num > 1000000) return (num / 1000000).toFixed(2) + 'M';
            if (num > 1000) return (num / 1000).toFixed(2) + 'K';
            return num.toFixed(0);
        }
        
        function getBadgeClass(value, thresholds) {
            if (value > thresholds.overbought) return 'badge-bearish';
            if (value < thresholds.oversold) return 'badge-bullish';
            return 'badge-neutral';
        }
        
        socket.on('indicators', (data) => {
            // Update price
            document.getElementById('currentPrice').innerHTML = formatPrice(data.currentPrice);
            const change = data.priceChange;
            const changePercent = data.priceChangePercent;
            const changeEl = document.getElementById('priceChange');
            changeEl.innerHTML = \`\${change >= 0 ? '▲' : '▼'} \${Math.abs(change).toFixed(8)} (\${changePercent >= 0 ? '+' : ''}\${changePercent.toFixed(2)}%)\`;
            changeEl.className = 'text-sm ' + (change >= 0 ? 'value-up' : 'value-down');
            
            // Momentum
            document.getElementById('rsi').innerHTML = data.indicators.rsi.value.toFixed(1);
            document.getElementById('stoch').innerHTML = data.indicators.stochK.value.toFixed(1) + ' / ' + data.indicators.stochD.toFixed(1);
            document.getElementById('willr').innerHTML = data.indicators.willr.toFixed(1);
            document.getElementById('cci').innerHTML = data.indicators.cci.toFixed(1);
            document.getElementById('mfi').innerHTML = data.indicators.mfi.value.toFixed(1);
            document.getElementById('momentum').innerHTML = data.indicators.momentum.toFixed(8);
            document.getElementById('roc').innerHTML = data.indicators.roc.toFixed(2) + '%';
            
            // Trend
            document.getElementById('macd').innerHTML = data.indicators.macd.macd.toFixed(8);
            document.getElementById('signalLine').innerHTML = data.indicators.macd.signal.toFixed(8);
            document.getElementById('histogram').innerHTML = data.indicators.macd.histogram.toFixed(8);
            document.getElementById('adx').innerHTML = data.indicators.adx.value.toFixed(1) + ' (' + data.indicators.adx.strength + ')';
            document.getElementById('ema20').innerHTML = formatPrice(data.indicators.ema20);
            document.getElementById('ema50').innerHTML = formatPrice(data.indicators.ema50);
            
            const trendEl = document.getElementById('trend');
            trendEl.innerHTML = data.indicators.trend;
            trendEl.className = data.indicators.trend === 'BULLISH' ? 'value-up' : (data.indicators.trend === 'BEARISH' ? 'value-down' : 'text-yellow-500');
            
            // Volatility
            document.getElementById('bbUpper').innerHTML = formatPrice(data.indicators.bb.upper);
            document.getElementById('bbMiddle').innerHTML = formatPrice(data.indicators.bb.middle);
            document.getElementById('bbLower').innerHTML = formatPrice(data.indicators.bb.lower);
            document.getElementById('atr').innerHTML = formatPrice(data.indicators.atr);
            document.getElementById('atrPercent').innerHTML = data.indicators.atrPercent.toFixed(2) + '%';
            document.getElementById('volume').innerHTML = formatVolume(data.volume);
            document.getElementById('volumeRatio').innerHTML = data.indicators.volumeRatio.toFixed(2) + 'x';
            document.getElementById('vwap').innerHTML = formatPrice(data.indicators.vwap);
            
            // Patterns
            const patternsHtml = \`
                <div class="text-center p-2 rounded \${data.patterns.doji ? 'pattern-active' : ''}">
                    <div>📌 Doji</div>
                    <div class="text-xs text-gray-500">\${data.patterns.doji ? '✓ DETECTED' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.hammer ? 'pattern-active' : ''}">
                    <div>🔨 Hammer</div>
                    <div class="text-xs text-gray-500">\${data.patterns.hammer ? '✓ BULLISH' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.shootingStar ? 'pattern-active' : ''}">
                    <div>⭐ Shooting Star</div>
                    <div class="text-xs text-gray-500">\${data.patterns.shootingStar ? '✓ BEARISH' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.engulfing.bullish || data.patterns.engulfing.bearish ? 'pattern-active' : ''}">
                    <div>🔄 Engulfing</div>
                    <div class="text-xs text-gray-500">\${data.patterns.engulfing.bullish ? '✓ BULLISH' : (data.patterns.engulfing.bearish ? '✓ BEARISH' : '—')}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.morningStar ? 'pattern-active' : ''}">
                    <div>🌅 Morning Star</div>
                    <div class="text-xs text-gray-500">\${data.patterns.morningStar ? '✓ BULLISH' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.eveningStar ? 'pattern-active' : ''}">
                    <div>🌙 Evening Star</div>
                    <div class="text-xs text-gray-500">\${data.patterns.eveningStar ? '✓ BEARISH' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.threeWhiteSoldiers ? 'pattern-active' : ''}">
                    <div>⚔️ 3 White Soldiers</div>
                    <div class="text-xs text-gray-500">\${data.patterns.threeWhiteSoldiers ? '✓ BULLISH' : '—'}</div>
                </div>
                <div class="text-center p-2 rounded \${data.patterns.threeBlackCrows ? 'pattern-active' : ''}">
                    <div>🐦‍⬛ 3 Black Crows</div>
                    <div class="text-xs text-gray-500">\${data.patterns.threeBlackCrows ? '✓ BEARISH' : '—'}</div>
                </div>
            \`;
            document.getElementById('patterns').innerHTML = patternsHtml;
            
            // Trading Signal
            const signal = data.indicators.signal;
            const strength = data.indicators.signalStrength;
            const signalCard = document.getElementById('signalCard');
            const signalDiv = document.getElementById('tradingSignal');
            
            if (signal === 'BUY') {
                signalDiv.className = 'text-center p-4 rounded-lg bg-green-900/50';
                signalDiv.innerHTML = \`<div class="text-2xl font-bold text-green-500">🟢 BUY SIGNAL</div>
                                       <div class="text-sm mt-2">Signal Strength: \${strength.toFixed(1)}/10</div>
                                       <div class="text-xs mt-1">RSI: \${data.indicators.rsi.value.toFixed(1)} | MACD: \${data.indicators.macd.histogram > 0 ? 'Bullish' : 'Bearish'}</div>\`;
            } else if (signal === 'SELL') {
                signalDiv.className = 'text-center p-4 rounded-lg bg-red-900/50';
                signalDiv.innerHTML = \`<div class="text-2xl font-bold text-red-500">🔴 SELL SIGNAL</div>
                                       <div class="text-sm mt-2">Signal Strength: \${strength.toFixed(1)}/10</div>
                                       <div class="text-xs mt-1">RSI: \${data.indicators.rsi.value.toFixed(1)} | MACD: \${data.indicators.macd.histogram < 0 ? 'Bearish' : 'Bullish'}</div>\`;
            } else {
                signalDiv.className = 'text-center p-4 rounded-lg bg-yellow-900/50';
                signalDiv.innerHTML = \`<div class="text-2xl font-bold text-yellow-500">🟡 NEUTRAL</div>
                                       <div class="text-sm mt-2">No clear signal. Wait for confirmation.</div>\`;
            }
            
            // Recent candles
            let candlesHtml = '';
            data.recentCandles.forEach(candle => {
                const date = new Date(candle.time);
                const timeStr = date.toLocaleTimeString();
                const isBullish = candle.close > candle.open;
                candlesHtml += \`
                    <tr class="border-t border-gray-800">
                        <td class="p-2 text-left text-xs">\${timeStr}</td>
                        <td class="p-2 text-right font-mono \${isBullish ? 'value-up' : 'value-down'}">\${candle.open.toFixed(8)}</td>
                        <td class="p-2 text-right font-mono text-green-500">\${candle.high.toFixed(8)}</td>
                        <td class="p-2 text-right font-mono text-red-500">\${candle.low.toFixed(8)}</td>
                        <td class="p-2 text-right font-mono \${isBullish ? 'value-up' : 'value-down'}">\${candle.close.toFixed(8)}</td>
                        <td class="p-2 text-right">\${formatVolume(candle.volume)}</td>
                    </tr>
                \`;
            });
            document.getElementById('recentCandles').innerHTML = candlesHtml;
            
            // Update timestamp
            document.getElementById('lastUpdate').innerHTML = 'Updated: ' + new Date(data.timestamp).toLocaleTimeString();
        });
        
        socket.on('disconnect', () => {
            document.getElementById('status').innerHTML = '● DISCONNECTED';
            document.getElementById('status').className = 'text-xs text-red-500';
        });
        
        socket.on('connect', () => {
            document.getElementById('status').innerHTML = '● LIVE';
            document.getElementById('status').className = 'text-xs text-green-500';
        });
    </script>
</body>
</html>
    `);
});

// ============ START SERVER ============

async function start() {
    await fetchOHLCV();
    await updateData();
    
    // Update every 60 seconds
    setInterval(updateData, 60000);
    
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║     🐕 SHIB/USDT Real-Time Technical Analysis           ║
║                                                          ║
║     Dashboard: http://localhost:${PORT}                    ║
║     API: http://localhost:${PORT}/api/indicators          ║
║                                                          ║
║     Indicators: RSI, MACD, BB, Stochastic, ADX, MFI     ║
║     Patterns: Doji, Hammer, Engulfing, Morning/Evening  ║
║                                                          ║
║     Status: ✅ RUNNING                                   ║
╚══════════════════════════════════════════════════════════╝
        `);
    });
}

start();
