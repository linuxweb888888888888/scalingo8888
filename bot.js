// faucetpay-full-bot.js - Complete Bot with Automatic Wallet Configuration
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
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'false';
const AUTO_SETUP = process.env.AUTO_SETUP !== 'false';

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

// ============ EARNING SOURCES ============
const EARNING_SOURCES = [
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', instantToBalance: true },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', instantToBalance: true },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', instantToBalance: true },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', instantToBalance: true },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', instantToBalance: true },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', instantToBalance: true },
    { 
        name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerAction: 0.0002, type: 'faucet', 
        minWithdraw: 0.0001, instantToBalance: false, requiresExternalLogin: true,
        walletFieldSelector: '#faucetpay_address', saveButtonSelector: '#save_address',
        withdrawSelectors: ['.withdraw-btn', '#withdrawButton', 'button:has-text("Withdraw")']
    },
    { 
        name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerAction: 0.0005, type: 'faucet', 
        minWithdraw: 0.0003, instantToBalance: false, requiresExternalLogin: true,
        walletFieldSelector: '#btc_address', saveButtonSelector: '#save_address',
        withdrawSelectors: ['#withdraw_button', '.withdraw-btn']
    },
    { 
        name: 'FireFaucet', url: 'https://firefaucet.win', earnPerAction: 0.0003, type: 'faucet', 
        minWithdraw: 0.0002, instantToBalance: false, requiresExternalLogin: true,
        walletFieldSelector: 'input[name="faucetpay"]', saveButtonSelector: 'button[type="submit"]',
        withdrawSelectors: ['.withdraw-btn', '#withdraw']
    },
    { 
        name: 'Cointiply', url: 'https://cointiply.com', earnPerAction: 0.0003, type: 'faucet', 
        minWithdraw: 0.0002, instantToBalance: false, requiresExternalLogin: true,
        walletFieldSelector: '#btc_address', saveButtonSelector: '#save_btc',
        withdrawSelectors: ['.withdraw-button', '#withdrawBtn']
    }
];

// ============ STATS STORAGE ============
let stats = {
    totalEarned: 0, totalActions: 0, currentBalance: 0, sessionEarned: 0,
    sourceBalances: {}, withdrawalHistory: [], claimHistory: [], setupHistory: [],
    startTime: new Date(), loggedIn: false, lastWithdrawal: null,
    withdrawalAttempts: 0, successfulWithdrawals: 0, failedWithdrawals: 0
};

EARNING_SOURCES.forEach(s => {
    stats.sourceBalances[s.name] = { earned: 0, claims: 0, lastClaim: null, pendingWithdraw: false, walletConfigured: false };
});

// ============ AUTO WALLET SETUP MANAGER ============
class AutoWalletSetup {
    constructor(browser, page) {
        this.browser = browser;
        this.page = page;
    }
    
    async getFaucetPayWallet() {
        console.log('\n🔍 Getting FaucetPay wallet address...');
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
            
            if (!walletAddress) {
                const content = await walletPage.content();
                const btcMatch = content.match(/[13][a-km-zA-HJ-NP-Z1-9]{25,34}/);
                if (btcMatch) walletAddress = btcMatch[0];
            }
            
            await walletPage.close();
            
            if (walletAddress) {
                console.log(`✅ Found wallet: ${walletAddress.substring(0, 15)}...`);
                return walletAddress;
            }
            return null;
        } catch (error) {
            console.log(`❌ Error getting wallet: ${error.message}`);
            return null;
        }
    }
    
    async configureWallet(source, walletAddress) {
        console.log(`\n🔧 Configuring wallet for ${source.name}...`);
        
        try {
            // Check if already configured
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            // Look for wallet field
            let walletField = await this.page.$(source.walletFieldSelector);
            if (!walletField) {
                console.log(`   ⚠️ Could not find wallet field on ${source.name}`);
                return false;
            }
            
            const currentValue = await this.page.$eval(source.walletFieldSelector, el => el.value).catch(() => '');
            
            if (currentValue && currentValue.length > 25) {
                console.log(`   ✅ Wallet already configured: ${currentValue.substring(0, 15)}...`);
                stats.sourceBalances[source.name].walletConfigured = true;
                stats.setupHistory.unshift({ time: new Date(), source: source.name, status: 'ALREADY_CONFIGURED', wallet: currentValue.substring(0, 15) });
                return true;
            }
            
            // Enter wallet address
            await walletField.click({ clickCount: 3 });
            await walletField.type(walletAddress);
            await this.page.waitForTimeout(1000);
            
            // Save
            let saveBtn = await this.page.$(source.saveButtonSelector);
            if (saveBtn) {
                await saveBtn.click();
                await this.page.waitForTimeout(3000);
                console.log(`   ✅ Wallet configured and SAVED for ${source.name}!`);
                stats.sourceBalances[source.name].walletConfigured = true;
                stats.setupHistory.unshift({ time: new Date(), source: source.name, status: 'CONFIGURED', wallet: walletAddress.substring(0, 15) });
                return true;
            }
            
            return false;
        } catch (error) {
            console.log(`   ❌ Failed to configure ${source.name}: ${error.message}`);
            return false;
        }
    }
    
    async runAutoSetup() {
        console.log('\n========================================');
        console.log('  🔧 AUTO WALLET SETUP STARTING');
        console.log('========================================');
        
        const walletAddress = await this.getFaucetPayWallet();
        if (!walletAddress) {
            console.log('\n❌ Could not find FaucetPay wallet address!');
            console.log('Please manually add your wallet address to .env:');
            console.log('FAUCETPAY_WALLET_ADDRESS=your_btc_address_here\n');
            return false;
        }
        
        const externalFaucets = EARNING_SOURCES.filter(s => !s.instantToBalance);
        let successCount = 0;
        
        for (const source of externalFaucets) {
            console.log(`\n📝 Configuring ${source.name}...`);
            const success = await this.configureWallet(source, walletAddress);
            if (success) successCount++;
            await this.page.waitForTimeout(2000);
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

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(2000);
            
            let claimBtn = null;
            for (const selector of this.claimSelectors) {
                try { claimBtn = await this.page.$(selector); if (claimBtn) break; } catch(e) {}
            }
            
            if (!claimBtn) {
                claimBtn = await this.page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    return buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('claim') || text.includes('get') || text.includes('earn');
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
                        
                        // Check if wallet is configured
                        if (!stats.sourceBalances[source.name].walletConfigured && AUTO_SETUP) {
                            console.log(`   🔧 Wallet not configured! Running auto-setup...`);
                            const setup = new AutoWalletSetup(this.browser, this.page);
                            const walletAddress = await setup.getFaucetPayWallet();
                            if (walletAddress) {
                                await setup.configureWallet(source, walletAddress);
                            }
                        }
                        
                        if (stats.sourceBalances[source.name].walletConfigured) {
                            await this.withdrawFromSource(source);
                        } else {
                            console.log(`   ❌ Cannot withdraw: Wallet not configured for ${source.name}`);
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
                    if (withdrawBtn) break;
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
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(2000);
        }
        
        // Then internal sources
        const internalSources = EARNING_SOURCES.filter(s => s.instantToBalance);
        for (const source of internalSources) {
            const earned = await this.claimSource(source);
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
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Complete Faucet Bot');
        console.log('💰 Real-time earnings and withdrawal tracking');
        console.log('🔧 Auto wallet configuration enabled\n');
        
        await this.init();
        await this.login();
        
        // RUN AUTO SETUP ON START
        if (AUTO_SETUP) {
            console.log('\n🔧 Running automatic wallet configuration...');
            const setup = new AutoWalletSetup(this.browser, this.page);
            await setup.runAutoSetup();
        } else {
            console.log('\n⚠️ Auto-setup is OFF. Wallets must be configured manually.');
            console.log('   Set AUTO_SETUP=true to enable automatic configuration\n');
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
    const minutes = Math.floor((uptime % 3600) / 60);
    const dailyRate = (stats.totalEarned / (uptime / 86400)).toFixed(5);
    const hourlyRate = (stats.totalEarned / (uptime / 3600)).toFixed(5);
    
    const sourceBalancesHtml = Object.entries(stats.sourceBalances)
        .filter(([_, data]) => data.earned > 0 || data.claims > 0)
        .map(([name, data]) => {
            const source = EARNING_SOURCES.find(s => s.name === name);
            const minText = source?.minWithdraw ? ` / Min: $${source.minWithdraw}` : '';
            const walletStatus = data.walletConfigured ? '✅ Configured' : (source?.minWithdraw ? '❌ Not Set' : 'N/A');
            return `<tr><td>${name}</td><td class="earn">$${data.earned.toFixed(5)}${minText}</td><td>${data.claims}</td><td>${walletStatus}</td><td>${data.pendingWithdraw ? '⏳' : 'Active'}</td></tr>`;
        }).join('');
    
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 20).map(w => `
        <tr><td>${new Date(w.time).toLocaleTimeString()}</td><td>${w.source}</td><td class="earn">$${w.amount.toFixed(5)}</td><td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td><td>${w.error || '-'}</td></tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html><head><title>FaucetPay Bot</title><meta http-equiv="refresh" content="10">
<style>body{background:#0a0e27;color:#00ff88;font-family:monospace;padding:20px}.container{max-width:1400px;margin:0 auto}.stat-card{background:#1a1f3a;padding:15px;border-radius:10px;display:inline-block;margin:10px}.card{background:#1a1f3a;padding:15px;border-radius:10px;margin-bottom:20px}.earn{color:#00ff88}.error{color:#ff4444}table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid #333}</style>
<body><div class="container"><h1>💰 FaucetPay Bot</h1>
<div class="card">🟢 LIVE | Uptime: ${hours}h ${minutes}m | Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'} | Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}<br>Session: $${stats.sessionEarned.toFixed(5)} | Balance: $${stats.currentBalance.toFixed(5)} | Withdrawals: ${stats.successfulWithdrawals}/${stats.withdrawalAttempts}</div>
<div class="stat-card"><div class="earn">$${stats.totalEarned.toFixed(5)}</div>Total</div>
<div class="stat-card"><div class="earn">$${hourlyRate}</div>/Hour</div>
<div class="stat-card"><div class="earn">$${dailyRate}</div>/Day</div>
<div class="card"><h3>🪙 Source Balances</h3><table><tr><th>Source</th><th>Balance</th><th>Claims</th><th>Wallet</th><th>Status</th></tr>${sourceBalancesHtml || '<tr><td colspan="5">No data</td></tr>'}</table></div>
<div class="card"><h3>💸 Withdrawals</h3><table><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th><th>Error</th></tr>${withdrawalHtml || '<tr><td colspan="5">No withdrawals</td></tr>'}</table></div>
</div></body></html>`);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => console.log(`📊 Dashboard: http://localhost:${port}`));
    const bot = new CompleteFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => {
    console.log(`\n\n📊 Final: Earned $${stats.totalEarned.toFixed(5)} | Withdrawals: ${stats.successfulWithdrawals}/${stats.withdrawalAttempts}`);
    process.exit(0);
});

main().catch(console.error);
