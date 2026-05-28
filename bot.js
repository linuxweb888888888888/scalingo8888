// server.js - Master Server on https://business-app.osc-fr1.scalingo.io
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static('public'));

// ============ CONFIGURATION ============
const CONFIG = {
    feeRate: 0.0015,
    minProfitPercent: 0.55,
    minTradeAmount: 10,
    maxTradeAmount: 1000,
    capital: 5000,
    opportunityTimeout: 500,
    workerHeartbeat: 60000,
    port: process.env.PORT || 8080
};

const HTX = {
    rest: 'https://api.htx.com',
    accessKey: process.env.HTX_API_KEY,
    secretKey: process.env.HTX_SECRET_KEY,
    accountId: process.env.HTX_ACCOUNT_ID
};

// ============ STATE ============
let workers = new Map();
let activeOpportunities = [];
let executing = false;
let totalProfit = 0;
let totalTrades = 0;
let startTime = Date.now();

// ============ HTX API FUNCTIONS ============
function htxRequest(method, endpoint, params = {}, signed = false) {
    const url = `${HTX.rest}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    
    if (signed && HTX.accessKey && HTX.secretKey) {
        const timestamp = Date.now();
        const signature = crypto
            .createHmac('sha256', HTX.secretKey)
            .update(timestamp + method + endpoint + JSON.stringify(params))
            .digest('hex');
        
        headers['AccessKeyId'] = HTX.accessKey;
        headers['Signature'] = signature;
        headers['Timestamp'] = timestamp;
    }
    
    return axios({ method, url, headers, params: method === 'GET' ? params : undefined, data: method !== 'GET' ? params : undefined });
}

async function executeTriangle(triangle, amount) {
    const trades = [];
    let currentAmount = amount;
    
    try {
        for (const step of triangle.steps) {
            const order = await placeOrder(step.symbol, step.side, currentAmount);
            if (!order || order.error) throw new Error(`Trade failed on ${step.symbol}`);
            trades.push(order);
            currentAmount = order.filled * (step.side === 'buy' ? 1 : (1 - CONFIG.feeRate));
        }
        
        const profit = currentAmount - amount;
        totalProfit += profit;
        totalTrades++;
        
        console.log(`✅ Executed: $${profit.toFixed(4)} profit`);
        return { success: true, profit };
        
    } catch (error) {
        console.error('❌ Execution failed:', error.message);
        await reverseTrades(trades);
        return { success: false, error: error.message };
    }
}

async function placeOrder(symbol, side, amount) {
    try {
        const response = await htxRequest('POST', '/v1/order/orders', {
            'account-id': HTX.accountId,
            symbol: symbol,
            type: `${side}-market`,
            amount: amount.toString()
        }, true);
        
        await new Promise(r => setTimeout(r, 1000));
        return { orderId: response.data.data, filled: amount, symbol, side };
    } catch (error) {
        return { error: error.message };
    }
}

async function reverseTrades(trades) {
    for (let i = trades.length - 1; i >= 0; i--) {
        const trade = trades[i];
        await placeOrder(trade.symbol, trade.side === 'buy' ? 'sell' : 'buy', trade.filled);
        await new Promise(r => setTimeout(r, 500));
    }
}

// ============ API ENDPOINTS ============

app.post('/addworker', async (req, res) => {
    const { workerId, symbolsScanned, trianglesScanned, opportunitiesFound, cpu, memory, status } = req.body;
    
    if (!workerId) {
        return res.status(400).json({ error: 'workerId required' });
    }
    
    workers.set(workerId, {
        workerId,
        ip: req.ip || req.socket.remoteAddress,
        lastHeartbeat: Date.now(),
        symbolsScanned: symbolsScanned || 0,
        trianglesScanned: trianglesScanned || 0,
        opportunitiesFound: opportunitiesFound || 0,
        cpu: cpu || 0,
        memory: memory || 0,
        status: status || 'online'
    });
    
    io.emit('workers_update', Array.from(workers.values()));
    console.log(`✅ Worker registered: ${workerId} (${workers.size} total)`);
    res.json({ success: true, workerCount: workers.size });
});

app.post('/opportunity', async (req, res) => {
    const { workerId, triangle, profitPercent, timestamp } = req.body;
    
    if (profitPercent < CONFIG.minProfitPercent) {
        return res.json({ accepted: false, reason: 'profit too low' });
    }
    
    const opportunity = {
        id: Date.now() + '-' + workerId,
        workerId,
        triangle,
        profitPercent,
        timestamp: timestamp || Date.now(),
        expiresAt: Date.now() + CONFIG.opportunityTimeout
    };
    
    activeOpportunities.push(opportunity);
    activeOpportunities = activeOpportunities.filter(o => o.expiresAt > Date.now());
    io.emit('opportunity', opportunity);
    
    if (!executing) {
        executing = true;
        const amount = Math.min(CONFIG.maxTradeAmount, CONFIG.capital * 0.1);
        const result = await executeTriangle(triangle, amount);
        executing = false;
        io.emit('execution', { opportunity, result });
        return res.json({ accepted: true, executed: result.success, profit: result.profit });
    }
    
    res.json({ accepted: true, executed: false, reason: 'queued' });
});

app.get('/workers', (req, res) => {
    const workerList = Array.from(workers.values()).map(w => ({
        ...w,
        lastHeartbeatAgo: Date.now() - w.lastHeartbeat,
        isActive: (Date.now() - w.lastHeartbeat) < CONFIG.workerHeartbeat
    }));
    res.json(workerList);
});

app.get('/metrics', (req, res) => {
    const activeWorkers = Array.from(workers.values()).filter(w => 
        (Date.now() - w.lastHeartbeat) < CONFIG.workerHeartbeat
    ).length;
    
    res.json({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        totalWorkers: workers.size,
        activeWorkers,
        totalProfit: totalProfit.toFixed(4),
        totalTrades,
        activeOpportunities: activeOpportunities.length
    });
});

// Dashboard
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>HTX Arbitrage Dashboard</title>
    <script src="https://cdn.socket.io/4.5.0/socket.io.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0e27; color: #00ffcc; padding: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .card { background: #11152a; border: 1px solid #00ffcc33; border-radius: 12px; padding: 20px; }
        .stat { font-size: 32px; font-weight: bold; }
        .worker { background: #0a0e27; padding: 10px; margin: 5px 0; border-left: 3px solid #00ffcc; }
        .worker.offline { border-left-color: #ff3366; opacity: 0.5; }
        .profit { color: #00ff66; }
        .loss { color: #ff3366; }
    </style>
</head>
<body>
    <h1>🔺 HTX Triangular Arbitrage - ALL SPOT COINS</h1>
    <p>Workers: <span id="workerCount">0</span> | Profit: $<span id="totalProfit">0</span> | Trades: <span id="totalTrades">0</span></p>
    
    <div class="grid">
        <div class="card"><h3>📊 Metrics</h3>
            <div>Active Workers: <span id="activeWorkers">0</span></div>
            <div>Uptime: <span id="uptime">0</span>s</div>
        </div>
        <div class="card"><h3>💰 Profit</h3>
            <div class="stat profit" id="profitDisplay">$0</div>
        </div>
    </div>
    
    <div class="card"><h3>🖥️ Workers (<span id="workerListCount">0</span>)</h3>
        <div id="workersList"></div>
    </div>
    
    <div class="card"><h3>📝 Log</h3>
        <div id="log"></div>
    </div>

    <script>
        const socket = io();
        
        function fetchMetrics() {
            fetch('/metrics').then(r => r.json()).then(data => {
                document.getElementById('workerCount').innerText = data.totalWorkers;
                document.getElementById('activeWorkers').innerText = data.activeWorkers;
                document.getElementById('totalProfit').innerText = data.totalProfit;
                document.getElementById('totalTrades').innerText = data.totalTrades;
                document.getElementById('profitDisplay').innerText = '$' + data.totalProfit;
                document.getElementById('uptime').innerText = data.uptime;
            });
        }
        
        function fetchWorkers() {
            fetch('/workers').then(r => r.json()).then(workers => {
                document.getElementById('workerListCount').innerText = workers.length;
                const html = workers.map(w => \`
                    <div class="worker \${(Date.now() - w.lastHeartbeat) < 60000 ? '' : 'offline'}">
                        <strong>\${w.workerId}</strong> | Last: \${Math.floor((Date.now() - w.lastHeartbeat)/1000)}s ago<br>
                        Symbols: \${w.symbolsScanned} | Tri: \${w.trianglesScanned} | Found: \${w.opportunitiesFound}<br>
                        CPU: \${(w.cpu || 0).toFixed(1)}% | RAM: \${(w.memory || 0).toFixed(1)}%
                    </div>
                \`).join('');
                document.getElementById('workersList').innerHTML = html || '<p>No workers</p>';
            });
        }
        
        socket.on('workers_update', () => { fetchWorkers(); fetchMetrics(); });
        socket.on('opportunity', (opp) => {
            const log = document.getElementById('log');
            log.innerHTML = \`[OPPORTUNITY] \${opp.workerId}: \${opp.profitPercent.toFixed(2)}%<br>\${log.innerHTML}\`;
        });
        socket.on('execution', (data) => {
            const log = document.getElementById('log');
            log.innerHTML = \`[EXECUTION] \${data.result.success ? '✅ SUCCESS' : '❌ FAILED'} - $\${(data.result.profit || 0).toFixed(4)}<br>\${log.innerHTML}\`;
            fetchMetrics();
        });
        
        setInterval(fetchMetrics, 3000);
        setInterval(fetchWorkers, 5000);
        fetchMetrics(); fetchWorkers();
    </script>
</body>
</html>
    `);
});

setInterval(() => {
    const now = Date.now();
    for (const [id, worker] of workers.entries()) {
        if (now - worker.lastHeartbeat > CONFIG.workerHeartbeat * 2) {
            workers.delete(id);
        }
    }
    io.emit('workers_update', Array.from(workers.values()));
}, 60000);

server.listen(CONFIG.port, () => {
    console.log(`Master running on port ${CONFIG.port}`);
});
