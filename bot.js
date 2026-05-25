const express = require('express');
const ccxt = require('ccxt');

// --- SYSTEM CONFIG ---
const CONFIG = {
    SYMBOL: 'BTC/USDT:USDT',
    DIRECTION: 'long',
    LEVERAGE: 10,
    BASE_QTY: 0.001,      // BTC
    MULTIPLIER: 2.0,      // Martingale Factor
    PRICE_SCALE: 0.01,    // 1% Drop
    TAKE_PROFIT: 0.015,   // 1.5% Gain
    MAX_SAFETY: 5,
    INTERVAL: 5000,
    API_KEY: process.env.HTX_API_KEY,
    API_SECRET: process.env.HTX_SECRET,
    PORT: process.env.PORT || 3000
};

class MartingaleEngine {
    constructor() {
        this.exchange = new ccxt.htx({
            apiKey: CONFIG.API_KEY,
            secret: CONFIG.API_SECRET,
            options: { 'defaultType': 'swap' }
        });
        this.status = 'OFFLINE';
        this.logs = [];
        this.data = { price: 0, entry: 0, tp: 0, next_safety: 0, step: 0 };
    }

    addLog(msg) {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.logs.unshift(entry);
        if (this.logs.length > 20) this.logs.pop();
        console.log(entry);
    }

    async init() {
        try {
            await this.exchange.loadMarkets();
            await this.exchange.setLeverage(CONFIG.LEVERAGE, CONFIG.SYMBOL);
            this.status = 'READY';
            this.addLog("System Initialized. Awaiting Start.");
        } catch (e) { this.addLog(`Init Error: ${e.message}`); }
    }

    async start() {
        this.status = 'RUNNING';
        this.addLog("Strategy Engaged.");
        this.tick();
    }

    async stop() {
        this.status = 'READY';
        this.addLog("Strategy Disengaged.");
    }

    async tick() {
        if (this.status !== 'RUNNING') return;

        try {
            const ticker = await this.exchange.fetchTicker(CONFIG.SYMBOL);
            this.data.price = ticker.last;

            const positions = await this.exchange.fetchPositions([CONFIG.SYMBOL]);
            const pos = positions.find(p => p.symbol === CONFIG.SYMBOL);

            if (!pos || parseFloat(pos.contracts) === 0) {
                this.addLog("No position. Opening Base Order...");
                await this.executeOrder('buy', CONFIG.BASE_QTY);
                this.data.step = 0;
            } else {
                const entry = parseFloat(pos.entryPrice);
                const size = parseFloat(pos.contracts);
                this.data.entry = entry;
                this.data.tp = entry * (1 + CONFIG.TAKE_PROFIT);
                this.data.next_safety = entry * (1 - CONFIG.PRICE_SCALE);

                // Logic 1: Take Profit (1.5%)
                if (this.data.price >= this.data.tp) {
                    this.addLog(`Take Profit Triggered at ${this.data.price}`);
                    await this.executeOrder('sell', size);
                    this.data.step = 0;
                } 
                // Logic 2: Safety Order (1% Scale)
                else if (this.data.price <= this.data.next_safety && this.data.step < CONFIG.MAX_SAFETY) {
                    this.data.step++;
                    const nextQty = CONFIG.BASE_QTY * Math.pow(CONFIG.MULTIPLIER, this.data.step);
                    this.addLog(`Safety Order #${this.data.step} triggered.`);
                    await this.executeOrder('buy', nextQty);
                }
            }
        } catch (e) { this.addLog(`Loop Error: ${e.message}`); }
        
        setTimeout(() => this.tick(), CONFIG.INTERVAL);
    }

    async executeOrder(side, qty) {
        const amount = this.exchange.amountToPrecision(CONFIG.SYMBOL, qty);
        return await this.exchange.createMarketOrder(CONFIG.SYMBOL, side, amount);
    }
}

const engine = new MartingaleEngine();
const app = express();

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Trading Terminal | Scaling</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Inter', sans-serif; background-color: #0b0e14; color: #e2e8f0; }
            .glass { background: rgba(23, 27, 34, 0.8); border: 1px solid #2d3748; backdrop-filter: blur(10px); }
            .terminal { font-family: 'Courier New', monospace; color: #10b981; }
        </style>
    </head>
    <body class="p-8">
        <div class="max-w-4xl mx-auto">
            <div class="flex justify-between items-center mb-8">
                <h1 class="text-2xl font-800 tracking-tighter">SCALING <span class="text-emerald-500">TERMINAL</span></h1>
                <div class="flex gap-4">
                    <button onclick="fetch('/start')" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-2 rounded-lg font-semibold transition">START</button>
                    <button onclick="fetch('/stop')" class="bg-rose-600 hover:bg-rose-500 px-6 py-2 rounded-lg font-semibold transition">STOP</button>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                <div class="glass p-4 rounded-xl">
                    <p class="text-xs text-slate-500 uppercase">Status</p>
                    <p class="text-lg font-bold ${engine.status === 'RUNNING' ? 'text-emerald-400' : 'text-rose-400'}">${engine.status}</p>
                </div>
                <div class="glass p-4 rounded-xl">
                    <p class="text-xs text-slate-500 uppercase">Live Price</p>
                    <p class="text-lg font-bold">$${engine.data.price.toLocaleString()}</p>
                </div>
                <div class="glass p-4 rounded-xl">
                    <p class="text-xs text-slate-500 uppercase">TP Target</p>
                    <p class="text-lg font-bold text-emerald-400">$${engine.data.tp.toFixed(2)}</p>
                </div>
                <div class="glass p-4 rounded-xl">
                    <p class="text-xs text-slate-500 uppercase">Next Safety</p>
                    <p class="text-lg font-bold text-rose-400">$${engine.data.next_safety.toFixed(2)}</p>
                </div>
            </div>

            <div class="glass p-6 rounded-2xl">
                <h2 class="text-sm font-semibold mb-4 text-slate-400">EXECUTION LOGS</h2>
                <div class="terminal h-64 overflow-y-auto text-sm space-y-1">
                    ${engine.logs.map(l => `<div>${l}</div>`).join('')}
                </div>
            </div>
        </div>
        <script>setTimeout(() => location.reload(), 5000);</script>
    </body>
    </html>
    `);
});

app.get('/start', async (req, res) => { await engine.init(); engine.start(); res.sendStatus(200); });
app.get('/stop', async (req, res) => { engine.stop(); res.sendStatus(200); });

app.listen(CONFIG.PORT, () => console.log(`Scaling app listening on ${CONFIG.PORT}`));
