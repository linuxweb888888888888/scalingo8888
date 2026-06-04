// bot.js - FaucetPay Bot with iFrame Dashboard & Session Capture
const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ CONFIGURATION ============
const USER_DATA_DIR = process.env.USER_DATA_DIR || './chrome-profile';
const SESSION_FILE = path.join(__dirname, 'session.json');

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    startTime: new Date(),
    loggedIn: false,
    sourceBalances: {
        'Daily Bonus': { earned: 0, claims: 0, lastClaim: null },
        'Faucet List': { earned: 0, claims: 0, lastClaim: null },
        'Offerwalls': { earned: 0, claims: 0, lastClaim: null },
        'PTC Ads': { earned: 0, claims: 0, lastClaim: null },
        'Staking': { earned: 0, claims: 0, lastClaim: null },
        'Tasks': { earned: 0, claims: 0, lastClaim: null }
    },
    claimHistory: []
};

let browser = null;
let page = null;
let botRunning = false;
let loginEmail = '';

// ============ SESSION MANAGEMENT ============
function saveSession(cookies) {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
        console.log(`✅ Session saved to ${SESSION_FILE}`);
        return true;
    } catch (error) {
        console.error(`Failed to save session: ${error.message}`);
        return false;
    }
}

function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            console.log(`✅ Loaded ${cookies.length} cookies from session`);
            return cookies;
        }
    } catch (error) {
        console.error(`Failed to load session: ${error.message}`);
    }
    return null;
}

// ============ BROWSER LAUNCH ============
async function launchBrowser() {
    console.log('🚀 Launching browser...');
    
    const executablePath = await chromium.executablePath;
    console.log(`📁 Chrome path: ${executablePath}`);
    
    browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath,
        headless: true,
        ignoreHTTPSErrors: true,
    });
    
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    return page;
}

// ============ COOKIE SYNC ============
async function syncCookiesToBrowser(cookies) {
    if (!cookies || !page) return false;
    try {
        await page.setCookie(...cookies);
        console.log(`✅ Synced ${cookies.length} cookies to browser`);
        return true;
    } catch (error) {
        console.error(`Failed to sync cookies: ${error.message}`);
        return false;
    }
}

// ============ DASHBOARD HTML WITH IFRAME ============
const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Bot - iFrame Dashboard</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%); 
            font-family: 'Segoe UI', monospace; 
            min-height: 100vh; 
            color: #00ff88; 
            padding: 20px;
        }
        .container { max-width: 1600px; margin: 0 auto; }
        
        h1 { text-align: center; margin-bottom: 20px; font-size: 28px; }
        h1 span { background: #00ff88; color: #0a0e27; padding: 5px 15px; border-radius: 20px; font-size: 14px; margin-left: 10px; }
        
        .dashboard-layout { display: flex; gap: 20px; flex-wrap: wrap; }
        .iframe-panel { flex: 2; min-width: 600px; }
        .stats-panel { flex: 1; min-width: 300px; }
        
        .card { 
            background: rgba(26,31,58,0.95); 
            border-radius: 15px; 
            padding: 20px; 
            margin-bottom: 20px; 
            border: 1px solid #00ff88;
            backdrop-filter: blur(10px);
        }
        .card h2 { 
            margin-bottom: 15px; 
            font-size: 18px; 
            border-bottom: 1px solid #00ff88; 
            padding-bottom: 8px; 
            display: flex; 
            align-items: center; 
            gap: 10px; 
        }
        
        .faucet-iframe {
            width: 100%;
            height: 600px;
            border: 2px solid #00ff88;
            border-radius: 10px;
            background: white;
        }
        
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 20px; }
        .stat-card { 
            background: #0a0e27; 
            padding: 15px; 
            border-radius: 10px; 
            text-align: center; 
            border: 1px solid #00ff88;
        }
        .stat-value { font-size: 24px; font-weight: bold; color: #00ff88; }
        .stat-label { font-size: 10px; opacity: 0.7; margin-top: 5px; }
        
        .btn-group { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
        button { 
            padding: 10px 20px; 
            background: #00ff88; 
            color: #0a0e27; 
            border: none; 
            border-radius: 8px; 
            cursor: pointer; 
            font-weight: bold; 
            font-family: monospace;
            transition: all 0.3s;
            flex: 1;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(0,255,136,0.4); }
        button.danger { background: #ff4444; color: white; }
        button.warning { background: #ffaa00; color: #0a0e27; }
        button.secondary { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        
        .status-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(0,255,136,0.2); }
        .status-label { opacity: 0.7; }
        .status-value { font-weight: bold; }
        
        .table-container { max-height: 300px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid rgba(0,255,136,0.2); font-size: 11px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .error { color: #ff4444; }
        
        .loading { 
            display: inline-block; 
            width: 16px; 
            height: 16px; 
            border: 2px solid #00ff88; 
            border-top-color: transparent; 
            border-radius: 50%; 
            animation: spin 1s linear infinite; 
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; }
        .badge-success { background: #00ff88; color: #0a0e27; }
        .badge-warning { background: #ffaa00; color: #0a0e27; }
        
        .log-area {
            background: #0a0e27;
            border-radius: 8px;
            padding: 10px;
            font-size: 11px;
            font-family: monospace;
            max-height: 200px;
            overflow-y: auto;
            color: #00ff88;
        }
        
        @media (max-width: 1024px) {
            .dashboard-layout { flex-direction: column; }
            .iframe-panel { min-width: auto; }
        }
    </style>
</head>
<body>
<div class="container">
    <h1>💰 FaucetPay Bot <span>iFrame Dashboard</span></h1>
    
    <div class="dashboard-layout">
        <!-- Left Panel: iFrame -->
        <div class="iframe-panel">
            <div class="card">
                <h2>
                    <span>🌐</span> Login to FaucetPay
                    <button onclick="refreshIframe()" class="secondary" style="margin-left: auto; padding: 5px 10px; font-size: 12px;">🔄 Refresh</button>
                </h2>
                <iframe id="faucetIframe" class="faucet-iframe" src="https://faucetpay.io/login"></iframe>
                <div style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
                    <button onclick="detectLogin()" style="flex: 1;">🔍 Detect Login Status</button>
                    <button onclick="captureSession()" style="flex: 1;">💾 Capture & Save Session</button>
                </div>
                <div id="iframeMsg" style="margin-top: 10px; font-size: 12px; text-align: center;"></div>
            </div>
        </div>
        
        <!-- Right Panel: Stats & Controls -->
        <div class="stats-panel">
            <div class="card">
                <h2>📊 Bot Status</h2>
                <div class="status-item">
                    <span class="status-label">Bot Status:</span>
                    <span class="status-value" id="botStatus">⭕ Stopped</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Login Status:</span>
                    <span class="status-value" id="loginStatus">❌ Not logged in</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Session Saved:</span>
                    <span class="status-value" id="sessionStatus">❌ No</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Balance:</span>
                    <span class="status-value earn" id="balance">$0.00000</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Total Earned:</span>
                    <span class="status-value earn" id="totalEarned">$0.00000</span>
                </div>
                <div class="status-item">
                    <span class="status-label">Total Claims:</span>
                    <span class="status-value" id="totalClaims">0</span>
                </div>
            </div>
            
            <div class="card">
                <h2>🎮 Controls</h2>
                <div class="btn-group">
                    <button id="startBtn" onclick="startBot()" class="success">▶️ Start Bot</button>
                    <button id="stopBtn" onclick="stopBot()" class="danger" disabled>⏹️ Stop Bot</button>
                </div>
                <div class="btn-group">
                    <button onclick="syncSessionToBot()" class="secondary">🔄 Sync Session to Bot</button>
                    <button onclick="clearSession()" class="warning">🗑️ Clear Session</button>
                </div>
            </div>
            
            <div class="card">
                <h2>📈 Quick Stats</h2>
                <div class="stats-grid">
                    <div class="stat-card"><div class="stat-value" id="hourlyRate">$0</div><div class="stat-label">/Hour</div></div>
                    <div class="stat-card"><div class="stat-value" id="dailyRate">$0</div><div class="stat-label">/Day</div></div>
                </div>
            </div>
            
            <div class="card">
                <h2>🪙 Source Balances</h2>
                <div class="table-container">
                    <table id="balancesTable">
                        <thead><tr><th>Source</th><th>Earned</th><th>Claims</th></tr></thead>
                        <tbody id="balancesBody"><tr><td colspan="3">No data...</td></tr></tbody>
                    </table>
                </div>
            </div>
            
            <div class="card">
                <h2>📝 Recent Activity</h2>
                <div class="log-area" id="logArea">
                    [INFO] Bot ready. Login via iFrame above.<br>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
    let refreshInterval = null;
    
    function addLog(message) {
        const logArea = document.getElementById('logArea');
        const time = new Date().toLocaleTimeString();
        logArea.innerHTML += `[${time}] ${message}<br>`;
        logArea.scrollTop = logArea.scrollHeight;
        // Keep only last 50 lines
        const lines = logArea.innerHTML.split('<br>');
        if (lines.length > 50) {
            logArea.innerHTML = lines.slice(-50).join('<br>');
        }
    }
    
    function refreshIframe() {
        const iframe = document.getElementById('faucetIframe');
        iframe.src = iframe.src;
        addLog('🔄 iFrame refreshed');
    }
    
    async function detectLogin() {
        const iframe = document.getElementById('faucetIframe');
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        
        const url = iframeDoc.location.href;
        addLog(`🔍 Detecting login status: ${url}`);
        
        if (!url.includes('login')) {
            document.getElementById('loginStatus').innerHTML = '✅ Logged in!';
            document.getElementById('sessionStatus').innerHTML = '⚠️ Capture to save';
            addLog('✅ Detected logged in status! Click "Capture & Save Session" to save.');
            
            // Get cookies from iframe
            const cookies = iframeDoc.cookie;
            if (cookies) {
                addLog(`📝 Found cookies: ${cookies.substring(0, 100)}...`);
            }
        } else {
            document.getElementById('loginStatus').innerHTML = '❌ Not logged in';
            addLog('❌ Not logged in. Please login in the iFrame.');
        }
    }
    
    async function captureSession() {
        addLog('📸 Capturing session from iFrame...');
        
        const iframe = document.getElementById('faucetIframe');
        const iframeWin = iframe.contentWindow;
        
        try {
            // Get all cookies from the iframe
            const cookies = iframeWin.document.cookie;
            
            // Get localStorage
            const localStorage = iframeWin.localStorage;
            const storageData = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                storageData[key] = localStorage.getItem(key);
            }
            
            const sessionData = {
                cookies: cookies,
                localStorage: storageData,
                url: iframeWin.location.href,
                timestamp: new Date().toISOString()
            };
            
            const response = await fetch('/api/capture-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sessionData)
            });
            
            const result = await response.json();
            
            if (result.success) {
                addLog('✅ Session captured and saved successfully!');
                document.getElementById('sessionStatus').innerHTML = '✅ Saved';
                document.getElementById('loginStatus').innerHTML = '✅ Session saved';
            } else {
                addLog('❌ Failed to save session: ' + result.message);
            }
        } catch (error) {
            addLog('❌ Error capturing session: ' + error.message);
            addLog('⚠️ Due to CORS, manual cookie entry may be needed');
        }
    }
    
    async function syncSessionToBot() {
        addLog('🔄 Syncing saved session to bot...');
        
        const response = await fetch('/api/sync-session', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            addLog('✅ Session synced to bot successfully!');
            document.getElementById('loginStatus').innerHTML = '✅ Bot logged in';
            updateStats();
        } else {
            addLog('❌ Failed to sync session: ' + result.message);
        }
    }
    
    async function clearSession() {
        addLog('🗑️ Clearing saved session...');
        
        const response = await fetch('/api/clear-session', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            addLog('✅ Session cleared');
            document.getElementById('sessionStatus').innerHTML = '❌ No';
            document.getElementById('loginStatus').innerHTML = '❌ Not logged in';
        }
    }
    
    async function updateStats() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            document.getElementById('loginStatus').innerHTML = data.loggedIn ? '✅ Logged in' : '❌ Not logged in';
            document.getElementById('balance').innerHTML = '$' + (data.balance || 0).toFixed(5);
            document.getElementById('totalEarned').innerHTML = '$' + (data.stats?.totalEarned || 0).toFixed(5);
            document.getElementById('totalClaims').innerHTML = data.stats?.totalActions || 0;
            document.getElementById('botStatus').innerHTML = data.botRunning ? '🟢 Running' : '⭕ Stopped';
            
            const statsRes = await fetch('/api/stats');
            const statsData = await statsRes.json();
            document.getElementById('hourlyRate').innerHTML = '$' + (statsData.hourlyRate || 0);
            document.getElementById('dailyRate').innerHTML = '$' + (statsData.dailyRate || 0);
            
            // Update source balances
            if (statsData.sourceBalances) {
                const balancesBody = document.getElementById('balancesBody');
                balancesBody.innerHTML = '';
                for (const [name, data] of Object.entries(statsData.sourceBalances)) {
                    if (data.earned > 0 || data.claims > 0) {
                        const row = balancesBody.insertRow();
                        row.insertCell(0).innerHTML = name;
                        row.insertCell(1).innerHTML = '<span class="earn">$' + data.earned.toFixed(5) + '</span>';
                        row.insertCell(2).innerHTML = data.claims;
                    }
                }
            }
        } catch (error) {
            console.error('Stats update error:', error);
        }
    }
    
    async function startBot() {
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        startBtn.disabled = true;
        startBtn.innerHTML = '<span class="loading"></span> Starting...';
        
        const response = await fetch('/api/start', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            startBtn.innerHTML = '▶️ Running';
            stopBtn.disabled = false;
            addLog('🚀 Bot started!');
            if (refreshInterval) clearInterval(refreshInterval);
            refreshInterval = setInterval(updateStats, 5000);
        } else {
            startBtn.innerHTML = '▶️ Start Bot';
            startBtn.disabled = false;
            addLog('❌ Failed to start bot: ' + data.message);
        }
    }
    
    async function stopBot() {
        const response = await fetch('/api/stop', { method: 'POST' });
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('startBtn').disabled = false;
            document.getElementById('startBtn').innerHTML = '▶️ Start Bot';
            document.getElementById('stopBtn').disabled = true;
            addLog('⏹️ Bot stopped');
        }
    }
    
    // Initial update
    updateStats();
    setInterval(updateStats, 10000);
</script>
</body>
</html>
`;

// ============ API ROUTES ============

// Serve dashboard
app.get('/', (req, res) => {
    res.send(dashboardHTML);
});

// Capture session from iFrame
app.post('/api/capture-session', async (req, res) => {
    const { cookies, localStorage, url } = req.body;
    
    try {
        // Parse cookies string into array
        const cookieArray = [];
        if (cookies) {
            cookies.split(';').forEach(cookie => {
                const [name, value] = cookie.trim().split('=');
                if (name && value) {
                    cookieArray.push({
                        name: name.trim(),
                        value: value.trim(),
                        domain: '.faucetpay.io',
                        path: '/',
                        secure: true,
                        httpOnly: false
                    });
                }
            });
        }
        
        // Save session
        const sessionData = {
            cookies: cookieArray,
            localStorage: localStorage,
            url: url,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync('session.json', JSON.stringify(sessionData, null, 2));
        
        // Also sync to running browser if exists
        if (page) {
            await page.setCookie(...cookieArray);
            console.log('✅ Cookies synced to running browser');
        }
        
        stats.loggedIn = true;
        
        res.json({ success: true, message: `Saved ${cookieArray.length} cookies` });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Sync saved session to bot
app.post('/api/sync-session', async (req, res) => {
    try {
        if (!fs.existsSync('session.json')) {
            return res.json({ success: false, message: 'No saved session found' });
        }
        
        const sessionData = JSON.parse(fs.readFileSync('session.json', 'utf8'));
        
        if (!page) {
            await launchBrowser();
        }
        
        if (sessionData.cookies && sessionData.cookies.length > 0) {
            await page.setCookie(...sessionData.cookies);
            console.log(`✅ Synced ${sessionData.cookies.length} cookies to browser`);
        }
        
        stats.loggedIn = true;
        loginEmail = 'from_session';
        
        res.json({ success: true, message: `Synced ${sessionData.cookies?.length || 0} cookies` });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Clear session
app.post('/api/clear-session', async (req, res) => {
    try {
        if (fs.existsSync('session.json')) {
            fs.unlinkSync('session.json');
        }
        stats.loggedIn = false;
        loginEmail = '';
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Get status
app.get('/api/status', (req, res) => {
    res.json({
        loggedIn: stats.loggedIn,
        email: loginEmail,
        balance: stats.currentBalance,
        botRunning: botRunning,
        stats: {
            totalEarned: stats.totalEarned,
            totalActions: stats.totalActions,
            sessionEarned: stats.sessionEarned
        }
    });
});

// Get detailed stats
app.get('/api/stats', (req, res) => {
    const uptime = (Date.now() - stats.startTime) / 1000;
    const hourlyRate = uptime > 0 ? (stats.totalEarned / (uptime / 3600)).toFixed(5) : 0;
    const dailyRate = uptime > 0 ? (stats.totalEarned / (uptime / 86400)).toFixed(5) : 0;
    
    res.json({
        totalEarned: stats.totalEarned,
        totalActions: stats.totalActions,
        hourlyRate: hourlyRate,
        dailyRate: dailyRate,
        sourceBalances: stats.sourceBalances,
        claimHistory: stats.claimHistory.slice(0, 50)
    });
});

// Start bot
app.post('/api/start', async (req, res) => {
    if (!page) {
        try {
            await launchBrowser();
        } catch (error) {
            return res.json({ success: false, message: `Failed to launch browser: ${error.message}` });
        }
    }
    
    if (botRunning) {
        return res.json({ success: false, message: 'Bot already running' });
    }
    
    // Try to sync session if exists
    if (fs.existsSync('session.json')) {
        const sessionData = JSON.parse(fs.readFileSync('session.json', 'utf8'));
        if (sessionData.cookies && sessionData.cookies.length > 0) {
            await page.setCookie(...sessionData.cookies);
            stats.loggedIn = true;
            console.log('✅ Session loaded on start');
        }
    }
    
    botRunning = true;
    console.log('🚀 Bot started!');
    
    const runLoop = async () => {
        while (botRunning && page) {
            try {
                console.log(`\n📊 Cycle ${new Date().toLocaleTimeString()}`);
                
                await page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 5000));
                
                // Check if we need to login
                const url = page.url();
                if (url.includes('login')) {
                    console.log('❌ Not logged in! Please capture session from iFrame first.');
                    botRunning = false;
                    break;
                }
                
                // Claim Daily Bonus
                const claimed = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const claimBtn = buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('claim') && (text.includes('bonus') || text.includes('daily'));
                    });
                    if (claimBtn) {
                        claimBtn.click();
                        return true;
                    }
                    return false;
                });
                
                if (claimed) {
                    await new Promise(r => setTimeout(r, 5000));
                    const earned = 0.001;
                    stats.totalEarned += earned;
                    stats.sessionEarned += earned;
                    stats.totalActions++;
                    stats.sourceBalances['Daily Bonus'].earned += earned;
                    stats.sourceBalances['Daily Bonus'].claims++;
                    stats.sourceBalances['Daily Bonus'].lastClaim = new Date();
                    
                    stats.claimHistory.unshift({
                        time: new Date(),
                        source: 'Daily Bonus',
                        amount: earned
                    });
                    
                    console.log(`💰 Daily Bonus: +$${earned.toFixed(5)}`);
                } else {
                    console.log('ℹ️ Daily Bonus not available');
                }
                
                // Get balance
                const balanceText = await page.evaluate(() => {
                    const el = document.querySelector('.balance-amount, .user-balance, [class*="balance"]');
                    return el ? el.innerText : '0';
                });
                const balance = parseFloat(balanceText) || 0;
                stats.currentBalance = balance;
                
                await new Promise(r => setTimeout(r, 60000));
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    };
    
    runLoop();
    res.json({ success: true });
});

// Stop bot
app.post('/api/stop', (req, res) => {
    botRunning = false;
    console.log('⏹️ Bot stopped');
    res.json({ success: true });
});

// ============ START SERVER ============
app.listen(port, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`📊 DASHBOARD: http://localhost:${port}`);
    console.log(`========================================`);
    console.log(`\n💡 INSTRUCTIONS:`);
    console.log(`   1. Open the dashboard in your browser`);
    console.log(`   2. Login to FaucetPay in the iFrame on the left`);
    console.log(`   3. Click "Detect Login Status" to verify`);
    console.log(`   4. Click "Capture & Save Session" to save cookies`);
    console.log(`   5. Click "Sync Session to Bot" to load into bot`);
    console.log(`   6. Click "Start Bot" to begin earning!\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    if (browser) await browser.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit(0);
});
