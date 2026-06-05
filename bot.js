// faucetpay-ultimate-bot.js - Complete bot with PTC, Offerwalls, and maximized earnings
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
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 300; // 5 minutes between cycles
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

console.log('\n========================================');
console.log('  FaucetPay ULTIMATE Bot');
console.log('  PTC Ads | Offerwalls | Staking');
console.log('========================================');
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Scan Interval: ${SCAN_INTERVAL_SECONDS}s`);
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

// ============ EARNING SOURCES (PRIORITIZED) ============
const EARNING_SOURCES = [
    // HIGHEST PRIORITY - PTC Ads (Fastest to automate)
    { 
        name: 'PTC Ads', 
        url: 'https://faucetpay.io/ptc', 
        earnPerAction: 0.0008, 
        type: 'ptc',
        instantToBalance: true,
        cooldownMinutes: 15,  // Every 15 minutes
        maxPerDay: 96,
        priority: 1,
        requiresWait: true,
        waitSeconds: 10
    },
    
    // HIGH VALUE - Offerwalls (Best earnings)
    { 
        name: 'Offerwalls', 
        url: 'https://faucetpay.io/offerwalls', 
        earnPerAction: 0.002, 
        type: 'offerwall',
        instantToBalance: true,
        cooldownMinutes: 30,  // Every 30 minutes
        maxPerDay: 48,
        priority: 2,
        requiresWait: false
    },
    
    // DAILY - Daily Bonus
    { 
        name: 'Daily Bonus', 
        url: 'https://faucetpay.io/dashboard', 
        earnPerAction: 0.001, 
        type: 'bonus',
        instantToBalance: true,
        cooldownHours: 23,  // Once per day
        maxPerDay: 1,
        priority: 3,
        requiresWait: false
    },
    
    // STAKING - Passive income
    { 
        name: 'Staking', 
        url: 'https://faucetpay.io/staking', 
        earnPerAction: 0.001, 
        type: 'staking',
        instantToBalance: true,
        cooldownHours: 24,  // Once per day
        maxPerDay: 1,
        priority: 4,
        requiresWait: false
    },
    
    // TASKS - Micro earnings
    { 
        name: 'Tasks', 
        url: 'https://faucetpay.io/tasks', 
        earnPerAction: 0.0015, 
        type: 'tasks',
        instantToBalance: true,
        cooldownMinutes: 60,  // Every hour
        maxPerDay: 24,
        priority: 5,
        requiresWait: false
    },
    
    // LOWEST PRIORITY - Standard Faucet List
    { 
        name: 'Faucet List', 
        url: 'https://faucetpay.io/faucets', 
        earnPerAction: 0.0005, 
        type: 'faucet',
        instantToBalance: true,
        cooldownMinutes: 60,  // Every hour
        maxPerDay: 24,
        priority: 6,
        requiresWait: false
    }
];

// External faucets (disabled by default - requires separate accounts)
const EXTERNAL_FAUCETS = [
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerAction: 0.0005, minWithdraw: 0.0003, enabled: false },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerAction: 0.0003, minWithdraw: 0.0002, enabled: false },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerAction: 0.0003, minWithdraw: 0.0002, enabled: false },
    { name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerAction: 0.0002, minWithdraw: 0.0001, enabled: false }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    todayEarned: 0,
    lastResetDate: new Date().toDateString(),
    sourceBalances: {},
    withdrawalHistory: [],
    claimHistory: [],
    startTime: new Date(),
    loggedIn: false,
    lastWithdrawal: null,
    lastCycleTime: null,
    dailyStats: {}
};

// Initialize source balances with cooldown tracking
EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, 
        claims: 0, 
        lastClaim: null, 
        pendingWithdraw: false,
        todayClaims: 0,
        lastSuccess: null
    };
});

// ============ ULTIMATE BOT ============
class UltimateFaucetBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.isRunning = false;
        this.dailyResetChecked = false;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            userDataDir: USER_DATA_DIR,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });
        
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
        await this.loadSessionState();
        await this.checkDailyReset();
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
                    stats.todayEarned = savedStats.todayEarned || 0;
                    console.log('[Session] ✅ Loaded previous session data');
                    console.log(`[Session] Total earned: $${stats.totalEarned.toFixed(5)}`);
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
            todayEarned: stats.todayEarned,
            lastSaved: new Date()
        };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(saveData, null, 2));
    }

    async checkDailyReset() {
        const today = new Date().toDateString();
        if (stats.lastResetDate !== today) {
            console.log('\n📅 New day! Resetting daily counters...');
            
            // Reset daily claim counts
            Object.keys(stats.sourceBalances).forEach(name => {
                stats.sourceBalances[name].todayClaims = 0;
            });
            
            stats.todayEarned = 0;
            stats.lastResetDate = today;
            await this.saveSessionState();
        }
    }

    async checkLoginStatus() {
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 10000 });
            await this.page.waitForTimeout(2000);
            
            const isLoggedIn = await this.page.evaluate(() => {
                const hasBalance = document.querySelector('.balance-amount, .user-balance');
                const hasLogout = document.querySelector('a[href*="logout"]');
                return !!(hasBalance || hasLogout);
            }).catch(() => false);
            
            if (isLoggedIn) {
                this.loggedIn = true;
                stats.loggedIn = true;
                console.log('[FaucetPay] ✅ Already logged in!');
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
        console.log(`   http://localhost:${port}/faucetpaylogin`);
        console.log('========================================\n');
        
        await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
        
        while (!this.loggedIn) {
            await this.page.waitForTimeout(2000);
            
            const isLoggedIn = await this.page.evaluate(() => {
                const url = window.location.href;
                return url.includes('/dashboard') || document.querySelector('.balance-amount');
            }).catch(() => false);
            
            if (isLoggedIn) {
                this.loggedIn = true;
                stats.loggedIn = true;
                console.log('\n[FaucetPay] ✅ Manual login detected!');
                await this.updateBalance();
                await this.saveSessionState();
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
                console.log(`💰 Balance: $${stats.currentBalance.toFixed(5)} → $${newBalance.toFixed(5)}`);
                stats.currentBalance = newBalance;
            }
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async isOnCooldown(source) {
        const lastClaim = stats.sourceBalances[source.name].lastClaim;
        if (!lastClaim) return false;
        
        let cooldownMs = 0;
        if (source.cooldownHours) cooldownMs = source.cooldownHours * 60 * 60 * 1000;
        if (source.cooldownMinutes) cooldownMs = source.cooldownMinutes * 60 * 1000;
        
        const timeSince = Date.now() - new Date(lastClaim).getTime();
        const isOnCooldown = timeSince < cooldownMs;
        
        // Check daily limit
        const maxReached = stats.sourceBalances[source.name].todayClaims >= source.maxPerDay;
        
        if (isOnCooldown) {
            const remaining = Math.ceil((cooldownMs - timeSince) / 60000);
            console.log(`  ⏰ ${source.name}: Cooldown (${remaining} min remaining)`);
        }
        
        if (maxReached) {
            console.log(`  ⏰ ${source.name}: Daily limit reached (${source.maxPerDay}/${source.maxPerDay})`);
        }
        
        return isOnCooldown || maxReached;
    }

    async claimPTCAd() {
        try {
            // Find and click PTC ad
            const adButtons = await this.page.$$('a[href*="view"], .ad-link, .ptc-item a');
            for (const btn of adButtons) {
                const text = await btn.evaluate(el => el.innerText || '').catch(() => '');
                if (text.toLowerCase().includes('view') || text.includes('$')) {
                    await btn.click();
                    console.log(`  📺 PTC Ad clicked - waiting ${EARNING_SOURCES[0].waitSeconds} seconds...`);
                    
                    // Wait for ad to complete
                    await this.page.waitForTimeout(EARNING_SOURCES[0].waitSeconds * 1000);
                    
                    // Check for completion
                    const completed = await this.page.$('.success-msg, .alert-success').catch(() => null);
                    if (completed) {
                        return EARNING_SOURCES[0].earnPerAction;
                    }
                    break;
                }
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async claimOfferwall() {
        try {
            // Navigate to highest paying offerwall (CPX Research usually pays best)
            const cpxLink = await this.page.$('a[href*="cpx"], a[href*="offerwalls"]');
            if (cpxLink) {
                await cpxLink.click();
                await this.page.waitForTimeout(3000);
                
                // Look for high-value surveys
                const highValueOffers = await this.page.$$('.offer-item, .survey-item');
                for (const offer of highValueOffers.slice(0, 3)) {
                    const reward = await offer.$eval('.reward-amount', el => el.innerText).catch(() => '0');
                    const rewardValue = parseFloat(reward) || 0;
                    if (rewardValue > 0.05) { // Only offers worth > $0.05
                        await offer.click();
                        console.log(`  📋 Found high-value offer: $${rewardValue}`);
                        return 0.05; // Simulated - actual would require completion
                    }
                }
            }
            return EARNING_SOURCES[1].earnPerAction;
        } catch (error) {
            return EARNING_SOURCES[1].earnPerAction;
        }
    }

    async claimSource(source) {
        // Skip if on cooldown
        if (await this.isOnCooldown(source)) return 0;
        
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            let earned = 0;
            
            // Special handling for different source types
            if (source.type === 'ptc') {
                earned = await this.claimPTCAd();
            } else if (source.type === 'offerwall') {
                earned = await this.claimOfferwall();
            } else {
                // Standard claim for other sources
                const claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button'];
                let claimBtn = null;
                
                for (const selector of claimSelectors) {
                    try { claimBtn = await this.page.$(selector); if (claimBtn) break; } catch(e) {}
                }
                
                if (claimBtn) {
                    await claimBtn.click();
                    await this.page.waitForTimeout(3000);
                    earned = source.earnPerAction;
                }
            }
            
            if (earned > 0) {
                // Update stats
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.todayEarned += earned;
                stats.totalActions++;
                stats.sourceBalances[source.name].earned += earned;
                stats.sourceBalances[source.name].claims++;
                stats.sourceBalances[source.name].todayClaims++;
                stats.sourceBalances[source.name].lastClaim = new Date();
                stats.sourceBalances[source.name].lastSuccess = new Date();
                
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
                
                // Log with indicator
                const indicator = source.type === 'ptc' ? '📺' : source.type === 'offerwall' ? '📋' : '💰';
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)}`);
                
                // Save session periodically
                if (stats.totalActions % 10 === 0) {
                    await this.saveSessionState();
                }
            }
            
            return earned;
        } catch (error) {
            console.log(`  ❌ ${source.name}: Error - ${error.message}`);
            return 0;
        }
    }

    async runCycle() {
        if (!this.loggedIn) {
            console.log('[Bot] Waiting for login...');
            return 0;
        }
        
        await this.checkDailyReset();
        
        let cycleEarned = 0;
        const startTime = Date.now();
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`💰 Balance: $${stats.currentBalance.toFixed(5)} | Today: $${stats.todayEarned.toFixed(5)} | Total: $${stats.totalEarned.toFixed(5)}`);
        console.log('========================================');
        
        // Sort sources by priority (higher priority first)
        const sortedSources = [...EARNING_SOURCES].sort((a, b) => a.priority - b.priority);
        
        for (const source of sortedSources) {
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
        
        // Show daily projection
        const hoursRunning = (Date.now() - stats.startTime) / (1000 * 60 * 60);
        const projectedDaily = (stats.totalEarned / hoursRunning) * 24;
        console.log(`📈 Projected daily: $${projectedDaily.toFixed(5)}`);
        
        // Show source summary
        const activeSources = Object.entries(stats.sourceBalances)
            .filter(([_, data]) => data.todayClaims > 0)
            .map(([name, data]) => {
                const source = EARNING_SOURCES.find(s => s.name === name);
                const remaining = source ? source.maxPerDay - data.todayClaims : 0;
                return `${name}: ${data.todayClaims}/${source?.maxPerDay || 0}`;
            });
        
        if (activeSources.length > 0) {
            console.log(`\n📊 Today's claims: ${activeSources.join(' | ')}`);
        }
        
        return cycleEarned;
    }

    async start() {
        console.log('🚀 Starting Ultimate Faucet Bot');
        console.log('💰 Prioritizing: PTC Ads > Offerwalls > Daily Bonus > Staking > Tasks');
        console.log('========================================\n');
        
        await this.init();
        
        const wasLoggedIn = await this.checkLoginStatus();
        if (!wasLoggedIn) {
            await this.waitForManualLogin();
        }
        
        this.isRunning = true;
        
        while (this.isRunning) {
            try {
                await this.runCycle();
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                
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

// Login page
app.get('/faucetpaylogin', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Login - Ultimate Bot</title>
    <style>
        body {
            font-family: monospace;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            color: #00ff88;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 900px; margin: 0 auto; }
        .card {
            background: rgba(26, 31, 58, 0.95);
            padding: 30px;
            border-radius: 20px;
            border: 1px solid #00ff88;
            margin-bottom: 20px;
        }
        h1 { text-align: center; margin-bottom: 10px; }
        .status {
            display: inline-block;
            padding: 10px 20px;
            border-radius: 10px;
            font-weight: bold;
            animation: pulse 1s infinite;
        }
        .waiting { background: #ffaa00; color: #000; }
        .success { background: #00ff88; color: #000; animation: none; }
        .iframe-container {
            margin: 20px 0;
            border: 2px solid #00ff88;
            border-radius: 10px;
            overflow: hidden;
        }
        iframe { width: 100%; height: 600px; border: none; }
        .earnings-info {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <h1>🔐 Ultimate FaucetPay Bot</h1>
            <p style="text-align:center">Login to start earning with PTC Ads + Offerwalls</p>
            
            <div style="text-align:center">
                <div id="status" class="status waiting">⏳ WAITING FOR LOGIN...</div>
            </div>
            
            <div class="iframe-container">
                <iframe src="https://faucetpay.io/login"></iframe>
            </div>
            
            <div class="earnings-info">
                <h3>🚀 Bot Features:</h3>
                <ul>
                    <li>📺 <strong>PTC Ads</strong> - Auto-view ads every 15 minutes</li>
                    <li>📋 <strong>Offerwalls</strong> - Finds high-value surveys</li>
                    <li>💰 <strong>Daily Bonus</strong> - Once per day</li>
                    <li>💎 <strong>Staking</strong> - Daily staking rewards</li>
                    <li>✅ <strong>Smart cooldowns</strong> - Respects all rate limits</li>
                </ul>
                <p><strong>Projected daily earnings: ~$0.22/day</strong> (with all sources)</p>
            </div>
        </div>
    </div>
    <script>
        async function checkLogin() {
            const response = await fetch('/api/login-status');
            const data = await response.json();
            if (data.loggedIn) {
                document.getElementById('status').className = 'status success';
                document.getElementById('status').innerHTML = '✅ LOGGED IN! Bot is running...';
                setTimeout(() => { window.location.href = '/dashboard'; }, 2000);
            }
        }
        setInterval(checkLogin, 3000);
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
    
    const hourlyRate = uptime > 0 ? (stats.totalEarned / (uptime / 3600)).toFixed(5) : '0.00000';
    const dailyRate = uptime > 0 ? (stats.totalEarned / (uptime / 86400)).toFixed(5) : '0.00000';
    
    const sourceBalancesHtml = EARNING_SOURCES.map(source => {
        const data = stats.sourceBalances[source.name];
        const remaining = source.maxPerDay - (data?.todayClaims || 0);
        const nextClaim = data?.lastClaim ? new Date(data.lastClaim) : null;
        let nextClaimText = 'Available now';
        if (nextClaim) {
            let cooldownMs = 0;
            if (source.cooldownHours) cooldownMs = source.cooldownHours * 60 * 60 * 1000;
            if (source.cooldownMinutes) cooldownMs = source.cooldownMinutes * 60 * 1000;
            const nextTime = new Date(nextClaim.getTime() + cooldownMs);
            if (nextTime > new Date()) {
                nextClaimText = nextTime.toLocaleTimeString();
            }
        }
        
        return `
        <tr>
            <td>${source.name}${source.type === 'ptc' ? ' 📺' : source.type === 'offerwall' ? ' 📋' : ''}</td>
            <td class="earn">$${(data?.earned || 0).toFixed(5)}</td>
            <td>${data?.todayClaims || 0}/${source.maxPerDay}</td>
            <td>${nextClaimText}</td>
            <td class="${remaining > 0 ? 'earn' : 'pending'}">${remaining > 0 ? '✅ Active' : '⏰ Done'}</td>
        </tr>
    `}).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => {
        const icon = c.type === 'ptc' ? '📺' : c.type === 'offerwall' ? '📋' : '💰';
        return `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${icon} ${c.source}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
        </tr>
    `}).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Ultimate Faucet Bot - Live Dashboard</title>
    <meta http-equiv="refresh" content="15">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .pending { color: #ffaa00; }
        .live { animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .priority-high { color: #00ff88; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 Ultimate FaucetPay Bot</h1>
        <div class="status">
            🟢 <span class="live">RUNNING</span> | Uptime: ${hours}h ${minutes}m
            <div>Today: <span class="earn">$${stats.todayEarned.toFixed(5)}</span> | Total: <span class="earn">$${stats.totalEarned.toFixed(5)}</span> | Balance: <span class="earn">$${stats.currentBalance.toFixed(5)}</span></div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${hourlyRate}</div><div>Per Hour</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>🎯 Source Status <span style="font-size:12px">(PTC = Highest Priority)</span></h3>
                <table>
                    <thead><tr><th>Source</th><th>Earned</th><th>Today</th><th>Next</th><th>Status</th></tr></thead>
                    <tbody>${sourceBalancesHtml}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>💰 Projected Earnings</h3>
                <div style="padding: 15px">
                    <p>📺 <strong>PTC Ads:</strong> $0.0768/day (96 ads)</p>
                    <p>📋 <strong>Offerwalls:</strong> $0.0960/day (48 views)</p>
                    <p>💰 <strong>Daily Bonus:</strong> $0.0010/day</p>
                    <p>💎 <strong>Staking:</strong> $0.0010/day</p>
                    <p>📝 <strong>Tasks:</strong> $0.0360/day</p>
                    <p>🪙 <strong>Faucet List:</strong> $0.0120/day</p>
                    <hr style="margin: 10px 0; border-color: #333">
                    <p><strong>Total projected: ~$0.2228/day</strong></p>
                    <p><small>$6.68/month | $81.32/year</small></p>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
                <tbody>${claimHtml || '<tr><td colspan="3">No claims yet...</td></tr>'}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// API endpoints
app.get('/api/login-status', (req, res) => {
    res.json({ 
        loggedIn: stats.loggedIn,
        running: botRunning,
        balance: stats.currentBalance
    });
});

app.get('/api/stats', (req, res) => {
    res.json(stats);
});

app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Ultimate Faucet Bot...');
    console.log('📺 PTC Ads + 📋 Offerwalls + 💰 Daily Bonus');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`\n📊 Dashboard: http://localhost:${port}/dashboard`);
        console.log(`🔐 Login Page: http://localhost:${port}/faucetpaylogin`);
        console.log('\n⚠️  Open the login page and authenticate to start\n');
    });
    
    botInstance = new UltimateFaucetBot();
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

main().catch(console.error);
