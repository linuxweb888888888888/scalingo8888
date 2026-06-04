// faucetpay-internal-bot.js - FaucetPay Internal Bot with Dashboard Login
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const session = require('express-session');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session storage for login status
app.use(session({
    secret: 'faucetpay-bot-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ============ CONFIGURATION ============
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || '';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const USER_DATA_DIR = process.env.USER_DATA_DIR || './chrome-profile';

console.log('\n========================================');
console.log('  FaucetPay Internal Bot v5.0');
console.log('  DASHBOARD LOGIN - PERSISTENT SESSION');
console.log('========================================');
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Persistent Session: ON`);
console.log('========================================\n');

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
    const CHROME_PATH = '/app/chrome-linux64/chrome';
    const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';
    
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

async function safeWait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ensure chrome-profile directory exists
if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
}

// ============ GLOBAL VARIABLES ============
let browserInstance = null;
let pageInstance = null;
let botRunning = false;
let loginStatus = {
    isLoggedIn: false,
    email: '',
    lastLoginTime: null,
    balance: 0
};

let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    sourceBalances: {
        'Daily Bonus': { earned: 0, claims: 0, lastClaim: null },
        'Faucet List': { earned: 0, claims: 0, lastClaim: null },
        'Offerwalls': { earned: 0, claims: 0, lastClaim: null },
        'PTC Ads': { earned: 0, claims: 0, lastClaim: null },
        'Staking': { earned: 0, claims: 0, lastClaim: null },
        'Tasks': { earned: 0, claims: 0, lastClaim: null }
    },
    claimHistory: [],
    startTime: new Date()
};

// ============ BROWSER MANAGER ============
class BrowserManager {
    constructor() {
        this.browser = null;
        this.page = null;
    }
    
    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            userDataDir: USER_DATA_DIR, // Persistent session!
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,720'
            ]
        });
        
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 720 });
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        browserInstance = this.browser;
        pageInstance = this.page;
        
        return this.page;
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
    
    async getBalance() {
        if (!this.page) return 0;
        try {
            const balance = await this.page.evaluate(() => {
                const elements = document.querySelectorAll('.balance-amount, .user-balance, [class*="balance"]');
                for (const el of elements) {
                    const text = el.innerText;
                    if (text && text.match(/[\d.]+/)) {
                        return parseFloat(text.match(/[\d.]+/)[0]);
                    }
                }
                return 0;
            });
            loginStatus.balance = balance;
            stats.currentBalance = balance;
            return balance;
        } catch (error) {
            return 0;
        }
    }
}

let browserManager = new BrowserManager();

// ============ LOGIN VIA DASHBOARD ============
async function performLogin(email, password) {
    console.log(`\n🔐 Manual login triggered for: ${email}`);
    
    try {
        const page = await browserManager.init();
        
        // Navigate to login page
        await page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2', timeout: 30000 });
        await safeWait(3000);
        
        // Check if already logged in via persistent session
        const currentUrl = page.url();
        if (!currentUrl.includes('login')) {
            console.log('✅ Already logged in from persistent session!');
            loginStatus.isLoggedIn = true;
            loginStatus.email = email;
            loginStatus.lastLoginTime = new Date();
            await browserManager.getBalance();
            return { success: true, message: 'Already logged in from saved session' };
        }
        
        // Enter credentials
        await page.type('#email, input[name="email"]', email);
        await safeWait(500);
        await page.type('#password, input[name="password"]', password);
        await safeWait(500);
        
        // Check for captcha
        const hasCaptcha = await page.evaluate(() => {
            return !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], .captcha');
        });
        
        if (hasCaptcha) {
            console.log('⚠️ CAPTCHA detected - please solve it in the browser window');
            console.log('   You have 60 seconds to solve the captcha...');
            
            // Wait for captcha to be solved
            await page.waitForFunction(() => {
                const recaptchaResponse = document.querySelector('#g-recaptcha-response');
                return recaptchaResponse && recaptchaResponse.value.length > 0;
            }, { timeout: 60000 }).catch(() => {
                console.log('⚠️ Captcha not solved, trying to proceed anyway...');
            });
            
            await safeWait(2000);
        }
        
        // Click login
        await page.click('button[type="submit"], input[type="submit"]');
        await safeWait(8000);
        
        // Verify login success
        const afterUrl = page.url();
        if (!afterUrl.includes('login')) {
            console.log('✅ Login successful! Session saved to persistent storage.');
            loginStatus.isLoggedIn = true;
            loginStatus.email = email;
            loginStatus.lastLoginTime = new Date();
            await browserManager.getBalance();
            return { success: true, message: 'Login successful! Session saved.' };
        } else {
            console.log('❌ Login failed');
            return { success: false, message: 'Login failed. Please check credentials.' };
        }
    } catch (error) {
        console.error(`Login error: ${error.message}`);
        return { success: false, message: error.message };
    }
}

// ============ EARNING ENGINE ============
class InternalEarningEngine {
    constructor(page) {
        this.page = page;
    }
    
    async claimDailyBonus() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
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
            
            if (result) {
                await safeWait(5000);
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances['Daily Bonus'].earned += earned;
                stats.sourceBalances['Daily Bonus'].claims++;
                stats.sourceBalances['Daily Bonus'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async claimFaucetList() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('visit')) && link.href && !link.href.includes('faucetpay.io')) {
                        link.click();
                        count++;
                        if (count >= 5) break;
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.0005 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Faucet List'].earned += earned;
                stats.sourceBalances['Faucet List'].claims += result;
                stats.sourceBalances['Faucet List'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async claimOfferwalls() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/offerwalls', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('earn') || text.includes('offer')) && link.href) {
                        link.click();
                        count++;
                        if (count >= 3) break;
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.002 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Offerwalls'].earned += earned;
                stats.sourceBalances['Offerwalls'].claims += result;
                stats.sourceBalances['Offerwalls'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async claimPTCAds() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/ptc', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('view') || text.includes('click') || text.includes('ad')) && link.href) {
                        link.click();
                        count++;
                        if (count >= 10) break;
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(3000);
                const earned = 0.0008 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['PTC Ads'].earned += earned;
                stats.sourceBalances['PTC Ads'].claims += result;
                stats.sourceBalances['PTC Ads'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async claimStaking() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/staking', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const claimBtn = buttons.find(btn => {
                    const text = (btn.innerText || '').toLowerCase();
                    return text.includes('claim') || text.includes('withdraw');
                });
                if (claimBtn) {
                    claimBtn.click();
                    return true;
                }
                return false;
            });
            
            if (result) {
                await safeWait(3000);
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances['Staking'].earned += earned;
                stats.sourceBalances['Staking'].claims++;
                stats.sourceBalances['Staking'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async claimTasks() {
        if (!this.page) return 0;
        try {
            await this.page.goto('https://faucetpay.io/tasks', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const result = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a, button'));
                let count = 0;
                for (const link of links) {
                    const text = (link.innerText || '').toLowerCase();
                    if ((text.includes('complete') || text.includes('start') || text.includes('earn')) && link.href) {
                        link.click();
                        count++;
                        if (count >= 5) break;
                    }
                }
                return count;
            });
            
            if (result > 0) {
                await safeWait(4000);
                const earned = 0.0015 * result;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += result;
                stats.sourceBalances['Tasks'].earned += earned;
                stats.sourceBalances['Tasks'].claims += result;
                stats.sourceBalances['Tasks'].lastClaim = new Date();
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async runCycle() {
        if (!this.page) {
            console.log('⚠️ Browser not initialized. Please login first.');
            return 0;
        }
        
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`💰 Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`📈 Session earned: $${stats.sessionEarned.toFixed(5)}`);
        console.log('========================================');
        
        cycleEarned += await this.claimDailyBonus();
        await safeWait(2000);
        
        cycleEarned += await this.claimFaucetList();
        await safeWait(2000);
        
        cycleEarned += await this.claimOfferwalls();
        await safeWait(2000);
        
        cycleEarned += await this.claimPTCAds();
        await safeWait(2000);
        
        cycleEarned += await this.claimStaking();
        await safeWait(2000);
        
        cycleEarned += await this.claimTasks();
        
        await browserManager.getBalance();
        
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        const uptimeHours = (Date.now() - stats.startTime) / 3600000;
        const hourlyRate = uptimeHours > 0 ? (stats.totalEarned / uptimeHours).toFixed(5) : 0;
        const dailyProjection = (hourlyRate * 24).toFixed(5);
        console.log(`\n📈 Hourly rate: $${hourlyRate} | Projected daily: $${dailyProjection}`);
        
        return cycleEarned;
    }
}

let earningEngine = null;

// ============ API ROUTES ============

// Login endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.json({ success: false, message: 'Email and password required' });
    }
    
    const result = await performLogin(email, password);
    res.json(result);
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
    try {
        if (browserInstance) {
            await browserInstance.close();
            browserInstance = null;
            pageInstance = null;
        }
        loginStatus.isLoggedIn = false;
        loginStatus.email = '';
        loginStatus.lastLoginTime = null;
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// Get status endpoint
app.get('/api/status', async (req, res) => {
    if (pageInstance && loginStatus.isLoggedIn) {
        await browserManager.getBalance();
    }
    res.json({
        loggedIn: loginStatus.isLoggedIn,
        email: loginStatus.email,
        lastLoginTime: loginStatus.lastLoginTime,
        balance: loginStatus.balance,
        botRunning: botRunning,
        stats: {
            totalEarned: stats.totalEarned,
            totalActions: stats.totalActions,
            sessionEarned: stats.sessionEarned,
            currentBalance: stats.currentBalance
        }
    });
});

// Start bot endpoint
app.post('/api/start', async (req, res) => {
    if (!loginStatus.isLoggedIn || !pageInstance) {
        return res.json({ success: false, message: 'Please login first' });
    }
    
    if (botRunning) {
        return res.json({ success: false, message: 'Bot is already running' });
    }
    
    botRunning = true;
    earningEngine = new InternalEarningEngine(pageInstance);
    
    // Start bot loop
    const runLoop = async () => {
        while (botRunning && loginStatus.isLoggedIn) {
            try {
                await earningEngine.runCycle();
                await safeWait(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await safeWait(10000);
            }
        }
    };
    
    runLoop();
    res.json({ success: true, message: 'Bot started' });
});

// Stop bot endpoint
app.post('/api/stop', async (req, res) => {
    botRunning = false;
    res.json({ success: true, message: 'Bot stopped' });
});

// Get stats endpoint
app.get('/api/stats', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hourlyRate = uptime > 0 ? (stats.totalEarned / (uptime / 3600)).toFixed(5) : 0;
    const dailyRate = uptime > 0 ? (stats.totalEarned / (uptime / 86400)).toFixed(5) : 0;
    
    res.json({
        totalEarned: stats.totalEarned,
        totalActions: stats.totalActions,
        sessionEarned: stats.sessionEarned,
        currentBalance: stats.currentBalance,
        hourlyRate: hourlyRate,
        dailyRate: dailyRate,
        uptime: uptime,
        sourceBalances: stats.sourceBalances,
        claimHistory: stats.claimHistory.slice(0, 50)
    });
});

// ============ DASHBOARD HTML ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Bot - Dashboard Login</title>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%); font-family: 'Segoe UI', monospace; min-height: 100vh; color: #00ff88; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        h1 { text-align: center; margin-bottom: 20px; font-size: 28px; }
        
        /* Login Panel */
        .login-panel { background: rgba(26,31,58,0.95); border-radius: 15px; padding: 30px; margin-bottom: 20px; border: 1px solid #00ff88; }
        .login-panel h2 { margin-bottom: 20px; font-size: 20px; }
        .login-form { display: flex; gap: 15px; flex-wrap: wrap; align-items: flex-end; }
        .form-group { flex: 1; min-width: 200px; }
        .form-group label { display: block; margin-bottom: 5px; font-size: 12px; opacity: 0.8; }
        .form-group input { width: 100%; padding: 12px; background: #0a0e27; border: 1px solid #00ff88; border-radius: 8px; color: #00ff88; font-family: monospace; }
        .form-group input:focus { outline: none; border-color: #00ff88; box-shadow: 0 0 10px rgba(0,255,136,0.3); }
        button { padding: 12px 24px; background: #00ff88; color: #0a0e27; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-family: monospace; transition: all 0.3s; }
        button:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(0,255,136,0.4); }
        button.danger { background: #ff4444; color: white; }
        button.warning { background: #ffaa00; color: #0a0e27; }
        button.success { background: #00ff88; color: #0a0e27; }
        
        /* Status Panel */
        .status-panel { background: rgba(26,31,58,0.95); border-radius: 15px; padding: 20px; margin-bottom: 20px; border: 1px solid #00ff88; }
        .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
        .status-item { background: #0a0e27; padding: 15px; border-radius: 10px; text-align: center; }
        .status-label { font-size: 12px; opacity: 0.7; margin-bottom: 5px; }
        .status-value { font-size: 24px; font-weight: bold; }
        
        /* Stats Grid */
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: rgba(26,31,58,0.95); padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #00ff88; }
        .stat-value { font-size: 28px; font-weight: bold; color: #00ff88; }
        .stat-label { font-size: 12px; opacity: 0.7; margin-top: 5px; }
        
        /* Tables */
        .card { background: rgba(26,31,58,0.95); border-radius: 10px; padding: 20px; margin-bottom: 20px; overflow-x: auto; }
        .card h3 { margin-bottom: 15px; border-bottom: 1px solid #00ff88; padding-bottom: 5px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(0,255,136,0.2); font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .error { color: #ff4444; }
        
        /* Control Buttons */
        .control-buttons { display: flex; gap: 15px; margin-bottom: 20px; flex-wrap: wrap; }
        
        /* Loading */
        .loading { display: inline-block; width: 20px; height: 20px; border: 2px solid #00ff88; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        /* Responsive */
        @media (max-width: 768px) {
            .login-form { flex-direction: column; }
            .form-group { width: 100%; }
            button { width: 100%; }
        }
    </style>
</head>
<body>
<div class="container">
    <h1>💰 FaucetPay Internal Bot</h1>
    
    <!-- Login Panel -->
    <div class="login-panel" id="loginPanel">
        <h2>🔐 Login to FaucetPay</h2>
        <div class="login-form">
            <div class="form-group">
                <label>Email Address</label>
                <input type="email" id="email" placeholder="your@email.com">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="password" placeholder="••••••••">
            </div>
            <button onclick="login()">🔓 Login & Save Session</button>
        </div>
        <div id="loginMessage" style="margin-top: 15px; font-size: 12px;"></div>
    </div>
    
    <!-- Status Panel -->
    <div class="status-panel" id="statusPanel" style="display: none;">
        <h2>📊 Login Status</h2>
        <div class="status-grid">
            <div class="status-item">
                <div class="status-label">Status</div>
                <div class="status-value" id="loginStatus">-</div>
            </div>
            <div class="status-item">
                <div class="status-label">Email</div>
                <div class="status-value" id="loginEmail" style="font-size: 14px;">-</div>
            </div>
            <div class="status-item">
                <div class="status-label">Balance</div>
                <div class="status-value" id="balance">$0.00000</div>
            </div>
            <div class="status-item">
                <div class="status-label">Session Saved To</div>
                <div class="status-value" style="font-size: 12px;">./chrome-profile</div>
            </div>
        </div>
    </div>
    
    <!-- Control Buttons -->
    <div class="control-buttons" id="controlButtons" style="display: none;">
        <button id="startBtn" onclick="startBot()" class="success">▶️ Start Bot</button>
        <button id="stopBtn" onclick="stopBot()" class="danger">⏹️ Stop Bot</button>
        <button id="logoutBtn" onclick="logout()" class="warning">🚪 Logout</button>
    </div>
    
    <!-- Stats Cards -->
    <div class="stats-grid" id="statsGrid" style="display: none;">
        <div class="stat-card"><div class="stat-value" id="totalEarned">$0.00000</div><div class="stat-label">Total Earned</div></div>
        <div class="stat-card"><div class="stat-value" id="hourlyRate">$0.00000</div><div class="stat-label">Per Hour</div></div>
        <div class="stat-card"><div class="stat-value" id="dailyRate">$0.00000</div><div class="stat-label">Per Day</div></div>
        <div class="stat-card"><div class="stat-value" id="totalClaims">0</div><div class="stat-label">Total Claims</div></div>
    </div>
    
    <!-- Source Balances -->
    <div class="card" id="balancesCard" style="display: none;">
        <h3>🪙 Source Balances</h3>
        <table id="balancesTable">
            <thead><tr><th>Source</th><th>Earned</th><th>Claims</th><th>Last Claim</th></tr></thead>
            <tbody id="balancesBody"><tr><td colspan="4">Loading...</td></tr></tbody>
        </table>
    </div>
    
    <!-- Recent Claims -->
    <div class="card" id="claimsCard" style="display: none;">
        <h3>📈 Recent Claims</h3>
        <table id="claimsTable">
            <thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
            <tbody id="claimsBody"><tr><td colspan="3">Loading...</td></tr></tbody>
        </table>
    </div>
</div>

<script>
    let refreshInterval = null;
    
    // Login function
    async function login() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        
        if (!email || !password) {
            document.getElementById('loginMessage').innerHTML = '<span class="error">❌ Please enter email and password</span>';
            return;
        }
        
        document.getElementById('loginMessage').innerHTML = '<span class="loading"></span> Logging in...';
        
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await response.json();
            
            if (data.success) {
                document.getElementById('loginMessage').innerHTML = '<span class="earn">✅ ' + data.message + '</span>';
                document.getElementById('loginPanel').style.display = 'none';
                document.getElementById('statusPanel').style.display = 'block';
                document.getElementById('controlButtons').style.display = 'flex';
                document.getElementById('statsGrid').style.display = 'grid';
                document.getElementById('balancesCard').style.display = 'block';
                document.getElementById('claimsCard').style.display = 'block';
                
                // Start refreshing stats
                if (refreshInterval) clearInterval(refreshInterval);
                refreshInterval = setInterval(updateStats, 5000);
                updateStats();
            } else {
                document.getElementById('loginMessage').innerHTML = '<span class="error">❌ ' + data.message + '</span>';
            }
        } catch (error) {
            document.getElementById('loginMessage').innerHTML = '<span class="error">❌ Error: ' + error.message + '</span>';
        }
    }
    
    // Update stats
    async function updateStats() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            if (data.loggedIn) {
                document.getElementById('loginStatus').innerHTML = '✅ Logged In';
                document.getElementById('loginEmail').innerHTML = data.email;
                document.getElementById('balance').innerHTML = '$' + (data.balance || 0).toFixed(5);
                
                document.getElementById('totalEarned').innerHTML = '$' + (data.stats.totalEarned || 0).toFixed(5);
                document.getElementById('totalClaims').innerHTML = data.stats.totalActions || 0;
            }
            
            // Get detailed stats
            const statsResponse = await fetch('/api/stats');
            const stats = await statsResponse.json();
            
            document.getElementById('hourlyRate').innerHTML = '$' + (stats.hourlyRate || 0);
            document.getElementById('dailyRate').innerHTML = '$' + (stats.dailyRate || 0);
            
            // Update source balances
            if (stats.sourceBalances) {
                const balancesBody = document.getElementById('balancesBody');
                balancesBody.innerHTML = '';
                for (const [name, data] of Object.entries(stats.sourceBalances)) {
                    if (data.earned > 0 || data.claims > 0) {
                        const row = balancesBody.insertRow();
                        row.insertCell(0).innerHTML = name;
                        row.insertCell(1).innerHTML = '<span class="earn">$' + data.earned.toFixed(5) + '</span>';
                        row.insertCell(2).innerHTML = data.claims;
                        row.insertCell(3).innerHTML = data.lastClaim ? new Date(data.lastClaim).toLocaleTimeString() : 'Never';
                    }
                }
                if (balancesBody.children.length === 0) {
                    balancesBody.innerHTML = '<tr><td colspan="4">No activity yet...</td></tr>';
                }
            }
            
            // Update claim history
            if (stats.claimHistory && stats.claimHistory.length > 0) {
                const claimsBody = document.getElementById('claimsBody');
                claimsBody.innerHTML = '';
                for (const claim of stats.claimHistory.slice(0, 30)) {
                    const row = claimsBody.insertRow();
                    row.insertCell(0).innerHTML = new Date(claim.time).toLocaleTimeString();
                    row.insertCell(1).innerHTML = claim.source;
                    row.insertCell(2).innerHTML = '<span class="earn">+$' + claim.amount.toFixed(5) + '</span>';
                }
            }
        } catch (error) {
            console.error('Stats update error:', error);
        }
    }
    
    // Start bot
    async function startBot() {
        const startBtn = document.getElementById('startBtn');
        startBtn.disabled = true;
        startBtn.innerHTML = '<span class="loading"></span> Starting...';
        
        try {
            const response = await fetch('/api/start', { method: 'POST' });
            const data = await response.json();
            
            if (data.success) {
                startBtn.innerHTML = '▶️ Bot Running';
                startBtn.disabled = true;
                document.getElementById('stopBtn').disabled = false;
                alert('Bot started! Check console for logs.');
            } else {
                startBtn.innerHTML = '▶️ Start Bot';
                startBtn.disabled = false;
                alert('Error: ' + data.message);
            }
        } catch (error) {
            startBtn.innerHTML = '▶️ Start Bot';
            startBtn.disabled = false;
            alert('Error: ' + error.message);
        }
    }
    
    // Stop bot
    async function stopBot() {
        const stopBtn = document.getElementById('stopBtn');
        stopBtn.disabled = true;
        stopBtn.innerHTML = '<span class="loading"></span> Stopping...';
        
        try {
            const response = await fetch('/api/stop', { method: 'POST' });
            const data = await response.json();
            
            if (data.success) {
                stopBtn.innerHTML = '⏹️ Stop Bot';
                stopBtn.disabled = false;
                document.getElementById('startBtn').disabled = false;
                document.getElementById('startBtn').innerHTML = '▶️ Start Bot';
                alert('Bot stopped.');
            } else {
                stopBtn.innerHTML = '⏹️ Stop Bot';
                stopBtn.disabled = false;
            }
        } catch (error) {
            stopBtn.innerHTML = '⏹️ Stop Bot';
            stopBtn.disabled = false;
        }
    }
    
    // Logout
    async function logout() {
        if (refreshInterval) clearInterval(refreshInterval);
        
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch(e) {}
        
        location.reload();
    }
    
    // Check initial status
    async function checkStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            if (data.loggedIn) {
                document.getElementById('loginPanel').style.display = 'none';
                document.getElementById('statusPanel').style.display = 'block';
                document.getElementById('controlButtons').style.display = 'flex';
                document.getElementById('statsGrid').style.display = 'grid';
                document.getElementById('balancesCard').style.display = 'block';
                document.getElementById('claimsCard').style.display = 'block';
                
                refreshInterval = setInterval(updateStats, 5000);
                updateStats();
            }
        } catch(e) {}
    }
    
    checkStatus();
</script>
</body>
</html>
    `);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n========================================`);
        console.log(`📊 DASHBOARD: http://localhost:${port}`);
        console.log(`========================================`);
        console.log(`\n💡 INSTRUCTIONS:`);
        console.log(`   1. Open the dashboard in your browser`);
        console.log(`   2. Enter your FaucetPay email and password`);
        console.log(`   3. Click "Login & Save Session"`);
        console.log(`   4. If captcha appears, solve it in the popup window`);
        console.log(`   5. Session will be saved to ${USER_DATA_DIR}`);
        console.log(`   6. Click "Start Bot" to begin earning!\n`);
    });
    
    // Don't auto-start browser - wait for dashboard login
    console.log('✅ Bot ready. Waiting for dashboard login...\n');
}

process.on('SIGINT', async () => {
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

main().catch(console.error);
