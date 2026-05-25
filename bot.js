const express = require('express');
const ccxt = require('ccxt');

const CONFIG = {
    SYMBOL: 'BTC/USDT:USDT',
    DIRECTION: 'long',
    LEVERAGE: 10,
    BASE_QTY: 0.001,      // Base Amount
    MULTIPLIER: 2.0,      // Martingale factor
    PRICE_SCALE: 0.01,    // 1% Drop
    TAKE_PROFIT: 0.015,   // 1.5% Profit
    MAX_SAFETY: 5,
    INTERVAL: 5000,
    API_KEY: process.env.HTX_API_KEY,
    API_SECRET: process.env.HTX_SECRET,
    PORT: process.env.PORT || 3000
};

class BotEngine {
    constructor() {
        this.exchange = new ccxt.htx({
            apiKey: CONFIG.API_KEY,
            secret: CONFIG.API_SECRET,
            options: { 'defaultType': 'swap' }
        });
        this.status = 'IDLE';
        this.logs = [];
        this.metrics = { price: 0, entry: 0, tp: 0, safety: 0, step: 0 };
    }

    addLog(msg) {
        const time = new Date().toLocaleTimeString();
        this.logs.unshift({ time, msg });
        if (this.logs.length > 15) this.logs.pop();
    }

    async run() {
        if (this.status !== 'RUNNING') return;
        try {
            const ticker = await this.exchange.fetchTicker(CONFIG.SYMBOL);
            this.metrics.price = ticker.last;

            const positions = await this.exchange.fetchPositions([CONFIG.SYMBOL]);
            const pos = positions.find(p => p.symbol === CONFIG.SYMBOL);

            if (!pos || parseFloat(pos.contracts) === 0) {
                this.addLog("Searching for entry... Opening Base Order.");
                await this.order('buy', CONFIG.BASE_QTY);
                this.metrics.step = 0;
            } else {
                const entry = parseFloat(pos.entryPrice);
                const size = parseFloat(pos.contracts);
                this.metrics.entry = entry;
                this.metrics.tp = entry * (1 + CONFIG.TAKE_PROFIT);
                this.metrics.safety = entry * (1 - CONFIG.PRICE_SCALE);

                if (this.metrics.price >= this.metrics.tp) {
                    this.addLog(`Take Profit hit at ${this.metrics.price}`);
                    await this.order('sell', size);
                    this.metrics.step = 0;
                } else if (this.metrics.price <= this.metrics.safety && this.metrics.step < CONFIG.MAX_SAFETY) {
                    this.metrics.step++;
                    const qty = CONFIG.BASE_QTY * Math.pow(CONFIG.MULTIPLIER, this.metrics.step);
                    this.addLog(`Executing Safety Order #${this.metrics.step}`);
                    await this.order('buy', qty);
                }
            }
        } catch (e) { this.addLog(`Error: ${e.message}`); }
        setTimeout(() => this.run(), CONFIG.INTERVAL);
    }

    async order(side, qty) {
        const amount = this.exchange.amountToPrecision(CONFIG.SYMBOL, qty);
        return await this.exchange.createMarketOrder(CONFIG.SYMBOL, side, amount);
    }
}

const bot = new BotEngine();
const app = express();

app.get('/', (req, res) => {
    const logHtml = bot.logs.map(l => `
        <div class="flex py-2 border-b border-slate-100 text-sm">
            <span class="text-slate-400 w-24">${l.time}</span>
            <span class="text-slate-700 font-medium">${l.msg}</span>
        </div>`).join('');

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Scaling Bot</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
        <style>body { font-family: 'Inter', sans-serif; background-color: #f8fafc; }</style>
    </head>
    <body class="antialiased text-slate-900">
        <div class="max-w-5xl mx-auto px-6 py-12">
            <header class="flex justify-between items-center mb-12">
                <div>
                    <h1 class="text-xl font-bold tracking-tight">SCALING_BOT</h1>
                    <p class="text-slate-500 text-sm">HTX Martingale Strategy #256778</p>
                </div>
                <div class="flex gap-3">
                    <button onclick="fetch('/start').then(()=>location.reload())" class="bg-slate-900 text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-slate-800 transition">Start Bot</button>
                    <button onclick="fetch('/stop').then(()=>location.reload())" class="bg-white border border-slate-200 text-slate-600 px-5 py-2 rounded-full text-sm font-semibold hover:bg-slate-50 transition">Stop</button>
                </div>
            </header>

            <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
                <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p class="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-1">Status</p>
                    <p class="text-lg font-bold ${bot.status === 'RUNNING' ? 'text-emerald-500' : 'text-slate-400'}">${bot.status}</p>
                </div>
                <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p class="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-1">Live Price</p>
                    <p class="text-lg font-bold">$${bot.metrics.price.toLocaleString()}</p>
                </div>
                <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p class="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-1">Take Profit</p>
                    <p class="text-lg font-bold text-emerald-600">$${bot.metrics.tp.toFixed(2)}</p>
                </div>
                <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p class="text-slate-500 text-xs font-semibold uppercase tracking-wider mb-1">Next Safety</p>
                    <p class="text-lg font-bold text-rose-500">$${bot.metrics.safety.toFixed(2)}</p>
                </div>
            </div>

            <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div class="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                    <h3 class="text-sm font-bold text-slate-700">Real-time Activity</h3>
                </div>
                <div class="p-6 min-h-[300px]">
                    ${logHtml || '<p class="text-slate-400 text-center py-12">No activity recorded</p>'}
                </div>
            </div>
        </div>
        <script>if ("${bot.status}" === "RUNNING") setTimeout(() => location.reload(), 5000);</script>
    </body>
    </html>
    `);
});

app.get('/start', async (req, res) => {
    if (bot.status !== 'RUNNING') {
        bot.status = 'RUNNING';
        await bot.exchange.loadMarkets();
        await bot.exchange.setLeverage(CONFIG.LEVERAGE, CONFIG.SYMBOL);
        bot.run();
    }
    res.sendStatus(200);
});

app.get('/stop', (req, res) => { bot.status = 'IDLE'; res.sendStatus(200); });

app.listen(CONFIG.PORT, () => console.log(`Scaling Terminal on ${CONFIG.PORT}`));
