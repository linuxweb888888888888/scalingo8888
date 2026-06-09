// bitcoin-keygen-server.js - Complete Bitcoin Key Generator with Web Dashboard
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const os = require('os');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ============ SECP256K1 CURVE PARAMETERS ============
const SECP256K1 = {
    ORDER: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'),
    G: {
        x: BigInt('0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798'),
        y: BigInt('0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8')
    },
    P: BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F')
};

// ============ METRICS STORAGE ============
let metrics = {
    totalKeysGenerated: 0,
    totalKeysValidated: 0,
    totalKeysWithFunds: 0,
    totalBalanceFound: 0,
    generationSpeed: 0,
    validationSpeed: 0,
    startTime: Date.now(),
    recentKeys: [],
    foundWallets: [],
    generationHistory: [],
    validationHistory: []
};

// ============ ELLIPTIC CURVE MATH ============
function modInverse(a, m) {
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    let [old_t, t] = [0n, 1n];
    
    while (r !== 0n) {
        const quotient = old_r / r;
        [old_r, r] = [r, old_r - quotient * r];
        [old_s, s] = [s, old_s - quotient * s];
        [old_t, t] = [t, old_t - quotient * t];
    }
    
    return (old_s % m + m) % m;
}

function pointAdd(p1, p2) {
    if (p1 === null) return p2;
    if (p2 === null) return p1;
    
    const [x1, y1] = [p1.x, p1.y];
    const [x2, y2] = [p2.x, p2.y];
    
    if (x1 === x2 && y1 === y2) {
        const slope = (3n * x1 * x1) * modInverse(2n * y1, SECP256K1.P) % SECP256K1.P;
        const x3 = (slope * slope - 2n * x1) % SECP256K1.P;
        const y3 = (slope * (x1 - x3) - y1) % SECP256K1.P;
        return { x: (x3 + SECP256K1.P) % SECP256K1.P, y: (y3 + SECP256K1.P) % SECP256K1.P };
    } else {
        const slope = (y2 - y1) * modInverse(x2 - x1, SECP256K1.P) % SECP256K1.P;
        const x3 = (slope * slope - x1 - x2) % SECP256K1.P;
        const y3 = (slope * (x1 - x3) - y1) % SECP256K1.P;
        return { x: (x3 + SECP256K1.P) % SECP256K1.P, y: (y3 + SECP256K1.P) % SECP256K1.P };
    }
}

function pointMultiply(k, point) {
    let result = null;
    let addend = point;
    let scalar = k;
    
    while (scalar > 0n) {
        if (scalar & 1n) result = pointAdd(result, addend);
        addend = pointAdd(addend, addend);
        scalar >>= 1n;
    }
    return result;
}

// ============ ADDRESS GENERATION ============
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
    let attempts = 0;
    
    do {
        const privateKeyBytes = crypto.randomBytes(32);
        privateKeyHex = privateKeyBytes.toString('hex');
        const privateKeyBigInt = BigInt('0x' + privateKeyHex);
        attempts++;
        
        if (privateKeyBigInt !== 0n && privateKeyBigInt < SECP256K1.ORDER) {
            break;
        }
    } while (true);
    
    return privateKeyHex;
}

function privateKeyToPublicKey(privateKeyHex) {
    const privateKeyBigInt = BigInt('0x' + privateKeyHex);
    const publicKeyPoint = pointMultiply(privateKeyBigInt, SECP256K1.G);
    
    const xHex = publicKeyPoint.x.toString(16).padStart(64, '0');
    const yHex = publicKeyPoint.y.toString(16).padStart(64, '0');
    const prefix = (publicKeyPoint.y & 1n) === 0n ? '02' : '03';
    const compressed = prefix + xHex;
    
    return { compressed, x: xHex, y: yHex };
}

function publicKeyToAddress(publicKeyHex) {
    const publicKeyBuffer = Buffer.from(publicKeyHex, 'hex');
    const hash160Buffer = hash160(publicKeyBuffer);
    const versionedBuffer = Buffer.concat([Buffer.from([0x00]), hash160Buffer]);
    const checksum = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(versionedBuffer).digest())
        .digest()
        .slice(0, 4);
    const addressBuffer = Buffer.concat([versionedBuffer, checksum]);
    return base58Encode(addressBuffer);
}

function privateKeyToAddress(privateKeyHex) {
    const publicKey = privateKeyToPublicKey(privateKeyHex);
    return publicKeyToAddress(publicKey.compressed);
}

// ============ VALIDATION FUNCTIONS ============
function validatePrivateKeyFormat(privateKeyHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
        return { valid: false, reason: 'Invalid hex format (must be 64 characters)' };
    }
    
    const privateKeyBigInt = BigInt('0x' + privateKeyHex);
    
    if (privateKeyBigInt === 0n) {
        return { valid: false, reason: 'Private key cannot be zero' };
    }
    
    if (privateKeyBigInt >= SECP256K1.ORDER) {
        return { valid: false, reason: 'Private key exceeds curve order' };
    }
    
    return { valid: true };
}

function validateAddressFormat(address) {
    try {
        if (!address || typeof address !== 'string') return { valid: false, reason: 'Invalid address string' };
        
        let num = 0n;
        for (const char of address) {
            const idx = BASE58_ALPHABET.indexOf(char);
            if (idx === -1) return { valid: false, reason: 'Invalid character in address' };
            num = num * 58n + BigInt(idx);
        }
        
        const bytes = [];
        while (num > 0n) {
            bytes.unshift(Number(num & 0xFFn));
            num >>= 8n;
        }
        
        for (const char of address) {
            if (char === '1') bytes.unshift(0);
            else break;
        }
        
        const buffer = Buffer.from(bytes);
        
        if (buffer.length !== 25) return { valid: false, reason: 'Invalid address length' };
        if (buffer[0] !== 0x00) return { valid: false, reason: 'Not a mainnet address' };
        
        const payload = buffer.slice(0, 21);
        const checksum = buffer.slice(21, 25);
        const calculatedChecksum = crypto.createHash('sha256')
            .update(crypto.createHash('sha256').update(payload).digest())
            .digest()
            .slice(0, 4);
        
        if (!checksum.equals(calculatedChecksum)) return { valid: false, reason: 'Invalid checksum' };
        
        return { valid: true, hash160: payload.slice(1).toString('hex') };
    } catch (error) {
        return { valid: false, reason: error.message };
    }
}

async function checkWalletBalance(address) {
    try {
        const response = await axios.get('https://blockchain.info/q/addressbalance/' + address, { timeout: 10000 });
        const balanceSatoshis = response.data;
        const balanceBTC = balanceSatoshis / 100000000;
        
        return { hasFunds: balanceBTC > 0, balanceBTC: balanceBTC, balanceSatoshis: balanceSatoshis, address: address };
    } catch (error) {
        return { hasFunds: false, balanceBTC: 0, balanceSatoshis: 0, address: address, error: error.message };
    }
}

// ============ BULK GENERATION ============
async function generateKeys(count, callback) {
    const startTime = Date.now();
    const keys = [];
    
    for (let i = 0; i < count; i++) {
        const privateKey = generateRandomPrivateKey();
        const address = privateKeyToAddress(privateKey);
        keys.push({ privateKey: privateKey, address: address, index: i + 1 });
        
        if (callback && i % Math.floor(count / 10) === 0) {
            callback({ progress: ((i + 1) / count) * 100, generated: i + 1, total: count });
        }
    }
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const speed = count / duration;
    
    metrics.generationSpeed = speed;
    metrics.generationHistory.unshift({ timestamp: new Date(), count: count, duration: duration, speed: speed });
    if (metrics.generationHistory.length > 50) metrics.generationHistory.pop();
    
    return { keys: keys, duration: duration, speed: speed, count: count };
}

async function validateKeys(keys, checkBalance = true) {
    const startTime = Date.now();
    const results = [];
    let fundedCount = 0;
    let totalBalance = 0;
    
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const privateKey = typeof key === 'string' ? key : key.privateKey;
        
        const formatValid = validatePrivateKeyFormat(privateKey);
        if (!formatValid.valid) {
            results.push({ privateKey: privateKey, valid: false, error: formatValid.reason });
            continue;
        }
        
        const address = privateKeyToAddress(privateKey);
        let balance = null;
        
        if (checkBalance) {
            balance = await checkWalletBalance(address);
            if (balance.hasFunds) {
                fundedCount++;
                totalBalance += balance.balanceBTC;
                metrics.foundWallets.unshift({
                    privateKey: privateKey,
                    address: address,
                    balance: balance.balanceBTC,
                    timestamp: new Date()
                });
                if (metrics.foundWallets.length > 100) metrics.foundWallets.pop();
            }
        }
        
        results.push({
            privateKey: privateKey,
            address: address,
            valid: true,
            hasFunds: balance?.hasFunds || false,
            balanceBTC: balance?.balanceBTC || 0,
            balanceSatoshis: balance?.balanceSatoshis || 0
        });
        
        metrics.totalKeysValidated++;
        if (balance?.hasFunds) {
            metrics.totalKeysWithFunds++;
            metrics.totalBalanceFound += balance.balanceBTC;
        }
        
        if (i % 10 === 0) {
            const progress = ((i + 1) / keys.length) * 100;
            if (callback) callback({ progress: progress, validated: i + 1, total: keys.length, funded: fundedCount });
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const speed = keys.length / duration;
    
    metrics.validationSpeed = speed;
    metrics.validationHistory.unshift({ timestamp: new Date(), count: keys.length, duration: duration, speed: speed, funded: fundedCount });
    if (metrics.validationHistory.length > 50) metrics.validationHistory.pop();
    
    return { results: results, duration: duration, speed: speed, fundedCount: fundedCount, totalBalance: totalBalance };
}

function estimateTimeToFind(countPerSecond) {
    const totalKeyspace = Math.pow(2, 256);
    const yearsToSearchAll = totalKeyspace / (countPerSecond * 365 * 24 * 60 * 60);
    const probabilityPercent = (countPerSecond / totalKeyspace) * 100;
    
    return {
        keysPerSecond: countPerSecond,
        keysPerDay: countPerSecond * 86400,
        keysPerYear: countPerSecond * 31536000,
        yearsToSearchAll: yearsToSearchAll.toExponential(2),
        probabilityPercent: probabilityPercent.toExponential(2)
    };
}

// ============ API ENDPOINTS ============
app.post('/api/generate', async (req, res) => {
    const count = Math.min(req.body.count || 10, 1000);
    
    metrics.totalKeysGenerated += count;
    
    const result = await generateKeys(count);
    
    metrics.recentKeys.unshift(...result.keys.slice(0, 10));
    if (metrics.recentKeys.length > 100) metrics.recentKeys = metrics.recentKeys.slice(0, 100);
    
    res.json({
        success: true,
        keys: result.keys,
        duration: result.duration,
        speed: result.speed,
        count: result.keys.length
    });
});

app.post('/api/validate', async (req, res) => {
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.keys];
    const checkBalance = req.body.checkBalance !== false;
    
    const result = await validateKeys(keys, checkBalance);
    
    res.json({
        success: true,
        results: result.results,
        duration: result.duration,
        speed: result.speed,
        fundedCount: result.fundedCount,
        totalBalance: result.totalBalance
    });
});

app.post('/api/find-wallets', async (req, res) => {
    const count = Math.min(req.body.count || 100, 500);
    const checkBalance = req.body.checkBalance !== false;
    
    const generateResult = await generateKeys(count);
    const privateKeys = generateResult.keys.map(k => k.privateKey);
    const validateResult = await validateKeys(privateKeys, checkBalance);
    
    metrics.totalKeysGenerated += count;
    
    res.json({
        success: true,
        generated: generateResult.keys.length,
        duration: generateResult.duration + validateResult.duration,
        generationSpeed: generateResult.speed,
        validationSpeed: validateResult.speed,
        fundedFound: validateResult.fundedCount,
        totalBalanceFound: validateResult.totalBalance,
        fundedWallets: validateResult.results.filter(r => r.hasFunds)
    });
});

app.post('/api/validate-single', async (req, res) => {
    const privateKey = req.body.privateKey;
    
    const formatValid = validatePrivateKeyFormat(privateKey);
    if (!formatValid.valid) {
        return res.json({ valid: false, error: formatValid.reason });
    }
    
    const address = privateKeyToAddress(privateKey);
    const balance = await checkWalletBalance(address);
    
    metrics.totalKeysValidated++;
    if (balance.hasFunds) {
        metrics.totalKeysWithFunds++;
        metrics.totalBalanceFound += balance.balanceBTC;
        metrics.foundWallets.unshift({
            privateKey: privateKey,
            address: address,
            balance: balance.balanceBTC,
            timestamp: new Date()
        });
    }
    
    res.json({
        valid: true,
        privateKey: privateKey,
        address: address,
        hasFunds: balance.hasFunds,
        balanceBTC: balance.balanceBTC,
        balanceSatoshis: balance.balanceSatoshis
    });
});

app.post('/api/validate-address', async (req, res) => {
    const address = req.body.address;
    
    const formatValid = validateAddressFormat(address);
    if (!formatValid.valid) {
        return res.json({ valid: false, error: formatValid.reason });
    }
    
    const balance = await checkWalletBalance(address);
    
    res.json({
        valid: true,
        address: address,
        hasFunds: balance.hasFunds,
        balanceBTC: balance.balanceBTC,
        balanceSatoshis: balance.balanceSatoshis
    });
});

app.get('/api/metrics', (req, res) => {
    const uptime = (Date.now() - metrics.startTime) / 1000;
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    const uptimeSeconds = Math.floor(uptime % 60);
    
    const estimate = estimateTimeToFind(metrics.generationSpeed || 100);
    
    res.json({
        stats: {
            totalKeysGenerated: metrics.totalKeysGenerated,
            totalKeysValidated: metrics.totalKeysValidated,
            totalKeysWithFunds: metrics.totalKeysWithFunds,
            totalBalanceFound: metrics.totalBalanceFound.toFixed(8),
            generationSpeed: metrics.generationSpeed.toFixed(2),
            validationSpeed: metrics.validationSpeed.toFixed(2),
            uptime: uptimeHours + 'h ' + uptimeMinutes + 'm ' + uptimeSeconds + 's'
        },
        recentKeys: metrics.recentKeys.slice(0, 20),
        foundWallets: metrics.foundWallets.slice(0, 20),
        generationHistory: metrics.generationHistory.slice(0, 20),
        validationHistory: metrics.validationHistory.slice(0, 20),
        estimates: estimate
    });
});

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    res.send('<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>Bitcoin Key Generator & Wallet Finder</title>\n' +
'    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">\n' +
'    <style>\n' +
'        * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'        body {\n' +
'            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);\n' +
'            font-family: "Inter", sans-serif;\n' +
'            color: #fff;\n' +
'            min-height: 100vh;\n' +
'        }\n' +
'        .container { max-width: 1400px; margin: 0 auto; padding: 40px 20px; }\n' +
'        h1 { text-align: center; font-size: 2.5rem; margin-bottom: 10px; }\n' +
'        h1 span { background: linear-gradient(135deg, #00d4ff, #667eea); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n' +
'        .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; }\n' +
'        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }\n' +
'        .stat-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; text-align: center; border: 1px solid rgba(255,255,255,0.2); }\n' +
'        .stat-value { font-size: 2rem; font-weight: bold; color: #00d4ff; }\n' +
'        .stat-label { font-size: 0.8rem; opacity: 0.7; margin-top: 5px; }\n' +
'        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 40px; }\n' +
'        .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 15px; padding: 20px; border: 1px solid rgba(255,255,255,0.2); }\n' +
'        .card h3 { margin-bottom: 15px; color: #00d4ff; }\n' +
'        input, textarea, select { width: 100%; padding: 12px; margin-bottom: 15px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; color: #fff; font-family: monospace; }\n' +
'        button { background: linear-gradient(135deg, #667eea, #764ba2); color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: 600; transition: transform 0.2s; margin-right: 10px; margin-bottom: 10px; }\n' +
'        button:hover { transform: scale(1.02); }\n' +
'        .btn-success { background: linear-gradient(135deg, #4facfe, #00f2fe); }\n' +
'        .result { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; margin-top: 15px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px; }\n' +
'        .key-item { border-bottom: 1px solid rgba(255,255,255,0.1); padding: 10px; margin-bottom: 5px; }\n' +
'        .funded { background: rgba(0,255,0,0.1); border-left: 3px solid #00ff00; }\n' +
'        .progress-bar { width: 100%; height: 20px; background: rgba(255,255,255,0.1); border-radius: 10px; overflow: hidden; margin-top: 10px; }\n' +
'        .progress-fill { height: 100%; background: linear-gradient(90deg, #00d4ff, #667eea); transition: width 0.3s; }\n' +
'        .status { margin-top: 10px; font-size: 12px; }\n' +
'        .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }\n' +
'        .tab { background: rgba(255,255,255,0.1); padding: 10px 20px; border-radius: 8px; cursor: pointer; transition: all 0.2s; }\n' +
'        .tab.active { background: linear-gradient(135deg, #667eea, #764ba2); }\n' +
'        .tab-content { display: none; }\n' +
'        .tab-content.active { display: block; }\n' +
'        @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'<div class="container">\n' +
'    <h1>🔐 <span>Bitcoin Key Generator</span> & Wallet Finder</h1>\n' +
'    <div class="subtitle">Generate, validate, and check Bitcoin private keys for funds</div>\n' +
'    \n' +
'    <div class="stats-grid" id="statsGrid">\n' +
'        <div class="stat-card"><div class="stat-value" id="totalKeys">0</div><div class="stat-label">Keys Generated</div></div>\n' +
'        <div class="stat-card"><div class="stat-value" id="validatedKeys">0</div><div class="stat-label">Keys Validated</div></div>\n' +
'        <div class="stat-card"><div class="stat-value" id="fundsFound">0</div><div class="stat-label">Wallets with Funds</div></div>\n' +
'        <div class="stat-card"><div class="stat-value" id="balanceFound">0 BTC</div><div class="stat-label">Total Balance Found</div></div>\n' +
'        <div class="stat-card"><div class="stat-value" id="genSpeed">0</div><div class="stat-label">Gen Speed (keys/sec)</div></div>\n' +
'        <div class="stat-card"><div class="stat-value" id="valSpeed">0</div><div class="stat-label">Val Speed (keys/sec)</div></div>\n' +
'    </div>\n' +
'    \n' +
'    <div class="tabs">\n' +
'        <div class="tab active" onclick="showTab(\'generate\')">🚀 Generate Keys</div>\n' +
'        <div class="tab" onclick="showTab(\'validate\')">🔍 Validate Keys</div>\n' +
'        <div class="tab" onclick="showTab(\'find\')">💰 Find Wallets</div>\n' +
'        <div class="tab" onclick="showTab(\'single\')">🔑 Single Key</div>\n' +
'        <div class="tab" onclick="showTab(\'found\')">🏆 Found Wallets</div>\n' +
'        <div class="tab" onclick="showTab(\'estimates\')">📊 Estimates</div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-generate" class="tab-content active">\n' +
'        <div class="grid-2">\n' +
'            <div class="card">\n' +
'                <h3>⚙️ Generation Settings</h3>\n' +
'                <label>Number of Keys:</label>\n' +
'                <input type="number" id="genCount" value="100" min="1" max="1000">\n' +
'                <button onclick="generateKeys()">🎲 Generate Keys</button>\n' +
'                <div class="progress-bar"><div class="progress-fill" id="genProgress" style="width:0%"></div></div>\n' +
'                <div class="status" id="genStatus">Ready to generate keys...</div>\n' +
'            </div>\n' +
'            <div class="card">\n' +
'                <h3>📋 Generated Keys</h3>\n' +
'                <div class="result" id="genResult">Click generate to create keys...</div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-validate" class="tab-content">\n' +
'        <div class="grid-2">\n' +
'            <div class="card">\n' +
'                <h3>🔍 Validation Settings</h3>\n' +
'                <label>Enter Private Keys (one per line or comma separated):</label>\n' +
'                <textarea id="validateKeys" rows="5" placeholder="Enter private keys here..."></textarea>\n' +
'                <label><input type="checkbox" id="checkBalance" checked> Check blockchain balance</label>\n' +
'                <button onclick="validateKeys()">🔍 Validate Keys</button>\n' +
'                <div class="progress-bar"><div class="progress-fill" id="valProgress" style="width:0%"></div></div>\n' +
'                <div class="status" id="valStatus">Ready to validate...</div>\n' +
'            </div>\n' +
'            <div class="card">\n' +
'                <h3>📊 Validation Results</h3>\n' +
'                <div class="result" id="valResult">Enter keys to validate...</div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-find" class="tab-content">\n' +
'        <div class="grid-2">\n' +
'            <div class="card">\n' +
'                <h3>💰 Find Wallets with Funds</h3>\n' +
'                <label>Number of Keys to Generate & Check:</label>\n' +
'                <input type="number" id="findCount" value="100" min="1" max="500">\n' +
'                <label><input type="checkbox" id="findCheckBalance" checked> Check blockchain balance</label>\n' +
'                <button onclick="findWallets()" class="btn-success">🚀 Start Finding Wallets</button>\n' +
'                <div class="progress-bar"><div class="progress-fill" id="findProgress" style="width:0%"></div></div>\n' +
'                <div class="status" id="findStatus">Ready to search...</div>\n' +
'            </div>\n' +
'            <div class="card">\n' +
'                <h3>🎯 Wallets Found</h3>\n' +
'                <div class="result" id="findResult">No wallets found yet...</div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-single" class="tab-content">\n' +
'        <div class="grid-2">\n' +
'            <div class="card">\n' +
'                <h3>🔑 Single Key Check</h3>\n' +
'                <label>Private Key (hex):</label>\n' +
'                <input type="text" id="singleKey" placeholder="64 character hex string">\n' +
'                <button onclick="checkSingleKey()">🔍 Check Key</button>\n' +
'            </div>\n' +
'            <div class="card">\n' +
'                <h3>📋 Result</h3>\n' +
'                <div class="result" id="singleResult">Enter a private key to check...</div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-found" class="tab-content">\n' +
'        <div class="card">\n' +
'            <h3>🏆 Wallets Found with Funds</h3>\n' +
'            <div class="result" id="foundWalletsList">No wallets found yet. Run "Find Wallets" to discover funded wallets.</div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <div id="tab-estimates" class="tab-content">\n' +
'        <div class="card">\n' +
'            <h3>📊 Speed & Probability Estimates</h3>\n' +
'            <div class="result" id="estimatesContent">Loading estimates...</div>\n' +
'        </div>\n' +
'    </div>\n' +
'</div>\n' +
'\n' +
'<script>\n' +
'let currentGenerationSpeed = 0;\n' +
'let currentValidationSpeed = 0;\n' +
'\n' +
'function showTab(tab) {\n' +
'    document.querySelectorAll(".tab-content").forEach(function(t) { t.classList.remove("active"); });\n' +
'    document.querySelectorAll(".tab").forEach(function(t) { t.classList.remove("active"); });\n' +
'    document.getElementById("tab-" + tab).classList.add("active");\n' +
'    event.target.classList.add("active");\n' +
'    if (tab === "found") loadFoundWallets();\n' +
'    if (tab === "estimates") loadEstimates();\n' +
'}\n' +
'\n' +
'async function loadMetrics() {\n' +
'    try {\n' +
'        const res = await fetch("/api/metrics");\n' +
'        const data = await res.json();\n' +
'        document.getElementById("totalKeys").innerText = data.stats.totalKeysGenerated.toLocaleString();\n' +
'        document.getElementById("validatedKeys").innerText = data.stats.totalKeysValidated.toLocaleString();\n' +
'        document.getElementById("fundsFound").innerText = data.stats.totalKeysWithFunds.toLocaleString();\n' +
'        document.getElementById("balanceFound").innerText = parseFloat(data.stats.totalBalanceFound).toFixed(8) + " BTC";\n' +
'        document.getElementById("genSpeed").innerText = parseFloat(data.stats.generationSpeed).toFixed(2);\n' +
'        document.getElementById("valSpeed").innerText = parseFloat(data.stats.validationSpeed).toFixed(2);\n' +
'        currentGenerationSpeed = parseFloat(data.stats.generationSpeed);\n' +
'        currentValidationSpeed = parseFloat(data.stats.validationSpeed);\n' +
'    } catch(e) { console.error(e); }\n' +
'}\n' +
'\n' +
'async function generateKeys() {\n' +
'    const count = parseInt(document.getElementById("genCount").value);\n' +
'    const genResult = document.getElementById("genResult");\n' +
'    const genProgress = document.getElementById("genProgress");\n' +
'    const genStatus = document.getElementById("genStatus");\n' +
'    \n' +
'    genStatus.innerText = "Generating " + count + " keys...";\n' +
'    genProgress.style.width = "50%";\n' +
'    \n' +
'    try {\n' +
'        const res = await fetch("/api/generate", {\n' +
'            method: "POST",\n' +
'            headers: { "Content-Type": "application/json" },\n' +
'            body: JSON.stringify({ count: count })\n' +
'        });\n' +
'        const data = await res.json();\n' +
'        genProgress.style.width = "100%";\n' +
'        genStatus.innerText = "✅ Generated " + data.keys.length + " keys in " + data.duration.toFixed(2) + "s (" + data.speed.toFixed(2) + " keys/sec)";\n' +
'        let html = "";\n' +
'        for (let i = 0; i < Math.min(data.keys.length, 20); i++) {\n' +
'            const key = data.keys[i];\n' +
'            html += "<div class=\"key-item\"><strong>#" + key.index + "</strong><br>Private Key: <span style=\"font-family:monospace; font-size:11px\">" + key.privateKey + "</span><br>Address: <span style=\"font-family:monospace; font-size:11px\">" + key.address + "</span></div>";\n' +
'        }\n' +
'        if (data.keys.length > 20) html += "<div>... and " + (data.keys.length - 20) + " more</div>";\n' +
'        genResult.innerHTML = html;\n' +
'        loadMetrics();\n' +
'    } catch(e) {\n' +
'        genStatus.innerText = "❌ Error: " + e.message;\n' +
'    }\n' +
'}\n' +
'\n' +
'async function validateKeys() {\n' +
'    const keysText = document.getElementById("validateKeys").value;\n' +
'    const checkBalance = document.getElementById("checkBalance").checked;\n' +
'    const keys = keysText.split(/[,\\n]/).map(function(k) { return k.trim(); }).filter(function(k) { return k; });\n' +
'    const valResult = document.getElementById("valResult");\n' +
'    const valProgress = document.getElementById("valProgress");\n' +
'    const valStatus = document.getElementById("valStatus");\n' +
'    \n' +
'    if (keys.length === 0) {\n' +
'        valStatus.innerText = "Please enter at least one private key";\n' +
'        return;\n' +
'    }\n' +
'    \n' +
'    valStatus.innerText = "Validating " + keys.length + " keys...";\n' +
'    valProgress.style.width = "50%";\n' +
'    \n' +
'    try {\n' +
'        const res = await fetch("/api/validate", {\n' +
'            method: "POST",\n' +
'            headers: { "Content-Type": "application/json" },\n' +
'            body: JSON.stringify({ keys: keys, checkBalance: checkBalance })\n' +
'        });\n' +
'        const data = await res.json();\n' +
'        valProgress.style.width = "100%";\n' +
'        valStatus.innerText = "✅ Validated " + data.results.length + " keys in " + data.duration.toFixed(2) + "s (" + data.speed.toFixed(2) + " keys/sec) | Funded: " + data.fundedCount + " | Total: " + data.totalBalance.toFixed(8) + " BTC";\n' +
'        let html = "";\n' +
'        for (let i = 0; i < Math.min(data.results.length, 50); i++) {\n' +
'            const result = data.results[i];\n' +
'            const status = result.hasFunds ? "💰 HAS FUNDS!" : (result.valid ? "✅ Valid" : "❌ Invalid");\n' +
'            html += "<div class=\"key-item" + (result.hasFunds ? " funded" : "") + "\"><strong>" + status + "</strong><br>Private Key: <span style=\"font-family:monospace; font-size:10px\">" + result.privateKey + "</span><br>Address: <span style=\"font-family:monospace; font-size:10px\">" + result.address + "</span>" + (result.hasFunds ? "<br><span style=\"color:#00ff00\">💰 Balance: " + result.balanceBTC + " BTC</span>" : "") + "</div>";\n' +
'        }\n' +
'        valResult.innerHTML = html;\n' +
'        loadMetrics();\n' +
'    } catch(e) {\n' +
'        valStatus.innerText = "❌ Error: " + e.message;\n' +
'    }\n' +
'}\n' +
'\n' +
'async function findWallets() {\n' +
'    const count = parseInt(document.getElementById("findCount").value);\n' +
'    const checkBalance = document.getElementById("findCheckBalance").checked;\n' +
'    const findResult = document.getElementById("findResult");\n' +
'    const findProgress = document.getElementById("findProgress");\n' +
'    const findStatus = document.getElementById("findStatus");\n' +
'    \n' +
'    findStatus.innerText = "Generating and checking " + count + " keys...";\n' +
'    findProgress.style.width = "30%";\n' +
'    \n' +
'    try {\n' +
'        const res = await fetch("/api/find-wallets", {\n' +
'            method: "POST",\n' +
'            headers: { "Content-Type": "application/json" },\n' +
'            body: JSON.stringify({ count: count, checkBalance: checkBalance })\n' +
'        });\n' +
'        const data = await res.json();\n' +
'        findProgress.style.width = "100%";\n' +
'        findStatus.innerText = "✅ Found " + data.fundedFound + " wallets with funds! Total balance: " + data.totalBalanceFound.toFixed(8) + " BTC | Speed: " + data.generationSpeed.toFixed(2) + " gen/s, " + data.validationSpeed.toFixed(2) + " val/s";\n' +
'        if (data.fundedFound > 0) {\n' +
'            let html = "";\n' +
'            for (let i = 0; i < Math.min(data.fundedWallets.length, 20); i++) {\n' +
'                const wallet = data.fundedWallets[i];\n' +
'                html += "<div class=\"key-item funded\"><strong>💰 WALLET WITH FUNDS!</strong><br>Private Key: <span style=\"font-family:monospace; font-size:10px\">" + wallet.privateKey + "</span><br>Address: <span style=\"font-family:monospace; font-size:10px\">" + wallet.address + "</span><br><span style=\"color:#00ff00\">Balance: " + wallet.balanceBTC + " BTC</span></div>";\n' +
'            }\n' +
'            findResult.innerHTML = html;\n' +
'        } else {\n' +
'            findResult.innerHTML = "<div class=\"key-item\">No wallets with funds found in this batch. Keep trying!</div>";\n' +
'        }\n' +
'        loadMetrics();\n' +
'        loadFoundWallets();\n' +
'    } catch(e) {\n' +
'        findStatus.innerText = "❌ Error: " + e.message;\n' +
'    }\n' +
'}\n' +
'\n' +
'async function checkSingleKey() {\n' +
'    const privateKey = document.getElementById("singleKey").value.trim();\n' +
'    const singleResult = document.getElementById("singleResult");\n' +
'    \n' +
'    if (!privateKey) {\n' +
'        singleResult.innerHTML = "<div class=\"key-item\">Please enter a private key</div>";\n' +
'        return;\n' +
'    }\n' +
'    \n' +
'    singleResult.innerHTML = "<div class=\"key-item\">Checking...</div>";\n' +
'    \n' +
'    try {\n' +
'        const res = await fetch("/api/validate-single", {\n' +
'            method: "POST",\n' +
'            headers: { "Content-Type": "application/json" },\n' +
'            body: JSON.stringify({ privateKey: privateKey })\n' +
'        });\n' +
'        const data = await res.json();\n' +
'        if (data.valid) {\n' +
'            singleResult.innerHTML = "<div class=\"key-item" + (data.hasFunds ? " funded" : "") + "\"><strong>" + (data.hasFunds ? "💰 VALID WALLET WITH FUNDS!" : "✅ Valid private key") + "</strong><br>Private Key: <span style=\"font-family:monospace; font-size:11px\">" + data.privateKey + "</span><br>Address: <span style=\"font-family:monospace; font-size:11px\">" + data.address + "</span>" + (data.hasFunds ? "<br><span style=\"color:#00ff00\">💰 Balance: " + data.balanceBTC + " BTC (" + data.balanceSatoshis.toLocaleString() + " satoshis)</span>" : "<br>No funds found on this address") + "</div>";\n' +
'        } else {\n' +
'            singleResult.innerHTML = "<div class=\"key-item\">❌ Invalid private key: " + data.error + "</div>";\n' +
'        }\n' +
'        loadMetrics();\n' +
'    } catch(e) {\n' +
'        singleResult.innerHTML = "<div class=\"key-item\">❌ Error: " + e.message + "</div>";\n' +
'    }\n' +
'}\n' +
'\n' +
'async function loadFoundWallets() {\n' +
'    try {\n' +
'        const res = await fetch("/api/metrics");\n' +
'        const data = await res.json();\n' +
'        const found = document.getElementById("foundWalletsList");\n' +
'        if (data.foundWallets && data.foundWallets.length > 0) {\n' +
'            let html = "";\n' +
'            for (let i = 0; i < data.foundWallets.length; i++) {\n' +
'                const wallet = data.foundWallets[i];\n' +
'                html += "<div class=\"key-item funded\"><strong>💰 FOUND " + wallet.balance + " BTC</strong><br>Private Key: <span style=\"font-family:monospace; font-size:10px\">" + wallet.privateKey + "</span><br>Address: <span style=\"font-family:monospace; font-size:10px\">" + wallet.address + "</span><br>Found: " + new Date(wallet.timestamp).toLocaleString() + "</div>";\n' +
'            }\n' +
'            found.innerHTML = html;\n' +
'        } else {\n' +
'            found.innerHTML = "<div class=\"key-item\">No wallets found yet. Run \"Find Wallets\" to search.</div>";\n' +
'        }\n' +
'    } catch(e) { console.error(e); }\n' +
'}\n' +
'\n' +
'async function loadEstimates() {\n' +
'    try {\n' +
'        const res = await fetch("/api/metrics");\n' +
'        const data = await res.json();\n' +
'        const est = data.estimates;\n' +
'        const estimatesDiv = document.getElementById("estimatesContent");\n' +
'        estimatesDiv.innerHTML = "<div class=\"key-item\"><strong>📊 CURRENT PERFORMANCE</strong><br>Generation Speed: " + (data.stats.generationSpeed || 0) + " keys/sec<br>Validation Speed: " + (data.stats.validationSpeed || 0) + " keys/sec<br>Total Keys Generated: " + data.stats.totalKeysGenerated.toLocaleString() + "<br>Total Keys Validated: " + data.stats.totalKeysValidated.toLocaleString() + "</div><div class=\"key-item\"><strong>⏱️ TIME ESTIMATES</strong><br>Keys per Day: " + (est.keysPerDay || 0).toLocaleString() + "<br>Keys per Year: " + (est.keysPerYear || 0).toExponential(2) + "<br>Years to search all possible keys: " + (est.yearsToSearchAll || "N/A") + "<br>Probability per key: " + (est.probabilityPercent || "N/A") + "%</div><div class=\"key-item\"><strong>💡 REALITY CHECK</strong><br>Total possible Bitcoin private keys: ~2^256 (1.16e77)<br>This is more than the number of atoms in the universe.<br>Finding a key with funds is statistically impossible.<br>This tool is for educational purposes only.</div>";\n' +
'    } catch(e) { console.error(e); }\n' +
'}\n' +
'\n' +
'setInterval(loadMetrics, 5000);\n' +
'loadMetrics();\n' +
'</script>\n' +
'</body>\n' +
'</html>');
});

// ============ START SERVER ============
app.listen(port, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('  Bitcoin Key Generator & Wallet Finder');
    console.log('========================================');
    console.log('  Dashboard: http://localhost:' + port);
    console.log('  API Base:   http://localhost:' + port + '/api/');
    console.log('========================================\n');
});
