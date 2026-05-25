const express = require('express');
const ccxt = require('ccxt');
const http = require('http');

// ==========================================
// 1. CONFIGURATION (REPLICATING #256778)
// ==========================================
const CONFIG = {
    API_KEY: 'YOUR_HTX_API_KEY',
    SECRET_KEY: 'YOUR_HTX_SECRET_KEY',
    SYMBOL: 'BTC/USDT:USDT',   // Linear Swap
    DIRECTION: 'long',         // 'long' or 'short'
    LEVERAGE: 10,
    BASE_SIZE: 0.001,          // Base quantity in BTC
    MULTIPLIER: 2.0,           // Double size every step
    PRICE_SCALE: 0.01,         // EXACT 1% drop triggers safety
    TAKE_PROFIT: 0.015,        // EXACT 1.5% target from average
    MAX_SAFETY_ORDERS: 5,
    POLL_INTERVAL: 5000,       // 5 seconds
    PORT: 3000
};

// ==========================================
// 2. TRADING ENGINE (SCALING.COM DESIGN)
// ==========================================
class TradingEngine {
    constructor() {
        this.exchange = new ccxt.htx({
            apiKey: CONFIG.API_KEY,
            secret: CONFIG.SECRET_KEY,
            options: { 'defaultType': 'swap' }
        });
        this.isActive = false;
        this.currentStep = 0;
        this.logs = [];
    }

    log(msg) {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(entry);
        this.logs.unshift(entry);
        if (this.logs.length > 50) this.logs.pop();
    }

    async init() {
        await this.exchange.loadMarkets();
        await this.exchange.setLeverage(CONFIG.LEVERAGE, CONFIG.SYMBOL);
        this.log(`Initialized: ${CONFIG.SYMBOL} | Mode: ${CONFIG.DIRECTION}`);
    }

    async start() {
        if (this.isActive) return;
        this.isActive = true;
        this.log("Bot Strategy Started.");
        this.runLoop();
    }

    stop() {
        this.isActive = false;
        this.log("Bot Strategy Stopped.");
    }

    async runLoop() {
        while (this.isActive) {
            try {
                const pos = await this.fetchCurrentPosition();
                const ticker = await this.exchange.fetchTicker(CONFIG.SYMBOL);
                const price = ticker.last;

                if (!pos || pos.contracts === 0) {
                    await this.openBaseOrder();
                } else {
                    await this.managePosition(pos, price);
                }
            } catch (e) {
                this.log(`Error: ${e.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.POLL_INTERVAL));
        }
    }

    async fetchCurrentPosition() {
        const positions = await this.exchange.fetchPositions([CONFIG.SYMBOL]);
        return positions.find(p => p.symbol === CONFIG.SYMBOL);
    }

    async openBaseOrder() {
        this.log("Opening Base Order...");
        const side = CONFIG.DIRECTION === 'long' ? 'buy' : 'sell';
        await this.placeOrder(side, CONFIG.BASE_SIZE);
        this.currentStep = 0;
    }

    async managePosition(pos, currentPrice) {
        const avgPrice = parseFloat(pos.entryPrice);
        const totalSize = parseFloat(pos.contracts);

        // 1. Calculate REAL Targets
        const tpPrice = CONFIG.DIRECTION === 'long' 
            ? avgPrice * (1 + CONFIG.TAKE_PROFIT) 
            : avgPrice * (1 - CONFIG.TAKE_PROFIT);

        const safetyTrigger = CONFIG.DIRECTION === 'long'
            ? avgPrice * (1 - CONFIG.PRICE_SCALE)
            : avgPrice * (1 + CONFIG.PRICE_SCALE);

        // 2. Check Take Profit
        const isTP = CONFIG.DIRECTION === 'long' ? currentPrice >= tpPrice : currentPrice <= tpPrice;
        if (isTP) {
            this.log(`TP Hit at ${currentPrice}. Closing Position.`);
            const closeSide = CONFIG.DIRECTION === 'long' ? 'sell' : 'buy';
            await this.placeOrder(closeSide, totalSize);
            this.currentStep = 0;
            return;
        }

        // 3. Check Safety Order
        const isSafety = CONFIG.DIRECTION === 'long' ? currentPrice <= safetyTrigger : currentPrice >= safetyTrigger;
        if (isSafety && this.currentStep < CONFIG.MAX_SAFETY_ORDERS) {
            this.currentStep++;
            const nextSize = CONFIG.BASE_SIZE * Math.pow(CONFIG.MULTIPLIER, this.currentStep);
            this.log(`Triggering Safety #${this.currentStep} | Size: ${nextSize}`);
            const side = CONFIG.DIRECTION === 'long' ? 'buy' : 'sell';
            await this.placeOrder(side, nextSize);
        }
    }

    async placeOrder(side, amount) {
        const formattedAmount = this.exchange.amountToPrecision(CONFIG.SYMBOL, amount);
        return await this.exchange.createMarketOrder(CONFIG.SYMBOL, side, formattedAmount);
    }
}

const bot = new TradingEngine();

// ==========================================
// 3. WEB SERVER & DASHBOARD
// ==========================================
const app = express();

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Scaling.com Bot Dashboard</title>
                <style>
                    body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; }
                    .card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
                    .btn { padding: 10px 20px; border-radius: 6px; cursor: pointer; border: none; font-weight: bold; }
                    .btn-start { background: #10b981; color: white; }
                    .btn-stop { background: #ef4444; color: white; }
                    .log-box { background: #000; padding: 15px; border-radius: 8px; height: 300px; overflow-y: scroll; font-family: monospace; color: #10b981; margin-top: 20px; }
                    .status { font-size: 1.2em; margin-bottom: 20px; color: ${bot.isActive ? '#10b981' : '#ef4444'} }
                </style>
                <script>
                    setInterval(() => location.reload(), 10000);
                </script>
            </head>
            <body>
                <div class="card">
                    <h1>HTX Martingale Scaler <small style="font-size: 0.4em; color: #94a3b8;">v1.0.2</small></h1>
                    <div class="status">Status: ${bot.isActive ? 'RUNNING' : 'IDLE'} | Current Step: ${bot.currentStep}</div>
                    <button class="btn btn-start" onclick="fetch('/start')">START BOT</button>
                    <button class="btn btn-stop" onclick="fetch('/stop')">STOP BOT</button>
                    
                    <div class="log-box">
                        ${bot.logs.map(l => `<div>${l}</div>`).join('')}
                    </div>
                </div>
            </body>
        </html>
    `);
});

app.get('/start', async (req, res) => {
    await bot.init();
    bot.start();
    res.send("Started");
});

app.get('/stop', (req, res) => {
    bot.stop();
    res.send("Stopped");
});

app.listen(CONFIG.PORT, () => {
    console.log(`
    ============================================
    SCALING.COM DESIGN INITIALIZED
    Web Dashboard: http://localhost:${CONFIG.PORT}
    Pair: ${CONFIG.SYMBOL}
    ============================================
    `);
});
