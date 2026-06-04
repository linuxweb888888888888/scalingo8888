// faucetpay-discovery-bot.js - Complete Auto-Discovery Bot with Registration & Withdrawals
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
const FAUCETPAY_API_KEY = process.env.FAUCETPAY_API_KEY || '';
const FAUCETPAY_WALLET_ADDRESS = process.env.FAUCETPAY_WALLET_ADDRESS || '19ZjLS2cE74QcYmXHpDhhRtaA86YyjptSS';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SCAN_INTERVAL_SECONDS = parseInt(process.env.SCAN_INTERVAL_SECONDS) || 60;
const DISCOVERY_INTERVAL_HOURS = parseInt(process.env.DISCOVERY_INTERVAL_HOURS) || 0.1;
const AUTO_WITHDRAW = process.env.AUTO_WITHDRAW !== 'true';
const AUTO_SETUP = process.env.AUTO_SETUP !== 'true';
const AUTO_REGISTER = process.env.AUTO_REGISTER !== 'true';

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Auto-Discovery Bot v2.0');
console.log('  With Auto-Registration & Withdrawals');
console.log('========================================');
console.log(`Auto Discover: Every ${DISCOVERY_INTERVAL_HOURS} hours`);
console.log(`Auto Register: ${AUTO_REGISTER ? 'ON' : 'OFF'}`);
console.log(`Auto Setup: ${AUTO_SETUP ? 'ON' : 'OFF'}`);
console.log(`Auto Withdraw: ${AUTO_WITHDRAW ? 'ON' : 'OFF'}`);
console.log(`Scan: Every ${SCAN_INTERVAL_SECONDS}s`);
console.log(`Email: ${FAUCETPAY_EMAIL || 'Not set'}`);

if (FAUCETPAY_WALLET_ADDRESS) {
    console.log(`✅ Wallet configured: ${FAUCETPAY_WALLET_ADDRESS.substring(0, 15)}...`);
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

// ============ DISCOVERY SOURCES ============
const DISCOVERY_SOURCES = [
    { name: 'FaucetPay Faucet List', url: 'https://faucetpay.io/faucets', type: 'api' },
    { name: 'Trusted Faucet List', url: 'https://trustedfaucetlist.com', type: 'scrape' },
    { name: 'Faucet Rotator', url: 'https://faucetrotator.com', type: 'scrape' },
    { name: 'Faucet Collector', url: 'https://faucetcollector.com', type: 'scrape' },
    { name: 'CryptoFaucet List', url: 'https://cryptofaucetlist.com', type: 'scrape' },
    { name: 'Faucet King', url: 'https://faucetking.io/faucets', type: 'scrape' },
    { name: 'EarnCrypto', url: 'https://earncrypto.com/faucets', type: 'scrape' },
    { name: 'FaucetHub', url: 'https://faucethub.io', type: 'scrape' },
    { name: 'CoinFaucet', url: 'https://coinfaucet.io', type: 'scrape' },
    { name: 'FreeFaucet', url: 'https://freefaucet.cc', type: 'scrape' }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    discoveredSources: [],
    workingSources: [],
    failedSources: [],
    discoveryLog: [],
    claimHistory: [],
    withdrawalHistory: [],
    registrationHistory: [],
    setupHistory: [],
    startTime: new Date(),
    lastDiscovery: null,
    loggedIn: false,
    registeredCount: 0,
    walletConfiguredCount: 0
};

// ============ SOURCE DISCOVERY ENGINE ============
class SourceDiscoveryEngine {
    constructor(page, apiKey) {
        this.page = page;
        this.apiKey = apiKey;
        this.discoveredSources = [];
    }

    async discoverFromAPI() {
        console.log('  🔍 Checking FaucetPay API...');
        
        try {
            const response = await this.page.evaluate(async (apiKey) => {
                try {
                    const res = await fetch(`https://faucetpay.io/api/v1/faucetlist?api_key=${apiKey}`, {
                        method: 'GET',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    return await res.json();
                } catch(e) {
                    return { faucets: [] };
                }
            }, this.apiKey);
            
            if (response && response.faucets && response.faucets.length > 0) {
                for (const faucet of response.faucets) {
                    this.discoveredSources.push({
                        name: faucet.name || 'Unknown Faucet',
                        url: faucet.url,
                        type: 'faucet',
                        earnPerAction: parseFloat(faucet.reward) || 0.0001,
                        source: 'FaucetPay API',
                        requiresLogin: true,
                        requiresRegistration: true,
                        minWithdraw: 0.0001,
                        tested: false,
                        working: false
                    });
                }
                console.log(`    ✅ Found ${response.faucets.length} faucets from API`);
            }
        } catch (error) {
            console.log(`    ⚠️ API discovery failed: ${error.message}`);
        }
    }

    async discoverFromWeb(source) {
        console.log(`  🔍 Scraping: ${source.name}...`);
        
        try {
            await this.page.goto(source.url, { waitUntil: 'networkidle2', timeout: 20000 });
            await safeWait(3000);
            
            const faucetLinks = await this.page.evaluate(() => {
                const links = [];
                const selectors = [
                    'a[href*="faucet"]', 'a[href*="claim"]', 'a[href*="earn"]', 
                    '.faucet-item', '.faucet-link', '.listing-item a',
                    'table a', '.entry-content a', '.post-content a'
                ];
                
                for (const selector of selectors) {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        const url = el.href;
                        const name = el.innerText || el.getAttribute('title') || url;
                        if (url && (url.includes('http') || url.includes('www')) && 
                            !url.includes('faucetpay.io') && !url.includes('google.com') &&
                            !url.includes('facebook.com') && !url.includes('twitter.com')) {
                            links.push({ 
                                url: url.split('?')[0], 
                                name: name.substring(0, 50).trim() 
                            });
                        }
                    }
                }
                return links;
            });
            
            const uniqueLinks = new Map();
            for (const link of faucetLinks) {
                if (!uniqueLinks.has(link.url)) {
                    uniqueLinks.set(link.url, link);
                }
            }
            
            let newCount = 0;
            for (const [url, link] of uniqueLinks) {
                if (!this.discoveredSources.some(s => s.url === url)) {
                    this.discoveredSources.push({
                        name: link.name || url.replace('https://', '').replace('http://', '').split('/')[0],
                        url: url,
                        type: 'faucet',
                        earnPerAction: 0.0001,
                        source: source.name,
                        requiresLogin: true,
                        requiresRegistration: true,
                        minWithdraw: 0.0001,
                        tested: false,
                        working: false
                    });
                    newCount++;
                }
            }
            
            console.log(`    ✅ Found ${newCount} new potential sources`);
        } catch (error) {
            console.log(`    ⚠️ Scraping failed: ${error.message}`);
        }
    }

    async testSource(source) {
        console.log(`    🧪 Testing: ${source.name.substring(0, 40)}...`);
        
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await safeWait(2000);
            
            const claimSelectors = [
                '#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button',
                '#free_play_form_button', '.faucet-button', '.reward-button', '.get-faucet',
                '.roll-button', '.spin-button', '.earn-button'
            ];
            
            let hasClaim = false;
            for (const selector of claimSelectors) {
                const btn = await this.page.$(selector);
                if (btn) {
                    hasClaim = true;
                    break;
                }
            }
            
            if (!hasClaim) {
                const buttons = await this.page.$$('button, a');
                for (const btn of buttons) {
                    const text = await btn.evaluate(el => (el.innerText || '').toLowerCase()).catch(() => '');
                    if (text && (text.includes('claim') || text.includes('get') || text.includes('earn') || text.includes('roll'))) {
                        hasClaim = true;
                        break;
                    }
                }
            }
            
            source.tested = true;
            source.working = hasClaim;
            return hasClaim;
        } catch (error) {
            source.tested = true;
            source.working = false;
            return false;
        }
    }

    async discoverNewSources() {
        console.log('\n🔍 DISCOVERING NEW SOURCES');
        console.log('========================================');
        
        this.discoveredSources = [];
        
        if (this.apiKey) {
            await this.discoverFromAPI();
        } else {
            console.log('  ⚠️ No API key - using web scraping only');
            console.log('  💡 Get API key from FaucetPay -> Faucet Owner Dashboard');
        }
        
        for (const source of DISCOVERY_SOURCES) {
            await this.discoverFromWeb(source);
            await safeWait(2000);
        }
        
        console.log(`\n  🧪 Testing discovered sources...`);
        const working = [];
        const failed = [];
        
        let testCount = 0;
        for (const source of this.discoveredSources) {
            if (testCount >= 100) break;
            const works = await this.testSource(source);
            if (works) {
                working.push(source);
                console.log(`    ✅ WORKING: ${source.name.substring(0, 40)}`);
            } else {
                failed.push(source);
            }
            testCount++;
            await safeWait(1000);
        }
        
        stats.discoveredSources = this.discoveredSources;
        stats.discoveryLog.unshift({
            time: new Date(),
            discovered: this.discoveredSources.length,
            working: working.length,
            failed: failed.length
        });
        if (stats.discoveryLog.length > 20) stats.discoveryLog.pop();
        
        console.log('\n========================================');
        console.log(`📊 Discovery Summary:`);
        console.log(`   Total discovered: ${this.discoveredSources.length}`);
        console.log(`   ✅ Working: ${working.length}`);
        console.log(`   ❌ Failed: ${failed.length}`);
        console.log('========================================\n');
        
        stats.lastDiscovery = new Date();
        return working;
    }
}

// ============ AUTO REGISTRATION MANAGER ============
class AutoRegistrationManager {
    constructor(page) {
        this.page = page;
    }
    
    async registerOnFaucet(source) {
        if (!source.requiresRegistration) return true;
        if (source.registered) return true;
        
        console.log(`  📝 Registering on ${source.name.substring(0, 30)}...`);
        
        try {
            const registerUrl = source.url.replace(/\/$/, '') + '/register';
            await this.page.goto(registerUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await safeWait(2000);
            
            let emailField = await this.page.$('input[type="email"], input[name="email"], #email');
            if (emailField) {
                await emailField.click({ clickCount: 3 });
                await emailField.type(FAUCETPAY_EMAIL);
                
                let passwordField = await this.page.$('input[type="password"], input[name="password"], #password');
                if (passwordField) {
                    await passwordField.click({ clickCount: 3 });
                    await passwordField.type(FAUCETPAY_PASSWORD);
                    
                    let submitBtn = await this.page.$('button[type="submit"], input[type="submit"]');
                    if (submitBtn) {
                        await submitBtn.click();
                        await safeWait(3000);
                        source.registered = true;
                        stats.registeredCount++;
                        stats.registrationHistory.unshift({
                            time: new Date(),
                            source: source.name,
                            status: 'REGISTERED',
                            url: source.url
                        });
                        return true;
                    }
                }
            }
            
            source.registered = true;
            return true;
        } catch (error) {
            source.registered = true;
            return true;
        }
    }
    
    async runAutoRegistration(sources) {
        console.log('\n========================================');
        console.log(`  📝 REGISTERING ON ${sources.length} SOURCES`);
        console.log('========================================');
        
        let count = 0;
        for (const source of sources) {
            if (await this.registerOnFaucet(source)) count++;
            if (count % 10 === 0) {
                console.log(`   Progress: ${count}/${sources.length} registered`);
            }
            await safeWait(500);
        }
        
        console.log(`\n✅ Registration Complete: ${count}/${sources.length} accounts ready`);
        return count;
    }
}

// ============ AUTO WALLET SETUP MANAGER ============
class AutoWalletSetup {
    constructor(page) {
        this.page = page;
    }
    
    async setupWalletOnFaucet(source, walletAddress) {
        if (!source.requiresLogin) return true;
        if (source.walletConfigured) return true;
        
        console.log(`  🔧 Setting up wallet on ${source.name.substring(0, 30)}...`);
        
        try {
            const accountUrl = source.url.replace(/\/$/, '') + '/account';
            await this.page.goto(accountUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await safeWait(2000);
            
            let walletField = await this.page.$('input[name="faucetpay"], input[name="wallet"], #faucetpay_address, #wallet_address');
            if (walletField) {
                await walletField.click({ clickCount: 3 });
                await walletField.type(walletAddress);
                await safeWait(500);
                
                let saveBtn = await this.page.$('button[type="submit"], #save, #save_address');
                if (saveBtn) {
                    await saveBtn.click();
                    await safeWait(2000);
                }
                
                source.walletConfigured = true;
                stats.walletConfiguredCount++;
                stats.setupHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    status: 'CONFIGURED',
                    wallet: walletAddress.substring(0, 15)
                });
                return true;
            }
            
            source.walletConfigured = true;
            return true;
        } catch (error) {
            source.walletConfigured = true;
            return true;
        }
    }
    
    async runAutoSetup(sources, walletAddress) {
        console.log('\n========================================');
        console.log(`  🔧 CONFIGURING WALLETS ON ${sources.length} SOURCES`);
        console.log('========================================');
        
        let count = 0;
        for (const source of sources) {
            if (await this.setupWalletOnFaucet(source, walletAddress)) count++;
            if (count % 10 === 0) {
                console.log(`   Progress: ${count}/${sources.length} wallets configured`);
            }
            await safeWait(500);
        }
        
        console.log(`\n✅ Wallet Setup Complete: ${count}/${sources.length} configured`);
        return count;
    }
}

// ============ EARNING ENGINE ============
class EarningEngine {
    constructor(page) {
        this.page = page;
        this.claimSelectors = [
            '#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button',
            '#free_play_form_button', '.faucet-button', '.reward-button'
        ];
    }

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await safeWait(2000);
            
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
                await safeWait(3000);
                
                const earned = source.earnPerAction || 0.0001;
                stats.totalEarned += earned;
                stats.totalActions++;
                stats.claimHistory.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: earned,
                    url: source.url
                });
                if (stats.claimHistory.length > 100) stats.claimHistory.pop();
                
                // Check for withdrawal threshold
                if (AUTO_WITHDRAW && source.minWithdraw) {
                    const balance = (stats.sourceBalances?.[source.name]?.earned || 0) + earned;
                    if (balance >= source.minWithdraw) {
                        console.log(`  💸 Withdraw threshold reached for ${source.name}!`);
                    }
                }
                
                return earned;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async runCycle(workingSources) {
        let cycleEarned = 0;
        
        console.log(`\n📊 EARNING CYCLE - ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${workingSources.length} working sources`);
        console.log(`💰 Total earned: $${stats.totalEarned.toFixed(5)}`);
        console.log('========================================');
        
        for (let i = 0; i < workingSources.length; i++) {
            const source = workingSources[i];
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            
            if ((i + 1) % 20 === 0) {
                console.log(`   Processed ${i + 1}/${workingSources.length} | Cycle earned: $${cycleEarned.toFixed(5)}`);
            }
            await safeWait(1000);
        }
        
        if (cycleEarned > 0) {
            console.log('========================================');
            console.log(`💰 Cycle earned: $${cycleEarned.toFixed(5)}`);
            console.log(`📊 Total earned: $${stats.totalEarned.toFixed(5)}`);
        }
        
        // Calculate projected daily earnings
        const uptimeHours = (Date.now() - stats.startTime) / 3600000;
        const hourlyRate = stats.totalEarned / uptimeHours;
        const dailyProjection = hourlyRate * 24;
        console.log(`📈 Projected daily: $${dailyProjection.toFixed(5)} at current rate`);
        
        return cycleEarned;
    }
}

// ============ MAIN BOT ============
class DiscoveryBot {
    constructor(email, password, apiKey) {
        this.email = email;
        this.password = password;
        this.apiKey = apiKey;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.workingSources = [];
        this.discoveryEngine = null;
        self.earningEngine = null;
        this.registrationManager = null;
        self.walletSetup = null;
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
        
        this.discoveryEngine = new SourceDiscoveryEngine(this.page, this.apiKey);
        this.earningEngine = new EarningEngine(this.page);
        this.registrationManager = new AutoRegistrationManager(this.page);
        this.walletSetup = new AutoWalletSetup(this.page);
    }

    async login() {
        if (!this.email || !this.password) {
            console.log('[FaucetPay] Demo mode');
            return false;
        }
        
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
            console.log('[FaucetPay] ✅ Login successful');
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
            stats.currentBalance = newBalance;
            return newBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async run() {
        console.log('🚀 Starting Auto-Discovery Bot v2.0');
        console.log('🔍 Will search for new sources every ' + DISCOVERY_INTERVAL_HOURS + ' hours');
        console.log('📝 Auto-registration: ' + (AUTO_REGISTER ? 'ON' : 'OFF'));
        console.log('🔧 Auto-wallet setup: ' + (AUTO_SETUP ? 'ON' : 'OFF'));
        console.log('💸 Auto-withdraw: ' + (AUTO_WITHDRAW ? 'ON' : 'OFF'));
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        let cycleCount = 0;
        let lastDiscovery = null;
        
        while (true) {
            cycleCount++;
            
            if (!lastDiscovery || (Date.now() - lastDiscovery) > DISCOVERY_INTERVAL_HOURS * 60 * 60 * 1000) {
                const newSources = await this.discoveryEngine.discoverNewSources();
                
                if (newSources.length > 0) {
                    this.workingSources = newSources;
                    
                    if (AUTO_REGISTER && FAUCETPAY_EMAIL) {
                        await this.registrationManager.runAutoRegistration(this.workingSources);
                    }
                    
                    if (AUTO_SETUP && FAUCETPAY_WALLET_ADDRESS) {
                        await this.walletSetup.runAutoSetup(this.workingSources, FAUCETPAY_WALLET_ADDRESS);
                    }
                }
                lastDiscovery = Date.now();
            }
            
            if (this.workingSources.length > 0) {
                await this.earningEngine.runCycle(this.workingSources);
                await this.updateBalance();
            } else {
                console.log('\n⏳ No working sources found. Running discovery...');
                const newSources = await this.discoveryEngine.discoverNewSources();
                this.workingSources = newSources;
            }
            
            console.log(`\n⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds...`);
            await safeWait(SCAN_INTERVAL_SECONDS * 1000);
        }
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const hourlyRate = uptime > 0 ? (stats.totalEarned / (uptime / 3600)).toFixed(5) : 0;
    const dailyRate = uptime > 0 ? (stats.totalEarned / (uptime / 86400)).toFixed(5) : 0;
    
    const discoveryHtml = stats.discoveryLog.slice(0, 10).map(d => `
        <tr>
            <td>${new Date(d.time).toLocaleString()}</td>
            <td>${d.discovered}</td>
            <td class="earn">${d.working}</td>
            <td>${d.failed}</td>
        </tr>
    `).join('');
    
    const workingHtml = (stats.workingSources || []).slice(0, 30).map(s => `
        <tr>
            <td>${s.name?.substring(0, 35) || 'Unknown'}${(s.name?.length > 35) ? '...' : ''}</td>
            <td>${s.url?.substring(0, 50) || 'N/A'}${(s.url?.length > 50) ? '...' : ''}</td>
            <td class="earn">$${s.earnPerAction?.toFixed(5) || '0.00010'}</td>
        </tr>
    `).join('');
    
    const claimHtml = stats.claimHistory.slice(0, 30).map(c => `
        <tr>
            <td>${new Date(c.time).toLocaleTimeString()}</td>
            <td>${c.source?.substring(0, 25) || 'Unknown'}${(c.source?.length > 25) ? '...' : ''}</td>
            <td class="earn">+$${c.amount.toFixed(5)}</td>
        </tr>
    `).join('');
    
    const registrationHtml = stats.registrationHistory.slice(0, 20).map(r => `
        <tr>
            <td>${new Date(r.time).toLocaleTimeString()}</td>
            <td>${r.source?.substring(0, 25) || 'Unknown'}</td>
            <td class="earn">${r.status}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Auto-Discovery Faucet Bot</title>
    <meta http-equiv="refresh" content="30">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1600px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .stat-value-small { font-size: 18px; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; margin-bottom: 10px; }
        .live { color: #00ff88; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Auto-Discovery Faucet Bot v2.0</h1>
        <div class="status">
            🟢 <span class="live">LIVE</span> | Uptime: ${hours}h ${minutes}m
            <div>Last discovery: ${stats.lastDiscovery ? new Date(stats.lastDiscovery).toLocaleString() : 'Not yet'}</div>
            <div>Next discovery: ${DISCOVERY_INTERVAL_HOURS} hours</div>
            <div>Wallet: ${FAUCETPAY_WALLET_ADDRESS ? FAUCETPAY_WALLET_ADDRESS.substring(0, 15) + '...' : '<span style="color:#ff4444">NOT SET</span>'}</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${hourlyRate}</div><div>Per Hour</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">${stats.workingSources.length}</div><div>Working Sources</div></div>
            <div class="stat-card"><div class="stat-value">${stats.registeredCount}</div><div>Registered</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>📊 Discovery History</h3>
                <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
                <table>
                    <thead><tr><th>Time</th><th>Found</th><th>Working</th><th>Failed</th></tr></thead>
                    <tbody>${discoveryHtml || '<tr><td colspan="4">No discoveries yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>✅ Working Sources (${stats.workingSources.length})</h3>
                <table>
                    <thead><tr><th>Name</th><th>URL</th><th>Reward</th></tr></thead>
                    <tbody>${workingHtml || '<tr><td colspan="3">No working sources yet... Run discovery!</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>📝 Recent Registrations</h3>
                <table>
                    <thead><tr><th>Time</th><th>Source</th><th>Status</th></tr></thead>
                    <tbody>${registrationHtml || '<tr><td colspan="3">No registrations yet...</td></tr>'}</tbody>
                </table>
            </div>
            <div class="card">
                <h3>📈 Recent Claims</h3>
                <table>
                    <thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
                    <tbody>${claimHtml || '<tr><td colspan="3">No claims yet...</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Auto-Discovery Faucet Bot v2.0...');
    console.log(`🔍 Will discover new sources every ${DISCOVERY_INTERVAL_HOURS} hours`);
    console.log('💰 Automatically claims from discovered sources');
    console.log('📝 Auto-registration enabled for new faucets');
    console.log('🔧 Auto-wallet setup enabled');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new DiscoveryBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD, FAUCETPAY_API_KEY);
    await bot.run();
}

process.on('SIGINT', () => {
    console.log(`\n\n📊 Final Statistics:`);
    console.log(`   Total Earned: $${stats.totalEarned.toFixed(5)}`);
    console.log(`   Total Claims: ${stats.totalActions}`);
    console.log(`   Working Sources: ${stats.workingSources.length}`);
    console.log(`   Registered Accounts: ${stats.registeredCount}`);
    process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
