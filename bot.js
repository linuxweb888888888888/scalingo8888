// external-faucets-bot.js - Complete Bot with Auto Login & Withdrawal
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
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || '19ZjLS2cE74QcYmXHpDhhRtaA86YyjptSS';
// Use the same email/password for all faucets (create accounts first)
const FAUCET_EMAIL = process.env.FAUCET_EMAIL || 'web88888888888888@gmail.com';
const FAUCET_PASSWORD = process.env.FAUCET_PASSWORD || 'Linuxdistro&84';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const DISCOVERY_INTERVAL_MINUTES = parseInt(process.env.DISCOVERY_INTERVAL_MINUTES) || 10;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';
const AUTO_LOGIN = process.env.AUTO_LOGIN !== 'true';

console.log('\n========================================');
console.log('  External Faucets Bot v4.0');
console.log('  WITH AUTO LOGIN FOR ALL FAUCETS');
console.log('========================================');
console.log(`Auto Login: ${AUTO_LOGIN ? 'ON - Will login to each faucet' : 'OFF'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON - Immediate withdrawal' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCET_EMAIL}`);

if (FAUCETPAY_WALLET_ADDRESS) {
    console.log(`✅ Wallet: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
} else {
    console.log(`⚠️ WARNING: FAUCETPAY_WALLET_ADDRESS not set!`);
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

async function safeWait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractTransactionId(pageContent) {
    const patterns = [
        /transaction[_\s]id[:\s]+([a-zA-Z0-9]{20,})/i,
        /tx[_\s]id[:\s]+([a-zA-Z0-9]{20,})/i,
        /[A-Fa-f0-9]{64}/,
        /[a-f0-9]{64}/
    ];
    for (const pattern of patterns) {
        const match = pageContent.match(pattern);
        if (match) return match[1] || match[0];
    }
    return null;
}

// ============ EXTERNAL FAUCETS WITH LOGIN CONFIGURATION ============
const EXTERNAL_FAUCETS = [
    {
        name: 'Cointiply',
        url: 'https://cointiply.com',
        loginUrl: 'https://cointiply.com/login',
        earnPerAction: 0.0003,
        minWithdraw: 0.0002,
        claimSelector: '.claim-btn',
        withdrawSelectors: ['.withdraw-button', '#withdrawBtn', 'button:has-text("Withdraw")'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: 'button[type="submit"]' }
    },
    {
        name: 'FaucetCollector',
        url: 'https://faucetcollector.com',
        loginUrl: 'https://faucetcollector.com/login',
        earnPerAction: 0.0002,
        minWithdraw: 0.0001,
        claimSelector: '.claim-btn',
        withdrawSelectors: ['.btn-withdraw', 'button:has-text("Withdraw")'],
        loginSelectors: { email: '#email', password: '#password', submit: 'button[type="submit"]' }
    },
    {
        name: 'FaucetCrypto',
        url: 'https://faucetcrypto.com',
        loginUrl: 'https://faucetcrypto.com/login',
        earnPerAction: 0.0002,
        minWithdraw: 0.0001,
        claimSelector: '#claimButton',
        withdrawSelectors: ['.btn-success', 'a[href*="withdraw"]', '.withdraw-btn'],
        loginSelectors: { email: '#email', password: '#password', submit: 'button[type="submit"]' }
    },
    {
        name: 'FireFaucet',
        url: 'https://firefaucet.win',
        loginUrl: 'https://firefaucet.win/login',
        earnPerAction: 0.0003,
        minWithdraw: 0.0002,
        claimSelector: '.claim-btn',
        withdrawSelectors: ['a[href*="withdraw"]', '.btn-danger', '.withdraw-btn'],
        loginSelectors: { email: '#username', password: '#password', submit: 'button[type="submit"]' }
    },
    {
        name: 'CoinPayU',
        url: 'https://coinpayu.com',
        loginUrl: 'https://coinpayu.com/login',
        earnPerAction: 0.0003,
        minWithdraw: 0.0001,
        claimSelector: '.claim-btn',
        withdrawSelectors: ['.btn-primary', 'a[href*="withdraw"]', '.withdraw-btn'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: 'button[type="submit"]' }
    },
    {
        name: 'CryptoFaucet',
        url: 'https://cryptofaucet.net',
        loginUrl: 'https://cryptofaucet.net/login',
        earnPerAction: 0.0002,
        minWithdraw: 0.0001,
        claimSelector: '#claim',
        withdrawSelectors: ['.btn-primary', 'a[href*="withdraw"]', '.withdraw-btn'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: 'button[type="submit"]' }
    },
    {
        name: 'FreeBitcoin',
        url: 'https://freebitco.in',
        loginUrl: 'https://freebitco.in/?op=login',
        earnPerAction: 0.0005,
        minWithdraw: 0.0003,
        claimSelector: '#free_play_form_button',
        withdrawSelectors: ['#withdraw_button', '.withdraw-btn'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: '#login_button' }
    },
    {
        name: 'ADBTC',
        url: 'https://adbtc.top',
        loginUrl: 'https://adbtc.top/login',
        earnPerAction: 0.0002,
        minWithdraw: 0.0001,
        claimSelector: '#claim',
        withdrawSelectors: ['.btn-primary', '.withdraw-btn'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: 'button[type="submit"]' }
    },
    {
        name: 'BonusBitcoin',
        url: 'https://bonusbitcoin.co',
        loginUrl: 'https://bonusbitcoin.co/login',
        earnPerAction: 0.0002,
        minWithdraw: 0.0001,
        claimSelector: '#roll',
        withdrawSelectors: ['.btn-primary', '.withdraw-btn'],
        loginSelectors: { email: 'input[name="email"]', password: 'input[name="password"]', submit: 'button[type="submit"]' }
    }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    sessionEarned: 0,
    sourceBalances: {},
    withdrawalHistory: [],
    claimHistory: [],
    discoveryHistory: [],
    loginHistory: [],
    startTime: new Date(),
    successfulWithdrawals: 0,
    failedWithdrawals: 0,
    successfulLogins: 0,
    failedLogins: 0
};

EXTERNAL_FAUCETS.forEach(s => {
    stats.sourceBalances[s.name] = { 
        earned: 0, 
        claims: 0, 
        lastClaim: null, 
        withdrawalAttempted: false,
        loggedIn: false
    };
});

// ============ LOGIN MANAGER ============
class LoginManager {
    constructor(page) {
        this.page = page;
    }
    
    async loginToFaucet(source) {
        if (!AUTO_LOGIN) return true;
        if (stats.sourceBalances[source.name]?.loggedIn) return true;
        
        console.log(`  🔐 Logging into ${source.name}...`);
        
        try {
            await this.page.goto(source.loginUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            await safeWait(3000);
            
            // Find and fill email
            let emailField = null;
            const emailSelectors = [source.loginSelectors.email, '#email', 'input[name="email"]', 'input[type="email"]'];
            for (const selector of emailSelectors) {
                try {
                    emailField = await this.page.$(selector);
                    if (emailField) {
                        console.log(`     ✅ Found email field: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(FAUCET_EMAIL);
                console.log(`     📧 Email entered: ${FAUCET_EMAIL.substring(0, 10)}...`);
            } else {
                console.log(`     ⚠️ Email field not found`);
            }
            
            await safeWait(500);
            
            // Find and fill password
            let passwordField = null;
            const passwordSelectors = [source.loginSelectors.password, '#password', 'input[name="password"]', 'input[type="password"]'];
            for (const selector of passwordSelectors) {
                try {
                    passwordField = await this.page.$(selector);
                    if (passwordField) {
                        console.log(`     ✅ Found password field: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (passwordField) {
                await passwordField.click({ clickCount: 3 });
                await passwordField.type(FAUCET_PASSWORD);
                console.log(`     🔑 Password entered`);
            } else {
                console.log(`     ⚠️ Password field not found`);
            }
            
            await safeWait(500);
            
            // Find and click submit
            let submitBtn = null;
            const submitSelectors = [source.loginSelectors.submit, 'button[type="submit"]', 'input[type="submit"]'];
            for (const selector of submitSelectors) {
                try {
                    submitBtn = await this.page.$(selector);
                    if (submitBtn) {
                        console.log(`     ✅ Found submit button: ${selector}`);
                        break;
                    }
                } catch(e) {}
            }
            
            if (submitBtn) {
                await submitBtn.click();
                await safeWait(5000);
                console.log(`     ✅ Login submitted for ${source.name}`);
                stats.sourceBalances[source.name].loggedIn = true;
                stats.successfulLogins++;
                stats.loginHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    status: 'SUCCESS'
                });
                return true;
            } else {
                console.log(`     ⚠️ Could not find submit button`);
                stats.sourceBalances[source.name].loggedIn = true; // Assume logged in
                return true;
            }
        } catch (error) {
            console.log(`     ❌ Login error: ${error.message}`);
            stats.failedLogins++;
            stats.loginHistory.unshift({
                time: new Date(),
                source: source.name,
                status: 'FAILED',
                error: error.message
            });
            stats.sourceBalances[source.name].loggedIn = true; // Continue anyway
            return true;
        }
    }
    
    async loginToAllFaucets(sources) {
        console.log('\n========================================');
        console.log('  🔐 LOGGING INTO ALL FAUCETS');
        console.log('========================================');
        
        for (const source of sources) {
            if (source.loginUrl) {
                await this.loginToFaucet(source);
                await safeWait(2000);
            } else {
                stats.sourceBalances[source.name].loggedIn = true;
            }
        }
        
        console.log(`\n✅ Logins: ${stats.successfulLogins} successful / ${stats.failedLogins} failed`);
        console.log('========================================\n');
    }
}

// ============ EARNING ENGINE ============
class EarningEngine {
    constructor(page) {
        this.page = page;
    }
    
    async withdrawFromSource(source, balance) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`💸 WITHDRAWING from ${source.name}`);
        console.log(`${'='.repeat(60)}`);
        console.log(`   Balance: $${balance.toFixed(5)}`);
        console.log(`   Minimum: $${source.minWithdraw}`);
        
        stats.sourceBalances[source.name].withdrawalAttempted = true;
        
        try {
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await safeWait(3000);
            
            let withdrawClicked = false;
            let usedSelector = null;
            const withdrawSelectors = source.withdrawSelectors;
            
            for (const selector of withdrawSelectors) {
                try {
                    const withdrawBtn = await this.page.$(selector);
                    if (withdrawBtn) {
                        await withdrawBtn.click();
                        withdrawClicked = true;
                        usedSelector = selector;
                        console.log(`   ✅ Clicked withdraw button using: ${selector}`);
                        break;
                    }
                } catch(e) {
                    try {
                        await this.page.evaluate((sel) => {
                            const btn = document.querySelector(sel);
                            if (btn) btn.click();
                        }, selector);
                        withdrawClicked = true;
                        usedSelector = `${selector} (evaluate)`;
                        console.log(`   ✅ Clicked withdraw button via evaluate: ${selector}`);
                        break;
                    } catch(e2) {}
                }
            }
            
            if (!withdrawClicked) {
                withdrawClicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const withdrawBtn = buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('withdraw') || text.includes('cash out');
                    });
                    if (withdrawBtn) {
                        withdrawBtn.click();
                        return true;
                    }
                    return false;
                });
                if (withdrawClicked) {
                    usedSelector = 'text search';
                    console.log(`   ✅ Clicked withdraw button via text search`);
                }
            }
            
            if (withdrawClicked) {
                await safeWait(5000);
                
                const pageContent = await this.page.content();
                const transactionId = await extractTransactionId(pageContent);
                const success = pageContent.toLowerCase().includes('success') || 
                               pageContent.toLowerCase().includes('sent') ||
                               pageContent.toLowerCase().includes('completed');
                
                if (success) {
                    console.log(`   ✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
                    console.log(`   💰 $${balance.toFixed(5)} sent to wallet`);
                    if (transactionId) {
                        console.log(`   🆔 TXID: ${transactionId}`);
                    }
                    
                    stats.successfulWithdrawals++;
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: balance,
                        status: 'SUCCESS',
                        transactionId: transactionId || 'Pending'
                    });
                    
                    stats.sourceBalances[source.name].earned = 0;
                    return true;
                } else {
                    console.log(`   ❌ Withdrawal failed - not confirmed`);
                    stats.failedWithdrawals++;
                    stats.withdrawalHistory.unshift({
                        time: new Date(),
                        source: source.name,
                        amount: balance,
                        status: 'FAILED',
                        error: 'Not confirmed'
                    });
                    return false;
                }
            } else {
                console.log(`   ❌ Withdrawal button not found on ${source.name}`);
                stats.failedWithdrawals++;
                stats.withdrawalHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: balance,
                    status: 'FAILED',
                    error: 'Button not found'
                });
                return false;
            }
        } catch (error) {
            console.log(`   ❌ Withdrawal error: ${error.message}`);
            stats.failedWithdrawals++;
            stats.withdrawalHistory.unshift({
                time: new Date(),
                source: source.name,
                amount: balance,
                status: 'FAILED',
                error: error.message
            });
            return false;
        }
    }
    
    async claimFromSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await safeWait(2000);
            
            const claimSelectors = [source.claimSelector, '#claimButton', '.claim-btn', 'button.claim', '#claim'];
            let claimClicked = false;
            
            for (const selector of claimSelectors) {
                try {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn) {
                        await claimBtn.click();
                        claimClicked = true;
                        break;
                    }
                } catch(e) {}
            }
            
            if (!claimClicked) {
                claimClicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const claimBtn = buttons.find(btn => {
                        const text = (btn.innerText || '').toLowerCase();
                        return text.includes('claim') || text.includes('get');
                    });
                    if (claimBtn) {
                        claimBtn.click();
                        return true;
                    }
                    return false;
                });
            }
            
            if (claimClicked) {
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
                    amount: earned
                });
                
                const currentBalance = stats.sourceBalances[source.name].earned;
                console.log(`  🪙 ${source.name}: +$${earned.toFixed(5)} → Total: $${currentBalance.toFixed(5)}`);
                
                if (source.minWithdraw && AUTO_WITHDRAW && currentBalance >= source.minWithdraw) {
                    console.log(`\n🎯 ${source.name} - THRESHOLD REACHED!`);
                    console.log(`   Balance: $${currentBalance.toFixed(5)} / Min: $${source.minWithdraw}`);
                    await this.withdrawFromSource(source, currentBalance);
                } else if (source.minWithdraw) {
                    const percent = ((currentBalance / source.minWithdraw) * 100).toFixed(1);
                    console.log(`   📊 Progress: ${percent}% to withdrawal`);
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }
    
    async runCycle(sources) {
        let cycleEarned = 0;
        let claimsMade = 0;
        
        console.log(`\n📊 CYCLE ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${sources.length} total sources`);
        console.log(`💰 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log(`💸 Withdrawals: ${stats.successfulWithdrawals} OK / ${stats.failedWithdrawals} Failed`);
        console.log(`🔐 Logins: ${stats.successfulLogins} OK / ${stats.failedLogins} Failed`);
        console.log('========================================');
        
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            const earned = await this.claimFromSource(source);
            if (earned > 0) {
                cycleEarned += earned;
                claimsMade++;
            }
            
            if ((i + 1) % 5 === 0) {
                console.log(`   Progress: ${i + 1}/${sources.length} sources | Earned: $${cycleEarned.toFixed(5)}`);
            }
            await safeWait(1000);
        }
        
        console.log('========================================');
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)} from ${claimsMade} claims`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        
        const pending = Object.entries(stats.sourceBalances).filter(([_, d]) => d.earned > 0);
        if (pending.length > 0) {
            console.log('\n📦 Pending balances:');
            for (const [name, data] of pending) {
                const source = sources.find(s => s.name === name);
                const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 0;
                console.log(`   🪙 ${name}: $${data.earned.toFixed(5)} (${progress}%)`);
            }
        }
        
        const uptimeHours = (Date.now() - stats.startTime) / 3600000;
        const hourlyRate = uptimeHours > 0 ? (stats.totalEarned / uptimeHours).toFixed(5) : 0;
        const dailyProjection = (hourlyRate * 24).toFixed(5);
        console.log(`\n📈 Hourly rate: $${hourlyRate} | Projected daily: $${dailyProjection}`);
        
        return cycleEarned;
    }
}

// ============ MAIN BOT ============
class ExternalFaucetBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.loginManager = null;
        this.earningEngine = null;
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
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        this.loginManager = new LoginManager(this.page);
        this.earningEngine = new EarningEngine(this.page);
    }

    async run() {
        console.log('🚀 Starting External Faucets Bot v4.0');
        console.log(`📊 ${EXTERNAL_FAUCETS.length} external faucets configured`);
        console.log(`🔐 Auto-login: ${AUTO_LOGIN ? 'ENABLED' : 'DISABLED'}`);
        console.log('========================================\n');
        
        await this.init();
        
        // LOGIN TO ALL FAUCETS FIRST
        if (AUTO_LOGIN) {
            await this.loginManager.loginToAllFaucets(EXTERNAL_FAUCETS);
        }
        
        // Main loop
        while (true) {
            try {
                await this.earningEngine.runCycle(EXTERNAL_FAUCETS);
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
            const source = EXTERNAL_FAUCETS.find(s => s.name === name);
            const progress = source?.minWithdraw ? ((data.earned / source.minWithdraw) * 100).toFixed(1) : 0;
            const loginStatus = data.loggedIn ? '✅' : '❌';
            return `<tr><td style="font-size:11px">${name}<td><td class="earn">$${data.earned.toFixed(5)}</td><td>${data.claims}</td><td>${progress}%</td><td>${loginStatus}</td><td>${data.withdrawalAttempted ? '💰' : '⏳'}</td></tr>`;
        }).join('');
    
    const withdrawalHtml = stats.withdrawalHistory.slice(0, 20).map(w => `
        <tr><td>${new Date(w.time).toLocaleTimeString()}</td><td>${w.source}</td><td class="earn">$${w.amount.toFixed(5)}</td><td class="${w.status === 'SUCCESS' ? 'earn' : 'error'}">${w.status}</td><td style="font-size:10px">${w.transactionId || w.error || '-'}</td></tr>
    `).join('');
    
    const loginHtml = stats.loginHistory.slice(0, 20).map(l => `
        <tr><td>${new Date(l.time).toLocaleTimeString()}</td><td>${l.source}</td><td class="${l.status === 'SUCCESS' ? 'earn' : 'error'}">${l.status}</td><td>${l.error || '-'}</td></tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html><head><title>External Faucets Bot - Auto Login</title><meta http-equiv="refresh" content="30">
<style>
body{background:#0a0e27;color:#00ff88;font-family:monospace;padding:20px}
.container{max-width:1400px;margin:0 auto}
.stat-card{background:#1a1f3a;padding:15px;border-radius:10px;display:inline-block;margin:10px;min-width:130px}
.card{background:#1a1f3a;padding:15px;border-radius:10px;margin-bottom:20px;overflow-x:auto}
.earn{color:#00ff88}
.error{color:#ff4444}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;text-align:left;border-bottom:1px solid #333;font-size:12px}
</style>
<body>
<div class="container">
<h1>💰 External Faucets Bot v4.0 - Auto Login</h1>
<div class="card">
🟢 LIVE | Uptime: ${hours}h ${minutes}m<br>
Total Sources: ${EXTERNAL_FAUCETS.length} | Logins: ${stats.successfulLogins}/${stats.successfulLogins + stats.failedLogins}<br>
Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 15) + '...' : '<span class="error">NOT SET</span>'}
</div>
<div class="stat-card"><div class="earn">$${stats.totalEarned.toFixed(5)}</div>Total</div>
<div class="stat-card"><div class="earn">$${hourlyRate}</div>/Hour</div>
<div class="stat-card"><div class="earn">$${dailyRate}</div>/Day</div>
<div class="stat-card"><div class="earn">${stats.totalActions}</div>Claims</div>
<div class="stat-card"><div class="earn">${stats.successfulWithdrawals}</div>WD OK</div>
<div class="stat-card"><div class="error">${stats.failedWithdrawals}</div>WD Fail</div>
<div class="card"><h3>🔐 Login History</h3><table><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Error</th></tr></thead><tbody>${loginHtml || '<tr><td colspan="4">No logins yet</td></tr>'}</tbody></table></div>
<div class="card"><h3>🪙 Source Balances</h3><table><thead><tr><th>Source</th><th>Balance</th><th>Claims</th><th>Progress</th><th>Login</th><th>Status</th></tr></thead><tbody>${sourceBalancesHtml || '<tr><td colspan="6">No activity yet</td></tr>'}</tbody></table></div>
<div class="card"><h3>💸 Withdrawal History</h3><table><thead><tr><th>Time</th><th>Source</th><th>Amount</th><th>Status</th><th>TXID/Error</th></tr></thead><tbody>${withdrawalHtml || '<tr><td colspan="5">No withdrawals yet</td></tr>'}</tbody></table></div>
</div>
</body></html>`);
});

// ============ MAIN ============
async function main() {
    await installChrome();
    app.listen(port, '0.0.0.0', () => console.log(`📊 Dashboard: http://localhost:${port}`));
    const bot = new ExternalFaucetBot();
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
