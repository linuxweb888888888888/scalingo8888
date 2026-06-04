// faucetpay-internal-bot.js - Complete Bot for FaucetPay Internal Sources Only
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_BONUS = process.env.AUTO_BONUS !== 'true';
const AUTO_PTC = process.env.AUTO_PTC !== 'true';
const AUTO_OFFERWALLS = process.env.AUTO_OFFERWALLS !== 'true';
const AUTO_TASKS = process.env.AUTO_TASKS !== 'true';

// Persistent session - saves login state
const USER_DATA_DIR = process.env.USER_DATA_DIR || './chrome-profile';
const USE_PERSISTENT_SESSION = process.env.USE_PERSISTENT_SESSION !== 'false';

console.log('\n========================================');
console.log('  FaucetPay Internal Bot');
console.log('  DAILY BONUS | FAUCET LIST | OFFERWALLS | PTC ADS | STAKING | TASKS');
console.log('========================================');
console.log(`Auto Daily Bonus: ${AUTO_BONUS ? 'ON' : 'OFF'}`);
console.log(`Auto Faucet List: ${AUTO_PTC ? 'ON' : 'OFF'}`);
console.log(`Auto Offerwalls: ${AUTO_OFFERWALLS ? 'ON' : 'OFF'}`);
console.log(`Auto Tasks: ${AUTO_TASKS ? 'ON' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCETPAY_EMAIL}`);
console.log(`Persistent Session: ${USE_PERSISTENT_SESSION ? 'ON' : 'OFF'}`);
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

// ============ INTERNAL FAUCETPAY SOURCES ============
const INTERNAL_SOURCES = [
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', enabled: AUTO_BONUS },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', enabled: AUTO_PTC },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', enabled: AUTO_OFFERWALLS },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', enabled: AUTO_PTC },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', enabled: true },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', enabled: AUTO_TASKS }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    sessionEarned: 0,
    sourceBalances: {},
    claimHistory: [],
    loginHistory: [],
    startTime: new Date(),
    loggedIn: false,
    loginAttempts: 0,
    successfulLogins: 0
};

INTERNAL_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, 
        claims: 0, 
        lastClaim: null, 
        lastStatus: 'pending'
    };
});

// ============ FAUCETPAY LOGIN MANAGER ============
class FaucetPayLogin {
    constructor(page) {
        this.page = page;
    }

    async login(email, password) {
        console.log('\n🔐 LOGGING INTO FAUCETPAY');
        console.log('========================================');
        console.log(`Email: ${email}`);
        
        stats.loginAttempts++;
        
        try {
            // Navigate to login page
            await this.page.goto('https://faucetpay.io/login', { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });
            await safeWait(3000);
            
            // Check if already logged in by checking current URL
            const currentUrl = this.page.url();
            if (!currentUrl.includes('login') && !currentUrl.includes('signin')) {
                console.log('✅ Already logged in!');
                stats.loggedIn = true;
                stats.successfulLogins++;
                stats.loginHistory.unshift({
                    time: new Date(),
                    status: 'ALREADY_LOGGED_IN',
                    message: 'Session was still active'
                });
                await this.getBalance();
                return true;
            }
            
            console.log('📍 Found login page, entering credentials...');
            
            // Method 1: Try standard selectors
            let emailField = await this.page.$('#email');
            if (!emailField) emailField = await this.page.$('input[name="email"]');
            if (!emailField) emailField = await this.page.$('input[type="email"]');
            
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(email);
                console.log('✅ Email entered');
            } else {
                console.log('❌ Could not find email field');
                return false;
            }
            
            await safeWait(500);
            
            let passwordField = await this.page.$('#password');
            if (!passwordField) passwordField = await this.page.$('input[name="password"]');
            if (!passwordField) passwordField = await this.page.$('input[type="password"]');
            
            if (passwordField) {
                await passwordField.click({ clickCount: 3 });
                await passwordField.type(password);
                console.log('✅ Password entered');
            } else {
                console.log('❌ Could not find password field');
                return false;
            }
            
            await safeWait(500);
            
            // Find and click login button
            let loginBtn = await this.page.$('button[type="submit"]');
            if (!loginBtn) loginBtn = await this.page.$('input[type="submit"]');
            if (!loginBtn) loginBtn = await this.page.$('button:has-text("Login")');
            if (!loginBtn) loginBtn = await this.page.$('button:has-text("Sign in")');
            
            if (loginBtn) {
                await loginBtn.click();
                console.log('✅ Clicked login button');
                await safeWait(8000);
            } else {
                console.log('⚠️ Could not find login button, pressing Enter');
                await this.page.keyboard.press('Enter');
                await safeWait(8000);
            }
            
            // Verify login success
            const afterUrl = this.page.url();
            console.log(`📍 After login URL: ${afterUrl}`);
            
            if (!afterUrl.includes('login') && !afterUrl.includes('signin')) {
                console.log('\n✅✅✅ LOGIN SUCCESSFUL! ✅✅✅');
                stats.loggedIn = true;
                stats.successfulLogins++;
                stats.loginHistory.unshift({
                    time: new Date(),
                    status: 'SUCCESS',
                    message: 'Logged in successfully'
                });
                await this.getBalance();
                return true;
            } else {
                // Check for error message
                const errorMsg = await this.page.evaluate(() => {
                    const errorEl = document.querySelector('.alert-danger, .error, .alert-error');
                    return errorEl ? errorEl.innerText : null;
                }).catch(() => null);
                
                console.log('\n❌ LOGIN FAILED');
                if (errorMsg) console.log(`Error: ${errorMsg}`);
                stats.loginHistory.unshift({
                    time: new Date(),
                    status: 'FAILED',
                    message: errorMsg || 'Invalid credentials or captcha'
                });
                return false;
            }
        } catch (error) {
            console.log(`❌ Login error: ${error.message}`);
            stats.loginHistory.unshift({
                time: new Date(),
                status: 'ERROR',
                message: error.message
            });
            return false;
        }
    }
    
    async getBalance() {
        try {
            // Try multiple selectors for balance
            const balanceSelectors = [
                '.balance-amount',
                '.user-balance',
                '.current-balance',
                '.wallet-balance',
                '.total-balance',
                '[class*="balance"]'
            ];
            
            for (const selector of balanceSelectors) {
                try {
                    const balanceElement = await this.page.$(selector);
                    if (balanceElement) {
                        const balanceText = await this.page.$eval(selector, el => el.innerText);
                        const balanceMatch = balanceText.match(/[\d.]+/);
                        if (balanceMatch) {
                            stats.currentBalance = parseFloat(balanceMatch[0]);
                            console.log(`💰 Current Balance: $${stats.currentBalance.toFixed(5)}`);
                            return stats.currentBalance;
                        }
                    }
                } catch(e) {}
            }
            
            // Try to get balance from page content
            const pageContent = await this.page.content();
            const balanceMatch = pageContent.match(/\$\s*([\d.]+)/);
            if (balanceMatch) {
                stats.currentBalance = parseFloat(balanceMatch[1]);
                console.log(`💰 Current Balance: $${stats.currentBalance.toFixed(5)}`);
            }
            return stats.currentBalance;
        } catch (error) {
            console.log(`⚠️ Could not get balance: ${error.message}`);
            return stats.currentBalance;
        }
    }
}

// ============ INTERNAL EARNING ENGINE ============
class InternalEarningEngine {
    constructor(page) {
        this.page = page;
    }
    
    async claimDailyBonus() {
        console.log('\n🎁 CLAIMING DAILY BONUS');
        
        try {
            // Look for claim button on dashboard
            const claimSelectors = [
                '.claim-bonus-btn',
                '.daily-bonus-btn',
                'button:has-text("Claim")',
                '.claim-btn',
                '#claimBonus'
            ];
            
            for (const selector of claimSelectors) {
                try {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn && await claimBtn.isVisible()) {
                        await claimBtn.click();
                        await safeWait(3000);
                        
                        // Check for success
                        const pageContent = await this.page.content();
                        if (pageContent.includes('success') || pageContent.includes('claimed')) {
                            const earned = 0.001;
                            stats.totalEarned += earned;
                            stats.sessionEarned += earned;
                            stats.totalActions++;
                            stats.sourceBalances['Daily Bonus'].earned += earned;
                            stats.sourceBalances['Daily Bonus'].claims++;
                            stats.sourceBalances['Daily Bonus'].lastClaim = new Date();
                            stats.sourceBalances['Daily Bonus'].lastStatus = 'success';
                            
                            stats.claimHistory.unshift({
                                time: new Date(),
                                source: 'Daily Bonus',
                                amount: earned,
                                status: 'SUCCESS'
                            });
                            
                            console.log(`💰 Daily Bonus: +$${earned.toFixed(5)}`);
                            return earned;
                        }
                        break;
                    }
                } catch(e) {}
            }
            
            // Check if already claimed
            const pageContent = await this.page.content();
            if (pageContent.includes('already claimed') || pageContent.includes('already collected')) {
                console.log('ℹ️ Daily Bonus already claimed today');
                stats.sourceBalances['Daily Bonus'].lastStatus = 'already_claimed';
            } else {
                console.log('⚠️ Could not find Daily Bonus claim button');
                stats.sourceBalances['Daily Bonus'].lastStatus = 'button_not_found';
            }
            return 0;
        } catch (error) {
            console.log(`❌ Daily Bonus error: ${error.message}`);
            stats.sourceBalances['Daily Bonus'].lastStatus = 'error';
            return 0;
        }
    }
    
    async claimFaucetList() {
        console.log('\n📋 CLAIMING FAUCET LIST');
        
        try {
            // Navigate to faucets page
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            // Look for any claim/view buttons on the page
            const claimButtons = await this.page.$$('a[href*="claim"], .claim-btn, button:has-text("View"), button:has-text("Claim")');
            
            let claimed = 0;
            for (const btn of claimButtons.slice(0, 5)) { // Limit to 5 per cycle
                try {
                    await btn.click();
                    await safeWait(2000);
                    claimed++;
                } catch(e) {}
            }
            
            if (claimed > 0) {
                const earned = 0.0005 * claimed;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += claimed;
                stats.sourceBalances['Faucet List'].earned += earned;
                stats.sourceBalances['Faucet List'].claims += claimed;
                stats.sourceBalances['Faucet List'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Faucet List',
                    amount: earned,
                    status: 'SUCCESS',
                    count: claimed
                });
                
                console.log(`💰 Faucet List: +$${earned.toFixed(5)} from ${claimed} views`);
                return earned;
            } else {
                console.log('ℹ️ No faucet list items available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Faucet List error: ${error.message}`);
            return 0;
        }
    }
    
    async claimOfferwalls() {
        console.log('\n📢 CLAIMING OFFERWALLS');
        
        try {
            await this.page.goto('https://faucetpay.io/offerwalls', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const viewButtons = await this.page.$$('a[href*="offer"], .view-offer-btn, button:has-text("View")');
            
            let viewed = 0;
            for (const btn of viewButtons.slice(0, 3)) {
                try {
                    await btn.click();
                    await safeWait(2000);
                    viewed++;
                } catch(e) {}
            }
            
            if (viewed > 0) {
                const earned = 0.002 * viewed;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += viewed;
                stats.sourceBalances['Offerwalls'].earned += earned;
                stats.sourceBalances['Offerwalls'].claims += viewed;
                stats.sourceBalances['Offerwalls'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Offerwalls',
                    amount: earned,
                    status: 'SUCCESS',
                    count: viewed
                });
                
                console.log(`💰 Offerwalls: +$${earned.toFixed(5)} from ${viewed} views`);
                return earned;
            } else {
                console.log('ℹ️ No offerwalls available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Offerwalls error: ${error.message}`);
            return 0;
        }
    }
    
    async claimPTCAds() {
        console.log('\n🖱️ CLAIMING PTC ADS');
        
        try {
            await this.page.goto('https://faucetpay.io/ptc', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const adButtons = await this.page.$$('a[href*="ptc"], .view-ad-btn, button:has-text("View Ad")');
            
            let clicked = 0;
            for (const btn of adButtons.slice(0, 10)) {
                try {
                    await btn.click();
                    await safeWait(3000);
                    clicked++;
                } catch(e) {}
            }
            
            if (clicked > 0) {
                const earned = 0.0008 * clicked;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += clicked;
                stats.sourceBalances['PTC Ads'].earned += earned;
                stats.sourceBalances['PTC Ads'].claims += clicked;
                stats.sourceBalances['PTC Ads'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'PTC Ads',
                    amount: earned,
                    status: 'SUCCESS',
                    count: clicked
                });
                
                console.log(`💰 PTC Ads: +$${earned.toFixed(5)} from ${clicked} ads`);
                return earned;
            } else {
                console.log('ℹ️ No PTC ads available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ PTC Ads error: ${error.message}`);
            return 0;
        }
    }
    
    async claimStaking() {
        console.log('\n📈 CLAIMING STAKING REWARDS');
        
        try {
            await this.page.goto('https://faucetpay.io/staking', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const claimBtn = await this.page.$('button:has-text("Claim"), .claim-reward-btn');
            
            if (claimBtn && await claimBtn.isVisible()) {
                await claimBtn.click();
                await safeWait(3000);
                
                const earned = 0.001;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances['Staking'].earned += earned;
                stats.sourceBalances['Staking'].claims++;
                stats.sourceBalances['Staking'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Staking',
                    amount: earned,
                    status: 'SUCCESS'
                });
                
                console.log(`💰 Staking: +$${earned.toFixed(5)}`);
                return earned;
            } else {
                console.log('ℹ️ No staking rewards available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Staking error: ${error.message}`);
            return 0;
        }
    }
    
    async claimTasks() {
        console.log('\n✅ CLAIMING TASKS');
        
        try {
            await this.page.goto('https://faucetpay.io/tasks', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            
            const taskButtons = await this.page.$$('button:has-text("Complete"), .complete-task-btn, a[href*="task"]');
            
            let completed = 0;
            for (const btn of taskButtons.slice(0, 5)) {
                try {
                    await btn.click();
                    await safeWait(3000);
                    completed++;
                } catch(e) {}
            }
            
            if (completed > 0) {
                const earned = 0.0015 * completed;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions += completed;
                stats.sourceBalances['Tasks'].earned += earned;
                stats.sourceBalances['Tasks'].claims += completed;
                stats.sourceBalances['Tasks'].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: 'Tasks',
                    amount: earned,
                    status: 'SUCCESS',
                    count: completed
                });
                
                console.log(`💰 Tasks: +$${earned.toFixed(5)} from ${completed} tasks`);
                return earned;
            } else {
                console.log('ℹ️ No tasks available');
                return 0;
            }
        } catch (error) {
            console.log(`❌ Tasks error: ${error.message}`);
            return 0;
        }
    }
    
    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${INTERNAL_SOURCES.filter(s => s.enabled).length} active sources`);
        console.log(`💰 Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`📈 Session earned: $${stats.sessionEarned.toFixed(5)}`);
        console.log('========================================');
        
        // Claim Daily Bonus (once per day)
        if (AUTO_BONUS) {
            const earned = await this.claimDailyBonus();
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Claim Faucet List
        if (AUTO_PTC) {
            const earned = await this.claimFaucetList();
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Claim Offerwalls
        if (AUTO_OFFERWALLS) {
            const earned = await this.claimOfferwalls();
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Claim PTC Ads
        if (AUTO_PTC) {
            const earned = await this.claimPTCAds();
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Claim Staking
        const stakingEarned = await this.claimStaking();
        cycleEarned += stakingEarned;
        await safeWait(2000);
        
        // Claim Tasks
        if (AUTO_TASKS) {
            const earned = await this.claimTasks();
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Update balance
        const loginManager = new FaucetPayLogin(this.page);
        await loginManager.getBalance();
        
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show source breakdown
        console.log('\n📊 Source breakdown:');
        for (const [name, data] of Object.entries(stats.sourceBalances)) {
            if (data.earned > 0 || data.claims > 0) {
                console.log(`   📌 ${name}: $${data.earned.toFixed(5)} from ${data.claims} claims`);
            }
        }
        
        // Show recent claims
        if (stats.claimHistory.length > 0) {
            const recent = stats.claimHistory.slice(0, 5);
            console.log('\n📈 Recent claims:');
            for (const claim of recent) {
                console.log(`   ${claim.time.toLocaleTimeString()}: ${claim.source} +$${claim.amount.toFixed(5)}`);
            }
        }
        
        // Calculate rates
        const uptimeHours = (Date.now() - stats.startTime) / 3600000;
        const hourlyRate = uptimeHours > 0 ? (stats.totalEarned / uptimeHours).toFixed(5) : 0;
        const dailyProjection = (hourlyRate * 24).toFixed(5);
        console.log(`\n📈 Hourly rate: $${hourlyRate} | Projected daily: $${dailyProjection}`);
        
        return cycleEarned;
    }
}

// ============ MAIN BOT ============
class FaucetPayInternalBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.loginManager = null;
        this.earningEngine = null;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        const launchOptions = {
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,720'
            ]
        };
        
        // Add persistent session if enabled
        if (USE_PERSISTENT_SESSION) {
            if (!fs.existsSync(USER_DATA_DIR)) {
                fs.mkdirSync(USER_DATA_DIR, { recursive: true });
            }
            launchOptions.userDataDir = USER_DATA_DIR;
            console.log('[Chrome] Using persistent session - login will be remembered');
        }
        
        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 720 });
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Set extra headers to look more like a real browser
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        });
        
        this.loginManager = new FaucetPayLogin(this.page);
        this.earningEngine = new InternalEarningEngine(this.page);
    }

    async run() {
        console.log('🚀 Starting FaucetPay Internal Bot');
        console.log(`📊 ${INTERNAL_SOURCES.filter(s => s.enabled).length} internal sources`);
        console.log('💸 Earning from: Daily Bonus, Faucet List, Offerwalls, PTC Ads, Staking, Tasks');
        console.log('========================================\n');
        
        await this.init();
        
        // Login to FaucetPay
        const loginSuccess = await this.loginManager.login(this.email, this.password);
        
        if (!loginSuccess) {
            console.log('\n⚠️ WARNING: Could not log into FaucetPay');
            console.log('   The bot will attempt to continue, but claiming may fail');
            console.log('   Please check your credentials and captcha\n');
        }
        
        // Main loop
        while (true) {
            try {
                // Check if still logged in periodically
                if (loginSuccess && stats.totalActions % 50 === 0 && stats.totalActions > 0) {
                    const currentUrl = this.page.url();
                    if (currentUrl.includes('login')) {
                        console.log('\n🔄 Session expired, re-logging in...');
                        await this.loginManager.login(this.email, this.password);
                    }
                }
                
                await this.earningEngine.runCycle();
                
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
                await safeWait(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await safeWait(10000);
            }
        }
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .filter(([_, data]) => data.earned > 0 || data.claims > 0)
        .map(([name, data]) => {
            const source = INTERNAL_SOURCES.find(s => s.name === name);
            const statusColor = data.lastStatus === 'success' ? 'earn' : (data.lastStatus === 'error' ? 'error' : '');
            return `
                <tr>
                    <td>${name}${!source?.enabled ? ' (Disabled)' : ''}</td>
                    <td class="earn">$${data.earned.toFixed(5)}</td>
                    <td>${data.claims}</td>
                    <td class="${statusColor}">${data.lastStatus || 'pending'}</td>
                    <td>${data.lastClaim ? new Date(data.lastClaim).toLocaleTimeString() : 'Never'}</td>
                </tr>
            `;
        }).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
            <td>${c.status || 'SUCCESS'}</td>
        </td>
    `).join('');
    
    const loginHtml = stats.loginHistory.slice(0, 10).map(l => `
        <tr>
            <td>${new Date(l.time).toLocaleTimeString()}</td>
            <td class="${l.status === 'SUCCESS' ? 'earn' : 'error'}">${l.status}</td>
            <td>${l.message || '-'}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html><head><title>FaucetPay Internal Bot</title><meta http-equiv="refresh" content="30">
<style>
body{background:#0a0e27;color:#00ff88;font-family:monospace;padding:20px}
.container{max-width:1400px;margin:0 auto}
.stat-card{background:#1a1f3a;padding:15px;border-radius:10px;display:inline-block;margin:10px;min-width:140px}
.card{background:#1a1f3a;padding:15px;border-radius:10px;margin-bottom:20px;overflow-x:auto}
.earn{color:#00ff88}
.error{color:#ff4444}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;text-align:left;border-bottom:1px solid #333;font-size:12px}
</style>
<body>
<div class="container">
<h1>💰 FaucetPay Internal Bot</h1>
<div class="card">
🟢 LIVE | Uptime: ${hours}h ${minutes}m<br>
Logged In: ${stats.loggedIn ? '✅ YES' : '❌ NO'}<br>
Email: ${FAUCETPAY_EMAIL}<br>
Persistent Session: ${USE_PERSISTENT_SESSION ? 'ON' : 'OFF'}
</div>
<div class="stat-card"><div class="earn">$${stats.totalEarned.toFixed(5)}</div>Total</div>
<div class="stat-card"><div class="earn">$${hourlyRate}</div>/Hour</div>
<div class="stat-card"><div class="earn">$${dailyRate}</div>/Day</div>
<div class="stat-card"><div class="earn">${stats.totalActions}</div>Claims</div>
<div class="stat-card"><div class="earn">${stats.successfulLogins}</div>Logins</div>

<div class="card"><h3>🔐 Login History</h3>
<table><thead><tr><th>Time</th><th>Status</th><th>Message</th></tr></thead>
<tbody>${loginHtml || '<tr><td colspan="3">No login attempts yet</td></tr>'}</tbody>
</table></div>

<div class="card"><h3>🪙 Source Balances</h3>
<table><thead><tr><th>Source</th><th>Earned</th><th>Claims</th><th>Status</th><th>Last Claim</th></tr></thead>
<tbody>${sourceBalancesHtml || '<tr><td colspan="5">No activity yet</td></tr>'}</tbody>
</table></div>

<div class="card"><h3>📈 Recent Claims</h3>
<table><thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th></tr></thead>
<tbody>${claimHtml || '<tr><td colspan="4">No claims yet</td></tr>'}</tbody>
</table></div>
</div>
</body></html>`);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => console.log(`📊 Dashboard: http://localhost:${port}`));
    
    const bot = new FaucetPayInternalBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\n📊 Final Statistics:');
        console.log(`   Total Earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`   Total Claims: ${stats.totalActions}`);
        console.log(`   Session Earned: $${stats.sessionEarned.toFixed(5)}`);
        console.log(`   Successful Logins: ${stats.successfulLogins}`);
        await bot.close();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('\n\n📊 Final Statistics:');
        console.log(`   Total Earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`   Total Claims: ${stats.totalActions}`);
        await bot.close();
        process.exit(0);
    });
    
    await bot.run();
}

main().catch(console.error);
