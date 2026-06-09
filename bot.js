// bitcoin-auto-finder.js - Auto-continuous Bitcoin Wallet Finder
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    autoStart: true,
    batchSize: 50,           // Keys per batch
    batchDelay: 100,         // Milliseconds between batches
    checkBalance: true,      // Check blockchain balance
    saveFoundWallets: true,  // Save to file
    maxConcurrent: 5,        // Max concurrent API requests
    continuousMode: true     // Run forever
};

// ============ SECP256K1 CURVE ============
const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ============ STATISTICS ============
let stats = {
    startTime: Date.now(),
    totalGenerated: 0,
    totalValidated: 0,
    totalWithFunds: 0,
    totalBalanceFound: 0,
    currentSpeed: 0,
    lastBatchTime: Date.now(),
    foundWallets: [],
    running: true
};

// ============ LOAD SAVED WALLETS ============
function loadSavedWallets() {
    try {
        if (fs.existsSync('found-wallets.json')) {
            const data = fs.readFileSync('found-wallets.json', 'utf8');
            const saved = JSON.parse(data);
            stats.foundWallets = saved;
            stats.totalWithFunds = saved.length;
            stats.totalBalanceFound = saved.reduce((sum, w) => sum + w.balance, 0);
            console.log(`[LOAD] Loaded ${saved.length} previously found wallets`);
        }
    } catch(e) {}
}

function saveFoundWallet(wallet) {
    stats.foundWallets.unshift(wallet);
    stats.totalWithFunds = stats.foundWallets.length;
    stats.totalBalanceFound += wallet.balance;
    
    // Save to file
    fs.writeFileSync('found-wallets.json', JSON.stringify(stats.foundWallets, null, 2));
    console.log(`\n🔥🔥🔥 WALLET FOUND! 🔥🔥🔥`);
    console.log(`Private Key: ${wallet.privateKey}`);
    console.log(`Address: ${wallet.address}`);
    console.log(`Balance: ${wallet.balance} BTC`);
    console.log(`Total Found: ${stats.totalWithFunds} wallets`);
    console.log(`Total Balance: ${stats.totalBalanceFound.toFixed(8)} BTC\n`);
}

// ============ CRYPTO FUNCTIONS ============
function base58Encode(buffer) {
    let num = 0n;
    for (const byte of buffer) num = (num << 8n) | BigInt(byte);
    
    let result = '';
    while (num > 0n) {
        result = BASE58_ALPHABET[Number(num % 58n)] + result;
        num = num / 58n;
    }
    for (const byte of buffer) {
        if (byte === 0) result = '1' + result;
        else break;
    }
    return result;
}

function hash160(buffer) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest();
    return crypto.createHash('ripemd160').update(sha256).digest();
}

function generateRandomPrivateKey() {
    let privateKeyHex;
    do {
        const privateKeyBytes = crypto.randomBytes(32);
        privateKeyHex = privateKeyBytes.toString('hex');
        const privateKeyBigInt = BigInt('0x' + privateKeyHex);
        if (privateKeyBigInt !== 0n && privateKeyBigInt < SECP256K1_ORDER) {
            break;
        }
    } while (true);
    return privateKeyHex;
}

function privateKeyToAddress(privateKeyHex) {
    // Simplified: In production, use proper ECDSA
    // For demo, we generate a deterministic address from the key
    const hash = crypto.createHash('sha256').update(privateKeyHex).digest();
    const ripemd = crypto.createHash('ripemd160').update(hash).digest();
    const versioned = Buffer.concat([Buffer.from([0x00]), ripemd]);
    const checksum = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(versioned).digest())
        .digest()
        .slice(0, 4);
    return base58Encode(Buffer.concat([versioned, checksum]));
}

async function checkBalance(address) {
    try {
        const response = await axios.get(`https://blockchain.info/q/addressbalance/${address}`, { timeout: 5000 });
        const balanceSatoshis = response.data;
        return balanceSatoshis / 100000000;
    } catch (error) {
        return 0;
    }
}

// ============ BATCH PROCESSING ============
async function processBatch(batchSize) {
    const batchStart = Date.now();
    const keys = [];
    const addresses = [];
    
    // Generate keys
    for (let i = 0; i < batchSize; i++) {
        const privateKey = generateRandomPrivateKey();
        const address = privateKeyToAddress(privateKey);
        keys.push(privateKey);
        addresses.push(address);
        stats.totalGenerated++;
    }
    
    // Check balances (with concurrency limit)
    const balancePromises = addresses.map(async (address, idx) => {
        const balance = await checkBalance(address);
        if (balance > 0) {
            const wallet = {
                privateKey: keys[idx],
                address: address,
                balance: balance,
                timestamp: new Date().toISOString()
            };
            saveFoundWallet(wallet);
        }
        return balance;
    });
    
    // Process with concurrency limit
    const balances = [];
    for (let i = 0; i < balancePromises.length; i += CONFIG.maxConcurrent) {
        const batch = balancePromises.slice(i, i + CONFIG.maxConcurrent);
        const results = await Promise.all(batch);
        balances.push(...results);
        await new Promise(r => setTimeout(r, 50));
    }
    
    const batchEnd = Date.now();
    const batchDuration = (batchEnd - batchStart) / 1000;
    const batchSpeed = batchSize / batchDuration;
    
    // Update stats
    stats.totalValidated += batchSize;
    stats.currentSpeed = batchSpeed;
    stats.lastBatchTime = batchEnd;
    
    const fundedInBatch = balances.filter(b => b > 0).length;
    
    console.log(`[BATCH] ${batchSize} keys | ${batchDuration.toFixed(2)}s | ${batchSpeed.toFixed(2)} keys/sec | Funded: ${fundedInBatch} | Total: ${stats.totalGenerated.toLocaleString()}`);
    
    return { batchSize, batchDuration, batchSpeed, fundedInBatch };
}

// ============ CONTINUOUS RUNNER ============
async function continuousRunner() {
    console.log('\n========================================');
    console.log('  Bitcoin Wallet Finder - AUTO MODE');
    console.log('========================================');
    console.log(`Batch Size: ${CONFIG.batchSize} keys`);
    console.log(`Batch Delay: ${CONFIG.batchDelay}ms`);
    console.log(`Checking Balance: ${CONFIG.checkBalance}`);
    console.log(`Continuous Mode: ${CONFIG.continuousMode}`);
    console.log('========================================\n');
    
    loadSavedWallets();
    
    let batchCount = 0;
    const startTime = Date.now();
    
    while (stats.running) {
        batchCount++;
        const batchStart = Date.now();
        
        try {
            await processBatch(CONFIG.batchSize);
            
            const elapsed = (Date.now() - startTime) / 1000;
            const avgSpeed = stats.totalGenerated / elapsed;
            
            // Update dashboard stats
            stats.avgSpeed = avgSpeed;
            stats.elapsed = elapsed;
            stats.batchCount = batchCount;
            
            // Delay between batches
            if (CONFIG.continuousMode && stats.running) {
                await new Promise(r => setTimeout(r, CONFIG.batchDelay));
            } else {
                break;
            }
            
        } catch (error) {
            console.error(`[ERROR] Batch ${batchCount}: ${error.message}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// ============ API ENDPOINTS ============
app.get('/api/stats', (req, res) => {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    res.json({
        running: stats.running,
        totalGenerated: stats.totalGenerated,
        totalValidated: stats.totalValidated,
        totalWithFunds: stats.totalWithFunds,
        totalBalanceFound: stats.totalBalanceFound.toFixed(8),
        currentSpeed: stats.currentSpeed.toFixed(2),
        avgSpeed: (stats.totalGenerated / elapsed).toFixed(2),
        elapsed: elapsed,
        batchCount: stats.batchCount || 0,
        foundWallets: stats.foundWallets.slice(0, 20)
    });
});

app.post('/api/start', (req, res) => {
    if (!stats.running) {
        stats.running = true;
        stats.startTime = Date.now();
        continuousRunner().catch(console.error);
        res.json({ success: true, message: 'Bot started' });
    } else {
        res.json({ success: false, message: 'Bot already running' });
    }
});

app.post('/api/stop', (req, res) => {
    stats.running = false;
    res.json({ success: true, message: 'Bot stopping...' });
});

app.get('/api/found-wallets', (req, res) => {
    res.json(stats.foundWallets);
});

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bitcoin Wallet Finder - Auto Continuous</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
            font-family: 'Inter', sans-serif;
            color: #fff;
            min-height: 100vh;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 40px 20px; }
        h1 { text-align: center; font-size: 2.5rem; margin-bottom: 10px; }
        h1 span { background: linear-gradient(135deg, #00d4ff, #667eea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; }
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; text-align: center; border: 1px solid rgba(255,255,255,0.2); }
        .stat-value { font-size: 2rem; font-weight: bold; color: #00d4ff; }
        .stat-label { font-size: 0.8rem; opacity: 0.7; margin-top: 5px; }
        
        .controls { display: flex; gap: 15px; justify-content: center; margin-bottom: 40px; }
        .btn { padding: 12px 30px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: transform 0.2s; }
        .btn-start { background: linear-gradient(135deg, #4facfe, #00f2fe); color: #fff; }
        .btn-stop { background: linear-gradient(135deg, #f093fb, #f5576c); color: #fff; }
        .btn:hover { transform: scale(1.02); }
        
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 40px; }
        .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; border: 1px solid rgba(255,255,255,0.2); }
        .card h3 { margin-bottom: 15px; color: #00d4ff; }
        
        .result { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px; }
        .wallet-item { border-bottom: 1px solid rgba(255,255,255,0.1); padding: 10px; margin-bottom: 5px; }
        .funded { background: rgba(0,255,0,0.1); border-left: 3px solid #00ff00; }
        .status { padding: 10px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
        .status-running { background: rgba(0,255,0,0.2); border: 1px solid #00ff00; }
        .status-stopped { background: rgba(255,0,0,0.2); border: 1px solid #ff4444; }
        
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .pulse { animation: pulse 1s infinite; }
        
        @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
<div class="container">
    <h1>🔐 <span>Bitcoin Wallet Finder</span> - Auto Continuous</h1>
    <div class="subtitle">24/7 Automatic Key Generation & Balance Checking</div>
    
    <div class="controls">
        <button class="btn btn-start" onclick="startBot()">▶ START AUTO BOT</button>
        <button class="btn btn-stop" onclick="stopBot()">⏹ STOP BOT</button>
    </div>
    
    <div id="status" class="status status-stopped">⚫ BOT STOPPED - Click Start to begin</div>
    
    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="totalGenerated">0</div><div class="stat-label">Keys Generated</div></div>
        <div class="stat-card"><div class="stat-value" id="currentSpeed">0</div><div class="stat-label">Current Speed (keys/sec)</div></div>
        <div class="stat-card"><div class="stat-value" id="avgSpeed">0</div><div class="stat-label">Avg Speed (keys/sec)</div></div>
        <div class="stat-card"><div class="stat-value" id="fundsFound">0</div><div class="stat-label">Wallets with Funds</div></div>
        <div class="stat-card"><div class="stat-value" id="balanceFound">0 BTC</div><div class="stat-label">Total Balance Found</div></div>
        <div class="stat-card"><div class="stat-value" id="uptime">0s</div><div class="stat-label">Uptime</div></div>
    </div>
    
    <div class="grid-2">
        <div class="card">
            <h3>📊 Real-time Stats</h3>
            <div class="result" id="liveStats">
                Waiting for bot to start...
            </div>
        </div>
        <div class="card">
            <h3>🏆 Found Wallets</h3>
            <div class="result" id="foundWallets">
                No wallets found yet...
            </div>
        </div>
    </div>
</div>

<script>
    let updateInterval = null;
    
    async function startBot() {
        try {
            const res = await fetch('/api/start', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                document.getElementById('status').className = 'status status-running';
                document.getElementById('status').innerHTML = '🟢 BOT RUNNING - Auto-generating keys 24/7';
                startUpdates();
            }
        } catch(e) { console.error(e); }
    }
    
    async function stopBot() {
        try {
            const res = await fetch('/api/stop', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                document.getElementById('status').className = 'status status-stopped';
                document.getElementById('status').innerHTML = '⚫ BOT STOPPED';
            }
        } catch(e) { console.error(e); }
    }
    
    async function loadStats() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            
            document.getElementById('totalGenerated').innerText = data.totalGenerated.toLocaleString();
            document.getElementById('currentSpeed').innerText = parseFloat(data.currentSpeed).toFixed(2);
            document.getElementById('avgSpeed').innerText = parseFloat(data.avgSpeed).toFixed(2);
            document.getElementById('fundsFound').innerText = data.totalWithFunds;
            document.getElementById('balanceFound').innerText = data.totalBalanceFound + ' BTC';
            
            const hours = Math.floor(data.elapsed / 3600);
            const minutes = Math.floor((data.elapsed % 3600) / 60);
            const seconds = Math.floor(data.elapsed % 60);
            document.getElementById('uptime').innerText = hours + 'h ' + minutes + 'm ' + seconds + 's';
            
            // Live stats
            const liveStats = document.getElementById('liveStats');
            liveStats.innerHTML = '<div class="wallet-item"><strong>📈 Performance</strong><br>' +
                'Total Generated: ' + data.totalGenerated.toLocaleString() + '<br>' +
                'Keys per Second: ' + parseFloat(data.currentSpeed).toFixed(2) + '<br>' +
                'Average Speed: ' + parseFloat(data.avgSpeed).toFixed(2) + ' keys/sec<br>' +
                'Keys per Hour: ' + (data.avgSpeed * 3600).toLocaleString() + '<br>' +
                'Keys per Day: ' + (data.avgSpeed * 86400).toLocaleString() + '<br>' +
                'Batches Processed: ' + (data.batchCount || 0) + '<br>' +
                'Uptime: ' + hours + 'h ' + minutes + 'm ' + seconds + 's</div>';
            
            // Found wallets
            const foundDiv = document.getElementById('foundWallets');
            if (data.foundWallets && data.foundWallets.length > 0) {
                let html = '';
                for (let i = 0; i < Math.min(data.foundWallets.length, 30); i++) {
                    const w = data.foundWallets[i];
                    html += '<div class="wallet-item funded"><strong>💰 FOUND ' + w.balance + ' BTC</strong><br>' +
                        'Private Key: <span style="font-family:monospace; font-size:10px">' + w.privateKey + '</span><br>' +
                        'Address: <span style="font-family:monospace; font-size:10px">' + w.address + '</span><br>' +
                        'Found: ' + new Date(w.timestamp).toLocaleString() + '</div>';
                }
                foundDiv.innerHTML = html;
            } else {
                foundDiv.innerHTML = '<div class="wallet-item">No wallets found yet. Bot is searching...</div>';
            }
        } catch(e) { console.error(e); }
    }
    
    function startUpdates() {
        if (updateInterval) clearInterval(updateInterval);
        loadStats();
        updateInterval = setInterval(loadStats, 1000);
    }
    
    // Auto-start bot on page load
    setTimeout(startBot, 1000);
    startUpdates();
</script>
</body>
</html>`);
});

// ============ AUTO START ============
if (CONFIG.autoStart) {
    setTimeout(() => {
        console.log('\n🚀 Auto-starting continuous wallet finder...\n');
        continuousRunner().catch(console.error);
    }, 2000);
}

// ============ START SERVER ============
app.listen(port, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('  Bitcoin Wallet Finder - Auto Mode');
    console.log('========================================');
    console.log(`  Dashboard: http://localhost:${port}`);
    console.log(`  Status: ${CONFIG.autoStart ? 'AUTO-STARTING' : 'MANUAL START REQUIRED'}`);
    console.log('========================================\n');
});
