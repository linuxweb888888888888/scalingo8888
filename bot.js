// faucetpay-full-bot.js - Complete Bot with Auto Login & Wallet Setup for ALL Sources
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
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || 'ltc1q0k6uqmjgp32uplwyfx9kqmd4j26js9w3x6as9d';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';
const AUTO_SETUP = process.env.AUTO_SETUP !== 'true';

console.log('\n========================================');
console.log('  FaucetPay Complete Bot v4.0');
console.log('  With Auto Login & Wallet Setup for ALL Sources');
console.log('========================================');
console.log(`Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCETPAY_EMAIL}`);

if (FAUCETPAY_WALLET_ADDRESS) {
    console.log(`✅ Wallet configured: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
} else {
    console.log(`⚠️ WARNING: FAUCETPAY_WALLET_ADDRESS not set!`);
    console.log(`   Withdrawals will fail. Set your BTC/LTC wallet address:`);
    console.log(`   export FAUCETPAY_WALLET_ADDRESS="your_wallet_address_here"`);
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

// ============ EARNING SOURCES WITH FULL CONFIGURATION ============
const EARNING_SOURCES = [
    // Internal FaucetPay Sources (No wallet needed)
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', instantToBalance: true, requiresLogin: false },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', instantToBalance: true, requiresLogin: false },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', instantToBalance: true, requiresLogin: false },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', instantToBalance: true, requiresLogin: false },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', instantToBalance: true, requiresLogin: false },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', instantToBalance: true, requiresLogin: false },
    
    // External Faucet 1: FaucetCrypto
    { 
        name: 'FaucetCrypto', 
        url: 'https://faucetcrypto.com', 
        loginUrl: 'https://faucetcrypto.com/login',
        accountUrl: 'https://faucetcrypto.com/account',
        earnPerAction: 0.0002, 
        type: 'faucet', 
        minWithdraw: 0.0001, 
        instantToBalance: false,
        requiresLogin: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        walletFieldSelectors: ['#faucetpay_address', '#wallet_address', 'input[name="faucetpay"]', 'input[name="wallet"]'],
        saveButtonSelectors: ['#save_address', '#save', 'button[type="submit"]', 'button:has-text("Save")'],
        withdrawSelectors: ['.withdraw-btn', '#withdrawButton', 'button:has-text("Withdraw")', '.btn-withdraw'],
        claimSelectors: ['#claimButton', '.claim-btn', 'button.claim']
    },
    
    // External Faucet 2: FreeBitcoin
    { 
        name: 'FreeBitcoin', 
        url: 'https://freebitco.in', 
        loginUrl: 'https://freebitco.in/?op=login',
        accountUrl: 'https://freebitco.in/?op=profile',
        earnPerAction: 0.0005, 
        type: 'faucet', 
        minWithdraw: 0.0003, 
        instantToBalance: false,
        requiresLogin: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        walletFieldSelectors: ['#btc_address', 'input[name="btc_address"]', 'input[name="address"]'],
        saveButtonSelectors: ['#save_address', '#save', 'button[type="submit"]'],
        withdrawSelectors: ['#withdraw_button', '.withdraw-btn', 'a:has-text("Withdraw")'],
        claimSelectors: ['#free_play_form_button', '#claim', '.roll-button']
    },
    
    // External Faucet 3: FireFaucet
    { 
        name: 'FireFaucet', 
        url: 'https://firefaucet.win', 
        loginUrl: 'https://firefaucet.win/login',
        accountUrl: 'https://firefaucet.win/profile',
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresLogin: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        walletFieldSelectors: ['input[name="faucetpay"]', 'input[name="wallet"]', '#faucetpay_address'],
        saveButtonSelectors: ['button[type="submit"]', '#save', '.btn-save'],
        withdrawSelectors: ['.withdraw-btn', '#withdraw', 'button:has-text("Withdraw")'],
        claimSelectors: ['.claim-btn', '#claim', 'button.claim']
    },
    
    // External Faucet 4: Cointiply
    { 
        name: 'Cointiply', 
        url: 'https://cointiply.com', 
        loginUrl: 'https://cointiply.com/login',
        accountUrl: 'https://cointiply.com/account',
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresLogin: true,
        email: FAUCETPAY_EMAIL,
        password: FAUCETPAY_PASSWORD,
        walletFieldSelectors: ['#btc_address', 'input[name="btc_address"]', '#withdraw_address'],
        saveButtonSelectors: ['#save_btc', '#save', 'button[type="submit"]'],
        withdrawSelectors: ['.withdraw-button', '#withdrawBtn', 'button:has-text("Withdraw")'],
        claimSelectors: ['.claim-btn', '#claim', 'button.claim']
    }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0, totalActions: 0, currentBalance: 0, sessionEarned: 0,
    sourceBalances: {}, withdrawalHistory: [], claimHistory: [], setupHistory: [], loginHistory: [],
    startTime: new Date(), loggedIn: false, lastWithdrawal: null,
    withdrawalAttempts: 0, successfulWithdrawals: 0, failedWithdrawals: 0
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, claims: 0, lastClaim: null, pendingWithdraw: false, 
        walletConfigured: false, loggedIn: false 
    };
});

// ============ AUTO WALLET SETUP MANAGER ============
class AutoWalletSetup {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
    }
    
    async getFaucetPayWallet() {
        console.log('\n🔍 Getting FaucetPay wallet address...');
        
        if (FAUCETPAY_WALLET_ADDRESS && FAUCETPAY_WALLET_ADDRESS.length > 25) {
            console.log(`✅ Using wallet from environment: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
            return FAUCETPAY_WALLET_ADDRESS;
        }
        
        try {
            const walletPage = await this.browser.newPage();
            await walletPage.goto('https://faucetpay.io/account', { waitUntil: 'networkidle2' });
            await walletPage.waitForTimeout(3000);
            
            let walletAddress = null;
            const selectors = ['.wallet-address', '#wallet_address', '.btc-address', 'input[name="wallet_address"]'];
            
            for (const selector of selectors) {
                try {
                    const element = await walletPage.$(selector);
                    if (element) {
                        walletAddress = await walletPage.$eval(selector, el => el.value || el.innerText).catch(() => null);
                        if (walletAddress && walletAddress.length > 25) break;
                    }
                } catch(e) {}
            }
            
            await walletPage.close();
            
            if (walletAddress) {
                console.log(`✅ Found wallet: ${walletAddress.substring(0, 15)}...`);
                return walletAddress;
            }
            return null;
        } catch (error) {
            console.log(`❌ Error: ${error.message}`);
            return null;
        }
    }
    
    async loginToExternalFaucet(source) {
        if (!source.requiresLogin) return true;
        if (stats.sourceBalances[source.name].loggedIn) return true;
        
        console.log(`\n🔐 Logging into ${source.name}...`);
        
        try {
            await this.page.goto(source.loginUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Auto-find and fill email
            let emailField = null;
            const emailSelectors = ['#email', 'input[name="email"]', 'input[type="email"]', '#username', 'input[name="username"]'];
            for (const selector of emailSelectors) {
                try {
                    emailField = await this.page.$(selector);
                    if (emailField) {
                        console.log(`   ✅ Found email field: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(source.email);
                console.log(`   📧 Entered email: ${source.email.substring(0, 10)}...`);
                
                // Auto-find and fill password
                let passwordField = null;
                const passwordSelectors = ['#password', 'input[name="password"]', 'input[type="password"]'];
                for (const selector of passwordSelectors) {
                    try {
                        passwordField = await this.page.$(selector);
                        if (passwordField) {
                            console.log(`   ✅ Found password field: ${selector}`);
                            break;
                        }
                    } catch(e) {}
                }
                
                if (passwordField) {
                    await passwordField.click({ clickCount: 3 });
                    await passwordField.type(source.password);
                    console.log(`   🔑 Entered password`);
                    
                    // Find and click submit button
                    let submitBtn = null;
                    const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', '#login-btn', '.login-btn', '#login'];
                    for (const selector of submitSelectors) {
                        try {
                            submitBtn = await this.page.$(selector);
                            if (submitBtn) {
                                console.log(`   ✅ Found submit button: ${selector}`);
                                break;
                            }
                        } catch(e) {}
                    }
                    
                    if (submitBtn) {
                        await submitBtn.click();
                        await this.page.waitForTimeout(5000);
                        
                        // Check if login successful
                        const currentUrl = this.page.url();
                        const success = !currentUrl.includes('login') && !currentUrl.includes('signin');
                        
                        if (success) {
                            console.log(`   ✅ Successfully logged into ${source.name}!`);
                            stats.sourceBalances[source.name].loggedIn = true;
                            stats.loginHistory.unshift({
                                time: new Date(),
                                source: source.name,
                                status: 'SUCCESS'
                            });
                            return true;
                        }
                    }
                }
            }
            
            console.log(`   ⚠️ Could not login to ${source.name}`);
            stats.loginHistory.unshift({
                time: new Date(),
                source: source.name,
                status: 'FAILED',
                error: 'Login form not found'
            });
            return false;
        } catch (error) {
            console.log(`   ❌ Login error: ${error.message}`);
            stats.loginHistory.unshift({
                time: new Date(),
                source: source.name,
                status: 'FAILED',
                error: error.message
            });
            return false;
        }
    }
    
    async setupWalletOnFaucet(source, walletAddress) {
        if (!source.requiresLogin) return true;
        if (stats.sourceBalances[source.name].walletConfigured) return true;
        
        console.log(`\n🔧 Setting up wallet on ${source.name}...`);
        
        try {
            // Login first
            const loggedIn = await this.loginToExternalFaucet(source);
            if (!loggedIn) {
                console.log(`   ❌ Cannot setup wallet - login failed`);
                return false;
            }
            
            // Go to account page
            if (source.accountUrl) {
                await this.page.goto(source.accountUrl, { waitUntil: 'networkidle2', timeout: 15000 });
                await this.page.waitForTimeout(3000);
            }
            
            // Find wallet field
            let walletField = null;
            let usedSelector = null;
            
            for (const selector of source.walletFieldSelectors) {
                try {
                    walletField = await this.page.$(selector);
                    if (walletField) {
                        usedSelector = selector;
                        console.log(`   ✅ Found wallet field: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (!walletField) {
                // Try to find by placeholder or label
                walletField = await this.page.evaluateHandle(() => {
                    const inputs = Array.from(document.querySelectorAll('input'));
                    return inputs.find(input => {
                        const placeholder = (input.placeholder || '').toLowerCase();
                        const name = (input.name || '').toLowerCase();
                        const id = (input.id || '').toLowerCase();
                        return placeholder.includes('wallet') || placeholder.includes('address') ||
                               name.includes('wallet') || name.includes('address') ||
                               id.includes('wallet') || id.includes('address');
                    });
                });
                const isNull = await walletField.evaluate(el => el === null).catch(() => true);
                if (!isNull) {
                    console.log(`   ✅ Found wallet field by auto-detection`);
                    usedSelector = 'auto-detected';
                } else {
                    walletField = null;
                }
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
                await this.page.waitForTimeout(1000);
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
                    await this.page.waitForTimeout(3000);
                    console.log(`   ✅ Wallet SAVED for ${source.name}!`);
                    stats.sourceBalances[source.name].walletConfigured = true;
                    stats.setupHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        status: 'CONFIGURED',
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
            console.log(`\n📝 Processing ${source.name}...`);
            const success = await this.setupWalletOnFaucet(source, walletAddress);
            if (success) successCount++;
            await this.page.waitForTimeout(2000);
        }
        
        console.log(`\n========================================`);
        console.log(`✅ Setup Complete: ${successCount}/${externalFaucets.length} configured`);
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
            await this.page.waitForTimeout(3000);
            await this.page.type('#email', this.email);
            await this.page.type('#password', this.password);
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(5000);
            
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
            // For external faucets, ensure logged in and wallet configured
            if (source.requiresLogin) {
                const setup = new AutoWalletSetup(this.browser, this.page);
                
                if (!stats.sourceBalances[source.name].loggedIn) {
                    await setup.loginToExternalFaucet(source);
                }
                
                if (AUTO_SETUP && !stats.sourceBalances[source.name].walletConfigured) {
                    const walletAddress = await setup.getFaucetPayWallet();
                    if (walletAddress) {
                        await setup.setupWalletOnFaucet(source, walletAddress);
                    }
                }
            }
            
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
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
                await this.page.waitForTimeout(3000);
                
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
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)} → ${source.instantToBalance ? 'Balance' : `${source.name} Wallet ${walletStatus}`}`);
                
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
            console.log(`   ❌ Error: ${error.message}`);
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
            await this.page.waitForTimeout(3000);
            
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
                await this.page.waitForTimeout(5000);
                
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
            await this.page.waitForTimeout(2000);
        }
        
        // Then internal sources
        const internalSources = EARNING_SOURCES.filter(s => s.instantToBalance);
        for (const source of internalSources) {
            const earned = await this.claimFromSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(1500);
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
        
        // Show wallet status
        const unconfigured = EARNING_SOURCES.filter(s => s.requiresLogin && !stats.sourceBalances[s.name].walletConfigured);
        if (unconfigured.length > 0) {
            console.log(`\n⚠️ ${unconfigured.length} faucets need wallet configuration:`);
            for (const source of unconfigured) {
                console.log(`   ❌ ${source.name} - Wallet not set`);
            }
        }
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Complete Faucet Bot');
        console.log('💰 Real-time earnings and withdrawal tracking');
        console.log('🔧 Auto wallet configuration for ALL sources enabled\n');
        
        await this.init();
        await this.loginToFaucetPay();
        
        // RUN AUTO SETUP ON START
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
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
            } catch (error) {
                console.error(`Cycle error: ${error.message}`);
                await this.page.waitForTimeout(10000);
            }
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
   
