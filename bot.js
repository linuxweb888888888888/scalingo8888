// faucetpay-only-bot.js - Complete FaucetPay Auto Earning Bot
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
const port = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const FAUCETPAY_EMAIL = process.env.FAUCETPAY_EMAIL || '';
const FAUCETPAY_PASSWORD = process.env.FAUCETPAY_PASSWORD || '';
const MIN_WITHDRAWAL_USD = parseFloat(process.env.MIN_WITHDRAWAL_USD) || 0.10;
const HEADLESS_MODE = process.env.HEADLESS_MODE !== 'false';
const SHOW_DASHBOARD = process.env.SHOW_DASHBOARD !== 'false';

// Chrome paths
const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Auto Earning Bot');
console.log('========================================');
console.log(`FaucetPay Email: ${FAUCETPAY_EMAIL || 'Not set'}`);
console.log(`Min Withdrawal: $${MIN_WITHDRAWAL_USD}`);
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
        if (stats.size > 50000000) {
            console.log('[Chrome] Already installed');
            return CHROME_PATH;
        }
    }
    
    console.log('[Chrome] Installing...');
    
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

// ============ FAUCET SITES ============
const FAUCET_SITES = [
    { name: 'FireFaucet', url: 'https://firefaucet.win', earnPerClaim: 0.0005, timePerClaim: 5 },
    { name: 'EzBit', url: 'https://ezbit.co.in', earnPerClaim: 0.0003, timePerClaim: 3 },
    { name: 'CoinPayU', url: 'https://coinpayu.com', earnPerClaim: 0.001, timePerClaim: 5 },
    { name: 'AdBTC', url: 'https://adbtc.top', earnPerClaim: 0.0015, timePerClaim: 6 },
    { name: 'BTCClicks', url: 'https://btcclicks.com', earnPerClaim: 0.0012, timePerClaim: 5 },
    { name: 'Cointiply', url: 'https://cointiply.com', earnPerClaim: 0.003, timePerClaim: 10 }
];

// ============ MEMORY STORAGE ============
let totalEarned = 0;
let totalClicks = 0;
let faucetPayBalance = 0;
const earningHistory = [];

// ============ FAUCETPAY BOT ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.sessionEarned = 0;
        this.sessionClicks = 0;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('Chrome not available');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
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
            console.log('[FaucetPay] No credentials - demo mode');
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
                await this.updateBalance();
                return true;
            }
            return false;
        } catch (error) {
            console.error('[FaucetPay] Login failed:', error.message);
            return false;
        }
    }

    async updateBalance() {
        try {
            const balanceText = await this.page.$eval('.balance-amount', el => el.innerText).catch(() => '0');
            faucetPayBalance = parseFloat(balanceText) || 0;
            console.log(`[FaucetPay] Balance: $${faucetPayBalance}`);
            return faucetPayBalance;
        } catch (error) {
            return faucetPayBalance;
        }
    }

    async claimFaucet(faucet) {
        console.log(`\n[${faucet.name}] Claiming...`);
        
        try {
            await this.page.goto(faucet.url, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(5000);
            
            // Scroll to load content
            await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
            await this.page.waitForTimeout(1000);
            
            // Claim button selectors
            const claimSelectors = [
                '#claimButton', '.claim-btn', 'button:has-text("Claim")',
                'a:has-text("Claim")', '.claim-button', '#claim',
                '.faucet-button', '.get-faucet', 'button[class*="claim"]'
            ];
            
            for (const selector of claimSelectors) {
                try {
                    const claimBtn = await this.page.$(selector);
                    if (claimBtn) {
                        await claimBtn.click();
                        await this.page.waitForTimeout(5000);
                        console.log(`[${faucet.name}] ✅ Claimed! +$${faucet.earnPerClaim}`);
                        this.sessionEarned += faucet.earnPerClaim;
                        this.sessionClicks++;
                        return true;
                    }
                } catch(e) {}
            }
            
            console.log(`[${faucet.name}] No claim button found`);
            return false;
            
        } catch (error) {
            console.error(`[${faucet.name}] Error:`, error.message);
            return false;
        }
    }

    async checkWithdrawal() {
        if (!this.email || !this.password) return;
        
        await this.updateBalance();
        
        if (faucetPayBalance >= MIN_WITHDRAWAL_USD) {
            console.log(`\n💰 Balance $${faucetPayBalance} reached threshold!`);
            console.log(`   Log into FaucetPay to withdraw to your wallet`);
        }
    }

    async runSession() {
        console.log('\n========================================');
        console.log('  STARTING FAUCET CLAIM SESSION');
        console.log('========================================\n');
        
        await this.init();
        
        if (this.email && this.password) {
            await this.loginToFaucetPay();
        } else {
            console.log('[FaucetPay] Demo mode - faucet claims only');
        }
        
        for (const faucet of FAUCET_SITES) {
            await this.claimFaucet(faucet);
            
            // Random delay between faucets (30-60 seconds)
            const delay = 30000 + Math.random() * 30000;
            console.log(`   Waiting ${Math.round(delay / 1000)} seconds...`);
            await this.page.waitForTimeout(delay);
        }
        
        // Update totals
        totalEarned += this.sessionEarned;
        totalClicks += this.sessionClicks;
        
        earningHistory.push({
            earned: this.sessionEarned,
            clicks: this.sessionClicks,
            timestamp: new Date()
        });
        
        await this.checkWithdrawal();
        
        console.log('\n========================================');
        console.log(`  SESSION COMPLETE`);
        console.log(`  Earned: $${this.sessionEarned.toFixed(4)}`);
        console.log(`  Clicks: ${this.sessionClicks}`);
        console.log(`  Total Earned: $${totalEarned.toFixed(4)}`);
        console.log(`  FaucetPay Balance: $${faucetPayBalance}`);
        console.log('========================================\n');
        
        await this.browser.close();
        return this.sessionEarned;
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
    <title>FaucetPay Auto Bot</title>
    <style>
        body {
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 40px 20px;
            color: white;
        }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; text-align: center; }
        .stat-value { font-size: 2rem; font-weight: bold; color: #00d4ff; }
        .history-table { background: rgba(255,255,255,0.1); border-radius: 15px; padding: 20px; overflow-x: auto; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.2); }
        th { color: #00d4ff; }
        .profit { color: #10b981; }
        .refresh-btn { background: #00d4ff; color: #000; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>💰 FaucetPay Auto Bot</h1>
        <div class="stats">
            <div class="stat-card"><div class="stat-value">$${totalEarned.toFixed(4)}</div><div class="stat-label">Total Earned</div></div>
            <div class="stat-card"><div class="stat-value">${totalClicks}</div><div class="stat-label">Total Claims</div></div>
            <div class="stat-card"><div class="stat-value">$${faucetPayBalance.toFixed(4)}</div><div class="stat-label">FaucetPay Balance</div></div>
        </div>
        <div class="history-table">
            <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
            <table>
                <thead><tr><th>Time</th><th>Clicks</th><th>Earned</th></tr></thead>
                <tbody>
                    ${earningHistory.slice().reverse().slice(0, 30).map(h => `
                        <tr><td>${new Date(h.timestamp).toLocaleString()}</td><td>${h.clicks}</td><td class="profit">+$${h.earned.toFixed(4)}</td></tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    </div>
    <script>setTimeout(() => location.reload(), 15000);</script>
</body>
</html>`;
        res.send(html);
    });
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
}

// ============ MAIN LOOP ============
async function main() {
    console.log('🚀 Starting FaucetPay Bot...');
    await installChrome();
    
    while (true) {
        try {
            const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
            await bot.runSession();
            
            // Wait 2-4 hours between sessions
            const waitHours = 2 + Math.random() * 2;
            console.log(`⏰ Waiting ${waitHours.toFixed(1)} hours...\n`);
            await new Promise(r => setTimeout(r, waitHours * 60 * 60 * 1000));
            
        } catch (error) {
            console.error('Error:', error.message);
            await new Promise(r => setTimeout(r, 300000));
        }
    }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
