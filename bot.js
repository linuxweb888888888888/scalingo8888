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

// Configuration - FIXED for Huobi API
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
let fetchError = null;

// ============ FETCH DATA WITH BETTER ERROR HANDLING ============

async function fetchOHLCV() {
    try {
        // Huobi API endpoint (correct format)
        const url = `https://${config.restHost}/market/history/kline`;
        const params = {
            symbol: config.symbol,
            period: config.interval,
            size: config.limit
        };
        
        console.log(`Fetching: ${url}?symbol=${config.symbol}&period=${config.interval}&size=${config.limit}`);
        
        const response = await axios.get(url, { 
            params: params,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            }
        });
        
        if (response.data && response.data.status === 'ok' && response.data.data) {
            ohlcv = response.data.data.map(k => ({
                time: k.id * 1000,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: parseFloat(k.vol)
            }));
            
            console.log(`✅ Fetched ${ohlcv.length} candles for SHIB/USDT`);
            console.log(`Latest price: $${ohlcv[ohlcv.length-1].close.toFixed(8)}`);
            fetchError = null;
            return true;
        } else {
            console.error('API returned unexpected format:', response.data);
            fetchError = 'API format error';
            return false;
        }
    } catch (error) {
        console.error('Error fetching OHLCV:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        fetchError = error.message;
        return false;
    }
}

// ============ INDICATOR FUNCTIONS (same as before) ============

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
    
    const macdHistory = [];
    for (let i = 0; i < closes.length - 26; i++) {
        const e12 = calculateEMA(closes.slice(i, i + 26), 12);
        const e26 = calculateEMA(closes.slice(i, i + 26), 26);
        macdHistory.push(e12 - e26);
    }
    
    const signalLine = macdHistory.length > 0 ? calculateEMA(macdHistory, 9) : 0;
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
    
    return volumeSum > 0 ? typicalPriceSum / volumeSum : 0;
}

// ============ CANDLESTICK PATTERNS ============

function detectDoji(open, close, high, low) {
    const bodySize = Math.abs(close - open);
    const totalRange = high - low;
    return totalRange > 0 && bodySize <= totalRange * 0.1;
}

function detectHammer(candle, prevCandle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
    const upperShadow = candle.high - Math.max(candle.open, candle.close);
    const totalRange = candle.high - candle.low;
    
    return totalRange > 0 && lowerShadow > bodySize * 2 && 
           upperShadow < bodySize * 0.5 &&
           candle.close > prevCandle.close;
}

function detectShootingStar(candle, prevCandle) {
    const bodySize = Math.abs(candle.close - candle.open);
    const upperShadow = candle.high - Math.max(candle.open, candle.close);
    const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
    const totalRange = candle.high - candle.low;
    
    return totalRange > 0 && upperShadow > bodySize * 2 && 
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
            rsi: { value: rsi, status: rsi > 70 ? 'OVERBOUGHT' : (rsi < 30 ? 'OVERSOLD' : 'NEUTRAL') },
            stochK: { value: stoch.k, status: stoch.k > 80 ? 'OVERBOUGHT' : (stoch.k < 20 ? 'OVERSOLD' : 'NEUTRAL') },
            stochD: stoch.d,
            willr: -((bb.upper - currentPrice) / (bb.upper - bb.lower)) * 100,
            cci: cci,
            mfi: { value: mfi, status: mfi > 80 ? 'OVERBOUGHT' : (mfi < 20 ? 'OVERSOLD' : 'NEUTRAL') },
            momentum: momentum,
            roc: roc,
            macd: macd,
            adx: { value: adx, strength: adx > 25 ? 'STRONG' : (adx > 20 ? 'MODERATE' : 'WEAK') },
            ema9: ema9,
            ema20: ema20,
            ema50: ema50,
            sma20: sma20,
            sma50: sma50,
            trend: trend,
            bb: bb,
            atr: atr,
            atrPercent: (atr / currentPrice) * 100,
            obv: obv,
            vwap: vwap,
            volumeRatio: volumes[volumes.length - 1] / calculateSMA(volumes, 20),
            signal: signal,
            signalStrength: signalStrength
        },
        patterns: patterns,
        recentCandles: ohlcv.slice(-10)
    };
}

// ============ WEBSOCKET & UPDATE ============

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send existing data if available
    if (indicators) {
        socket.emit('indicators', indicators);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

async function updateData() {
    console.log('Updating data...');
    const success = await fetchOHLCV();
    if (success && ohlcv.length > 0) {
        const data = calculateAllIndicators();
        if (data) {
            indicators = data;
            lastUpdate = new Date();
            io.emit('indicators', indicators);
            console.log(`📊 Data updated: $${data.currentPrice.toFixed(8)} | RSI: ${data.indicators.rsi.value.toFixed(1)} | Signal: ${data.indicators.signal}`);
        } else {
            console.log('⚠️ Not enough data to calculate indicators (need at least 50 candles)');
        }
    } else {
        console.log('❌ Failed to fetch data');
    }
}

// ============ EXPRESS ROUTES ============

app.use(express.static('public'));

app.get('/api/indicators', (req, res) => {
    if (indicators) {
        res.json(indicators);
    } else {
        res.json({ error: 'No data yet', message: 'Waiting for first data fetch...', fetchError: fetchError });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        lastUpdate: lastUpdate,
        candlesCount: ohlcv.length,
        symbol: config.symbol,
        interval: config.interval,
        fetchError: fetchError
    });
});

// ============ START SERVER ============

async function start() {
    console.log('Starting SHIB/USDT Technical Analysis Server...');
    
    // Initial fetch
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
║     Status: http://localhost:${PORT}/api/status           ║
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
