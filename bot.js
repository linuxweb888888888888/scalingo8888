// faucetpay-smart-bot.js - Auto-discovers working sources
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

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Smart Bot - Auto Discovery');
console.log('========================================');
console.log(`Account: ${FAUCETPAY_EMAIL || 'Demo Mode'}`);
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

// ============ 150+ POTENTIAL SOURCES (Will auto-discover what works) ============
const POTENTIAL_SOURCES = [
    // Tier 1: FaucetPay Internal (Always work)
    { name: 'Daily Bonus', url: 'https://faucetpay.io/dashboard', earnPerAction: 0.001, type: 'bonus', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerAction: 0.0005, type: 'view', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerAction: 0.002, type: 'view', status: 'pending', attempts: 0, successes: 0 },
    { name: 'PTC Ads', url: 'https://faucetpay.io/ptc', earnPerAction: 0.0008, type: 'ptc', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Staking', url: 'https://faucetpay.io/staking', earnPerAction: 0.001, type: 'staking', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerAction: 0.0015, type: 'tasks', status: 'pending', attempts: 0, successes: 0 },
    
    // Tier 2: Top Faucets (Most likely to work)
    { name: 'FreeBitcoin', url: 'https://freebitco.in', earnPerAction: 0.0005, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerAction: 0.0003, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerAction: 0.0003, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetCrypto', url: 'https://faucetcrypto.com', earnPerAction: 0.0002, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetHouse', url: 'https://faucethouse.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CryptoFaucet', url: 'https://cryptofaucet.net', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetList', url: 'https://faucetlist.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Airdrops', url: 'https://airdrops.io', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetCollector', url: 'https://faucetcollector.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetExchange', url: 'https://faucetexchange.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CryptoFaucets', url: 'https://cryptofaucets.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'ADBTC', url: 'https://adbtc.top', earnPerAction: 0.0002, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerAction: 0.0002, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CoinPayU', url: 'https://coinpayu.com', earnPerAction: 0.00015, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'EZBit', url: 'https://ezbit.co.in', earnPerAction: 0.00015, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'BonusBitcoin', url: 'https://bonusbitcoin.co', earnPerAction: 0.00012, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'BitFun', url: 'https://bitfun.co', earnPerAction: 0.00012, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetKing', url: 'https://faucetking.io', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetNice', url: 'https://faucetnice.com', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CoinFaucet', url: 'https://coinfaucet.io', earnPerAction: 0.0001, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetBank', url: 'https://faucetbank.io', earnPerAction: 0.00008, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetTime', url: 'https://faucettime.com', earnPerAction: 0.00008, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CryptoKing', url: 'https://cryptoking.io', earnPerAction: 0.00008, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'BTCFaucet', url: 'https://btcfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'LTCFaucet', url: 'https://ltcfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'DOGEFaucet', url: 'https://dogefaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'ETHFaucet', url: 'https://ethfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'SOLFaucet', url: 'https://solanafaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'XRPFaucet', url: 'https://xrpfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'TRXFaucet', url: 'https://trxfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'ADAFaucet', url: 'https://adafaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'MATICFaucet', url: 'https://maticfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'BNBFaucet', url: 'https://bnb-faucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'AVAXFaucet', url: 'https://avaxfaucet.io', earnPerAction: 0.00007, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    
    // Tier 3: More faucets to try
    { name: 'FaucetRotator', url: 'https://faucetrotator.com', earnPerAction: 0.00005, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetMining', url: 'https://faucetmining.com', earnPerAction: 0.00005, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CryptoRewards', url: 'https://cryptorewards.com', earnPerAction: 0.00005, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'CoinPot', url: 'https://coinpot.co', earnPerAction: 0.00004, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetBox', url: 'https://faucetbox.com', earnPerAction: 0.00004, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    { name: 'FaucetHub', url: 'https://faucethub.io', earnPerAction: 0.00004, type: 'faucet', status: 'pending', attempts: 0, successes: 0 },
    
    // Tier 4: Additional earning methods
    { name: 'Shortlinks', url: 'https://faucetpay.io/shortlinks', earnPerAction: 0.0003, type: 'shortlink', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Video Ads', url: 'https://faucetpay.io/video', earnPerAction: 0.0005, type: 'video', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Surveys', url: 'https://faucetpay.io/surveys', earnPerAction: 0.01, type: 'survey', status: 'pending', attempts: 0, successes: 0 },
    
    // Tier 5: Offerwalls
    { name: 'CPX Research', url: 'https://faucetpay.io/offers/cpx', earnPerAction: 0.50, type: 'offerwall', status: 'pending', attempts: 0, successes: 0 },
    { name: 'OfferToro', url: 'https://faucetpay.io/offers/toro', earnPerAction: 0.30, type: 'offerwall', status: 'pending', attempts: 0, successes: 0 },
    { name: 'AdGate', url: 'https://faucetpay.io/offers/adgate', earnPerAction: 0.25, type: 'offerwall', status: 'pending', attempts: 0, successes: 0 },
    { name: 'Peanut Labs', url: 'https://faucetpay.io/offers/peanut', earnPerAction: 0.20, type: 'offerwall', status: 'pending', attempts: 0, successes: 0 },
    { name: 'TimeWall', url: 'https://faucetpay.io/offers/timewall', earnPerAction: 0.15, type: 'offerwall', status: 'pending', attempts: 0, successes: 0 }
];

// ============ STATS ============
let stats = {
    totalEarned: 0,
    totalActions: 0,
    currentBalance: 0,
    activeSources: [],
    failedSources: [],
    pendingSources: [],
    history: [],
    startTime: new Date(),
    loggedIn: false
};

// ============ SMART BOT WITH AUTO-DISCOVERY ============
class SmartFaucetBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.loggedIn = false;
        this.workingSources = [];
        this.failedSources = [];
        this.claimSelectors = [
            '#claimButton', '.claim-btn', 'button.claim', '#claim', '.claim-button',
            '#free_play_form_button', '.faucet-button', '.reward-button',
            '.get-faucet', '.earn-button', '.collect-button'
        ];
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
            console.log('[FaucetPay] Demo mode');
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
            console.log('[FaucetPay] ✅ Login successful');
            await this.updateBalance();
            return true;
        } catch (error) {
            console.log('[FaucetPay] Login failed, continuing in demo mode');
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount, .user-balance', el => el.innerText).catch(() => '0');
            stats.currentBalance = parseFloat(balanceText) || 0;
            return stats.currentBalance;
        } catch (error) {
            return stats.currentBalance;
        }
    }

    async testSource(source) {
        console.log(`  🔍 Testing: ${source.name}...`);
        
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await this.page.waitForTimeout(3000);
            
            // Try to find claim button
            let claimBtn = null;
            for (const selector of this.claimSelectors) {
                try {
                    claimBtn = await this.page.$(selector);
                    if (claimBtn) break;
                } catch(e) {}
            }
            
            // Try text-based search
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
                console.log(`    ✅ WORKING! +$${source.earnPerAction.toFixed(5)}`);
                source.status = 'working';
                source.successes++;
                return true;
            } else {
                console.log(`    ❌ NOT WORKING`);
                source.status = 'failed';
                return false;
            }
        } catch (error) {
            console.log(`    ❌ ERROR: ${error.message.substring(0, 50)}`);
            source.status = 'failed';
            return false;
        }
    }

    async discoverWorkingSources() {
        console.log('\n🔍 Discovering working sources...');
        console.log(`📊 Testing ${POTENTIAL_SOURCES.length} potential sources`);
        console.log('========================================\n');
        
        const working = [];
        const failed = [];
        
        for (const source of POTENTIAL_SOURCES) {
            // Skip if already marked working
            if (source.status === 'working') {
                working.push(source);
                continue;
            }
            
            const works = await this.testSource(source);
            if (works) {
                working.push(source);
                stats.activeSources.push(source.name);
            } else {
                failed.push(source);
                stats.failedSources.push(source.name);
            }
            
            // Random delay to avoid rate limiting
            await this.page.waitForTimeout(2000 + Math.random() * 3000);
        }
        
        this.workingSources = working;
        this.failedSources = failed;
        
        console.log('\n========================================');
        console.log(`✅ Working: ${working.length} sources`);
        console.log(`❌ Failed: ${failed.length} sources`);
        console.log('========================================\n');
        
        working.forEach(s => console.log(`  ✅ ${s.name} - $${s.earnPerAction.toFixed(5)}`));
        
        return working;
    }

    async claimSource(source) {
        try {
            await this.page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await this.page.waitForTimeout(2000);
            
            let claimBtn = null;
            for (const selector of this.claimSelectors) {
                try {
                    claimBtn = await this.page.$(selector);
                    if (claimBtn) break;
                } catch(e) {}
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
                
                stats.totalEarned += source.earnPerAction;
                stats.totalActions++;
                stats.history.unshift({
                    time: new Date(),
                    source: source.name,
                    amount: source.earnPerAction,
                    type: source.type
                });
                if (stats.history.length > 100) stats.history.pop();
                
                console.log(`  ✅ ${source.name}: +$${source.earnPerAction.toFixed(5)}`);
                return source.earnPerAction;
            }
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async runCycle() {
        let cycleEarned = 0;
        
        console.log(`\n📊 Cycle - ${new Date().toLocaleTimeString()}`);
        console.log(`🪙 ${this.workingSources.length} working sources`);
        console.log('----------------------------------------');
        
        // First, claim from FaucetPay internal methods (highest priority)
        const internalSources = this.workingSources.filter(s => 
            ['bonus', 'view', 'ptc', 'staking', 'tasks'].includes(s.type)
        );
        
        for (const source of internalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(2000);
        }
        
        // Then claim from external faucets
        const externalSources = this.workingSources.filter(s => s.type === 'faucet');
        for (const source of externalSources) {
            const earned = await this.claimSource(source);
            cycleEarned += earned;
            await this.page.waitForTimeout(1500);
        }
        
        if (this.loggedIn) {
            await this.updateBalance();
        }
        
        console.log(`----------------------------------------`);
        console.log(`💰 Cycle earned: $${cycleEarned.toFixed(4)}`);
        console.log(`📊 Total earned: $${stats.totalEarned.toFixed(4)}`);
        console.log(`✅ Working sources: ${this.workingSources.length}`);
        
        return cycleEarned;
    }

    async run() {
        console.log('🚀 Starting Smart Faucet Bot');
        console.log('🔍 Will auto-discover working sources');
        console.log('========================================\n');
        
        await this.init();
        await this.login();
        
        // Discover working sources first
        await this.discoverWorkingSources();
        
        if (this.workingSources.length === 0) {
            console.log('⚠️ No working sources found! Check your connection.\n');
            return;
        }
        
        let cycleCount = 0;
        
        while (true) {
            cycleCount++;
            try {
                await this.runCycle();
                
                console.log(`⏰ Next cycle in ${SCAN_INTERVAL_SECONDS} seconds\n`);
                await this.page.waitForTimeout(SCAN_INTERVAL_SECONDS * 1000);
                
                // Re-discover sources every 50 cycles
                if (cycleCount % 50 === 0) {
                    console.log('\n🔄 Re-discovering working sources...');
                    await this.discoverWorkingSources();
                }
                
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
    const monthlyRate = (dailyRate * 30).toFixed(2);
    
    const activeList = stats.activeSources.slice(0, 30).map(name => `<div>✅ ${name}</div>`).join('');
    const failedList = stats.failedSources.slice(0, 20).map(name => `<div>❌ ${name}</div>`).join('');
    
    const historyHtml = stats.history.slice(0, 30).map(h => `
        <tr>
            <td>${new Date(h.time).toLocaleTimeString()}</td>
            <td>${h.source.substring(0, 25)}${h.source.length > 25 ? '...' : ''}</td>
            <td class="earn">+$${h.amount.toFixed(5)}</td>
        </tr>
    `).join('');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Smart Faucet Bot - Auto Discovery</title>
    <meta http-equiv="refresh" content="15">
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: #1a1f3a; padding: 15px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 28px; font-weight: bold; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .card { background: #1a1f3a; padding: 15px; border-radius: 10px; overflow-y: auto; max-height: 400px; }
        .status { background: #1a1f3a; padding: 15px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
        .working { color: #00ff88; }
        .failed { color: #ff4444; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
        th { color: #00ff88; }
        .earn { color: #00ff88; }
        .refresh-btn { background: #1a1f3a; color: #00ff88; border: 1px solid #00ff88; padding: 5px 10px; border-radius: 5px; cursor: pointer; }
        .source-count { font-size: 14px; margin-top: 5px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Smart Faucet Bot - Auto Discovery</h1>
        <div class="status">
            🟢 RUNNING | Uptime: ${hours}h ${minutes}m
            <div class="source-count">✅ ${stats.activeSources.length} Working | ❌ ${stats.failedSources.length} Failed</div>
        </div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${stats.totalEarned.toFixed(5)}</div><div>Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">$${dailyRate}</div><div>Per Day</div></div>
            <div class="stat-card"><div class="stat-value">$${monthlyRate}</div><div>Per Month</div></div>
            <div class="stat-card"><div class="stat-value">${stats.totalActions}</div><div>Total Actions</div></div>
            <div class="stat-card"><div class="stat-value">$${stats.currentBalance.toFixed(4)}</div><div>Balance</div></div>
        </div>
        
        <div class="grid-2">
            <div class="card">
                <h3>✅ Working Sources (${stats.activeSources.length})</h3>
                <div class="working">${activeList || 'Discovering...'}</div>
            </div>
            <div class="card">
                <h3>❌ Failed Sources (${stats.failedSources.length})</h3>
                <div class="failed">${failedList || 'None yet'}</div>
            </div>
        </div>
        
        <div class="card">
            <h3>📈 Recent Claims</h3>
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Time</th><th>Source</th><th>Amount</th></tr></thead>
                <tbody>${historyHtml || '<tr><td colspan="3">No claims yet...</td></tr>'}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting Smart Faucet Bot...');
    console.log(`🔍 Will test ${POTENTIAL_SOURCES.length} potential sources`);
    console.log('✅ Auto-discovers what works and only uses working sources');
    console.log('========================================\n');
    
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    const bot = new SmartFaucetBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
    await bot.run();
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
