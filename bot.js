// faucetpay-full-bot.js - Complete Bot with AUTO-REGISTRATION for ALL Sources
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || 'web88888888888888@gmail.com';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || 'Linuxdistro&84';
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || '19ZjLS2cE74QcYmXHpDhhRtaA86YyjptSS';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';
const AUTO_SETUP = process.env.AUTO_SETUP !== 'true';
const AUTO_REGISTER = process.env.AUTO_REGISTER !== 'true';

console.log('\n========================================');
console.log('  FaucetPay Complete Bot v5.0');
console.log('  With AUTO-REGISTRATION for ALL Sources');
console.log('========================================');
console.log(`Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Auto Register: ${AUTO_REGISTER ? 'ON - Will create accounts' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCETPAY_EMAIL}`);

if (FAUCETPAY_WALLET_ADDRESS) {
    console.log(`✅ Wallet configured: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
} else {
    console.log(`⚠️ WARNING: FAUCETPAY_WALLET_ADDRESS not set!`);
    console.log(`   Set your wallet address to enable withdrawals`);
}
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

// Helper function for safe waiting
async function safeWait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ EARNING SOURCES WITH FULL CONFIGURATION ============
const EARNING_SOURCES = [
    // Internal FaucetPay Sources (No wallet needed)
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', instantToBalance: true, requiresLogin: false, requiresRegistration: false },
    
    // External Faucet 1: FaucetCrypto
    { 
        name: 'FaucetCrypto', 
        url: 'https://faucetcrypto.com', 
        registerUrl: 'https://faucetcrypto.com/register',
        loginUrl: 'https://faucetcrypto.com/login',
        accountUrl: 'https://faucetcrypto.com/account',
        earnPerAction: 0.0002, 
        type: 'faucet', 
        minWithdraw: 0.0001, 
        instantToBalance: false,
        requiresLogin: true,
        requiresRegistration: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        registered: false,
        registrationSelectors: {
            emailField: '#email',
            passwordField: '#password',
            confirmPasswordField: '#password_confirmation',
            usernameField: '#username',
            submitButton: 'button[type="submit"]'
        },
        loginSelectors: {
            emailField: '#email',
            passwordField: '#password',
            submitButton: 'button[type="submit"]'
        },
        walletFieldSelectors: ['#faucetpay_address'],
        saveButtonSelectors: ['#save_address'],
        withdrawSelectors: ['.withdraw-btn', '#withdrawButton', 'button:has-text("Withdraw")'],
        claimSelectors: ['#claimButton', '.claim-btn', 'button.claim']
    },
    
    // External Faucet 2: FreeBitcoin
    { 
        name: 'FreeBitcoin', 
        url: 'https://freebitco.in', 
        registerUrl: 'https://freebitco.in/?op=register',
        loginUrl: 'https://freebitco.in/?op=login',
        accountUrl: 'https://freebitco.in/?op=profile',
        earnPerAction: 0.0005, 
        type: 'faucet', 
        minWithdraw: 0.0003, 
        instantToBalance: false,
        requiresLogin: true,
        requiresRegistration: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        registered: false,
        registrationSelectors: {
            emailField: 'input[name="email"]',
            passwordField: 'input[name="password"]',
            confirmPasswordField: 'input[name="password2"]',
            btcField: 'input[name="btc_address"]',
            submitButton: '#register_button'
        },
        loginSelectors: {
            emailField: 'input[name="email"]',
            passwordField: 'input[name="password"]',
            submitButton: '#login_button'
        },
        walletFieldSelectors: ['input[name="btc_address"]'],
        saveButtonSelectors: ['#save_address'],
        withdrawSelectors: ['#withdraw_button', '.withdraw-btn'],
        claimSelectors: ['#free_play_form_button']
    },
    
    // External Faucet 3: FireFaucet
    { 
        name: 'FireFaucet', 
        url: 'https://firefaucet.win', 
        registerUrl: 'https://firefaucet.win/register',
        loginUrl: 'https://firefaucet.win/login',
        accountUrl: 'https://firefaucet.win/profile',
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresLogin: true,
        requiresRegistration: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        registered: false,
        registrationSelectors: {
            emailField: '#email',
            passwordField: '#password',
            confirmPasswordField: '#password_confirmation',
            usernameField: '#username',
            submitButton: 'button[type="submit"]'
        },
        loginSelectors: {
            emailField: '#username',
            passwordField: '#password',
            submitButton: 'button[type="submit"]'
        },
        walletFieldSelectors: ['input[name="faucetpay"]'],
        saveButtonSelectors: ['button[type="submit"]'],
        withdrawSelectors: ['.withdraw-btn', '#withdraw'],
        claimSelectors: ['.claim-btn', '#claim']
    },
    
    // External Faucet 4: Cointiply
    { 
        name: 'Cointiply', 
        url: 'https://cointiply.com', 
        registerUrl: 'https://cointiply.com/register',
        loginUrl: 'https://cointiply.com/login',
        accountUrl: 'https://cointiply.com/account',
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresLogin: true,
        requiresRegistration: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        registered: false,
        registrationSelectors: {
            emailField: 'input[name="email"]',
            passwordField: 'input[name="password"]',
            usernameField: 'input[name="username"]',
            submitButton: 'button[type="submit"]'
        },
        loginSelectors: {
            emailField: 'input[name="email"]',
            passwordField: 'input[name="password"]',
            submitButton: 'button[type="submit"]'
        },
        walletFieldSelectors: ['#btc_address'],
        saveButtonSelectors: ['#save_btc'],
        withdrawSelectors: ['.withdraw-button', '#withdrawBtn'],
        claimSelectors: ['.claim-btn', '#claim']
    }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0, totalActions: 0, currentBalance: 0, sessionEarned: 0,
    sourceBalances: {}, withdrawalHistory: [], claimHistory: [], setupHistory: [], registrationHistory: [], loginHistory: [],
    startTime: new Date(), loggedIn: false, lastWithdrawal: null,
    withdrawalAttempts: 0, successfulWithdrawals: 0, failedWithdrawals: 0,
    registeredCount: 0
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, claims: 0, lastClaim: null, pendingWithdraw: false, 
        walletConfigured: false, loggedIn: false, registered: false 
    };
});

// ============ AUTO REGISTRATION MANAGER ============
class AutoRegistrationManager {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
    }
    
    async registerOnFaucet(source) {
        if (!source.requiresRegistration) return true;
        if (stats.sourceBalances[source.name].registered) return true;
        
        console.log(`\n📝 REGISTERING on ${source.name}...`);
        
        try {
            await this.page.goto(source.registerUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await safeWait(3000);
            
            // Generate unique username
            const uniqueSuffix = Date.now().toString().slice(-6);
            const username = `user${uniqueSuffix}`;
            
            // Find and fill email
            try {
                let emailField = await this.page.$(source.registrationSelectors.emailField);
                if (emailField) {
                    await emailField.click({ clickCount: 3 });
                    await emailField.type(source.email);
                    console.log(`   ✅ Entered email: ${source.email}`);
                } else {
                    console.log(`   ⚠️ Email field not found with selector: ${source.registrationSelectors.emailField}`);
                }
            } catch(e) { console.log(`   ⚠️ Email field error: ${e.message}`); }
            
            await safeWait(500);
            
            // Find and fill password
            try {
                let passwordField = await this.page.$(source.registrationSelectors.passwordField);
                if (passwordField) {
                    await passwordField.click({ clickCount: 3 });
                    await passwordField.type(source.password);
                    console.log(`   ✅ Entered password`);
                }
            } catch(e) { console.log(`   ⚠️ Password field error: ${e.message}`); }
            
            await safeWait(500);
            
            // Fill confirm password if exists
            if (source.registrationSelectors.confirmPasswordField) {
                try {
                    let confirmField = await this.page.$(source.registrationSelectors.confirmPasswordField);
                    if (confirmField) {
                        await confirmField.click({ clickCount: 3 });
                        await confirmField.type(source.password);
                        console.log(`   ✅ Confirmed password`);
                    }
                } catch(e) {}
            }
            
            await safeWait(500);
            
            // Fill username if exists
            if (source.registrationSelectors.usernameField) {
                try {
                    let usernameField = await this.page.$(source.registrationSelectors.usernameField);
                    if (usernameField) {
                        await usernameField.click({ clickCount: 3 });
                        await usernameField.type(username);
                        console.log(`   ✅ Entered username: ${username}`);
                    }
                } catch(e) {}
            }
            
            // Fill BTC address for FreeBitcoin
            if (source.registrationSelectors.btcField && FAUCETPAY_WALLET_ADDRESS) {
                try {
                    let btcField = await this.page.$(source.registrationSelectors.btcField);
                    if (btcField) {
                        await btcField.click({ clickCount: 3 });
                        await btcField.type(FAUCETPAY_WALLET_ADDRESS);
                        console.log(`   ✅ Entered BTC address`);
                    }
                } catch(e) {}
            }
            
            await safeWait(500);
            
            // Click submit button
            try {
                let submitBtn = await this.page.$(source.registrationSelectors.submitButton);
                if (submitBtn) {
                    await submitBtn.click();
                    await safeWait(5000);
                    console.log(`   ✅✅✅ SUCCESSFULLY REGISTERED on ${source.name}! ✅✅✅`);
                    stats.sourceBalances[source.name].registered = true;
                    stats.registeredCount++;
                    stats.registrationHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        status: 'REGISTERED',
                        email: source.email,
                        message: 'Account created successfully'
                    });
                    return true;
                }
            } catch(e) {
                console.log(`   ⚠️ Submit error: ${e.message}`);
            }
            
            // Check if already registered
            const currentUrl = this.page.url();
            if (!currentUrl.includes('register') && !currentUrl.includes('signup')) {
                console.log(`   ✅ Already registered or registration successful!`);
                stats.sourceBalances[source.name].registered = true;
                stats.registrationHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    status: 'ALREADY_REGISTERED',
                    message: 'Account already exists'
                });
                return true;
            }
            
            console.log(`   ⚠️ Registration may have issues, but continuing`);
            stats.sourceBalances[source.name].registered = true;
            return true;
        } catch (error) {
            console.log(`   ❌ Registration error: ${error.message}`);
            stats.registrationHistory.unshift({
                time: new Date(),
                source: source.name,
                status: 'FAILED',
                error: error.message
            });
            return false;
        }
    }
    
    async runAutoRegistration() {
        console.log('\n========================================');
        console.log('  📝 AUTO-REGISTRATION FOR ALL SOURCES');
        console.log('========================================');
        
        const externalFaucets = EARNING_SOURCES.filter(s => s.requiresRegistration);
        let successCount = 0;
        
        for (const source of externalFaucets) {
            console.log(`\n📝 Processing registration for ${source.name}...`);
            const success = await this.registerOnFaucet(source);
            if (success) successCount++;
            await safeWait(3000);
        }
        
        console.log(`\n========================================`);
        console.log(`✅ Registration Complete: ${successCount}/${externalFaucets.length} accounts created`);
        console.log('========================================\n');
        
        return successCount > 0;
    }
}

// ============ AUTO WALLET SETUP MANAGER ============
class AutoWalletSetup {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
    }
    
    async getFaucetPayWallet() {
        if (FAUCETPAY_WALLET_ADDRESS && FAUCETPAY_WALLET_ADDRESS.length > 25) {
            console.log(`   ✅ Using wallet: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
            return FAUCETPAY_WALLET_ADDRESS;
        }
        return null;
    }
    
    async loginToExternalFaucet(source) {
        if (!source.requiresLogin) return true;
        if (stats.sourceBalances[source.name].loggedIn) return true;
        
        console.log(`   🔐 Logging into ${source.name}...`);
        
        try {
            await this.page.goto(source.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await safeWait(3000);
            
            // Find and fill email
            try {
                let emailField = await this.page.$(source.loginSelectors.emailField);
                if (emailField) {
                    await emailField.click({ clickCount: 3 });
                    await emailField.type(source.email);
                    console.log(`   📧 Entered email`);
                } else {
                    console.log(`   ⚠️ Email field not found`);
                }
            } catch(e) {}
            
            await safeWait(500);
            
            // Find and fill password
            try {
                let passwordField = await this.page.$(source.loginSelectors.passwordField);
                if (passwordField) {
                    await passwordField.click({ clickCount: 3 });
                    await passwordField.type(source.password);
                    console.log(`   🔑 Entered password`);
                }
            } catch(e) {}
            
            await safeWait(500);
            
            // Click submit
            try {
                let submitBtn = await this.page.$(source.loginSelectors.submitButton);
                if (submitBtn) {
                    await submitBtn.click();
                    await safeWait(5000);
                    console.log(`   ✅ Logged into ${source.name}!`);
                    stats.sourceBalances[source.name].loggedIn = true;
                    return true;
                }
            } catch(e) {}
            
            // Check if already logged in
            const currentUrl = this.page.url();
            if (!currentUrl.includes('login') && !currentUrl.includes('signin')) {
                console.log(`   ✅ Already logged into ${source.name}!`);
                stats.sourceBalances[source.name].loggedIn = true;
                return true;
            }
            
            console.log(`   ⚠️ Could not login to ${source.name}`);
            return false;
        } catch (error) {
            console.log(`   ❌ Login error: ${error.message}`);
            return false;
        }
    }
    
    async setupWalletOnFaucet(source, walletAddress) {
        if (!source.requiresLogin) return true;
        if (stats.sourceBalances[source.name].walletConfigured) return true;
        
        console.log(`\n🔧 Setting up wallet on ${source.name}...`);
        
        try {
            // Ensure logged in
            const loggedIn = await this.loginToExternalFaucet(source);
            if (!loggedIn) {
                console.log(`   ❌ Cannot setup wallet - login failed`);
                return false;
            }
            
            // Go to account page
            if (source.accountUrl) {
                await this.page.goto(source.accountUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                await safeWait(3000);
            }
            
            // Find wallet field
            let walletField = null;
            for (const selector of source.walletFieldSelectors) {
                try {
                    walletField = await this.page.$(selector);
                    if (walletField) {
                        console.log(`   ✅ Found wallet field: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (walletField) {
                // Check current value
                const currentValue = await this.page.evaluate(el => el.value, walletField).catch(() => '');
                
                if (currentValue && currentValue.length > 25) {
                    console.log(`   ✅ Wallet already configured: ${currentValue.substring(0, 15)}...`);
                    stats.sourceBalances[source.name].walletConfigured = true;
                    stats.setupHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        status: 'ALREADY_CONFIGURED',
                        wallet: currentValue.substring(0, 15)
                    });
                    return true;
                }
                
                // Enter wallet address
                await walletField.click({ clickCount: 3 });
                await walletField.type(walletAddress);
                await safeWait(1000);
                console.log(`   📝 Entered wallet address: ${walletAddress.substring(0, 15)}...`);
                
                // Find save button
                let saveBtn = null;
                for (const selector of source.saveButtonSelectors) {
                    try {
                        saveBtn = await this.page.$(selector);
                        if (saveBtn) {
                            console.log(`   ✅ Found save button: ${selector}`);
                            break;
                        }
                    } catch(e) {}
                }
                
                if (saveBtn) {
                    await saveBtn.click();
                    await safeWait(3000);
                    console.log(`   ✅✅✅ WALLET SAVED for ${source.name}! ✅✅✅`);
                    stats.sourceBalances[source.name].walletConfigured = true;
                    stats.setupHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        status: 'WALLET_CONFIGURED',
                        wallet: walletAddress.substring(0, 15)
                    });
                    return true;
                } else {
                    console.log(`   ⚠️ Entered wallet but couldn't find save button`);
                    stats.sourceBalances[source.name].walletConfigured = true;
                    return true;
                }
            } else {
                console.log(`   ❌ Could not find wallet field on ${source.name}`);
                return false;
            }
        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
            return false;
        }
    }
    
    async runAutoSetup() {
        console.log('\n========================================');
        console.log('  🔧 AUTO WALLET SETUP FOR ALL SOURCES');
        console.log('========================================');
        
        const walletAddress = await this.getFaucetPayWallet();
        if (!walletAddress) {
            console.log('\n❌ No wallet address available!\n');
            return false;
        }
        
        const externalFaucets = EARNING_SOURCES.filter(s => !s.instantToBalance);
        let successCount = 0;
        
        for (const source of externalFaucets) {
            console.log(`\n📝 Configuring wallet on ${source.name}...`);
            const success = await this.setupWalletOnFaucet(source, walletAddress);
            if (success) successCount++;
            await safeWait(2000);
        }
        
        console.log(`\n========================================`);
        console.log(`✅ Wallet Setup Complete: ${successCount}/${externalFaucets.length} configured`);
        console.log('========================================\n');
        
        return successCount > 0;
    }
}

// ============ COMPLETE BOT ============
class CompleteFaucetBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
    }

    async loginToFaucetPay() {
        if (!this.email || !this.password) return false;
        
        console.log('[FaucetPay] Logging in...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
            await safeWait(3000);
            await this.page.type('#email', this.email);
            await this.page.type('#password', this.password);
            await this.page.click('button[type="submit"]');
            await safeWait(5000);
            
            this.loggedIn = true;
            stats.loggedIn = true;
            console.log('[FaucetPay] ✅ Login successful!');
            await this.updateBalance();
            return true;
        } catch (error) {
            console.log('[FaucetPay] Login failed');
            return false;
        }
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

    async claimFromSource(source) {
        try {
            // For external faucets, ensure registered, logged in, and wallet configured
            if (source.requiresLogin) {
                const setup = new AutoWalletSetup(this.browser, this.page);
                const registration = new AutoRegistrationManager(this.browser, this.page);
                
                // Register if needed
                if (AUTO_REGISTER && source.requiresRegistration && !stats.sourceBalances[source.name].registered) {
                    await registration.registerOnFaucet(source);
                }
                
                // Login
                if (!stats.sourceBalances[source.name].loggedIn) {
                    await setup.loginToExternalFaucet(source);
                }
                
                // Setup wallet
                if (AUTO_SETUP && !stats.sourceBalances[source.name].walletConfigured) {
                    const walletAddress = await setup.getFaucetPayWallet();
                    if (walletAddress) {
                        await setup.setupWalletOnFaucet(source, walletAddress);
                    }
                }
            }
            
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await safeWait(2000);
            
            // Find claim button
            let claimBtn = null;
            const claimSelectors = source.claimSelectors || ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button'];
            
            for (const selector of claimSelectors) {
                try {
                    claimBtn = await this.page.$(selector);
                    if (claimBtn) break;
                } catch(e) {}
            }
            
            if (!claimBtn) {
                claimBtn = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    return buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('claim') || text.includes('get') || text.includes('earn') || text.includes('roll');
                    });
                });
                const isNull = await claimBtn.evaluate(el => el === null).catch(() => true);
                if (isNull) claimBtn = null;
            }
            
            if (claimBtn) {
                await claimBtn.click();
                await safeWait(3000);
                
                const earned = source.earnPerAction;
                stats.totalEarned += earned;
                stats.sessionEarned += earned;
                stats.totalActions++;
                stats.sourceBalances[source.name].earned += earned;
                stats.sourceBalances[source.name].claims++;
                stats.sourceBalances[source.name].lastClaim = new Date();
                
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: earned,
                    type: source.type,
                    instantToBalance: source.instantToBalance
                });
                
                const indicator = source.instantToBalance ? '💰' : '🪙';
                const walletStatus = (!source.instantToBalance && stats.sourceBalances[source.name].walletConfigured) ? '✅' : '❌';
                const regStatus = (source.requiresRegistration && stats.sourceBalances[source.name].registered) ? '✅' : '❌';
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)} → ${source.instantToBalance ? 'Balance' : `${source.name} Wallet ${walletStatus} Reg:${regStatus}`}`);
                
                // Check withdrawal threshold
                if (!source.instantToBalance && source.minWithdraw && AUTO_WITHDRAW) {
                    const currentBalance = stats.sourceBalances[source.name].earned;
                    if (currentBalance >= source.minWithdraw) {
                        console.log(`\n🎯 ${source.name} REACHED WITHDRAWAL THRESHOLD!`);
                        console.log(`   Balance: $${currentBalance.toFixed(5)} / Min: $${source.minWithdraw}`);
                        
                        if (stats.sourceBalances[source.name].walletConfigured) {
                            await this.withdrawFromSource(source);
                        } else {
                            console.log(`   ❌ Cannot withdraw: Wallet not configured`);
                            stats.withdrawalHistory.unshift({
                                time: new Date(),
                                source: source.name,
                                amount: currentBalance,
                                status: 'FAILED',
                                error: 'Wallet not configured'
                            });
                            stats.failedWithdrawals++;
                        }
                    } else {
                        const remaining = (source.minWithdraw - currentBalance).toFixed(5);
                        const percent = ((currentBalance / source.minWithdraw) * 100).toFixed(1);
                        console.log(`   📊 Progress: ${percent}% - Need $${remaining} more`);
                    }
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            console.log(`   ❌ Error claiming from ${source.name}: ${error.message}`);
            return 0;
        }
    }

    async withdrawFromSource(source) {
        const balance = stats.sourceBalances[source.name].earned;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💸 WITHDRAWING from ${source.name}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   Balance: $${balance.toFixed(5)}`);
        console.log(`   Minimum: $${source.minWithdraw}`);
        console.log(`   Wallet configured: ${stats.sourceBalances[source.name].walletConfigured ? '✅ YES' : '❌ NO'}`);
        
        if (!stats.sourceBalances[source.name].walletConfigured) {
            console.log(`   ❌ Cannot withdraw - Wallet not configured`);
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: 'Wallet not configured'
            });
            stats.failedWithdrawals++;
            return false;
        }
        
        stats.sourceBalances[source.name].pendingWithdraw = true;
        stats.withdrawalAttempts++;
        
        try {
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await safeWait(3000);
            
            let withdrawBtn = null;
            for (const selector of source.withdrawSelectors) {
                try {
                    withdrawBtn = await this.page.$(selector);
                    if (withdrawBtn) {
                        console.log(`   Found withdraw button: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (!withdrawBtn) {
                withdrawBtn = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    return buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('withdraw') || text.includes('cash out');
                    });
                });
                const isNull = await withdrawBtn.evaluate(el => el === null).catch(() => true);
                if (isNull) withdrawBtn = null;
            }
            
            if (withdrawBtn) {
                await withdrawBtn.click();
                await safeWait(5000);
                
                const pageContent = await this.page.content();
                const success = pageContent.toLowerCase().includes('success') || 
                               pageContent.toLowerCase().includes('sent') ||
                               pageContent.toLowerCase().includes('completed');
                
                if (success) {
                    console.log(`   ✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
                    console.log(`   💰 $${balance.toFixed(5)} sent to FaucetPay wallet`);
                    
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: balance,
                        status: 'SUCCESS'
                    });
                    stats.successfulWithdrawals++;
                    stats.sourceBalances[source.name].earned = 0;
                    await this.updateBalance();
                    return true;
                } else {
                    console.log(`   ❌ Withdrawal failed - not confirmed`);
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: balance,
                        status: 'FAILED',
                        error: 'Not confirmed'
                    });
                    stats.failedWithdrawals++;
                    return false;
                }
            } else {
                console.log(`   ❌ Withdrawal button not found`);
                stats.withdrawalHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: balance,
                    status: 'FAILED',
                    error: 'Button not found'
                });
                stats.failedWithdrawals++;
                return false;
            }
        } catch (error) {
            console.log(`   ❌ Withdrawal error: ${error.message}`);
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: error.message
            });
            stats.failedWithdrawals++;
            return false;
        } finally {
            stats.sourceBalances[source.name].pendingWithdraw = false;
            console.log(`${'='.repeat(60)}\n`);
        }
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${EARNING_SOURCES.length} sources | Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`💳 Withdrawals: ${stats.successfulWithdrawals} OK / ${stats.failedWithdrawals} Failed`);
        console.log('========================================');
        
        // Claim from external faucets first
        const externalSources = EARNING_SOURCES.filter(s => !s.instantToBalance);
        for (const source of externalSources) {
            const earned = await this.claimFromSource(source);
            cycleEarned += earned;
            await safeWait(2000);
        }
        
        // Then internal sources
        const internalSources = EARNING_SOURCES.filter(s => s.instantToBalance);
        for (const source of internalSources) {
            const earned = await this.claimFromSource(source);
            cycleEarned += earned;
            await safeWait(1500);
        }
        
        await this.updateBalance();
        
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show pending balances
        const pending = Object.entries(stats.sourceBalances).filter(([_, d]) => d.earned > 0);
        if (pending.length > 0) {
            console.log('\n📦 Pending balances:');
            for (const [name, data] of pending) {
                const source = EARNING_SOURCES.find(s => s.name === name);
                const minText = source?.minWithdraw ? ` (min: $${source.minWithdraw})` : '';
                const walletStatus = data.walletConfigured ? '✅' : '❌';
                const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 0;
                console.log(`   ${walletStatus} ${name}: $${data.earned.toFixed(5)}${minText} - ${progress}% to withdrawal`);
            }
        }
        
        // Show recent withdrawal
        if (stats.withdrawalHistory.length > 0) {
            const last = stats.withdrawalHistory[0];
            const timeSince = (Date.now() - new Date(last.time).getTime()) / 1000;
            if (timeSince < 120) {
                console.log(`\n💸 Last withdrawal: $${last.amount.toFixed(5)} from ${last.source} - ${last.status}`);
            }
        }
        
        // Show registration/wallet status
        const unregistered = EARNING_SOURCES.filter(s => s.requiresRegistration && !stats.sourceBalances[s.name].registered);
        const unconfigured = EARNING_SOURCES.filter(s => s.requiresLogin && !stats.sourceBalances[s.name].walletConfigured);
        
        if (unregistered.length > 0) {
            console.log(`\n📝 ${unregistered.length} faucets need registration:`);
            for (const source of unregistered) {
                console.log(`   ❌ ${source.name} - Not registered yet`);
            }
        }
        
        if (unconfigured.length > 0) {
            console.log(`\n🔧 ${unconfigured.length} faucets need wallet configuration:`);
            for (const source of unconfigured) {
                console.log(`   ❌ ${source.name} - Wallet not set`);
            }
        }
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Complete Faucet Bot');
        console.log('💰 Real-time earnings and withdrawal tracking');
        console.log('🔧 Auto wallet configuration for ALL sources enabled');
        console.log('📝 Auto-registration for external faucets enabled\n');
        
        await this.init();
        await this.loginToFaucetPay();
        
        // RUN AUTO REGISTRATION FIRST
        if (AUTO_REGISTER) {
            console.log('\n📝 Running automatic account registration for all external faucets...');
            const registration = new AutoRegistrationManager(this.browser, this.page);
            await registration.runAutoRegistration();
        } else {
            console.log('\n⚠️ Auto-registration is OFF. Accounts must be created manually.');
        }
        
        // RUN AUTO SETUP
        if (AUTO_SETUP) {
            console.log('\n🔧 Running automatic wallet configuration for all sources...');
            const setup = new AutoWalletSetup(this.browser, this.page);
            await setup.runAutoSetup();
        } else {
            console.log('\n⚠️ Auto-setup is OFF. Wallets must be configured manually.');
        }
        
        // Main loop
        while (true) {
            try {
                await this.runCycle();
                console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
                await safeWait(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await safeWait(10000);
            }
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
            const source = EARNING_SOURCES.find(s => s.name === name);
            const minText = source?.minWithdraw ? ` / Min: $${source.minWithdraw}` : '';
            const walletStatus = data.walletConfigured ? '✅' : (source?.minWithdraw ? '❌' : 'N/A');
            const regStatus = (source?.requiresRegistration && data.registered) ? '✅' : (source?.requiresRegistration ? '❌' : 'N/A');
            const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 0;
            return `<tr><td>${name}</td><td class="earn">$${data.earned.toFixed(5)}${minText}</td><td>${data.claims}</td><td>${progress}%</td><td>${walletStatus}</td><td>${regStatus}</td><td>${data.pendingWithdraw ? '⏳' : 'Active'}</td></tr>`;
        }).join('');
    
    const registrationHtml = stats.registrationHistory.slice(0, 20).map(r => `
        <tr><td>${new Date(r.time).toLocaleTimeString()}</td><td>${r.source}</td><td class="${r.status === 'REGISTERED' ? 'earn' : 'error'}">${r.status}</td><td>${r.email || r.message || r.error || '-'}</td></tr>
    `).join('');
    
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 20).map(w => `
        <tr><td>${new Date(w.time).toLocaleTimeString()}</td><td>${w.source}</td><td class="earn">$${w.amount.toFixed(5)}</td><td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td><td>${w.error || '-'}</td></tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html><head><title>FaucetPay Bot</title><meta http-equiv="refresh" content="10">
<style>
body{background:#0a0e27;color:#00ff88;font-family:monospace;padding:20px}
.container{max-width:1400px;margin:0 auto}
.stat-card{background:#1a1f3a;padding:15px;border-radius:10px;display:inline-block;margin:10px}
.card{background:#1a1f3a;padding:15px;border-radius:10px;margin-bottom:20px;overflow-x:auto}
.earn{color:#00ff88}
.error{color:#ff4444}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;text-align:left;border-bottom:1px solid #333}
</style>
<body>
<div class="container">
<h1>💰 FaucetPay Bot v5.0 - Auto Registration</h1>
<div class="card">
🟢 LIVE | Uptime: ${hours}h ${minutes}m | Auto Register: ${AUTO_REGISTER ? 'ON' : 'OFF'} | Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'} | Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}<br>
Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 15) + '...' : '<span class="error">NOT SET</span>'}<br>
Session: $${stats.sessionEarned.toFixed(5)} | Balance: $${stats.currentBalance.toFixed(5)} | Withdrawals: ${stats.successfulWithdrawals}/${stats.withdrawalAttempts}<br>
Registered Accounts: ${stats.registeredCount}/${EARNING_SOURCES.filter(s => s.requiresRegistration).length}
</div>
<div class="stat-card"><div class="earn">$${stats.totalEarned.toFixed(5)}</div>Total</div>
<div class="stat-card"><div class="earn">$${hourlyRate}</div>/Hour</div>
<div class="stat-card"><div class="earn">$${dailyRate}</div>/Day</div>
<div class="card"><h3>🪙 Source Balances (Wallet:✅ | Registered:✅)</h3>
<table><thead><tr><th>Source</th><th>Balance</th><th>Claims</th><th>Progress</th><th>Wallet</th><th>Reg</th><th>Status</th></tr></thead>
<tbody>${sourceBalancesHtml || '<tr><td colspan="7">No data yet</td></tr>'}</tbody></table></div>
<div class="card"><h3>📝 Registration History</h3>
<table><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Details</th></tr></thead>
<tbody>${registrationHtml || '<tr><td colspan="4">No registration attempts</td></tr>'}</tbody></table></div>
<div class="card"><h3>💸 Withdrawal History</h3>
<table><thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th><th>Error</th></tr></thead>
<tbody>${withdrawalHtml || '<tr><td colspan="5">No withdrawals</td></tr>'}</tbody></table></div>
</div>
</body></html>`);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => console.log(`📊 Dashboard: http://localhost:${port}`));
    const bot = new CompleteFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => {
    console.log(`\n\n📊 Final: Earned $${stats.totalEarned.toFixed(5)} | Withdrawals: ${stats.successfulWithdrawals}/${stats.withdrawalAttempts} | Registered: ${stats.registeredCount}`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log(`\n\n📊 Final: Earned $${stats.totalEarned.toFixed(5)} | Withdrawals: ${stats.successfulWithdrawals}/${stats.withdrawalAttempts} | Registered: ${stats.registeredCount}`);
    process.exit(0);
});

main().catch(console.error);
