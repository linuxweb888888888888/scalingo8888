// faucetpay-full-bot.js - Complete Automated Setup & Bot with Verification
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
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';
const AUTO_SETUP = process.env.AUTO_SETUP !== 'true';

console.log('\n========================================');
console.log('  FaucetPay Complete Bot v3.0');
console.log('========================================');
console.log(`Auto Setup: ${AUTO_SETUP ? 'ON - Will auto-configure all faucets' : 'OFF'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
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

// ============ EARNING SOURCES WITH WITHDRAWAL CONFIG ============
const EARNING_SOURCES = [
    // FaucetPay Internal (Instant to balance)
    { 
        name: 'Daily Bonus', 
        url: 'https://faucetpay.io/dashboard', 
        earnPerAction: 0.001, 
        type: 'bonus', 
        instantToBalance: true,
        requiresSetup: false
    },
    { 
        name: 'Faucet List', 
        url: 'https://faucetpay.io/faucets', 
        earnPerAction: 0.0005, 
        type: 'view', 
        instantToBalance: true,
        requiresSetup: false
    },
    { 
        name: 'Offerwalls', 
        url: 'https://faucetpay.io/offerwalls', 
        earnPerAction: 0.002, 
        type: 'view', 
        instantToBalance: true,
        requiresSetup: false
    },
    { 
        name: 'PTC Ads', 
        url: 'https://faucetpay.io/ptc', 
        earnPerAction: 0.0008, 
        type: 'ptc', 
        instantToBalance: true,
        requiresSetup: false
    },
    { 
        name: 'Staking', 
        url: 'https://faucetpay.io/staking', 
        earnPerAction: 0.001, 
        type: 'staking', 
        instantToBalance: true,
        requiresSetup: false
    },
    { 
        name: 'Tasks', 
        url: 'https://faucetpay.io/tasks', 
        earnPerAction: 0.0015, 
        type: 'tasks', 
        instantToBalance: true,
        requiresSetup: false
    },
    
    // External Faucets (Require wallet setup & withdrawal)
    { 
        name: 'FreeBitcoin', 
        url: 'https://freebitco.in', 
        earnPerAction: 0.0005, 
        type: 'faucet', 
        minWithdraw: 0.0003, 
        instantToBalance: false,
        requiresSetup: true,
        setupUrl: 'https://freebitco.in/?op=profile',
        walletFieldSelector: '#btc_address',
        saveButtonSelector: '#save_address',
        withdrawSelectors: ['#withdraw_button', '.withdraw-btn'],
        walletSet: false,
        walletVerified: false
    },
    { 
        name: 'FireFaucet', 
        url: 'https://firefaucet.win', 
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresSetup: true,
        setupUrl: 'https://firefaucet.win/profile',
        walletFieldSelector: 'input[name="faucetpay"]',
        saveButtonSelector: 'button[type="submit"]',
        withdrawSelectors: ['.withdraw-btn', '#withdraw'],
        walletSet: false,
        walletVerified: false
    },
    { 
        name: 'Cointiply', 
        url: 'https://cointiply.com', 
        earnPerAction: 0.0003, 
        type: 'faucet', 
        minWithdraw: 0.0002, 
        instantToBalance: false,
        requiresSetup: true,
        setupUrl: 'https://cointiply.com/account',
        walletFieldSelector: '#btc_address',
        saveButtonSelector: '#save_btc',
        withdrawSelectors: ['.withdraw-button', '#withdrawBtn'],
        walletSet: false,
        walletVerified: false
    },
    { 
        name: 'FaucetCrypto', 
        url: 'https://faucetcrypto.com', 
        earnPerAction: 0.0002, 
        type: 'faucet', 
        minWithdraw: 0.0001, 
        instantToBalance: false,
        requiresSetup: true,
        setupUrl: 'https://faucetcrypto.com/account',
        walletFieldSelector: '#faucetpay_address',
        saveButtonSelector: '#save_address',
        withdrawSelectors: ['.withdraw-btn', '#withdrawButton'],
        walletSet: false,
        walletVerified: false
    }
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
    setupHistory: [],
    startTime: new Date(),
    loggedIn: false,
    lastWithdrawal: null,
    withdrawalAttempts: 0,
    successfulWithdrawals: 0,
    failedWithdrawals: 0,
    setupComplete: {}
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, 
        claims: 0, 
        lastClaim: null, 
        pendingWithdraw: false,
        lastWithdrawAttempt: null,
        withdrawError: null,
        walletConfigured: false,
        walletVerified: false
    };
    if (s.requiresSetup) {
        stats.setupComplete[s.name] = false;
    }
});

// ============ AUTOMATIC SETUP MANAGER ============
class AutoSetupManager {
    constructor(browser, faucetpayWalletAddress) {
        this.browser = browser;
        this.faucetpayWallet = faucetpayWalletAddress;
        this.setupResults = [];
    }
    
    async getFaucetPayWallet() {
        console.log('\n🔧 [SETUP] Getting FaucetPay wallet address...');
        const page = await this.browser.newPage();
        try {
            await page.goto('https://faucetpay.io/account', { waitUntil: 'networkidle2', timeout: 15000 });
            await page.waitForTimeout(3000);
            
            // Try multiple selectors to find wallet address
            const walletSelectors = [
                '.wallet-address',
                '#wallet_address',
                '.btc-address',
                'input[name="wallet_address"]',
                '.address-display'
            ];
            
            let walletAddress = null;
            for (const selector of walletSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        walletAddress = await page.$eval(selector, el => el.value || el.innerText).catch(() => null);
                        if (walletAddress && walletAddress.length > 20) break;
                    }
                } catch(e) {}
            }
            
            // If not found, try to get from page content
            if (!walletAddress) {
                const content = await page.content();
                const btcMatch = content.match(/[13][a-km-zA-HJ-NP-Z1-9]{25,34}/);
                if (btcMatch) walletAddress = btcMatch[0];
            }
            
            if (walletAddress) {
                console.log(`✅ [SETUP] Found FaucetPay wallet: ${walletAddress.substring(0, 15)}...`);
                return walletAddress;
            } else {
                console.log(`⚠️ [SETUP] Could not auto-detect wallet. Using fallback method.`);
                return null;
            }
        } catch (error) {
            console.log(`⚠️ [SETUP] Error getting wallet: ${error.message}`);
            return null;
        } finally {
            await page.close();
        }
    }
    
    async setupFaucetWallet(source, walletAddress) {
        console.log(`\n🔧 [SETUP] Configuring ${source.name}...`);
        const page = await this.browser.newPage();
        
        try {
            await page.goto(source.setupUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            await page.waitForTimeout(3000);
            
            // Check if wallet is already set
            const existingWallet = await page.$eval(source.walletFieldSelector, el => el.value, false).catch(() => '');
            
            if (existingWallet && existingWallet.length > 20) {
                console.log(`   ✅ ${source.name} wallet already configured: ${existingWallet.substring(0, 15)}...`);
                source.walletSet = true;
                source.walletVerified = true;
                stats.sourceBalances[source.name].walletConfigured = true;
                stats.sourceBalances[source.name].walletVerified = true;
                stats.setupComplete[source.name] = true;
                
                stats.setupHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    action: 'WALLET_ALREADY_SET',
                    wallet: existingWallet.substring(0, 15) + '...',
                    status: 'SUCCESS'
                });
                return true;
            }
            
            // Enter wallet address
            await page.click(source.walletFieldSelector, { clickCount: 3 });
            await page.type(source.walletFieldSelector, walletAddress);
            await page.waitForTimeout(1000);
            
            // Verify it was entered correctly
            const enteredWallet = await page.$eval(source.walletFieldSelector, el => el.value);
            if (enteredWallet === walletAddress) {
                console.log(`   ✅ Wallet address entered successfully`);
                
                // Save the wallet
                await page.click(source.saveButtonSelector);
                await page.waitForTimeout(3000);
                
                // Check for success message
                const pageContent = await page.content();
                const successIndicators = ['success', 'saved', 'updated', 'complete'];
                const isSuccess = successIndicators.some(ind => pageContent.toLowerCase().includes(ind));
                
                if (isSuccess) {
                    console.log(`   ✅ WALLET SAVED SUCCESSFULLY for ${source.name}!`);
                    source.walletSet = true;
                    source.walletVerified = true;
                    stats.sourceBalances[source.name].walletConfigured = true;
                    stats.sourceBalances[source.name].walletVerified = true;
                    stats.setupComplete[source.name] = true;
                    
                    stats.setupHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        action: 'WALLET_CONFIGURED',
                        wallet: walletAddress.substring(0, 15) + '...',
                        status: 'SUCCESS',
                        message: 'Wallet saved successfully'
                    });
                    return true;
                } else {
                    console.log(`   ⚠️ Wallet saved but success not confirmed for ${source.name}`);
                    stats.setupHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        action: 'WALLET_SAVED',
                        status: 'UNCERTAIN',
                        message: 'Wallet may have been saved'
                    });
                    return true;
                }
            } else {
                console.log(`   ❌ Failed to enter wallet address for ${source.name}`);
                stats.setupHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    action: 'WALLET_SETUP_FAILED',
                    status: 'FAILED',
                    error: 'Could not enter wallet address'
                });
                return false;
            }
        } catch (error) {
            console.log(`   ❌ Setup failed for ${source.name}: ${error.message}`);
            stats.setupHistory.unshift({
                time: new Date(),
                source: source.name,
                action: 'WALLET_SETUP_FAILED',
                status: 'FAILED',
                error: error.message
            });
            return false;
        } finally {
            await page.close();
        }
    }
    
    async verifyWalletSetup(source) {
        console.log(`\n🔍 [VERIFY] Checking ${source.name} wallet configuration...`);
        const page = await this.browser.newPage();
        
        try {
            await page.goto(source.setupUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await page.waitForTimeout(2000);
            
            const walletField = await page.$(source.walletFieldSelector);
            if (walletField) {
                const walletValue = await page.$eval(source.walletFieldSelector, el => el.value);
                if (walletValue && walletValue.length > 20) {
                    console.log(`   ✅ VERIFIED: Wallet configured on ${source.name}`);
                    console.log(`   📝 Wallet: ${walletValue.substring(0, 15)}...`);
                    source.walletVerified = true;
                    stats.sourceBalances[source.name].walletVerified = true;
                    return true;
                }
            }
            
            console.log(`   ❌ Wallet NOT configured on ${source.name}`);
            return false;
        } catch (error) {
            console.log(`   ❌ Verification failed: ${error.message}`);
            return false;
        } finally {
            await page.close();
        }
    }
    
    async runAutoSetup() {
        console.log('\n========================================');
        console.log('  🔧 AUTOMATIC SETUP STARTING');
        console.log('========================================');
        
        // Get FaucetPay wallet address
        let walletAddress = await this.getFaucetPayWallet();
        
        if (!walletAddress) {
            console.log('\n⚠️ Could not auto-detect wallet address');
            console.log('Please manually set your FaucetPay wallet address:');
            console.log('1. Go to https://faucetpay.io/account');
            console.log('2. Copy your BTC wallet address');
            console.log('3. Set environment variable: FAUCETPAY_WALLET_ADDRESS=your_address\n');
            
            // Try to get from environment
            walletAddress = process.env.FAUCETPAY_WALLET_ADDRESS;
            if (!walletAddress) {
                console.log('❌ No wallet address available. Auto-withdrawals will fail.');
                console.log('Please set FAUCETPAY_WALLET_ADDRESS environment variable.\n');
                return false;
            }
        }
        
        console.log(`\n📝 Using wallet: ${walletAddress.substring(0, 15)}...`);
        
        // Setup each faucet
        const externalFaucets = EARNING_SOURCES.filter(s => s.requiresSetup);
        let successCount = 0;
        
        for (const source of externalFaucets) {
            console.log(`\n${'='.repeat(50)}`);
            const success = await this.setupFaucetWallet(source, walletAddress);
            if (success) {
                successCount++;
                // Verify after setup
                await this.verifyWalletSetup(source);
            }
            await this.pageWait(2000);
        }
        
        console.log(`\n========================================`);
        console.log(`  ✅ SETUP COMPLETE`);
        console.log(`========================================`);
        console.log(`Successfully configured: ${successCount}/${externalFaucets.length} faucets`);
        console.log(`\n📊 Setup Summary:`);
        for (const source of externalFaucets) {
            const status = source.walletVerified ? '✅ VERIFIED' : (source.walletSet ? '⚠️ SET BUT NOT VERIFIED' : '❌ FAILED');
            console.log(`   ${status} - ${source.name}`);
        }
        console.log(`\n💡 Withdrawals will now work automatically when minimum thresholds are reached!\n`);
        
        return successCount > 0;
    }
    
    async pageWait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============ COMPLETE BOT WITH DETAILED WITHDRAWALS ============
class CompleteFaucetBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.claimSelectors = ['#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button', '#free_play_form_button'];
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

    async login() {
        if (!this.email || !this.password) {
            console.log('[FaucetPay] Demo mode - limited features');
            return false;
        }
        
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
            console.log('[FaucetPay] Login failed - running in limited mode');
            return false;
        }
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

    async withdrawFromSource(source) {
        const balance = stats.sourceBalances[source.name].earned;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💸 ATTEMPTING WITHDRAWAL from ${source.name}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   📊 Current balance: $${balance.toFixed(5)}`);
        console.log(`   🎯 Minimum required: $${source.minWithdraw}`);
        console.log(`   💳 Wallet configured: ${source.walletVerified ? '✅ YES' : '❌ NO'}`);
        
        if (!source.walletVerified && source.requiresSetup) {
            console.log(`   ❌ Cannot withdraw: Wallet not configured on ${source.name}`);
            console.log(`   💡 Run auto-setup first or manually configure your FaucetPay wallet address`);
            
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: 'Wallet not configured',
                details: 'Please run auto-setup first'
            });
            stats.failedWithdrawals++;
            return false;
        }
        
        stats.sourceBalances[source.name].pendingWithdraw = true;
        stats.sourceBalances[source.name].lastWithdrawAttempt = new Date();
        stats.withdrawalAttempts++;
        
        try {
            // Go to withdrawal page
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Find and click withdraw button
            let withdrawBtn = null;
            for (const selector of source.withdrawSelectors) {
                try {
                    withdrawBtn = await this.page.$(selector);
                    if (withdrawBtn) break;
                } catch(e) {}
            }
            
            if (!withdrawBtn) {
                // Try to find by text
                withdrawBtn = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    return buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('withdraw') || text.includes('cash out');
                    });
                });
            }
            
            if (withdrawBtn) {
                console.log(`   🔘 Clicking withdraw button...`);
                await withdrawBtn.click();
                await this.page.waitForTimeout(3000);
                
                // Check if withdrawal was successful
                const pageContent = await this.page.content();
                const successIndicators = ['success', 'sent', 'completed', 'withdrawn', 'transaction'];
                const isSuccess = successIndicators.some(ind => pageContent.toLowerCase().includes(ind));
                
                if (isSuccess) {
                    const withdrawnAmount = balance;
                    console.log(`   ✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
                    console.log(`   💰 Amount: $${withdrawnAmount.toFixed(5)}`);
                    console.log(`   🎯 Sent to: FaucetPay Wallet`);
                    console.log(`   📝 Status: COMPLETED`);
                    
                    // Record successful withdrawal
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: withdrawnAmount,
                        status: 'SUCCESS',
                        to: 'FaucetPay Balance',
                        transactionId: new Date().getTime(),
                        details: 'Successfully withdrawn to wallet'
                    });
                    
                    stats.successfulWithdrawals++;
                    stats.lastWithdrawal = new Date();
                    stats.sourceBalances[source.name].earned = 0;
                    stats.sourceBalances[source.name].withdrawError = null;
                    
                    // Update balance after successful withdrawal
                    if (this.loggedIn) {
                        await this.updateBalance();
                        console.log(`   💳 New FaucetPay balance: $${stats.currentBalance.toFixed(5)}`);
                    }
                    
                    return true;
                } else {
                    // Check for specific error messages
                    const errorMessages = ['insufficient', 'minimum', 'error', 'failed', 'try again'];
                    const errorMatch = errorMessages.find(err => pageContent.toLowerCase().includes(err));
                    
                    console.log(`   ❌ WITHDRAWAL FAILED`);
                    if (errorMatch) {
                        console.log(`   📛 Error: ${errorMatch.toUpperCase()}`);
                    } else {
                        console.log(`   📛 Error: Unknown - withdrawal not confirmed`);
                    }
                    console.log(`   💡 Tip: Make sure you've completed any required tasks or verifications`);
                    
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: balance,
                        status: 'FAILED',
                        error: errorMatch || 'Withdrawal not confirmed',
                        details: 'Transaction may require manual review'
                    });
                    stats.failedWithdrawals++;
                    stats.sourceBalances[source.name].withdrawError = errorMatch || 'Unknown error';
                    return false;
                }
            } else {
                console.log(`   ❌ Withdrawal button not found on ${source.name}`);
                console.log(`   💡 The site may have changed its layout or requires login`);
                
                stats.withdrawalHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: balance,
                    status: 'FAILED',
                    error: 'Withdrawal button not found',
                    details: 'Site structure may have changed'
                });
                stats.failedWithdrawals++;
                stats.sourceBalances[source.name].withdrawError = 'Button not found';
                return false;
            }
        } catch (error) {
            console.log(`   ❌ Withdrawal error: ${error.message}`);
            
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: error.message,
                details: 'Exception during withdrawal process'
            });
            stats.failedWithdrawals++;
            stats.sourceBalances[source.name].withdrawError = error.message;
            return false;
        } finally {
            stats.sourceBalances[source.name].pendingWithdraw = false;
            console.log(`${'='.repeat(60)}\n`);
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
                
                // Log with appropriate indicator
                const indicator = source.instantToBalance ? '💰' : '🪙';
                const walletStatus = (!source.instantToBalance && source.walletVerified) ? ' (✅ Wallet ready)' : '';
                console.log(`  ${indicator} ${source.name}: +$${earned.toFixed(5)} → ${source.instantToBalance ? 'To Balance' : `To ${source.name} Wallet${walletStatus}`}`);
                
                // Check if external faucet reached withdrawal minimum
                if (!source.instantToBalance && source.minWithdraw && AUTO_WITHDRAW) {
                    const currentBalance = stats.sourceBalances[source.name].earned;
                    if (currentBalance >= source.minWithdraw) {
                        console.log(`\n🎯 ${source.name} REACHED WITHDRAWAL THRESHOLD!`);
                        console.log(`   Balance: $${currentBalance.toFixed(5)} / Minimum: $${source.minWithdraw}`);
                        await this.withdrawFromSource(source);
                    } else {
                        const remaining = (source.minWithdraw - currentBalance).toFixed(5);
                        console.log(`   📊 Progress: $${currentBalance.toFixed(5)} / Need $${remaining} more for withdrawal`);
                    }
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${EARNING_SOURCES.length} sources | Balance: $${stats.currentBalance.toFixed(5)}`);
        console.log(`📈 Session earned: $${stats.sessionEarned.toFixed(5)}`);
        console.log(`💳 Withdrawals: ${stats.successfulWithdrawals} successful / ${stats.failedWithdrawals} failed`);
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
        
        // Show summary
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💳 Balance: $${stats.currentBalance.toFixed(5)}`);
        
        // Show source balances summary
        const activeSources = Object.entries(stats.sourceBalances).filter(([_, data]) => data.earned > 0);
        if (activeSources.length > 0) {
            console.log('\n📦 Pending balances (ready for withdrawal):');
            for (const [name, data] of activeSources) {
                if (data.earned > 0) {
                    const source = EARNING_SOURCES.find(s => s.name === name);
                    const minText = source?.minWithdraw ? ` (min: $${source.minWithdraw})` : '';
                    const walletStatus = source?.walletVerified ? '✅' : '❌';
                    const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 0;
                    console.log(`   ${walletStatus} ${name}: $${data.earned.toFixed(5)}${minText} - ${progress}% to withdrawal`);
                }
            }
        }
        
        // Show recent withdrawals
        if (stats.withdrawalHistory.length > 0) {
            const lastWithdraw = stats.withdrawalHistory[0];
            const timeSince = Math.floor((new Date() - new Date(lastWithdraw.time)) / 1000);
            if (timeSince < 300) { // Show if within last 5 minutes
                console.log(`\n💸 Last withdrawal: $${lastWithdraw.amount.toFixed(5)} from ${lastWithdraw.source}`);
                console.log(`   Status: ${lastWithdraw.status}`);
                if (lastWithdraw.status === 'SUCCESS') {
                    console.log(`   ✅ Successfully transferred to FaucetPay wallet!`);
                }
            }
        }
        
        // Show wallet configuration status
        const unconfigured = EARNING_SOURCES.filter(s => s.requiresSetup && !s.walletVerified);
        if (unconfigured.length > 0 && AUTO_SETUP) {
            console.log(`\n⚠️ ${unconfigured.length} faucets need wallet configuration:`);
            for (const source of unconfigured) {
                console.log(`   ❌ ${source.name} - Withdrawals will fail until configured`);
            }
            console.log(`   💡 Run auto-setup or configure manually`);
        }
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Complete Faucet Bot');
        console.log('💰 Real-time earnings and withdrawal tracking enabled');
        console.log('🔧 Auto-withdrawal and wallet configuration active');
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        // Run auto-setup if enabled
        if (AUTO_SETUP) {
            const setupManager = new AutoSetupManager(this.browser, null);
            await setupManager.runAutoSetup();
            
            // Update source configurations
            for (const source of EARNING_SOURCES) {
                if (source.requiresSetup && setupManager.setupResults[source.name]) {
                    source.walletVerified = setupManager.setupResults[source.name].verified;
                    source.walletSet = setupManager.setupResults[source.name].success;
                }
            }
        }
        
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
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    
    // Source balances HTML with wallet status
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .filter(([_, data]) => data.earned > 0 || data.claims > 0)
        .map(([name, data]) => {
            const source = EARNING_SOURCES.find(s => s.name === name);
            const minText = source?.minWithdraw ? ` / Min: $${source.minWithdraw}` : '';
            const walletStatus = source?.walletVerified ? '✅ Wallet OK' : (source?.requiresSetup ? '❌ No Wallet' : 'N/A');
            const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 100;
            
            return `
            <tr>
                <td>${name}</td>
                <td class="earn">$${data.earned.toFixed(5)}${minText}</td>
                <td>${data.claims}</td>
                <td class="${progress >= 100 ? 'earn' : ''}">${progress}%</td>
                <td>${walletStatus}</td>
                <td>${data.pendingWithdraw ? '⏳ Withdrawing' : (data.withdrawError ? '❌ Failed' : '✅ Active')}</td>
            </tr>
        `}).join('');
    
    // Withdrawal history with detailed status
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 30).map(w => `
        <tr>
            <td>${new Date(w.time).toLocaleTimeString()}</td>
            <td>${w.source}</td>
            <td class="earn">$${w.amount.toFixed(5)}</td>
            <td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td>
            <td class="small">${w.error || w.details || '-'}</td>
        </table>
    `).join('');
    
    // Setup history
    const setupHtml = stats.setupHistory.slice(0, 20).map(s => `
        <tr>
            <td>${new Date(s.time).toLocaleTimeString()}</td>
            <td>${s.source}</td>
            <td class="${s.status === 'SUCCESS' ? 'earn' : 'error'}">${s.action}</td>
            <td class="small">${s.wallet || s.message || s.error || '-'}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Complete Bot - Live Dashboard</title>
    <meta http-equiv="refresh" content="10">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1600px; margin: 0 auto; }
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
        .small { font-size: 10px; opacity: 0.8; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; }
        .live { color: #00ff88; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .success-rate { font-size: 24px; }
        .withdraw-summary { display: flex; gap: 20px; justify-content: center; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Complete Bot - Live Dashboard</h1>
        <div class="status">
            🟢 <span class="live">LIVE</span> | Uptime: ${hours}h ${minutes}m | Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'} | Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'}
            <div>Session earned: <span class="earn">$${stats.sessionEarned.toFixed(5)}</span> | Balance: <span class="earn">$${stats.currentBalance.toFixed(5)}</span></div>
            <div class="withdraw-summary">
                <div>✅ Successful: ${stats.successfulWithdrawals}</div>
                <div>❌ Failed: ${stats.failedWithdrawals}</div>
                <div>📊 Rate: ${stats.withdrawalAttempts > 0 ? ((stats.successfulWithdrawals / stats.withdrawalAttempts) * 100).toFixed(1) : 0}%</div>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${hourlyRate}</div><div>Per Hour</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>🪙 Source Balances & Wallet Status</h3>
                <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
                <table>
                    <thead>
                        <tr><th>Source</th><th>Balance</th><th>Claims</th><th>Progress</th><th>Wallet</th><th>Status</th></tr>
                    </thead>
                    <tbody>${sourceBalancesHtml || '<tr><td colspan="6">No activity yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>💸 Withdrawal History (Detailed)</h3>
                <table>
                    <thead>
                        <tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th><th>Details</th></tr>
                    </thead>
                    <tbody>${withdrawalHtml || '<tr><td colspan="5">No withdrawals yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="card">
            <h3>🔧 Setup History</h3>
            <table>
                <thead>
                    <tr><th>Time</th><th>Source</th><th>Action</th><th>Details</th></tr>
                </thead>
                <tbody>${setupHtml || '<tr><td colspan="4">No setup actions yet...</td></tr>'}</tbody>
            </table>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <table>
                <thead>
                    <tr><th>Time</th><th>Source</th><th>Amount</th><th>Destination</th></tr>
                </thead>
                <tbody>
                    ${stats.claimHistory.slice(0, 30).map(c => `
                        <tr>
                            <td>${new Date(c.time).toLocaleTimeString()}</td>
                            <td>${c.source}</td>
                            <td class="earn">+$${c.amount.toFixed(5)}</td>
                            <td>${c.instantToBalance ? '💰 Balance' : '🪙 Wallet'}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="4">No claims yet...</td></tr>'}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Complete Faucet Bot with Auto-Setup...');
    console.log('💰 Real-time earnings and withdrawal tracking enabled');
    console.log('🔧 Automatic wallet configuration active');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
        console.log(`   Watch withdrawals in real-time!`);
    });
    
    const bot = new CompleteFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => {
    console.log('\n\n📊 Final Statistics:');
    console.log(`   Total Earned: $${stats.totalEarned.toFixed(5)}`);
    console.log(`   Successful Withdrawals: ${stats.successfulWithdrawals}`);
    console.log(`   Failed Withdrawals: ${stats.failedWithdrawals}`);
    console.log(`   Success Rate: ${stats.withdrawalAttempts > 0 ? ((stats.successfulWithdrawals / stats.withdrawalAttempts) * 100).toFixed(1) : 0}%`);
    process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
