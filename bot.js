// faucetpay-bot.js - Complete FaucetPay Auto Earning Bot with Chrome Installation
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https = require('https');
const { createWriteStream } = require('fs');

// Apply stealth plugin
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || '';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || '';
const MIN_WITHDRAWAL_USD = parseFloat(process.env.MIN_WITHDRAWAL_USD) || 0.10;
const EARNING_GOAL = parseFloat(process.env.EARNING_GOAL) || 10;
const SHOW_DASHBOARD = process.env.SHOW_DASHBOARD !== 'false';
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';

// Chrome paths
const CHROME_PATH = process.env.CHROMIUM_PATH || '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Auto Earning Bot');
console.log('========================================');
console.log(`Email: ${FAUCETPAY_EMAIL || 'Not set (using demo mode)'}`);
console.log(`Min Withdrawal: $${MIN_WITHDRAWAL_USD}`);
console.log(`Daily Goal: $${EARNING_GOAL}`);
console.log(`Dashboard: ${SHOW_DASHBOARD ? 'Enabled' : 'Disabled'}`);
console.log(`Headless: ${HEADLESS_MODE}`);
console.log('========================================\n');

// ============ CHROME INSTALLATION ============
async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish' () => {
                file.close();
                resolve();
            });
        }).on('error', reject);
    });
}

async function installChrome() {
    if (fs.existsSync(CHROME_PATH)) {
        const stats = fs.statSync(CHROME_PATH);
        if (stats.size > 50000000) {
            console.log('[Chrome] Already installed at:', CHROME_PATH);
            return CHROME_PATH;
        }
    }
    
    console.log('[Chrome] Installing Chromium...');
    
    try {
        // Install system dependencies
        console.log('[Chrome] Installing dependencies...');
        execSync('apt-get update -qq 2>/dev/null || true', { stdio: 'inherit' });
        execSync(`apt-get install -y -qq --no-install-recommends \
            ca-certificates \
            fonts-liberation \
            libappindicator3-1 \
            libasound2 \
            libatk-bridge2.0-0 \
            libatk1.0-0 \
            libcups2 \
            libdbus-1-3 \
            libgbm1 \
            libgtk-3-0 \
            libnspr4 \
            libnss3 \
            libx11-xcb1 \
            libxcb1 \
            libxcomposite1 \
            libxdamage1 \
            libxrandr2 \
            xdg-utils \
            wget \
            unzip \
            2>/dev/null || true`, { stdio: 'inherit' });
        
        // Download Chrome
        const zipPath = '/tmp/chromium.zip';
        console.log('[Chrome] Downloading...');
        await downloadFile(CHROME_URL, zipPath);
        
        // Extract
        console.log('[Chrome] Extracting...');
        execSync(`unzip -q ${zipPath} -d /app/`, { stdio: 'inherit' });
        
        // Verify
        if (fs.existsSync(CHROME_PATH)) {
            fs.chmodSync(CHROME_PATH, 0o755);
            fs.unlinkSync(zipPath);
            console.log('[Chrome] ✅ Installed successfully');
            return CHROME_PATH;
        }
        throw new Error('Chrome binary not found');
        
    } catch (error) {
        console.error('[Chrome] Installation failed:', error.message);
        return null;
    }
}

function getChromeLaunchOptions() {
    return {
        headless: HEADLESS_MODE,
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-webgl',
            '--disable-accelerated-2d-canvas'
        ]
    };
}

// ============ MEMORY STORAGE ============
let totalEarned = 0;
let totalClicks = 0;
let totalSessions = 0;
const earningHistory = [];

// ============ FAUCET SITES ============
const FAUCET_SITES = [
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerClaim: 0.0005, timePerClaim: 5, claimsPerDay: 30 },
    { name: 'EzBit', url: 'https://ezbit.co.in', earnPerClaim: 0.0003, timePerClaim: 3, claimsPerDay: 40 },
    { name: 'CoinPayU', url: 'https://coinpayu.com', earnPerClaim: 0.001, timePerClaim: 5, claimsPerDay: 50 },
    { name: 'AdBTC', url: 'https://adbtc.top', earnPerClaim: 0.0015, timePerClaim: 6, claimsPerDay: 40 },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerClaim: 0.0012, timePerClaim: 5, claimsPerDay: 35 },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerClaim: 0.003, timePerClaim: 10, claimsPerDay: 25 }
];

// ============ FAUCETPAY BOT CLASS ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.balance = { BTC: 0, DOGE: 0, LTC: 0 };
        this.earned = 0;
        this.clicks = 0;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        const launchOptions = getChromeLaunchOptions();
        this.browser = await puppeteer.launch(launchOptions);
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1280, height: 800 });
        
        // Random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        ];
        await this.page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
    }

    async loginToFaucetPay() {
        if (!this.email || !this.password) {
            console.log('[FaucetPay] No credentials provided - running demo mode');
            return false;
        }
        
        console.log('[FaucetPay] Logging in...');
        
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            await this.page.type('input[name="email"]', this.email);
            await this.page.type('input[name="password"]', this.password);
            await this.page.click('button[type="submit"]');
            
            await this.page.waitForTimeout(5000);
            
            if (await this.page.$('.dashboard-container')) {
                console.log('[FaucetPay] ✅ Login successful');
                return true;
            }
            return false;
        } catch (error) {
            console.error('[FaucetPay] Login failed:', error.message);
            return false;
        }
    }

    async processFaucet(faucet) {
        console.log(`\n[${faucet.name}] Processing...`);
        
        try {
            await this.page.goto(faucet.url, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(5000);
            
            // Look for claim button
            const claimSelectors = [
                '#claimButton', '.claim-btn', 'button:has-text("Claim")',
                'a:has-text("Claim")', '.captcha-form button', '.claim-button',
                'button[class*="claim"]', 'a[class*="claim"]'
            ];
            
            let claimed = false;
            for (const selector of claimSelectors) {
                try {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn) {
                        await claimBtn.click();
                        await this.page.waitForTimeout(3000);
                        console.log(`[${faucet.name}] ✅ Claimed! +$${faucet.earnPerClaim}`);
                        this.earned += faucet.earnPerClaim;
                        this.clicks++;
                        claimed = true;
                        break;
                    }
                } catch(e) {}
            }
            
            if (!claimed) {
                console.log(`[${faucet.name}] No claim button found`);
            }
            
            return claimed;
            
        } catch (error) {
            console.error(`[${faucet.name}] Error:`, error.message);
            return false;
        }
    }

    async runSession() {
        console.log('\n========================================');
        console.log('  STARTING EARNING SESSION');
        console.log('========================================\n');
        
        await this.init();
        
        let loggedIn = false;
        if (this.email && this.password) {
            loggedIn = await this.loginToFaucetPay();
        }
        
        let sessionEarnings = 0;
        
        for (const faucet of FAUCET_SITES) {
            if (sessionEarnings >= EARNING_GOAL) {
                console.log(`\n🎉 Daily goal reached! Total: $${sessionEarnings.toFixed(4)}`);
                break;
            }
            
            const success = await this.processFaucet(faucet);
            if (success) {
                sessionEarnings += faucet.earnPerClaim;
            }
            
            console.log(`   Running total: $${sessionEarnings.toFixed(4)}`);
            
            // Random delay between faucets (30-90 seconds)
            const delay = 30000 + Math.random() * 60000;
            console.log(`   Waiting ${Math.round(delay / 1000)} seconds...`);
            await this.page.waitForTimeout(delay);
        }
        
        this.earned = sessionEarnings;
        totalEarned += sessionEarnings;
        totalClicks += this.clicks;
        totalSessions++;
        
        earningHistory.push({
            earned: sessionEarnings,
            clicks: this.clicks,
            timestamp: new Date()
        });
        
        console.log('\n========================================');
        console.log(`  SESSION COMPLETE`);
        console.log(`  Earned: $${sessionEarnings.toFixed(4)}`);
        console.log(`  Clicks: ${this.clicks}`);
        console.log(`  Total Earned: $${totalEarned.toFixed(4)}`);
        console.log('========================================\n');
        
        await this.browser.close();
        return sessionEarnings;
    }
}

// ============ DASHBOARD ============
if (SHOW_DASHBOARD) {
    app.get('/', (req, res) => {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FaucetPay Auto Earning Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 40px 20px;
            color: white;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 10px; }
        .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; text-align: center; }
        .stat-value { font-size: 2rem; font-weight: bold; color: #00d4ff; }
        .stat-label { font-size: 0.8rem; opacity: 0.7; margin-top: 5px; }
        .history-table { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.2); }
        th { color: #00d4ff; }
        .profit { color: #10b981; }
        .refresh-btn { background: #00d4ff; color: #000; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; font-weight: bold; }
        .faucet-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-bottom: 40px; }
        .faucet-card { background: rgba(255,255,255,0.1); border-radius: 10px; padding: 15px; text-align: center; }
        .faucet-name { font-weight: bold; margin-bottom: 8px; }
        .faucet-rate { font-size: 0.8rem; opacity: 0.8; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Auto Earning Bot</h1>
        <div class="subtitle">Automated Faucet Claims • 24/7 Operation</div>
        
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${totalClicks}</div><div class="stat-label">Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">${totalSessions}</div><div class="stat-label">Sessions</div></div>
            <div class="stat-card"><div class="stat-value">$${EARNING_GOAL}</div><div class="stat-label">Daily Goal</div></div>
        </div>
        
        <h2>🌊 Active Faucets</h2>
        <div class="faucet-list">
            ${FAUCET_SITES.map(faucet => `
                <div class="faucet-card">
                    <div class="faucet-name">${faucet.name}</div>
                    <div class="faucet-rate">$${faucet.earnPerClaim}/claim</div>
                    <div class="faucet-rate">${faucet.claimsPerDay}/day</div>
                </div>
            `).join('')}
        </div>
        
        <h2>📈 Earning History</h2>
        <div class="history-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Time</th><th>Clicks</th><th>Earned</th></thead>
                <tbody>
                    ${earningHistory.slice().reverse().slice(0, 30).map(h => `
                        <tr>
                            <td>${new Date(h.timestamp).toLocaleString()}</td>
                            <td>${h.clicks}</td>
                            <td class="profit">+$${h.earned.toFixed(4)}</
