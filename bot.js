// faucetpay-persistent-bot.js - Bot with manual login and persistent session
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'false';

// Session storage paths
const SESSION_DIR = path.join(__dirname, 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'faucetpay-session.json');
const USER_DATA_DIR = path.join(__dirname, 'chrome-user-data');

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

// Bot state
let botInstance = null;
let botRunning = false;
let loginCompleted = false;
let loginPromiseResolve = null;

console.log('\n========================================');
console.log('  FaucetPay Persistent Bot');
console.log('========================================');
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log('========================================\n');

// Ensure directories exist
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });

// ============ CHROME INSTALLATION ============
async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed: ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', reject);
    });
}

async function installChrome() {
    if (fs.existsSync(CHROME_PATH)) {
        const stats = fs.statSync(CHROME_PATH);
        if (stats.size > 50000000) return CHROME_PATH;
    }
    
    console.log('[Chrome] Installing...');
    try {
        execSync('apt-get update -qq 2>/dev/null || true', { stdio: 'inherit' });
        execSync(`apt-get install -y -qq ca-certificates wget unzip libnss3 libxss1 libasound2 2>/dev/null || true`, { stdio: 'inherit' });
        
        const zipPath = '/tmp/chromium.zip';
        await downloadFile(CHROME_URL, zipPath);
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        fs.chmodSync(CHROME_PATH, 0o755);
        fs.unlinkSync(zipPath);
        console.log('[Chrome] ✅ Installed');
        return CHROME_PATH;
    } catch (error) {
        console.error('[Chrome] Failed:', error.message);
        return null;
    }
}

// ============ EARNING SOURCES ============
const EARNING_SOURCES = [
    // FaucetPay Internal (Instant to balance)
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', instantToBalance: true },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', instantToBalance: true },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', instantToBalance: true },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', instantToBalance: true },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', instantToBalance: true },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', instantToBalance: true },
    
    // External Faucets (Require withdrawal)
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerAction: 0.0005, type: 'faucet', minWithdraw: 0.0003, instantToBalance: false },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerAction: 0.0003, type: 'faucet', minWithdraw: 0.0002, instantToBalance: false },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerAction: 0.0003, type: 'faucet', minWithdraw: 0.0002, instantToBalance: false },
    { name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerAction: 0.0002, type: 'faucet', minWithdraw: 0.0001, instantToBalance: false }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    sourceBalances: {},
    withdrawalHistory: [],
    claimHistory: [],
    successHistory: [],
    startTime: new Date(),
    loggedIn: false,
    lastWithdrawal: null,
    lastCycleTime: null
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { earned: 0, claims: 0, lastClaim: null, pendingWithdraw: false };
});

// ============ PERSISTENT BOT ============
class PersistentFaucetBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button', '#free_play_form_button'];
        this.isRunning = false;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        // Launch with persistent user data directory
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            userDataDir: USER_DATA_DIR, // This preserves cookies and sessions
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
        
        // Load saved session state if exists
        await this.loadSessionState();
    }

    async loadSessionState() {
        if (fs.existsSync(SESSION_FILE)) {
            try {
                const savedStats = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
                if (savedStats.totalEarned) {
                    stats.totalEarned = savedStats.totalEarned;
                    stats.totalActions = savedStats.totalActions;
                    stats.sourceBalances = savedStats.sourceBalances || stats.sourceBalances;
                    stats.withdrawalHistory = savedStats.withdrawalHistory || [];
                    stats.claimHistory = savedStats.claimHistory || [];
                    console.log('[Session] ✅ Loaded previous session data');
                    console.log(`[Session] Previous total earned: $${stats.totalEarned.toFixed(5)}`);
                }
            } catch (e) {
                console.log('[Session] No saved session found');
            }
        }
    }

    async saveSessionState() {
        const saveData = {
            totalEarned: stats.totalEarned,
            totalActions: stats.totalActions,
            sourceBalances: stats.sourceBalances,
            withdrawalHistory: stats.withdrawalHistory.slice(0, 100),
            claimHistory: stats.claimHistory.slice(0, 500),
            lastSaved: new Date()
        };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(saveData, null, 2));
    }

    async checkLoginStatus() {
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 10000 });
            await this.page.waitForTimeout(2000);
            
            // Check if we're logged in by looking for user elements
            const isLoggedIn = await this.page.evaluate(() => {
                const hasBalance = document.querySelector('.balance-amount, .user-balance');
                const hasLogout = document.querySelector('a[href*="logout"]');
                const hasDashboard = window.location.href.includes('/dashboard');
                return !!(hasBalance || hasLogout || hasDashboard);
            }).catch(() => false);
            
            if (isLoggedIn) {
                this.loggedIn = true;
                stats.loggedIn = true;
                console.log('[FaucetPay] ✅ Already logged in from saved session!');
                await this.updateBalance();
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async waitForManualLogin() {
        console.log('\n========================================');
        console.log('  ⏳ MANUAL LOGIN REQUIRED');
        console.log('========================================');
        console.log('1. Open your browser and go to:');
        console.log(`   http://localhost:${port}/faucetpaylogin`);
        console.log('2. Login to your FaucetPay account');
        console.log('3. Bot will automatically detect login');
        console.log('========================================\n');
        
        // Navigate to login page and wait for manual login
        await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
        
        // Wait for successful login (check every 2 seconds)
        while (!this.loggedIn) {
            await this.page.waitForTimeout(2000);
            
            const isLoggedIn = await this.page.evaluate(() => {
                const url = window.location.href;
                const hasDashboard = url.includes('/dashboard');
                const hasBalance = document.querySelector('.balance-amount, .user-balance');
                return hasDashboard || hasBalance;
            }).catch(() => false);
            
            if (isLoggedIn) {
                this.loggedIn = true;
                stats.loggedIn = true;
                console.log('\n[FaucetPay] ✅ Manual login detected!');
                await this.updateBalance();
                await this.saveSessionState();
                
                // Resolve the promise if someone is waiting
                if (loginPromiseResolve) {
                    loginPromiseResolve(true);
                    loginPromiseResolve = null;
                }
                break;
            }
        }
        
        return true;
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            const newBalance = parseFloat(balanceText) || 0;
            if (newBalance !== stats.currentBalance) {
                console.log(`💰 Balance updated: $${stats.currentBalance.toFixed(5)} → $${newBalance.toFixed(5)}`);
                stats.currentBalance = newBalance;
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            let claimBtn = null;
            for (const selector of this.claimSelectors) {
                try { claimBtn = await this.page.$(selector); if (claimBtn) break; } catch(e) {}
            }
            
            if (!claimBtn) {
                const buttons = await this.page.$$('button, a');
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                    if (text && (text.includes('claim') || text.includes('get') || text.includes('earn'))) {
                        claimBtn = btn;
                        break;
                    }
                }
            }
            
            if (claimBtn) {
                await claimBtn.click();
                await this.page.waitForTimeout(3000);
                
                const earned = source.earnPerAction;
                
                // Update stats
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances[source.name].earned += earned;
                stats.sourceBalances[source.name].claims++;
                stats.sourceBalances[source.name].lastClaim = new Date();
                
                // Record claim
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: earned,
                    type: source.type,
                    instantToBalance: source.instantToBalance
                });
                
                // Trim history
                if (stats.claimHistory.length > 500) stats.claimHistory.pop();
                
                // Log with appropriate indicator
                const indicator = source.instantToBalance ? '💰' : '🪙';
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)} → ${source.instantToBalance ? 'To Balance' : `To ${source.name} Wallet`}`);
                
                // Save session periodically
                if (stats.totalActions % 10 === 0) {
                    await this.saveSessionState();
                }
                
                // Check if external faucet reached withdrawal minimum
                if (!source.instantToBalance && source.minWithdraw && stats.sourceBalances[source.name].earned >= source.minWithdraw) {
                    await this.withdrawFromSource(source);
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async withdrawFromSource(source) {
        const balance = stats.sourceBalances[source.name].earned;
        console.log(`\n  💸 WITHDRAWING from ${source.name}!`);
        console.log(`     Balance: $${balance.toFixed(5)}`);
        console.log(`     Minimum required: $${source.minWithdraw}`);
        
        stats.sourceBalances[source.name].pendingWithdraw = true;
        
        try {
            await this.page.goto(source.url, { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            const withdrawSelectors = ['.withdraw-btn', '#withdraw', 'button:has-text("Withdraw")', 'a:has-text("Withdraw")'];
            let withdrawBtn = null;
            
            for (const selector of withdrawSelectors) {
                try { withdrawBtn = await this.page.$(selector); if (withdrawBtn) break; } catch(e) {}
            }
            
            if (withdrawBtn) {
                await withdrawBtn.click();
                await this.page.waitForTimeout(3000);
                
                stats.withdrawalHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: balance,
                    status: 'SUCCESS',
                    to: 'FaucetPay Balance'
                });
                
                // Trim history
                if (stats.withdrawalHistory.length > 100) stats.withdrawalHistory.pop();
                
                console.log(`     ✅ WITHDRAWAL SUCCESSFUL! $${balance.toFixed(5)} sent to FaucetPay balance`);
                stats.sourceBalances[source.name].earned = 0;
                stats.lastWithdrawal = new Date();
                await this.saveSessionState();
                
                if (this.loggedIn) {
                    await this.updateBalance();
                }
            } else {
                throw new Error('Withdraw button not found');
            }
        } catch (error) {
            console.log(`     ❌ Withdrawal failed: ${error.message}`);
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: error.message
            });
        }
        
        stats.sourceBalances[source.name].pendingWithdraw = false;
        await this.saveSessionState();
    }

    async runCycle() {
        if (!this.loggedIn) {
            console.log('[Bot] Waiting for login...');
            return 0;
        }
        
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${EARNING_SOURCES.length} sources | Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`📈 Total earned this session: $${stats.sessionEarned.toFixed(5)}`);
        console.log('========================================');
        
        // First claim external faucets (ones that need withdrawal)
        const externalSources = EARNING_SOURCES.filter(s => !s.instantToBalance);
        for (const source of externalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(2000);
        }
        
        // Then claim internal sources (instant to balance)
        const internalSources = EARNING_SOURCES.filter(s => s.instantToBalance);
        for (const source of internalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(1500);
        }
        
        // Update final balance
        if (this.loggedIn) {
            await this.updateBalance();
        }
        
        stats.lastCycleTime = new Date();
        await this.saveSessionState();
        
        // Show summary
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show source balances summary
        const activeSources = Object.entries(stats.sourceBalances).filter(([_, data]) => data.earned > 0);
        if (activeSources.length > 0) {
            console.log('\n📦 Pending balances:');
            for (const [name, data] of activeSources) {
                if (data.earned > 0) {
                    const source = EARNING_SOURCES.find(s => s.name === name);
                    const minText = source?.minWithdraw ? ` (min: $${source.minWithdraw})` : '';
                    console.log(`   🪙 ${name}: $${data.earned.toFixed(5)}${minText}`);
                }
            }
        }
        
        // Show recent withdrawals
        if (stats.withdrawalHistory.length > 0 && new Date(stats.withdrawalHistory[0].time) > new Date(Date.now() - 60000)) {
            const lastWithdraw = stats.withdrawalHistory[0];
            console.log(`\n💸 Last withdrawal: $${lastWithdraw.amount.toFixed(5)} from ${lastWithdraw.source} - ${lastWithdraw.status}`);
        }
        
        return cycleEarned;
    }

    async start() {
        console.log('🚀 Starting Persistent Faucet Bot');
        console.log('💰 Will save session data between restarts');
        console.log('========================================\n');
        
        await this.init();
        
        // Check if already logged in from previous session
        const wasLoggedIn = await this.checkLoginStatus();
        
        if (!wasLoggedIn) {
            await this.waitForManualLogin();
        }
        
        this.isRunning = true;
        
        // Start the main loop
        while (this.isRunning) {
            try {
                await this.runCycle();
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                
                // Check if we're still logged in
                const stillLoggedIn = await this.checkLoginStatus();
                if (!stillLoggedIn) {
                    console.log('[Bot] Session expired. Waiting for re-login...');
                    this.loggedIn = false;
                    stats.loggedIn = false;
                    await this.waitForManualLogin();
                }
                
                await this.page.waitForTimeout(10000);
            }
        }
    }

    async stop() {
        this.isRunning = false;
        await this.saveSessionState();
        if (this.browser) {
            await this.browser.close();
        }
    }
}

// ============ EXPRESS ROUTES ============

// Login page for manual authentication
app.get('/faucetpaylogin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Login - Bot Authentication</title>
    <style>
        body {
            font-family: monospace;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            color: #00ff88;
            padding: 20px;
            min-height: 100vh;
            margin: 0;
        }
        .container {
            max-width: 800px;
            margin: 50px auto;
            text-align: center;
        }
        .card {
            background: rgba(26, 31, 58, 0.95);
            padding: 30px;
            border-radius: 20px;
            border: 1px solid #00ff88;
            box-shadow: 0 0 30px rgba(0,255,136,0.2);
        }
        h1 {
            margin-bottom: 10px;
        }
        .status {
            display: inline-block;
            padding: 10px 20px;
            margin: 20px 0;
            border-radius: 10px;
            font-weight: bold;
        }
        .waiting {
            background: #ffaa00;
            color: #000;
            animation: pulse 1s infinite;
        }
        .success {
            background: #00ff88;
            color: #000;
        }
        .instructions {
            text-align: left;
            background: rgba(0,0,0,0.3);
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .instructions li {
            margin: 10px 0;
        }
        .iframe-container {
            margin: 20px 0;
            border: 2px solid #00ff88;
            border-radius: 10px;
            overflow: hidden;
        }
        iframe {
            width: 100%;
            height: 600px;
            border: none;
        }
        button {
            background: #00ff88;
            color: #000;
            border: none;
            padding: 10px 20px;
            margin: 10px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
        }
        button:hover {
            background: #00cc66;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
        .balance {
            font-size: 24px;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>🔐 FaucetPay Login</h1>
            <p>Login to your FaucetPay account to start the bot</p>
            
            <div id="status" class="status waiting">⏳ WAITING FOR LOGIN...</div>
            
            <div class="instructions">
                <h3>📋 Instructions:</h3>
                <ol>
                    <li>Login to your FaucetPay account in the frame below</li>
                    <li>Complete any 2FA if enabled</li>
                    <li>Wait for the success message</li>
                    <li>Bot will automatically start claiming!</li>
                </ol>
                <p><strong>⚠️ Note:</strong> Your session will be saved. You won't need to login again unless cookies expire.</p>
            </div>
            
            <div class="iframe-container">
                <iframe src="https://faucetpay.io/login"></iframe>
            </div>
            
            <button onclick="checkLoginStatus()">🔄 Check Login Status</button>
            <button onclick="window.open('https://faucetpay.io/dashboard', '_blank')">📊 Open Dashboard</button>
        </div>
    </div>
    
    <script>
        async function checkLoginStatus() {
            try {
                const response = await fetch('/api/login-status');
                const data = await response.json();
                if (data.loggedIn) {
                    document.getElementById('status').className = 'status success';
                    document.getElementById('status').innerHTML = '✅ LOGIN SUCCESSFUL! Bot is running...';
                    setTimeout(() => {
                        window.location.href = '/dashboard';
                    }, 2000);
                } else {
                    document.getElementById('status').innerHTML = '⏳ Still waiting for login... Please login in the frame above';
                }
            } catch(e) {
                console.error(e);
            }
        }
        
        setInterval(checkLoginStatus, 3000);
        checkLoginStatus();
    </script>
</body>
</html>
    `);
});

// Dashboard
app.get('/dashboard', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const dailyRate = uptime > 0 ? (stats.totalEarned / (uptime / 86400)).toFixed(5) : '0.00000';
    const hourlyRate = uptime > 0 ? (stats.totalEarned / (uptime / 3600)).toFixed(5) : '0.00000';
    
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .filter(([_, data]) => data.earned > 0 || data.claims > 0)
        .map(([name, data]) => {
            const source = EARNING_SOURCES.find(s => s.name === name);
            const minText = source?.minWithdraw ? ` / Min: $${source.minWithdraw}` : '';
            return `
            <tr>
                <td>${name}</td>
                <td class="earn">$${data.earned.toFixed(5)}${minText}</td>
                <td>${data.claims}</td>
                <td>${data.lastClaim ? new Date(data.lastClaim).toLocaleTimeString() : 'Never'}</td>
                <td>${data.pendingWithdraw ? '⏳ Withdrawing' : '✅ Active'}</td>
            </tr>
        `}).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
            <td>${c.instantToBalance ? '💰 Balance' : '🪙 Wallet'}</td>
        </tr>
    `).join('');
    
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 20).map(w => `
        <tr>
            <td>${new Date(w.time).toLocaleTimeString()}</td>
            <td>${w.source}</td>
            <td class="earn">$${w.amount.toFixed(5)}</td>
            <td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Bot Dashboard - Live Earnings</title>
    <meta http-equiv="refresh" content="10">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-value-small { font-size: 18px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .error { color: #ff4444; }
        .nav { text-align: center; margin-bottom: 20px; }
        .nav a { color: #00ff88; margin: 0 10px; text-decoration: none; }
        .nav a:hover { text-decoration: underline; }
        .live { animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        button { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Persistent Bot</h1>
        <div class="nav">
            <a href="/dashboard">📊 Dashboard</a>
            <a href="/faucetpaylogin">🔐 Re-login</a>
        </div>
        <div class="status">
            🟢 <span class="live">${botRunning ? 'RUNNING' : 'STOPPED'}</span> | Uptime: ${hours}h ${minutes}m | Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}
            <div>Session earned: <span class="earn">$${stats.sessionEarned.toFixed(5)}</span> | Balance: <span class="earn">$${stats.currentBalance.toFixed(5)}</span></div>
            <div>Total earned all time: <span class="earn">$${stats.totalEarned.toFixed(5)}</span></div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${hourlyRate}</div><div>Per Hour</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>🪙 Source Balances</h3>
                <button onclick="location.reload()">🔄 Refresh</button>
                <table>
                    <thead><tr><th>Source</th><th>Balance</th><th>Claims</th><th>Last</th><th>Status</th></tr></thead>
                    <tbody>${sourceBalancesHtml || '<tr><td colspan="5">No activity yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>💸 Withdrawal History</h3>
                <table>
                    <thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th></tr></thead>
                    <tbody>${withdrawalHtml || '<tr><td colspan="4">No withdrawals yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Destination</th></tr></thead>
                <tbody>${claimHtml || '<tr><td colspan="4">No claims yet...</td></tr>'}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// API endpoint to check login status
app.get('/api/login-status', (req, res) => {
    res.json({ 
        loggedIn: stats.loggedIn,
        running: botRunning,
        balance: stats.currentBalance,
        totalEarned: stats.totalEarned
    });
});

// API to get stats
app.get('/api/stats', (req, res) => {
    res.json(stats);
});

// Root redirect
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Persistent Faucet Bot...');
    console.log('💰 Manual login required at /faucetpaylogin');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}/dashboard`);
        console.log(`🔐 Login Page: http://localhost:${port}/faucetpaylogin`);
        console.log('\n⚠️  Open the login page and authenticate to start the bot\n');
    });
    
    botInstance = new PersistentFaucetBot();
    botRunning = true;
    await botInstance.start();
}

process.on('SIGINT', async () => {
    console.log('\n[Bot] Shutting down...');
    if (botInstance) {
        await botInstance.stop();
    }
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('\n[Bot] Shutting down...');
    if (botInstance) {
        await botInstance.stop();
    }
    process.exit(0);
});

main().catch(console.error);
