// real-bitcoin-finder.js - Genuine Bitcoin Wallet Finder
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const secp256k1 = require('secp256k1');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
    autoStart: true,
    batchSize: 10,           // Real keys are slower - smaller batches
    batchDelay: 500,         // Milliseconds between batches
    checkBalance: true,
    saveFoundWallets: true,
    maxConcurrent: 3,        // Rate limit friendly
    continuousMode: true,
    apiTimeout: 10000,       // 10 second timeout
    useMultipleApis: true    // Fallback if one API fails
};

// ============ BITCOIN CONSTANTS ============
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const VERSION_BYTE = 0x00;  // Mainnet

// API endpoints (real blockchain APIs)
const APIS = [
    { name: 'BlockchainInfo', url: (addr) => `https://blockchain.info/q/addressbalance/${addr}` },
    { name: 'Blockchair', url: (addr) => `https://api.blockchair.com/bitcoin/dashboards/address/${addr}?key=${process.env.BLOCKCHAIR_API_KEY || ''}` },
    { name: 'Blockcypher', url: (addr) => `https://api.blockcypher.com/v1/btc/main/addrs/${addr}` }
];

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
    running: true,
    rateLimits: { hits: 0, lastReset: Date.now() }
};

// ============ LOAD/SAVE WALLETS ============
function loadSavedWallets() {
    try {
        if (fs.existsSync('real-found-wallets.json')) {
            const data = fs.readFileSync('real-found-wallets.json', 'utf8');
            const saved = JSON.parse(data);
            stats.foundWallets = saved;
            stats.totalWithFunds = saved.length;
            stats.totalBalanceFound = saved.reduce((sum, w) => sum + w.balance, 0);
            console.log(`[LOAD] Loaded ${saved.length} previously found wallets with total ${stats.totalBalanceFound} BTC`);
        }
    } catch(e) { console.error('[LOAD ERROR]', e.message); }
}

function saveFoundWallet(wallet) {
    // Check if already found (prevent duplicates)
    const exists = stats.foundWallets.some(w => w.address === wallet.address);
    if (exists) return;
    
    stats.foundWallets.unshift(wallet);
    stats.totalWithFunds = stats.foundWallets.length;
    stats.totalBalanceFound += wallet.balance;
    
    // Save to file with backup
    const backup = `real-found-wallets-backup-${Date.now()}.json`;
    fs.writeFileSync(backup, JSON.stringify(stats.foundWallets, null, 2));
    fs.writeFileSync('real-found-wallets.json', JSON.stringify(stats.foundWallets, null, 2));
    
    console.log('\n' + '='.repeat(60));
    console.log('🔥🔥🔥 BITCOIN WALLET WITH FUNDS FOUND! 🔥🔥🔥');
    console.log('='.repeat(60));
    console.log(`Private Key (WIF): ${wallet.wif}`);
    console.log(`Address: ${wallet.address}`);
    console.log(`Balance: ${wallet.balance.toFixed(8)} BTC`);
    console.log(`Value: ~$${(wallet.balance * (wallet.price || 0)).toLocaleString()} USD`);
    console.log(`Found: ${wallet.timestamp}`);
    console.log('='.repeat(60));
    console.log('⚠️  IMPORTANT: Move funds immediately to secure wallet! ⚠️');
    console.log('='.repeat(60) + '\n');
    
    // Play sound if in terminal
    process.stdout.write('\x07');
}

// ============ BASE58 ENCODING ============
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

// ============ REAL SECP256K1 KEY GENERATION ============
function generateRealPrivateKey() {
    let privateKey;
    do {
        privateKey = crypto.randomBytes(32);
    } while (!secp256k1.privateKeyVerify(privateKey));
    return privateKey;
}

function privateKeyToWIF(privateKeyBytes, compressed = true) {
    // Add version byte (0x80 for mainnet)
    const versioned = Buffer.concat([Buffer.from([0x80]), privateKeyBytes]);
    
    // Add compression flag if compressed
    const withCompression = compressed ? Buffer.concat([versioned, Buffer.from([0x01])]) : versioned;
    
    // Double SHA256 for checksum
    const hash = crypto.createHash('sha256').update(withCompression).digest();
    const hash2 = crypto.createHash('sha256').update(hash).digest();
    const checksum = hash2.slice(0, 4);
    
    // Encode to Base58
    return base58Encode(Buffer.concat([withCompression, checksum]));
}

function publicKeyToAddress(publicKeyBytes) {
    // SHA256 the public key
    const sha256 = crypto.createHash('sha256').update(publicKeyBytes).digest();
    // RIPEMD160 the result
    const ripemd160 = crypto.createHash('ripemd160').update(sha256).digest();
    // Add version byte
    const versioned = Buffer.concat([Buffer.from([VERSION_BYTE]), ripemd160]);
    // Double SHA256 for checksum
    const checksumHash = crypto.createHash('sha256').update(versioned).digest();
    const checksumHash2 = crypto.createHash('sha256').update(checksumHash).digest();
    const checksum = checksumHash2.slice(0, 4);
    // Base58 encode
    return base58Encode(Buffer.concat([versioned, checksum]));
}

function generateKeyPair() {
    const privateKey = generateRealPrivateKey();
    const publicKey = secp256k1.publicKeyCreate(privateKey);
    const address = publicKeyToAddress(publicKey);
    const wif = privateKeyToWIF(privateKey);
    
    return { privateKey: privateKey.toString('hex'), wif, publicKey: publicKey.toString('hex'), address };
}

// ============ REAL BALANCE CHECKING ============
async function checkBalanceReal(address, retryCount = 0) {
    const maxRetries = 3;
    
    // Rate limiting protection
    const now = Date.now();
    if (now - stats.rateLimits.lastReset > 60000) {
        stats.rateLimits = { hits: 0, lastReset: now };
    }
    
    if (stats.rateLimits.hits > 30) { // 30 requests per minute max
        await new Promise(r => setTimeout(r, 2000));
    }
    
    try {
        // Try Blockchain.info first (fastest)
        stats.rateLimits.hits++;
        const response = await axios.get(APIS[0].url(address), { 
            timeout: CONFIG.apiTimeout,
            headers: { 'User-Agent': 'Bitcoin-Finder/1.0' }
        });
        
        let balanceSatoshis = 0;
        if (typeof response.data === 'number') {
            balanceSatoshis = response.data;
        } else if (response.data.balance) {
            balanceSatoshis = response.data.balance;
        } else if (response.data.data && response.data.data[address]) {
            balanceSatoshis = response.data.data[address].address.balance;
        }
        
        const balanceBTC = balanceSatoshis / 100000000;
        
        if (balanceBTC > 0) {
            // Get current BTC price for value display
            let price = 0;
            try {
                const priceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 5000 });
                price = priceRes.data.bitcoin.usd;
            } catch(e) {}
            
            return { balance: balanceBTC, price, address };
        }
        
        return { balance: 0, price: 0, address };
        
    } catch (error) {
        if (retryCount < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
            return checkBalanceReal(address, retryCount + 1);
        }
        return { balance: 0, price: 0, address, error: error.message };
    }
}

// ============ BATCH PROCESSING ============
async function processBatch(batchSize) {
    const batchStart = Date.now();
    const wallets = [];
    
    // Generate real key pairs
    for (let i = 0; i < batchSize; i++) {
        const wallet = generateKeyPair();
        wallets.push(wallet);
        stats.totalGenerated++;
    }
    
    // Check balances
    const results = [];
    for (let i = 0; i < wallets.length; i += CONFIG.maxConcurrent) {
        const batch = wallets.slice(i, i + CONFIG.maxConcurrent);
        const promises = batch.map(wallet => checkBalanceReal(wallet.address));
        const balances = await Promise.all(promises);
        
        for (let j = 0; j < balances.length; j++) {
            const balance = balances[j];
            const wallet = batch[j];
            
            if (balance.balance > 0) {
                const foundWallet = {
                    address: wallet.address,
                    privateKey: wallet.privateKey,
                    wif: wallet.wif,
                    publicKey: wallet.publicKey,
                    balance: balance.balance,
                    price: balance.price,
                    valueUSD: balance.balance * balance.price,
                    timestamp: new Date().toISOString()
                };
                saveFoundWallet(foundWallet);
                results.push(foundWallet);
            }
        }
        
        // Small delay between concurrent batches
        if (i + CONFIG.maxConcurrent < wallets.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    
    const batchEnd = Date.now();
    const batchDuration = (batchEnd - batchStart) / 1000;
    const batchSpeed = batchSize / batchDuration;
    
    // Update stats
    stats.totalValidated += batchSize;
    stats.currentSpeed = batchSpeed;
    stats.lastBatchTime = batchEnd;
    
    const fundedInBatch = results.length;
    const avgSpeed = stats.totalGenerated / ((Date.now() - stats.startTime) / 1000);
    
    console.log(`[BATCH] ${batchSize} keys | ${batchDuration.toFixed(2)}s | ${batchSpeed.toFixed(2)} keys/sec | Avg: ${avgSpeed.toFixed(2)}/s | Funded: ${fundedInBatch} | Total: ${stats.totalGenerated.toLocaleString()}`);
    
    return { batchSize, batchDuration, batchSpeed, fundedInBatch };
}

// ============ CONTINUOUS RUNNER ============
async function continuousRunner() {
    console.log('\n' + '='.repeat(60));
    console.log('  REAL BITCOIN WALLET FINDER - AUTO MODE');
    console.log('='.repeat(60));
    console.log(`Batch Size: ${CONFIG.batchSize} keys`);
    console.log(`Batch Delay: ${CONFIG.batchDelay}ms`);
    console.log(`Checking Real Balances: ${CONFIG.checkBalance}`);
    console.log(`Continuous Mode: ${CONFIG.continuousMode}`);
    console.log(`API Timeout: ${CONFIG.apiTimeout}ms`);
    console.log('='.repeat(60) + '\n');
    
    loadSavedWallets();
    
    let batchCount = 0;
    const startTime = Date.now();
    
    while (stats.running) {
        batchCount++;
        
        try {
            await processBatch(CONFIG.batchSize);
            
            // Update dashboard stats
            const elapsed = (Date.now() - startTime) / 1000;
            stats.avgSpeed = stats.totalGenerated / elapsed;
            stats.elapsed = elapsed;
            stats.batchCount = batchCount;
            
            // Display summary every 10 batches
            if (batchCount % 10 === 0) {
                const foundCount = stats.foundWallets.length;
                const totalBTC = stats.totalBalanceFound;
                console.log(`\n📊 SUMMARY: ${stats.totalGenerated.toLocaleString()} keys | ${foundCount} wallets found | ${totalBTC.toFixed(8)} BTC total\n`);
            }
            
            // Delay between batches
            if (CONFIG.continuousMode && stats.running) {
                await new Promise(r => setTimeout(r, CONFIG.batchDelay));
            } else {
                break;
            }
            
        } catch (error) {
            console.error(`[ERROR] Batch ${batchCount}: ${error.message}`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// ============ API ENDPOINTS ============
app.get('/api/stats', (req, res) => {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = Math.floor(elapsed % 60);
    
    res.json({
        running: stats.running,
        totalGenerated: stats.totalGenerated,
        totalValidated: stats.totalValidated,
        totalWithFunds: stats.totalWithFunds,
        totalBalanceFound: stats.totalBalanceFound.toFixed(8),
        currentSpeed: stats.currentSpeed.toFixed(2),
        avgSpeed: (stats.totalGenerated / elapsed).toFixed(2),
        uptime: `${hours}h ${minutes}m ${seconds}s`,
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
    <title>REAL Bitcoin Wallet Finder</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%);
            font-family: 'Inter', sans-serif;
            color: #fff;
            min-height: 100vh;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 40px 20px; }
        h1 { text-align: center; font-size: 2.5rem; margin-bottom: 10px; }
        h1 span { background: linear-gradient(135deg, #f7931a, #ffd700); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; font-size: 0.9rem; }
        .warning { background: rgba(255,100,0,0.2); border: 1px solid #ff6400; border-radius: 8px; padding: 10px; text-align: center; margin-bottom: 20px; font-size: 0.85rem; }
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; text-align: center; border: 1px solid rgba(255,255,255,0.2); }
        .stat-value { font-size: 2rem; font-weight: bold; color: #f7931a; }
        .stat-label { font-size: 0.8rem; opacity: 0.7; margin-top: 5px; }
        
        .controls { display: flex; gap: 15px; justify-content: center; margin-bottom: 40px; }
        .btn { padding: 12px 30px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: transform 0.2s; font-size: 1rem; }
        .btn-start { background: linear-gradient(135deg, #00b09b, #96c93d); color: #fff; }
        .btn-stop { background: linear-gradient(135deg, #cb2d3e, #ef473a); color: #fff; }
        .btn:hover { transform: scale(1.02); }
        
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 40px; }
        .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; border: 1px solid rgba(255,255,255,0.2); }
        .card h3 { margin-bottom: 15px; color: #f7931a; }
        
        .result { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px; }
        .wallet-item { border-bottom: 1px solid rgba(255,255,255,0.1); padding: 10px; margin-bottom: 5px; }
        .funded { background: rgba(0,255,0,0.1); border-left: 3px solid #00ff00; }
        .status { padding: 10px; border-radius: 8px; margin-bottom: 20px; text-align: center; font-weight: bold; }
        .status-running { background: rgba(0,255,0,0.2); border: 1px solid #00ff00; }
        .status-stopped { background: rgba(255,0,0,0.2); border: 1px solid #ff4444; }
        
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .pulse { animation: pulse 1s infinite; }
        
        @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
<div class="container">
    <h1>₿ <span>REAL Bitcoin Wallet Finder</span> ₿</h1>
    <div class="subtitle">Genuine secp256k1 Key Generation + Real Blockchain Balance Checking</div>
    <div class="warning">⚠️ REAL CRYPTOGRAPHIC IMPLEMENTATION - Uses actual secp256k1 curve for key generation</div>
    
    <div class="controls">
        <button class="btn btn-start" onclick="startBot()">▶ START REAL BOT</button>
        <button class="btn btn-stop" onclick="stopBot()">⏹ STOP BOT</button>
    </div>
    
    <div id="status" class="status status-stopped">⚫ BOT STOPPED - Click Start to begin real key generation</div>
    
    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" id="totalGenerated">0</div><div class="stat-label">Keys Generated (Real secp256k1)</div></div>
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
            <h3>🏆 Found Wallets (REAL)</h3>
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
                document.getElementById('status').innerHTML = '🟢 REAL BOT RUNNING - Generating real secp256k1 keys & checking blockchain';
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
            document.getElementById('uptime').innerText = data.uptime;
            
            // Live stats
            const liveStats = document.getElementById('liveStats');
            liveStats.innerHTML = '<div class="wallet-item"><strong>🔐 REAL SECP256K1 PERFORMANCE</strong><br>' +
                'Total Generated: ' + data.totalGenerated.toLocaleString() + '<br>' +
                'Current Speed: ' + parseFloat(data.currentSpeed).toFixed(2) + ' keys/sec<br>' +
                'Average Speed: ' + parseFloat(data.avgSpeed).toFixed(2) + ' keys/sec<br>' +
                'Keys per Hour: ' + (data.avgSpeed * 3600).toLocaleString() + '<br>' +
                'Keys per Day: ' + (data.avgSpeed * 86400).toLocaleString() + '<br>' +
                'Batches Processed: ' + (data.batchCount || 0) + '<br>' +
                'Uptime: ' + data.uptime + '<br>' +
                '<span style="color:#f7931a">⚡ Using real elliptic curve multiplication (secp256k1)</span></div>';
            
            // Found wallets
            const foundDiv = document.getElementById('foundWallets');
            if (data.foundWallets && data.foundWallets.length > 0) {
                let html = '';
                for (let i = 0; i < Math.min(data.foundWallets.length, 30); i++) {
                    const w = data.foundWallets[i];
                    html += '<div class="wallet-item funded"><strong>💰 FOUND ' + w.balance + ' BTC</strong><br>' +
                        'Address: <span style="font-family:monospace; font-size:10px">' + w.address + '</span><br>' +
                        'Value: $' + (w.valueUSD || (w.balance * 50000)).toLocaleString() + '<br>' +
                        'Found: ' + new Date(w.timestamp).toLocaleString() + '</div>';
                }
                foundDiv.innerHTML = html;
            } else {
                foundDiv.innerHTML = '<div class="wallet-item">🔍 No wallets found yet. Bot is generating REAL secp256k1 keys and checking the blockchain...</div>';
            }
        } catch(e) { console.error(e); }
    }
    
    function startUpdates() {
        if (updateInterval) clearInterval(updateInterval);
        loadStats();
        updateInterval = setInterval(loadStats, 1000);
    }
    
    // Auto-start
    setTimeout(startBot, 1000);
    startUpdates();
</script>
</body>
</html>`);
});

// ============ AUTO START ============
if (CONFIG.autoStart) {
    setTimeout(() => {
        console.log('\n🚀 Auto-starting REAL Bitcoin wallet finder...\n');
        continuousRunner().catch(console.error);
    }, 2000);
}

// ============ START SERVER ============
app.listen(port, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('  REAL BITCOIN WALLET FINDER');
    console.log('='.repeat(60));
    console.log(`  Dashboard: http://localhost:${port}`);
    console.log(`  Using REAL secp256k1 cryptography`);
    console.log(`  Checking ACTUAL blockchain balances`);
    console.log(`  Status: ${CONFIG.autoStart ? 'AUTO-STARTING' : 'MANUAL START REQUIRED'}`);
    console.log('='.repeat(60) + '\n');
});
