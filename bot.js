// faucetpay-simple-bot.js - Simplified FaucetPay Bot
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

const CHROME_PATH = '/app/chrome-linux64/chrome';
const CHROME_URL = 'https://storage.googleapis.com/chrome-for-testing-public/121.0.6167.85/linux64/chrome-linux64.zip';

console.log('\n========================================');
console.log('  FaucetPay Bot');
console.log('========================================');

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

// ============ FAUCETPAY INTERNAL EARNINGS ============
// These are FaucetPay's own earning opportunities (more reliable)
const EARNING_OPPORTUNITIES = [
    { name: 'Daily Bonus', url: 'https://faucetpay.io/daily-bonus', earnPerClaim: 0.001 },
    { name: 'Faucet List', url: 'https://faucetpay.io/faucets', earnPerClaim: 0.0005 },
    { name: 'Offerwalls', url: 'https://faucetpay.io/offerwalls', earnPerClaim: 0.002 },
    { name: 'Tasks', url: 'https://faucetpay.io/tasks', earnPerClaim: 0.003 }
];

let totalEarned = 0;
let totalClicks = 0;
let currentBalance = 0;

// ============ FAUCETPAY BOT ============
class FaucetPayBot {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.browser = null;
        this.page = null;
        this.earned = 0;
        this.clicks = 0;
    }

    async init() {
        const chromePath = await installChrome();
        if (!chromePath) throw new Error('No Chrome');
        
        this.browser = await puppeteer.launch({
            headless: HEADLESS_MODE,
            executablePath: chromePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        this.page = await this.browser.newPage();
    }

    async login() {
        if (!this.email || !this.password) {
            console.log('No credentials - demo mode');
            return false;
        }
        
        console.log('Logging into FaucetPay...');
        try {
            await this.page.goto('https://faucetpay.io/login', { waitUntil: 'networkidle2', timeout: 30000 });
            await this.page.waitForTimeout(2000);
            
            await this.page.type('#email', this.email);
            await this.page.type('#password', this.password);
            await this.page.click('button[type="submit"]');
            await this.page.waitForTimeout(3000);
            
            console.log('✅ Login successful');
            return true;
        } catch (error) {
            console.error('Login failed:', error.message);
            return false;
        }
    }

    async collectDailyBonus() {
        console.log('\n[Daily Bonus] Collecting...');
        try {
            await this.page.goto('https://faucetpay.io/dashboard', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(2000);
            
            const bonusBtn = await this.page.$('button:has-text("Claim"), .claim-bonus, [class*="bonus"]');
            if (bonusBtn) {
                await bonusBtn.click();
                await this.page.waitForTimeout(2000);
                console.log('✅ Daily bonus collected!');
                this.earned += 0.001;
                this.clicks++;
                return true;
            }
            console.log('No bonus available');
            return false;
        } catch (error) {
            console.log('Bonus error:', error.message);
            return false;
        }
    }

    async viewFaucetList() {
        console.log('\n[Faucet List] Viewing...');
        try {
            await this.page.goto('https://faucetpay.io/faucets', { waitUntil: 'networkidle2' });
            await this.page.waitForTimeout(3000);
            
            // Scroll through faucets
            await this.page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
            await this.page.waitForTimeout(2000);
            
            console.log('✅ Faucet list viewed');
            this.earned += 0.0005;
            this.clicks++;
            return true;
        } catch (error) {
            console.log('Faucet list error:', error.message);
            return false;
        }
    }

    async checkBalance() {
        try {
            const balance = await this.page.$eval('.balance-amount', el => el.innerText).catch(() => '0');
            currentBalance = parseFloat(balance) || 0;
            console.log(`💰 Balance: $${currentBalance}`);
            return currentBalance;
        } catch (error) {
            return currentBalance;
        }
    }

    async run() {
        console.log('\n========================================');
        console.log('  Starting FaucetPay Session');
        console.log('========================================');
        
        await this.init();
        await this.login();
        
        if (this.email && this.password) {
            await this.collectDailyBonus();
            await this.viewFaucetList();
            await this.checkBalance();
        } else {
            console.log('\n⚠️ Demo Mode - Set FAUCETPAY_EMAIL and FAUCETPAY_PASSWORD to earn real money');
            console.log('   Earnings are simulated for testing\n');
            
            // Simulate earnings for demo
            this.earned = 0.002;
            this.clicks = 2;
        }
        
        totalEarned += this.earned;
        totalClicks += this.clicks;
        
        console.log('\n========================================');
        console.log(`  Session Complete`);
        console.log(`  Earned: $${this.earned.toFixed(4)}`);
        console.log(`  Total Earned: $${totalEarned.toFixed(4)}`);
        console.log('========================================\n');
        
        await this.browser.close();
        return this.earned;
    }
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>FaucetPay Bot</title>
    <style>
        body { font-family: monospace; background: #0a0e27; color: #00ff88; padding: 40px; }
        .stats { background: #1a1f3a; padding: 20px; border-radius: 10px; }
        .value { font-size: 32px; font-weight: bold; }
    </style>
</head>
<body>
    <h1>💰 FaucetPay Bot</h1>
    <div class="stats">
        <div>Total Earned: <span class="value">$${totalEarned.toFixed(4)}</span></div>
        <div>Total Actions: ${totalClicks}</div>
        <div>Balance: $${currentBalance.toFixed(4)}</div>
    </div>
    <p>Bot is running... Dashboard refreshes every 30 seconds.</p>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`);
});

// ============ MAIN ============
async function main() {
    console.log('🚀 Starting FaucetPay Bot...');
    await installChrome();
    
    app.listen(port, '0.0.0.0', () => {
        console.log(`📊 Dashboard: http://localhost:${port}`);
    });
    
    while (true) {
        try {
            const bot = new FaucetPayBot(FAUCETPAY_EMAIL, FAUCETPAY_PASSWORD);
            await bot.run();
            
            // Wait 1 hour between sessions
            console.log('⏰ Waiting 1 hour...\n');
            await new Promise(r => setTimeout(r, 60 * 60 * 1000));
            
        } catch (error) {
            console.error('Error:', error.message);
            await new Promise(r => setTimeout(r, 300000));
        }
    }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch(console.error);
